import { describe, expect, it } from 'vitest';

import { TEAM_CODES, buildDefaultLineup, createMatch, stepMatch } from '@dfhl/shared';
import type { Lineup } from '@dfhl/shared';

import { defaultSettings } from '../rooms/lobby.js';
import {
  buildMatchConfig,
  defaultTeamCodes,
  lineupProblems,
  loadRosters,
  rosterFor,
  sanitizeLineup,
  teamConfigFor,
} from './config.js';

const detroitLineup = (): Lineup => buildDefaultLineup(rosterFor('Det'));

describe('roster loading', () => {
  it('finds the generated data and it is the expected export', () => {
    const rosters = loadRosters();
    expect(rosters.playerCount).toBe(691);
    expect(Object.keys(rosters.teams)).toHaveLength(TEAM_CODES.length);
  });

  it('has a roster and a config for all fourteen franchises', () => {
    for (const code of TEAM_CODES) {
      expect(rosterFor(code).length).toBeGreaterThan(0);
      expect(teamConfigFor(code).code).toBe(code);
    }
  });
});

describe('sanitizeLineup', () => {
  it('accepts a lineup the optimizer built', () => {
    const lineup = detroitLineup();
    expect(sanitizeLineup(lineup)).toEqual(lineup);
  });

  it('rebuilds the object rather than trusting the one on the wire', () => {
    const lineup = detroitLineup();
    const hostile = {
      ...lineup,
      lines: lineup.lines.map((line) => ({ ...line, injected: 'x' })),
      attributes: { skating: 99 },
      seed: 1,
    };
    const clean = sanitizeLineup(hostile);
    expect(clean).toEqual(lineup);
    expect(Object.keys(clean as object).sort()).toEqual(['goalieId', 'lines', 'teamCode']);
    expect(Object.keys((clean as Lineup).lines[0])).toEqual(['skaterIds']);
  });

  it('refuses a shape that is not a lineup', () => {
    const lineup = detroitLineup();
    expect(sanitizeLineup(null)).toBeNull();
    expect(sanitizeLineup('Det')).toBeNull();
    expect(sanitizeLineup({ ...lineup, teamCode: 'FA' })).toBeNull();
    expect(sanitizeLineup({ ...lineup, goalieId: 42 })).toBeNull();
    expect(sanitizeLineup({ ...lineup, goalieId: '' })).toBeNull();
    expect(sanitizeLineup({ ...lineup, lines: [lineup.lines[0]] })).toBeNull();
    expect(sanitizeLineup({ ...lineup, lines: [lineup.lines[0], { skaterIds: ['a', 'b'] }] })).toBeNull();
    expect(
      sanitizeLineup({ ...lineup, lines: [lineup.lines[0], { skaterIds: ['a', 'b', 7] }] }),
    ).toBeNull();
  });
});

describe('lineupProblems', () => {
  it('passes a lineup built from the real roster', () => {
    expect(lineupProblems(detroitLineup())).toEqual([]);
  });

  it('catches a player who is not on that franchise', () => {
    const lineup = detroitLineup();
    const stolen = buildDefaultLineup(rosterFor('TSP'));
    const forged: Lineup = {
      ...lineup,
      lines: [{ skaterIds: [...stolen.lines[0].skaterIds] }, lineup.lines[1]],
    };
    expect(lineupProblems(forged).length).toBeGreaterThan(0);
  });

  it('catches the same player dressed twice', () => {
    const lineup = detroitLineup();
    const doubled: Lineup = {
      ...lineup,
      lines: [lineup.lines[0], { skaterIds: [...lineup.lines[0].skaterIds] }],
    };
    expect(lineupProblems(doubled).length).toBeGreaterThan(0);
  });
});

describe('defaultTeamCodes', () => {
  it('never puts a franchise against itself', () => {
    for (let seed = 0; seed < 5000; seed++) {
      const { home, away } = defaultTeamCodes(seed);
      expect(home).not.toBe(away);
    }
  });

  it('is a function of the seed alone', () => {
    expect(defaultTeamCodes(12345)).toEqual(defaultTeamCodes(12345));
  });

  it('reaches every franchise across the seed space', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 5000; seed++) {
      const { home, away } = defaultTeamCodes(seed);
      seen.add(home);
      seen.add(away);
    }
    expect(seen.size).toBe(TEAM_CODES.length);
  });
});

describe('buildMatchConfig', () => {
  it('carries the lobby settings and the seed through untouched', () => {
    const settings = { periods: 2, periodSeconds: 90, onFireEnabled: false };
    const config = buildMatchConfig(
      4242,
      settings,
      { teamCode: 'Det', lineup: null },
      { teamCode: 'TSP', lineup: null },
    );
    expect(config.seed).toBe(4242);
    expect(config.periods).toBe(2);
    expect(config.periodSeconds).toBe(90);
    expect(config.onFireEnabled).toBe(false);
  });

  it('dresses six real skaters and a goalie a side', () => {
    const config = buildMatchConfig(
      1,
      defaultSettings(),
      { teamCode: 'Det', lineup: null },
      { teamCode: 'HFD', lineup: null },
    );
    for (const team of [config.home, config.away]) {
      expect(team.skaters).toHaveLength(6);
      expect(team.skaters.map((s) => s.skaterRole)).toEqual(['F', 'F', 'D', 'F', 'F', 'D']);
      expect(new Set(team.skaters.map((s) => s.playerId)).size).toBe(6);
      expect(team.goalie.playerId).not.toBe('');
      expect(team.goalie.name.length).toBeGreaterThan(0);
      expect(team.config.code).toBe(team.code);
    }
    expect(config.home.code).toBe('Det');
    expect(config.away.code).toBe('HFD');
  });

  it('honours a lineup the player chose', () => {
    const roster = rosterFor('Det');
    const base = buildDefaultLineup(roster);
    // Swap the two lines around: still legal, plainly different.
    const swapped: Lineup = { ...base, lines: [base.lines[1], base.lines[0]] };

    const config = buildMatchConfig(
      1,
      defaultSettings(),
      { teamCode: 'Det', lineup: swapped },
      { teamCode: 'TSP', lineup: null },
    );
    expect(config.home.skaters.slice(0, 3).map((s) => s.playerId)).toEqual(
      swapped.lines[0].skaterIds,
    );
  });

  it('falls back to the auto-built lines when the chosen ones do not hold up', () => {
    // The last gate before untrusted data becomes simulation input.
    const roster = rosterFor('Det');
    const forged: Lineup = {
      teamCode: 'Det',
      goalieId: 'not-a-real-player',
      lines: [{ skaterIds: ['x', 'y', 'z'] }, { skaterIds: ['p', 'q', 'r'] }],
    };
    const config = buildMatchConfig(
      1,
      defaultSettings(),
      { teamCode: 'Det', lineup: forged },
      { teamCode: 'TSP', lineup: null },
    );
    expect(config.home.goalie.playerId).toBe(buildDefaultLineup(roster).goalieId);
  });

  it('ignores a lineup for a different franchise than the seat picked', () => {
    const config = buildMatchConfig(
      1,
      defaultSettings(),
      { teamCode: 'Det', lineup: buildDefaultLineup(rosterFor('TSP')) },
      { teamCode: 'TSP', lineup: null },
    );
    expect(config.home.code).toBe('Det');
    for (const skater of config.home.skaters) {
      expect(rosterFor('Det').some((player) => player.id === skater.playerId)).toBe(true);
    }
  });

  it('produces something the simulation will actually run', () => {
    // The point of the whole module: a config the server builds out of real
    // league data has to be simulatable, not merely well-typed.
    const config = buildMatchConfig(
      99,
      defaultSettings(),
      { teamCode: 'MNS', lineup: null },
      { teamCode: 'CGS', lineup: null },
    );
    const state = createMatch(config);
    for (let i = 0; i < 600; i++) stepMatch(state, {}, config);
    expect(state.tick).toBe(600);
    expect(Number.isFinite(state.puck.x)).toBe(true);
    expect(Number.isFinite(state.puck.y)).toBe(true);
    expect(state.skaters.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true);
  });
});
