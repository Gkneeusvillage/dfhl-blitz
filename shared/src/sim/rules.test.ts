/**
 * Match rules: goals and their credit, the faceoff that follows, the clock, the
 * period machine, overtime, the shootout, and the two edges where the clock and
 * a shot argue about who got there first.
 *
 * These tests set up a position and then let `stepMatch` do the work. Nothing
 * here calls into rules.ts directly: the point is that the rule fires through
 * the real tick, in the real order, not that the function exists.
 */

import { describe, expect, it } from 'vitest';

import { createMatch, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { FACEOFF, MATCH, RINK, SKATER, TICK_RATE } from '../tuning.js';
import type {
  GamePhase,
  GameSimState,
  InputMap,
  MatchConfig,
  PlayerInput,
  SimEvent,
  SkaterSimState,
  TeamSide,
} from '../types.js';

const SEED = 0x1234abcd;

/**
 * Set the phase without letting the compiler narrow `state.phase` to the literal
 * it was assigned — the sim moves it on during the very next tick, and a
 * narrowed union turns the loop conditions below into "unrelated types" errors.
 */
function setPhase(state: GameSimState, phase: GamePhase): void {
  state.phase = phase;
}

function liveMatch(spec: { seed?: number; periods?: number; periodSeconds?: number } = {}): {
  config: MatchConfig;
  state: GameSimState;
} {
  const config = makeTestMatchConfig({
    seed: spec.seed ?? SEED,
    periods: spec.periods,
    periodSeconds: spec.periodSeconds,
  });
  const state = createMatch(config);
  // Straight into live play: the warmup and the opening draw are exercised by
  // their own tests, and every test here is about what happens after the drop.
  state.phase = 'play';
  state.phaseTimer = 0;
  return { config, state };
}

function onIceFor(state: GameSimState, side: TeamSide): SkaterSimState[] {
  return state.skaters.filter((skater) => skater.side === side && skater.onIce);
}

function playerIdOf(config: MatchConfig, skater: SkaterSimState): string {
  const team = skater.side === 'home' ? config.home : config.away;
  return team.skaters[skater.slot].playerId;
}

/**
 * Put the puck a foot short of the net `scoringSide` attacks, moving in fast,
 * and walk the goalie out of the way. One tick later it is a goal.
 */
function setUpTapIn(state: GameSimState, scoringSide: TeamSide, shooter: SkaterSimState): void {
  const direction = scoringSide === 'home' ? 1 : -1;
  const goalX = direction * RINK.goalLineX;

  state.puck.carrierId = null;
  state.puck.lastTouchedBy = shooter.id;
  state.puck.lastTouchSide = shooter.side;
  state.puck.x = goalX - direction * 1;
  state.puck.y = 0;
  state.puck.vx = direction * 2.5;
  state.puck.vy = 0;
  // Long enough that nobody collects it out of the air before it crosses.
  state.puck.pickupCooldown = 30;

  const goalie = state.goalies.find((entry) => entry.side !== scoringSide);
  if (goalie === undefined) throw new Error('no defending goalie');
  goalie.x = goalX - direction * 30;
  goalie.y = 20;
}

function typesOf(events: SimEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('goals', () => {
  it('credits the scoring side, the shooter, the passer, and the beaten goalie', () => {
    const { config, state } = liveMatch();
    state.clock = 1000;

    const shooter = onIceFor(state, 'home')[0];
    const passer = onIceFor(state, 'home')[1];
    state.assistCandidateId = passer.id;
    setUpTapIn(state, 'home', shooter);

    const events = stepMatch(state, {}, config);

    expect(typesOf(events)).toContain('goal');
    const goal = events.find((event) => event.type === 'goal');
    expect(goal?.side).toBe('home');
    expect(goal?.actorId).toBe(shooter.id);
    expect(goal?.targetId).toBe(passer.id);

    expect(state.score).toEqual({ home: 1, away: 0 });
    expect(state.stats[playerIdOf(config, shooter)].goals).toBe(1);
    expect(state.stats[playerIdOf(config, passer)].assists).toBe(1);
    expect(state.stats[config.away.goalie.playerId].goalsAgainst).toBe(1);
    expect(state.stats[config.home.goalie.playerId].goalsAgainst).toBe(0);
    // The assist is spent; the next goal must earn its own.
    expect(state.assistCandidateId).toBeNull();
  });

  it('refuses an assist to an opponent or to the scorer himself', () => {
    // `assistCandidateId` is just "whoever fed the current carrier", and a puck
    // can change hands without it being cleared. Both guards in scoreGoal exist
    // to stop that becoming a stat line nobody can explain.
    for (const candidate of ['opponent', 'self'] as const) {
      const { config, state } = liveMatch();
      state.clock = 1000;
      const shooter = onIceFor(state, 'home')[0];
      const opponent = onIceFor(state, 'away')[0];
      state.assistCandidateId = candidate === 'self' ? shooter.id : opponent.id;
      setUpTapIn(state, 'home', shooter);

      const events = stepMatch(state, {}, config);

      expect(typesOf(events)).toContain('goal');
      expect(state.stats[playerIdOf(config, shooter)].goals).toBe(1);
      expect(state.stats[playerIdOf(config, shooter)].assists).toBe(0);
      expect(state.stats[playerIdOf(config, opponent)].assists).toBe(0);
      // Nobody at all should have an assist on this goal.
      const assists = Object.values(state.stats).reduce((sum, line) => sum + line.assists, 0);
      expect(assists, `candidate ${candidate}`).toBe(0);
    }
  });

  it('gives an own goal to the other side without crediting a scorer', () => {
    const { config, state } = liveMatch();
    state.clock = 1000;

    // An away defender puts it into his own net: home gets the goal, nobody gets
    // the point, and the away goalie still wears it.
    const victim = onIceFor(state, 'away')[0];
    setUpTapIn(state, 'home', victim);

    const events = stepMatch(state, {}, config);

    expect(state.score).toEqual({ home: 1, away: 0 });
    expect(events.find((event) => event.type === 'goal')?.actorId).toBeUndefined();
    expect(state.stats[playerIdOf(config, victim)].goals).toBe(0);
    expect(state.stats[config.away.goalie.playerId].goalsAgainst).toBe(1);
  });

  it('holds for the celebration and then faces off at centre with fresh lines', () => {
    const { config, state } = liveMatch();
    state.clock = 1000;
    const lineBefore = state.activeLine.home;
    setUpTapIn(state, 'home', onIceFor(state, 'home')[0]);

    stepMatch(state, {}, config);
    expect(state.phase).toBe('goal');
    expect(state.phaseTimer).toBe(MATCH.goalCelebrationTicks - 1);

    let ticks = 0;
    while (state.phase === 'goal' && ticks < MATCH.goalCelebrationTicks * 4) {
      stepMatch(state, {}, config);
      ticks++;
    }

    expect(ticks).toBe(MATCH.goalCelebrationTicks - 1);
    expect(state.phase).toBe('faceoff');
    expect(state.puck).toMatchObject({ x: 0, y: 0, vx: 0, vy: 0, carrierId: null });
    // Lines alternate on every stoppage, so the second unit actually plays.
    expect(state.activeLine.home).toBe(1 - lineBefore);
    expect(state.activeLine.away).toBe(1 - lineBefore);
    expect(onIceFor(state, 'home')).toHaveLength(3);
    expect(onIceFor(state, 'away')).toHaveLength(3);

    // The clock does not run during a celebration.
    expect(state.clock).toBe(1000);
  });

  it('drops the puck again after the faceoff hold', () => {
    const { config, state } = liveMatch();
    state.clock = 1000;
    setUpTapIn(state, 'home', onIceFor(state, 'home')[0]);

    stepMatch(state, {}, config);
    expect(state.phase).toBe('goal');

    // Celebration, then the hold at the dot, then the drop — counted from the
    // tick after the goal so the two holds are the only thing being measured.
    let ticks = 0;
    while (state.phase !== 'play' && ticks < 10_000) {
      stepMatch(state, {}, config);
      ticks++;
    }
    expect(state.phase).toBe('play');
    expect(ticks).toBe(MATCH.goalCelebrationTicks + MATCH.faceoffHoldTicks - 1);
  });
});

describe('the clock and the period machine', () => {
  it('ends the period at zero and restarts the clock for the next one', () => {
    const { config, state } = liveMatch();
    state.clock = 1;

    const events = stepMatch(state, {}, config);
    expect(typesOf(events)).toContain('periodEnd');
    expect(state.phase).toBe('intermission');
    expect(state.period).toBe(1);
    expect(state.phaseTimer).toBe(MATCH.intermissionTicks);

    for (let tick = 0; tick < MATCH.intermissionTicks; tick++) stepMatch(state, {}, config);

    expect(state.period).toBe(2);
    expect(state.clock).toBe(config.periodSeconds * TICK_RATE);
    expect(state.phase).toBe('faceoff');
  });

  it('ends the match when regulation runs out with a leader', () => {
    const { config, state } = liveMatch();
    state.period = config.periods;
    state.clock = 1;
    state.score.home = 3;
    state.score.away = 1;

    const events = stepMatch(state, {}, config);
    expect(typesOf(events)).toEqual(expect.arrayContaining(['periodEnd', 'matchEnd']));
    expect(state.phase).toBe('final');
    expect(state.score).toEqual({ home: 3, away: 1 });
  });

  it('stops simulating once the match is final', () => {
    const { config, state } = liveMatch();
    setPhase(state, 'final');
    const frozen = JSON.stringify({ ...state, tick: 0 });

    for (let i = 0; i < 100; i++) expect(stepMatch(state, {}, config)).toEqual([]);
    expect(JSON.stringify({ ...state, tick: 0 })).toBe(frozen);
  });
});

describe('overtime and the shootout', () => {
  it('goes to sudden death when regulation ends level', () => {
    const { config, state } = liveMatch();
    state.period = config.periods;
    state.clock = 1;
    state.score.home = 2;
    state.score.away = 2;

    stepMatch(state, {}, config);
    expect(state.phase).toBe('intermission');

    let ticks = 0;
    while (state.phase !== 'overtime' && ticks < 5000) {
      stepMatch(state, {}, config);
      ticks++;
    }

    expect(state.phase).toBe('overtime');
    expect(state.period).toBe(config.periods + 1);
    expect(state.clock).toBe(MATCH.overtimeSeconds * TICK_RATE);
    expect(ticks).toBe(MATCH.intermissionTicks + MATCH.faceoffHoldTicks);
  });

  it('ends overtime on the first goal, with no celebration', () => {
    const { config, state } = liveMatch();
    state.period = config.periods + 1;
    setPhase(state, 'overtime');
    state.clock = MATCH.overtimeSeconds * TICK_RATE;
    state.score.home = 2;
    state.score.away = 2;

    setUpTapIn(state, 'away', onIceFor(state, 'away')[0]);
    const events = stepMatch(state, {}, config);

    expect(typesOf(events)).toEqual(expect.arrayContaining(['goal', 'matchEnd']));
    expect(state.phase).toBe('final');
    expect(state.score).toEqual({ home: 2, away: 3 });
  });

  it('resolves a shootout when overtime expires level', () => {
    for (const seed of [1, 2, 3, 7, 0x5eed1234]) {
      const { config, state } = liveMatch({ seed });
      state.period = config.periods + 1;
      setPhase(state, 'overtime');
      state.clock = 1;
      state.score.home = 3;
      state.score.away = 3;

      stepMatch(state, {}, config);
      expect(state.phase, `seed ${seed}`).toBe('shootout');
      expect(state.shootoutRound).toBe(0);
      // One shooter, one goalie, nobody else.
      expect(onIceFor(state, 'home').length + onIceFor(state, 'away').length).toBe(1);

      let ticks = 0;
      // Worst case is the 12-round backstop: 24 attempts of 9 s each.
      while (state.phase !== 'final' && ticks < 40_000) {
        stepMatch(state, {}, config);
        ticks++;
      }

      expect(state.phase, `seed ${seed} stalled after ${ticks} ticks`).toBe('final');
      // Attempts always come in pairs, so nobody wins on an uneven number of shots.
      expect(state.shootoutRound % 2).toBe(0);

      const soHome = state.shootoutScore.home;
      const soAway = state.shootoutScore.away;
      if (soHome === soAway) {
        // The 12-round backstop was reached and the scoreline stands as a draw.
        expect(state.score.home).toBe(3);
        expect(state.score.away).toBe(3);
        expect(state.shootoutRound / 2).toBeGreaterThanOrEqual(MATCH.shootoutMaxRounds);
      } else {
        // The winner takes it by one, the way a real scoreline reads.
        const winner: TeamSide = soHome > soAway ? 'home' : 'away';
        expect(state.score[winner]).toBe(4);
        expect(state.score[winner === 'home' ? 'away' : 'home']).toBe(3);
      }
    }
  });

  it('calls a shootout that nobody can win rather than running forever', () => {
    /*
     * `stepMatch` has no way out of a phase that never terminates, so a shootout
     * that keeps trading rounds has to be called. Two 99-rated goalies against
     * 1-rated shooters is the case that gets there: measured over these twelve
     * seeds, every one terminates, none exceeds the 12-pair cap, and two of them
     * (22 and 66) go the whole distance 0-0 and are called as draws.
     *
     * The assertions are split on purpose. "Every seed terminates" is what fails
     * if the backstop is deleted — those two seeds run forever. "At least one
     * seed reaches the cap" is what fails if the backstop stops being reachable,
     * which would quietly make the first assertion vacuous.
     */
    const seeds = [1, 2, 3, 7, 11, 22, 33, 44, 55, 66, 77, 99];
    let cappedDraws = 0;

    for (const seed of seeds) {
      const config = makeTestMatchConfig({
        seed,
        home: { skill: 1, goalieSkill: 99 },
        away: { skill: 1, goalieSkill: 99 },
      });
      const state = createMatch(config);
      state.period = config.periods + 1;
      setPhase(state, 'overtime');
      state.phaseTimer = 0;
      state.clock = 1;
      state.score.home = 2;
      state.score.away = 2;

      stepMatch(state, {}, config);
      expect(state.phase).toBe('shootout');

      let ticks = 0;
      while (state.phase !== 'final' && ticks < 60_000) {
        stepMatch(state, {}, config);
        ticks++;
      }

      expect(state.phase, `seed ${seed} stalled after ${ticks} ticks`).toBe('final');
      expect(state.shootoutRound / 2, `seed ${seed}`).toBeLessThanOrEqual(MATCH.shootoutMaxRounds);

      if (state.shootoutScore.home === state.shootoutScore.away) {
        cappedDraws++;
        expect(state.shootoutRound / 2, `seed ${seed}`).toBe(MATCH.shootoutMaxRounds);
        // Still level, so the scoreline stands as it was.
        expect(state.score, `seed ${seed}`).toEqual({ home: 2, away: 2 });
      }
    }

    expect(cappedDraws).toBeGreaterThan(0);
  });

  it('does not credit a shootout goal to the shooter for scoring on himself', () => {
    /*
     * `applyPuckOutcome` used to test only that *a* goal had been conceded and
     * then call `endShootoutAttempt(ctx, true)` for any goal at all while the
     * phase was 'shootout', without asking which net it went into. Reproduced
     * directly: home shooting, puck driven into the home net, 0-0 became 1-0.
     *
     * Not reachable through the current AI — `releaseShot` always aims at
     * `attackingGoalX` — but a shootout deciding a league match on a mis-credited
     * own goal is the worst possible place for a sign error to be one behaviour
     * change away from live.
     */
    const { config, state } = liveMatch();
    state.period = config.periods + 1;
    setPhase(state, 'overtime');
    state.clock = 1;
    state.score.home = 3;
    state.score.away = 3;
    stepMatch(state, {}, config);
    expect(state.phase).toBe('shootout');
    expect(state.shootoutRound).toBe(0);

    // Home shoots first. Send the puck the wrong way, at the net home defends.
    const shooter = state.skaters.find((skater) => skater.id === state.puck.carrierId);
    expect(shooter?.side).toBe('home');
    state.puck.carrierId = null;
    state.puck.lastTouchedBy = shooter?.id ?? null;
    state.puck.lastTouchSide = 'home';
    state.puck.x = -RINK.goalLineX + 1;
    state.puck.y = 0;
    state.puck.vx = -2.5;
    state.puck.vy = 0;
    state.puck.pickupCooldown = 30;
    // Out of the way, so the puck reaches the line rather than the goalie's body.
    const ownGoalie = state.goalies[0];
    ownGoalie.y = 20;

    stepMatch(state, {}, config);

    expect(state.shootoutScore).toEqual({ home: 0, away: 0 });
    // The attempt is over either way — it just was not a goal.
    expect(state.shootoutRound).toBe(1);
  });
});

describe('the buzzer', () => {
  /** Park a shooter in the slot with the puck on the stick and a seat driving them. */
  function armShooter(state: GameSimState): SkaterSimState {
    state.seats.push({ id: 'shooter', side: 'home', nickname: 'shooter', connected: true });
    const shooter = onIceFor(state, 'home')[0];
    shooter.x = 40;
    shooter.y = 0;
    shooter.facing = 0;
    shooter.vx = 0;
    shooter.vy = 0;
    shooter.windup = 0;
    shooter.actionCooldown = 0;

    state.puck.carrierId = shooter.id;
    state.puck.lastTouchedBy = shooter.id;
    state.puck.lastTouchSide = 'home';
    state.puck.x = shooter.x + SKATER.stickReach;
    state.puck.y = 0;
    state.puck.vx = 0;
    state.puck.vy = 0;
    state.puck.pickupCooldown = 0;
    return shooter;
  }

  const press = (state: GameSimState, shoot: boolean): InputMap => {
    const input: PlayerInput = {
      tick: state.tick + 1,
      moveX: 0,
      moveY: 0,
      shoot,
      pass: false,
      turbo: false,
      switchPlayer: false,
    };
    return { shooter: input };
  };

  it('counts a shot released on the final tick of the period', () => {
    // The physics run before the clock does, so a shot that leaves the stick on
    // the buzzer tick beat the horn.
    const { config, state } = liveMatch();
    state.clock = 2;
    const shooter = armShooter(state);

    stepMatch(state, press(state, true), config); // load the windup, clock 2 -> 1
    const events = stepMatch(state, press(state, false), config); // release, clock 1 -> 0

    expect(typesOf(events)).toEqual(expect.arrayContaining(['shot', 'periodEnd']));
    expect(state.stats[playerIdOf(config, shooter)].shots).toBe(1);
    expect(state.phase).toBe('intermission');
    expect(state.clock).toBe(0);
  });

  it('refuses a shot released after the clock hits zero', () => {
    const { config, state } = liveMatch();
    state.clock = 2;
    const shooter = armShooter(state);

    stepMatch(state, press(state, true), config); // clock 2 -> 1
    stepMatch(state, press(state, true), config); // clock 1 -> 0, still holding
    expect(state.phase).toBe('intermission');
    expect(state.clock).toBe(0);

    const afterBuzzer = stepMatch(state, press(state, false), config);

    expect(typesOf(afterBuzzer)).not.toContain('shot');
    expect(typesOf(afterBuzzer)).not.toContain('goal');
    expect(state.stats[playerIdOf(config, shooter)].shots).toBe(0);
    expect(state.score).toEqual({ home: 0, away: 0 });
    // The puck is still glued to the stick — no action resolved at all.
    expect(state.puck.carrierId).toBe(shooter.id);
  });

  it('does not let a goal on the final tick be erased by the horn', () => {
    const { config, state } = liveMatch();
    state.clock = 1;
    setUpTapIn(state, 'home', onIceFor(state, 'home')[0]);

    const events = stepMatch(state, {}, config);

    expect(typesOf(events)).toContain('goal');
    expect(state.score).toEqual({ home: 1, away: 0 });
    // A goal switches straight into the celebration, so the clock is not spent
    // on this tick; the period ends once play resumes and the last tick runs.
    expect(state.phase).toBe('goal');
    expect(state.clock).toBe(1);

    let ticks = 0;
    while (state.phase !== 'intermission' && ticks < 5000) {
      stepMatch(state, {}, config);
      ticks++;
    }
    expect(state.phase).toBe('intermission');
    expect(state.clock).toBe(0);
    expect(state.score).toEqual({ home: 1, away: 0 });
  });
});

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

describe('the puck-drop contest', () => {
  type Press = 'never' | 'hold' | 'cue';

  /**
   * Play a match from the opening warmup with each seat pressing to a script,
   * and count how many draws the home side won.
   *
   * A won draw is nudged back toward the winner's own end, and home attacks +x,
   * so a home win shows up as the puck leaving the dot with a negative vx. That
   * is read off the state rather than out of the rng, so the measurement is of
   * the rule and not of the implementation.
   */
  function drawRecord(homePress: Press, awayPress: Press): { won: number; total: number } {
    let won = 0;
    let total = 0;

    for (const seed of SEEDS) {
      const config = makeTestMatchConfig({ seed });
      const state = createMatch(config);
      state.seats.push({ id: 'home-seat', side: 'home', nickname: 'home', connected: true });
      state.seats.push({ id: 'away-seat', side: 'away', nickname: 'away', connected: true });

      let ticks = 0;
      while (state.phase !== 'final' && ticks < 100_000) {
        const dropping = state.phase === 'faceoff';
        // The hold is a fixed length and `phaseTimer` is in every snapshot, so
        // "on the cue" is something a client can genuinely play to.
        const onCue = dropping && state.phaseTimer <= FACEOFF.drawPressWindowTicks / 2;
        const inputs: InputMap = {};
        for (const seat of state.seats) {
          const script = seat.side === 'home' ? homePress : awayPress;
          const down = script === 'hold' || (script === 'cue' && onCue);
          inputs[seat.id] = {
            tick: state.tick + 1,
            moveX: 0,
            moveY: 0,
            shoot: down,
            pass: false,
            turbo: false,
            switchPlayer: false,
          };
        }
        stepMatch(state, inputs, config);
        if (dropping && (state.phase === 'play' || state.phase === 'overtime')) {
          total++;
          if (state.puck.vx < 0) won++;
        }
        ticks++;
      }
    }
    return { won, total };
  }

  const SEEDS = [1, 2, 3, 7, 11, 22];

  // Played once, up here, rather than inside each `it`: these are full matches,
  // and re-running them per assertion put the file over its own timeout.
  const idle = drawRecord('never', 'never');
  const cue = drawRecord('cue', 'never');
  const held = drawRecord('hold', 'never');
  const cueVsHold = drawRecord('cue', 'hold');

  it('rewards a press on the cue', () => {
    // Measured over these six matches: 50.0% of draws with neither seat touching
    // a button, 96.0% with home pressing on the cue.
    expect(idle.total).toBeGreaterThan(20);
    expect(cue.won / cue.total).toBeGreaterThan(idle.won / idle.total + 0.2);
  });

  it('gives a seat that tapes the button down nothing at all', () => {
    /*
     * The exploit this rule exists for. `dropPuck` used to credit the bonus to
     * any seat with shoot or pass set on the drop tick, with no edge detection
     * and no cost for holding — so the dominant strategy was to tape the button
     * down, and measured over six full matches it took the home side from 51.7%
     * of draws to 92.2%.
     *
     * Holding is now strictly worse than doing nothing: measured 33.3% against
     * 50.0% idle, and a seat that presses on the cue beats one that holds 94.7%
     * of the time.
     */
    expect(held.won / held.total).toBeLessThanOrEqual(idle.won / idle.total);
    expect(cueVsHold.won / cueVsHold.total).toBeGreaterThan(0.7);
  });

  it('spends the press, so it cannot be carried into the play as shot power', () => {
    // `windup` is the same counter the slapshot uses. A draw press that survived
    // the drop would be free load on the first shot of the shift.
    const config = makeTestMatchConfig({ seed: SEED, periodSeconds: 20 });
    const state = createMatch(config);
    state.seats.push({ id: 'home-seat', side: 'home', nickname: 'home', connected: true });

    const held: InputMap = {
      'home-seat': {
        tick: 0,
        moveX: 0,
        moveY: 0,
        shoot: true,
        pass: false,
        turbo: false,
        switchPlayer: false,
      },
    };

    let ticks = 0;
    let peak = 0;
    while (state.phase !== 'play' && ticks < 1000) {
      held['home-seat'].tick = state.tick + 1;
      stepMatch(state, held, config);
      peak = Math.max(peak, ...state.skaters.map((skater) => skater.windup));
      ticks++;
    }

    // The counter really did run while the puck was being held...
    expect(peak).toBeGreaterThan(FACEOFF.drawPressWindowTicks);
    // ...and the drop cleared it for everybody who took a draw.
    for (const skater of state.skaters) {
      expect(skater.windup, skater.id).toBeLessThanOrEqual(1);
    }
  });
});

describe('the opening sequence', () => {
  it('warms up, forms up, drops the puck, and starts the clock', () => {
    const config = makeTestMatchConfig({ seed: SEED });
    const state = createMatch(config);

    expect(state.phase).toBe('warmup');
    expect(state.clock).toBe(config.periodSeconds * TICK_RATE);

    for (let tick = 0; tick < MATCH.faceoffHoldTicks; tick++) stepMatch(state, {}, config);
    expect(state.phase).toBe('faceoff');
    // The opening draw keeps the line already out, so the top unit starts.
    expect(state.activeLine).toEqual({ home: 0, away: 0 });
    expect(state.puck).toMatchObject({ x: 0, y: 0, carrierId: null });

    for (let tick = 0; tick < MATCH.faceoffHoldTicks; tick++) stepMatch(state, {}, config);
    expect(state.phase).toBe('play');
    // The drop happens inside the phase machine, after the physics for that tick
    // have already been skipped, so the clock starts on the tick *after* it.
    expect(state.clock).toBe(config.periodSeconds * TICK_RATE);

    // A won draw nudges the puck back toward the winner's own end.
    expect(Math.abs(state.puck.vx)).toBeGreaterThan(0);

    stepMatch(state, {}, config);
    expect(state.clock).toBe(config.periodSeconds * TICK_RATE - 1);
  });
});
