/**
 * Lobby settings and the LobbyMessage the room broadcasts on every change.
 *
 * Settings arrive from the host over the wire, so they get the same treatment
 * as everything else a client sends: rebuilt field by field, coerced, and
 * clamped to a range the simulation is known to behave in. A `periodSeconds` of
 * 1e9 would not be a cheat so much as a room that never ends, which is worse.
 */

import { MATCH, TICK_RATE } from '@dfhl/shared';
import type { LobbyMessage } from '@dfhl/shared';
import { toLobbySeats, type SeatTable } from './seats.js';

export interface LobbySettings {
  periods: number;
  periodSeconds: number;
  onFireEnabled: boolean;
}

/**
 * Bounds on what a host may ask for.
 *
 * The floor on `periodSeconds` is a couple of faceoffs' worth of hockey — below
 * `MATCH.faceoffHoldTicks` plus a goal celebration a period could elapse
 * entirely inside a stoppage. The ceiling is arbitrary but finite, which is the
 * property that matters.
 */
export const SETTINGS_LIMITS = {
  minPeriods: 1,
  maxPeriods: 7,
  minPeriodSeconds: Math.ceil((MATCH.faceoffHoldTicks + MATCH.goalCelebrationTicks) / TICK_RATE),
  maxPeriodSeconds: 900,
} as const;

export function defaultSettings(): LobbySettings {
  return {
    periods: MATCH.periods,
    periodSeconds: MATCH.periodSeconds,
    onFireEnabled: true,
  };
}

function clampInteger(value: unknown, low: number, high: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < low) return low;
  if (rounded > high) return high;
  return rounded;
}

/**
 * Fold a `SettingsMessage` into the current settings.
 *
 * Absent fields are left alone — the protocol makes all three optional so a
 * host can nudge one dial without restating the others.
 *
 * @returns the new settings, and whether anything actually changed (the room
 *          only re-broadcasts the lobby when something did).
 */
export function applySettings(
  current: LobbySettings,
  message: unknown,
): { settings: LobbySettings; changed: boolean } {
  if (typeof message !== 'object' || message === null) {
    return { settings: current, changed: false };
  }
  const source = message as Record<string, unknown>;

  const next: LobbySettings = {
    periods:
      source.periods === undefined
        ? current.periods
        : clampInteger(
            source.periods,
            SETTINGS_LIMITS.minPeriods,
            SETTINGS_LIMITS.maxPeriods,
            current.periods,
          ),
    periodSeconds:
      source.periodSeconds === undefined
        ? current.periodSeconds
        : clampInteger(
            source.periodSeconds,
            SETTINGS_LIMITS.minPeriodSeconds,
            SETTINGS_LIMITS.maxPeriodSeconds,
            current.periodSeconds,
          ),
    onFireEnabled:
      source.onFireEnabled === undefined ? current.onFireEnabled : source.onFireEnabled === true,
  };

  const changed =
    next.periods !== current.periods ||
    next.periodSeconds !== current.periodSeconds ||
    next.onFireEnabled !== current.onFireEnabled;

  return { settings: changed ? next : current, changed };
}

export function buildLobbyMessage(
  roomCode: string,
  table: SeatTable,
  settings: LobbySettings,
  inProgress: boolean,
): LobbyMessage {
  return {
    roomCode,
    seats: toLobbySeats(table),
    periodSeconds: settings.periodSeconds,
    periods: settings.periods,
    onFireEnabled: settings.onFireEnabled,
    inProgress,
  };
}
