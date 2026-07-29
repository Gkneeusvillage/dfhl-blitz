import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CSV_PATH,
  CSV_RELATIVE_PATH,
  OUTPUT_PATH,
  RATINGS,
  buildRostersFile,
  countTeam,
  overallFromScore,
  parseFantraxCsv,
} from './build-rosters.js';
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

function allPlayers(rosters: RostersFile): RosterPlayer[] {
  return TEAM_CODES.flatMap((code) => rosters.teams[code]);
}

/**
 * Ground truth from the Fantrax export. If any of these move, the source data
 * changed (or the classification rule broke) — either way it should be loud.
 */
const EXPECTED: Record<TeamCode, [total: number, goalies: number, defense: number, forwards: number]> =
  {
    Det: [54, 14, 12, 28],
    TSP: [52, 7, 15, 30],
    HFD: [52, 8, 12, 32],
    Jets: [51, 7, 10, 34],
    PP: [51, 12, 11, 28],
    TOA: [51, 9, 12, 30],
    QUE: [50, 7, 11, 32],
    SJF: [49, 5, 15, 29],
    HC: [49, 7, 15, 27],
    CGS: [49, 8, 12, 29],
    Yotes: [48, 3, 14, 31],
    CBO: [48, 11, 12, 25],
    MW: [46, 6, 11, 29],
    MNS: [41, 6, 8, 27],
  };

describe('roster pipeline', () => {
  it('reads every data row in the export', () => {
    expect(file.sourceRows).toBe(8624);
  });

  it('retains exactly 691 players', () => {
    expect(file.playerCount).toBe(691);
    expect(allPlayers(file)).toHaveLength(691);
  });

  it('emits exactly the 14 league teams', () => {
    expect(Object.keys(file.teams).sort()).toEqual([...TEAM_CODES].sort());
  });

  it('matches the expected per-team goalie/defense/forward split', () => {
    for (const code of TEAM_CODES) {
      const [total, goalies, defense, forwards] = EXPECTED[code];
      expect({ code, ...countTeam(file.teams[code]) }).toEqual({
        code,
        total,
        goalies,
        defense,
        forwards,
      });
    }
  });
});

describe('filtering', () => {
  it('leaks no free agents or malformed waiver rows', () => {
    const retained = new Set(allPlayers(file).map((player) => player.id));
    const rejected = parseFantraxCsv(csvText).filter((row) => !isTeamCode(row.Status.trim()));

    // The export really does contain both kinds of row we mean to drop.
    expect(rejected.filter((row) => row.Status.trim() === 'FA')).toHaveLength(7932);
    expect(rejected.some((row) => row.Status.includes('<small>'))).toBe(true);

    for (const row of rejected) {
      expect(retained.has(row.ID.replaceAll('*', ''))).toBe(false);
    }
    expect(rejected).toHaveLength(8624 - 691);
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
    const floorPlayers = allPlayers(file).filter((player) => player.score === 0);
    expect(floorPlayers.length).toBeGreaterThan(0);
    for (const player of floorPlayers) expect(player.overall).toBe(40);
  });

  it('tops out at 99', () => {
    expect(overallFromScore(100)).toBe(99);
  });

  it('makes the anchor players elite', () => {
    const byName = new Map(allPlayers(file).map((player) => [player.name, player]));
    for (const name of ['Connor McDavid', 'Nathan MacKinnon', 'Andrei Vasilevskiy']) {
      const player = byName.get(name);
      expect(player, `${name} should be on a roster`).toBeDefined();
      expect(player!.overall).toBeGreaterThanOrEqual(95);
    }
    expect(byName.get('Connor McDavid')!.score).toBe(98.25);
    expect(byName.get('Nathan MacKinnon')!.score).toBe(100);
    expect(byName.get('Andrei Vasilevskiy')!.score).toBe(100);
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

  it('spreads attributes so equal-score players are not clones', () => {
    const floorSkaters = allPlayers(file).filter(
      (player) => player.score === 0 && player.skater !== null,
    );
    const distinct = new Set(floorSkaters.map((player) => JSON.stringify(player.skater)));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('determinism', () => {
  it('produces identical JSON on a rebuild', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('matches the committed rosters.json apart from the timestamp', () => {
    const committed = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as RostersFile;
    const rebuilt = buildRostersFile(csvText, {
      sourceFile: committed.sourceFile,
      generatedAt: committed.generatedAt,
    });
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(committed));
  });
});
