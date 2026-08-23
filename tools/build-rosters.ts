/**
 * Roster pipeline: data/fantrax-rosters.csv  ->  shared/data/rosters.json
 *
 * Re-runnable and deterministic. The same CSV always produces byte-identical
 * player records, so a rebuild never churns the committed JSON and diffs stay
 * readable; only the top-level `generatedAt` moves between runs.
 *
 * Refreshing league data is deliberately a one-step operation: drop a new
 * Fantrax export at data/fantrax-rosters.csv and run `npm run build:rosters`.
 *
 * Nothing here imports from the @dfhl/shared barrel — the tool needs the domain
 * types and the RNG, not the simulation, and pulling the barrel would make a
 * data build depend on gameplay code.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'csv-parse/sync';

import { TEAM_CODES, isTeamCode } from '../shared/src/types.js';
import type {
  GoalieAttributes,
  NhlPosition,
  RosterPlayer,
  RostersFile,
  SkaterAttributes,
  TeamCode,
  TeamsConfigFile,
} from '../shared/src/types.js';
import { Rng, seedFromString } from '../shared/src/rng.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Relative form is what gets recorded in the output, so provenance is machine-independent. */
export const CSV_RELATIVE_PATH = 'data/fantrax-rosters.csv';
export const CSV_PATH = resolve(REPO_ROOT, CSV_RELATIVE_PATH);
export const OUTPUT_PATH = resolve(REPO_ROOT, 'shared/data/rosters.json');
export const TEAMS_CONFIG_PATH = resolve(REPO_ROOT, 'shared/data/teams.config.json');

// ---------------------------------------------------------------------------
// Ratings derivation
// ---------------------------------------------------------------------------

/**
 * These constants stay here rather than in shared/src/tuning.ts on purpose:
 * nothing at runtime reads them. They shape the data once, at build time, and
 * the simulation only ever sees the resulting 0-99 attributes. Moving them into
 * the sim's tuning file would imply a rebuild is needed to retune gameplay.
 */
export const RATINGS = {
  /** Everyone is playable: the worst prospect in the league still rates 40. */
  floor: 40,
  /**
   * Reach of the curve above the floor. Deliberately short of the 99 ceiling.
   *
   * Position weighting and jitter are applied *above* the curve, so a curve that
   * peaked at the ceiling would have nowhere to put them: the elite tier flattened
   * into a wall of 99s and McDavid came out rated maximum defensively. Stopping at
   * 96 leaves room for a profile to exist at the top, which is the one place the
   * differences are supposed to be most visible.
   */
  span: 56,
  /**
   * Sub-linear exponent. Fantrax scores bunch up in the 20s-40s, so a straight
   * line would leave two thirds of the league indistinguishable just above the
   * floor. Pulling the curve up lifts that mass into usable territory while
   * barely touching the 95+ tier, which is what keeps stars feeling elite.
   */
  exponent: 0.85,
  /** Per-attribute spread in rating points, so equal-Score players are not clones. */
  jitter: 4,
  attributeMin: 0,
  attributeMax: 99,
} as const;

/** Skater positions, i.e. every NhlPosition except 'G'. */
type SkaterPosition = Exclude<NhlPosition, 'G'>;

/**
 * Position weighting, in rating points applied to `overall` before jitter.
 *
 * The shape matters more than the magnitudes. In a 3-on-3 game the single
 * defenseman on each line is the only thing standing between the puck and the
 * goalie, so the profile has to be tilted far enough to be felt through the
 * sim's lerpAttr ranges — roughly 7 points is a visible step. Each row sums to
 * about zero, so weighting redistributes ability instead of inflating it.
 *
 * Exported only so the suite can pin the shipped data's league-wide profile
 * against the table it was built from; nothing at runtime reads it.
 */
export const SKATER_WEIGHTS: Record<SkaterPosition, SkaterAttributes> = {
  D: { skating: -1, shooting: -8, passing: 0, checking: 6, defense: 8 },
  C: { skating: 0, shooting: 0, passing: 7, checking: -1, defense: 1 },
  LW: { skating: 2, shooting: 7, passing: 0, checking: 1, defense: -6 },
  RW: { skating: 2, shooting: 7, passing: 0, checking: 1, defense: -6 },
};

/**
 * Goalies get almost no profile tilt — there is only one goalie position — but
 * rebound control is held back deliberately. Rebounds are what keep even a
 * 99-rated goalie beatable in a 3-on-3 scramble.
 */
export const GOALIE_WEIGHTS: GoalieAttributes = { reflexes: 1, positioning: 1, reboundControl: -3 };

/** Top of the curve. Everything above this belongs to the profile, not the curve. */
const CURVE_PEAK = RATINGS.floor + RATINGS.span;

/**
 * Fold a rating that has been pushed above the curve into the headroom left
 * between the curve's peak and the ceiling, rather than cutting it off there.
 *
 * Clamping did not merely cap a number, it collapsed the *differences* between
 * one player's attributes: McDavid came out 99 checking and 99 defense, a centre
 * rated maximum defensively, exactly where the profile is supposed to read
 * loudest. This maps [peak, infinity) onto [peak, 99) smoothly and monotonically,
 * so a +8 stays ahead of a +6 no matter how elite the player is, and nothing
 * below the peak is touched at all.
 *
 * Deliberately algebraic rather than exponential: the committed JSON has to be
 * byte-identical on every machine, and this is plain IEEE-754 arithmetic.
 */
function foldAboveCurve(value: number): number {
  if (value <= CURVE_PEAK) return value;
  const headroom = RATINGS.attributeMax - CURVE_PEAK;
  const excess = value - CURVE_PEAK;
  return CURVE_PEAK + (headroom * excess) / (excess + headroom);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** The base curve every rating is built from. Score 0 lands exactly on the floor. */
export function overallFromScore(score: number): number {
  const t = clamp(score, 0, 100) / 100;
  return Math.round(RATINGS.floor + Math.pow(t, RATINGS.exponent) * RATINGS.span);
}

/**
 * Deterministic per-attribute offset in [-jitter, +jitter].
 *
 * Seeding from `id:attribute` rather than drawing successive values from one
 * per-player stream means adding an attribute later cannot shift the values of
 * the attributes that already exist — the committed JSON stays stable.
 */
function jitterFor(playerId: string, attribute: string): number {
  const rng = new Rng(seedFromString(`${playerId}:${attribute}`));
  return Math.round(rng.range(-RATINGS.jitter, RATINGS.jitter));
}

function ratingFor(playerId: string, attribute: string, overall: number, weight: number): number {
  const weighted = overall + weight + jitterFor(playerId, attribute);
  // The fold already keeps this under the ceiling; the clamp guards the floor
  // and any future weight table wide enough to reach past it.
  return clamp(Math.round(foldAboveCurve(weighted)), RATINGS.attributeMin, RATINGS.attributeMax);
}

function skaterAttributes(
  playerId: string,
  overall: number,
  position: SkaterPosition,
): SkaterAttributes {
  const w = SKATER_WEIGHTS[position];
  return {
    skating: ratingFor(playerId, 'skating', overall, w.skating),
    shooting: ratingFor(playerId, 'shooting', overall, w.shooting),
    passing: ratingFor(playerId, 'passing', overall, w.passing),
    checking: ratingFor(playerId, 'checking', overall, w.checking),
    defense: ratingFor(playerId, 'defense', overall, w.defense),
  };
}

function goalieAttributes(playerId: string, overall: number): GoalieAttributes {
  return {
    reflexes: ratingFor(playerId, 'reflexes', overall, GOALIE_WEIGHTS.reflexes),
    positioning: ratingFor(playerId, 'positioning', overall, GOALIE_WEIGHTS.positioning),
    reboundControl: ratingFor(
      playerId,
      'reboundControl',
      overall,
      GOALIE_WEIGHTS.reboundControl,
    ),
  };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/** One raw Fantrax export row. Every field arrives as a string. */
export interface FantraxRow {
  ID: string;
  Player: string;
  Team: string;
  Position: string;
  RkOv: string;
  Status: string;
  Age: string;
  Opponent: string;
  Salary: string;
  Score: string;
  Ros: string;
  '+/-': string;
}

const VALID_POSITIONS: readonly string[] = ['C', 'LW', 'RW', 'D', 'G'];

/** Column order of a Fantrax export, which is positional and stable. */
const COLUMNS = [
  'ID', 'Player', 'Team', 'Position', 'RkOv', 'Status',
  'Age', 'Opponent', 'Salary', 'Score', 'Ros', '+/-',
] as const;

/**
 * Salary carries commas inside quotes and names carry accents, so this goes
 * through a real parser. `split(',')` silently shreds roughly a third of the
 * file and the damage is invisible until ratings look wrong.
 *
 * Columns are assigned BY POSITION rather than from a header line, because a
 * real export cannot be relied on to have one where you expect it. The file this
 * was rewritten for has no header on line 1 — it opens on Macklin Celebrini —
 * and carries one buried at line 498, because it is two exports concatenated.
 * Reading `columns: true` off the first line therefore invented a header out of
 * a player and silently lost him; reading positionally cannot. Any row that
 * repeats the header is dropped below with the same filter that drops waivers.
 */
export function parseFantraxCsv(csvText: string): FantraxRow[] {
  const records = parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as string[][];

  const rows: FantraxRow[] = [];
  for (const record of records) {
    if (record.length < COLUMNS.length) continue;
    const row = {} as Record<string, string>;
    COLUMNS.forEach((name, i) => {
      row[name] = record[i] ?? '';
    });
    rows.push(row as unknown as FantraxRow);
  }
  return rows;
}

/**
 * The franchise a row belongs to, and what that franchise is called.
 *
 * The `Status` column used to be a bare code (`HC`). It now reads
 * `Halifax Citadels - HC`: the league owner renamed the teams and put the names
 * in the export precisely so the game would show them. So the code is taken from
 * after the final dash, and everything before it is the display name — which
 * makes the export the source of truth for names, and leaves jersey colours as
 * the only thing `teams.config.json` still owns by hand.
 *
 * Returns null for a free agent, a waiver row, or a repeated header line, all of
 * which simply fail to end in a known code.
 */
export function parseStatus(raw: string): { code: TeamCode; displayName: string } | null {
  const status = raw.trim();
  if (status.length === 0) return null;

  const dash = status.lastIndexOf(' - ');
  if (dash === -1) {
    // A bare code is still valid: that is what older exports carried.
    return isTeamCode(status) ? { code: status, displayName: status } : null;
  }

  const code = status.slice(dash + 3).trim();
  const displayName = status.slice(0, dash).trim();
  if (!isTeamCode(code) || displayName.length === 0) return null;
  return { code, displayName };
}

/** Fantrax wraps ids in asterisks (`*02un4*`); the bare form is the stable key. */
function stripId(rawId: string): string {
  return rawId.trim().replace(/^\*+|\*+$/g, '');
}

function parsePositions(raw: string, context: string): NhlPosition[] {
  const positions: NhlPosition[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim().toUpperCase();
    if (!VALID_POSITIONS.includes(token)) continue;
    const position = token as NhlPosition;
    if (!positions.includes(position)) positions.push(position);
  }
  if (positions.length === 0) {
    throw new Error(`No recognizable position in "${raw}" for ${context}`);
  }
  return positions;
}

function parseNumber(raw: string, context: string): number {
  const value = Number(raw.trim().replace(/,/g, ''));
  if (!Number.isFinite(value)) throw new Error(`Expected a number, got "${raw}" for ${context}`);
  return value;
}

// ---------------------------------------------------------------------------
// Row -> RosterPlayer
// ---------------------------------------------------------------------------

/**
 * Classification, and the reason the counts come out where they do: any player
 * listed at G is a goalie, anyone else listed at D is a defenseman, everyone
 * else is a forward. Dual-eligible skaters therefore land in the scarcer pool,
 * which is exactly where the line optimizer wants them.
 */
export function derivePlayer(row: FantraxRow, teamCode: TeamCode): RosterPlayer {
  const id = stripId(row.ID);
  const name = row.Player.trim();
  const context = `${name} (${id})`;
  const positions = parsePositions(row.Position, context);

  const isGoalie = positions.includes('G');
  const isDefense = !isGoalie && positions.includes('D');

  // Keep primaryPosition consistent with the classification above, so a player
  // listed "LW,D" is weighted as the defenseman the roster counts him as.
  const primaryPosition: NhlPosition = isGoalie ? 'G' : isDefense ? 'D' : positions[0];

  const score = parseNumber(row.Score, context);
  const overall = overallFromScore(score);

  return {
    id,
    name,
    nhlTeam: row.Team.trim(),
    teamCode,
    positions,
    primaryPosition,
    role: isGoalie ? 'goalie' : 'skater',
    skaterRole: isGoalie ? null : isDefense ? 'D' : 'F',
    age: Math.round(parseNumber(row.Age, context)),
    score,
    overall,
    skater: isGoalie ? null : skaterAttributes(id, overall, primaryPosition as SkaterPosition),
    goalie: isGoalie ? goalieAttributes(id, overall) : null,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Recorded verbatim in the output for provenance. */
  sourceFile: string;
  /** Injected rather than read from the clock so builds are reproducible in tests. */
  generatedAt: string;
}

/** Strongest first. `id` only breaks ties, so the ordering is machine-independent. */
function compareForOutput(a: RosterPlayer, b: RosterPlayer): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.overall !== a.overall) return b.overall - a.overall;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildRostersFile(csvText: string, options: BuildOptions): RostersFile {
  const rows = parseFantraxCsv(csvText);

  const teams = {} as Record<TeamCode, RosterPlayer[]>;
  for (const code of TEAM_CODES) teams[code] = [];

  const seen = new Set<string>();
  for (const row of rows) {
    // Ending in a known code is the only filter that matters: it drops free
    // agents, waiver rows and any repeated header line without enumerating them.
    const owner = parseStatus(row.Status ?? '');
    if (owner === null) continue;

    const player = derivePlayer(row, owner.code);
    if (seen.has(player.id)) {
      throw new Error(`Duplicate player id ${player.id} (${player.name}) in the export`);
    }
    seen.add(player.id);
    teams[owner.code].push(player);
  }

  for (const code of TEAM_CODES) teams[code].sort(compareForOutput);

  return {
    generatedAt: options.generatedAt,
    sourceFile: options.sourceFile,
    sourceRows: rows.length,
    playerCount: seen.size,
    teams,
  };
}

/**
 * The franchise names carried by an export.
 *
 * Deliberately a second pass rather than an extra field on `buildRostersFile`.
 * The committed `rosters.json` is compared byte for byte against a fresh build
 * to prove the pipeline is deterministic, so one stray key on that result makes
 * the artefact and the builder disagree forever. The names are not roster data;
 * they belong to the team config, and they travel separately.
 */
export function collectDisplayNames(csvText: string): Record<TeamCode, string> {
  const names = {} as Record<TeamCode, string>;
  for (const row of parseFantraxCsv(csvText)) {
    const owner = parseStatus(row.Status ?? '');
    // Every row of a team carries the same name, so last writer wins harmlessly.
    if (owner !== null) names[owner.code] = owner.displayName;
  }
  return names;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface TeamCounts {
  total: number;
  goalies: number;
  defense: number;
  forwards: number;
}

export function countTeam(players: RosterPlayer[]): TeamCounts {
  let goalies = 0;
  let defense = 0;
  let forwards = 0;
  for (const player of players) {
    if (player.role === 'goalie') goalies++;
    else if (player.skaterRole === 'D') defense++;
    else forwards++;
  }
  return { total: players.length, goalies, defense, forwards };
}

/**
 * Can this roster actually put a team on the ice?
 *
 * A line is [F, F, D] and there are two of them, plus a goalie. A franchise
 * short of that cannot be picked, and finding that out at the puck drop is far
 * worse than finding it out here.
 */
export function canDress(players: RosterPlayer[]): boolean {
  const c = countTeam(players);
  return c.goalies >= 1 && c.defense >= 2 && c.forwards >= 4;
}

/**
 * Refresh franchise names and abbreviations from the export, keeping colours.
 *
 * `teams.config.json` used to be entirely hand-owned. It is now split: the
 * league owner renamed his teams inside Fantrax and put the names in the export
 * so the game would follow, which makes the export the source of truth for what
 * a team is called. Colours have no home in a Fantrax export and stay hand-owned
 * here, so this rewrites two fields and never touches the other two.
 *
 * The abbreviation becomes the league's own code rather than an NHL one: the
 * scoreboard was reading HAM for a team the league calls HC.
 */
function refreshTeamConfig(displayNames: Record<TeamCode, string>): string[] {
  const config = JSON.parse(readFileSync(TEAMS_CONFIG_PATH, 'utf8')) as TeamsConfigFile;
  const changes: string[] = [];

  for (const code of TEAM_CODES) {
    const team = config.teams[code];
    const name = displayNames[code];
    if (team === undefined || name === undefined || name === code) continue;

    const abbreviation = code.toUpperCase();
    if (team.displayName !== name || team.abbreviation !== abbreviation) {
      changes.push(`${team.abbreviation} ${team.displayName}  ->  ${abbreviation} ${name}`);
      team.displayName = name;
      team.abbreviation = abbreviation;
    }
  }

  if (changes.length > 0) {
    writeFileSync(TEAMS_CONFIG_PATH, `${JSON.stringify(config, null, 2)}
`, 'utf8');
  }
  return changes;
}

function main(): void {
  const csvText = readFileSync(CSV_PATH, 'utf8');
  const file = buildRostersFile(csvText, {
    sourceFile: CSV_RELATIVE_PATH,
    generatedAt: new Date().toISOString(),
  });
  const displayNames = collectDisplayNames(csvText);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  console.log(`Read ${file.sourceRows} data rows from ${CSV_RELATIVE_PATH}`);
  console.log(`Retained ${file.playerCount} players across ${TEAM_CODES.length} teams`);
  // Sorted by size so a team that suddenly loses half its roster stands out.
  const ordered = [...TEAM_CODES].sort(
    (a, b) => file.teams[b].length - file.teams[a].length || (a < b ? -1 : 1),
  );
  for (const code of ordered) {
    const c = countTeam(file.teams[code]);
    console.log(
      `  ${code.padEnd(6)} ${String(c.total).padStart(3)} = ${c.goalies}G / ${c.defense}D / ${c.forwards}F`,
    );
  }
  const renamed = refreshTeamConfig(displayNames);
  if (renamed.length > 0) {
    console.log(`
Renamed ${renamed.length} franchise(s) from the export:`);
    for (const change of renamed) console.log(`  ${change}`);
  }

  /*
   * A team that cannot dress is reported loudly and does NOT stop the build.
   * Refusing to write anything would hold the other thirteen hostage to one bad
   * row in somebody's export; the team select screen hides an undressable
   * franchise, so the game stays correct either way.
   */
  const undressable = TEAM_CODES.filter((code) => !canDress(file.teams[code]));
  if (undressable.length > 0) {
    console.log('');
    for (const code of undressable) {
      const c = countTeam(file.teams[code]);
      console.log(
        `WARNING: ${code} cannot ice a lineup - ${c.total} players ` +
          `(${c.goalies}G / ${c.defense}D / ${c.forwards}F), needs at least 1G / 2D / 4F. ` +
          'It will not be selectable until the export includes its roster.',
      );
    }
  }

  console.log(`Wrote ${OUTPUT_PATH}`);
}

// Only build when invoked as a script; the test suite imports this module.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
