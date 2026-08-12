/**
 * Client-side prediction and reconciliation, as a headless bot runs it.
 *
 * This is the same model `client/src/net` renders against, kept as its own file
 * here so the harness can measure the netcode without depending on a Phaser
 * scene existing — and so a divergence the harness reports is a divergence in
 * the *model*, not in somebody's render loop.
 *
 * THE MODEL, IN THE ORDER IT HAPPENS
 *
 *   local tick     step the predicted state forward with this client's own real
 *                  input. Remote seats are absent from the InputMap, which the
 *                  simulation reads as idle (`humanInputFor` falls back to
 *                  `emptyInput`) — a client is never told what another human
 *                  pressed, so idle is the only honest guess available.
 *
 *   snapshot       score the prediction that was on screen for that tick, then
 *                  rewind to the server's state and replay every input the
 *                  server has not acknowledged. `ackInputTick` is per-seat and
 *                  is the newest input tick the server APPLIED for us, so
 *                  "inputs after the ack" is exactly the set the server has yet
 *                  to see the effect of.
 *
 * WHY THE ERROR IS MEASURED AGAINST THE *FIRST* PREDICTION FOR A TICK: a rewind
 * re-predicts ticks that have already been displayed. Grading the corrected
 * value against the authority would report how well the client can copy a
 * snapshot it is holding, which is not a question anybody has. The number worth
 * having is how far what the player already saw was from the truth, so the
 * earliest prediction for a tick is the one kept.
 *
 * WHAT IS DELIBERATELY NOT HERE: interpolation. A bot has nothing to render, and
 * the interpolation buffer only decides what remote entities look like — it
 * cannot change what the server does or what this client predicts. The property
 * of the stream that actually decides whether a 100 ms buffer is enough is the
 * snapshot ARRIVAL INTERVAL, and that is measured in `botclient.ts`.
 */

import { NETWORK, cloneState, distance, stepMatch } from '@dfhl/shared';
import type {
  GameSimState,
  InputMap,
  MatchConfig,
  PlayerInput,
  SnapshotMessage,
} from '@dfhl/shared';

/**
 * Unacknowledged inputs kept before the oldest is abandoned.
 *
 * Eight times the prediction cap, four seconds at 60 Hz. Reaching this means the
 * server has acknowledged nothing for four seconds, at which point the seat is
 * disconnected or the room is dead and a faithful replay is not the problem.
 */
const MAX_HISTORY = NETWORK.maxPredictionTicks * 8;

interface PredictionSample {
  /** Which skater this client believed it was driving on that tick. */
  skaterId: string;
  x: number;
  y: number;
}

export interface PredictionMetrics {
  /** Feet between prediction and authority, one entry per graded snapshot. */
  errors: number[];
  /** Errors past NETWORK.reconcileSnapThreshold — the ones a real client hard-snaps. */
  snaps: number;
  /** Unacknowledged inputs at each snapshot: how deep the prediction was running. */
  depths: number[];
  /** Snapshots where the server had us driving a different skater than we predicted. */
  controlMismatches: number;
  /** Ticks not predicted because NETWORK.maxPredictionTicks was reached. */
  stalledTicks: number;
  /** Snapshots with no prediction to grade (start-up, or after a stall). */
  ungraded: number;
  /** Total ticks re-simulated by reconciliation. The CPU cost of this design. */
  replayTicks: number;
  /** Inputs abandoned because the server acknowledged nothing for MAX_HISTORY ticks. */
  historyOverruns: number;
}

function emptyMetrics(): PredictionMetrics {
  return {
    errors: [],
    snaps: 0,
    depths: [],
    controlMismatches: 0,
    stalledTicks: 0,
    ungraded: 0,
    replayTicks: 0,
    historyOverruns: 0,
  };
}

export class Predictor {
  readonly metrics = emptyMetrics();

  /** The predicted state, or null until the first snapshot gives us something to predict from. */
  state: GameSimState | null = null;

  /** Tick of the newest snapshot applied. -1 before the first one. */
  authTick = -1;

  /** Newest input tick the server says it has applied for this seat. */
  ackTick = -1;

  private history: PlayerInput[] = [];
  private readonly samples = new Map<number, PredictionSample>();

  constructor(
    private readonly config: MatchConfig,
    private readonly seatId: string,
  ) {}

  /** Unacknowledged inputs: the depth the prediction is currently running at. */
  get depth(): number {
    return this.history.length;
  }

  /**
   * Advance one local tick.
   *
   * The input is recorded whether or not it is simulated: it still has to be
   * sent, and the server will still apply it, so dropping it from the history
   * would put the next replay out of phase with the authority.
   */
  step(input: PlayerInput): void {
    this.history.push(input);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
      this.metrics.historyOverruns++;
    }

    if (this.state === null) return;
    if (this.authTick >= 0 && this.state.tick - this.authTick >= NETWORK.maxPredictionTicks) {
      // Past the cap the prediction is a guess about a guess. Freezing is the
      // honest failure: the skater stops rather than skating somewhere the
      // server is about to disagree with by half a rink.
      this.metrics.stalledTicks++;
      return;
    }
    this.advance(this.state, input);
  }

  /** Rewind to the authority and replay. Returns the error that was graded, if any. */
  applySnapshot(snapshot: SnapshotMessage): number | null {
    const graded = this.grade(snapshot);

    this.authTick = snapshot.tick;
    this.ackTick = snapshot.ackInputTick;

    // Everything at or before the authoritative tick has been answered.
    for (const tick of this.samples.keys()) {
      if (tick <= snapshot.tick) this.samples.delete(tick);
    }
    this.history = this.history.filter((input) => input.tick > snapshot.ackInputTick);
    this.metrics.depths.push(this.history.length);

    // `cloneState` rather than the wire object itself: the decoded snapshot is
    // handed to the interpolation buffer as well, and a simulation stepping over
    // a state somebody else is reading is a bug that surfaces as a flicker.
    const replayed = cloneState(snapshot.state);
    const limit = Math.min(this.history.length, NETWORK.maxPredictionTicks);
    for (let i = 0; i < limit; i++) this.advance(replayed, this.history[i]);
    this.metrics.replayTicks += limit;
    this.state = replayed;

    return graded;
  }

  private grade(snapshot: SnapshotMessage): number | null {
    const sample = this.samples.get(snapshot.tick);
    if (sample === undefined) {
      if (this.state !== null) this.metrics.ungraded++;
      return null;
    }

    const actual = snapshot.state.skaters.find((skater) => skater.id === sample.skaterId);
    if (actual === undefined) return null;

    if (actual.controlledBy !== this.seatId) this.metrics.controlMismatches++;

    const error = distance(sample.x, sample.y, actual.x, actual.y);
    this.metrics.errors.push(error);
    if (error > NETWORK.reconcileSnapThreshold) this.metrics.snaps++;
    return error;
  }

  private advance(state: GameSimState, input: PlayerInput): void {
    const inputs: InputMap = { [this.seatId]: input };
    stepMatch(state, inputs, this.config);

    const mine = state.skaters.find((skater) => skater.controlledBy === this.seatId);
    if (mine === undefined) return;
    // First write wins: this is the value that was displayed for that tick.
    if (this.samples.has(state.tick)) return;
    this.samples.set(state.tick, { skaterId: mine.id, x: mine.x, y: mine.y });
  }
}
