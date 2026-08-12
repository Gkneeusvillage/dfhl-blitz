import { describe, expect, it } from 'vitest';

import { AXIS_QUANT, NETWORK } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import {
  INPUT_LIMITS,
  acceptInputPacket,
  consumeInput,
  createInputBuffer,
  sanitizeInput,
} from './input.js';

function input(tick: number, overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    tick,
    moveX: 0,
    moveY: 0,
    shoot: false,
    pass: false,
    turbo: false,
    switchPlayer: false,
    ...overrides,
  };
}

describe('sanitizeInput — tick', () => {
  it('accepts a plain input at the server tick', () => {
    expect(sanitizeInput(input(10), 10)).toEqual(input(10));
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 7, 'input', true, []]) {
      // An array has no `tick`, so it falls out at the same gate.
      expect(sanitizeInput(raw, 0)).toBeNull();
    }
  });

  it('refuses a tick that is missing, fractional, negative, or not a number', () => {
    expect(sanitizeInput({ moveX: 0 }, 0)).toBeNull();
    expect(sanitizeInput(input(1.5), 10)).toBeNull();
    expect(sanitizeInput(input(-1), 10)).toBeNull();
    expect(sanitizeInput({ ...input(0), tick: '5' }, 10)).toBeNull();
    expect(sanitizeInput({ ...input(0), tick: Number.NaN }, 10)).toBeNull();
    expect(sanitizeInput({ ...input(0), tick: Number.POSITIVE_INFINITY }, 10)).toBeNull();
  });

  it('refuses a tick absurdly far ahead of the server, and accepts one at the limit', () => {
    const serverTick = 1000;
    const limit = serverTick + INPUT_LIMITS.maxLeadTicks;
    expect(sanitizeInput(input(limit), serverTick)).not.toBeNull();
    expect(sanitizeInput(input(limit + 1), serverTick)).toBeNull();
    expect(sanitizeInput(input(10_000_000), serverTick)).toBeNull();
  });

  it('leaves room for the prediction window a healthy client actually uses', () => {
    // A client legitimately runs up to maxPredictionTicks past the last snapshot
    // it saw, and that snapshot is up to a round trip old.
    expect(INPUT_LIMITS.maxLeadTicks).toBeGreaterThan(NETWORK.maxPredictionTicks);
  });
});

describe('sanitizeInput — the security boundary', () => {
  it('returns a fresh object built from exactly the seven input fields', () => {
    const hostile = {
      tick: 5,
      moveX: 10,
      moveY: -10,
      shoot: true,
      pass: false,
      turbo: true,
      switchPlayer: false,
      // Everything a cheat would try to smuggle in:
      x: 999,
      y: 999,
      score: { home: 99, away: 0 },
      state: { tick: 0 },
      seatId: 'somebody-else',
      controlledBy: 'home-0',
      rng: 1234,
    };
    const clean = sanitizeInput(hostile, 5);
    expect(clean).not.toBeNull();
    expect(Object.keys(clean as object).sort()).toEqual([
      'moveX',
      'moveY',
      'pass',
      'shoot',
      'switchPlayer',
      'tick',
      'turbo',
    ]);
    expect(clean).not.toBe(hostile);
  });

  it('clamps axes into the quantized range the simulation is defined over', () => {
    expect(sanitizeInput(input(0, { moveX: 5000, moveY: -5000 }), 0)).toEqual(
      input(0, { moveX: AXIS_QUANT, moveY: -AXIS_QUANT }),
    );
    expect(sanitizeInput(input(0, { moveX: AXIS_QUANT + 1 }), 0)?.moveX).toBe(AXIS_QUANT);
    expect(sanitizeInput(input(0, { moveX: -AXIS_QUANT - 1 }), 0)?.moveX).toBe(-AXIS_QUANT);
  });

  it('rounds fractional axes and zeroes unusable ones', () => {
    expect(sanitizeInput(input(0, { moveX: 12.6 }), 0)?.moveX).toBe(13);
    expect(sanitizeInput({ ...input(0), moveX: Number.NaN }, 0)?.moveX).toBe(0);
    expect(sanitizeInput({ ...input(0), moveX: Number.POSITIVE_INFINITY }, 0)?.moveX).toBe(0);
    expect(sanitizeInput({ ...input(0), moveX: '127' }, 0)?.moveX).toBe(0);
    expect(sanitizeInput({ ...input(0), moveY: undefined }, 0)?.moveY).toBe(0);
  });

  it('treats anything that is not exactly `true` as a released button', () => {
    const clean = sanitizeInput(
      { tick: 0, moveX: 0, moveY: 0, shoot: 1, pass: 'yes', turbo: {}, switchPlayer: true },
      0,
    );
    expect(clean).toEqual(input(0, { switchPlayer: true }));
  });

  it('cannot be used to reach the prototype', () => {
    const clean = sanitizeInput(
      JSON.parse('{"tick":0,"moveX":0,"moveY":0,"__proto__":{"polluted":true}}'),
      0,
    );
    expect(clean).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('acceptInputPacket', () => {
  it('refuses a packet that is not an object with an inputs array', () => {
    const buffer = createInputBuffer();
    for (const message of [null, undefined, 5, 'input', { inputs: 'nope' }, {}]) {
      expect(acceptInputPacket(buffer, message, 0)).toBe(0);
    }
    expect(buffer.pending).toHaveLength(0);
    expect(buffer.refused).toBe(6);
  });

  it('queues previously unseen ticks', () => {
    const buffer = createInputBuffer();
    expect(acceptInputPacket(buffer, { inputs: [input(0), input(1), input(2)] }, 0)).toBe(3);
    expect(buffer.pending.map((i) => i.tick)).toEqual([0, 1, 2]);
  });

  it('ignores a repeat of the same packet — redundancy is not an error', () => {
    const buffer = createInputBuffer();
    const packet = { inputs: [input(0), input(1)] };
    expect(acceptInputPacket(buffer, packet, 0)).toBe(2);
    expect(acceptInputPacket(buffer, packet, 0)).toBe(0);
    expect(buffer.pending.map((i) => i.tick)).toEqual([0, 1]);
    expect(buffer.refused).toBe(0);
  });

  it('ignores ticks already applied', () => {
    const buffer = createInputBuffer();
    acceptInputPacket(buffer, { inputs: [input(0), input(1)] }, 0);
    consumeInput(buffer);
    consumeInput(buffer);
    expect(buffer.ackTick).toBe(1);
    expect(acceptInputPacket(buffer, { inputs: [input(0), input(1), input(2)] }, 1)).toBe(1);
    expect(buffer.pending.map((i) => i.tick)).toEqual([2]);
  });

  it('sorts ticks that arrive out of order', () => {
    const buffer = createInputBuffer();
    acceptInputPacket(buffer, { inputs: [input(4), input(5)] }, 0);
    acceptInputPacket(buffer, { inputs: [input(2), input(3)] }, 0);
    expect(buffer.pending.map((i) => i.tick)).toEqual([2, 3, 4, 5]);
  });

  it('keeps the newest end of an oversized packet', () => {
    const buffer = createInputBuffer();
    const flood = Array.from({ length: 200 }, (_, i) => input(i));
    const accepted = acceptInputPacket(buffer, { inputs: flood }, 199);
    expect(accepted).toBe(INPUT_LIMITS.maxPacketInputs);
    expect(buffer.pending[buffer.pending.length - 1].tick).toBe(199);
  });

  it('caps the buffer, dropping the stale end rather than the fresh one', () => {
    const buffer = createInputBuffer();
    const depth = INPUT_LIMITS.maxBufferedTicks;
    for (let tick = 0; tick < depth + 20; tick++) {
      acceptInputPacket(buffer, { inputs: [input(tick)] }, tick);
    }
    expect(buffer.pending).toHaveLength(depth);
    expect(buffer.pending[buffer.pending.length - 1].tick).toBe(depth + 19);
    expect(buffer.pending[0].tick).toBe(20);
    expect(buffer.overrun).toBe(20);
  });

  it('counts a malformed entry as refused without discarding its neighbours', () => {
    const buffer = createInputBuffer();
    const accepted = acceptInputPacket(buffer, { inputs: [input(0), 'garbage', input(1)] }, 0);
    expect(accepted).toBe(2);
    expect(buffer.refused).toBe(1);
    expect(buffer.pending.map((i) => i.tick)).toEqual([0, 1]);
  });

  it('keeps the first copy when a tick is resent with different content', () => {
    // Redundant resends are supposed to be identical. One that is not is either
    // a broken client or somebody trying to rewrite the past.
    const buffer = createInputBuffer();
    acceptInputPacket(buffer, { inputs: [input(3, { shoot: true })] }, 3);
    acceptInputPacket(buffer, { inputs: [input(3, { shoot: false, moveX: 127 })] }, 3);
    expect(buffer.pending).toHaveLength(1);
    expect(buffer.pending[0]).toEqual(input(3, { shoot: true }));
  });
});

describe('consumeInput', () => {
  it('starts with nothing acknowledged, so a fresh client replays everything', () => {
    expect(createInputBuffer().ackTick).toBe(-1);
  });

  it('takes one input per call, in order', () => {
    const buffer = createInputBuffer();
    acceptInputPacket(buffer, { inputs: [input(0, { moveX: 1 }), input(1, { moveX: 2 })] }, 0);
    expect(consumeInput(buffer).moveX).toBe(1);
    expect(consumeInput(buffer).moveX).toBe(2);
  });

  it('advances ackTick to the tick it just applied', () => {
    const buffer = createInputBuffer();
    acceptInputPacket(buffer, { inputs: [input(7), input(8)] }, 7);
    consumeInput(buffer);
    expect(buffer.ackTick).toBe(7);
    consumeInput(buffer);
    expect(buffer.ackTick).toBe(8);
  });

  it('repeats the last input when nothing arrived, and does not move the ack', () => {
    const buffer = createInputBuffer();
    acceptInputPacket(buffer, { inputs: [input(0, { turbo: true, moveX: 60 })] }, 0);
    const applied = consumeInput(buffer);
    expect(applied.turbo).toBe(true);
    // Two dry ticks: a skater must not let go of the stick because a packet
    // went missing.
    expect(consumeInput(buffer)).toEqual(applied);
    expect(consumeInput(buffer)).toEqual(applied);
    expect(buffer.ackTick).toBe(0);
  });

  it('is idle before the seat has sent anything', () => {
    const buffer = createInputBuffer();
    expect(consumeInput(buffer)).toEqual(input(0));
  });

  it('survives the loss of every packet but the last, without losing a press', () => {
    // The redundancy contract: the server applies ticks it has not seen, so one
    // surviving packet carrying the last N inputs covers the N-1 that were lost.
    const buffer = createInputBuffer();
    const history = Array.from({ length: 8 }, (_, tick) =>
      input(tick, { shoot: tick === 5, moveX: tick }),
    );
    const redundancy = NETWORK.inputRedundancy;
    // Only the final packet lands.
    acceptInputPacket(buffer, { inputs: history.slice(8 - redundancy) }, 7);

    const applied: PlayerInput[] = [];
    for (let i = 0; i < redundancy; i++) applied.push(consumeInput(buffer));
    expect(applied.map((i) => i.tick)).toEqual(history.slice(8 - redundancy).map((i) => i.tick));
    expect(applied.some((i) => i.shoot)).toBe(true);
  });
});
