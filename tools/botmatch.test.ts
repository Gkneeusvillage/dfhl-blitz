/**
 * End-to-end netcode coverage for `npm test`.
 *
 * Everything else in the suite tests the simulation or a server module in
 * isolation. This is the only test that puts a real socket between them, and it
 * is the one that would catch a protocol change on one side that the other never
 * heard about.
 *
 * KEPT SHORT AND SEEDED. The match is one 12-second period, so a full run
 * including the overtime it will almost certainly need lands well inside the
 * timeout. A flaky network test gets ignored, and an ignored test is worse than
 * no test — so the thresholds below have deliberate slack and the assertions are
 * about AGREEMENT rather than about any particular scoreline.
 */

import { describe, expect, it } from 'vitest';
import { NETWORK, SNAPSHOT_RATE } from '@dfhl/shared';

import { runBotMatch } from './botmatch.js';
import { RUBRIC_LINK } from './wiretap.js';

/** One period this short nearly always ends level, so overtime is the norm here. */
const PERIOD_SECONDS = 12;

describe('bot match over a real socket', () => {
  it('plays to a final that the server and both clients agree on', async () => {
    const result = await runBotMatch({
      periods: 1,
      periodSeconds: PERIOD_SECONDS,
      verbose: false,
    });

    // The whole point: nobody watched a different game.
    expect(result.disagreements).toEqual([]);

    // A match that ends 0-0 with no shots would "agree" while proving nothing,
    // so confirm real hockey actually happened over the wire.
    const [home] = result.reports;
    expect(home.snapshots).toBeGreaterThan(SNAPSHOT_RATE * 5);
    expect(home.inputsSent).toBeGreaterThan(300);
    expect(home.finalScore).not.toBeNull();

    // Prediction on a local socket should be all but exact. Generous ceiling:
    // this is a regression guard, not the tuning target.
    expect(result.p95ErrorFeet).toBeLessThan(1);
    expect(result.snaps).toBe(0);

    expect(result.roomDisposed).toBe(true);
    expect(result.snapshotHz).toBeGreaterThan(SNAPSHOT_RATE * 0.9);
  }, 240_000);

  it('still agrees at 150 ms and 2% loss', async () => {
    const result = await runBotMatch({
      periods: 1,
      periodSeconds: PERIOD_SECONDS,
      impairment: RUBRIC_LINK,
      verbose: false,
    });

    expect(result.disagreements).toEqual([]);
    expect(result.roomDisposed).toBe(true);

    /*
     * p95, not max. A control mismatch — the server handing this seat a different
     * skater than the client predicted, because auto-switch keys off proximity to
     * a puck that remote players are moving — measures the gap between two
     * different players and reads as tens of feet without anything having
     * desynced. Asserting on `max` would be asserting that auto-switch never
     * disagrees under loss, which is not a property this netcode has or needs.
     */
    expect(result.p95ErrorFeet).toBeLessThan(NETWORK.reconcileSnapThreshold);
  }, 240_000);
});
