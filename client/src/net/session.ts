/**
 * The client's match loop: the piece that ties the socket, the prediction, the
 * playout buffer and the input device together.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT IN A SCENE
 *
 * Pairs D and F replace everything under `client/src/scenes/` with real UI and
 * art in Phases 4 and 5. Anything living there dies with that rewrite. The input
 * pump, the redundancy window and the ownership of the predictor are netcode,
 * not presentation, and the bot harness in `tools/` wants them too — so they
 * live here, and a scene is reduced to calling `update(delta)` and drawing what
 * comes back.
 *
 * THE PUMP RUNS AT A FIXED 60 Hz, NOT AT THE FRAME RATE
 *
 * A tick is a fixed amount of hockey. If inputs were produced once per rendered
 * frame, a client on a 144 Hz monitor would issue inputs faster than the server
 * consumes them and sit permanently at the prediction cap, while one dropping to
 * 30 fps would starve the server's buffer and have its last input repeated —
 * i.e. how fast your skater accelerates would depend on your monitor. The
 * accumulator makes the tick rate the same everywhere and lets the frame rate be
 * whatever it is.
 */

import { NETWORK, TICK_RATE, TICK_SECONDS } from '@dfhl/shared';
import type {
  LobbyMessage,
  MatchConfig,
  MatchEndMessage,
  SnapshotMessage,
  WelcomeMessage,
} from '@dfhl/shared';

import { MatchConnection, type ConnectionStatus } from './connection.js';
import { SnapshotInterpolator, type RenderView } from './interpolation.js';
import { Predictor, type PredictedSelf, type PredictionMetrics } from './prediction.js';
import type { InputSource } from '../input/source.js';

const TICK_MS = TICK_SECONDS * 1000;

/**
 * Most simulated ticks one rendered frame may produce.
 *
 * A tab that was backgrounded for ten seconds comes back with a ten-second
 * delta. Replaying six hundred ticks of stale intent would be both pointless and
 * a visible freeze; the prediction cap would throw nearly all of it away anyway.
 * Five ticks covers a genuine 12 fps stutter and nothing worse.
 */
const MAX_TICKS_PER_FRAME = 5;

export class MatchSession {
  readonly connection: MatchConnection;

  private readonly interpolator = new SnapshotInterpolator();
  private inputSource: InputSource | null = null;
  private predictor: Predictor | null = null;

  private accumulator = 0;

  private welcomeMessage: WelcomeMessage | null = null;
  private lobbyMessage: LobbyMessage | null = null;
  private matchConfig: MatchConfig | null = null;
  private result: MatchEndMessage | null = null;

  /**
   * True when this client is watching rather than playing: it joined after the
   * puck dropped, so the server gave it no input buffer and will ignore anything
   * it sends. Read off the snapshot, which carries exactly the seats the runner
   * knows about.
   */
  private spectating = false;

  constructor(connection: MatchConnection = new MatchConnection()) {
    this.connection = connection;

    this.connection.on('welcome', (message) => {
      this.welcomeMessage = message;
      // The protocol sends the server's tick rate so a client can check it
      // against its own build. A mismatch means the two are running different
      // simulations, which produces a desync that looks like bad netcode and is
      // actually a bad deploy.
      if (message.tickRate !== TICK_RATE) {
        console.error(
          `[DFHL Blitz] server ticks at ${message.tickRate} Hz, this build at ${TICK_RATE} Hz. ` +
            'Client and server are out of step; reload after the deploy finishes.',
        );
      }
    });

    this.connection.on('lobby', (message) => {
      this.lobbyMessage = message;
    });

    this.connection.on('matchStart', (message) => {
      this.matchConfig = message.config;
      this.result = null;
      this.spectating = false;
      this.accumulator = 0;
      this.interpolator.reset();
      const seatId = this.connection.seatId;
      this.predictor = seatId === null ? null : new Predictor(message.config, seatId);
    });

    this.connection.on('snapshot', (message) => {
      this.absorbSnapshot(message);
    });

    this.connection.on('matchEnd', (message) => {
      this.result = message;
      // The predictor goes, the playout buffer stays: the last few frames are
      // still arriving and the post-game screen is drawn over a live rink.
      this.predictor = null;
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Attach the device intent is read from. Replacing one destroys the old. */
  useInputSource(source: InputSource | null): void {
    if (this.inputSource !== null && this.inputSource !== source) this.inputSource.destroy();
    this.inputSource = source;
  }

  destroy(): void {
    this.inputSource?.destroy();
    this.inputSource = null;
    this.predictor = null;
    void this.connection.leave();
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Advance one rendered frame.
   *
   * @param deltaMs real elapsed time since the previous frame.
   * @returns the interpolated view of everything this client does not control,
   *          or null before the first snapshot has landed.
   */
  update(deltaMs: number): RenderView | null {
    this.pumpInput(deltaMs);
    return this.interpolator.advance(deltaMs);
  }

  private pumpInput(deltaMs: number): void {
    const predictor = this.predictor;
    const source = this.inputSource;
    if (predictor === null || source === null || this.spectating) {
      this.accumulator = 0;
      return;
    }

    this.accumulator += deltaMs;
    let produced = 0;
    while (this.accumulator >= TICK_MS && produced < MAX_TICKS_PER_FRAME) {
      this.accumulator -= TICK_MS;
      produced++;

      // A predictor at its cap has nothing to add to the timeline, but the
      // packet still goes: the redundancy window is what carries an earlier
      // input across a hole in the connection, and that is exactly the situation
      // a stall means we are in.
      if (predictor.canPredict()) {
        predictor.recordInput(source.sample(predictor.nextInputTick()));
      }

      const window = predictor.recentInputs(NETWORK.inputRedundancy);
      if (window.length > 0) this.connection.sendInput(window);
    }

    // Whatever is left after the catch-up limit describes intent from a frame
    // that has already been superseded. Banking it would replay a stutter.
    if (this.accumulator > TICK_MS * MAX_TICKS_PER_FRAME) this.accumulator = 0;
  }

  private absorbSnapshot(message: SnapshotMessage): void {
    this.interpolator.push(message);

    // `runner.state.seats` holds only seats that were in the room at kickoff, so
    // a seat missing from it is a late joiner with no input buffer on the server.
    const seatId = this.connection.seatId;
    this.spectating = seatId !== null && !message.state.seats.some((seat) => seat.id === seatId);

    this.predictor?.applySnapshot(message);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get welcome(): WelcomeMessage | null {
    return this.welcomeMessage;
  }

  get lobby(): LobbyMessage | null {
    return this.lobbyMessage;
  }

  get config(): MatchConfig | null {
    return this.matchConfig;
  }

  get finalResult(): MatchEndMessage | null {
    return this.result;
  }

  get isSpectating(): boolean {
    return this.spectating;
  }

  get seatId(): string | null {
    return this.connection.seatId;
  }

  get status(): ConnectionStatus {
    return this.connection.getStatus();
  }

  /** The predicted skater this client drives, already carrying the ease offset. */
  self(): PredictedSelf | null {
    return this.predictor?.self() ?? null;
  }

  /**
   * The predicted puck, but only while this client's skater is carrying it.
   * Null otherwise, including for a loose puck — see `Predictor.carriedPuck`.
   */
  carriedPuck(): { x: number; y: number } | null {
    return this.predictor?.carriedPuck() ?? null;
  }

  /** Null outside a match. The inspector and the bot harness both read this. */
  metrics(): PredictionMetrics | null {
    return this.predictor?.metrics() ?? null;
  }
}
