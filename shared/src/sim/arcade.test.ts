/**
 * The arcade features, each measured by what it does rather than by the constant
 * it is spelled with.
 *
 * Turbo, body checks and the on-fire streak are named spec items, and until this
 * file existed every one of them could be deleted without turning the suite red:
 * a mirrored repo stayed 57/57 green with `ON_FIRE.goalsRequired` at 99, all
 * three on-fire multipliers at 1, both turbo multipliers at 1, `stunTicks` at
 * 0/0, and the skating and shooting attributes stripped out of top speed and shot
 * speed. So every assertion here is behavioural — a distance covered, a speed
 * reached, a skater knocked over — and none of them reads back the multiplier it
 * is checking. The measured figures are recorded in the comments and the bounds
 * sit well inside them, so tuning stays free and deletion does not.
 */

import { describe, expect, it } from 'vitest';

import { createMatch, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { attemptDefensiveAction, releaseShot } from './actions.js';
import { assignControl } from './control.js';
import { resolveGoalieSave, tryCoverLoosePuck, updateGoalie } from './goalie.js';
import { driveSkater, moveSkater } from './skater.js';
import { speedOf } from './physics.js';
import { Rng } from '../rng.js';
import { GOALIE, PUCK, RINK, SKATER, TICK_RATE } from '../tuning.js';
import { quantizeAxis } from '../types.js';
import type {
  GameSimState,
  MatchConfig,
  PlayerInput,
  SimEvent,
  SkaterSimState,
} from '../types.js';
import type { SimContext } from './context.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function makeCtx(state: GameSimState, config: MatchConfig): SimContext {
  return { state, config, inputs: {}, rng: new Rng(state.rng), events: [] };
}

function liveState(spec: Parameters<typeof makeTestMatchConfig>[0] = {}): {
  config: MatchConfig;
  state: GameSimState;
  ctx: SimContext;
} {
  const config = makeTestMatchConfig({ seed: 0x1234abcd, periodSeconds: 600, ...spec });
  const state = createMatch(config);
  state.phase = 'play';
  state.phaseTimer = 0;
  state.clock = 600 * TICK_RATE;
  return { config, state, ctx: makeCtx(state, config) };
}

function stick(x: number, y: number, extra: Partial<PlayerInput> = {}): PlayerInput {
  return {
    tick: 0,
    moveX: quantizeAxis(x),
    moveY: quantizeAxis(y),
    shoot: false,
    pass: false,
    turbo: false,
    switchPlayer: false,
    ...extra,
  };
}

/**
 * Drive one skater in open ice for a number of ticks.
 *
 * Deliberately below `stepMatch`: nobody bumps into anybody, nothing collides
 * with the boards, and the puck is nowhere near — so the distance covered is a
 * measurement of the skating model and of nothing else.
 */
function skateOpenIce(
  ctx: SimContext,
  skater: SkaterSimState,
  input: PlayerInput,
  ticks: number,
): number {
  const fromX = skater.x;
  const fromY = skater.y;
  for (let tick = 0; tick < ticks; tick++) {
    driveSkater(ctx, skater, input);
    moveSkater(skater);
  }
  return Math.hypot(skater.x - fromX, skater.y - fromY);
}

function placeInOpenIce(skater: SkaterSimState, x: number, y: number): void {
  skater.x = x;
  skater.y = y;
  skater.vx = 0;
  skater.vy = 0;
  skater.facing = 0;
  skater.stun = 0;
  skater.turbo = 1;
}

/** Puck a foot short of the line `scoringSide` attacks, with the goalie walked off. */
function setUpTapIn(state: GameSimState, shooter: SkaterSimState): void {
  const direction = shooter.side === 'home' ? 1 : -1;
  const goalX = direction * RINK.goalLineX;

  state.puck.carrierId = null;
  state.puck.lastTouchedBy = shooter.id;
  state.puck.lastTouchSide = shooter.side;
  state.puck.x = goalX - direction * 1;
  state.puck.y = 0;
  state.puck.vx = direction * 2.5;
  state.puck.vy = 0;
  state.puck.pickupCooldown = 30;

  const goalie = state.goalies.find((entry) => entry.side !== shooter.side);
  if (goalie === undefined) throw new Error('no defending goalie');
  goalie.x = goalX - direction * 30;
  goalie.y = 20;
}

/** Tap one in for `shooter` through a real tick, and hand back what it emitted. */
function scoreOne(state: GameSimState, config: MatchConfig, shooter: SkaterSimState): SimEvent[] {
  state.phase = 'play';
  state.phaseTimer = 0;
  state.clock = 600 * TICK_RATE;
  shooter.onIce = true;
  setUpTapIn(state, shooter);
  const events = stepMatch(state, {}, config);
  if (!events.some((event) => event.type === 'goal')) {
    throw new Error(`the scripted tap-in for ${shooter.id} did not go in`);
  }
  return events;
}

function skaterOf(state: GameSimState, id: string): SkaterSimState {
  const found = state.skaters.find((skater) => skater.id === id);
  if (found === undefined) throw new Error(`no skater ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// On fire
// ---------------------------------------------------------------------------

describe('the on-fire streak', () => {
  it('takes two goals from the same skater, and one is not enough', () => {
    const { config, state } = liveState();
    const scorer = skaterOf(state, 'home-0');

    const first = scoreOne(state, config, scorer);
    expect(scorer.streakGoals).toBe(1);
    expect(scorer.onFire).toBe(false);
    expect(first.some((event) => event.type === 'onFire')).toBe(false);

    const second = scoreOne(state, config, scorer);
    expect(scorer.onFire).toBe(true);
    expect(scorer.onFireTicks).toBeGreaterThan(0);
    const lit = second.find((event) => event.type === 'onFire');
    expect(lit?.actorId).toBe(scorer.id);

    // Nobody else caught anything: at most one skater a side is ever lit.
    for (const other of state.skaters) {
      if (other !== scorer) expect(other.onFire, other.id).toBe(false);
    }
  });

  it('is put out when the other team scores', () => {
    const { config, state } = liveState();
    const scorer = skaterOf(state, 'home-0');
    scoreOne(state, config, scorer);
    scoreOne(state, config, scorer);
    expect(scorer.onFire).toBe(true);

    scoreOne(state, config, skaterOf(state, 'away-0'));

    expect(scorer.onFire).toBe(false);
    expect(scorer.streakGoals).toBe(0);
  });

  it('makes the lit skater faster than an identical teammate', () => {
    /*
     * Same team, same attributes, same stick, same number of ticks — the only
     * difference between the two is the fire. Measured over 150 ticks:
     * 77.22 ft lit against 65.44 ft cold, a ratio of 1.180. Asserted at 1.08 so
     * the multiplier stays a tuning knob, but 1.0 (the feature deleted) fails.
     */
    const { config, state, ctx } = liveState();
    const scorer = skaterOf(state, 'home-0');
    scoreOne(state, config, scorer);
    scoreOne(state, config, scorer);
    expect(scorer.onFire).toBe(true);

    const cold = skaterOf(state, 'home-1');
    expect(cold.onFire).toBe(false);

    placeInOpenIce(scorer, -40, -10);
    placeInOpenIce(cold, -40, 10);
    const hotDistance = skateOpenIce(ctx, scorer, stick(1, 0), 150);
    const coldDistance = skateOpenIce(ctx, cold, stick(1, 0), 150);

    expect(hotDistance).toBeGreaterThan(coldDistance * 1.08);
  });

  it('makes the lit skater shoot harder', () => {
    // Measured: 2.430 ft/tick lit against 2.025 cold, a ratio of 1.200.
    const { config, state, ctx } = liveState();
    const scorer = skaterOf(state, 'home-0');
    scoreOne(state, config, scorer);
    scoreOne(state, config, scorer);

    const hot = fireFrom(ctx, scorer, 40, 0);
    const coldShot = fireFrom(ctx, skaterOf(state, 'home-1'), 40, 0);

    expect(hot.speed).toBeGreaterThan(coldShot.speed * 1.08);
  });

  it('makes the lit skater more accurate', () => {
    /*
     * Aim error is a draw from the rng, so this is measured as the spread of the
     * release angle over 24 differently seeded shots from one spot rather than
     * from any single shot. Measured standard deviation: 0.0161 rad lit against
     * 0.0294 cold — a variance ratio of 0.303, which is `accuracyMultiplier`
     * squared. Asserted at 0.6, so deleting the bonus (ratio 1.0) fails while
     * retuning it does not.
     */
    const { config, state } = liveState();
    const scorer = skaterOf(state, 'home-0');
    scoreOne(state, config, scorer);
    scoreOne(state, config, scorer);

    const hot = angleSpread(state, config, scorer, 24);
    const coldSpread = angleSpread(state, config, skaterOf(state, 'home-1'), 24);

    expect(hot).toBeGreaterThan(0);
    expect(hot).toBeLessThan(coldSpread * 0.6);
  });
});

/** Fire one wrist shot from a given spot and report the puck it produced. */
function fireFrom(
  ctx: SimContext,
  shooter: SkaterSimState,
  x: number,
  y: number,
): { speed: number; angle: number } {
  const puck = ctx.state.puck;
  shooter.x = x;
  shooter.y = y;
  shooter.windup = 0;
  shooter.actionCooldown = 0;
  puck.carrierId = shooter.id;
  puck.oneTimerTicks = 0;
  puck.x = x;
  puck.y = y;
  releaseShot(ctx, shooter);
  return { speed: speedOf(puck), angle: Math.atan2(puck.vy, puck.vx) };
}

/** Standard deviation of the release angle over `count` independently seeded shots. */
function angleSpread(
  state: GameSimState,
  config: MatchConfig,
  shooter: SkaterSimState,
  count: number,
): number {
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    const ctx: SimContext = {
      state,
      config,
      inputs: {},
      rng: new Rng((0xc0ffee + i * 0x9e3779b9) >>> 0),
      events: [],
    };
    angles.push(fireFrom(ctx, shooter, 40, 0).angle);
  }
  const mean = angles.reduce((sum, a) => sum + a, 0) / angles.length;
  const variance = angles.reduce((sum, a) => sum + (a - mean) ** 2, 0) / angles.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Turbo
// ---------------------------------------------------------------------------

describe('turbo', () => {
  it('carries a skater past the speed they can reach without it', () => {
    /*
     * Two identical skaters held flat out for 100 ticks, one on the boost.
     * Measured terminal speed 0.6644 ft/tick against 0.4582, a ratio of 1.450,
     * and 62.15 ft covered against 42.53, a ratio of 1.461. Asserted at 1.2:
     * deleting the boost (ratio 1.0) fails, retuning it does not.
     *
     * 100 ticks is inside the meter — it finishes on 0.333 — so this is a clean
     * reading of the boost rather than of the boost plus the drain.
     */
    const { state, ctx } = liveState();
    const boosted = skaterOf(state, 'home-0');
    const plain = skaterOf(state, 'home-1');
    placeInOpenIce(boosted, -60, -10);
    placeInOpenIce(plain, -60, 10);

    const boostedDistance = skateOpenIce(ctx, boosted, stick(1, 0, { turbo: true }), 100);
    const plainDistance = skateOpenIce(ctx, plain, stick(1, 0), 100);

    expect(speedOf(boosted)).toBeGreaterThan(speedOf(plain) * 1.2);
    expect(boostedDistance).toBeGreaterThan(plainDistance * 1.2);
  });

  it('gets a skater up to speed quicker, not just to a higher speed', () => {
    // The acceleration multiplier is a separate knob and needs its own reading:
    // eight ticks in, both skaters are still well below either cap. Measured
    // 0.3824 ft/tick against 0.2390, a ratio of 1.600.
    const { state, ctx } = liveState();
    const boosted = skaterOf(state, 'home-0');
    const plain = skaterOf(state, 'home-1');
    placeInOpenIce(boosted, -60, -10);
    placeInOpenIce(plain, -60, 10);

    skateOpenIce(ctx, boosted, stick(1, 0, { turbo: true }), 8);
    skateOpenIce(ctx, plain, stick(1, 0), 8);

    expect(speedOf(boosted)).toBeLessThan(SKATER.maxSpeedHigh);
    expect(speedOf(boosted)).toBeGreaterThan(speedOf(plain) * 1.25);
  });

  it('runs the meter down in about two and a half seconds and back up in about five', () => {
    /*
     * The documented feel, measured rather than restated: the meter empties in
     * 132 ticks (2.20 s — it stops draining at `turboMinEngage` rather than at
     * zero) and refills from there in 265 ticks (4.42 s), during which the
     * boosted speed drops from 0.6644 back to 0.4582. The bands below are
     * "roughly 2.5 s" and "roughly 5 s", and the last assertion is the part a
     * player actually feels: recharging costs more than burning.
     */
    const { state, ctx } = liveState();
    const skater = skaterOf(state, 'home-0');
    placeInOpenIce(skater, -60, 0);
    expect(skater.turbo).toBe(1);

    let drainTicks = 0;
    const held = stick(1, 0, { turbo: true });
    while (skater.turbo > SKATER.turboMinEngage && drainTicks < 10 * TICK_RATE) {
      driveSkater(ctx, skater, held);
      moveSkater(skater);
      drainTicks++;
    }
    expect(drainTicks).toBeGreaterThan(1.5 * TICK_RATE);
    expect(drainTicks).toBeLessThan(3.5 * TICK_RATE);

    // Held down with an empty meter, the skater is simply not boosting any more.
    const drainedSpeed = speedOf(skater);
    skateOpenIce(ctx, skater, held, 60);
    expect(speedOf(skater)).toBeLessThan(drainedSpeed);

    let refillTicks = 0;
    const released = stick(1, 0);
    while (skater.turbo < 1 && refillTicks < 20 * TICK_RATE) {
      driveSkater(ctx, skater, released);
      moveSkater(skater);
      refillTicks++;
    }
    expect(skater.turbo).toBe(1);
    expect(refillTicks).toBeGreaterThan(3 * TICK_RATE);
    expect(refillTicks).toBeLessThan(7 * TICK_RATE);
    expect(refillTicks).toBeGreaterThan(drainTicks);
  });
});

// ---------------------------------------------------------------------------
// Body checks
// ---------------------------------------------------------------------------

describe('a body check', () => {
  /** Defender closing on a carrier, close enough and fast enough to land one. */
  function collision(): {
    ctx: SimContext;
    state: GameSimState;
    defender: SkaterSimState;
    victim: SkaterSimState;
  } {
    const { state, ctx } = liveState();
    const defender = skaterOf(state, 'away-0');
    const victim = skaterOf(state, 'home-0');
    for (const skater of state.skaters) {
      if (skater === defender || skater === victim) continue;
      skater.onIce = false;
    }
    placeInOpenIce(defender, 0, 0);
    placeInOpenIce(victim, 3, 0);
    defender.vx = 0.4;
    victim.vx = 0;

    state.puck.carrierId = victim.id;
    state.puck.lastTouchedBy = victim.id;
    state.puck.lastTouchSide = victim.side;
    state.puck.x = victim.x;
    state.puck.y = victim.y;
    return { ctx, state, defender, victim };
  }

  it('knocks the victim down, drives him backwards, and jars the puck loose', () => {
    /*
     * Measured at checking 65: 30 ticks of stun (0.50 s) and 5.13 ft of slide
     * over the 20 ticks after contact, from the impulse alone. Asserted at a
     * quarter second and 2 ft — both far inside the measurement, and both zero
     * if `stunTicks` or `impulse` is flattened out.
     */
    const { ctx, state, defender, victim } = collision();

    attemptDefensiveAction(ctx, defender);

    expect(victim.stun).toBeGreaterThan(0.25 * TICK_RATE);
    expect(state.puck.carrierId).toBeNull();
    // The puck is jarred loose inside the check, so the turnover is emitted first.
    expect(ctx.events.map((event) => event.type)).toEqual(['turnover', 'hit']);
    const hit = ctx.events.find((event) => event.type === 'hit');
    expect(hit?.actorId).toBe(defender.id);
    expect(hit?.targetId).toBe(victim.id);

    // The impulse carries him: a stunned skater cannot steer, only slide.
    const fromX = victim.x;
    const idle = stick(0, 0);
    for (let tick = 0; tick < 20; tick++) {
      driveSkater(ctx, victim, idle);
      moveSkater(victim);
    }
    expect(victim.x - fromX).toBeGreaterThan(2);
    expect(victim.stun).toBeGreaterThan(0);
  });

  it('needs real closing speed — a gentle lean is a poke, not a hit', () => {
    // `minImpactSpeed` is what stops the check button being a permanent stun gun.
    const { ctx, state, defender, victim } = collision();
    defender.vx = 0;

    attemptDefensiveAction(ctx, defender);

    expect(victim.stun).toBe(0);
    expect(ctx.events.some((event) => event.type === 'hit')).toBe(false);
    // The puck may still be poked away, but the man is left standing.
    expect(state.puck.carrierId === null || state.puck.carrierId === victim.id).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attributes reach the ice
// ---------------------------------------------------------------------------

describe('attributes decide what a skater can do', () => {
  it('lets a 99-skating skater outrun a 0-skating one', () => {
    // Measured over 150 ticks: 74.28 ft against 48.54 ft, a ratio of 1.530.
    // Asserted at 1.2 — flattening `maxSpeed*`/`accel*` gives exactly 1.0.
    const { state, ctx } = liveState({ home: { skill: 99 }, away: { skill: 0 } });
    const quick = skaterOf(state, 'home-0');
    const slow = skaterOf(state, 'away-0');
    placeInOpenIce(quick, -40, -10);
    placeInOpenIce(slow, -40, 10);

    const quickDistance = skateOpenIce(ctx, quick, stick(1, 0), 150);
    const slowDistance = skateOpenIce(ctx, slow, stick(1, 0), 150);

    expect(quickDistance).toBeGreaterThan(slowDistance * 1.2);
  });

  it('lets a 99-shooting skater shoot harder than a 0-shooting one', () => {
    // Measured: 2.300 ft/tick against 1.500, a ratio of 1.533. Asserted at 1.2.
    const { state, ctx } = liveState({ home: { skill: 99 }, away: { skill: 0 } });
    const sniper = fireFrom(ctx, skaterOf(state, 'home-0'), 40, 0);
    const plugger = fireFrom(ctx, skaterOf(state, 'away-0'), -40, 0);

    expect(sniper.speed).toBeGreaterThan(plugger.speed * 1.2);
  });

  it('lets a goalie with rebound control kill the puck instead of feeding the slot', () => {
    /*
     * `reboundControl` is the attribute that decides whether a save ends the
     * chance or starts a better one, and nothing else in the suite reads it —
     * moving `reboundRetention` to 0.95/0.9 (no difference between a great goalie
     * and a terrible one) used to pass everything.
     *
     * Fired at just over `GOALIE.freezeMaxSpeed`, so the save cannot come back a
     * freeze and the measurement is the rebound every time — the freeze is a dice
     * roll and this test is not about it.
     *
     * Measured off a 2.7 ft/tick shot: a 0-rated goalie coughs it up at 1.485
     * ft/tick, a 99-rated one at 0.486. A ratio of 3.06; asserted at 1.5.
     */
    const rebound = (goalieSkill: number): number => {
      const { state, ctx } = liveState({ away: { goalieSkill } });
      const goalie = state.goalies[1];
      // Committed, so the save is the body rather than a flat-footed graze.
      goalie.lunge = 5;
      const puck = state.puck;
      puck.carrierId = null;
      puck.x = goalie.x - 3;
      puck.y = goalie.y;
      puck.vx = GOALIE.freezeMaxSpeed + 0.1;
      puck.vy = 0;
      const result = resolveGoalieSave(ctx, goalie, puck.x, puck.y, puck.x + puck.vx, puck.y);
      expect(result.stopped).toBe(true);
      expect(result.frozen).toBe(false);
      return speedOf(puck);
    };

    expect(rebound(0)).toBeGreaterThan(rebound(99) * 1.5);
  });

  it('reads the same shot differently from one match to the next', () => {
    /*
     * The goalie's misread is derived from the shot rather than from `state.rng`,
     * on purpose: a read re-rolled every tick averages out to a perfect read and
     * the goalie is never beaten. But the key used to be the flight angle and the
     * goalie id alone, and the ids are only ever 'home-g' and 'away-g' — so every
     * one of the 14 franchises shared one misread pattern and it was the same
     * pattern in every match ever played. An angle that beat a goalie once beat
     * them for the rest of the league's history.
     *
     * The match seed is in the key now. This fires the identical shot into eight
     * different matches and asks where the goalie ends up: measured, six distinct
     * landing spots spread over 3.4 ft. With the seed out of the key all eight
     * are the same number.
     */
    const settle = (seed: number): number => {
      const { state, ctx } = liveState({ seed });
      const goalie = state.goalies[1];
      const puck = state.puck;
      puck.carrierId = null;
      puck.x = 60;
      puck.y = 0;
      puck.vx = 1.6;
      puck.vy = 0.2;

      // Ten ticks of flight, which is long enough for the goalie to reach the
      // spot it committed to and stop there.
      for (let tick = 0; tick < 10; tick++) {
        updateGoalie(ctx, goalie);
        puck.x += puck.vx;
        puck.y += puck.vy;
      }
      expect(goalie.lunge).toBeGreaterThan(0);
      return goalie.y;
    };

    const landings = [1, 2, 3, 7, 99, 4242, 31337, 0x5eed1234].map(settle);
    expect(new Set(landings).size).toBeGreaterThan(3);
    expect(Math.max(...landings) - Math.min(...landings)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The goalie as a source of stoppages
// ---------------------------------------------------------------------------

describe('a goalie keeps the game running', () => {
  /** Park a loose puck at rest a given distance in front of the away goalie. */
  function deadPuckAt(gap: number): {
    state: GameSimState;
    ctx: SimContext;
    goalie: GameSimState['goalies'][number];
  } {
    const { state, ctx } = liveState();
    const goalie = state.goalies[1];
    for (const skater of state.skaters) placeInOpenIce(skater, skater.side === 'home' ? -60 : 60, 30);
    state.puck.carrierId = null;
    state.puck.x = goalie.x - gap;
    state.puck.y = goalie.y;
    state.puck.vx = 0;
    state.puck.vy = 0;
    return { state, ctx, goalie };
  }

  it('never leaves a rebound pinned on its own contact circle', () => {
    /*
     * `sweepPointCircle` reports t = 0 for a sweep that starts inside the circle,
     * so a puck already touching the goalie was placed back on its own position
     * every single tick — for as long as the goalie stood over it. Measured: a
     * loose puck motionless at (84.0, -1.5) for 119 consecutive ticks with the
     * goalie 1.9 ft away, and it is unreachable by anybody else, because a skater
     * is held `SKATER.radius + GOALIE.radius` off the goalie against a 2.2 ft
     * stick. The same shape of bug as the puck that used to park on a post.
     *
     * Starting the puck INSIDE the save radius is the case that used to pin: the
     * assertion is simply that it moves.
     */
    const { state, ctx, goalie } = deadPuckAt(GOALIE.radius);
    state.puck.vx = 0.4;

    const before = { x: state.puck.x, y: state.puck.y };
    const result = resolveGoalieSave(
      ctx,
      goalie,
      state.puck.x,
      state.puck.y,
      state.puck.x + state.puck.vx,
      state.puck.y,
    );

    expect(result.stopped).toBe(true);
    expect(Math.hypot(state.puck.x - before.x, state.puck.y - before.y)).toBeGreaterThan(0.1);
    // And it left going away from the goalie, not further into them.
    expect(Math.hypot(state.puck.x - goalie.x, state.puck.y - goalie.y)).toBeGreaterThan(
      Math.hypot(before.x - goalie.x, before.y - goalie.y),
    );
  });

  it('plays a dead puck at its feet instead of always blowing the whistle', () => {
    /*
     * A puck at rest against the pads has to be resolved by the goalie — nobody
     * else can physically get a stick on it. Covering it up every time was worth
     * 14.6 whistles a match on its own, so the goalie usually just clears it.
     * Over 200 seeded attempts: 165 clearances, 35 covers.
     */
    let cleared = 0;
    let covered = 0;
    for (let seed = 0; seed < 200; seed++) {
      const config = makeTestMatchConfig({ seed, periodSeconds: 600 });
      const state = createMatch(config);
      state.phase = 'play';
      state.phaseTimer = 0;
      state.clock = 600 * TICK_RATE;
      const ctx = makeCtx(state, config);
      const goalie = state.goalies[1];
      for (const skater of state.skaters) placeInOpenIce(skater, skater.side === 'home' ? -60 : 60, 30);
      state.puck.carrierId = null;
      state.puck.x = goalie.x - 1;
      state.puck.y = goalie.y;
      state.puck.vx = 0;
      state.puck.vy = 0;

      if (tryCoverLoosePuck(ctx, goalie)) covered++;
      else if (speedOf(state.puck) > 0) cleared++;
    }

    expect(cleared + covered).toBe(200);
    // Both outcomes are real, and clearing is the common one.
    expect(covered).toBeGreaterThan(0);
    expect(cleared).toBeGreaterThan(covered * 2);
  });

  it('sends its clearance up the ice, never back across its own goal mouth', () => {
    // A clearance that curls in front of the net is an own goal waiting to
    // happen. Checked from both ends, because "up the ice" has a sign in it.
    for (const side of [0, 1]) {
      const { state, ctx } = liveState({ home: { goalieSkill: 0 }, away: { goalieSkill: 0 } });
      const goalie = state.goalies[side];
      for (const skater of state.skaters) placeInOpenIce(skater, 0, 30);
      state.puck.carrierId = null;
      state.puck.x = goalie.x;
      state.puck.y = goalie.y + 1;
      state.puck.vx = 0;
      state.puck.vy = 0;

      tryCoverLoosePuck(ctx, goalie);
      const upIce = goalie.side === 'home' ? 1 : -1;
      expect(state.puck.vx * upIce, `${goalie.id}`).toBeGreaterThan(0);
    }
  });

  /**
   * Put one shot into a committed goalie's body and report what came back.
   * `aimY` decides whether it was going in: the goalie moves with it, so the
   * contact is identical either way and only `onTarget` differs.
   */
  function shotIntoGoalie(seed: number, aimY: number): { frozen: boolean; events: SimEvent[] } {
    const config = makeTestMatchConfig({ seed, periodSeconds: 600, away: { goalieSkill: 99 } });
    const state = createMatch(config);
    state.phase = 'play';
    state.phaseTimer = 0;
    const ctx = makeCtx(state, config);
    const goalie = state.goalies[1];
    goalie.y = aimY;
    // Committed, so the save is the whole body and the contact is certain.
    goalie.lunge = 8;
    state.puck.carrierId = null;
    state.puck.x = goalie.x - 2;
    state.puck.y = aimY;
    state.puck.vx = 1;
    state.puck.vy = 0;

    const result = resolveGoalieSave(ctx, goalie, state.puck.x, state.puck.y, state.puck.x + 1, aimY);
    expect(result.stopped).toBe(true);
    return { frozen: result.frozen, events: ctx.events };
  }

  it('emits a whistle when it freezes the puck, so the client has a cue', () => {
    /*
     * `SimEvent` is the only channel one-shot audio and VFX have. The freeze used
     * to return `{ frozen: true }` without pushing anything, so on the single most
     * frequent stoppage in the game the client cut from live hockey to a faceoff
     * with nothing to play a whistle over. Measured over these 60 seeds: 12
     * freezes, and a whistle event on every one of them.
     */
    let freezes = 0;
    for (let seed = 0; seed < 60; seed++) {
      const shot = shotIntoGoalie(seed, 0);
      if (!shot.frozen) continue;
      freezes++;
      expect(
        shot.events.some((event) => event.type === 'whistle'),
        `seed ${seed} froze the puck without a whistle`,
      ).toBe(true);
    }
    expect(freezes).toBeGreaterThan(3);
  });

  it('does not stop play for a puck that was missing the net anyway', () => {
    /*
     * The freeze used to roll on every contact under `freezeMaxSpeed`, wide shots
     * and dribblers included: 49 whistles a match against 12.9 goals, one every
     * 8.7 s of live play. Identical contact from 300 seeds, aimed at the net and
     * then aimed well outside the post: measured 63 freezes against 3.
     */
    let onNet = 0;
    let wide = 0;
    for (let seed = 0; seed < 300; seed++) {
      if (shotIntoGoalie(seed, 0).frozen) onNet++;
      if (shotIntoGoalie(seed, RINK.goalHalfWidth + GOALIE.radius + 4).frozen) wide++;
    }
    expect(onNet).toBeGreaterThan(20);
    expect(wide).toBeLessThan(onNet / 5);
  });

  it('spends a commitment the moment a skater takes possession', () => {
    /*
     * A goalie that reads a pass, commits to it, and is still committed when the
     * one-timer comes off the stick is a goalie the cross-crease play cannot beat.
     * The commitment is to ONE puck flight; possession ends the flight.
     */
    const { state, ctx } = liveState();
    const goalie = state.goalies[1];
    goalie.lunge = 9;
    goalie.lungeCooldown = 0;
    state.puck.carrierId = skaterOf(state, 'home-0').id;

    updateGoalie(ctx, goalie);

    expect(goalie.lunge).toBe(0);
    expect(goalie.lungeCooldown).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Seat assignment
// ---------------------------------------------------------------------------

describe('a seat drives the right skater', () => {
  interface Seated {
    state: GameSimState;
    config: MatchConfig;
    near: SkaterSimState;
    middle: SkaterSimState;
    far: SkaterSimState;
    /** Run one control pass with the switch button up or down. */
    step(switchPlayer: boolean): void;
  }

  function seated(): Seated {
    const { config, state } = liveState();
    state.seats.push({ id: 'seat', side: 'home', nickname: 'seat', connected: true });
    state.puck.carrierId = null;
    state.puck.x = 0;
    state.puck.y = 0;

    const near = skaterOf(state, 'home-1');
    const middle = skaterOf(state, 'home-2');
    const far = skaterOf(state, 'home-0');
    placeInOpenIce(near, 6, 0);
    placeInOpenIce(middle, 18, 0);
    placeInOpenIce(far, 40, 0);

    const step = (switchPlayer: boolean): void => {
      const inputs = { seat: stick(0, 0, { switchPlayer }) };
      assignControl({ state, config, inputs, rng: new Rng(state.rng), events: [] });
    };
    return { state, config, near, middle, far, step };
  }

  it('takes the skater nearest the puck when it has nobody', () => {
    const { near, middle, far, step } = seated();
    step(false);
    expect(near.controlledBy).toBe('seat');
    expect(middle.controlledBy).toBeNull();
    expect(far.controlledBy).toBeNull();
  });

  it('keeps its skater when a teammate gets nearer the puck', () => {
    // The auto-switch this replaced took the skater away the moment anyone else
    // was nearer. Control now moves only when the player asks for it.
    const { far, near, step } = seated();
    far.controlledBy = 'seat';
    step(false);
    expect(far.controlledBy).toBe('seat');
    expect(near.controlledBy).toBeNull();
  });

  it('moves to the nearest other teammate on a press of switch', () => {
    const { near, middle, far, step } = seated();
    step(false);
    expect(near.controlledBy).toBe('seat');

    step(true);
    expect(middle.controlledBy).toBe('seat');
    expect(near.controlledBy).toBeNull();
    expect(far.controlledBy).toBeNull();
  });

  it('switches once per press, however long the button is held', () => {
    // The server repeats a seat's last input when a packet is late, so a held
    // button arrives as many identical ticks. Only the first one is a press.
    const { near, middle, step } = seated();
    step(false);
    step(true);
    expect(middle.controlledBy).toBe('seat');
    for (let i = 0; i < 30; i++) step(true);
    expect(middle.controlledBy).toBe('seat');

    step(false);
    step(true);
    expect(near.controlledBy).toBe('seat');
  });

  it('takes the carrier over anyone standing closer to the puck', () => {
    // You always have the puck if your team has it, wherever the carrier is.
    const { config, state } = liveState();
    state.seats.push({ id: 'seat', side: 'home', nickname: 'seat', connected: true });

    const near = skaterOf(state, 'home-1');
    const carrier = skaterOf(state, 'home-0');
    placeInOpenIce(near, 6, 0);
    placeInOpenIce(carrier, 40, 0);
    near.controlledBy = 'seat';
    state.puck.carrierId = carrier.id;
    state.puck.x = 0;
    state.puck.y = 0;

    assignControl({ state, config, inputs: {}, rng: new Rng(state.rng), events: [] });

    expect(carrier.controlledBy).toBe('seat');
    expect(near.controlledBy).toBeNull();
  });

  it('keeps its skater when the other side has the puck', () => {
    const { config, state } = liveState();
    state.seats.push({ id: 'seat', side: 'home', nickname: 'seat', connected: true });

    const mine = skaterOf(state, 'home-0');
    const near = skaterOf(state, 'home-1');
    const opponent = skaterOf(state, 'away-0');
    placeInOpenIce(mine, 40, 0);
    placeInOpenIce(near, 4, 0);
    placeInOpenIce(opponent, 0, 0);
    mine.controlledBy = 'seat';
    state.puck.carrierId = opponent.id;
    state.puck.x = 0;
    state.puck.y = 0;

    assignControl({ state, config, inputs: {}, rng: new Rng(state.rng), events: [] });

    expect(mine.controlledBy).toBe('seat');
    expect(near.controlledBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

describe('the skater a person drives handles sharply', () => {
  /** Ticks for a skater at full speed along +x to be skating back along -x. */
  function ticksToReverse(driven: boolean): number {
    const { state, ctx } = liveState();
    const skater = skaterOf(state, 'home-0');
    placeInOpenIce(skater, 0, 0);
    skater.controlledBy = driven ? 'seat' : null;

    for (let i = 0; i < 120; i++) driveSkater(ctx, skater, stick(1, 0));
    expect(skater.vx).toBeGreaterThan(0.3);

    for (let tick = 1; tick <= 300; tick++) {
      driveSkater(ctx, skater, stick(-1, 0));
      moveSkater(skater);
      if (skater.vx < -0.15) return tick;
    }
    return Infinity;
  }

  it('turns round from full speed much sooner than the AI does', () => {
    // The v0.1 model, which the AI still uses: momentum never turns, so a
    // reversal is a long drift before the new acceleration wins.
    const ai = ticksToReverse(false);
    const driven = ticksToReverse(true);
    expect(driven).toBeLessThan(ai * 0.7);
    // Under half a second, at 60 ticks a second.
    expect(driven).toBeLessThan(TICK_RATE / 2);
  });

  it('carves a turn instead of sliding sideways', () => {
    const { state, ctx } = liveState();
    const skater = skaterOf(state, 'home-0');
    placeInOpenIce(skater, 0, 0);
    skater.controlledBy = 'seat';
    for (let i = 0; i < 120; i++) driveSkater(ctx, skater, stick(1, 0));
    for (let i = 0; i < 20; i++) driveSkater(ctx, skater, stick(0, 1));
    // Twenty ticks into a hard right turn, most of the speed goes the new way.
    expect(skater.vy).toBeGreaterThan(Math.abs(skater.vx));
    expect(speedOf(skater)).toBeGreaterThan(SKATER.maxSpeedLow * 0.6);
  });
});
