/**
 * The authoritative simulation.
 *
 * THE CENTRAL ARCHITECTURAL RULE OF THIS PROJECT:
 * all gameplay state changes happen inside `stepMatch`. The server runs it to
 * produce authority; the client runs the identical code to predict. Therefore
 * `stepMatch` must be a pure function of (state, inputs, config):
 *
 *   - no Math.random()  -> use the Rng cursor over `state.rng`
 *   - no Date.now()     -> use `state.tick`
 *   - no I/O, no logging, no reads of anything outside its arguments
 *
 * Violating this causes desyncs that are extremely painful to debug.
 *
 * ---------------------------------------------------------------------------
 * STATE FIELD OVERLOADS
 *
 * types.ts is a frozen contract shared with the server, the client and the
 * roster pipeline, so the sim cannot add fields to GameSimState. Three counters
 * the gameplay needs therefore live in fields that are provably dead in the
 * regime where they are reused. Each is discriminated by a value already in the
 * state, so there is never a moment when both meanings are live at once:
 *
 *   puck.pickupCooldown   while puck.carrierId !== null
 *                         -> ticks left in the one-timer window.
 *                            Nothing can pick up a carried puck, so the cooldown
 *                            has no other meaning while somebody has it.
 *
 *   skater.streakGoals    while skater.onFire === true
 *                         -> ticks of heat remaining.
 *                            The goal count only matters up to the moment it
 *                            crosses ON_FIRE.goalsRequired and lights the skater.
 *
 *   state.shootoutRound   while state.phase !== 'shootout'
 *                         -> index+1 of the skater who fed the current carrier,
 *                            so a goal can be credited back to the passer.
 *                            types.ts documents this field as unused outside the
 *                            shootout, and entering the shootout zeroes it.
 *
 * If types.ts is ever unfrozen, promote these to real fields (`oneTimerTicks`,
 * `onFireTicks`, `assistCandidate`) and delete this note.
 */

import { MATCH, SKATER, TICK_RATE } from '../tuning.js';
import { Rng } from '../rng.js';
import type {
  GameSimState,
  InputMap,
  MatchConfig,
  PlayerInput,
  PlayerMatchStats,
  ResolvedTeam,
  SimEvent,
  SkaterSimState,
  TeamSide,
} from '../types.js';
import { FACEOFF, GOALIE, RINK } from '../tuning.js';
import { attackDirection, clamp } from '../rink.js';
import type { SimContext } from './context.js';
import { isLive, puckCarrier } from './context.js';
import { aiInput, shootoutInput } from './ai.js';
import { assignControl, humanInputFor } from './control.js';
import { attachPuckToCarrier, resolvePickups, resolveSkaterActions } from './actions.js';
import { updateGoalie } from './goalie.js';
import { applyFriction, confineSkater, separateCircles } from './physics.js';
import { checkCarriedGoal, stepLoosePuck } from './puck.js';
import {
  advancePhase,
  endShootoutAttempt,
  puckDead,
  scoreGoal,
  stopPlay,
} from './rules.js';
import { driveSkater, moveSkater, tickSkaterTimers } from './skater.js';

/** Starting formation for a faceoff, in feet relative to the defending side's own end. */
const FACEOFF_FORMATION = FACEOFF.formation;

function emptyStats(): PlayerMatchStats {
  return { goals: 0, assists: 0, shots: 0, hits: 0, saves: 0, goalsAgainst: 0 };
}

function buildSkaters(team: ResolvedTeam, side: TeamSide): SkaterSimState[] {
  const direction = attackDirection(side);
  return team.skaters.map((skater, slot) => {
    const formation = FACEOFF_FORMATION[slot % 3];
    const onIce = slot < 3;
    return {
      id: `${side}-${slot}`,
      side,
      slot,
      playerId: skater.playerId,
      onIce,
      x: onIce
        ? -direction * formation.x
        : clamp((slot - 2.5) * FACEOFF.benchSpacingX, -RINK.halfLength + 20, RINK.halfLength - 20),
      y: onIce ? formation.y : side === 'home' ? FACEOFF.benchY : -FACEOFF.benchY,
      vx: 0,
      vy: 0,
      facing: direction > 0 ? 0 : Math.PI,
      turbo: 1,
      stun: 0,
      actionCooldown: 0,
      windup: 0,
      controlledBy: null,
      onFire: false,
      streakGoals: 0,
    };
  });
}

/**
 * Build the opening state for a match.
 *
 * The returned object is fully serializable and contains every input to the
 * simulation — nothing outside it may influence a tick.
 */
export function createMatch(config: MatchConfig): GameSimState {
  const stats: Record<string, PlayerMatchStats> = {};
  for (const team of [config.home, config.away]) {
    stats[team.goalie.playerId] = emptyStats();
    for (const skater of team.skaters) stats[skater.playerId] = emptyStats();
  }

  return {
    tick: 0,
    phase: 'warmup',
    phaseTimer: MATCH.faceoffHoldTicks,
    period: 1,
    clock: config.periodSeconds * TICK_RATE,
    score: { home: 0, away: 0 },
    activeLine: { home: 0, away: 0 },
    skaters: [...buildSkaters(config.home, 'home'), ...buildSkaters(config.away, 'away')],
    goalies: [
      {
        id: 'home-g',
        side: 'home',
        playerId: config.home.goalie.playerId,
        x: -RINK.goalLineX + GOALIE.restDepth,
        y: 0,
        vx: 0,
        vy: 0,
        facing: 0,
        lunge: 0,
        lungeCooldown: 0,
      },
      {
        id: 'away-g',
        side: 'away',
        playerId: config.away.goalie.playerId,
        x: RINK.goalLineX - GOALIE.restDepth,
        y: 0,
        vx: 0,
        vy: 0,
        facing: Math.PI,
        lunge: 0,
        lungeCooldown: 0,
      },
    ],
    puck: {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      carrierId: null,
      lastTouchedBy: null,
      lastTouchSide: null,
      pickupCooldown: 0,
    },
    seats: [],
    rng: config.seed >>> 0,
    stats,
    shootoutRound: 0,
    shootoutScore: { home: 0, away: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * The input a skater acts on: their seat's if they have one, otherwise the AI's.
 *
 * Decided exactly once per skater per tick and cached — `aiInput` draws from the
 * rng, so calling it twice would both burn the stream and let the skater shoot
 * on one call and skate somewhere else on the other.
 */
function decideInputs(ctx: SimContext): Array<PlayerInput | null> {
  return ctx.state.skaters.map((skater) => {
    if (!skater.onIce) return null;
    const human = humanInputFor(ctx, skater);
    if (human !== null) return human;
    if (ctx.state.phase === 'shootout') return shootoutInput(ctx, skater);
    return aiInput(ctx, skater);
  });
}

/** Move every on-ice skater, then push everyone apart and back onto the ice. */
function moveSkaters(ctx: SimContext): void {
  const { state } = ctx;
  for (const skater of state.skaters) {
    if (!skater.onIce) continue;
    moveSkater(skater);
  }

  // Pairwise separation. Twelve skaters means 15 on-ice pairs at most — a grid
  // would cost more than it saves and would add a source of ordering subtlety.
  for (let i = 0; i < state.skaters.length; i++) {
    const a = state.skaters[i];
    if (!a.onIce) continue;
    for (let j = i + 1; j < state.skaters.length; j++) {
      const b = state.skaters[j];
      if (!b.onIce) continue;
      separateCircles(a, b, SKATER.radius, SKATER.radius, SKATER.bumpRestitution);
    }
  }

  for (const skater of state.skaters) {
    if (!skater.onIce) continue;
    // Goalies are immovable objects: a skater bounces off, the goalie does not budge.
    for (const goalie of state.goalies) {
      separateCircles(skater, goalie, SKATER.radius, GOALIE.radius, 0, 1, 0);
    }
    confineSkater(skater, SKATER.radius);
  }
}

/** Non-live phases: nothing moves, momentum bleeds off, timers run. */
function stepHold(ctx: SimContext): void {
  for (const skater of ctx.state.skaters) {
    applyFriction(skater, SKATER.friction);
    if (skater.actionCooldown > 0) skater.actionCooldown--;
    if (skater.stun > 0) skater.stun--;
  }
}

/** Turn a puck outcome into the matching rule. Returns true if play stopped. */
function applyPuckOutcome(ctx: SimContext, conceding: TeamSide | null, froze: boolean): boolean {
  const { state } = ctx;
  if (conceding !== null) {
    if (state.phase === 'shootout') {
      endShootoutAttempt(ctx, true);
    } else {
      scoreGoal(ctx, conceding);
    }
    return true;
  }
  if (froze) {
    if (state.phase === 'shootout') {
      endShootoutAttempt(ctx, false);
    } else {
      stopPlay(ctx);
    }
    return true;
  }
  return false;
}

function stepLive(ctx: SimContext): void {
  const { state } = ctx;

  for (const skater of state.skaters) {
    if (!skater.onIce) continue;
    tickSkaterTimers(ctx, skater);
  }

  const decided = decideInputs(ctx);

  // Actions read positions from the start of the tick, so a check lands where the
  // players actually were when the button went down.
  for (let i = 0; i < state.skaters.length; i++) {
    const input = decided[i];
    if (input === null) continue;
    resolveSkaterActions(ctx, state.skaters[i], input);
  }

  for (let i = 0; i < state.skaters.length; i++) {
    const input = decided[i];
    if (input === null) continue;
    driveSkater(ctx, state.skaters[i], input);
  }
  moveSkaters(ctx);

  for (const goalie of state.goalies) updateGoalie(ctx, goalie);

  const previousX = state.puck.x;
  const previousY = state.puck.y;

  if (state.puck.carrierId !== null) {
    attachPuckToCarrier(ctx);
    const conceded = checkCarriedGoal(state, previousX, previousY);
    if (applyPuckOutcome(ctx, conceded, false)) return;
  } else {
    const outcome = stepLoosePuck(ctx);
    if (
      applyPuckOutcome(
        ctx,
        outcome.kind === 'goal' ? outcome.conceding : null,
        outcome.kind === 'freeze',
      )
    ) {
      return;
    }
    resolvePickups(ctx, previousX, previousY, state.puck.x, state.puck.y);

    // A shootout attempt is over the moment the chance is gone.
    if (state.phase === 'shootout' && shootoutAttemptDead(ctx, outcome.kind === 'save')) {
      endShootoutAttempt(ctx, false);
    }
  }
}

/**
 * A shootout attempt dies on a save, on the puck stopping, or on the shooter
 * losing it behind the goal line. Without this the attempt only ends on its
 * timer and every miss costs nine seconds of dead air.
 */
function shootoutAttemptDead(ctx: SimContext, saved: boolean): boolean {
  if (saved) return true;
  const { state } = ctx;
  if (puckDead(state)) return true;
  const shooter = puckCarrier(state);
  if (shooter !== null) return false;
  const attacking = state.puck.lastTouchSide;
  if (attacking === null) return false;
  const goalX = attackDirection(attacking) > 0 ? RINK.goalLineX : -RINK.goalLineX;
  return attackDirection(attacking) > 0 ? state.puck.x > goalX : state.puck.x < goalX;
}

/**
 * Advance the match by exactly one tick.
 *
 * @returns presentation-only events produced this tick (sounds, VFX). Events are
 *          never read back by the simulation and may be discarded safely.
 */
export function stepMatch(
  state: GameSimState,
  inputs: InputMap,
  config: MatchConfig,
): SimEvent[] {
  const events: SimEvent[] = [];
  state.tick++;
  if (state.phase === 'final') return events;

  const rng = new Rng(state.rng);
  const ctx: SimContext = { state, config, inputs, rng, events };

  assignControl(ctx);

  if (isLive(state)) {
    stepLive(ctx);
  } else {
    stepHold(ctx);
  }

  advancePhase(ctx);

  state.rng = rng.state;
  return events;
}

/**
 * Deep copy of the match state.
 *
 * Used by the client for prediction rollback and by tests for replay
 * verification, so it must copy every mutable field. Structured-clone-free and
 * allocation-conscious: this runs up to 30 times per frame during reconciliation.
 */
export function cloneState(state: GameSimState): GameSimState {
  return {
    tick: state.tick,
    phase: state.phase,
    phaseTimer: state.phaseTimer,
    period: state.period,
    clock: state.clock,
    score: { home: state.score.home, away: state.score.away },
    activeLine: { home: state.activeLine.home, away: state.activeLine.away },
    skaters: state.skaters.map((s) => ({ ...s })),
    goalies: state.goalies.map((g) => ({ ...g })),
    puck: { ...state.puck },
    seats: state.seats.map((s) => ({ ...s })),
    rng: state.rng,
    stats: Object.fromEntries(Object.entries(state.stats).map(([k, v]) => [k, { ...v }])),
    shootoutRound: state.shootoutRound,
    shootoutScore: { home: state.shootoutScore.home, away: state.shootoutScore.away },
  };
}

/** Convenience lookup used across sim, server, and client. */
export function findSkater(state: GameSimState, id: string): SkaterSimState | undefined {
  return state.skaters.find((s) => s.id === id);
}

/** The three skaters currently on the ice for a side. */
export function skatersOnIce(state: GameSimState, side: TeamSide): SkaterSimState[] {
  return state.skaters.filter((s) => s.side === side && s.onIce);
}

/**
 * Re-exported so the server and client can reason about the sim without reaching
 * into sim/* internals. Names are unique against types.ts, which shared/src/index.ts
 * also star-exports.
 */
export { isLive, puckCarrier, skaterById, goalieFor } from './context.js';
export { oneTimerTicks } from './actions.js';
export type { SimContext } from './context.js';
