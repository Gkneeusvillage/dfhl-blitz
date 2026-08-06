/**
 * Possession mechanics: what happens when the puck arrives on a stick.
 *
 * The one-timer is the signature arcade play, and `balance.test.ts` measures how
 * well it converts — but it measures it by arming the window by hand. This file
 * covers the half the rate test cannot: that receiving a pass is what arms the
 * window in the first place, and that an armed window changes what the shoot
 * button does.
 */

import { describe, expect, it } from 'vitest';

import { createMatch, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { PASSING, PUCK, SHOOTING, TICK_RATE } from '../tuning.js';
import type { GameSimState, InputMap, MatchConfig, SimEvent, SkaterSimState } from '../types.js';

const SEAT_ID = 'seat';

interface Scene {
  config: MatchConfig;
  state: GameSimState;
  passer: SkaterSimState;
  receiver: SkaterSimState;
}

/**
 * Two home skaters alone on the ice with the puck sliding from one to the other.
 * Everybody else is on the bench so the only thing that can happen is the
 * reception under test.
 */
function passInFlight(puckY: number, puckSpeed: number): Scene {
  const config = makeTestMatchConfig({ seed: 0x1234abcd, onFireEnabled: false });
  const state = createMatch(config);
  state.phase = 'play';
  state.phaseTimer = 0;
  state.clock = 60 * TICK_RATE;
  state.seats.push({ id: SEAT_ID, side: 'home', nickname: SEAT_ID, connected: true });

  const passer = state.skaters[0];
  const receiver = state.skaters[1];
  for (const skater of state.skaters) {
    if (skater === passer || skater === receiver) continue;
    skater.onIce = false;
    skater.x = (skater.slot - 2.5) * 9;
    skater.y = skater.side === 'home' ? 38 : -38;
    skater.vx = 0;
    skater.vy = 0;
  }

  passer.onIce = true;
  passer.x = 10;
  passer.y = 0;
  passer.vx = 0;
  passer.vy = 0;
  passer.facing = Math.PI / 2;

  receiver.onIce = true;
  receiver.x = 10;
  receiver.y = 14;
  receiver.vx = 0;
  receiver.vy = 0;
  receiver.facing = 0;

  state.puck.carrierId = null;
  state.puck.x = 10;
  state.puck.y = puckY;
  state.puck.vx = 0;
  state.puck.vy = puckSpeed;
  state.puck.lastTouchedBy = passer.id;
  state.puck.lastTouchSide = 'home';
  state.puck.pickupCooldown = 0;
  state.puck.oneTimerTicks = 0;

  return { config, state, passer, receiver };
}

function seatInput(state: GameSimState, shoot: boolean): InputMap {
  return {
    [SEAT_ID]: {
      tick: state.tick + 1,
      moveX: 0,
      moveY: 0,
      shoot,
      pass: false,
      turbo: false,
      switchPlayer: false,
    },
  };
}

/** Run until somebody picks the puck up. Returns the carrier's id. */
function skateUntilCollected(scene: Scene, limit = 120): string | null {
  for (let tick = 0; tick < limit; tick++) {
    stepMatch(scene.state, seatInput(scene.state, false), scene.config);
    if (scene.state.puck.carrierId !== null) return scene.state.puck.carrierId;
  }
  return null;
}

function typesOf(events: SimEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('receiving a pass', () => {
  it('arms the one-timer window and remembers who fed it', () => {
    // 1.6 ft/tick is a normal pass, comfortably over PASSING.receptionSpeed.
    const scene = passInFlight(4, 1.6);
    expect(1.6).toBeGreaterThan(PASSING.receptionSpeed);

    const carrier = skateUntilCollected(scene);

    expect(carrier).toBe(scene.receiver.id);
    expect(scene.state.puck.oneTimerTicks).toBe(SHOOTING.oneTimerWindowTicks);
    expect(scene.state.assistCandidateId).toBe(scene.passer.id);
  });

  it('does not arm on a puck the receiver simply skated up to', () => {
    // Below reception speed: this is a loose puck collected, not a pass taken,
    // and it must not hand out a free one-timer or a free assist.
    const scene = passInFlight(12, 0.15);
    expect(0.15).toBeLessThan(PASSING.receptionSpeed);

    const carrier = skateUntilCollected(scene);

    expect(carrier).toBe(scene.receiver.id);
    expect(scene.state.puck.oneTimerTicks).toBe(0);
    expect(scene.state.assistCandidateId).toBeNull();
  });

  it('fires on the button press while the window is open', () => {
    const scene = passInFlight(4, 1.6);
    expect(skateUntilCollected(scene)).toBe(scene.receiver.id);

    // No windup, no release: the shot goes the instant the button goes down,
    // which is the whole point of the mechanic.
    const events = stepMatch(scene.state, seatInput(scene.state, true), scene.config);

    expect(typesOf(events)).toContain('shot');
    expect(scene.state.puck.carrierId).toBeNull();
    expect(scene.state.puck.oneTimerTicks).toBe(0);
  });

  it('only winds up when the window is not open', () => {
    const scene = passInFlight(12, 0.15);
    expect(skateUntilCollected(scene)).toBe(scene.receiver.id);
    expect(scene.state.puck.oneTimerTicks).toBe(0);

    const events = stepMatch(scene.state, seatInput(scene.state, true), scene.config);

    expect(typesOf(events)).not.toContain('shot');
    expect(scene.state.puck.carrierId).toBe(scene.receiver.id);
    expect(scene.receiver.windup).toBeGreaterThan(0);
  });

  it('lets the window expire if the shot is not taken', () => {
    const scene = passInFlight(4, 1.6);
    expect(skateUntilCollected(scene)).toBe(scene.receiver.id);

    // Hold the puck and do nothing. The window burns down a tick at a time.
    for (let tick = 0; tick < SHOOTING.oneTimerWindowTicks + 2; tick++) {
      stepMatch(scene.state, seatInput(scene.state, false), scene.config);
    }
    expect(scene.state.puck.oneTimerTicks).toBe(0);
    // Still on the same stick — the window closing is not a turnover.
    expect(scene.state.puck.carrierId).toBe(scene.receiver.id);
  });
});

// ---------------------------------------------------------------------------
// Who gets a loose puck
// ---------------------------------------------------------------------------

describe('a loose puck goes to whoever is nearest it', () => {
  /** Two gaps, both inside `PUCK.pickupRadius`, so the loser was genuinely in it. */
  const NEAR = 0.8;
  const FAR = 1.6;

  /**
   * One home skater and one away skater, at chosen distances from a puck sliding
   * between them, and nobody else on the ice. `state.skaters` is always home
   * first, so "home is nearer" and "away is nearer" put the winner at opposite
   * ends of the array — which is the whole point.
   */
  function race(homeGap: number, awayGap: number): string | null {
    const config = makeTestMatchConfig({ seed: 0x1234abcd, onFireEnabled: false });
    const state = createMatch(config);
    state.phase = 'play';
    state.phaseTimer = 0;
    state.clock = 60 * TICK_RATE;

    const home = state.skaters.find((skater) => skater.side === 'home');
    const away = state.skaters.find((skater) => skater.side === 'away');
    if (home === undefined || away === undefined) throw new Error('missing skaters');

    for (const skater of state.skaters) {
      skater.onIce = skater === home || skater === away;
      skater.vx = 0;
      skater.vy = 0;
      skater.stun = 0;
      if (!skater.onIce) {
        skater.x = (skater.slot - 2.5) * 9;
        skater.y = skater.side === 'home' ? 38 : -38;
      }
    }

    // Both stand off the puck's line, on opposite sides, at the given gaps. The
    // puck slides straight between them, so each one's closest approach to its
    // path is exactly its gap.
    home.x = 0;
    home.y = -homeGap;
    away.x = 0;
    away.y = awayGap;

    state.puck.carrierId = null;
    state.puck.x = -0.5;
    state.puck.y = 0;
    state.puck.vx = 1;
    state.puck.vy = 0;
    state.puck.lastTouchedBy = null;
    state.puck.lastTouchSide = null;
    state.puck.pickupCooldown = 0;

    stepMatch(state, {}, config);
    return state.puck.carrierId;
  }

  it('does not simply give it to whoever comes first in the array', () => {
    /*
     * `resolvePickups` scans `state.skaters`, which is home-first for the whole
     * match. First-in-array-wins is a thumb on the scale that never lifts, and
     * nothing in the suite noticed it: reverting to it left all 85 tests green
     * while moving the home share of goals from 49.2% (z = -0.54) to 53.1%
     * (z = 2.19) and the record from 45-55 to 59-41, over 100 identical-roster
     * matches each. `balance.test.ts` only fails a side past 65% of the goals,
     * which is twelve points further out than that.
     *
     * Both orientations, because a test that only ever asks one of them cannot
     * tell nearest-wins from first-wins.
     */
    const homeNearer = race(NEAR, FAR);
    const awayNearer = race(FAR, NEAR);

    expect(homeNearer).toMatch(/^home-/);
    expect(awayNearer).toMatch(/^away-/);
  });

  it('is measuring a real contest — either of them could have had it', () => {
    // The test above is only worth having if the loser was actually in range;
    // otherwise it passes under any rule at all. Both gaps are inside the pickup
    // radius, and each skater collects the puck on their own from the far one.
    expect(FAR).toBeLessThan(PUCK.pickupRadius);
    expect(race(FAR, 90)).toMatch(/^home-/);
    expect(race(90, FAR)).toMatch(/^away-/);
  });
});
