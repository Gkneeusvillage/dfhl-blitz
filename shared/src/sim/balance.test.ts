/**
 * Balance: the two numbers a player actually feels.
 *
 *  1. Does the goalie stop the right share of what reaches the net, and is the
 *     one-timer worth setting up?
 *  2. Do a team's attributes decide matches, independently of which end of the
 *     ice they start at?
 *
 * Both are measured, not asserted from theory, and every sample is seeded — so
 * these tests give the same answer on every machine on every run. The bands are
 * set with real margin around the measured values, recorded in the comments, so
 * ordinary tuning does not turn the suite red while a genuine regression does.
 */

import { describe, expect, it } from 'vitest';

import { createMatch, isLive, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { Rng } from '../rng.js';
import { RINK, SHOOTING, SKATER, TICK_RATE } from '../tuning.js';
import type { GameSimState, InputMap, PlayerInput, TeamSide } from '../types.js';

// ---------------------------------------------------------------------------
// A single shot, fired from a chosen spot, resolved to its outcome
// ---------------------------------------------------------------------------

type ShotOutcome = 'goal' | 'save' | 'post' | 'wide';

interface ShotSpec {
  seed: number;
  x: number;
  y: number;
  oneTimer: boolean;
  goalieSkill: number;
  shooterSkill: number;
}

const SEAT_ID = 'shooter-seat';

function shooterInput(state: GameSimState, shoot: boolean): InputMap {
  const input: PlayerInput = {
    tick: state.tick + 1,
    moveX: 0,
    moveY: 0,
    shoot,
    pass: false,
    turbo: false,
    switchPlayer: false,
  };
  return { [SEAT_ID]: input };
}

/**
 * One shot, in isolation.
 *
 * Every other skater is sent to the bench so the result is the shooter, the
 * puck and the goalie and nothing else — no defender blocking the lane, no
 * teammate collecting a rebound. That is the only way to measure a goalie
 * rather than the AI's positioning.
 */
function fireOneShot(spec: ShotSpec): ShotOutcome {
  const config = makeTestMatchConfig({
    seed: spec.seed,
    // On-fire multipliers would make the sample depend on match history.
    onFireEnabled: false,
    home: { skill: spec.shooterSkill, goalieSkill: spec.goalieSkill },
    away: { skill: spec.shooterSkill, goalieSkill: spec.goalieSkill },
  });
  const state = createMatch(config);
  state.phase = 'play';
  state.phaseTimer = 0;
  state.clock = 60 * TICK_RATE;
  state.seats.push({ id: SEAT_ID, side: 'home', nickname: 'shooter', connected: true });

  const shooter = state.skaters[0];
  for (const other of state.skaters) {
    if (other === shooter) continue;
    other.onIce = false;
    other.x = (other.slot - 2.5) * 9;
    other.y = other.side === 'home' ? 38 : -38;
    other.vx = 0;
    other.vy = 0;
  }

  shooter.onIce = true;
  shooter.x = spec.x;
  shooter.y = spec.y;
  shooter.vx = 0;
  shooter.vy = 0;
  shooter.facing = Math.atan2(-spec.y, RINK.goalLineX - spec.x);
  shooter.turbo = 1;

  state.puck.carrierId = shooter.id;
  state.puck.lastTouchedBy = shooter.id;
  state.puck.lastTouchSide = 'home';
  state.puck.x = shooter.x + Math.cos(shooter.facing) * SKATER.stickReach;
  state.puck.y = shooter.y + Math.sin(shooter.facing) * SKATER.stickReach;
  state.puck.vx = 0;
  state.puck.vy = 0;
  state.puck.pickupCooldown = 0;

  /*
   * Let the goalie square up to a shooter who is actually standing there before
   * anything is fired.
   *
   * Releasing on tick 0 measures a goalie one update out of its reset position
   * that has never tracked anybody — a stance the game will never actually have
   * to make a save from, and one that flatters whichever shot type happens to
   * suit an unset goalie. It matters more since the flat-footed lean landed:
   * an unsettled goalie has nothing to be leaning away from.
   */
  const SETTLE_TICKS = 45;
  for (let i = 0; i < SETTLE_TICKS; i++) {
    stepMatch(state, {}, config);
    // Pin the shooter and the puck: the only thing meant to move here is the goalie.
    shooter.x = spec.x;
    shooter.y = spec.y;
    shooter.vx = 0;
    shooter.vy = 0;
    shooter.facing = Math.atan2(-spec.y, RINK.goalLineX - spec.x);
    shooter.stun = 0;
    state.puck.carrierId = shooter.id;
    state.puck.x = shooter.x + Math.cos(shooter.facing) * SKATER.stickReach;
    state.puck.y = shooter.y + Math.sin(shooter.facing) * SKATER.stickReach;
    state.puck.vx = 0;
    state.puck.vy = 0;
  }
  // A held puck that never moves looks stranded, and the clock has been running.
  state.phase = 'play';
  state.phaseTimer = 0;
  state.puck.strandedTicks = 0;
  state.puck.pickupCooldown = 0;

  // A one-timer fires the instant the button goes down; an ordinary shot needs
  // the button released, so the script below covers both. Armed after settling,
  // because the window would otherwise expire while the goalie gets set.
  state.puck.oneTimerTicks = spec.oneTimer ? SHOOTING.oneTimerWindowTicks : 0;

  let released = false;
  let hitPost = false;

  for (let tick = 0; tick < 200; tick++) {
    const events = stepMatch(state, shooterInput(state, tick === 0), config);
    for (const event of events) {
      if (event.type === 'shot') released = true;
      if (event.type === 'goal') return 'goal';
      // `save` is only emitted when the puck was actually going in, which is
      // exactly the population a save percentage is supposed to be taken over.
      if (event.type === 'save') return 'save';
      if (event.type === 'post') hitPost = true;
    }
    // Once the puck is dead, collected, or the whistle has gone, the shot is over.
    if (released && (state.puck.carrierId !== null || !isLive(state))) break;
  }

  if (!released) throw new Error('the scripted shot never left the stick');
  return hitPost ? 'post' : 'wide';
}

interface ShotSample {
  goals: number;
  saves: number;
  posts: number;
  wide: number;
  onNet: number;
  savePercentage: number;
  conversion: number;
}

/**
 * Several hundred shots from seeded positions in the area the AI actually
 * shoots from: 12-45 ft out and inside 0.6 rad (34 degrees) of the net's centre
 * line, which sits inside `AI.shootRangeMin`/`shootRange`/`shootMaxAngle`.
 */
function sampleShots(options: {
  count: number;
  oneTimer: boolean;
  goalieSkill?: number;
  shooterSkill?: number;
  sampleSeed?: number;
}): ShotSample {
  const sampleSeed = options.sampleSeed ?? 0xabc123;
  const rng = new Rng(sampleSeed);
  const sample: ShotSample = {
    goals: 0,
    saves: 0,
    posts: 0,
    wide: 0,
    onNet: 0,
    savePercentage: 0,
    conversion: 0,
  };

  for (let i = 0; i < options.count; i++) {
    const range = rng.range(12, 45);
    const angle = rng.range(-0.6, 0.6);
    const outcome = fireOneShot({
      // A distinct match seed per shot, so the goalie's read noise and the
      // shooter's aim error are not the same draw 400 times running.
      seed: (sampleSeed ^ (i * 0x9e3779b9)) >>> 0,
      x: RINK.goalLineX - range * Math.cos(angle),
      y: range * Math.sin(angle),
      oneTimer: options.oneTimer,
      goalieSkill: options.goalieSkill ?? 65,
      shooterSkill: options.shooterSkill ?? 65,
    });
    if (outcome === 'goal') sample.goals++;
    else if (outcome === 'save') sample.saves++;
    else if (outcome === 'post') sample.posts++;
    else sample.wide++;
  }

  sample.onNet = sample.goals + sample.saves;
  sample.savePercentage = sample.onNet === 0 ? 0 : sample.saves / sample.onNet;
  sample.conversion = sample.goals / options.count;
  return sample;
}

describe('goalie balance', () => {
  const SHOTS = 400;
  const ordinary = sampleShots({ count: SHOTS, oneTimer: false });
  const oneTimers = sampleShots({ count: SHOTS, oneTimer: true });

  it('stops 70-85% of the shots that reach the net', () => {
    /*
     * Measured at goalie 65 vs shooter 65 over these exact 400 seeded shots:
     * 71 goals, 267 saves, 338 on net -> .7899. The rubric band is .70-.85, so
     * the margin is .090 below and .060 above.
     */
    expect(ordinary.onNet).toBeGreaterThan(SHOTS * 0.5);
    expect(ordinary.savePercentage).toBeGreaterThanOrEqual(0.7);
    expect(ordinary.savePercentage).toBeLessThanOrEqual(0.85);
  });

  it('lets most shots reach the net at all', () => {
    // The shooting spread has to be tight enough that a miss is a decision, not
    // a dice roll: 338 of 400 on net, plus 28 posts. Threshold 0.7 leaves room.
    expect(ordinary.onNet / SHOTS).toBeGreaterThan(0.7);
  });

  it('converts one-timers better than ordinary shots', () => {
    /*
     * Measured over the same 400 shot positions against a SETTLED goalie:
     * ordinary 72 goals (.1800), one-timer 91 (.2275) — a 1.26x edge.
     *
     * The figure recorded here used to be 2.14x, and that number was an artifact
     * of this harness firing on tick 0: the goalie was one update out of its reset
     * position and had never tracked the shooter, so the "one-timer" advantage was
     * really just an unset goalie. Settling it for 45 ticks first drops the edge to
     * 1.26x, which independently matches the 1.258x measured over 30 real-match
     * seeds — two different methods agreeing is why 1.26x is believed and 2.14x is not.
     *
     * Asserted at 1.15x: the mechanic must stay worth setting up, but the exact
     * edge is a tuning knob. Making the one-timer payoff feel bigger is open
     * polish work, tracked in QA_LOG.md — the honest number belongs here meanwhile.
     *
     * This harness arms the window by hand and drives the shooter from a seat, so
     * it says nothing at all about whether the AI ever takes a one-timer worth
     * having. `converts one-timers better in a real match` further down is the
     * guard on that, and it is not optional: deleting the AI's shot-angle
     * discipline leaves every assertion in this block green while inverting the
     * edge in actual play.
     */
    expect(oneTimers.conversion).toBeGreaterThan(ordinary.conversion * 1.15);
    expect(oneTimers.savePercentage).toBeLessThan(ordinary.savePercentage);
  });

  it('gets a one-timer to the net more often, because it is more accurate', () => {
    // oneTimerAccuracyBonus tightens the spread, so fewer one-timers miss:
    // measured 376 of 400 on net against 338 for a wrist shot.
    expect(oneTimers.onNet).toBeGreaterThan(ordinary.onNet);
  });

  it('rewards a better goalie', () => {
    /*
     * Save percentage by goalie rating over 300 seeded shots: 30 -> .7298 and
     * 95 -> .8577, a gap of .1279.
     *
     * The threshold was 0.1 against a measured .266, back when `readError` ran
     * 6.1/1.9 and `reactionTicks` 17/7. That spread is what put a weak-vs-weak
     * DFHL matchup at 19.7 goals and an elite-vs-elite one at 2.9, so it was
     * deliberately compressed — a goalie's rating should decide games, not decide
     * which sport is being played. 0.06 against .1279 leaves the same kind of
     * margin the old bound had, and a goalie whose rating does nothing at all
     * still fails it.
     */
    const weak = sampleShots({ count: 300, oneTimer: false, goalieSkill: 30 });
    const elite = sampleShots({ count: 300, oneTimer: false, goalieSkill: 95 });
    expect(elite.savePercentage).toBeGreaterThan(weak.savePercentage + 0.06);
  });
});

// ---------------------------------------------------------------------------
// The same question asked of a real match
// ---------------------------------------------------------------------------

interface MatchTally {
  shots: number;
  saves: number;
  goals: number;
  /** Release speed of every shot, so the CPU's windup is visible here too. */
  shotPower: number[];
  /** Shots split by whether the one-timer window was armed when they left. */
  oneTimerShots: number;
  oneTimerGoals: number;
  ordinaryShots: number;
  ordinaryGoals: number;
}

function emptyTally(): MatchTally {
  return {
    shots: 0,
    saves: 0,
    goals: 0,
    shotPower: [],
    oneTimerShots: 0,
    oneTimerGoals: 0,
    ordinaryShots: 0,
    ordinaryGoals: 0,
  };
}

/**
 * Event counts over a full AI-vs-AI match at the standard 3 x 180 s.
 *
 * A shot is a one-timer if the window was armed at the START of the tick it
 * fired on — `releaseShot` clears `oneTimerTicks`, so by the time the event is
 * read the evidence is gone. The goal that follows is credited to the last shot
 * of the possession, which is how a rebound put in off a one-timer counts for the
 * play that created it; the count is reset at every faceoff.
 */
function tallyFullMatch(seed: number): MatchTally {
  const config = makeTestMatchConfig({ seed });
  const state = createMatch(config);
  const tally = emptyTally();
  let ticks = 0;
  let pendingOneTimer: boolean | null = null;

  while (state.phase !== 'final' && ticks < 400_000) {
    const armed = state.puck.carrierId !== null && state.puck.oneTimerTicks > 0;
    for (const event of stepMatch(state, {}, config)) {
      if (event.type === 'shot') {
        tally.shots++;
        tally.shotPower.push(event.power ?? 0);
        pendingOneTimer = armed;
        if (armed) tally.oneTimerShots++;
        else tally.ordinaryShots++;
      } else if (event.type === 'save') tally.saves++;
      else if (event.type === 'goal') {
        tally.goals++;
        if (pendingOneTimer === true) tally.oneTimerGoals++;
        else if (pendingOneTimer === false) tally.ordinaryGoals++;
      } else if (event.type === 'faceoff') {
        pendingOneTimer = null;
      }
    }
    ticks++;
  }
  if (state.phase !== 'final') throw new Error(`match with seed ${seed} never finished`);
  return tally;
}

/**
 * Sixteen seeds rather than eight.
 *
 * Eight full matches produce about 90 one-timer shots between them, and 17 goals
 * off that is +/- 4 on Poisson noise alone — enough to move the measured
 * one-timer edge from 1.28x to 1.66x between two samples of the same build. The
 * conversion test below is the only guard on a property AI shot selection can
 * invert, so it gets a sample it can actually stand on.
 */
const MATCH_SEEDS = [
  1, 2, 3, 7, 99, 4242, 31337, 0x5eed1234, 11, 22, 33, 44, 55, 66, 77, 88,
];

describe('goalie balance in a real match', () => {
  const pooled = emptyTally();
  for (const seed of MATCH_SEEDS) {
    const tally = tallyFullMatch(seed);
    pooled.shots += tally.shots;
    pooled.saves += tally.saves;
    pooled.goals += tally.goals;
    pooled.shotPower.push(...tally.shotPower);
    pooled.oneTimerShots += tally.oneTimerShots;
    pooled.oneTimerGoals += tally.oneTimerGoals;
    pooled.ordinaryShots += tally.ordinaryShots;
    pooled.ordinaryGoals += tally.ordinaryGoals;
  }
  const onNet = pooled.saves + pooled.goals;

  it('stops 70-85% of what reaches the net across eight full matches', () => {
    /*
     * This is the assertion that actually protects the goalie tuning, and it is
     * here because the isolated harness above is not sensitive enough on its
     * own: reverting `GOALIE.readError` to the pre-tuning 5.2/1.1 moves the
     * isolated figure to .834 — still inside the band — while the number below
     * goes to .8865 and trips the ceiling. Tightening further, to 4.0/0.6,
     * reads .9647 here.
     *
     * Measured over these sixteen seeds: 1,210 shots, 188 goals, 851 events on
     * net -> .779, which sits .079 above the floor and .071 below the ceiling.
     * Deterministic, so those margins are protection against future tuning
     * drift rather than against sampling noise.
     *
     * `goals` here counts every goal, including the handful walked over the line
     * with the puck on a stick, which no goalie ever faced — so this figure runs
     * a shade below a true save percentage, in the safe direction.
     */
    expect(pooled.shots).toBeGreaterThan(200);
    const savePercentage = pooled.saves / onNet;
    expect(savePercentage).toBeGreaterThanOrEqual(0.7);
    expect(savePercentage).toBeLessThanOrEqual(0.85);
  });

  it('scores at an arcade rate rather than a simulation one', () => {
    /*
     * The band the whole scoring tuning pass exists to hit, and the one number
     * a player feels before any other. The rubric asks for 6 to 14.
     *
     * Measured: 188 combined goals over these 16 matches = 11.75 a game. The
     * bounds were 4 and 26, which is not a band at all — a drift back to 4.1 a
     * game, barely above the 3 the tuning pass was commissioned to fix, would
     * have stayed green, and so would 25.9. They were then 6 and 20, with the
     * ceiling still 43% above what the rubric actually asks for. At 6 and 14 the
     * measurement sits 5.75 above the floor and 2.25 below the ceiling, which is
     * room for tuning and not room for the arcade feel to drain away.
     */
    const perMatch = pooled.goals / MATCH_SEEDS.length;
    expect(perMatch).toBeGreaterThanOrEqual(6);
    expect(perMatch).toBeLessThanOrEqual(14);
  });

  it('converts one-timers better in a real match, not just on a rigged harness', () => {
    /*
     * THE ASSERTION THAT PROTECTS THE AI'S SHOT SELECTION.
     *
     * The isolated harness above arms the window by hand and drives the shooter
     * from a seat, so it cannot see whether the CPU ever takes a one-timer worth
     * having. Deleting `hasShootingAngle` — the read that stops the AI firing
     * from the goal line extended — left all 85 tests green while the one-timer
     * edge in actual play INVERTED, to one-timers converting 8.3% per shot
     * against 14.7% for ordinary shots. That is exactly the regression the
     * comments in ai.ts and goalie.ts say the fix exists to cure, and the
     * full-match guards missed it because shot volume rose to compensate: goals
     * a game did not move and the pooled save percentage went from .790 to .832,
     * still inside the band asserted above.
     *
     * Measured over these 16 seeds: one-timers 44 goals from 188 shots (23.4%),
     * ordinary shots 144 from 1,022 (14.1%) — a 1.66x edge. Asserted at 1.2,
     * which leaves the exact figure free to move and still catches an inversion
     * from a mile away.
     */
    expect(pooled.oneTimerShots).toBeGreaterThan(100);
    expect(pooled.ordinaryShots).toBeGreaterThan(400);

    const oneTimerRate = pooled.oneTimerGoals / pooled.oneTimerShots;
    const ordinaryRate = pooled.ordinaryGoals / pooled.ordinaryShots;
    expect(ordinaryRate).toBeGreaterThan(0);
    expect(oneTimerRate / ordinaryRate).toBeGreaterThan(1.2);
  });

  it('turns roughly half of all shots into work for the goalie', () => {
    // 851 of 1,210 shot events end up on net. The point of the bound is that
    // shots are not simply vanishing into the boards the way they did when the
    // accuracy spread was 0.19 rad, when barely a fifth of them arrived.
    expect(onNet / pooled.shots).toBeGreaterThan(0.6);
  });

  it('lets the CPU wind a shot up instead of wristing everything', () => {
    /*
     * `resolveSkaterActions` fires on release, and the AI used to press and let
     * go on consecutive ticks — so every CPU shot left on windup 1 of 42, power
     * 0.024, and `SHOOTING.slapSpeed*`, `maxWindupTicks` and
     * `slapAccuracyPenalty` were unreachable in AI play. That includes the
     * CPU-vs-CPU demo and every skater whose seat drops mid-match.
     *
     * Measured over these eight matches at skill 65, where a pure wrister leaves
     * at 2.025 ft/tick and a full slapshot at 2.791: min 2.043, median 2.463,
     * p95 2.499, max 2.992 (an on-fire one-timer). The spread is the assertion —
     * a single-valued distribution means the button is being tapped again.
     */
    const powers = [...pooled.shotPower].sort((a, b) => a - b);
    expect(powers.length).toBeGreaterThan(200);
    const spread = powers[powers.length - 1] - powers[0];
    expect(spread).toBeGreaterThan(0.5);

    // And a quarter of them carry a real load rather than a single tick of it.
    const loaded = powers.filter((power) => power > powers[0] + spread * 0.25).length;
    expect(loaded / powers.length).toBeGreaterThan(0.25);
  });
});

// ---------------------------------------------------------------------------
// The scoring band across the ratings the league actually contains
// ---------------------------------------------------------------------------

describe('the arcade scoring rate holds across the whole ratings range', () => {
  /*
   * The band above is measured at the fixture's default of 65, and for two
   * rounds that was the only place it was ever checked. It did not hold anywhere
   * else: at 6.1/1.9 read error and 17/7 reaction ticks, an equal-skill sweep ran
   * 16.2 goals a game at 40 and 2.8 at 95, and holding skaters at 65 while moving
   * only the goalie ran 19.7 down to 2.9.
   *
   * That is not an abstract concern. Aspect A's pipeline floors every rated
   * player at overall 40 and pins 207 real ones exactly there, and the league's
   * starting goalies run from 86 to 96 — so a DFHL matchup between two weak
   * franchises was a shooting gallery and one between two elite goalies was 3-1.
   * Both ends are checked here, and the goalie is swept on its own because it is
   * by far the stronger of the two levers.
   */
  const BAND_SEEDS = [1, 2, 3, 7, 99, 4242, 31337, 11];

  function goalsPerMatch(spec: { skill?: number; goalieSkill?: number }): number {
    let goals = 0;
    for (const seed of BAND_SEEDS) {
      const team = { skill: spec.skill ?? 65, goalieSkill: spec.goalieSkill };
      goals += tallyBandMatch(seed, team);
    }
    return goals / BAND_SEEDS.length;
  }

  /** Goals in one full match at the standard length, both sides on `team`. */
  function tallyBandMatch(seed: number, team: { skill: number; goalieSkill?: number }): number {
    const config = makeTestMatchConfig({ seed, home: team, away: team });
    const state = createMatch(config);
    let ticks = 0;
    let goals = 0;
    while (state.phase !== 'final' && ticks < 400_000) {
      for (const event of stepMatch(state, {}, config)) if (event.type === 'goal') goals++;
      ticks++;
    }
    if (state.phase !== 'final') throw new Error(`match with seed ${seed} never finished`);
    return goals;
  }

  // Played once, up here: these are full matches at the standard length, and
  // re-running them inside each `it` puts the file over its own timeout.
  // 65 is deliberately absent: the pooled block above already measures it over
  // twice as many seeds, and these are full-length matches.
  const byEqualSkill = [40, 95].map((skill) => ({ skill, perMatch: goalsPerMatch({ skill }) }));
  const floorGoalie = goalsPerMatch({ skill: 65, goalieSkill: 40 });
  const eliteGoalie = goalsPerMatch({ skill: 65, goalieSkill: 95 });

  it('stays inside 6-14 from the roster floor to the very top', () => {
    /*
     * Two weak franchises and two strong ones. Measured over these eight seeds:
     * 40 -> 12.5, 95 -> 10.8, with 65 at 11.75 above, where the old tuning read
     * 16.2 and 2.8 at the two ends. Real lineups built out of rosters.json land
     * between 9.2 and 12.0 across weakest-vs-weakest, strongest-vs-strongest and
     * a mismatch, but this file deliberately does not read that artefact: a sim
     * test that depends on the roster pipeline turns a CSV refresh into a sim
     * failure. The fixture's flat skills bracket the same range.
     */
    for (const entry of byEqualSkill) {
      expect(entry.perMatch, `equal skill ${entry.skill}`).toBeGreaterThanOrEqual(6);
      expect(entry.perMatch, `equal skill ${entry.skill}`).toBeLessThanOrEqual(14);
    }
  });

  it('does not let the goalie rating on its own decide the sport being played', () => {
    /*
     * Skaters held at 65, only the goalie moved: the single strongest lever in
     * the game, and the one the scoring band lives or dies on. It used to run
     * 19.7 goals a game at rating 30 down to 2.9 at 95 — a 16.8-goal swing, which
     * is not a difficulty setting, it is a different sport at each end.
     *
     * Measured now: 14.3 at the roster floor of 40 against 10.5 at 95. The
     * assertion is on the SPREAD rather than on the ends, because that is the
     * property that was wrong; and it is two-sided, because a goalie whose rating
     * does nothing at all would be its own failure. Compressing this much further
     * is a trap — pulling `moveSpeed` and `lungeReach` in as well got the spread
     * to 3.4 and took an 85-vs-45 matchup from 19 wins in 20 down to 13.
     */
    expect(floorGoalie).toBeGreaterThan(eliteGoalie + 1);
    expect(floorGoalie - eliteGoalie).toBeLessThan(9);
  });
});

// ---------------------------------------------------------------------------
// Attributes decide matches
// ---------------------------------------------------------------------------

interface MatchResult {
  home: number;
  away: number;
}

function playFullMatch(seed: number, homeSkill: number, awaySkill: number): MatchResult {
  // 60 s periods rather than 180: a third of the run time for the same verdict,
  // and still 15,000-odd ticks of hockey per match.
  const config = makeTestMatchConfig({
    seed,
    periodSeconds: 60,
    home: { skill: homeSkill },
    away: { skill: awaySkill },
  });
  const state = createMatch(config);
  let ticks = 0;
  while (state.phase !== 'final' && ticks < 200_000) {
    stepMatch(state, {}, config);
    ticks++;
  }
  if (state.phase !== 'final') throw new Error(`match with seed ${seed} never finished`);
  return { home: state.score.home, away: state.score.away };
}

/**
 * Ten seeds rather than five.
 *
 * At five, one upset out of five took the away-bench sweep from 5 wins to 4 and
 * left it sitting exactly on its own threshold — a test with no margin is a test
 * that will go red on a tuning change rather than on a regression. Ten matches a
 * sweep costs about 6 s and buys a real margin on both.
 */
const SKILL_SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 101, 202];
const STRONG = 85;
const WEAK = 45;

describe('attributes decide matches', () => {
  interface Tally {
    strong: number;
    weak: number;
    strongWins: number;
  }

  function playSweep(strongSide: TeamSide): Tally {
    const tally: Tally = { strong: 0, weak: 0, strongWins: 0 };
    for (const seed of SKILL_SEEDS) {
      const result =
        strongSide === 'home'
          ? playFullMatch(seed, STRONG, WEAK)
          : playFullMatch(seed, WEAK, STRONG);
      const strongGoals = strongSide === 'home' ? result.home : result.away;
      const weakGoals = strongSide === 'home' ? result.away : result.home;
      tally.strong += strongGoals;
      tally.weak += weakGoals;
      if (strongGoals > weakGoals) tally.strongWins++;
    }
    return tally;
  }

  const strongAtHome = playSweep('home');
  const strongAway = playSweep('away');

  it('lets the better team win from the home bench', () => {
    /*
     * Measured, 85 vs 45 over the ten seeds: 52-11 on aggregate, 10 wins from 10.
     * Asserted at 2x aggregate (measured 4.7x) and 8 wins from 10, both far
     * enough off the measurement that narrowing the skill curve would have to
     * change the game's feel before it changed this test's answer.
     */
    expect(strongAtHome.strong).toBeGreaterThan(strongAtHome.weak * 2);
    expect(strongAtHome.strongWins).toBeGreaterThanOrEqual(8);
  });

  it('lets the better team win from the away bench too', () => {
    // Same ten seeds with the rosters swapped: measured 55-8, 9 wins from 10.
    // Aggregate ratio 6.9x, so the same 2x threshold still has real headroom.
    expect(strongAway.strong).toBeGreaterThan(strongAway.weak * 2);
    expect(strongAway.strongWins).toBeGreaterThanOrEqual(8);
  });

  it('is the attributes and not the side of the ice', () => {
    // The whole point of running both orientations: if home were quietly
    // favoured, one of the two sweeps would collapse. Measured 19 strong wins
    // from 20 matches across both.
    expect(strongAtHome.strongWins + strongAway.strongWins).toBeGreaterThanOrEqual(16);

    // And the control: equal rosters over the same seeds must not hand the
    // match to a side. Measured 23-24 on aggregate over ten matches.
    let home = 0;
    let away = 0;
    for (const seed of SKILL_SEEDS) {
      const result = playFullMatch(seed, 65, 65);
      home += result.home;
      away += result.away;
    }
    const total = home + away;
    expect(total).toBeGreaterThan(0);
    // Neither side may take more than 65% of the goals. Measured share: 48.9%
    // home to 51.1% away. The old bound was 75% on a five-match sample; ten
    // matches is a steady enough reading to hold it to something meaningful.
    expect(home / total).toBeLessThan(0.65);
    expect(away / total).toBeLessThan(0.65);
  });
});
