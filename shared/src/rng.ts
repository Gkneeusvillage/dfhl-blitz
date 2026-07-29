/**
 * Deterministic pseudo-random number generator.
 *
 * The simulation must never call Math.random(): server and client run the same
 * `stepMatch` code and must produce bit-identical results from the same inputs.
 * All randomness flows through this generator, whose entire state is a single
 * uint32 carried inside GameSimState.
 *
 * Algorithm: mulberry32 (fast, well-distributed, trivially serializable).
 */

/** Advance the state and return the next uint32. Pure: caller stores the new state. */
export function nextRandomState(state: number): number {
  return (state + 0x6d2b79f5) >>> 0;
}

/** Convert a generator state into a float in [0, 1). */
export function randomFloatFromState(state: number): number {
  let t = state >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Mutable cursor over the deterministic stream.
 *
 * Usage inside the sim:
 *   const rng = new Rng(state.rng);
 *   const jitter = rng.range(-1, 1);
 *   state.rng = rng.state;   // always write the state back
 */
export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = nextRandomState(this.state);
    return randomFloatFromState(this.state);
  }

  /** Next float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with the given probability (0..1). */
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

/** Build a stable 32-bit seed from a string (e.g. a room code or Fantrax player id). */
export function seedFromString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
