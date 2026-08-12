/**
 * The fixed-timestep accumulator that drives the authoritative loop.
 *
 * WHY NOT JUST STEP ONCE PER TIMER CALLBACK: `setInterval(fn, 16.6)` does not
 * fire every 16.6 ms. It fires late, it coalesces under load, and on a busy
 * host it can drift by whole frames. Stepping the simulation once per callback
 * would make the tick rate a function of the server's mood — and since the
 * client predicts by running the *same* number of ticks over the same wall
 * time, a server that quietly runs at 57 Hz makes every client wrong. The
 * accumulator decouples the two: real time goes in, whole ticks come out, and
 * a tick is always exactly 1/60 s of simulated hockey.
 *
 * WHY THE CAP: without one, a 4-second stall asks for 240 catch-up ticks, which
 * takes longer than 4 seconds to compute, which asks for more ticks next pass.
 * That is the spiral of death, and it ends with a room that never recovers. We
 * cap the catch-up and drop the rest of the backlog on the floor. Dropping
 * simulated time is a visible glitch; the spiral is a dead room.
 */

import { TICK_RATE } from '@dfhl/shared';

export interface FixedStep {
  /** Simulated milliseconds per tick. */
  readonly stepMs: number;
  /** Most ticks one `advanceFixedStep` call may return. */
  readonly maxStepsPerAdvance: number;
  accumulatorMs: number;
  /** Ticks of simulated time abandoned to the catch-up cap. Diagnostics only. */
  droppedTicks: number;
}

/**
 * Eight ticks is 133 ms of catch-up per pass: comfortably over a garbage
 * collection pause or a slow snapshot encode, comfortably under the point where
 * catching up costs more than the time it is trying to recover.
 */
export const MAX_CATCHUP_TICKS = 8;

export function createFixedStep(
  rate: number = TICK_RATE,
  maxStepsPerAdvance: number = MAX_CATCHUP_TICKS,
): FixedStep {
  return {
    stepMs: 1000 / rate,
    maxStepsPerAdvance,
    accumulatorMs: 0,
    droppedTicks: 0,
  };
}

/**
 * Fold real elapsed time into the accumulator and report how many whole ticks
 * to simulate.
 *
 * @param deltaMs real milliseconds since the previous call.
 */
export function advanceFixedStep(step: FixedStep, deltaMs: number): number {
  // A non-finite or negative delta means the clock did something we do not
  // understand, and refusing to simulate is the safe answer to that.
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;

  step.accumulatorMs += deltaMs;

  const ticks = Math.floor(step.accumulatorMs / step.stepMs);
  if (ticks <= 0) return 0;

  if (ticks > step.maxStepsPerAdvance) {
    // The backlog is larger than we are willing to chase. Run the cap and
    // abandon the rest of it outright: carrying the remainder forward is
    // exactly how one stall becomes a spiral, and it is also the only thing
    // that could let `accumulatorMs` grow without bound.
    step.droppedTicks += ticks - step.maxStepsPerAdvance;
    step.accumulatorMs = 0;
    return step.maxStepsPerAdvance;
  }

  step.accumulatorMs -= ticks * step.stepMs;
  return ticks;
}

/** Forget any banked time. Used when a match starts, so it begins on a clean clock. */
export function resetFixedStep(step: FixedStep): void {
  step.accumulatorMs = 0;
  step.droppedTicks = 0;
}
