/**
 * Client-side prediction and reconciliation for the skater this client drives.
 *
 * -----------------------------------------------------------------------------
 * THE MODEL, IN ONE PARAGRAPH
 *
 * The server consumes exactly one queued input per seat per tick (`consumeInput`
 * in server/src/rooms/input.ts) and reports the newest one it has applied as
 * `ackInputTick`. So the client's predicted state is, precisely, *the last
 * authoritative snapshot advanced by one tick per unacknowledged local input*.
 * Nothing else needs estimating: not latency, not clock offset, not how far
 * ahead we ought to be. The size of the unacked queue IS how far ahead we are,
 * and it self-corrects — every input we send eventually comes back acked, and
 * every tick the server runs without one of ours shortens the queue.
 *
 * That is also why an input's `tick` field is stamped as
 * `authoritativeTick + pending + 1`: the tick the server will consume it on.
 *
 * PREDICTION IS TRUSTED ONLY FOR OUR OWN SKATER
 *
 * `stepMatch` moves the whole world, and we run the whole thing — there is no
 * cheaper way to get our own skater right, because our skater collides with
 * theirs, gets checked by theirs, and picks up a puck theirs just shot. But only
 * our own skater is *rendered* from this. Everybody else comes out of
 * `interpolation.ts`, 100 ms in the past, because a predicted remote skater is a
 * guess about a human whose buttons we will never see, and a wrong guess about
 * where an opponent is looks far worse than an honest 100 ms of delay.
 *
 * WHAT WE FEED REMOTE SEATS DURING A REPLAY
 *
 * Nothing on the wire carries another seat's input, so the best available guess
 * is that they keep doing what the last snapshot showed them doing: their stick
 * held in the direction their skater was already moving, at a magnitude
 * proportional to their speed, and no buttons. "Keeps skating" is much closer to
 * a human than "stops dead", and the error it can produce is bounded by the ~10
 * ticks of replay it survives. Buttons are simply unknowable, so a remote check
 * or shot is never predicted — which is the right way round, since being hit is
 * something that should arrive as authority rather than as a guess.
 *
 * MEASURING RATHER THAN ARGUING
 *
 * `metrics()` reports the distance between where we had put our skater at a
 * given tick and where the server actually put it at that same tick — matched
 * ticks, from a small history ring, because comparing across ticks would inflate
 * the number by however far a skater travels in a frame. Rubber-banding is then
 * a number (mean, p95, snaps) instead of an opinion.
 */

import { NETWORK, SKATER, cloneState, emptyInput, quantizeAxis, stepMatch } from '@dfhl/shared';
import type {
  GameSimState,
  InputMap,
  MatchConfig,
  PlayerInput,
  SkaterSimState,
  SnapshotMessage,
  TeamSide,
} from '@dfhl/shared';

// ---------------------------------------------------------------------------

/**
 * Reconciliations kept for the p95.
 *
 * 256 samples at the 20 Hz snapshot rate is the last thirteen seconds of play,
 * which is the window somebody means when they say "it felt rubbery just then".
 */
const ERROR_WINDOW = 256;

/**
 * Predicted positions kept for the matched-tick error measurement.
 *
 * Must comfortably exceed `maxPredictionTicks` plus one snapshot interval; 128
 * ticks is over two seconds and keeps the modulo cheap.
 */
const HISTORY_SIZE = 128;

interface HistoryEntry {
  tick: number;
  /** Which skater we believed we were driving. A mismatch is not a position error. */
  skaterId: string;
  x: number;
  y: number;
}

export interface PredictionMetrics {
  /** Feet of position error at the most recent reconciliation. */
  currentErrorFeet: number;
  meanErrorFeet: number;
  p95ErrorFeet: number;
  /** Corrections that exceeded `NETWORK.reconcileSnapThreshold` and were hard-snapped. */
  snaps: number;
  /** Position errors measured. */
  samples: number;
  /**
   * Reconciliations where the server had us driving a different skater than we
   * predicted. Counted apart from position error because it is a different
   * defect with a different cause — an auto-switch we got wrong, not physics we
   * got wrong — and averaging the two together would hide both.
   */
  controlMismatches: number;
  /** Local inputs the server has not acknowledged. This is how far ahead we are. */
  pendingInputs: number;
  /** True while prediction is capped and waiting for the server to catch up. */
  stalled: boolean;
  /** Snapshots that arrived out of order or duplicated, and were discarded. */
  staleSnapshots: number;
}

/** The controlled skater as the renderer should draw it: predicted, plus the ease offset. */
export interface PredictedSelf {
  id: string;
  side: TeamSide;
  playerId: string;
  x: number;
  y: number;
  facing: number;
  turbo: number;
  stun: number;
  windup: number;
  onFire: boolean;
}

// ---------------------------------------------------------------------------

export class Predictor {
  private readonly config: MatchConfig;
  private readonly seatId: string;

  /** The newest snapshot, cloned so replaying never writes into the received object. */
  private authoritative: GameSimState | null = null;
  private authTick = -1;
  private ackInputTick = -1;

  /** Authoritative state advanced by one tick per entry in `pending`. */
  private predicted: GameSimState | null = null;

  /** Unacknowledged local inputs, oldest first. Bounded by `maxPredictionTicks`. */
  private readonly pending: PlayerInput[] = [];

  /** Monotonic guard on issued input ticks; see `nextInputTick`. */
  private lastIssuedTick = -1;

  private readonly history: Array<HistoryEntry | null> = new Array<HistoryEntry | null>(
    HISTORY_SIZE,
  ).fill(null);

  /**
   * Render-space correction, in feet, decayed at `NETWORK.reconcileEaseRate`.
   *
   * Deliberately NOT applied to the simulation state: bending the state would
   * make the next prediction start from a position the server never had, which
   * is how a small correction turns into a permanent drift. The state is always
   * exactly what the server said plus our own inputs; only the pixels lag.
   */
  private offsetX = 0;
  private offsetY = 0;
  private offsetSkaterId: string | null = null;

  private readonly errors = new Float64Array(ERROR_WINDOW);
  private errorCount = 0;
  private errorIndex = 0;
  private errorSum = 0;
  private errorSamples = 0;
  private currentError = 0;
  private snaps = 0;
  private controlMismatches = 0;
  private staleSnapshots = 0;

  constructor(config: MatchConfig, seatId: string) {
    this.config = config;
    this.seatId = seatId;
  }

  // -------------------------------------------------------------------------
  // Producing input
  // -------------------------------------------------------------------------

  /**
   * Whether the prediction timeline has room for another tick.
   *
   * False means we are `NETWORK.maxPredictionTicks` ahead of the last snapshot
   * with nothing coming back — a stall or a dead connection. Predicting further
   * would run the match on into a future the server may never agree with, and
   * every extra tick is one more that has to be thrown away when it does.
   */
  canPredict(): boolean {
    return this.authoritative !== null && this.pending.length < NETWORK.maxPredictionTicks;
  }

  /**
   * The tick to stamp on the next input: the tick the server will consume it on.
   *
   * `lastIssuedTick + 1` is a floor rather than the formula itself, because a
   * server that acknowledges a burst can briefly shorten `pending` faster than
   * `authTick` grows, and an input tick that goes backwards is one the server's
   * duplicate check silently drops.
   */
  nextInputTick(): number {
    const projected = this.authTick + this.pending.length + 1;
    return projected > this.lastIssuedTick + 1 ? projected : this.lastIssuedTick + 1;
  }

  /**
   * Take one tick of local intent: queue it, and advance the prediction by the
   * single tick it buys.
   *
   * @returns false when prediction is capped and the input was not taken. The
   *          caller should keep sending its redundancy window regardless — those
   *          are ticks the server still has to chew through.
   */
  recordInput(input: PlayerInput): boolean {
    if (!this.canPredict()) return false;
    const state = this.predicted;
    if (state === null) return false;

    this.pending.push(input);
    this.lastIssuedTick = input.tick;

    stepMatch(state, this.inputsFor(state, input), this.config);
    this.remember(state);
    this.decayOffset();
    return true;
  }

  /** The last `count` inputs, oldest first, for the redundant input packet. */
  recentInputs(count: number): PlayerInput[] {
    return this.pending.length <= count ? [...this.pending] : this.pending.slice(-count);
  }

  // -------------------------------------------------------------------------
  // Taking authority
  // -------------------------------------------------------------------------

  /**
   * Rewind to the server's state and replay everything it has not seen.
   *
   * Order matters: measure first (against the prediction we are about to throw
   * away), then rebuild, then re-derive the render offset so the drawn position
   * does not jump on the frame the correction lands.
   */
  applySnapshot(message: SnapshotMessage): void {
    // WebSocket delivery is ordered, so this should never fire — but a snapshot
    // applied twice would replay inputs the server has already consumed and
    // manufacture an error that was never there.
    if (message.tick <= this.authTick) {
      this.staleSnapshots++;
      return;
    }

    const previousRenderX = this.renderX();
    const previousRenderY = this.renderY();
    const previousSelfId = this.selfSkaterId();

    this.measure(message);

    this.authoritative = cloneState(message.state);
    this.authTick = message.state.tick;
    this.ackInputTick = message.ackInputTick;

    // Everything the server has applied is history now. `ackInputTick` of -1
    // means it has applied nothing of ours, which correctly keeps the lot.
    while (this.pending.length > 0 && this.pending[0].tick <= this.ackInputTick) {
      this.pending.shift();
    }
    // A client that stalled while the server ran on can hold inputs stamped for
    // ticks that have already passed unacknowledged — the server trimmed them
    // off the front of its own buffer. Replaying them would predict a past that
    // no longer exists.
    while (this.pending.length > 0 && this.pending[0].tick <= this.authTick) {
      this.pending.shift();
    }

    const state = cloneState(this.authoritative);
    for (const input of this.pending) {
      stepMatch(state, this.inputsFor(state, input), this.config);
      this.remember(state);
    }
    this.predicted = state;

    this.reseatOffset(previousSelfId, previousRenderX, previousRenderY);
  }

  /**
   * Where the correction goes.
   *
   * The rendered position is held exactly where it was on the previous frame and
   * the whole of the correction becomes an offset that eases away — so a small
   * misprediction is literally invisible, and a large one is caught by the snap
   * threshold instead of being smeared across the ice for a second and a half.
   */
  private reseatOffset(previousSelfId: string | null, previousX: number, previousY: number): void {
    const self = this.selfSkater();
    if (self === null) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetSkaterId = null;
      return;
    }

    // Easing between two different skaters is not smoothing, it is a smear.
    if (previousSelfId !== self.id || previousSelfId === null) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetSkaterId = self.id;
      return;
    }

    const dx = previousX - self.x;
    const dy = previousY - self.y;
    if (dx * dx + dy * dy > NETWORK.reconcileSnapThreshold * NETWORK.reconcileSnapThreshold) {
      // Past the threshold there is no correction small enough to hide. Snapping
      // is honest and instantaneous; easing six feet at 20% a tick would drag a
      // ghost across the slot for the best part of a second.
      this.offsetX = 0;
      this.offsetY = 0;
    } else {
      this.offsetX = dx;
      this.offsetY = dy;
    }
    this.offsetSkaterId = self.id;
  }

  private decayOffset(): void {
    this.offsetX -= this.offsetX * NETWORK.reconcileEaseRate;
    this.offsetY -= this.offsetY * NETWORK.reconcileEaseRate;
  }

  /**
   * How wrong we were, at the tick the snapshot describes.
   *
   * Same tick on both sides: the history ring holds what we predicted for
   * exactly `message.tick`, so the difference is prediction error and nothing
   * else. Comparing our newest prediction against the snapshot instead would
   * fold in every foot the skater legitimately travels in the round trip, and
   * report a permanent "error" of several feet in a perfectly healthy match.
   */
  private measure(message: SnapshotMessage): void {
    const entry = this.history[((message.tick % HISTORY_SIZE) + HISTORY_SIZE) % HISTORY_SIZE];
    if (entry === null || entry.tick !== message.tick) return;

    const actual = message.state.skaters.find((s) => s.controlledBy === this.seatId);
    if (actual === undefined) return;

    if (actual.id !== entry.skaterId) {
      this.controlMismatches++;
      return;
    }

    const dx = actual.x - entry.x;
    const dy = actual.y - entry.y;
    const error = Math.sqrt(dx * dx + dy * dy);

    this.currentError = error;
    this.errorSum += error;
    this.errorSamples++;
    this.errors[this.errorIndex] = error;
    this.errorIndex = (this.errorIndex + 1) % ERROR_WINDOW;
    if (this.errorCount < ERROR_WINDOW) this.errorCount++;
    if (error > NETWORK.reconcileSnapThreshold) this.snaps++;
  }

  private remember(state: GameSimState): void {
    const self = state.skaters.find((s) => s.controlledBy === this.seatId);
    const slot = ((state.tick % HISTORY_SIZE) + HISTORY_SIZE) % HISTORY_SIZE;
    this.history[slot] =
      self === undefined ? null : { tick: state.tick, skaterId: self.id, x: self.x, y: self.y };
  }

  // -------------------------------------------------------------------------
  // Building the input map for a replayed tick
  // -------------------------------------------------------------------------

  private inputsFor(state: GameSimState, localInput: PlayerInput): InputMap {
    const inputs: InputMap = {};
    for (const seat of state.seats) {
      if (!seat.connected) continue;
      inputs[seat.id] =
        seat.id === this.seatId ? localInput : inferRemoteInput(state, seat.id, state.tick);
    }
    // A spectator, or a seat the server has not put in the sim yet, still wants
    // its own intent in the map — `assignControl` skips seats it does not know,
    // so this costs nothing and covers the tick a seat is added on.
    if (inputs[this.seatId] === undefined) inputs[this.seatId] = localInput;
    return inputs;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The predicted state. Read-only: mutating it desyncs the next reconciliation. */
  get state(): GameSimState | null {
    return this.predicted;
  }

  get predictedTick(): number {
    return this.predicted?.tick ?? -1;
  }

  get authoritativeTick(): number {
    return this.authTick;
  }

  private selfSkater(): SkaterSimState | null {
    return this.predicted?.skaters.find((s) => s.controlledBy === this.seatId) ?? null;
  }

  private selfSkaterId(): string | null {
    return this.selfSkater()?.id ?? null;
  }

  private renderX(): number {
    const self = this.selfSkater();
    return self === null ? 0 : self.x + this.offsetX;
  }

  private renderY(): number {
    const self = this.selfSkater();
    return self === null ? 0 : self.y + this.offsetY;
  }

  /**
   * The controlled skater as it should be drawn, or null when this client has
   * none — a spectator, or a seat whose skater the server has not assigned yet.
   */
  self(): PredictedSelf | null {
    const skater = this.selfSkater();
    if (skater === null) return null;
    // The offset only belongs to the skater it was measured against; a
    // mid-flight auto-switch must not carry the old skater's correction over.
    const applies = this.offsetSkaterId === skater.id;
    return {
      id: skater.id,
      side: skater.side,
      playerId: skater.playerId,
      x: skater.x + (applies ? this.offsetX : 0),
      y: skater.y + (applies ? this.offsetY : 0),
      facing: skater.facing,
      turbo: skater.turbo,
      stun: skater.stun,
      windup: skater.windup,
      onFire: skater.onFire,
    };
  }

  /**
   * The puck, predicted — but ONLY while this client's own skater is carrying it.
   *
   * A carried puck is not an independent object: the simulation pins it to the
   * carrier's stick every tick. So when we draw our own skater from prediction
   * and the puck from the 100 ms playout buffer, the two are being drawn from
   * different moments in time, and the puck trails the stick that is supposedly
   * holding it by (interpolation delay x carrier speed) — about 2.7 ft at a
   * skill-65 skater's top speed, which is most of a body length, on the single
   * most common action in the game.
   *
   * Deliberately narrow: it returns null the moment anyone else has the puck, or
   * it is loose. A puck in flight or on an opponent's stick is exactly the case
   * where prediction is a guess about a human we cannot see, and it stays on the
   * honest 100 ms delay with everything else.
   */
  carriedPuck(): { x: number; y: number } | null {
    const skater = this.selfSkater();
    const state = this.predicted;
    if (skater === null || state === undefined || state === null) return null;
    if (state.puck.carrierId !== skater.id) return null;

    // The same offset the skater is drawn with, so the puck rides the corrected
    // stick rather than the raw predicted one.
    const applies = this.offsetSkaterId === skater.id;
    return {
      x: state.puck.x + (applies ? this.offsetX : 0),
      y: state.puck.y + (applies ? this.offsetY : 0),
    };
  }

  metrics(): PredictionMetrics {
    let p95 = 0;
    if (this.errorCount > 0) {
      const sorted = Array.from(this.errors.subarray(0, this.errorCount)).sort((a, b) => a - b);
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    return {
      currentErrorFeet: this.currentError,
      meanErrorFeet: this.errorSamples === 0 ? 0 : this.errorSum / this.errorSamples,
      p95ErrorFeet: p95,
      snaps: this.snaps,
      samples: this.errorSamples,
      controlMismatches: this.controlMismatches,
      pendingInputs: this.pending.length,
      stalled: !this.canPredict(),
      staleSnapshots: this.staleSnapshots,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * The stick we assume a remote seat is holding: the direction its skater is
 * already travelling, scaled by how fast it is going.
 *
 * Scaled rather than full-stick so a coasting or stationary opponent is not
 * predicted to sprint. `maxSpeedHigh` is the normaliser because the alternative
 * — looking up that seat's skater's `skating` attribute in the config — buys
 * accuracy that a guess about a human's thumb does not deserve.
 */
function inferRemoteInput(state: GameSimState, seatId: string, tick: number): PlayerInput {
  const input = emptyInput(tick);
  const skater = state.skaters.find((s) => s.controlledBy === seatId);
  if (skater === undefined) return input;

  const speed = Math.sqrt(skater.vx * skater.vx + skater.vy * skater.vy);
  if (speed <= 1e-6) return input;

  const magnitude = Math.min(1, speed / SKATER.maxSpeedHigh);
  input.moveX = quantizeAxis((skater.vx / speed) * magnitude);
  input.moveY = quantizeAxis((skater.vy / speed) * magnitude);
  return input;
}
