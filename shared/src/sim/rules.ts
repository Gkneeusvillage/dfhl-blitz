/**
 * Match rules: faceoffs, goals, the clock, period flow, overtime, the shootout,
 * on-fire streaks, and the stat sheet.
 *
 * Arcade rules, deliberately: no offsides, no icing, no penalties. Every stoppage
 * resets to the center dot, so play never has to be sorted out in a corner.
 */

import { FACEOFF, GOALIE, MATCH, ON_FIRE, PUCK, RINK, TICK_RATE } from '../tuning.js';
import { attackDirection, clamp, defendingGoalX } from '../rink.js';
import { otherSide } from '../types.js';
import type { GameSimState, SkaterSimState, TeamSide } from '../types.js';
import type { SimContext } from './context.js';
import { goalieFor, skaterAttrs, skaterById } from './context.js';
import { clearPendingAssist, pendingAssist } from './actions.js';

/** Regulation is over and we are into extra time. */
export function isOvertimePeriod(state: GameSimState, periods: number): boolean {
  return state.period > periods;
}

function periodLengthTicks(ctx: SimContext, period: number): number {
  return period > ctx.config.periods
    ? MATCH.overtimeSeconds * TICK_RATE
    : ctx.config.periodSeconds * TICK_RATE;
}

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

function parkOffIce(state: GameSimState, skater: SkaterSimState): void {
  skater.onIce = false;
  // Well inside the boards, so "every skater is on the sheet" holds even for the
  // players who are not playing.
  skater.x = clamp((skater.slot - 2.5) * FACEOFF.benchSpacingX, -RINK.halfLength + 20, RINK.halfLength - 20);
  skater.y = skater.side === 'home' ? FACEOFF.benchY : -FACEOFF.benchY;
  skater.vx = 0;
  skater.vy = 0;
  skater.stun = 0;
  skater.windup = 0;
  skater.actionCooldown = 0;
}

/** Line the given side up for a faceoff at (dotX, dotY). */
function formUp(ctx: SimContext, side: TeamSide, dotX: number, dotY: number): void {
  const line = ctx.state.activeLine[side];
  const direction = attackDirection(side);

  for (const skater of ctx.state.skaters) {
    if (skater.side !== side) continue;
    const index = skater.slot - line * 3;
    if (index < 0 || index > 2) {
      parkOffIce(ctx.state, skater);
      continue;
    }
    const spot = FACEOFF.formation[index];
    skater.onIce = true;
    skater.x = dotX - direction * spot.x;
    skater.y = clamp(dotY + spot.y, -RINK.halfWidth + 4, RINK.halfWidth - 4);
    skater.vx = 0;
    skater.vy = 0;
    skater.facing = direction > 0 ? 0 : Math.PI;
    skater.stun = 0;
    skater.windup = 0;
    skater.actionCooldown = 0;
  }
}

function resetGoalies(ctx: SimContext): void {
  for (const goalie of ctx.state.goalies) {
    const goalX = defendingGoalX(goalie.side);
    const inward = goalie.side === 'home' ? 1 : -1;
    goalie.x = goalX + inward * GOALIE.restDepth;
    goalie.y = 0;
    goalie.vx = 0;
    goalie.vy = 0;
    goalie.lunge = 0;
    goalie.lungeCooldown = 0;
    goalie.facing = inward > 0 ? 0 : Math.PI;
  }
}

/**
 * Set up the next faceoff at center.
 *
 * Lines alternate on every stoppage. Three minutes of 3-on-3 with no whistles
 * would otherwise leave the second line on the bench for the whole match. The
 * opening draw keeps the line that is already out, so the top line starts.
 */
export function startFaceoff(ctx: SimContext, changeLines: boolean): void {
  const { state } = ctx;
  if (changeLines) {
    state.activeLine.home = 1 - state.activeLine.home;
    state.activeLine.away = 1 - state.activeLine.away;
  }

  formUp(ctx, 'home', 0, 0);
  formUp(ctx, 'away', 0, 0);
  resetGoalies(ctx);

  state.puck.x = 0;
  state.puck.y = 0;
  state.puck.vx = 0;
  state.puck.vy = 0;
  state.puck.carrierId = null;
  state.puck.lastTouchedBy = null;
  state.puck.lastTouchSide = null;
  state.puck.pickupCooldown = 0;

  state.phase = 'faceoff';
  state.phaseTimer = MATCH.faceoffHoldTicks;
  clearPendingAssist(ctx);

  ctx.events.push({ type: 'faceoff', tick: state.tick, x: 0, y: 0 });
}

/** Skater taking the draw for a side: index 0 of the active line. */
function drawTaker(ctx: SimContext, side: TeamSide): SkaterSimState | null {
  const line = ctx.state.activeLine[side];
  for (const skater of ctx.state.skaters) {
    if (skater.side === side && skater.slot === line * 3) return skater;
  }
  return null;
}

/**
 * Drop the puck.
 *
 * The draw is mostly a coin flip weighted by the two centers, plus a bonus for a
 * seat that had the button down on the drop tick — the arcade "press on the cue"
 * moment, resolved without any client-side minigame state.
 */
export function dropPuck(ctx: SimContext): void {
  const { state } = ctx;
  const home = drawTaker(ctx, 'home');
  const away = drawTaker(ctx, 'away');

  const homeSkill = home ? skaterAttrs(ctx.config, home).checking : 50;
  const awaySkill = away ? skaterAttrs(ctx.config, away).checking : 50;
  let homeEdge = 0.5 + ((homeSkill - awaySkill) / 198) * FACEOFF.drawSkillWeight;

  for (const seat of state.seats) {
    if (!seat.connected) continue;
    const input = ctx.inputs[seat.id];
    if (input === undefined || (!input.shoot && !input.pass)) continue;
    homeEdge += seat.side === 'home' ? FACEOFF.drawSkillWeight : -FACEOFF.drawSkillWeight;
  }

  const winner: TeamSide = ctx.rng.next() < clamp(homeEdge, 0.05, 0.95) ? 'home' : 'away';
  const taker = winner === 'home' ? home : away;

  state.puck.carrierId = null;
  state.puck.pickupCooldown = 0;
  if (taker !== null) {
    // Nudged back toward the winner's own end, the way a won draw actually goes.
    const direction = -attackDirection(winner);
    state.puck.vx = direction * FACEOFF.drawNudgeSpeed;
    state.puck.vy = ctx.rng.range(-1, 1) * FACEOFF.drawNudgeSpeed * 0.5;
  }

  state.phase = isOvertimePeriod(state, ctx.config.periods) ? 'overtime' : 'play';
  state.phaseTimer = 0;
}

// ---------------------------------------------------------------------------
// On fire
// ---------------------------------------------------------------------------

/**
 * Apply a goal to the heat streaks.
 *
 * "Consecutive" is per team: any other teammate scoring ends your run, so at most
 * one skater a side is ever lit. While `onFire` is true, `streakGoals` is the
 * countdown of remaining heat rather than a goal count — see the STATE FIELD
 * OVERLOADS note in sim/index.ts.
 */
function updateStreaks(ctx: SimContext, scorer: SkaterSimState | null, scoringSide: TeamSide): void {
  if (!ctx.config.onFireEnabled) return;

  for (const skater of ctx.state.skaters) {
    if (skater.side !== scoringSide) {
      // Conceding puts the fire out.
      skater.onFire = false;
      skater.streakGoals = 0;
    } else if (skater !== scorer) {
      skater.onFire = false;
      skater.streakGoals = 0;
    }
  }

  if (scorer === null) return;
  if (scorer.onFire) {
    scorer.streakGoals = ON_FIRE.durationTicks;
    return;
  }
  scorer.streakGoals++;
  if (scorer.streakGoals >= ON_FIRE.goalsRequired) {
    scorer.onFire = true;
    scorer.streakGoals = ON_FIRE.durationTicks;
    ctx.events.push({
      type: 'onFire',
      tick: ctx.state.tick,
      actorId: scorer.id,
      side: scorer.side,
    });
  }
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** Record a goal against `concedingSide` and set up whatever comes next. */
export function scoreGoal(ctx: SimContext, concedingSide: TeamSide): void {
  const { state } = ctx;
  const scoringSide = otherSide(concedingSide);

  const shooter = skaterById(state, state.puck.lastTouchedBy);
  const scorer = shooter !== null && shooter.side === scoringSide ? shooter : null;
  const assister = pendingAssist(ctx);

  state.score[scoringSide]++;
  if (scorer !== null) {
    state.stats[scorer.playerId].goals++;
    if (assister !== null && assister !== scorer && assister.side === scoringSide) {
      state.stats[assister.playerId].assists++;
    }
  }
  state.stats[goalieFor(state, concedingSide).playerId].goalsAgainst++;

  updateStreaks(ctx, scorer, scoringSide);
  clearPendingAssist(ctx);

  ctx.events.push({
    type: 'goal',
    tick: state.tick,
    actorId: scorer?.id,
    targetId: assister?.id,
    side: scoringSide,
    x: state.puck.x,
    y: state.puck.y,
  });

  // Sudden death: the first overtime goal ends it on the spot.
  if (state.phase === 'overtime') {
    finishMatch(ctx);
    return;
  }

  state.puck.carrierId = null;
  state.puck.vx = 0;
  state.puck.vy = 0;
  state.phase = 'goal';
  state.phaseTimer = MATCH.goalCelebrationTicks;
}

/**
 * A whistle that is not a goal — a goalie freeze. Straight to the next draw with
 * a shorter hold than a celebration, because nothing happened worth watching.
 */
export function stopPlay(ctx: SimContext): void {
  startFaceoff(ctx, true);
  ctx.state.phaseTimer = MATCH.whistleHoldTicks;
}

export function finishMatch(ctx: SimContext): void {
  ctx.state.phase = 'final';
  ctx.state.phaseTimer = 0;
  ctx.state.puck.carrierId = null;
  ctx.state.puck.vx = 0;
  ctx.state.puck.vy = 0;
  ctx.events.push({ type: 'matchEnd', tick: ctx.state.tick });
}

// ---------------------------------------------------------------------------
// Shootout
// ---------------------------------------------------------------------------

/** Which side shoots on a given attempt; home goes first, then they alternate. */
export function shootoutSide(round: number): TeamSide {
  return round % 2 === 0 ? 'home' : 'away';
}

function setUpShootoutAttempt(ctx: SimContext): void {
  const { state } = ctx;
  const side = shootoutSide(state.shootoutRound);
  const shooterSlot = Math.floor(state.shootoutRound / 2) % 3;
  const direction = attackDirection(side);

  for (const skater of state.skaters) {
    if (skater.side === side && skater.slot === shooterSlot) {
      skater.onIce = true;
      skater.x = -direction * 10;
      skater.y = 0;
      skater.vx = 0;
      skater.vy = 0;
      skater.facing = direction > 0 ? 0 : Math.PI;
      skater.stun = 0;
      skater.windup = 0;
      skater.actionCooldown = 0;
      skater.turbo = 1;
      state.puck.carrierId = skater.id;
      state.puck.lastTouchedBy = skater.id;
      state.puck.lastTouchSide = side;
      state.puck.x = skater.x;
      state.puck.y = skater.y;
      state.puck.vx = 0;
      state.puck.vy = 0;
      state.puck.pickupCooldown = 0;
    } else {
      parkOffIce(state, skater);
    }
  }

  resetGoalies(ctx);
  state.phaseTimer = MATCH.shootoutAttemptTicks;
}

export function enterShootout(ctx: SimContext): void {
  ctx.state.phase = 'shootout';
  ctx.state.shootoutRound = 0;
  ctx.state.shootoutScore.home = 0;
  ctx.state.shootoutScore.away = 0;
  setUpShootoutAttempt(ctx);
}

/**
 * Close out one shootout attempt and either set up the next one or end the match.
 * Attempts always come in pairs, so nobody wins on an uneven number of shots.
 */
export function endShootoutAttempt(ctx: SimContext, scored: boolean): void {
  const { state } = ctx;
  const side = shootoutSide(state.shootoutRound);
  if (scored) state.shootoutScore[side]++;

  state.shootoutRound++;

  const pairsComplete = state.shootoutRound % 2 === 0;
  const roundsTaken = state.shootoutRound / 2;
  if (
    pairsComplete &&
    roundsTaken >= MATCH.shootoutRounds &&
    state.shootoutScore.home !== state.shootoutScore.away
  ) {
    const winner: TeamSide = state.shootoutScore.home > state.shootoutScore.away ? 'home' : 'away';
    // The shootout winner takes the game by one, the way a real scoreline reads.
    state.score[winner]++;
    finishMatch(ctx);
    return;
  }

  setUpShootoutAttempt(ctx);
}

// ---------------------------------------------------------------------------
// Clock and phase flow
// ---------------------------------------------------------------------------

function endPeriod(ctx: SimContext): void {
  const { state, config } = ctx;
  ctx.events.push({ type: 'periodEnd', tick: state.tick });

  if (state.period < config.periods) {
    state.phase = 'intermission';
    state.phaseTimer = MATCH.intermissionTicks;
    return;
  }

  const tied = state.score.home === state.score.away;
  if (!tied) {
    finishMatch(ctx);
    return;
  }

  if (state.period === config.periods) {
    // Regulation ended level: go to sudden death.
    state.phase = 'intermission';
    state.phaseTimer = MATCH.intermissionTicks;
    return;
  }

  // Overtime expired and still level.
  enterShootout(ctx);
}

/**
 * Run the clock and the phase machine for one tick. Called after the physics, so
 * a goal scored this tick has already switched us into the celebration.
 */
export function advancePhase(ctx: SimContext): void {
  const { state, config } = ctx;

  switch (state.phase) {
    case 'warmup':
      state.phaseTimer--;
      if (state.phaseTimer <= 0) startFaceoff(ctx, false);
      return;

    case 'faceoff':
      state.phaseTimer--;
      if (state.phaseTimer <= 0) dropPuck(ctx);
      return;

    case 'goal':
      state.phaseTimer--;
      if (state.phaseTimer <= 0) startFaceoff(ctx, true);
      return;

    case 'intermission':
      state.phaseTimer--;
      if (state.phaseTimer <= 0) {
        state.period++;
        state.clock = periodLengthTicks(ctx, state.period);
        startFaceoff(ctx, true);
      }
      return;

    case 'play':
    case 'overtime':
      state.clock--;
      if (state.clock <= 0) {
        state.clock = 0;
        endPeriod(ctx);
      }
      return;

    case 'shootout':
      state.phaseTimer--;
      if (state.phaseTimer <= 0) endShootoutAttempt(ctx, false);
      return;

    case 'final':
      return;
  }
}

/** Puck is loose and effectively stopped — the shootout uses this to wave an attempt off. */
export function puckDead(state: GameSimState): boolean {
  if (state.puck.carrierId !== null) return false;
  const speed = Math.sqrt(state.puck.vx * state.puck.vx + state.puck.vy * state.puck.vy);
  return speed <= PUCK.restSpeed;
}
