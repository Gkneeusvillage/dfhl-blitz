/**
 * The line score — goals by period — which nothing else in the system records.
 *
 * `GameSimState` carries a running score and per-player stats, and `MatchEnd`
 * carries both. Neither carries when the goals went in, and `shared/**` and
 * `server/**` are frozen, so a post-game screen that wants "1  0  2  —  3" has
 * to derive it. This watches the score change while the match plays and
 * attributes each goal to whatever period was on the clock at the time.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS HONESTLY WORTH
 *
 * It observes the interpolated render view, which means it only sees the frames
 * this client actually drew. Alt-tab for a minute — where `requestAnimationFrame`
 * stops entirely — and a goal scored in the first period and a period change can
 * both be absorbed into one observation, putting those goals in the wrong row.
 * The total always agrees with the authoritative final score, because it is
 * accumulated from score deltas rather than counted independently; only the
 * split between rows can be wrong, and only after the player stopped watching.
 * That is the right trade for a screenshot: a wrong final score would be a lie,
 * a mis-attributed period after an alt-tab is a curiosity.
 *
 * A server-side line score is the real fix and it is one field on `MatchEnd`.
 * Recorded in the report rather than reached for, because those files are frozen.
 */

import type { GamePhase, Score } from '@dfhl/shared';

export interface PeriodLine {
  /** "P1", "OT", "SO". */
  readonly label: string;
  home: number;
  away: number;
}

export class PeriodLog {
  private readonly regulationPeriods: number;
  private readonly rows: PeriodLine[] = [];
  private last: Score = { home: 0, away: 0 };

  /**
   * The shootout is a tally of attempts, not of goals, and the winner's single
   * added goal must not also land in a period row.
   */
  private shootout: Score | null = null;

  constructor(regulationPeriods: number) {
    this.regulationPeriods = Math.max(1, regulationPeriods);
  }

  /** Feed one frame of the render view. Cheap enough to call at frame rate. */
  observe(period: number, phase: GamePhase, score: Score, shootoutScore: Score): void {
    if (phase === 'shootout' || this.shootout !== null) {
      this.shootout = { home: shootoutScore.home, away: shootoutScore.away };
      // Deliberately not advancing `last`: once a shootout has begun, every
      // further change to the running score is the winner's ceremonial goal.
      return;
    }

    const row = this.rowFor(labelFor(period, this.regulationPeriods));
    row.home += Math.max(0, score.home - this.last.home);
    row.away += Math.max(0, score.away - this.last.away);
    this.last = { home: score.home, away: score.away };
  }

  /** The line score, in order, with the shootout appended if one happened. */
  lines(): PeriodLine[] {
    const out = this.rows.map((row) => ({ ...row }));
    if (this.shootout !== null) {
      out.push({ label: 'SO', home: this.shootout.home, away: this.shootout.away });
    }
    return out;
  }

  private rowFor(label: string): PeriodLine {
    const existing = this.rows.find((row) => row.label === label);
    if (existing !== undefined) return existing;
    const created: PeriodLine = { label, home: 0, away: 0 };
    this.rows.push(created);
    return created;
  }
}

function labelFor(period: number, regulationPeriods: number): string {
  return period > regulationPeriods ? 'OT' : `P${period}`;
}
