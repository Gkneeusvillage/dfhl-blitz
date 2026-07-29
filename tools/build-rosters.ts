/**
 * Roster pipeline: data/fantrax-rosters.csv  ->  shared/data/rosters.json
 *
 * OWNED BY: pair A (Data & Rosters). This file is a scaffold placeholder so the
 * repository typechecks; pair A replaces it wholesale.
 *
 * Requirements are specified in OPUS5_GAME_PLAN.md section 3. In brief:
 *   - parse with a real CSV parser (Salary contains commas inside quotes)
 *   - keep only rows whose Status is one of the 14 TEAM_CODES
 *   - derive SkaterAttributes / GoalieAttributes from the Fantrax Score
 *   - emit a RostersFile, and be safely re-runnable
 */

import { TEAM_CODES } from '@dfhl/shared';

console.error(
  `build-rosters is not implemented yet (pair A owns it). Expected ${TEAM_CODES.length} teams.`,
);
process.exit(1);
