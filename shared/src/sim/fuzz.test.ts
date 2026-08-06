/**
 * Fuzz and robustness.
 *
 * Ten thousand ticks of seeded nonsense per run, checking the three invariants
 * that make the difference between "the sim is playable" and "the sim is a bug
 * report": every number stays finite, every body stays on the sheet, and the
 * puck never parks somewhere nobody can reach it.
 *
 * Everything here is seeded and therefore reproducible — a fuzz test that finds
 * a different bug every night is not a test, it is a rumour.
 */

import { describe, expect, it } from 'vitest';

import { createMatch, isLive, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { aiInput } from './ai.js';
import { assignControl } from './control.js';
import { Rng } from '../rng.js';
import { signedDistanceToBoards } from '../rink.js';
import { GOALIE, MATCH, PUCK, SKATER, TICK_RATE } from '../tuning.js';
import { dequantizeAxis, emptyInput, quantizeAxis } from '../types.js';
import type { GameSimState, InputMap, SkaterSimState, TeamSide } from '../types.js';

const FUZZ_TICKS = 10_000;

/** 3 seconds. The puck sitting still for longer than this is a stalled game. */
const MAX_FROZEN_TICKS = 3 * TICK_RATE;

/**
 * The overhang a carried puck would have if nothing clamped it.
 *
 * A carrier pinned against the boards holds the puck at arm's length: the stick
 * point is `stickReach` from a center that can be as close as `radius` to the
 * wall, so the raw stick point puts the puck's far edge `stickReach - radius +
 * puckRadius` = 1.3 ft through the wall. `seatPuckOnStick` pulls it back on both
 * the tick the puck is collected and every tick it is carried, so this figure is
 * what the assertion below must stay far away from — a measured 1.2566 ft here
 * is exactly the regression it exists to catch.
 */
const UNCLAMPED_STICK_OVERHANG = SKATER.stickReach - SKATER.radius + PUCK.radius;

/** Float slack. Every confinement routine lands the body exactly on the boards. */
const EPSILON = 1e-9;

interface FuzzReport {
  seats: string;
  seed: number;
  model: string;
  nonFinite: string[];
  worstSkater: number;
  worstGoalie: number;
  worstLoosePuck: number;
  worstCarriedPuck: number;
  worstFrozenTicks: number;
  worstFrozenAt: string;
  maxPuckSpeed: number;
  /** Dead-puck whistles: the backstop firing, not the AI doing its job. */
  strandedWhistles: number;
  phasesSeen: string[];
}

/**
 * How the seats are driven.
 *
 * `noise` is zero-mean white noise on the stick, which is what this file fuzzed
 * for its first two rounds — and it is blind to a whole class of failure, because
 * it never sustains a direction for more than a few ticks. `held` is one fixed
 * stick angle per seat for the entire run, which is both what a player leaning on
 * a control stick produces and what Phase 3 replays out of
 * `NETWORK.inputRedundancy` when a client stalls. It found a loose puck
 * motionless at one spot for 9,217 consecutive ticks.
 */
type InputModel =
  | { kind: 'noise' }
  | { kind: 'held'; angles: number[]; turbo: boolean };

function modelLabel(model: InputModel): string {
  if (model.kind === 'noise') return 'noise';
  const degrees = model.angles.map((a) => Math.round((a * 180) / Math.PI)).join('/');
  return `held ${degrees}${model.turbo ? ' +turbo' : ''}`;
}

/** Every numeric leaf in the state, with a path, so a failure names the field. */
function numericLeaves(value: unknown, path: string, out: Array<[string, number]>): void {
  if (typeof value === 'number') {
    out.push([path, value]);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => numericLeaves(entry, `${path}[${index}]`, out));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    numericLeaves(entry, `${path}.${key}`, out);
  }
}

function nonFiniteFields(state: GameSimState): string[] {
  const leaves: Array<[string, number]> = [];
  numericLeaves(state, 'state', leaves);
  return leaves.filter(([, value]) => !Number.isFinite(value)).map(([path]) => path);
}

/**
 * The fields that can actually go non-finite, checked on every single tick.
 *
 * The full reflective walk is far too expensive to run 10,000 times per fuzz
 * run, but it is the only thing that would catch a *new* field going bad, so it
 * runs on a sampling cadence as well. Between the two, nothing gets a free pass.
 */
function nonFiniteHotFields(state: GameSimState): string[] {
  const bad: string[] = [];
  const check = (label: string, value: number): void => {
    if (!Number.isFinite(value)) bad.push(label);
  };
  check('puck.x', state.puck.x);
  check('puck.y', state.puck.y);
  check('puck.vx', state.puck.vx);
  check('puck.vy', state.puck.vy);
  check('clock', state.clock);
  check('rng', state.rng);
  for (const skater of state.skaters) {
    check(`${skater.id}.x`, skater.x);
    check(`${skater.id}.y`, skater.y);
    check(`${skater.id}.vx`, skater.vx);
    check(`${skater.id}.vy`, skater.vy);
    check(`${skater.id}.facing`, skater.facing);
    check(`${skater.id}.turbo`, skater.turbo);
  }
  for (const goalie of state.goalies) {
    check(`${goalie.id}.x`, goalie.x);
    check(`${goalie.id}.y`, goalie.y);
    check(`${goalie.id}.vx`, goalie.vx);
    check(`${goalie.id}.vy`, goalie.vy);
    check(`${goalie.id}.facing`, goalie.facing);
  }
  return bad;
}

function fuzz(
  seed: number,
  seatSides: TeamSide[],
  model: InputModel = { kind: 'noise' },
  ticks = FUZZ_TICKS,
): FuzzReport {
  const config = makeTestMatchConfig({ seed, periodSeconds: 60 });
  const state = createMatch(config);
  seatSides.forEach((side, index) => {
    state.seats.push({ id: `seat-${index}`, side, nickname: `seat-${index}`, connected: true });
  });

  // A second generator, entirely outside the sim's own stream, so the fuzzed
  // inputs cannot be correlated with the rng the sim is drawing from.
  const rng = new Rng((seed ^ 0x1234) >>> 0);

  const report: FuzzReport = {
    seats: seatSides.join('+') || 'none',
    seed,
    model: modelLabel(model),
    nonFinite: [],
    worstSkater: -Infinity,
    worstGoalie: -Infinity,
    worstLoosePuck: -Infinity,
    worstCarriedPuck: -Infinity,
    worstFrozenTicks: 0,
    worstFrozenAt: '',
    maxPuckSpeed: 0,
    strandedWhistles: 0,
    phasesSeen: [],
  };
  const phases = new Set<string>();

  let frozenRun = 0;
  let previousX = NaN;
  let previousY = NaN;

  for (let tick = 0; tick < ticks; tick++) {
    const inputs: InputMap = {};
    state.seats.forEach((seat, index) => {
      if (model.kind === 'held') {
        const angle = model.angles[index % model.angles.length];
        inputs[seat.id] = {
          tick: state.tick + 1,
          moveX: quantizeAxis(Math.cos(angle)),
          moveY: quantizeAxis(Math.sin(angle)),
          shoot: false,
          pass: false,
          turbo: model.turbo,
          switchPlayer: false,
        };
        return;
      }
      inputs[seat.id] = {
        tick: state.tick + 1,
        moveX: quantizeAxis(rng.range(-1, 1)),
        moveY: quantizeAxis(rng.range(-1, 1)),
        shoot: rng.chance(0.25),
        pass: rng.chance(0.2),
        turbo: rng.chance(0.3),
        switchPlayer: rng.chance(0.05),
      };
    });
    for (const event of stepMatch(state, inputs, config)) {
      // The dead-puck whistle carries no actor; a goalie's carries theirs.
      if (event.type === 'whistle' && event.actorId === undefined) report.strandedWhistles++;
    }
    phases.add(state.phase);

    if (report.nonFinite.length === 0) {
      report.nonFinite =
        tick % 25 === 0 || tick === ticks - 1 ? nonFiniteFields(state) : nonFiniteHotFields(state);
    }

    for (const skater of state.skaters) {
      const overlap = signedDistanceToBoards(skater.x, skater.y) + SKATER.radius;
      if (overlap > report.worstSkater) report.worstSkater = overlap;
    }
    for (const goalie of state.goalies) {
      const overlap = signedDistanceToBoards(goalie.x, goalie.y) + GOALIE.radius;
      if (overlap > report.worstGoalie) report.worstGoalie = overlap;
    }

    const puckOverlap = signedDistanceToBoards(state.puck.x, state.puck.y) + PUCK.radius;
    if (state.puck.carrierId === null) {
      if (puckOverlap > report.worstLoosePuck) report.worstLoosePuck = puckOverlap;
    } else if (puckOverlap > report.worstCarriedPuck) {
      report.worstCarriedPuck = puckOverlap;
    }

    const speed = Math.sqrt(state.puck.vx * state.puck.vx + state.puck.vy * state.puck.vy);
    if (speed > report.maxPuckSpeed) report.maxPuckSpeed = speed;

    // POSITION, not speed. A puck pinned against geometry keeps its velocity
    // while never actually moving — a speed check calls that healthy, which is
    // precisely how the puck-on-the-post bug survived as long as it did.
    if (isLive(state) && state.puck.carrierId === null) {
      if (state.puck.x === previousX && state.puck.y === previousY) {
        frozenRun++;
        if (frozenRun > report.worstFrozenTicks) {
          report.worstFrozenTicks = frozenRun;
          report.worstFrozenAt = `(${state.puck.x.toFixed(1)}, ${state.puck.y.toFixed(1)})`;
        }
      } else {
        frozenRun = 0;
      }
      previousX = state.puck.x;
      previousY = state.puck.y;
    } else {
      // Non-live phases park the puck on the dot on purpose; a faceoff hold is
      // not a stalled game.
      frozenRun = 0;
      previousX = NaN;
      previousY = NaN;
    }
  }

  report.phasesSeen = [...phases];
  return report;
}

/**
 * The seat layouts fuzzed.
 *
 * `home+away` — one human a side — is the MVP configuration and the most
 * adversarial one, because it is the only layout in which BOTH sides have a seat
 * and therefore the only one that exercises the AI's chaser election properly.
 * It is held to every assertion in here.
 */
const LAYOUTS: TeamSide[][] = [
  [],
  ['home'],
  ['home', 'home'],
  ['home', 'home', 'home'],
  ['home', 'away'],
];

const SEEDS = [7, 99];

describe('fuzz: 10,000 ticks of seeded pseudo-random input', () => {
  const reports = LAYOUTS.flatMap((layout) => SEEDS.map((seed) => fuzz(seed, layout)));

  it('runs every layout for the full 10,000 ticks', () => {
    expect(reports).toHaveLength(LAYOUTS.length * SEEDS.length);
    for (const report of reports) {
      // Every run must have got the match moving rather than sitting in warmup.
      expect(report.phasesSeen).toContain('play');
    }
  });

  it('produces no NaN or Infinity in any numeric field of the state', () => {
    for (const report of reports) {
      expect(report.nonFinite, `${report.seats} seed ${report.seed}`).toEqual([]);
    }
  });

  it('keeps every skater and goalie inside the boards', () => {
    for (const report of reports) {
      const label = `${report.seats} seed ${report.seed}`;
      // Both confinement routines resolve to exactly zero penetration, so the
      // only slack allowed here is floating point.
      expect(report.worstSkater, `skater ${label}`).toBeLessThanOrEqual(EPSILON);
      expect(report.worstGoalie, `goalie ${label}`).toBeLessThanOrEqual(EPSILON);
    }
  });

  it('keeps the puck inside the boards, carried as well as loose', () => {
    for (const report of reports) {
      const label = `${report.seats} seed ${report.seed}`;
      expect(report.worstLoosePuck, `loose puck ${label}`).toBeLessThanOrEqual(EPSILON);
      /*
       * The carried puck is held to the same zero-penetration standard as the
       * loose one. It used to be allowed the full 1.3 ft of stick overhang
       * because `resolvePickups` skipped the boards clamp, and a snapshot
       * broadcast on a collect tick therefore drew the puck through the wall —
       * measured 1.2566 ft outside at (81.93, 41.49). Both paths now go through
       * `seatPuckOnStick`; measured worst over these 100k ticks is exactly 0.
       */
      expect(report.worstCarriedPuck, `carried puck ${label}`).toBeLessThanOrEqual(EPSILON);
      expect(UNCLAMPED_STICK_OVERHANG).toBeGreaterThan(1);
    }
  });

  it('keeps the puck at an arcade speed, hard but not absurd', () => {
    const fastest = Math.max(...reports.map((report) => report.maxPuckSpeed));

    // clampSpeed runs after friction, so the stored velocity can never exceed
    // the configured cap even for a tick.
    for (const report of reports) {
      expect(report.maxPuckSpeed).toBeLessThanOrEqual(PUCK.maxSpeed + EPSILON);
    }

    /*
     * And an absolute bound that does not read the constant it is checking:
     * raising `PUCK.maxSpeed` would satisfy the loop above trivially. 4 ft/tick
     * is 240 ft/s, about 164 mph — comfortably past any real slapshot, so
     * anything beyond it is a physics bug rather than a tuning choice.
     *
     * The floor matters just as much: shots have to actually leave hard.
     * Measured fastest over these runs is 2.50 ft/tick = 150 ft/s (~102 mph),
     * and 2.99 ft/tick (~122 mph) in AI-vs-AI play, where an on-fire skater gets
     * to load one up.
     */
    expect(fastest).toBeLessThan(4);
    expect(fastest).toBeGreaterThan(1.5);
  });

  it('never leaves the loose puck frozen at one position for 3 seconds, in any seat layout', () => {
    /*
     * `home+away` used to be carved out of this assertion: with a seat on both
     * sides the loose puck was measured motionless at one spot for up to 1,175
     * consecutive ticks (19.6 s). The cause was structural, not physical —
     * `assignControl` hands each seat the skater nearest the puck and `aiInput`
     * elected its chaser by the same rule, so the elected chaser was always the
     * human's skater and both CPU teammates fell through to `postUpInput`. In
     * the MVP layout, one human a side, nobody on your team ever went and got
     * the puck for you. `electChaser` now picks from the skaters the AI actually
     * drives, so every layout is held to the invariant.
     *
     * Measured after the fix, across all ten runs: worst 16 ticks (0.27 s) and a
     * mean of 9.0, with `home+away` at 12 and 10 — an 11x margin on the worst
     * case against the 180-tick threshold.
     *
     * White noise on the stick is not the adversarial case, though: see the
     * held-stick suite below, which is.
     */
    for (const report of reports) {
      expect(
        report.worstFrozenTicks,
        `${report.seats} seed ${report.seed} at ${report.worstFrozenAt}`,
      ).toBeLessThan(MAX_FROZEN_TICKS);
    }

    /*
     * And a canary on the typical case rather than only the worst one. A single
     * long retrieval is legitimate hockey — an intermediate build put a dead puck
     * in the corner behind the home net with all three home skaters seated, and
     * the nearest AI was an away skater 39 ft away, which is 85 honest ticks of
     * skating. A systemic regression — pursuit hesitating, or one side not
     * chasing at all — lifts every run at once and shows up here long before
     * anything reaches the 180-tick threshold above.
     */
    const mean =
      reports.reduce((sum, report) => sum + report.worstFrozenTicks, 0) / reports.length;
    expect(mean).toBeLessThan(MAX_FROZEN_TICKS / 4);
  });

  it('sends a CPU teammate after a dead puck even when both sides are seated', () => {
    /*
     * The fuzz above is the invariant; this is the mechanism, isolated so a
     * failure names the cause rather than a coordinate. One idle seat per side,
     * a puck sitting dead in open ice, and nobody touching a button: the only
     * thing that can collect it is an AI teammate deciding to go.
     *
     * Before the chaser fix this ran the full 3,000 ticks (50 s) untouched.
     * Measured now: collected on tick 137, against 88 for a pure-AI match.
     */
    const config = makeTestMatchConfig({ seed: 4242, periodSeconds: 600 });
    const state = createMatch(config);
    for (const side of ['home', 'away'] as TeamSide[]) {
      state.seats.push({ id: `seat-${side}`, side, nickname: side, connected: true });
    }
    state.phase = 'play';
    state.phaseTimer = 0;
    state.clock = 600 * TICK_RATE;
    state.puck.carrierId = null;
    state.puck.x = 60;
    state.puck.y = 30;
    state.puck.vx = 0;
    state.puck.vy = 0;

    const startDistances = new Map<string, number>(
      state.skaters.map((skater) => [skater.id, Math.hypot(skater.x - 60, skater.y - 30)]),
    );

    // Every seat's input is present and completely idle, which is the case that
    // used to deadlock: a connected human who simply does not move.
    const idle: InputMap = {};
    for (const seat of state.seats) idle[seat.id] = emptyInput(0);

    let collectedOn = -1;
    for (let tick = 0; tick < 600 && collectedOn < 0; tick++) {
      for (const seat of state.seats) idle[seat.id] = emptyInput(state.tick + 1);
      stepMatch(state, idle, config);
      if (state.puck.carrierId !== null) collectedOn = tick + 1;
    }

    expect(collectedOn).toBeGreaterThan(0);
    expect(collectedOn).toBeLessThan(5 * TICK_RATE);
    // Somebody skated across the ice for it rather than happening to be standing
    // on it: every skater starts a faceoff formation away from (60, 30).
    const collector = state.skaters.find((skater) => skater.id === state.puck.carrierId);
    expect(collector).toBeDefined();
    expect(startDistances.get(collector?.id ?? '')).toBeGreaterThan(20);
  });

  it('elects its chaser from the skaters the AI actually drives', () => {
    /*
     * The mechanism behind the test above, isolated so a regression names the
     * cause. Home has a seat, and `assignControl` gives that seat the skater
     * nearest the puck — so "nearest to the puck" is precisely the rule the AI
     * must NOT use to pick its own chaser, or it elects a skater it does not
     * drive and every CPU teammate stands down.
     *
     * Both AI teammates are placed so that a chaser and a defender point in
     * clearly different directions: the puck is at centre ice and their own net
     * is 89 ft away in the other direction.
     */
    const config = makeTestMatchConfig({ seed: 0x1234abcd, periodSeconds: 600 });
    const state = createMatch(config);
    state.phase = 'play';
    state.phaseTimer = 0;
    state.clock = 600 * TICK_RATE;
    state.puck.carrierId = null;
    state.puck.x = 0;
    state.puck.y = 0;
    state.puck.vx = 0;
    state.puck.vy = 0;

    const home = state.skaters.filter((skater) => skater.side === 'home' && skater.onIce);
    expect(home).toHaveLength(3);
    home[0].x = 4;
    home[0].y = 0;
    home[1].x = 0;
    home[1].y = -20;
    home[2].x = 0;
    home[2].y = 26;
    for (const skater of home) {
      skater.vx = 0;
      skater.vy = 0;
      skater.stun = 0;
    }

    /** How squarely this skater's stick input points at the puck, in [-1, 1]. */
    const towardPuck = (skater: SkaterSimState): number => {
      const input = aiInput({ state, config, inputs: {}, rng: new Rng(state.rng), events: [] }, skater);
      const mx = dequantizeAxis(input.moveX);
      const my = dequantizeAxis(input.moveY);
      const drive = Math.hypot(mx, my) || 1;
      const gap = Math.hypot(state.puck.x - skater.x, state.puck.y - skater.y) || 1;
      return ((mx / drive) * (state.puck.x - skater.x) + (my / drive) * (state.puck.y - skater.y)) / gap;
    };

    // With nobody seated the nearest skater goes, and the other two do not.
    assignControl({ state, config, inputs: {}, rng: new Rng(state.rng), events: [] });
    expect(towardPuck(home[0])).toBeGreaterThan(0.99);
    expect(towardPuck(home[1])).toBeLessThan(0.9);
    expect(towardPuck(home[2])).toBeLessThan(0.9);

    // Seat a human on home. It takes home[0] — the nearest — and the chase has to
    // pass to home[1], the nearest of the two the AI still drives.
    state.seats.push({ id: 'seat', side: 'home', nickname: 'seat', connected: true });
    assignControl({ state, config, inputs: {}, rng: new Rng(state.rng), events: [] });
    expect(home[0].controlledBy).toBe('seat');

    expect(towardPuck(home[1])).toBeGreaterThan(0.99);
    expect(towardPuck(home[2])).toBeLessThan(0.9);

    // And a chaser who is face down cannot chase: knock home[1] over and the job
    // passes to home[2] rather than sitting with a skater who is not going
    // anywhere for the next half second.
    home[1].stun = 30;
    expect(towardPuck(home[2])).toBeGreaterThan(0.99);
  });

  it('waves off a puck nobody can reach, rather than letting the period run out', () => {
    /*
     * The backstop, and the proof that the frozen-position invariant above is not
     * vacuous. Pin a puck in open ice with no velocity and every skater parked at
     * the far end, which is exactly what an unreachable puck looks like, and the
     * officials have to notice.
     *
     * The whistle carries no `actorId`, which is what tells it apart from a
     * goalie covering one up: this is the rule waving the puck dead, not a save.
     */
    const config = makeTestMatchConfig({ seed: 0x5eed1234, periodSeconds: 60 });
    const state = createMatch(config);
    state.phase = 'play';
    state.phaseTimer = 0;
    state.clock = 60 * TICK_RATE;

    let frozenRun = 0;
    let whistledOn = -1;
    let previousX = NaN;
    let previousY = NaN;

    for (let tick = 0; tick < MAX_FROZEN_TICKS && whistledOn < 0; tick++) {
      // Re-pin the puck every tick and park every skater on the far boards, the
      // way a genuinely unreachable puck would behave.
      state.puck.carrierId = null;
      state.puck.x = 12;
      state.puck.y = -8;
      state.puck.vx = 0;
      state.puck.vy = 0;
      for (const skater of state.skaters) {
        skater.x = skater.side === 'home' ? -80 : 80;
        skater.y = 0;
        skater.vx = 0;
        skater.vy = 0;
      }
      const events = stepMatch(state, {}, config);
      if (events.some((event) => event.type === 'whistle' && event.actorId === undefined)) {
        whistledOn = tick + 1;
      }

      if (isLive(state) && state.puck.carrierId === null) {
        if (state.puck.x === previousX && state.puck.y === previousY) frozenRun++;
        else frozenRun = 0;
        previousX = state.puck.x;
        previousY = state.puck.y;
      }
    }

    // It fired, on its own schedule, and strictly inside what the fuzz invariant
    // above calls a stalled game — otherwise that invariant would only ever be
    // held up by luck.
    expect(whistledOn).toBe(MATCH.deadPuckWhistleTicks);
    expect(whistledOn).toBeLessThan(MAX_FROZEN_TICKS);
    // The position-freeze detector saw the same thing the rule did.
    expect(frozenRun).toBeGreaterThanOrEqual(MATCH.deadPuckWhistleTicks - 2);
    // And play resumes from the centre dot rather than from wherever it died.
    expect(state.phase).toBe('faceoff');
    expect(state.puck).toMatchObject({ x: 0, y: 0, vx: 0, vy: 0, carrierId: null });
  });

  it('leaves a dead puck alone while somebody is on their way to it', () => {
    /*
     * The other half: a whistle that fires whenever the puck stops would make
     * every long retrieval a stoppage. A skater standing over a dead puck is not
     * a stranded puck, and `PUCK.pickupRadius` is the line because that is exactly
     * the distance inside which `resolvePickups` would already have handed it over.
     */
    const config = makeTestMatchConfig({ seed: 0x5eed1234, periodSeconds: 60 });
    const state = createMatch(config);
    state.phase = 'play';
    state.phaseTimer = 0;
    state.clock = 60 * TICK_RATE;

    for (let tick = 0; tick < MATCH.deadPuckWhistleTicks * 2; tick++) {
      state.puck.carrierId = null;
      state.puck.pickupCooldown = 10;
      state.puck.x = 12;
      state.puck.y = -8;
      state.puck.vx = 0;
      state.puck.vy = 0;
      for (const skater of state.skaters) {
        skater.x = skater.side === 'home' ? 12 : 80;
        skater.y = skater.side === 'home' ? -8 : 0;
        skater.vx = 0;
        skater.vy = 0;
        skater.stun = 0;
      }
      const events = stepMatch(state, {}, config);
      expect(events.some((event) => event.type === 'whistle')).toBe(false);
    }

    expect(state.phase).toBe('play');
    expect(state.puck.strandedTicks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The adversarial input model: a stick held one way
// ---------------------------------------------------------------------------

describe('fuzz: one stick direction, held', () => {
  /**
   * Eight compass points for one seat, and for two seats every combination of
   * the four cardinals with and without turbo — the shapes a player leaning on a
   * stick, or a stalled client's last packet replayed under
   * `NETWORK.inputRedundancy`, actually produce. 10,000 ticks each.
   *
   * Turbo is swept rather than alternated, and that is not padding: with the
   * chaser reservation removed, `home+away` at seed 7 holding 0/0 degrees
   * reproduces the stall with turbo OFF and not with it on. Alternating the flag
   * by index missed exactly that run, and the mutant lived.
   */
  const HELD_RUNS: Array<{ sides: TeamSide[]; angles: number[]; turbo: boolean }> = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    HELD_RUNS.push({ sides: ['home'], angles: [angle], turbo: i % 2 === 0 });
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const a = (i / 4) * Math.PI * 2;
      const b = (j / 4) * Math.PI * 2;
      for (const turbo of [true, false]) {
        HELD_RUNS.push({ sides: ['home', 'away'], angles: [a, b], turbo });
      }
      HELD_RUNS.push({ sides: ['home', 'home', 'home'], angles: [a, b, a], turbo: false });
    }
  }

  const reports = HELD_RUNS.map((run) =>
    fuzz(7, run.sides, { kind: 'held', angles: run.angles, turbo: run.turbo }),
  );

  it('keeps every body on the sheet and every number finite', () => {
    for (const report of reports) {
      const label = `${report.seats} ${report.model}`;
      expect(report.nonFinite, label).toEqual([]);
      expect(report.worstSkater, `skater ${label}`).toBeLessThanOrEqual(EPSILON);
      expect(report.worstGoalie, `goalie ${label}`).toBeLessThanOrEqual(EPSILON);
      expect(report.worstLoosePuck, `loose puck ${label}`).toBeLessThanOrEqual(EPSILON);
      expect(report.worstCarriedPuck, `carried puck ${label}`).toBeLessThanOrEqual(EPSILON);
      expect(report.maxPuckSpeed).toBeLessThanOrEqual(PUCK.maxSpeed + EPSILON);
    }
  });

  it('never leaves the loose puck frozen at one position for 3 seconds', () => {
    /*
     * The blocker. White-noise fuzzing missed this entirely because it never
     * sustains a direction: with one seat a side and both sticks held, the loose
     * puck was measured motionless at one spot for 9,217 consecutive ticks —
     * 153.6 s of a 180 s period — because `assignControl` handed each seat
     * whichever teammate had just got closest to the dead puck and the held stick
     * dragged them straight back off it, over and over, 46 binding flips per
     * 1,000 ticks.
     *
     * Two independent things hold the line now, which is deliberate: the chaser
     * reservation in `sim/control.ts` lets the AI finish the errand, and the
     * dead-puck whistle in `sim/rules.ts` is the backstop for the case where
     * there is no AI left to send.
     *
     * Measured with both in, over a 144-probe sweep of `home+away` (3 seeds x 8
     * angles x 3 pairings x turbo): worst frozen run 0 ticks, and 0 dead-puck
     * whistles. Take the reservation out of that same sweep and it is worst 119
     * with 13 whistles — the backstop doing all the work.
     */
    for (const report of reports) {
      expect(
        report.worstFrozenTicks,
        `${report.seats} ${report.model} at ${report.worstFrozenAt}`,
      ).toBeLessThan(MAX_FROZEN_TICKS);
    }
  });

  it('does not need the whistle to do it, in the layout the MVP ships', () => {
    /*
     * The backstop must not be load-bearing. One human a side is the MVP
     * configuration, and in it the AI has to actually go and fetch the puck —
     * a match that only kept moving because the officials kept blowing it dead
     * would pass the assertion above while being unplayable.
     *
     * Measured over these 32 `home+away` runs: 0 dead-puck whistles. Over the
     * same runs with the reservation removed: 13. They otherwise appear only
     * with all three home skaters seated, where there is no AI on that side to
     * elect a chaser at all.
     */
    const mvp = reports.filter((report) => report.seats === 'home+away');
    expect(mvp.length).toBeGreaterThan(8);
    for (const report of mvp) {
      expect(report.strandedWhistles, `${report.seats} ${report.model}`).toBe(0);
    }
  });
});

describe('fuzz: a full match still reaches its end', () => {
  it('drives a pure-AI match to final through regulation, overtime, and the shootout', () => {
    for (const seed of [1, 2, 3, 7, 99]) {
      const config = makeTestMatchConfig({ seed, periodSeconds: 60 });
      const state = createMatch(config);
      let ticks = 0;
      // Generous: three 60 s periods plus a 120 s overtime plus a 12-round
      // shootout is well under 60k ticks even with every stoppage.
      while (state.phase !== 'final' && ticks < 120_000) {
        stepMatch(state, {}, config);
        ticks++;
      }
      expect(state.phase, `seed ${seed} stalled after ${ticks} ticks`).toBe('final');
      expect(nonFiniteFields(state)).toEqual([]);
    }
  });
});
