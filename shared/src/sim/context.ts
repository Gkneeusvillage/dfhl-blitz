/**
 * The per-tick working set handed to every simulation module.
 *
 * Everything a module is allowed to read lives here. Nothing in `shared/src/sim`
 * may reach outside this object for state — that is what keeps `stepMatch` pure
 * and therefore identical on the server and on every client.
 */

import type { Rng } from '../rng.js';
import type {
  GameSimState,
  GoalieAttributes,
  GoalieSimState,
  InputMap,
  MatchConfig,
  ResolvedTeam,
  SimEvent,
  SkaterAttributes,
  SkaterSimState,
  TeamSide,
} from '../types.js';

export interface SimContext {
  state: GameSimState;
  config: MatchConfig;
  inputs: InputMap;
  /** The single deterministic stream. Written back to state.rng at the end of the tick. */
  rng: Rng;
  /** Presentation-only output. Never read back by the simulation. */
  events: SimEvent[];
}

export function teamOf(config: MatchConfig, side: TeamSide): ResolvedTeam {
  return side === 'home' ? config.home : config.away;
}

/** Attribute lookup by slot — no searching, because this runs 12 times a tick. */
export function skaterAttrs(config: MatchConfig, skater: SkaterSimState): SkaterAttributes {
  return teamOf(config, skater.side).skaters[skater.slot].attributes;
}

export function goalieAttrs(config: MatchConfig, goalie: GoalieSimState): GoalieAttributes {
  return teamOf(config, goalie.side).goalie.attributes;
}

/** Goalies are always stored home-first, so this stays an index rather than a search. */
export function goalieFor(state: GameSimState, side: TeamSide): GoalieSimState {
  return side === 'home' ? state.goalies[0] : state.goalies[1];
}

export function skaterById(state: GameSimState, id: string | null): SkaterSimState | null {
  if (id === null) return null;
  for (const skater of state.skaters) if (skater.id === id) return skater;
  return null;
}

/** The skater carrying the puck, or null when it is loose or a goalie has it. */
export function puckCarrier(state: GameSimState): SkaterSimState | null {
  return skaterById(state, state.puck.carrierId);
}

/** Phases in which the puck is live and the full simulation runs. */
export function isLive(state: GameSimState): boolean {
  return state.phase === 'play' || state.phase === 'overtime' || state.phase === 'shootout';
}

export function emitEvent(ctx: SimContext, event: SimEvent): void {
  ctx.events.push(event);
}
