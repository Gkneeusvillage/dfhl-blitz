import { describe, expect, it } from 'vitest';

import { MATCH } from '@dfhl/shared';

import { SETTINGS_LIMITS, applySettings, buildLobbyMessage, defaultSettings } from './lobby.js';
import { claimSeat, createSeatTable } from './seats.js';

describe('defaultSettings', () => {
  it('is whatever tuning.ts says a match is', () => {
    expect(defaultSettings()).toEqual({
      periods: MATCH.periods,
      periodSeconds: MATCH.periodSeconds,
      onFireEnabled: true,
    });
  });
});

describe('applySettings', () => {
  it('changes only the dials the host named', () => {
    const before = defaultSettings();
    const { settings, changed } = applySettings(before, { periodSeconds: 120 });
    expect(changed).toBe(true);
    expect(settings).toEqual({ ...before, periodSeconds: 120 });
  });

  it('reports no change when the values already match', () => {
    const before = defaultSettings();
    const result = applySettings(before, {
      periods: before.periods,
      periodSeconds: before.periodSeconds,
      onFireEnabled: before.onFireEnabled,
    });
    expect(result.changed).toBe(false);
    // Same object, so the room can skip a broadcast on identity alone.
    expect(result.settings).toBe(before);
  });

  it('clamps a period length to something a match can actually be played in', () => {
    const before = defaultSettings();
    expect(applySettings(before, { periodSeconds: 1e9 }).settings.periodSeconds).toBe(
      SETTINGS_LIMITS.maxPeriodSeconds,
    );
    expect(applySettings(before, { periodSeconds: 0 }).settings.periodSeconds).toBe(
      SETTINGS_LIMITS.minPeriodSeconds,
    );
    expect(applySettings(before, { periodSeconds: -60 }).settings.periodSeconds).toBe(
      SETTINGS_LIMITS.minPeriodSeconds,
    );
  });

  it('clamps the period count', () => {
    const before = defaultSettings();
    expect(applySettings(before, { periods: 500 }).settings.periods).toBe(
      SETTINGS_LIMITS.maxPeriods,
    );
    expect(applySettings(before, { periods: 0 }).settings.periods).toBe(SETTINGS_LIMITS.minPeriods);
  });

  it('rounds a fractional period count instead of handing the sim a half period', () => {
    expect(applySettings(defaultSettings(), { periods: 2.6 }).settings.periods).toBe(3);
  });

  it('ignores a value that is not a usable number', () => {
    const before = defaultSettings();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '90', {}, null]) {
      const result = applySettings(before, { periodSeconds: bad });
      expect(result.settings.periodSeconds).toBe(before.periodSeconds);
    }
  });

  it('treats anything that is not exactly `true` as on-fire off', () => {
    const before = defaultSettings();
    expect(applySettings(before, { onFireEnabled: false }).settings.onFireEnabled).toBe(false);
    expect(applySettings(before, { onFireEnabled: 1 }).settings.onFireEnabled).toBe(false);
    expect(applySettings(before, { onFireEnabled: 'true' }).settings.onFireEnabled).toBe(false);
  });

  it('leaves settings alone for a message that is not an object', () => {
    const before = defaultSettings();
    for (const message of [null, undefined, 42, 'periods=9']) {
      const result = applySettings(before, message);
      expect(result.changed).toBe(false);
      expect(result.settings).toBe(before);
    }
  });

  it('has a floor above the stoppages a period contains', () => {
    // A period shorter than its own faceoff hold plus a goal celebration could
    // elapse entirely inside dead time.
    expect(SETTINGS_LIMITS.minPeriodSeconds).toBeGreaterThan(0);
    expect(SETTINGS_LIMITS.minPeriodSeconds).toBeLessThan(MATCH.periodSeconds);
  });
});

describe('buildLobbyMessage', () => {
  it('carries the room code, the seats, the settings, and whether play is under way', () => {
    const table = createSeatTable();
    claimSeat(table, 'a', 'Gordie');
    claimSeat(table, 'b', 'Ted');
    const settings = { periods: 2, periodSeconds: 120, onFireEnabled: false };

    expect(buildLobbyMessage('7GK2', table, settings, false)).toEqual({
      roomCode: '7GK2',
      seats: [
        {
          seatId: 'a',
          nickname: 'Gordie',
          side: 'home',
          teamCode: null,
          ready: false,
          connected: true,
          isHost: true,
        },
        {
          seatId: 'b',
          nickname: 'Ted',
          side: 'away',
          teamCode: null,
          ready: false,
          connected: true,
          isHost: false,
        },
      ],
      periods: 2,
      periodSeconds: 120,
      onFireEnabled: false,
      inProgress: false,
    });
  });

  it('reports a match in progress so a late joiner knows it is watching', () => {
    const table = createSeatTable();
    claimSeat(table, 'a', 'Gordie');
    expect(buildLobbyMessage('7GK2', table, defaultSettings(), true).inProgress).toBe(true);
  });
});
