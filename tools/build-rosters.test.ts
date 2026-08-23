import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CSV_PATH,
  CSV_RELATIVE_PATH,
  GOALIE_WEIGHTS,
  OUTPUT_PATH,
  RATINGS,
  SKATER_WEIGHTS,
  buildRostersFile,
  countTeam,
  overallFromScore,
  parseFantraxCsv,
  parseStatus,
} from './build-rosters.js';
import type { FantraxRow } from './build-rosters.js';
import { TEAM_CODES, isTeamCode } from '../shared/src/types.js';
import type { RosterPlayer, RostersFile, TeamCode } from '../shared/src/types.js';

const csvText = readFileSync(CSV_PATH, 'utf8');

/** Frozen so `generatedAt` can never be the reason two builds differ. */
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function build(): RostersFile {
  return buildRostersFile(csvText, {
    sourceFile: CSV_RELATIVE_PATH,
    generatedAt: FIXED_TIMESTAMP,
  });
}

const file = build();

/** The shipped artefact rather than a fresh build; the determinism block proves the two agree. */
const committedFile = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as RostersFile;

function allPlayers(rosters: RostersFile): RosterPlayer[] {
  return TEAM_CODES.flatMap((code) => rosters.teams[code]);
}

type TeamSplit = [total: number, goalies: number, defense: number, forwards: number];

// ---------------------------------------------------------------------------
// CURRENT_EXPORT — the only block tied to the CSV that is committed today
// ---------------------------------------------------------------------------

/**
 * Ground truth for *this* Fantrax export, and nothing else in this file is.
 *
 * Refreshing the league is meant to be one step — drop a new export at
 * data/fantrax-rosters.csv, run `npm run build:rosters` — so every other
 * assertion below is derived from the CSV at test time and survives a refresh
 * untouched. When the export changes, copy the new figures out of the build's
 * own console summary into this block; that is the whole maintenance burden.
 *
 * These numbers still earn their keep: derived checks prove the JSON agrees
 * with the CSV, but only a recorded count can tell the league owner that the
 * CSV itself is the file they think it is.
 */
const CURRENT_EXPORT: {
  sourceRows: number;
  playerCount: number;
  /** Rows the owner filter drops: a repeated header line plus waiver rows. */
  rejectedRows: number;
  teams: Record<TeamCode, TeamSplit>;
  anchorScores: Record<string, number>;
} = {
  sourceRows: 702,
  playerCount: 697,
  /*
   * This export carries no free agents at all — it is a rostered-only download,
   * unlike the first one, which had 7,932 of them. What is left to reject is the
   * header line (columns are read positionally, so the header is just another
   * row until the owner filter drops it), one row with an empty Status, and
   * three waiver rows.
   */
  rejectedRows: 5,
  /** `total = goalies + defense + forwards`, exactly as `build:rosters` prints it. */
  teams: {
    Det: [53, 16, 11, 26],
    HFD: [52, 7, 12, 33],
    TSP: [52, 7, 15, 30],
    PP: [51, 12, 11, 28],
    QUE: [51, 7, 13, 31],
    Jets: [50, 7, 12, 31],
    SJF: [50, 5, 15, 30],
    TOA: [50, 7, 12, 31],
    Yotes: [50, 2, 14, 34],
    CGS: [49, 8, 12, 29],
    HC: [49, 8, 13, 28],
    CBO: [48, 12, 12, 24],
    MW: [48, 6, 11, 31],
    MNS: [44, 6, 9, 29],
  },
  /** The plan's three sanity anchors, with the Scores this export gives them. */
  anchorScores: {
    'Connor McDavid': 98.25,
    'Nathan MacKinnon': 100,
    'Andrei Vasilevskiy': 100,
  },
};

/** Overall an anchor player must reach to count as elite. A plan rubric, not an export fact. */
const ELITE_OVERALL = 95;

// ---------------------------------------------------------------------------
// Derived from the CSV, so a refreshed export needs no edits down here
// ---------------------------------------------------------------------------

/** Mirrors the build's own normalisation, so test and pipeline can never disagree. */
function statusOf(row: FantraxRow): string {
  return row.Status?.trim() ?? '';
}

const rows = parseFantraxCsv(csvText);
/*
 * The test derives its expectations through `parseStatus`, the same function the
 * pipeline uses, rather than re-implementing the rule. The export's Status column
 * changed from a bare code to "Halifax Citadels - HC", and a second copy of that
 * rule living here would have gone quietly wrong instead of loudly.
 */
const rosteredRows = rows.filter((row) => parseStatus(statusOf(row)) !== null);
const rejectedRows = rows.filter((row) => parseStatus(statusOf(row)) === null);

const csvTeamCounts = new Map<TeamCode, number>();
for (const row of rosteredRows) {
  const owner = parseStatus(statusOf(row));
  if (owner === null) continue;
  csvTeamCounts.set(owner.code, (csvTeamCounts.get(owner.code) ?? 0) + 1);
}

describe('roster pipeline', () => {
  it('reads every data row in the export', () => {
    expect(file.sourceRows).toBe(rows.length);
    expect(file.sourceRows).toBe(CURRENT_EXPORT.sourceRows);
  });

  it('retains exactly the rostered rows the CSV carries', () => {
    expect(file.playerCount).toBe(rosteredRows.length);
    expect(allPlayers(file)).toHaveLength(rosteredRows.length);
    expect(file.playerCount).toBe(CURRENT_EXPORT.playerCount);
  });

  it('emits exactly the 14 league teams', () => {
    expect(Object.keys(file.teams).sort()).toEqual([...TEAM_CODES].sort());
  });

  it('gives each team exactly the players the CSV files under its code', () => {
    for (const code of TEAM_CODES) {
      const fromCsv = rosteredRows.filter((row) => parseStatus(statusOf(row))?.code === code);
      const fromJson = file.teams[code];
      expect({ code, count: fromJson.length }).toEqual({ code, count: csvTeamCounts.get(code) });
      expect(new Set(fromJson.map((player) => player.id))).toEqual(
        new Set(fromCsv.map((row) => row.ID.replaceAll('*', ''))),
      );
    }
  });

  it('matches the recorded per-team goalie/defense/forward split', () => {
    for (const code of TEAM_CODES) {
      const [total, goalies, defense, forwards] = CURRENT_EXPORT.teams[code];
      expect({ code, ...countTeam(file.teams[code]) }).toEqual({
        code,
        total,
        goalies,
        defense,
        forwards,
      });
      // The recorded split has to be internally consistent, whatever export it came from.
      expect(goalies + defense + forwards).toBe(total);
    }
  });
});

describe('filtering', () => {
  it('leaks no free agents or malformed waiver rows', () => {
    const retained = new Set(allPlayers(file).map((player) => player.id));

    for (const row of rejectedRows) {
      expect(retained.has(row.ID.replaceAll('*', ''))).toBe(false);
    }
    expect(rejectedRows).toHaveLength(rows.length - file.playerCount);

    // The export really does contain each kind of row we mean to drop, and the
    // count is pinned so a future export that silently stops dropping them fails.
    expect(rejectedRows).toHaveLength(CURRENT_EXPORT.rejectedRows);
    expect(rejectedRows.some((row) => row.Status.includes('<small>'))).toBe(true);
    expect(rejectedRows.some((row) => row.ID === 'ID')).toBe(true);
  });

  it('files every retained player under a real team code', () => {
    for (const code of TEAM_CODES) {
      for (const player of file.teams[code]) {
        expect(player.teamCode).toBe(code);
        expect(isTeamCode(player.teamCode)).toBe(true);
      }
    }
  });

  it('strips the asterisks Fantrax wraps ids in', () => {
    for (const player of allPlayers(file)) {
      expect(player.id).not.toContain('*');
      expect(player.id.length).toBeGreaterThan(0);
    }
  });
});

describe('ratings curve', () => {
  it('puts a score-0 prospect exactly on the floor', () => {
    expect(overallFromScore(0)).toBe(RATINGS.floor);
    expect(RATINGS.floor).toBe(40);
    const floorPlayers = allPlayers(file).filter((player) => player.score === 0);
    expect(floorPlayers.length).toBeGreaterThan(0);
    for (const player of floorPlayers) expect(player.overall).toBe(40);
  });

  it('bends the curve above the straight line through the middle of the league', () => {
    // The 0 -> floor and 100 -> peak anchors are true of *any* exponent, so they
    // cannot detect the curve being flattened. These three can: they sit where
    // the sub-linear exponent actually bites, and they are where the bulk of the
    // league lives. Straight-line values would be 51 / 68 / 82.
    const straightLine = (score: number): number =>
      Math.round(RATINGS.floor + (score / 100) * RATINGS.span);

    expect(overallFromScore(20)).toBe(54);
    expect(overallFromScore(50)).toBe(71);
    expect(overallFromScore(75)).toBe(84);

    for (const score of [20, 50, 75]) {
      expect(overallFromScore(score)).toBeGreaterThan(straightLine(score));
    }
  });

  it('peaks below the ceiling so the profile has somewhere to live', () => {
    // Deliberately not 99: weighting and jitter are applied above the curve, and
    // a curve that peaked at the ceiling would have them clamped off — which is
    // how a centre once ended up rated 99 defensively.
    expect(overallFromScore(100)).toBe(RATINGS.floor + RATINGS.span);
    expect(overallFromScore(100)).toBe(96);
    expect(overallFromScore(100)).toBeLessThan(RATINGS.attributeMax);
  });

  it('never lets an attribute pile up on the ceiling', () => {
    const attributesOf = (player: RosterPlayer): number[] =>
      Object.values(player.skater ?? {}).concat(Object.values(player.goalie ?? {}));
    const values = allPlayers(file).flatMap(attributesOf);

    // Clamping does not merely cap a number, it erases the *differences* between
    // one player's attributes, exactly in the tier where they should read loudest.
    expect(values.filter((value) => value === RATINGS.attributeMax)).toHaveLength(0);
    // ...and the headroom above the curve is genuinely used, not just unreachable.
    expect(Math.max(...values)).toBeGreaterThan(overallFromScore(100));
  });

  it('makes the anchor players elite', () => {
    const byName = new Map(allPlayers(file).map((player) => [player.name, player]));
    for (const [name, score] of Object.entries(CURRENT_EXPORT.anchorScores)) {
      const player = byName.get(name);
      expect(player, `${name} should be on a roster`).toBeDefined();
      expect(player!.score).toBe(score);
      expect(player!.overall).toBeGreaterThanOrEqual(ELITE_OVERALL);
    }
  });

  it('keeps every derived attribute inside 0..99', () => {
    for (const player of allPlayers(file)) {
      expect(player.overall).toBeGreaterThanOrEqual(RATINGS.floor);
      expect(player.overall).toBeLessThanOrEqual(RATINGS.attributeMax);
      const attributes = Object.values(player.skater ?? {}).concat(
        Object.values(player.goalie ?? {}),
      );
      expect(attributes).toHaveLength(player.role === 'goalie' ? 3 : 5);
      for (const value of attributes) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(RATINGS.attributeMin);
        expect(value).toBeLessThanOrEqual(RATINGS.attributeMax);
      }
    }
  });

  it('gives every player exactly one attribute block, matching their role', () => {
    for (const player of allPlayers(file)) {
      if (player.positions.includes('G')) {
        expect(player.role).toBe('goalie');
        expect(player.skaterRole).toBeNull();
        expect(player.skater).toBeNull();
        expect(player.goalie).not.toBeNull();
      } else {
        expect(player.role).toBe('skater');
        expect(player.skaterRole).toBe(player.positions.includes('D') ? 'D' : 'F');
        expect(player.goalie).toBeNull();
        expect(player.skater).not.toBeNull();
      }
    }
  });

  it('spreads attributes so equal-score players at a position are not clones', () => {
    // Counting *duplicates*, not distinct values, is the whole point. Position
    // weighting alone gives three distinct skater vectors, so "more than one
    // distinct vector exists" stays true with the jitter deleted entirely.
    // Grouping by (score, position) removes weighting from the picture: inside a
    // group the jitter is the only thing left that can tell two players apart.
    const groups = new Map<string, RosterPlayer[]>();
    for (const player of allPlayers(file)) {
      if (player.skater === null) continue;
      const key = `${player.score} ${player.primaryPosition}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [player]);
      else group.push(player);
    }

    const collisions: string[] = [];
    for (const [key, group] of groups) {
      const distinct = new Set(group.map((player) => JSON.stringify(player.skater)));
      if (distinct.size !== group.length) {
        collisions.push(
          `${key}: ${group.length} skaters, only ${distinct.size} distinct attribute lines`,
        );
      }
    }
    expect(collisions).toEqual([]);

    // Only meaningful if the export really does bunch players onto one Score.
    const largest = Math.max(...[...groups.values()].map((group) => group.length));
    expect(largest).toBeGreaterThan(10);
  });

  it('keeps goalies near-unique on only three attributes', () => {
    // Three attributes and a +-4 jitter is a small enough space that a couple of
    // collisions among the score-0 crowd is arithmetic rather than cloning, so
    // this asks for near-uniqueness instead of the skaters' exact zero. Deleting
    // the jitter would collapse a whole group onto one line and fail loudly.
    const groups = new Map<number, RosterPlayer[]>();
    for (const player of allPlayers(file)) {
      if (player.goalie === null) continue;
      const group = groups.get(player.score);
      if (group === undefined) groups.set(player.score, [player]);
      else group.push(player);
    }

    for (const [score, group] of groups) {
      const distinct = new Set(group.map((player) => JSON.stringify(player.goalie)));
      expect({ score, distinct: distinct.size >= Math.ceil(group.length * 0.9) }).toEqual({
        score,
        distinct: true,
      });
    }
    expect(Math.max(...[...groups.values()].map((group) => group.length))).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Position profile — pinned league-wide, never per player
// ---------------------------------------------------------------------------

type SkaterPosition = keyof typeof SKATER_WEIGHTS;
type SkaterAttribute = keyof (typeof SKATER_WEIGHTS)['D'];
type GoalieAttribute = keyof typeof GOALIE_WEIGHTS;

/**
 * How far a position's league-wide mean may sit from its weight, in points.
 *
 * Jitter is symmetric and the thinnest position still has 96 players, so it
 * averages down to hundredths; what is left is the fold above the curve gently
 * compressing the elite tier, worst case 0.39 on this export. A point of slack
 * absorbs a data refresh while still catching a row that has stopped applying.
 */
const PROFILE_TOLERANCE = 1;

/** Below this a tilt is not felt through the sim's lerpAttr ranges. */
const MIN_VISIBLE_TILT = 4;

/** How far mean rebound control must sit under the other two goalie attributes. */
const MIN_REBOUND_HANDICAP = 2;

/**
 * Plan section 3 in its own words: D get +defense/+checking and slightly
 * -shooting, wingers +shooting, centres +passing.
 *
 * This is the half of the guard that outlives the weight table being wrong. The
 * tolerance checks below read their expectations out of SKATER_WEIGHTS, so a
 * zeroed or inverted row moves data and expectation together and slips past
 * them; these directions come from the spec instead, and go red the moment the
 * profile stops meaning what the plan says it means. Positions and attributes
 * only — magnitudes stay in the weight table, which is free to be retuned.
 */
const PROFILE_SHAPE: Record<SkaterPosition, { up: SkaterAttribute[]; down: SkaterAttribute[] }> = {
  D: { up: ['defense', 'checking'], down: ['shooting'] },
  C: { up: ['passing'], down: [] },
  LW: { up: ['shooting'], down: ['defense'] },
  RW: { up: ['shooting'], down: ['defense'] },
};

const skatersByPosition = new Map<SkaterPosition, RosterPlayer[]>();
for (const player of allPlayers(committedFile)) {
  if (player.skater === null) continue;
  const position = player.primaryPosition as SkaterPosition;
  const group = skatersByPosition.get(position);
  if (group === undefined) skatersByPosition.set(position, [player]);
  else group.push(player);
}
const committedGoalies = allPlayers(committedFile).filter((player) => player.goalie !== null);

/**
 * Mean of `attribute - overall` across a group: the tilt the weight table claims
 * to apply, measured on the shipped data. Taking it against each player's own
 * overall is what makes this independent of how strong the position happens to
 * be in a given export.
 */
function meanTilt(players: RosterPlayer[], read: (player: RosterPlayer) => number): number {
  return players.reduce((sum, player) => sum + read(player) - player.overall, 0) / players.length;
}

describe('position profile', () => {
  it('has enough players at every position for the jitter to average out', () => {
    expect([...skatersByPosition.keys()].sort()).toEqual(Object.keys(SKATER_WEIGHTS).sort());
    for (const [position, group] of skatersByPosition) {
      expect({ position, sample: group.length >= 90 }).toEqual({ position, sample: true });
    }
    expect(committedGoalies.length).toBeGreaterThanOrEqual(90);
  });

  it('tilts each skater position by the weights it was built from', () => {
    const off: string[] = [];
    for (const [position, group] of skatersByPosition) {
      const weights = Object.entries(SKATER_WEIGHTS[position]) as [SkaterAttribute, number][];
      for (const [attribute, weight] of weights) {
        const tilt = meanTilt(group, (player) => player.skater![attribute]);
        if (Math.abs(tilt - weight) > PROFILE_TOLERANCE) {
          off.push(`${position} ${attribute}: mean ${tilt.toFixed(2)}, expected ~${weight}`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  it('tilts goalies by the weights they were built from', () => {
    const off: string[] = [];
    const weights = Object.entries(GOALIE_WEIGHTS) as [GoalieAttribute, number][];
    for (const [attribute, weight] of weights) {
      const tilt = meanTilt(committedGoalies, (player) => player.goalie![attribute]);
      if (Math.abs(tilt - weight) > PROFILE_TOLERANCE) {
        off.push(`G ${attribute}: mean ${tilt.toFixed(2)}, expected ~${weight}`);
      }
    }
    expect(off).toEqual([]);
  });

  it('reads the way the plan describes each position', () => {
    for (const position of Object.keys(PROFILE_SHAPE) as SkaterPosition[]) {
      const group = skatersByPosition.get(position)!;
      const { up, down } = PROFILE_SHAPE[position];
      for (const attribute of up) {
        const tilt = meanTilt(group, (player) => player.skater![attribute]);
        expect({ position, attribute, tilt: tilt >= MIN_VISIBLE_TILT }).toEqual({
          position,
          attribute,
          tilt: true,
        });
      }
      for (const attribute of down) {
        const tilt = meanTilt(group, (player) => player.skater![attribute]);
        expect({ position, attribute, tilt: tilt <= -MIN_VISIBLE_TILT }).toEqual({
          position,
          attribute,
          tilt: true,
        });
      }
    }
  });

  it('holds rebound control back below the rest of a goalie', () => {
    // The one deliberate handicap in the goalie profile: rebounds are what keep
    // even a 99-rated goalie beatable in a 3-on-3 scramble, so this must survive
    // any retune that pulls the other two attributes around.
    const rebound = meanTilt(committedGoalies, (player) => player.goalie!.reboundControl);
    const reflexes = meanTilt(committedGoalies, (player) => player.goalie!.reflexes);
    const positioning = meanTilt(committedGoalies, (player) => player.goalie!.positioning);

    expect(rebound).toBeLessThan(0);
    expect(reflexes - rebound).toBeGreaterThanOrEqual(MIN_REBOUND_HANDICAP);
    expect(positioning - rebound).toBeGreaterThanOrEqual(MIN_REBOUND_HANDICAP);
  });
});

describe('determinism', () => {
  it('produces identical JSON on a rebuild', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('matches the committed rosters.json apart from the timestamp', () => {
    const rebuilt = buildRostersFile(csvText, {
      sourceFile: committedFile.sourceFile,
      generatedAt: committedFile.generatedAt,
    });
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(committedFile));
  });
});
