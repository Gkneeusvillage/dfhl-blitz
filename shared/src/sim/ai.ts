/**
 * AI for every skater no seat is currently driving.
 *
 * The AI produces a `PlayerInput` and nothing else. It has exactly the same
 * vocabulary as a human — a stick and three buttons — which is what keeps CPU
 * teammates from being able to do things a player cannot, and keeps the sim's
 * only entry point honest.
 */

import { AI, CHECKING, PUCK, RINK } from '../tuning.js';
import { attackingGoalX, clamp, defendingGoalX, distance } from '../rink.js';
import { quantizeAxis } from '../types.js';
import type { PlayerInput, SkaterSimState, TeamSide } from '../types.js';
import type { SimContext } from './context.js';
import { puckCarrier } from './context.js';
import { speedOf } from './physics.js';
import { oneTimerTicks } from './actions.js';

function steer(tick: number, targetX: number, targetY: number, from: SkaterSimState): PlayerInput {
  const dx = targetX - from.x;
  const dy = targetY - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-3) {
    return {
      tick,
      moveX: 0,
      moveY: 0,
      shoot: false,
      pass: false,
      turbo: false,
      switchPlayer: false,
    };
  }
  return {
    tick,
    moveX: quantizeAxis(dx / len),
    moveY: quantizeAxis(dy / len),
    shoot: false,
    pass: false,
    turbo: false,
    switchPlayer: false,
  };
}

/** On-ice skater of `side` closest to a point, tie-broken by slot so it is stable. */
export function nearestOnIce(
  ctx: SimContext,
  side: TeamSide,
  x: number,
  y: number,
  exclude?: SkaterSimState,
): SkaterSimState | null {
  let best: SkaterSimState | null = null;
  let bestDist = Infinity;
  for (const skater of ctx.state.skaters) {
    if (skater.side !== side || !skater.onIce || skater === exclude) continue;
    const dist = distance(skater.x, skater.y, x, y);
    if (dist < bestDist) {
      bestDist = dist;
      best = skater;
    }
  }
  return best;
}

/** Where a loose puck will be once a chaser can plausibly get to it. */
function interceptPoint(ctx: SimContext): { x: number; y: number } {
  const puck = ctx.state.puck;
  return {
    x: puck.x + puck.vx * AI.puckInterceptLookaheadTicks,
    y: puck.y + puck.vy * AI.puckInterceptLookaheadTicks,
  };
}

/**
 * Where the puck was `AI.reactionTicks` ago.
 *
 * Off-puck AI aims at this rather than at the live puck, which is what keeps CPU
 * skaters a half-beat behind the play and therefore beatable.
 */
function laggedPuck(ctx: SimContext): { x: number; y: number } {
  const puck = ctx.state.puck;
  return {
    x: puck.x - puck.vx * AI.reactionTicks,
    y: puck.y - puck.vy * AI.reactionTicks,
  };
}

function nearestOpponentDistance(ctx: SimContext, skater: SkaterSimState): number {
  let best = Infinity;
  for (const other of ctx.state.skaters) {
    if (other.side === skater.side || !other.onIce) continue;
    const dist = distance(skater.x, skater.y, other.x, other.y);
    if (dist < best) best = dist;
  }
  return best;
}

/** Carrying the puck: drive the net, move it when pressured, shoot when in range. */
function carrierInput(ctx: SimContext, skater: SkaterSimState): PlayerInput {
  const tick = ctx.state.tick;
  const goalX = attackingGoalX(skater.side);
  const range = distance(skater.x, skater.y, goalX, 0);
  const pressure = nearestOpponentDistance(ctx, skater);

  // Attack the near post side rather than driving straight into the goalie.
  const laneY = clamp(skater.y, -RINK.faceoffDotY, RINK.faceoffDotY);
  const input = steer(tick, goalX, laneY * 0.35, skater);

  if (oneTimerTicks(ctx) > 0 && range < AI.shootRange) {
    input.shoot = true;
    return input;
  }
  if (range < AI.shootRange && ctx.rng.chance(AI.shootUrge)) {
    input.shoot = true;
    return input;
  }
  const wantsPass = pressure < AI.pressureDistance || ctx.rng.chance(AI.passUrge);
  if (wantsPass) {
    input.pass = true;
    return input;
  }
  input.turbo = skater.turbo > AI.turboMinMeter && pressure < AI.turboDistance;
  return input;
}

/** A teammate has it: get open on the far side of the carrier's lane. */
function supportInput(ctx: SimContext, skater: SkaterSimState, carrier: SkaterSimState): PlayerInput {
  const tick = ctx.state.tick;
  const goalX = attackingGoalX(skater.side);
  const towardGoal = Math.sign(goalX - carrier.x) || 1;

  // Sit ahead of the carrier and on the opposite side of the ice, which is what
  // makes the cross-crease one-timer available.
  const side = skater.y >= carrier.y ? 1 : -1;
  const targetX = clamp(
    carrier.x + towardGoal * AI.supportDistance * 0.5,
    -RINK.goalLineX + 4,
    RINK.goalLineX - 4,
  );
  const targetY = clamp(carrier.y + side * AI.supportOffset, -RINK.halfWidth + 6, RINK.halfWidth - 6);

  const input = steer(tick, targetX, targetY, skater);
  input.turbo =
    skater.turbo > AI.turboMinMeter && distance(skater.x, skater.y, targetX, targetY) > AI.turboDistance;
  return input;
}

/** Nobody on our side has it: the closest skater goes and gets it. */
function chaseInput(ctx: SimContext, skater: SkaterSimState): PlayerInput {
  const tick = ctx.state.tick;
  const target = interceptPoint(ctx);
  const input = steer(tick, target.x, target.y, skater);
  const gap = distance(skater.x, skater.y, target.x, target.y);
  input.turbo = skater.turbo > AI.turboMinMeter && gap > AI.turboDistance;

  // Reach in as soon as the puck is on an opponent's stick and within a stick's length.
  const carrier = puckCarrier(ctx.state);
  if (
    carrier !== null &&
    carrier.side !== skater.side &&
    distance(skater.x, skater.y, carrier.x, carrier.y) < CHECKING.checkRadius &&
    ctx.rng.chance(AI.checkUrge)
  ) {
    input.pass = true;
  }
  return input;
}

/** Everyone else on defence: sit between the puck and our own net. */
function postUpInput(ctx: SimContext, skater: SkaterSimState): PlayerInput {
  const tick = ctx.state.tick;
  const ownGoalX = defendingGoalX(skater.side);
  const puck = laggedPuck(ctx);

  const dx = puck.x - ownGoalX;
  const dy = puck.y - 0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const targetX = ownGoalX + (dx / len) * AI.defensivePostDistance;
  const targetY = (dy / len) * AI.defensivePostDistance;

  const input = steer(tick, targetX, targetY, skater);
  input.turbo =
    skater.turbo > AI.turboMinMeter && distance(skater.x, skater.y, targetX, targetY) > AI.turboDistance;
  return input;
}

/**
 * One tick of intent for an AI skater.
 *
 * Deliberately stateless: the decision is recomputed from the world every tick,
 * so there is nothing extra to serialize and nothing that can drift between the
 * server's copy of the match and a client's.
 */
export function aiInput(ctx: SimContext, skater: SkaterSimState): PlayerInput {
  const { state } = ctx;
  const carrier = puckCarrier(state);

  if (carrier === skater) return carrierInput(ctx, skater);
  if (carrier !== null && carrier.side === skater.side) return supportInput(ctx, skater, carrier);

  // Loose or on an opponent's stick: exactly one skater per side goes to the puck.
  const puckTarget = state.puck.carrierId === null ? interceptPoint(ctx) : { x: state.puck.x, y: state.puck.y };
  const chaser = nearestOnIce(ctx, skater.side, puckTarget.x, puckTarget.y);
  if (chaser === skater) return chaseInput(ctx, skater);
  return postUpInput(ctx, skater);
}

/**
 * The shootout is a different game: skate in and pick a moment to shoot.
 * A goalie who never has to respect a pass would otherwise never be beaten.
 */
export function shootoutInput(ctx: SimContext, skater: SkaterSimState): PlayerInput {
  const tick = ctx.state.tick;
  const goalX = attackingGoalX(skater.side);
  const range = Math.abs(goalX - skater.x);

  const drift = Math.sin(tick * 0.05) * RINK.goalHalfWidth;
  const input = steer(tick, goalX, drift, skater);
  input.turbo = skater.turbo > AI.turboMinMeter && range > AI.shootRange;
  if (range < AI.shootRange * 0.55 && ctx.rng.chance(AI.shootUrge * 1.5)) input.shoot = true;
  return input;
}

/** True once a loose puck has essentially stopped, used by the shootout to wave off an attempt. */
export function puckAtRest(ctx: SimContext): boolean {
  return ctx.state.puck.carrierId === null && speedOf(ctx.state.puck) <= PUCK.restSpeed;
}
