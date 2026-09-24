/**
 * Skater movement: turning, acceleration, the turbo meter, puck carrying, and
 * recovery from a check.
 *
 * Feel note: a skater accelerates along the direction they are *facing*, and the
 * facing turns toward the stick input. That choice is what makes carving around
 * a defender feel like skating rather than like a twin-stick shooter.
 *
 * A skater a person is driving handles more sharply (`HANDLING` in tuning.ts,
 * which says why it is not everyone): quicker turns from a standstill, edge grip
 * that swings existing momentum round with the facing, a hockey stop when the
 * stick is pulled back against the direction of travel, and a harder push-off.
 */

import { CHECKING, HANDLING, ON_FIRE, SKATER, lerpAttr } from '../tuning.js';
import { clamp, turnToward } from '../rink.js';
import { dequantizeAxis } from '../types.js';
import type { PlayerInput, SkaterSimState } from '../types.js';
import type { SimContext } from './context.js';
import { skaterAttrs } from './context.js';
import { applyFriction, clampSpeed, integrate, speedOf } from './physics.js';

/**
 * Dead zone below which a quantized stick reads as no input at all.
 *
 * Exported because the client has to agree with it. A device layer that decides
 * "the stick is being pushed" at a lower threshold than the simulation's is not a
 * cosmetic mismatch: it hands the player a band where their input is transmitted,
 * counts as intent, and still moves nobody. Both sides read this number.
 */
export const STICK_DEADZONE = 0.12;

export interface StickVector {
  x: number;
  y: number;
  magnitude: number;
}

/** Dequantize and radially clamp the stick. Radial, so diagonals are not faster. */
export function stickVector(input: PlayerInput): StickVector {
  const x = dequantizeAxis(input.moveX);
  const y = dequantizeAxis(input.moveY);
  const magnitude = Math.sqrt(x * x + y * y);
  if (magnitude < STICK_DEADZONE) return { x: 0, y: 0, magnitude: 0 };
  if (magnitude > 1) return { x: x / magnitude, y: y / magnitude, magnitude: 1 };
  return { x, y, magnitude };
}

export function isCarrying(ctx: SimContext, skater: SkaterSimState): boolean {
  return ctx.state.puck.carrierId === skater.id;
}

/** Where this skater's stick holds the puck. */
export function stickPointX(skater: SkaterSimState): number {
  return skater.x + Math.cos(skater.facing) * SKATER.stickReach;
}

export function stickPointY(skater: SkaterSimState): number {
  return skater.y + Math.sin(skater.facing) * SKATER.stickReach;
}

/** True while the meter is high enough to engage; the floor is what stops stutter-tapping. */
export function turboEngaged(skater: SkaterSimState, input: PlayerInput): boolean {
  return input.turbo && skater.stun <= 0 && skater.turbo >= SKATER.turboMinEngage;
}

export function maxSpeedOf(ctx: SimContext, skater: SkaterSimState, boosting: boolean): number {
  const attrs = skaterAttrs(ctx.config, skater);
  let speed = lerpAttr(attrs.skating, SKATER.maxSpeedLow, SKATER.maxSpeedHigh);
  if (boosting) speed *= SKATER.turboSpeedMultiplier;
  if (isCarrying(ctx, skater)) speed *= SKATER.carrySpeedFactor;
  if (skater.onFire) speed *= ON_FIRE.speedMultiplier;
  return speed;
}

function accelOf(ctx: SimContext, skater: SkaterSimState, boosting: boolean): number {
  const attrs = skaterAttrs(ctx.config, skater);
  let accel = lerpAttr(attrs.skating, SKATER.accelLow, SKATER.accelHigh);
  if (boosting) accel *= SKATER.turboAccelMultiplier;
  if (skater.onFire) accel *= ON_FIRE.speedMultiplier;
  return accel;
}

/** Countdowns that run every tick regardless of what the skater is doing. */
export function tickSkaterTimers(ctx: SimContext, skater: SkaterSimState): void {
  if (skater.stun > 0) skater.stun--;
  if (skater.actionCooldown > 0) skater.actionCooldown--;

  if (skater.onFire) {
    skater.onFireTicks--;
    if (skater.onFireTicks <= 0) {
      skater.onFire = false;
      skater.onFireTicks = 0;
      // Heat that burns out has to be earned again from scratch, otherwise one
      // stale goal leaves the skater a single tally short of relighting forever.
      skater.streakGoals = 0;
    }
  }
}

/**
 * Turn, accelerate, and drain or refill the turbo meter for one tick.
 * Movement integration and collision happen separately, after every skater has
 * been driven, so nobody gets a positional advantage from array order.
 */
export function driveSkater(ctx: SimContext, skater: SkaterSimState, input: PlayerInput): void {
  if (skater.stun > 0) {
    applyFriction(skater, SKATER.stunFriction);
    skater.turbo = clamp(skater.turbo + SKATER.turboRefillPerTick, 0, 1);
    return;
  }

  const stick = stickVector(input);
  const boosting = turboEngaged(skater, input) && stick.magnitude > 0;

  if (boosting) {
    skater.turbo = clamp(skater.turbo - SKATER.turboDrainPerTick, 0, 1);
  } else {
    skater.turbo = clamp(skater.turbo + SKATER.turboRefillPerTick, 0, 1);
  }

  if (stick.magnitude === 0) {
    applyFriction(skater, SKATER.friction);
    return;
  }

  const desired = Math.atan2(stick.y, stick.x);
  const maxSpeed = maxSpeedOf(ctx, skater, boosting);
  let accel = accelOf(ctx, skater, boosting) * stick.magnitude;

  if (skater.controlledBy === null) {
    skater.facing = turnToward(skater.facing, desired, SKATER.turnRate);
  } else {
    const speed = speedOf(skater);
    const pace = clamp(speed / maxSpeed, 0, 1);
    const turnRate = HANDLING.turnRateSlow + (HANDLING.turnRateFast - HANDLING.turnRateSlow) * pace;
    skater.facing = turnToward(skater.facing, desired, turnRate);

    // Hockey stop: the stick is pulled back against the way we are going. Dig in
    // rather than accelerate; the turn above keeps coming round meanwhile, so the
    // skater is already facing the new way when they push off.
    if (speed > HANDLING.stopMinSpeed) {
      const along = (skater.vx * stick.x + skater.vy * stick.y) / (speed * stick.magnitude);
      if (along < HANDLING.stopAngleCos) {
        applyFriction(skater, HANDLING.stopFriction);
        return;
      }
    }
    accel *= HANDLING.accelMultiplier;
  }

  skater.vx += Math.cos(skater.facing) * accel;
  skater.vy += Math.sin(skater.facing) * accel;

  if (skater.controlledBy !== null) {
    // Edge grip: swing part of the existing momentum onto the new heading.
    const carried = speedOf(skater);
    skater.vx += (Math.cos(skater.facing) * carried - skater.vx) * HANDLING.grip;
    skater.vy += (Math.sin(skater.facing) * carried - skater.vy) * HANDLING.grip;
  }

  clampSpeed(skater, maxSpeed);
}

/** Advance a skater's position. Collision resolution is the caller's job. */
export function moveSkater(skater: SkaterSimState): void {
  integrate(skater);
}

/** Knock a skater down: impulse plus a stun scaled inversely by how tough they are. */
export function knockDown(
  ctx: SimContext,
  skater: SkaterSimState,
  impulseX: number,
  impulseY: number,
): void {
  const attrs = skaterAttrs(ctx.config, skater);
  skater.vx += impulseX;
  skater.vy += impulseY;
  // Tougher skaters get up faster, so the stun range is interpolated in reverse.
  skater.stun = Math.round(lerpAttr(attrs.checking, CHECKING.stunTicksLow, CHECKING.stunTicksHigh));
  skater.windup = 0;
}
