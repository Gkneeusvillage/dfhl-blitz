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
 */

import { MATCH, TICK_RATE } from '../tuning.js';
import type {
  GameSimState,
  InputMap,
  MatchConfig,
  PlayerMatchStats,
  ResolvedTeam,
  SimEvent,
  SkaterSimState,
  TeamSide,
} from '../types.js';

/** Starting formation for a faceoff, in feet relative to the defending side's own end. */
const FACEOFF_FORMATION: Array<{ x: number; y: number }> = [
  { x: 8, y: 0 }, // center, at the dot
  { x: 20, y: -14 }, // winger
  { x: 30, y: 10 }, // defense
];

function emptyStats(): PlayerMatchStats {
  return { goals: 0, assists: 0, shots: 0, hits: 0, saves: 0, goalsAgainst: 0 };
}

function buildSkaters(team: ResolvedTeam, side: TeamSide): SkaterSimState[] {
  const direction = side === 'home' ? 1 : -1;
  return team.skaters.map((skater, slot) => {
    const formation = FACEOFF_FORMATION[slot % 3];
    return {
      id: `${side}-${slot}`,
      side,
      slot,
      playerId: skater.playerId,
      onIce: slot < 3,
      x: -direction * (formation.x + (slot >= 3 ? 26 : 0)),
      y: formation.y,
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
 * Pair B owns refining the faceoff formation and any additional state fields;
 * the contract that must hold is that the returned object is fully serializable
 * and contains every input to the simulation.
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
        x: -(89 - 2),
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
        x: 89 - 2,
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

/**
 * Advance the match by exactly one tick.
 *
 * @returns presentation-only events produced this tick (sounds, VFX). Events are
 *          never read back by the simulation and may be discarded safely.
 *
 * IMPLEMENTED BY: pair B (Core Gameplay Sim).
 */
export function stepMatch(
  _state: GameSimState,
  _inputs: InputMap,
  _config: MatchConfig,
): SimEvent[] {
  throw new Error('stepMatch is not implemented yet — pair B (Core Gameplay Sim) owns this.');
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
