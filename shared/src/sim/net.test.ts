/**
 * Net geometry: the posts, and the band of the goal line that actually scores.
 *
 * Both halves of the post fix are load-bearing and neither was visible to any
 * other test in the suite, because the fuzz frozen-puck detector only trips after
 * 180 ticks and an AI skater collects a post-parked puck in about nine:
 *
 *  1. A deflection must leave the puck moving. Seating it exactly on the contact
 *     circle and giving it none of the tick back leaves the next sweep starting
 *     inside that circle, `sweepPointCircle` returns 0 for that, and the puck is
 *     placed back at its own origin — pinned forever, spraying a `post` event
 *     every tick. A full AI match produced 139 post events against 117 shots when
 *     that was live. `POST_SEPARATION` and the carry-through each prevent it on
 *     their own, so the mutation these tests catch is losing both.
 *  2. The posts must sit one radius OUTSIDE the mouth. Centred on the mouth edge
 *     they eat 0.35 ft of net per side while `goalCrossing` still counts that band
 *     as a goal, so the puck gets waved off by a post it should have missed.
 *
 * These tests drive `stepLoosePuck` rather than `stepMatch`: with no skaters on
 * the ice and both goalies parked in a corner, the only thing left in the answer
 * is the geometry under test.
 */

import { describe, expect, it } from 'vitest';

import { createMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { stepLoosePuck } from './puck.js';
import { goalPosts } from '../rink.js';
import { Rng } from '../rng.js';
import { PUCK, RINK, TICK_RATE } from '../tuning.js';
import type { GameSimState, SimEvent } from '../types.js';
import type { SimContext } from './context.js';

/** The away net's posts, i.e. the ones home shoots at. */
const POST_Y = RINK.goalHalfWidth + RINK.postRadius;

/**
 * How far off the centre line a puck's CENTRE may cross and still score.
 *
 * Not `goalHalfWidth`: a 1 ft puck cannot pass through a 6 ft mouth with its
 * centre closer than its own radius to a post, so the reachable band is 2.5 ft
 * either way rather than 3. That is correct physics and it is what the post sweep
 * enforces — but it is 0.5 ft narrower than `RINK.goalHalfWidth` reads, which is
 * worth writing down where somebody aiming a shot will find it.
 */
const SCORING_BAND = RINK.goalHalfWidth - PUCK.radius;

interface Scene {
  ctx: SimContext;
  state: GameSimState;
}

/** A loose puck alone on the sheet, with nothing but the nets left to hit. */
function loosePuck(x: number, y: number, vx: number, vy: number): Scene {
  const config = makeTestMatchConfig({ seed: 0x5eed1234, periodSeconds: 600 });
  const state = createMatch(config);
  state.phase = 'play';
  state.phaseTimer = 0;
  state.clock = 600 * TICK_RATE;

  for (const skater of state.skaters) {
    skater.onIce = false;
    skater.x = (skater.slot - 2.5) * 9;
    skater.y = skater.side === 'home' ? 38 : -38;
  }
  // Out of the crease entirely: a goalie in the way would answer the shot before
  // the post ever got a chance to.
  for (const goalie of state.goalies) {
    goalie.x = goalie.side === 'home' ? -60 : 60;
    goalie.y = goalie.side === 'home' ? 30 : -30;
  }

  state.puck.carrierId = null;
  state.puck.x = x;
  state.puck.y = y;
  state.puck.vx = vx;
  state.puck.vy = vy;
  state.puck.pickupCooldown = 0;

  const events: SimEvent[] = [];
  return { ctx: { state, config, inputs: {}, rng: new Rng(state.rng), events }, state };
}

describe('the goal mouth', () => {
  it('scores a puck whose centre crosses inside the reachable band', () => {
    /*
     * 2.4 ft is inside the 2.5 ft band and 0.95 ft from the post's contact
     * circle. Move the posts back onto the mouth edge and that circle's inner
     * edge climbs from 2.5 to 2.15, so this crossing rings iron instead — which
     * is the exact defect commit 42c0967 fixed, and the reason this test exists.
     */
    const y = 2.4;
    expect(y).toBeLessThan(SCORING_BAND);

    const { ctx } = loosePuck(88.4, y, 1, 0);
    const outcome = stepLoosePuck(ctx);

    expect(outcome).toEqual({ kind: 'goal', conceding: 'away' });
    expect(ctx.events).toEqual([]);
  });

  it('scores it from the other end too, so the fix is not one-sided', () => {
    const { ctx } = loosePuck(-88.4, -2.4, -1, 0);
    expect(stepLoosePuck(ctx)).toEqual({ kind: 'goal', conceding: 'home' });
  });

  it('rings iron just outside that band', () => {
    // The complement of the test above: at 2.6 the puck genuinely overlaps the
    // post, so this is a post and not a goal. Together the two pin the offset
    // from both directions — widening it as well as narrowing it turns one red.
    const { ctx } = loosePuck(88.4, 2.6, 1, 0);
    const outcome = stepLoosePuck(ctx);

    expect(outcome.kind).toBe('none');
    expect(ctx.events.map((event) => event.type)).toEqual(['post']);
  });

  it('scores dead centre, as a control', () => {
    const { ctx } = loosePuck(88.4, 0, 1, 0);
    expect(stepLoosePuck(ctx).kind).toBe('goal');
  });
});

describe('a puck off the post', () => {
  /** Step a scene until something ends the puck's life, reporting what happened. */
  function ring(scene: Scene, ticks: number) {
    const { ctx, state } = scene;
    let posts = 0;
    let repeatedPositions = 0;
    let outcome = 'none';
    let previousX = state.puck.x;
    let previousY = state.puck.y;

    for (let tick = 0; tick < ticks; tick++) {
      ctx.events.length = 0;
      const result = stepLoosePuck(ctx);
      for (const event of ctx.events) if (event.type === 'post') posts++;

      // The signature of the bug, measured directly: a puck that occupies the
      // same coordinate two ticks running while it still has velocity.
      const speed = Math.sqrt(state.puck.vx ** 2 + state.puck.vy ** 2);
      if (speed > 0 && state.puck.x === previousX && state.puck.y === previousY) {
        repeatedPositions++;
      }
      previousX = state.puck.x;
      previousY = state.puck.y;

      if (result.kind !== 'none') {
        outcome = result.kind;
        break;
      }
    }
    return { posts, repeatedPositions, outcome };
  }

  it('comes off it and keeps moving, every tick, instead of parking on it', () => {
    /*
     * Fired straight down the line of the post, the worst case: the deflection
     * is head-on, so there is no lateral travel to carry the puck clear of the
     * contact circle. With the pre-42c0967 post branch — seated on the circle and
     * given none of the tick back — this pins at the contact point and emits a
     * post event on all 400 ticks.
     *
     * Measured as it stands: 2 posts (the puck comes back down the ice and hits
     * the matching post at the other end), 0 repeated positions.
     */
    const scene = loosePuck(70, POST_Y, 2, 0);
    const result = ring(scene, 400);

    expect(result.repeatedPositions).toBe(0);
    expect(result.posts).toBeLessThanOrEqual(4);
    expect(result.posts).toBeGreaterThan(0);
  });

  it('carries its remaining travel through the deflection', () => {
    // A post hit costs no distance: the puck resolves the bounce partway through
    // the tick and spends what is left of it. Parked on the post it would move
    // nothing at all, so this is the same defect measured as a distance.
    const scene = loosePuck(70, POST_Y, 2, 0);
    const before = { x: scene.state.puck.x, y: scene.state.puck.y };

    let contactTick = -1;
    for (let tick = 0; tick < 40 && contactTick < 0; tick++) {
      scene.ctx.events.length = 0;
      stepLoosePuck(scene.ctx);
      if (scene.ctx.events.some((event) => event.type === 'post')) contactTick = tick;
    }

    expect(contactTick).toBeGreaterThanOrEqual(0);
    const travelled = Math.abs(scene.state.puck.x - before.x);
    // Nine clean ticks at 2 ft plus whatever the bounce tick was worth.
    expect(travelled).toBeGreaterThan(15);
  });

  it('ends the deflection tick strictly clear of every post', () => {
    /*
     * The geometric statement of the invariant, rather than its symptom: a puck
     * left sitting on or inside a post's contact circle is a puck the next
     * tick's sweep can report a fresh t = 0 contact against. Both `POST_SEPARATION`
     * and the carry-through exist to keep this true, and either one alone does —
     * which is why the freeze only comes back when both are removed.
     */
    const scene = loosePuck(70, POST_Y, 2, 0);
    let contacted = false;
    for (let tick = 0; tick < 40 && !contacted; tick++) {
      scene.ctx.events.length = 0;
      stepLoosePuck(scene.ctx);
      contacted = scene.ctx.events.some((event) => event.type === 'post');
    }
    expect(contacted).toBe(true);

    for (const side of ['home', 'away'] as const) {
      for (const post of goalPosts(side)) {
        const gap = Math.hypot(scene.state.puck.x - post.x, scene.state.puck.y - post.y);
        expect(gap).toBeGreaterThan(post.radius + PUCK.radius);
      }
    }
  });

  it('can deflect in off the post rather than always being waved off', () => {
    // 2.7 ft clips the post on the way past and the deflection carries it over
    // the line. Worth pinning: it is the difference between a post being a wall
    // and a post being part of the net.
    const scene = loosePuck(70, 2.7, 2, 0);
    const result = ring(scene, 60);

    expect(result.posts).toBe(1);
    expect(result.outcome).toBe('goal');
    expect(result.repeatedPositions).toBe(0);
  });
});
