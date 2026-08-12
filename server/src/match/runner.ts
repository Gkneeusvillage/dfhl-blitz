/**
 * The authoritative loop's body, with the socket taken out of it.
 *
 * `MatchRoom` owns the timer, the clients, and the wire; everything that
 * decides *what the match does* lives here, as plain functions over a plain
 * object. That split is deliberate — the snapshot cadence, the per-seat
 * `ackInputTick`, and the rule that a disconnected seat contributes no input
 * are the three things in the netcode most worth pinning with a test, and none
 * of them should need a WebSocket to exercise.
 *
 * Note what is NOT here: the room does not clone the simulation state to send
 * it. `snapshotFor` hands out a live reference, because Colyseus encodes to
 * msgpack inside `client.send` before it returns and the next mutation is a
 * whole tick away. Twenty deep copies a second of a state that is about to be
 * serialised anyway is a cost with nothing on the other side of it.
 */

import { TICKS_PER_SNAPSHOT, createMatch, stepMatch } from '@dfhl/shared';
import type {
  GameSimState,
  InputMap,
  MatchConfig,
  Seat,
  SimEvent,
  SnapshotMessage,
} from '@dfhl/shared';

import { consumeInput, createInputBuffer, type SeatInputBuffer } from '../rooms/input.js';

export interface MatchRunner {
  readonly config: MatchConfig;
  readonly state: GameSimState;
  /** One jitter buffer per seat, keyed by Colyseus `sessionId`. */
  readonly buffers: Map<string, SeatInputBuffer>;
  /**
   * Seats that were in the room when this match started.
   *
   * A player arriving mid-match watches until the next lobby rather than
   * materialising on the ice; a seat held open for a reconnect stays in the set,
   * so its skater is waiting when the player gets back.
   */
  readonly seatIds: Set<string>;
  /** Events produced since the last snapshot. Presentation only. */
  pendingEvents: SimEvent[];
  ticksSinceSnapshot: number;
}

export function createRunner(config: MatchConfig, seats: Seat[]): MatchRunner {
  const state = createMatch(config);
  state.seats = seats.map((seat) => ({ ...seat }));

  const buffers = new Map<string, SeatInputBuffer>();
  const seatIds = new Set<string>();
  for (const seat of seats) {
    buffers.set(seat.id, createInputBuffer());
    seatIds.add(seat.id);
  }

  return { config, state, buffers, seatIds, pendingEvents: [], ticksSinceSnapshot: 0 };
}

/**
 * The inputs one tick runs on.
 *
 * Exactly one queued input is consumed per seat per tick, so button presses keep
 * their order. A disconnected seat is skipped rather than fed an idle input:
 * `assignControl` already declines to give it a skater, and leaving its buffer
 * untouched means a reconnect does not find its queue silently drained.
 */
export function gatherInputs(runner: MatchRunner): InputMap {
  const inputs: InputMap = {};
  for (const seat of runner.state.seats) {
    if (!seat.connected) continue;
    const buffer = runner.buffers.get(seat.id);
    if (buffer !== undefined) inputs[seat.id] = consumeInput(buffer);
  }
  return inputs;
}

/**
 * Advance the match by up to `ticks` ticks.
 *
 * `emitSnapshot` is called every `TICKS_PER_SNAPSHOT` ticks — 20 Hz against the
 * 60 Hz simulation — and again is expected to finish with
 * `clearSnapshotWindow`.
 *
 * @returns true once the match has reached its final whistle, at which point no
 *          further ticks are run.
 */
export function runTicks(runner: MatchRunner, ticks: number, emitSnapshot: () => void): boolean {
  for (let i = 0; i < ticks; i++) {
    const events = stepMatch(runner.state, gatherInputs(runner), runner.config);
    for (const event of events) runner.pendingEvents.push(event);

    runner.ticksSinceSnapshot++;
    if (runner.ticksSinceSnapshot >= TICKS_PER_SNAPSHOT) emitSnapshot();

    if (runner.state.phase === 'final') return true;
  }
  return false;
}

/**
 * The snapshot for one recipient.
 *
 * `ackInputTick` is what makes this per-client rather than a broadcast: it is
 * the newest input tick applied for THAT seat and the point its own prediction
 * replays from, so one payload cannot serve six of them. -1 means "nothing of
 * yours has been applied", which correctly tells a fresh client to replay its
 * entire input history.
 */
export function snapshotFor(runner: MatchRunner, seatId: string, serverTime: number): SnapshotMessage {
  const buffer = runner.buffers.get(seatId);
  return {
    tick: runner.state.tick,
    ackInputTick: buffer === undefined ? -1 : buffer.ackTick,
    state: runner.state,
    events: runner.pendingEvents,
    serverTime,
  };
}

/**
 * Open a fresh snapshot window.
 *
 * `pendingEvents` is replaced rather than emptied in place, because the array
 * that was just handed to `snapshotFor` may still be referenced by an encoder;
 * truncating it would be a subtle way to send an empty event list to whoever
 * came last in the loop.
 */
export function clearSnapshotWindow(runner: MatchRunner): void {
  runner.ticksSinceSnapshot = 0;
  runner.pendingEvents = [];
}
