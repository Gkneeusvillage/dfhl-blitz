import { describe, expect, it } from 'vitest';

import { TICK_RATE } from '@dfhl/shared';

import { MAX_CATCHUP_TICKS, advanceFixedStep, createFixedStep, resetFixedStep } from './loop.js';

describe('advanceFixedStep', () => {
  it('emits one tick per step of real time', () => {
    const step = createFixedStep();
    expect(advanceFixedStep(step, step.stepMs)).toBe(1);
  });

  it('banks time smaller than a tick instead of losing it', () => {
    const step = createFixedStep();
    expect(advanceFixedStep(step, 8)).toBe(0);
    expect(advanceFixedStep(step, 8)).toBe(0);
    // 24 ms in: the third call crosses 16.67 and the leftover is kept.
    expect(advanceFixedStep(step, 8)).toBe(1);
    expect(step.accumulatorMs).toBeCloseTo(24 - step.stepMs, 6);
  });

  it('does not drift over a simulated minute of jittery timer callbacks', () => {
    // The property the whole design rests on: real time in, exact tick count
    // out. A per-callback step would land wherever the timer happened to fire.
    const step = createFixedStep();
    let ticks = 0;
    let elapsed = 0;
    // Deterministic jitter around the nominal interval, 14-20 ms.
    for (let i = 0; i < 3600; i++) {
      const delta = 14 + (i % 7);
      elapsed += delta;
      ticks += advanceFixedStep(step, delta);
    }
    const expected = Math.floor(elapsed / step.stepMs);
    expect(ticks).toBe(expected);
    expect(step.droppedTicks).toBe(0);
  });

  it('runs at TICK_RATE over one second of nominal callbacks', () => {
    const step = createFixedStep();
    let ticks = 0;
    for (let i = 0; i < TICK_RATE; i++) ticks += advanceFixedStep(step, 1000 / TICK_RATE);
    expect(ticks).toBe(TICK_RATE);
  });

  it('caps catch-up so a stall cannot start a spiral of death', () => {
    const step = createFixedStep();
    // Four seconds of stall would otherwise ask for 240 ticks in one pass, which
    // takes longer than four seconds and so asks for even more next pass.
    expect(advanceFixedStep(step, 4000)).toBe(MAX_CATCHUP_TICKS);
    expect(step.droppedTicks).toBe(Math.floor(4000 / step.stepMs) - MAX_CATCHUP_TICKS);
    // The backlog is abandoned, not carried: the next nominal frame is one tick.
    expect(step.accumulatorMs).toBe(0);
    expect(advanceFixedStep(step, step.stepMs)).toBe(1);
  });

  it('cannot bank unbounded debt from a suspended process', () => {
    const step = createFixedStep();
    advanceFixedStep(step, 10 * 60 * 1000);
    expect(step.accumulatorMs).toBe(0);
    // Ten minutes away leaves the room a tick behind, not ten minutes behind.
    expect(advanceFixedStep(step, step.stepMs)).toBe(1);
  });

  it('refuses a delta that is not usable real time', () => {
    const step = createFixedStep();
    for (const delta of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(advanceFixedStep(step, delta)).toBe(0);
    }
    expect(step.accumulatorMs).toBe(0);
  });

  it('catches up across a modest hiccup without dropping anything', () => {
    const step = createFixedStep();
    // A 100 ms GC pause is six ticks, inside the cap.
    expect(advanceFixedStep(step, 100)).toBe(6);
    expect(step.droppedTicks).toBe(0);
  });
});

describe('resetFixedStep', () => {
  it('starts a match on a clean clock', () => {
    const step = createFixedStep();
    advanceFixedStep(step, 4000);
    advanceFixedStep(step, 10);
    expect(step.accumulatorMs).toBeGreaterThan(0);

    resetFixedStep(step);
    expect(step.accumulatorMs).toBe(0);
    expect(step.droppedTicks).toBe(0);
    expect(advanceFixedStep(step, step.stepMs - 0.001)).toBe(0);
  });
});
