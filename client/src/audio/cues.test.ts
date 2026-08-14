/**
 * The event-to-feel mapping.
 *
 * `playEvents` is testable under node precisely because the synth is inert
 * without an AudioContext: with no context it drops every sound and the cue
 * arithmetic runs untouched. So these cover the half that can be wrong quietly —
 * which team the goal light belongs to, and how hard the screen shakes — rather
 * than whether a horn sounds.
 */

import { describe, expect, it } from 'vitest';
import { PUCK } from '@dfhl/shared';
import type { SimEvent } from '@dfhl/shared';

import { playEvents } from './index.js';

const event = (over: Partial<SimEvent> & Pick<SimEvent, 'type'>): SimEvent => ({
  tick: 1,
  ...over,
});

describe('goal cues', () => {
  it('lights the lamp for the side that SCORED, not the side that conceded', () => {
    /*
     * `rules.ts` sets `side: scoringSide` on a goal event. Getting this backwards
     * flashes the opponent's colour on every goal, which looks like a rendering
     * bug rather than an inverted field — so it is pinned here.
     */
    expect(playEvents([event({ type: 'goal', side: 'home' })]).goalFor).toBe('home');
    expect(playEvents([event({ type: 'goal', side: 'away' })]).goalFor).toBe('away');
  });

  it('reports no goal on a frame without one', () => {
    expect(playEvents([event({ type: 'shot', power: 2 })]).goalFor).toBeNull();
    expect(playEvents([]).goalFor).toBeNull();
  });

  it('shakes hardest for a goal', () => {
    const goal = playEvents([event({ type: 'goal', side: 'home' })]).shake;
    const hit = playEvents([event({ type: 'hit', power: PUCK.maxSpeed })]).shake;
    expect(goal).toBeGreaterThan(hit);
  });
});

describe('shake', () => {
  it('scales with how hard the hit landed', () => {
    const soft = playEvents([event({ type: 'hit', power: PUCK.maxSpeed * 0.2 })]).shake;
    const hard = playEvents([event({ type: 'hit', power: PUCK.maxSpeed })]).shake;
    expect(hard).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(0);
  });

  it('accumulates across a busy frame but stays bounded', () => {
    const busy = playEvents([
      event({ type: 'goal', side: 'away' }),
      event({ type: 'hit', power: PUCK.maxSpeed }),
      event({ type: 'post' }),
      event({ type: 'save', power: PUCK.maxSpeed }),
      event({ type: 'hit', power: PUCK.maxSpeed }),
    ]).shake;
    expect(busy).toBeGreaterThan(1);
    // Unbounded shake in a goalmouth scramble is nausea, not impact.
    expect(busy).toBeLessThanOrEqual(1.5);
  });

  it('stays silent and still for possession churn', () => {
    /*
     * `turnover` fires on every change of possession, which in three-on-three is
     * constant. A cue on each one turns the match into a rattle.
     */
    const cue = playEvents([
      event({ type: 'turnover' }),
      event({ type: 'turnover' }),
      event({ type: 'turnover' }),
    ]);
    expect(cue.shake).toBe(0);
    expect(cue.goalFor).toBeNull();
  });

  it('treats an event with no power as full strength rather than zero', () => {
    // A whistle has no `power`; reading that as 0 would silence it entirely.
    expect(playEvents([event({ type: 'post' })]).shake).toBeGreaterThan(0);
  });
});
