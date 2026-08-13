/**
 * The league's real rosters, in the browser.
 *
 * 691 NHL players across the 14 DFHL franchises — the file the roster pipeline
 * produces, imported through the `@dfhl/shared` package export so the client and
 * the server read the same one artefact. It is ~340 KB of JSON in the bundle,
 * which is a lot for a menu and exactly the point of the menu: seeing McDavid on
 * your first line is the reason anybody opens this.
 *
 * -----------------------------------------------------------------------------
 * WHY THE UI BUILDS LINEUPS WITH THE SHARED OPTIMIZER
 *
 * `buildDefaultLineup` is what the server uses when a player does not override
 * his lines, so the lineup previewed under a franchise here is byte for byte the
 * one that would take the ice. A team-select screen that ranked players its own
 * way would be showing a team the player is not about to get.
 */

import rostersFile from '@dfhl/shared/rosters.json';
import { buildDefaultLineup, compareStrength, isEligibleAt } from '@dfhl/shared';
import type {
  Lineup,
  RosterPlayer,
  RostersFile,
  SkaterRole,
  TeamCode,
} from '@dfhl/shared';

const file = rostersFile as RostersFile;

export function rosterFor(code: TeamCode): RosterPlayer[] {
  return file.teams[code] ?? [];
}

export function playerCount(): number {
  return file.playerCount;
}

/** Every player on a roster, by id, for turning a lineup back into names. */
export function indexRoster(roster: RosterPlayer[]): Map<string, RosterPlayer> {
  const byId = new Map<string, RosterPlayer>();
  for (const player of roster) byId.set(player.id, player);
  return byId;
}

/**
 * Everyone who could legally take a slot of this kind, strongest first.
 *
 * Deliberately the whole roster rather than `dressedRoster`'s top-6 / top-4
 * depth. The depth is the right *default*, and the line picker marks it — but a
 * league-mate who wants his own guy on the second line is the entire reason the
 * picker exists, and `validateLineup` is what keeps the result legal.
 */
export function candidatesFor(roster: RosterPlayer[], role: SkaterRole): RosterPlayer[] {
  return roster.filter((player) => isEligibleAt(player, role)).sort(compareStrength);
}

export function goaliesFor(roster: RosterPlayer[]): RosterPlayer[] {
  return roster.filter((player) => player.role === 'goalie').sort(compareStrength);
}

/** What a franchise looks like at a glance, for the team list. */
export interface TeamSummary {
  readonly code: TeamCode;
  readonly lineup: Lineup;
  /** Mean `overall` of the six skaters who would dress. */
  readonly starterRating: number;
  /** The best player on the roster, which is the one a player actually recognises. */
  readonly star: RosterPlayer;
  readonly goalie: RosterPlayer;
  readonly rosterSize: number;
}

const summaries = new Map<TeamCode, TeamSummary>();

/**
 * Summaries are cached: the team list recomputes on every focus change, and
 * `buildDefaultLineup` sorts a 50-player roster each time it is asked.
 */
export function summaryFor(code: TeamCode): TeamSummary | null {
  const cached = summaries.get(code);
  if (cached !== undefined) return cached;

  const roster = rosterFor(code);
  if (roster.length === 0) return null;

  let lineup: Lineup;
  try {
    lineup = buildDefaultLineup(roster);
  } catch {
    // A franchise too thin to dress a legal lineup is a data problem, not a
    // reason for the team list to fail to render.
    return null;
  }

  const byId = indexRoster(roster);
  const starters = lineup.lines
    .flatMap((line) => line.skaterIds)
    .map((id) => byId.get(id))
    .filter((player): player is RosterPlayer => player !== undefined);

  const goalie = byId.get(lineup.goalieId);
  const star = [...roster].sort(compareStrength)[0];
  if (goalie === undefined || star === undefined) return null;

  const summary: TeamSummary = {
    code,
    lineup,
    starterRating:
      starters.length === 0
        ? 0
        : Math.round(starters.reduce((total, player) => total + player.overall, 0) / starters.length),
    star,
    goalie,
    rosterSize: roster.length,
  };
  summaries.set(code, summary);
  return summary;
}

/** "C, LW" — the positions as the league's own export lists them. */
export function positionLabel(player: RosterPlayer): string {
  return player.positions.join('/');
}

/** Surname only, for a label that has to fit under a skater. */
export function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}
