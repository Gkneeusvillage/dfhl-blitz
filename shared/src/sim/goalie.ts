/**
 * Goalie AI and save resolution.
 *
 * The design target is "fair but beatable": routine shots from the outside are
 * stopped ~3 times in 4, while anything that arrives before the goalie can react
 * — point blank, a one-timer, a cross-crease rebound — goes in.
 *
 * Two mechanisms produce that, and neither of them is a dice roll on the shot:
 *
 *  1. REACTION WINDOW. The goalie only commits to a lunge if the shot still has
 *     at least `reactionTicks` of flight left. A shot released inside that window
 *     is never reacted to at all, so beating a goalie is about *where you shoot
 *     from*, not about luck.
 *  2. READ ERROR. When the goalie does react, it guesses where the puck will
 *     cross the goal line and is wrong by up to `readError` feet. That error, not
 *     the goalie's reach, is what decides the rest of the saves.
 *
 * The save test itself is pure geometry: a swept circle against the goalie's body.
 */

import { GOALIE, PUCK, RINK, lerpAttr } from '../tuning.js';
import { clamp, defendingGoalX, distance } from '../rink.js';
import { otherSide } from '../types.js';
import type { GoalieSimState, TeamSide } from '../types.js';
import type { SimContext } from './context.js';
import { goalieAttrs, goalieFor } from './context.js';
import { speedOf, sweepPointCircle } from './physics.js';

/** Ticks until a loose puck reaches the given goal line, or Infinity if it never will. */
function ticksToGoalLine(ctx: SimContext, side: TeamSide): number {
  const puck = ctx.state.puck;
  const goalX = defendingGoalX(side);
  const toward = goalX - puck.x;
  if (Math.abs(puck.vx) < 1e-6) return Infinity;
  const ticks = toward / puck.vx;
  return ticks > 0 ? ticks : Infinity;
}

/** Where the puck would cross this side's goal line if nothing touched it. */
function predictedCrossing(ctx: SimContext, side: TeamSide, ticks: number): number {
  return ctx.state.puck.y + ctx.state.puck.vy * ticks;
}

/**
 * The angle-cutting spot: on the line from the puck to the middle of the net,
 * out as far as the goalie dares. Better `positioning` means coming out further,
 * which shrinks the visible net.
 */
function trackingTarget(ctx: SimContext, goalie: GoalieSimState): { x: number; y: number } {
  const attrs = goalieAttrs(ctx.config, goalie);
  const puck = ctx.state.puck;
  const goalX = defendingGoalX(goalie.side);
  const inward = goalie.side === 'home' ? 1 : -1;

  const dx = puck.x - goalX;
  const dy = puck.y - 0;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Puck behind the net or on the far side of the sheet: hug the middle of the crease.
  if (dist < 1e-3 || dx * inward <= 0) {
    return { x: goalX + inward * GOALIE.restDepth, y: 0 };
  }

  // Challenge harder as the shooter closes, but never skate out past the puck itself.
  const aggression = clamp(1 - dist / GOALIE.challengeRange, 0, 1);
  const depth = Math.min(
    GOALIE.restDepth +
      lerpAttr(attrs.positioning, 0, GOALIE.maxChallengeDepth - GOALIE.restDepth) * aggression,
    Math.max(GOALIE.restDepth, dist - GOALIE.radius),
  );

  return {
    x: goalX + (dx / dist) * depth,
    y: clamp((dy / dist) * depth, -GOALIE.maxLateralOffset, GOALIE.maxLateralOffset),
  };
}

/**
 * Decide whether to launch a lunge this tick.
 *
 * A lunge is stored purely as velocity plus a countdown — GoalieSimState has vx/vy
 * for exactly this — so no extra state is needed to remember where the goalie
 * committed to, and the commitment cannot be silently re-rolled next tick.
 */
function considerLunge(ctx: SimContext, goalie: GoalieSimState): void {
  if (goalie.lunge > 0 || goalie.lungeCooldown > 0) return;

  const puck = ctx.state.puck;
  if (puck.carrierId !== null) return;
  const speed = speedOf(puck);
  if (speed < GOALIE.shotDetectSpeed) return;

  const ticks = ticksToGoalLine(ctx, goalie.side);
  if (!Number.isFinite(ticks) || ticks > GOALIE.lungeTriggerTicks) return;

  const attrs = goalieAttrs(ctx.config, goalie);
  const reaction = lerpAttr(attrs.reflexes, GOALIE.reactionTicksLow, GOALIE.reactionTicksHigh);
  // The whole point of the reaction window: too fast to read means no reaction at all.
  if (ticks < reaction) return;

  const crossing = predictedCrossing(ctx, goalie.side, ticks);
  // Do not bite on a puck that is missing the net anyway.
  if (Math.abs(crossing) > RINK.goalHalfWidth + GOALIE.radius) return;

  const error = lerpAttr(attrs.reflexes, GOALIE.readErrorLow, GOALIE.readErrorHigh);
  const guess = clamp(
    crossing + ctx.rng.range(-error, error),
    -GOALIE.maxLateralOffset,
    GOALIE.maxLateralOffset,
  );

  const reach = lerpAttr(attrs.reflexes, GOALIE.lungeReachLow, GOALIE.lungeReachHigh);
  const need = clamp(guess - goalie.y, -reach, reach);
  const span = Math.max(1, Math.min(Math.floor(ticks), GOALIE.lungeTicks));
  const lungeSpeed =
    lerpAttr(attrs.positioning, GOALIE.moveSpeedLow, GOALIE.moveSpeedHigh) *
    GOALIE.lungeSpeedMultiplier;

  goalie.vy = clamp(need / span, -lungeSpeed, lungeSpeed);
  goalie.vx = 0;
  goalie.lunge = GOALIE.lungeTicks;
}

/** Move the goalie for one tick: either riding out a lunge or tracking the puck. */
export function updateGoalie(ctx: SimContext, goalie: GoalieSimState): void {
  if (goalie.lungeCooldown > 0) goalie.lungeCooldown--;

  considerLunge(ctx, goalie);

  if (goalie.lunge > 0) {
    goalie.x += goalie.vx;
    goalie.y += goalie.vy;
    goalie.lunge--;
    if (goalie.lunge === 0) {
      goalie.lungeCooldown = GOALIE.lungeCooldownTicks;
      goalie.vx = 0;
      goalie.vy = 0;
    }
  } else {
    const attrs = goalieAttrs(ctx.config, goalie);
    const speed = lerpAttr(attrs.positioning, GOALIE.moveSpeedLow, GOALIE.moveSpeedHigh);
    const target = trackingTarget(ctx, goalie);
    const dx = target.x - goalie.x;
    const dy = target.y - goalie.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= speed) {
      goalie.vx = dx;
      goalie.vy = dy;
    } else {
      goalie.vx = (dx / dist) * speed;
      goalie.vy = (dy / dist) * speed;
    }
    goalie.x += goalie.vx;
    goalie.y += goalie.vy;
  }

  // The goalie never leaves the paint, whatever the tracking maths asked for.
  const goalX = defendingGoalX(goalie.side);
  const inward = goalie.side === 'home' ? 1 : -1;
  const minX = goalX;
  const maxX = goalX + inward * GOALIE.maxChallengeDepth;
  goalie.x = inward > 0 ? clamp(goalie.x, minX, maxX) : clamp(goalie.x, maxX, minX);
  goalie.y = clamp(goalie.y, -GOALIE.maxLateralOffset, GOALIE.maxLateralOffset);
  goalie.facing = Math.atan2(ctx.state.puck.y - goalie.y, ctx.state.puck.x - goalie.x);
}

export interface SaveResult {
  saved: boolean;
  frozen: boolean;
  /** Fraction of the sweep consumed before contact, for the caller's segment bookkeeping. */
  t: number;
}

/**
 * Test one tick of puck travel against a goalie and, on contact, turn it into a
 * save with either a rebound or a freeze.
 */
export function resolveGoalieSave(
  ctx: SimContext,
  goalie: GoalieSimState,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): SaveResult {
  const puck = ctx.state.puck;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const t = sweepPointCircle(fromX, fromY, dx, dy, goalie.x, goalie.y, GOALIE.radius + PUCK.radius);
  if (t < 0) return { saved: false, frozen: false, t: 1 };

  const attrs = goalieAttrs(ctx.config, goalie);
  const contactX = fromX + dx * t;
  const contactY = fromY + dy * t;
  const incoming = speedOf(puck);

  puck.x = contactX;
  puck.y = contactY;
  puck.carrierId = null;
  puck.lastTouchedBy = goalie.id;
  puck.lastTouchSide = goalie.side;
  ctx.state.stats[goalie.playerId].saves++;

  ctx.events.push({
    type: 'save',
    tick: ctx.state.tick,
    actorId: goalie.id,
    side: goalie.side,
    x: contactX,
    y: contactY,
    power: incoming,
  });

  const freezeChance = lerpAttr(attrs.reboundControl, GOALIE.freezeChanceLow, GOALIE.freezeChanceHigh);
  if (incoming <= GOALIE.freezeMaxSpeed && ctx.rng.chance(freezeChance)) {
    puck.vx = 0;
    puck.vy = 0;
    return { saved: true, frozen: true, t };
  }

  // Rebound: back out along the contact normal, scattered. Better rebound control
  // means it dies at the goalie's feet instead of sitting up in the slot.
  const nx = contactX - goalie.x;
  const ny = contactY - goalie.y;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  const retention = lerpAttr(
    attrs.reboundControl,
    GOALIE.reboundRetentionLow,
    GOALIE.reboundRetentionHigh,
  );
  const speed = Math.max(incoming * retention, GOALIE.reboundMinSpeed);
  const angle =
    Math.atan2(ny / len, nx / len) + ctx.rng.range(-GOALIE.reboundSpread, GOALIE.reboundSpread);
  puck.vx = Math.cos(angle) * speed;
  puck.vy = Math.sin(angle) * speed;
  puck.pickupCooldown = 0;
  return { saved: true, frozen: false, t };
}

/**
 * Smother a slow puck sitting in the blue paint. Without this a rebound can die
 * behind a goalie who has no way to reach it, and play stalls.
 */
export function tryCoverLoosePuck(ctx: SimContext, goalie: GoalieSimState): boolean {
  const puck = ctx.state.puck;
  if (puck.carrierId !== null) return false;
  if (speedOf(puck) > PUCK.restSpeed * 8) return false;
  if (distance(puck.x, puck.y, goalie.x, goalie.y) > GOALIE.radius + PUCK.pickupRadius) return false;

  puck.vx = 0;
  puck.vy = 0;
  puck.lastTouchedBy = goalie.id;
  puck.lastTouchSide = goalie.side;
  ctx.events.push({
    type: 'whistle',
    tick: ctx.state.tick,
    actorId: goalie.id,
    side: goalie.side,
    x: puck.x,
    y: puck.y,
  });
  return true;
}

/** The goalie defending against the given attacking side. */
export function opposingGoalie(ctx: SimContext, attackingSide: TeamSide): GoalieSimState {
  return goalieFor(ctx.state, otherSide(attackingSide));
}
