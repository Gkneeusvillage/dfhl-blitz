/**
 * The 14 franchises, for anything that has to show a team before a match exists.
 *
 * `teams.config.json` is the league owner's file — display names and colours are
 * theirs to edit, and changing it must never require a code change. It is
 * imported through the `@dfhl/shared` package export rather than by a relative
 * path so the client and the server read the same one file.
 *
 * Once a match starts this module is no longer the source: `MatchConfig` carries
 * each side's resolved `TeamConfig`, so the colours on the ice are the ones the
 * server built the match with, even if the file changed underneath.
 */

import teamsConfigFile from '@dfhl/shared/teams.config.json';
import { TEAM_CODES } from '@dfhl/shared';
import type { TeamCode, TeamConfig, TeamsConfigFile } from '@dfhl/shared';

const file = teamsConfigFile as TeamsConfigFile;

export const TEAM_LIST: readonly TeamConfig[] = TEAM_CODES.map((code) => file.teams[code]);

export function teamConfig(code: TeamCode): TeamConfig {
  return file.teams[code];
}

/** `"#0d47a1"` as the 0xRRGGBB integer Phaser tints with. */
export function colorToInt(hex: string): number {
  const parsed = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : 0xffffff;
}
