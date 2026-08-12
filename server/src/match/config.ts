/**
 * Turning lobby choices into the `MatchConfig` the simulation runs on.
 *
 * The rosters are read once from `@dfhl/shared/rosters.json` — the 691 real
 * DFHL players — and every match is built with `resolveTeam` / `buildDefaultLineup`
 * out of `shared/src/lineup.ts`. None of that logic is reimplemented here: the
 * server and the client both have to agree on what "TSP's first line" means, and
 * the only way to guarantee that is for both to call the same function.
 *
 * A lineup is the one structured object a client is allowed to send, so it gets
 * rebuilt field by field before it is trusted (`sanitizeLineup`), then validated
 * against the real roster, and then validated *again* at the moment it would
 * reach the simulation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEAM_CODES,
  buildDefaultLineup,
  isTeamCode,
  resolveTeam,
  validateLineup,
} from '@dfhl/shared';
import type {
  LineUnit,
  Lineup,
  MatchConfig,
  ResolvedTeam,
  RosterPlayer,
  RostersFile,
  TeamCode,
  TeamConfig,
  TeamsConfigFile,
} from '@dfhl/shared';

import type { LobbySettings } from '../rooms/lobby.js';

const requireFromHere = createRequire(import.meta.url);

/**
 * Find a generated data file.
 *
 * The package export is the right answer and the one that works under `tsx` and
 * in the bundled `server/dist`. The walk-up is a fallback for a layout where
 * node_modules is not where the resolver expects — a deployment failing at the
 * first match rather than at boot is a worse way to find that out.
 */
function locateDataFile(fileName: string): string {
  try {
    return requireFromHere.resolve(`@dfhl/shared/${fileName}`);
  } catch {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(dir, 'shared', 'data', fileName);
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(
      `Cannot locate shared/data/${fileName}. Run "npm run build:rosters" and try again.`,
    );
  }
}

function readJson<T>(fileName: string): T {
  return JSON.parse(readFileSync(locateDataFile(fileName), 'utf8')) as T;
}

// Read on first use rather than at import: a unit test that never builds a match
// should not need the generated data to exist.
let rostersCache: RostersFile | null = null;
let teamsCache: TeamsConfigFile | null = null;

export function loadRosters(): RostersFile {
  if (rostersCache === null) rostersCache = readJson<RostersFile>('rosters.json');
  return rostersCache;
}

export function loadTeamsConfig(): TeamsConfigFile {
  if (teamsCache === null) teamsCache = readJson<TeamsConfigFile>('teams.config.json');
  return teamsCache;
}

export function rosterFor(teamCode: TeamCode): RosterPlayer[] {
  const roster = loadRosters().teams[teamCode];
  if (roster === undefined || roster.length === 0) {
    throw new Error(`rosters.json has no players for ${teamCode}`);
  }
  return roster;
}

export function teamConfigFor(teamCode: TeamCode): TeamConfig {
  const config = loadTeamsConfig().teams[teamCode];
  if (config === undefined) throw new Error(`teams.config.json has no entry for ${teamCode}`);
  return config;
}

/**
 * Rebuild a `Lineup` from an untrusted payload, or null if the shape is wrong.
 *
 * Structure only — whether these ids are real players on the right roster is
 * `validateLineup`'s job, and it needs the roster to answer.
 */
export function sanitizeLineup(raw: unknown): Lineup | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;

  const teamCode = source.teamCode;
  if (typeof teamCode !== 'string' || !isTeamCode(teamCode)) return null;

  const goalieId = source.goalieId;
  if (typeof goalieId !== 'string' || goalieId.length === 0) return null;

  const lines = source.lines;
  if (!Array.isArray(lines) || lines.length !== 2) return null;

  const units: LineUnit[] = [];
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return null;
    const ids = (line as { skaterIds?: unknown }).skaterIds;
    if (!Array.isArray(ids) || ids.length !== 3) return null;
    if (!ids.every((id) => typeof id === 'string' && id.length > 0)) return null;
    units.push({ skaterIds: [ids[0] as string, ids[1] as string, ids[2] as string] });
  }

  return { teamCode, goalieId, lines: [units[0], units[1]] };
}

/** Human-readable problems with a lineup against its own franchise's real roster. */
export function lineupProblems(lineup: Lineup): string[] {
  return validateLineup(rosterFor(lineup.teamCode), lineup);
}

/**
 * Two different franchises for a room where nobody picked one.
 *
 * Derived from the match seed so it is reproducible from the room code, and
 * forced apart so a default match is never Detroit against Detroit — with
 * jersey tinting driven by team colours, that is unplayable rather than merely
 * odd.
 */
export function defaultTeamCodes(seed: number): { home: TeamCode; away: TeamCode } {
  const count = TEAM_CODES.length;
  const homeIndex = seed % count;
  // +1 then an offset over the remaining 13: cannot land back on home.
  const awayIndex = (homeIndex + 1 + ((seed >>> 8) % (count - 1))) % count;
  return { home: TEAM_CODES[homeIndex], away: TEAM_CODES[awayIndex] };
}

export interface SideSetup {
  teamCode: TeamCode;
  /** The player's override, or null to auto-build from the roster. */
  lineup: Lineup | null;
}

function resolveSide(side: SideSetup): ResolvedTeam {
  const roster = rosterFor(side.teamCode);
  const config = teamConfigFor(side.teamCode);

  // Re-validated here even though `SelectLineup` already refused a bad one.
  // This is the last point before untrusted data becomes simulation input, and
  // the cost of the check is a few hundred microseconds once per match.
  const chosen = side.lineup;
  if (chosen !== null && chosen.teamCode === side.teamCode && validateLineup(roster, chosen).length === 0) {
    return resolveTeam(roster, chosen, config);
  }
  return resolveTeam(roster, buildDefaultLineup(roster), config);
}

export function buildMatchConfig(
  seed: number,
  settings: LobbySettings,
  home: SideSetup,
  away: SideSetup,
): MatchConfig {
  return {
    seed,
    periods: settings.periods,
    periodSeconds: settings.periodSeconds,
    onFireEnabled: settings.onFireEnabled,
    home: resolveSide(home),
    away: resolveSide(away),
  };
}
