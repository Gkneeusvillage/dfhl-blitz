/**
 * Determinism, replay, and purity.
 *
 * These are the load-bearing tests of the whole project: the server and every
 * client run this same `stepMatch`, so a single divergent tick is a live desync.
 * Everything here therefore drives the sim only through its public entry point —
 * (state, inputs, config) in, mutated state out — and never reaches into a module.
 */

import { describe, expect, it } from 'vitest';

import { cloneState, createMatch, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { quantizeAxis } from '../types.js';
import type { GameSimState, InputMap, MatchConfig, TeamSide } from '../types.js';

const SEATS: ReadonlyArray<{ id: string; side: TeamSide }> = [
  { id: 'home-seat', side: 'home' },
  { id: 'away-seat', side: 'away' },
];

const REPLAY_TICKS = 3000;

function seatedMatch(seed: number): { config: MatchConfig; state: GameSimState } {
  const config = makeTestMatchConfig({ seed });
  const state = createMatch(config);
  for (const seat of SEATS) {
    state.seats.push({ id: seat.id, side: seat.side, nickname: seat.id, connected: true });
  }
  return { config, state };
}

/**
 * The scripted input log.
 *
 * Written as a pure function of the tick rather than drawn from an rng, so the
 * log is identical in every run without any generator state to keep in step —
 * and so a perturbation cannot accidentally shift the stream that produced it.
 * The stick sweeps a full circle every ~170 ticks and the three buttons run on
 * mutually coprime cadences, so the two seats never fall into lockstep.
 */
function scriptedFrame(tick: number): InputMap {
  const frame: InputMap = {};
  SEATS.forEach((seat, index) => {
    const angle = tick * 0.037 + index * 2.1;
    frame[seat.id] = {
      tick: tick + 1,
      moveX: quantizeAxis(Math.cos(angle)),
      moveY: quantizeAxis(Math.sin(angle)),
      shoot: (tick + index * 7) % 37 < 6,
      pass: (tick + index * 11) % 53 < 4,
      turbo: (tick + index * 5) % 23 < 9,
      switchPlayer: (tick + index * 13) % 211 < 2,
    };
  });
  return frame;
}

interface Perturbation {
  tick: number;
  apply: (frame: InputMap) => void;
}

function replay(seed: number, ticks: number, perturb?: Perturbation): GameSimState {
  const { config, state } = seatedMatch(seed);
  for (let tick = 0; tick < ticks; tick++) {
    const frame = scriptedFrame(tick);
    if (perturb !== undefined && perturb.tick === tick) perturb.apply(frame);
    stepMatch(state, frame, config);
  }
  return state;
}

/** Per-tick fingerprint of a run, so a divergence anywhere in the trajectory is visible. */
function replayTrace(seed: number, ticks: number, perturb?: Perturbation): string[] {
  const { config, state } = seatedMatch(seed);
  const trace: string[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const frame = scriptedFrame(tick);
    if (perturb !== undefined && perturb.tick === tick) perturb.apply(frame);
    stepMatch(state, frame, config);
    trace.push(JSON.stringify(state));
  }
  return trace;
}

/**
 * The first tick at which letting go of the shoot button would fire the home
 * seat's shot: it drives the carrier, the windup is loaded, and no release
 * cooldown is running.
 *
 * Located at runtime rather than hardcoded, because it is the one perturbation
 * guaranteed to consume an extra rng draw — see the teeth test for why that
 * matters.
 */
function findShotReleaseTick(seed: number, limit: number): number {
  const { config, state } = seatedMatch(seed);
  const homeSeat = SEATS[0].id;
  for (let tick = 0; tick < limit; tick++) {
    const frame = scriptedFrame(tick);
    const carrier = state.skaters.find((skater) => skater.id === state.puck.carrierId);
    if (
      state.phase === 'play' &&
      carrier !== undefined &&
      carrier.controlledBy === homeSeat &&
      carrier.windup > 0 &&
      carrier.actionCooldown === 0 &&
      frame[homeSeat].shoot
    ) {
      return tick;
    }
    stepMatch(state, frame, config);
  }
  return -1;
}

describe('replay determinism', () => {
  it('produces a bit-identical state from the same seed and input log', () => {
    const first = replay(0x5eed1234, REPLAY_TICKS);
    const second = replay(0x5eed1234, REPLAY_TICKS);

    expect(first.tick).toBe(REPLAY_TICKS);
    expect(second).toEqual(first);
    // toEqual walks structure; JSON pins the exact float bit patterns too, which is
    // the level a desync actually shows up at.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('is deterministic across several seeds and with no seats at all', () => {
    for (const seed of [1, 7, 99, 0xc0ffee]) {
      expect(JSON.stringify(replay(seed, 600))).toBe(JSON.stringify(replay(seed, 600)));
    }

    // Pure AI, no inputs at all — the configuration the server runs when a seat drops.
    const runAi = (): string => {
      const config = makeTestMatchConfig({ seed: 0x5eed1234 });
      const state = createMatch(config);
      for (let tick = 0; tick < 1200; tick++) stepMatch(state, {}, config);
      return JSON.stringify(state);
    };
    expect(runAi()).toBe(runAi());
  });

  it('resuming from a cloned state reproduces the run exactly', () => {
    // The client's reconciliation loop: snapshot, roll back, re-simulate. If a
    // clone were not a complete restore point, prediction would drift.
    const { config, state } = seatedMatch(0x5eed1234);
    for (let tick = 0; tick < 400; tick++) stepMatch(state, scriptedFrame(tick), config);

    const branch = cloneState(state);
    for (let tick = 400; tick < 900; tick++) stepMatch(state, scriptedFrame(tick), config);
    for (let tick = 400; tick < 900; tick++) stepMatch(branch, scriptedFrame(tick), config);

    expect(JSON.stringify(branch)).toBe(JSON.stringify(state));
  });
});

describe('replay determinism — the assertion has teeth', () => {
  /**
   * Everything below perturbs exactly one tick of one seat's input and shows the
   * comparison notices. It is the only thing standing between "the replay test
   * passes" and "the replay test is vacuous".
   *
   * The perturbation is "let go of the shoot button one tick early", chosen
   * because it forces `releaseShot`, which draws from the rng. That matters: a
   * faceoff resets every skater's position, velocity, facing and timers along
   * with the puck, so a divergence that has only moved bodies around is *erased*
   * at the next whistle and the two runs re-converge. Only a difference that has
   * reached the rng cursor, the score, or the stat sheet survives a stoppage.
   * (Measured: an arbitrary stick flip on a live tick still differed 3000 ticks
   * later in 12 of 41 sampled ticks; forcing the shot, in 15 of 16 seeds.)
   */
  const seed = 0x5eed1234;
  const releaseTick = findShotReleaseTick(seed, REPLAY_TICKS);
  const dropShoot: Perturbation = {
    tick: releaseTick,
    apply: (frame) => {
      frame[SEATS[0].id].shoot = false;
    },
  };

  it('finds a tick at which the scripted log has a shot loaded', () => {
    expect(releaseTick).toBeGreaterThanOrEqual(0);
    expect(releaseTick).toBeLessThan(REPLAY_TICKS);
  });

  it('diverges on the very next tick when one input tick changes', () => {
    const clean = replay(seed, releaseTick + 1);
    const perturbed = replay(seed, releaseTick + 1, dropShoot);
    expect(JSON.stringify(perturbed)).not.toBe(JSON.stringify(clean));
  });

  it('shows the divergence somewhere in the trajectory', () => {
    const clean = replayTrace(seed, releaseTick + 200);
    const perturbed = replayTrace(seed, releaseTick + 200, dropShoot);
    const firstDifference = clean.findIndex((frame, index) => frame !== perturbed[index]);
    expect(firstDifference).toBe(releaseTick);
  });

  it('still differs in the final state after the full 3000 ticks', () => {
    const clean = replay(seed, REPLAY_TICKS);
    const perturbed = replay(seed, REPLAY_TICKS, dropShoot);
    expect(JSON.stringify(perturbed)).not.toBe(JSON.stringify(clean));
    expect(perturbed).not.toEqual(clean);
  });

  it('notices a state that differs only in the rng cursor', () => {
    // The subtlest desync there is: identical bodies, one extra draw taken.
    const clean = replay(seed, 600);
    const tweaked = cloneState(clean);
    tweaked.rng = (tweaked.rng + 1) >>> 0;
    expect(tweaked).not.toEqual(clean);
  });
});

/**
 * `shared` compiles with `types: []` and no DOM lib, so `console` and
 * `performance` are not in the type environment at all. That is exactly the
 * property the sim relies on, but the purity test still has to reach them to
 * prove they go untouched — hence one narrow, local view of the global object.
 */
type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';
interface TestGlobals {
  console: Record<ConsoleMethod, (...args: unknown[]) => void>;
  performance?: { now: () => number };
}
const globals = globalThis as unknown as TestGlobals;

describe('stepMatch purity', () => {
  it('never reads Math.random, Date.now, performance.now, or console', () => {
    const forbidden: string[] = [];
    const realRandom = Math.random;
    const realNow = Date.now;
    const realPerformanceNow = globals.performance?.now;

    const consoleKeys: ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug'];
    const realConsole = consoleKeys.map((key) => [key, globals.console[key]] as const);
    const consoleCalls: string[] = [];

    const { config, state } = seatedMatch(0x5eed1234);
    let thrown: unknown = null;

    try {
      globalThis.Math.random = (): number => {
        forbidden.push('Math.random');
        throw new Error('stepMatch called Math.random');
      };
      globalThis.Date.now = (): number => {
        forbidden.push('Date.now');
        throw new Error('stepMatch called Date.now');
      };
      if (realPerformanceNow !== undefined && globals.performance !== undefined) {
        globals.performance.now = (): number => {
          forbidden.push('performance.now');
          throw new Error('stepMatch called performance.now');
        };
      }
      for (const key of consoleKeys) {
        globals.console[key] = (...args: unknown[]): void => {
          consoleCalls.push(`${key}: ${String(args[0])}`);
        };
      }

      // Long enough to cross a faceoff, live play, a goal celebration and a
      // stoppage — every branch that might reasonably reach for a clock.
      for (let tick = 0; tick < 900; tick++) {
        stepMatch(state, scriptedFrame(tick), config);
      }
    } catch (error) {
      thrown = error;
    } finally {
      globalThis.Math.random = realRandom;
      globalThis.Date.now = realNow;
      if (realPerformanceNow !== undefined && globals.performance !== undefined) {
        globals.performance.now = realPerformanceNow;
      }
      for (const [key, original] of realConsole) globals.console[key] = original;
    }

    expect(forbidden).toEqual([]);
    expect(consoleCalls).toEqual([]);
    expect(thrown).toBeNull();
    expect(state.tick).toBe(900);
  });

  it('leaves the config and the input map untouched', () => {
    // The server hands the same MatchConfig to every tick of the match and the
    // same input objects to prediction and to authority. Mutating either would
    // desync the two the moment one side re-simulated.
    const { config, state } = seatedMatch(0x5eed1234);
    const configBefore = JSON.stringify(config);
    const frames: InputMap[] = [];

    for (let tick = 0; tick < 400; tick++) {
      const frame = scriptedFrame(tick);
      frames.push(frame);
      const frameBefore = JSON.stringify(frame);
      stepMatch(state, frame, config);
      expect(JSON.stringify(frame)).toBe(frameBefore);
    }

    expect(JSON.stringify(config)).toBe(configBefore);
    expect(frames).toHaveLength(400);
  });

  it('depends on nothing but its three arguments', () => {
    // Two matches interleaved tick-for-tick in the same process. If any module
    // held state between calls, the interleaved run would drift from the solo one.
    const solo = replay(0x5eed1234, 500);

    const a = seatedMatch(0x5eed1234);
    const b = seatedMatch(0xc0ffee);
    for (let tick = 0; tick < 500; tick++) {
      stepMatch(a.state, scriptedFrame(tick), a.config);
      stepMatch(b.state, scriptedFrame(tick), b.config);
    }

    expect(JSON.stringify(a.state)).toBe(JSON.stringify(solo));
  });
});
