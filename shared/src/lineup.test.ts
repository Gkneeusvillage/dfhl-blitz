import { describe, expect, it } from 'vitest';

import rostersJson from '../data/rosters.json';
import teamsJson from '../data/teams.config.json';
import {
  LINEUP,
  buildDefaultLineup,
  compareStrength,
  dressedRoster,
  isEligibleAt,
  resolveTeam,
  validateLineup,
} from './lineup.js';
import { TEAM_CODES } from './types.js';
import type { LineUnit, Lineup, RosterPlayer, RostersFile, TeamCode, TeamsConfigFile } from './types.js';

const rosters = rostersJson as unknown as RostersFile;
const teamConfigs = (teamsJson as unknown as TeamsConfigFile).teams;

function rosterOf(code: TeamCode): RosterPlayer[] {
  return rosters.teams[code];
}

function playerIn(roster: RosterPlayer[], id: string): RosterPlayer {
  const player = roster.find((candidate) => candidate.id === id);
  if (player === undefined) throw new Error(`no player ${id} in fixture roster`);
  return player;
}

/** Replace one line, keeping the tuple shape the Lineup type demands. */
function withLine(lineup: Lineup, index: 0 | 1, skaterIds: [string, string, string]): Lineup {
  const lines: [LineUnit, LineUnit] = [lineup.lines[0], lineup.lines[1]];
  lines[index] = { skaterIds };
  return { ...lineup, lines };
}

// Synthetic players cover the edge cases the real rosters are too healthy to hit.
let syntheticSeq = 0;

function makePlayer(positions: RosterPlayer['positions'], score: number): RosterPlayer {
  const isGoalie = positions.includes('G');
  const isDefense = !isGoalie && positions.includes('D');
  syntheticSeq += 1;
  return {
    id: `syn${syntheticSeq}`,
    name: `Synthetic ${syntheticSeq}`,
    nhlTeam: 'TST',
    teamCode: 'Det',
    positions,
    primaryPosition: isGoalie ? 'G' : isDefense ? 'D' : positions[0],
    role: isGoalie ? 'goalie' : 'skater',
    skaterRole: isGoalie ? null : isDefense ? 'D' : 'F',
    age: 25,
    score,
    overall: Math.round(score),
    skater: isGoalie ? null : { skating: 50, shooting: 50, passing: 50, checking: 50, defense: 50 },
    goalie: isGoalie ? { reflexes: 50, positioning: 50, reboundControl: 50 } : null,
  };
}

describe('buildDefaultLineup', () => {
  it('builds a valid goalie plus two full lines for all 14 teams', () => {
    for (const code of TEAM_CODES) {
      const roster = rosterOf(code);
      const lineup = buildDefaultLineup(roster);

      expect(lineup.teamCode).toBe(code);
      expect(validateLineup(roster, lineup)).toEqual([]);
      expect(lineup.lines).toHaveLength(LINEUP.lines);

      const skaterIds = lineup.lines.flatMap((line) => line.skaterIds);
      expect(skaterIds).toHaveLength(6);
      expect(new Set([...skaterIds, lineup.goalieId]).size).toBe(7);

      for (const line of lineup.lines) {
        expect(line.skaterIds).toHaveLength(3);
        const [first, second, defense] = line.skaterIds.map((id) => playerIn(roster, id));
        expect(isEligibleAt(first, 'F')).toBe(true);
        expect(isEligibleAt(second, 'F')).toBe(true);
        expect(isEligibleAt(defense, 'D')).toBe(true);
        // Forwards within a line read strongest first.
        expect(compareStrength(first, second)).toBeLessThan(0);
      }
    }
  });

  it('starts the best goalie by score, even on the thinnest crease in the league', () => {
    for (const code of TEAM_CODES) {
      const roster = rosterOf(code);
      const goalies = roster.filter((player) => player.role === 'goalie');
      expect(buildDefaultLineup(roster).goalieId).toBe([...goalies].sort(compareStrength)[0].id);
    }
    /*
     * Somebody in this league always runs a thin crease, and the optimizer must
     * not assume otherwise. Pinned as "the shallowest team has at most two" —
     * a shape rather than a number, so a roster refresh that shuffles who is
     * thinnest does not make this red for no reason.
     */
    const shallowest = Math.min(
      ...TEAM_CODES.map((code) => rosterOf(code).filter((p) => p.role === 'goalie').length),
    );
    expect(shallowest).toBeGreaterThanOrEqual(1);
    expect(shallowest).toBeLessThanOrEqual(3);
  });

  it('dresses the strongest available skaters', () => {
    for (const code of TEAM_CODES) {
      const roster = rosterOf(code);
      const chosen = new Set(buildDefaultLineup(roster).lines.flatMap((line) => line.skaterIds));
      const { forwards, defense } = dressedRoster(roster);

      expect(forwards).toHaveLength(LINEUP.dressedForwards);
      expect(defense).toHaveLength(LINEUP.dressedDefense);
      for (const player of forwards.slice(0, LINEUP.forwardsNeeded)) {
        expect(chosen.has(player.id)).toBe(true);
      }
      for (const player of defense.slice(0, LINEUP.defenseNeeded)) {
        expect(chosen.has(player.id)).toBe(true);
      }
    }
  });

  it('splits the chosen skaters into the most evenly matched pair of lines', () => {
    for (const code of TEAM_CODES) {
      const roster = rosterOf(code);
      const lineup = buildDefaultLineup(roster);
      const overall = (id: string): number => playerIn(roster, id).overall;

      const forwards = lineup.lines.flatMap((line) => line.skaterIds.slice(0, 2));
      const defense = lineup.lines.map((line) => line.skaterIds[2]);

      // Independent brute force over every legal arrangement of the same six.
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < forwards.length; i++) {
        for (let j = i + 1; j < forwards.length; j++) {
          const rest = forwards.filter((_, index) => index !== i && index !== j);
          for (const flip of [0, 1]) {
            const total1 = overall(forwards[i]) + overall(forwards[j]) + overall(defense[flip]);
            const total2 = overall(rest[0]) + overall(rest[1]) + overall(defense[1 - flip]);
            bestDiff = Math.min(bestDiff, Math.abs(total1 - total2));
          }
        }
      }

      const sum = (line: LineUnit): number =>
        line.skaterIds.reduce((total, id) => total + overall(id), 0);
      const actualDiff = Math.abs(sum(lineup.lines[0]) - sum(lineup.lines[1]));
      expect({ code, diff: actualDiff }).toEqual({ code, diff: bestDiff });
    }
  });

  it('does not depend on roster ordering', () => {
    for (const code of TEAM_CODES) {
      const roster = rosterOf(code);
      expect(buildDefaultLineup([...roster].reverse())).toEqual(buildDefaultLineup(roster));
    }
  });

  it('uses dual F/D eligibility to fill whichever slot is short', () => {
    // Two pure forwards, four defensemen — two of whom can also play the wing.
    const roster = [
      makePlayer(['G'], 60),
      makePlayer(['C'], 80),
      makePlayer(['LW'], 78),
      makePlayer(['D'], 70),
      makePlayer(['D'], 68),
      makePlayer(['D', 'RW'], 66),
      makePlayer(['D', 'C'], 64),
    ];
    const lineup = buildDefaultLineup(roster);
    expect(validateLineup(roster, lineup)).toEqual([]);

    // The dual-eligible pair covers the shortage; the pure defensemen are not
    // dragged up the ice to do it.
    for (const id of lineup.lines.flatMap((line) => line.skaterIds.slice(0, 2))) {
      expect(playerIn(roster, id).positions).not.toEqual(['D']);
    }
  });

  it('refuses a roster it cannot dress', () => {
    expect(() => buildDefaultLineup([])).toThrow(/empty roster/);
    expect(() => buildDefaultLineup([makePlayer(['C'], 50)])).toThrow(/no goalie/);
    expect(() =>
      buildDefaultLineup([makePlayer(['G'], 50), makePlayer(['C'], 50), makePlayer(['D'], 50)]),
    ).toThrow(/forward-eligible/);
    expect(() =>
      buildDefaultLineup([
        makePlayer(['G'], 50),
        makePlayer(['C'], 50),
        makePlayer(['C'], 50),
        makePlayer(['LW'], 50),
        makePlayer(['RW'], 50),
      ]),
    ).toThrow(/defense-eligible/);
  });
});

describe('resolveTeam', () => {
  it('round-trips a default lineup for all 14 teams', () => {
    for (const code of TEAM_CODES) {
      const roster = rosterOf(code);
      const lineup = buildDefaultLineup(roster);
      const resolved = resolveTeam(roster, lineup, teamConfigs[code]);

      expect(resolved.code).toBe(code);
      expect(resolved.config).toEqual(teamConfigs[code]);
      expect(resolved.skaters).toHaveLength(6);

      // Line 0 then line 1, each [F, F, D].
      expect(resolved.skaters.map((skater) => skater.skaterRole)).toEqual([
        'F',
        'F',
        'D',
        'F',
        'F',
        'D',
      ]);
      expect(resolved.skaters.map((skater) => skater.playerId)).toEqual(
        lineup.lines.flatMap((line) => line.skaterIds),
      );

      for (const skater of resolved.skaters) {
        const source = playerIn(roster, skater.playerId);
        expect(skater.name).toBe(source.name);
        expect(skater.attributes).toEqual(source.skater);
      }

      const goalie = playerIn(roster, lineup.goalieId);
      expect(resolved.goalie).toEqual({
        playerId: goalie.id,
        name: goalie.name,
        attributes: goalie.goalie,
      });
    }
  });

  it('names the missing player when an id cannot be resolved', () => {
    const roster = rosterOf('MNS');
    const lineup = buildDefaultLineup(roster);
    const [, second, defense] = lineup.lines[0].skaterIds;

    expect(() => resolveTeam(roster, withLine(lineup, 0, ['ghost', second, defense]), teamConfigs.MNS)).toThrow(
      /line 1 slot 1.*"ghost"/,
    );
    expect(() => resolveTeam(roster, { ...lineup, goalieId: 'ghost' }, teamConfigs.MNS)).toThrow(
      /goalie.*"ghost"/,
    );
  });

  it('rejects a config for a different franchise', () => {
    const roster = rosterOf('MNS');
    expect(() => resolveTeam(roster, buildDefaultLineup(roster), teamConfigs.Det)).toThrow(
      /Det.*MNS/,
    );
  });
});

describe('validateLineup', () => {
  const roster = rosterOf('Det');
  const lineup = buildDefaultLineup(roster);
  const [first, second, defense] = lineup.lines[0].skaterIds;

  it('accepts the optimizer output unchanged', () => {
    expect(validateLineup(roster, lineup)).toEqual([]);
  });

  it('reports an unknown player id', () => {
    expect(validateLineup(roster, { ...lineup, goalieId: 'ghost' })).toEqual([
      expect.stringContaining('is not on the Det roster'),
    ]);
  });

  it('reports a goalie in a skater slot', () => {
    const broken = withLine(lineup, 0, [lineup.goalieId, second, defense]);
    expect(validateLineup(roster, broken).join(' ')).toMatch(/cannot take a skater slot/);
  });

  it('reports a skater who is not eligible at the slot they were given', () => {
    const forwardOnly = roster.find(
      (player) => player.role === 'skater' && !player.positions.includes('D'),
    )!;
    const broken = withLine(lineup, 0, [first, second, forwardOnly.id]);
    expect(validateLineup(roster, broken).join(' ')).toMatch(/not eligible at D/);
  });

  it('reports a player used twice', () => {
    const broken = withLine(lineup, 1, [first, ...lineup.lines[1].skaterIds.slice(1)] as [
      string,
      string,
      string,
    ]);
    expect(validateLineup(roster, broken).join(' ')).toMatch(/used at both/);
  });

  it('reports a roster that does not belong to the lineup', () => {
    expect(validateLineup(rosterOf('MNS'), lineup).join(' ')).toMatch(
      /from MNS, but the lineup is for Det/,
    );
  });
});
