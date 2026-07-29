/**
 * Test-only match fixtures.
 *
 * Deliberately fabricates ResolvedTeam objects rather than reading
 * shared/data/rosters.json: the simulation's tests must not depend on the roster
 * pipeline, or a change to the CSV becomes a sim test failure.
 *
 * Not exported from shared/src/index.ts — nothing outside the sim's own tests
 * should reach for this.
 */

import { TEAM_CODES } from '../types.js';
import type {
  MatchConfig,
  ResolvedGoalie,
  ResolvedSkater,
  ResolvedTeam,
  TeamCode,
  TeamConfig,
} from '../types.js';

export interface TestTeamSpec {
  code?: TeamCode;
  /** Every skater and goalie attribute is set to this 0-99 value. */
  skill?: number;
  /** Overrides `skill` for the goalie only. */
  goalieSkill?: number;
}

export interface TestMatchSpec {
  seed?: number;
  periods?: number;
  periodSeconds?: number;
  onFireEnabled?: boolean;
  home?: TestTeamSpec;
  away?: TestTeamSpec;
}

function teamConfig(code: TeamCode): TeamConfig {
  return {
    code,
    displayName: `${code} Test Club`,
    abbreviation: code.slice(0, 3).toUpperCase(),
    primaryColor: '#123456',
    secondaryColor: '#abcdef',
  };
}

function skaters(code: TeamCode, skill: number): ResolvedSkater[] {
  const result: ResolvedSkater[] = [];
  for (let slot = 0; slot < 6; slot++) {
    // [F, F, D] per line, matching the Lineup contract.
    const skaterRole = slot % 3 === 2 ? 'D' : 'F';
    result.push({
      playerId: `${code}-s${slot}`,
      name: `${code} Skater ${slot}`,
      skaterRole,
      attributes: {
        skating: skill,
        shooting: skill,
        passing: skill,
        checking: skill,
        defense: skill,
      },
    });
  }
  return result;
}

function goalie(code: TeamCode, skill: number): ResolvedGoalie {
  return {
    playerId: `${code}-g`,
    name: `${code} Goalie`,
    attributes: { reflexes: skill, positioning: skill, reboundControl: skill },
  };
}

export function makeTestTeam(spec: TestTeamSpec, fallbackCode: TeamCode): ResolvedTeam {
  const code = spec.code ?? fallbackCode;
  const skill = spec.skill ?? 65;
  return {
    code,
    config: teamConfig(code),
    goalie: goalie(code, spec.goalieSkill ?? skill),
    skaters: skaters(code, skill),
  };
}

/**
 * A fully resolved MatchConfig with flat attributes, so any behavioural
 * difference between two runs is attributable to the one thing under test.
 */
export function makeTestMatchConfig(spec: TestMatchSpec = {}): MatchConfig {
  return {
    seed: spec.seed ?? 0x5eed1234,
    periods: spec.periods ?? 3,
    periodSeconds: spec.periodSeconds ?? 180,
    onFireEnabled: spec.onFireEnabled ?? true,
    home: makeTestTeam(spec.home ?? {}, TEAM_CODES[0]),
    away: makeTestTeam(spec.away ?? {}, TEAM_CODES[1]),
  };
}
