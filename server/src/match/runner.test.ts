import { describe, expect, it } from 'vitest';

import { TICKS_PER_SNAPSHOT, TICK_RATE, cloneState, emptyInput } from '@dfhl/shared';
import type { MatchConfig, PlayerInput, Seat, SnapshotMessage } from '@dfhl/shared';

import { acceptInputPacket } from '../rooms/input.js';
import { defaultSettings } from '../rooms/lobby.js';
import { buildMatchConfig } from './config.js';
import {
  clearSnapshotWindow,
  createRunner,
  gatherInputs,
  runTicks,
  snapshotFor,
} from './runner.js';

function config(overrides: Partial<{ periodSeconds: number; periods: number }> = {}): MatchConfig {
  return buildMatchConfig(
    7,
    { ...defaultSettings(), ...overrides },
    { teamCode: 'Det', lineup: null },
    { teamCode: 'TSP', lineup: null },
  );
}

function seat(id: string, side: Seat['side'], connected = true): Seat {
  return { id, side, nickname: id, connected };
}

function input(tick: number, overrides: Partial<PlayerInput> = {}): PlayerInput {
  return { ...emptyInput(tick), ...overrides };
}

describe('createRunner', () => {
  it('starts the simulation with the seats the room handed it', () => {
    const runner = createRunner(config(), [seat('a', 'home'), seat('b', 'away')]);
    expect(runner.state.tick).toBe(0);
    expect(runner.state.seats.map((s) => s.id)).toEqual(['a', 'b']);
    expect([...runner.seatIds]).toEqual(['a', 'b']);
    expect([...runner.buffers.keys()]).toEqual(['a', 'b']);
  });

  it('copies the seats rather than aliasing the room’s own objects', () => {
    const seats = [seat('a', 'home')];
    const runner = createRunner(config(), seats);
    expect(runner.state.seats[0]).not.toBe(seats[0]);
    expect(runner.state.seats[0]).toEqual(seats[0]);
  });
});

describe('gatherInputs', () => {
  it('consumes exactly one queued input per seat per tick', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    const buffer = runner.buffers.get('a');
    if (buffer === undefined) throw new Error('missing buffer');
    acceptInputPacket(buffer, { inputs: [input(0, { moveX: 10 }), input(1, { moveX: 20 })] }, 0);

    expect(gatherInputs(runner).a.moveX).toBe(10);
    expect(gatherInputs(runner).a.moveX).toBe(20);
    // Dry: the last intent repeats.
    expect(gatherInputs(runner).a.moveX).toBe(20);
  });

  it('gives a disconnected seat no input and leaves its buffer untouched', () => {
    const runner = createRunner(config(), [seat('a', 'home'), seat('b', 'away', false)]);
    const buffer = runner.buffers.get('b');
    if (buffer === undefined) throw new Error('missing buffer');
    acceptInputPacket(buffer, { inputs: [input(0, { moveX: 90 })] }, 0);

    const inputs = gatherInputs(runner);
    expect(Object.keys(inputs)).toEqual(['a']);
    expect(buffer.pending).toHaveLength(1);
    expect(buffer.ackTick).toBe(-1);
  });

  it('ignores a client with no buffer — a spectator who arrived mid-match', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    runner.state.seats.push(seat('late', 'away'));
    expect(Object.keys(gatherInputs(runner))).toEqual(['a']);
  });
});

describe('runTicks', () => {
  it('advances the simulation by exactly the tick count asked for', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    runTicks(runner, 10, () => clearSnapshotWindow(runner));
    expect(runner.state.tick).toBe(10);
  });

  it('emits a snapshot every TICKS_PER_SNAPSHOT ticks and no more often', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    const snapshotTicks: number[] = [];
    runTicks(runner, 60, () => {
      snapshotTicks.push(runner.state.tick);
      clearSnapshotWindow(runner);
    });
    expect(snapshotTicks).toHaveLength(60 / TICKS_PER_SNAPSHOT);
    expect(snapshotTicks[0]).toBe(TICKS_PER_SNAPSHOT);
    expect(snapshotTicks[snapshotTicks.length - 1]).toBe(60);
  });

  it('keeps its cadence across calls, so a jittery timer cannot skew the rate', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    let snapshots = 0;
    const emit = (): void => {
      snapshots++;
      clearSnapshotWindow(runner);
    };
    // 1 + 2 + 1 + 2 ... ticks per pass: 60 ticks all told.
    for (let i = 0; i < 40; i++) runTicks(runner, i % 2 === 0 ? 1 : 2, emit);
    expect(runner.state.tick).toBe(60);
    expect(snapshots).toBe(60 / TICKS_PER_SNAPSHOT);
  });

  it('gathers events into the open snapshot window and clears them with it', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    let sawEvents = false;
    // A couple of seconds is plenty for a faceoff and some whistles.
    for (let pass = 0; pass < 200; pass++) {
      runTicks(runner, 1, () => {
        if (runner.pendingEvents.length > 0) sawEvents = true;
        clearSnapshotWindow(runner);
        expect(runner.pendingEvents).toHaveLength(0);
      });
    }
    expect(sawEvents).toBe(true);
  });

  it('stops at the final whistle and reports it', () => {
    // One 5 s period, no overtime needed to reach a decision most seeds.
    const runner = createRunner(config({ periods: 1, periodSeconds: 5 }), [seat('a', 'home')]);
    let finished = false;
    let guard = 0;
    while (!finished && guard++ < 200) {
      finished = runTicks(runner, 60, () => clearSnapshotWindow(runner));
    }
    expect(finished).toBe(true);
    expect(runner.state.phase).toBe('final');

    // Nothing moves after the whistle: `stepMatch` returns immediately on a
    // final state, so a stray extra pass cannot change the result.
    const settled = cloneState(runner.state);
    runTicks(runner, 30, () => clearSnapshotWindow(runner));
    expect(runner.state.score).toEqual(settled.score);
    expect(runner.state.puck).toEqual(settled.puck);
    expect(runner.state.skaters).toEqual(settled.skaters);
  });

  it('always reaches a final whistle, however the scoreline falls', () => {
    // Two 20-second periods is well inside the fuzz suite's tolerance for a
    // stalled game, and a 0-0 that goes to overtime and a shootout still has to
    // terminate — this is the property, not the scoreline.
    const runner = createRunner(config({ periods: 2, periodSeconds: 20 }), [
      seat('a', 'home'),
      seat('b', 'away'),
    ]);
    let seconds = 0;
    while (!runTicks(runner, TICK_RATE, () => clearSnapshotWindow(runner)) && seconds++ < 600);
    expect(seconds).toBeLessThan(600);
    expect(runner.state.phase).toBe('final');
    expect(runner.state.period).toBeGreaterThanOrEqual(2);
    expect(runner.state.skaters.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(
      true,
    );
  });
});

describe('snapshotFor', () => {
  it('is per recipient: each seat gets its own ackInputTick', () => {
    const runner = createRunner(config(), [seat('a', 'home'), seat('b', 'away')]);
    const bufferA = runner.buffers.get('a');
    const bufferB = runner.buffers.get('b');
    if (bufferA === undefined || bufferB === undefined) throw new Error('missing buffer');

    acceptInputPacket(bufferA, { inputs: [input(0), input(1), input(2)] }, 0);
    acceptInputPacket(bufferB, { inputs: [input(0)] }, 0);

    runTicks(runner, TICKS_PER_SNAPSHOT, () => {
      expect(snapshotFor(runner, 'a', 0).ackInputTick).toBe(2);
      expect(snapshotFor(runner, 'b', 0).ackInputTick).toBe(0);
      clearSnapshotWindow(runner);
    });
  });

  it('acknowledges nothing for a seat that has never sent an input', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    expect(snapshotFor(runner, 'a', 0).ackInputTick).toBe(-1);
    // And for a spectator with no buffer at all.
    expect(snapshotFor(runner, 'nobody', 0).ackInputTick).toBe(-1);
  });

  it('carries the authoritative tick, the whole state, and the server clock', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    runTicks(runner, 5, () => clearSnapshotWindow(runner));
    const snapshot = snapshotFor(runner, 'a', 1234);
    expect(snapshot.tick).toBe(5);
    expect(snapshot.tick).toBe(snapshot.state.tick);
    expect(snapshot.serverTime).toBe(1234);
    expect(snapshot.state.skaters).toHaveLength(12);
    expect(snapshot.state.goalies).toHaveLength(2);
  });

  it('survives a JSON round trip, which is the shape msgpack will encode', () => {
    const runner = createRunner(config(), [seat('a', 'home')]);
    runTicks(runner, 90, () => clearSnapshotWindow(runner));
    const snapshot = snapshotFor(runner, 'a', 0);
    const decoded = JSON.parse(JSON.stringify(snapshot)) as SnapshotMessage;
    expect(decoded.state).toEqual(snapshot.state);
    expect(decoded.state.rng).toBe(snapshot.state.rng);
  });
});

describe('clearSnapshotWindow', () => {
  it('replaces the event array rather than emptying the one already handed out', () => {
    // Truncating in place would quietly send an empty event list to whichever
    // client came last in the send loop.
    const runner = createRunner(config(), [seat('a', 'home')]);
    runner.pendingEvents.push({ type: 'whistle', tick: 1 });
    const handedOut = snapshotFor(runner, 'a', 0).events;
    clearSnapshotWindow(runner);
    expect(handedOut).toHaveLength(1);
    expect(runner.pendingEvents).toHaveLength(0);
  });
});
