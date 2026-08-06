/**
 * Everything a skater can do to the puck or to an opponent: shoot, pass, pick up,
 * body check, poke check.
 *
 * All four buttons collapse into two, NHL '94 style: `shoot` is always a shot,
 * and `pass` means pass when you have the puck and hit when you do not.
 */

import {
  CHECKING,
  ON_FIRE,
  PASSING,
  PUCK,
  RINK,
  SHOOTING,
  lerpAttr,
} from '../tuning.js';
import { attackingGoalX, clamp, collideWithBoards, distance } from '../rink.js';
import { otherSide } from '../types.js';
import type { PlayerInput, PuckSimState, SkaterSimState } from '../types.js';
import type { SimContext } from './context.js';
import { goalieFor, puckCarrier, skaterAttrs, skaterById } from './context.js';
import { speedOf, sweepClosest } from './physics.js';
import { isCarrying, knockDown, stickPointX, stickPointY } from './skater.js';

// ---------------------------------------------------------------------------
// One-timer window
// ---------------------------------------------------------------------------

/** Ticks left in which the carrier's shot still counts as a one-timer. */
export function oneTimerTicks(ctx: SimContext): number {
  const puck = ctx.state.puck;
  return puck.carrierId === null ? 0 : puck.oneTimerTicks;
}

export function armOneTimer(ctx: SimContext): void {
  ctx.state.puck.oneTimerTicks = SHOOTING.oneTimerWindowTicks;
}

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------

/**
 * Release the puck as a shot.
 *
 * Windup interpolates continuously from a wrister to a slapshot: harder and less
 * accurate the longer it is held. A one-timer skips the trade-off entirely,
 * which is exactly why it is the highlight-reel play.
 */
export function releaseShot(ctx: SimContext, shooter: SkaterSimState): void {
  const { state, config } = ctx;
  const attrs = skaterAttrs(config, shooter);
  const power = clamp(shooter.windup / SHOOTING.maxWindupTicks, 0, 1);
  const oneTimer = oneTimerTicks(ctx) > 0;

  const wrist = lerpAttr(attrs.shooting, SHOOTING.wristSpeedLow, SHOOTING.wristSpeedHigh);
  const slap = lerpAttr(attrs.shooting, SHOOTING.slapSpeedLow, SHOOTING.slapSpeedHigh);
  let speed = wrist + (slap - wrist) * power;
  let spread =
    lerpAttr(attrs.shooting, SHOOTING.accuracySpreadLow, SHOOTING.accuracySpreadHigh) *
    (1 + power * (SHOOTING.slapAccuracyPenalty - 1));

  if (oneTimer) {
    speed *= SHOOTING.oneTimerSpeedBonus;
    spread *= SHOOTING.oneTimerAccuracyBonus;
  }
  if (shooter.onFire) {
    speed *= ON_FIRE.shotSpeedMultiplier;
    spread *= ON_FIRE.accuracyMultiplier;
  }
  speed = Math.min(speed, PUCK.maxSpeed);

  const originX = state.puck.x;
  const originY = state.puck.y;
  const goalX = attackingGoalX(shooter.side);
  const goalie = goalieFor(state, otherSide(shooter.side));

  // Pick the corner the goalie is furthest from; from point-blank there is no
  // angle left to work with, so just fire at the middle of what is open.
  const travel = Math.abs(goalX - originX);
  const cornerSign = goalie.y >= 0 ? -1 : 1;
  const aimY =
    travel < SHOOTING.minAimDistance
      ? 0
      : cornerSign * RINK.goalHalfWidth * SHOOTING.aimCornerFraction;

  const angle = Math.atan2(aimY - originY, goalX - originX) + ctx.rng.range(-spread, spread);

  state.puck.carrierId = null;
  state.puck.vx = Math.cos(angle) * speed;
  state.puck.vy = Math.sin(angle) * speed;
  state.puck.pickupCooldown = PUCK.pickupCooldown;
  state.puck.oneTimerTicks = 0;
  state.puck.lastTouchedBy = shooter.id;
  state.puck.lastTouchSide = shooter.side;

  shooter.windup = 0;
  shooter.actionCooldown = SHOOTING.releaseCooldownTicks;
  state.stats[shooter.playerId].shots++;

  ctx.events.push({
    type: 'shot',
    tick: state.tick,
    actorId: shooter.id,
    side: shooter.side,
    x: originX,
    y: originY,
    power: speed,
  });
}

// ---------------------------------------------------------------------------
// Passing
// ---------------------------------------------------------------------------

/** Best teammate inside the forward cone, scored on how central and how close they are. */
function selectPassTarget(ctx: SimContext, passer: SkaterSimState): SkaterSimState | null {
  const { state } = ctx;
  let best: SkaterSimState | null = null;
  let bestScore = -Infinity;

  for (const mate of state.skaters) {
    if (mate === passer || mate.side !== passer.side || !mate.onIce) continue;
    const dx = mate.x - passer.x;
    const dy = mate.y - passer.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-3 || dist > PASSING.maxTargetDistance) continue;

    let offAxis = Math.atan2(dy, dx) - passer.facing;
    while (offAxis > Math.PI) offAxis -= Math.PI * 2;
    while (offAxis < -Math.PI) offAxis += Math.PI * 2;
    if (Math.abs(offAxis) > PASSING.targetConeRadians) continue;

    // Centrality dominates; distance only breaks ties between two open mates.
    const score = 1 - Math.abs(offAxis) / PASSING.targetConeRadians - dist / (PASSING.maxTargetDistance * 4);
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return best;
}

export function releasePass(ctx: SimContext, passer: SkaterSimState): boolean {
  const { state, config } = ctx;
  const target = selectPassTarget(ctx, passer);
  if (target === null) return false;

  const attrs = skaterAttrs(config, passer);
  const speed = Math.min(
    lerpAttr(attrs.passing, PASSING.speedLow, PASSING.speedHigh),
    PUCK.maxSpeed,
  );
  const spread = lerpAttr(attrs.passing, PASSING.accuracySpreadLow, PASSING.accuracySpreadHigh);

  const originX = state.puck.x;
  const originY = state.puck.y;
  const flat = distance(originX, originY, target.x, target.y);
  const lead = Math.min(flat / speed, PASSING.maxLeadTicks);
  const aimX = target.x + target.vx * lead;
  const aimY = target.y + target.vy * lead;

  const angle = Math.atan2(aimY - originY, aimX - originX) + ctx.rng.range(-spread, spread);

  state.puck.carrierId = null;
  state.puck.vx = Math.cos(angle) * speed;
  state.puck.vy = Math.sin(angle) * speed;
  state.puck.pickupCooldown = PUCK.pickupCooldown;
  state.puck.oneTimerTicks = 0;
  state.puck.lastTouchedBy = passer.id;
  state.puck.lastTouchSide = passer.side;

  passer.actionCooldown = SHOOTING.releaseCooldownTicks;
  passer.windup = 0;

  ctx.events.push({
    type: 'pass',
    tick: state.tick,
    actorId: passer.id,
    targetId: target.id,
    side: passer.side,
    x: originX,
    y: originY,
    power: speed,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function nearestOpponent(ctx: SimContext, skater: SkaterSimState, radius: number): SkaterSimState | null {
  let best: SkaterSimState | null = null;
  let bestDist = radius;
  for (const other of ctx.state.skaters) {
    if (other.side === skater.side || !other.onIce || other.stun > 0) continue;
    const dist = distance(skater.x, skater.y, other.x, other.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = other;
    }
  }
  return best;
}

/** Drop the puck at a skater's feet with a little scatter — used by checks and strips. */
function jarPuckLoose(ctx: SimContext, victim: SkaterSimState): void {
  const { state } = ctx;
  if (state.puck.carrierId !== victim.id) return;
  const angle = ctx.rng.range(-Math.PI, Math.PI);
  state.puck.carrierId = null;
  state.puck.vx = victim.vx + Math.cos(angle) * CHECKING.strippedPuckSpeed;
  state.puck.vy = victim.vy + Math.sin(angle) * CHECKING.strippedPuckSpeed;
  state.puck.pickupCooldown = 0;
  state.puck.oneTimerTicks = 0;
  ctx.events.push({
    type: 'turnover',
    tick: state.tick,
    actorId: victim.id,
    side: victim.side,
    x: state.puck.x,
    y: state.puck.y,
  });
}

/**
 * The `pass` button when the skater does not have the puck.
 *
 * Close and closing fast is a body check; otherwise it is a poke, which is the
 * safer play and the only one a slow defender can reliably land.
 */
export function attemptDefensiveAction(ctx: SimContext, defender: SkaterSimState): void {
  if (defender.actionCooldown > 0 || defender.stun > 0) return;
  const { state, config } = ctx;
  const attrs = skaterAttrs(config, defender);

  const victim = nearestOpponent(ctx, defender, CHECKING.checkRadius);
  if (victim !== null) {
    const closing =
      Math.sqrt(
        (defender.vx - victim.vx) * (defender.vx - victim.vx) +
          (defender.vy - victim.vy) * (defender.vy - victim.vy),
      );
    if (closing >= CHECKING.minImpactSpeed) {
      const magnitude = lerpAttr(attrs.checking, CHECKING.impulseLow, CHECKING.impulseHigh);
      const dx = victim.x - defender.x;
      const dy = victim.y - defender.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      knockDown(ctx, victim, (dx / len) * magnitude, (dy / len) * magnitude);
      jarPuckLoose(ctx, victim);
      defender.actionCooldown = CHECKING.cooldownTicks;
      state.stats[defender.playerId].hits++;
      ctx.events.push({
        type: 'hit',
        tick: state.tick,
        actorId: defender.id,
        targetId: victim.id,
        side: defender.side,
        x: victim.x,
        y: victim.y,
        power: magnitude,
      });
      return;
    }
  }

  // Poke: reach for the carrier's puck.
  const carrier = puckCarrier(state);
  defender.actionCooldown = CHECKING.pokeCooldownTicks;
  if (carrier === null || carrier.side === defender.side) return;
  if (distance(defender.x, defender.y, carrier.x, carrier.y) > CHECKING.pokeRadius) return;

  const chance = lerpAttr(attrs.defense, CHECKING.pokeStripChanceLow, CHECKING.pokeStripChanceHigh);
  if (ctx.rng.chance(chance)) {
    jarPuckLoose(ctx, carrier);
    state.puck.lastTouchedBy = defender.id;
    state.puck.lastTouchSide = defender.side;
  }
}

// ---------------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------------

/**
 * Seat the puck on a carrier's stick, pulled back onto the ice.
 *
 * The stick reaches further than the skater's own radius, so the raw stick point
 * can sit up to `stickReach - radius + puckRadius` = 1.3 ft through the boards.
 * The collect tick used to skip this clamp and rely on the next tick's
 * `attachPuckToCarrier` to fix it — which is fine for the simulation and wrong
 * for the client, because a snapshot broadcast on exactly that tick draws the
 * puck through the wall. Measured 1.2566 ft outside the boards at (81.93, 41.49)
 * during a fuzz run.
 */
function seatPuckOnStick(puck: PuckSimState, carrier: SkaterSimState): void {
  puck.x = stickPointX(carrier);
  puck.y = stickPointY(carrier);
  const contact = collideWithBoards(puck.x, puck.y, PUCK.radius);
  if (contact.hit) {
    puck.x += contact.nx * contact.penetration;
    puck.y += contact.ny * contact.penetration;
  }
}

/**
 * Hand the loose puck to whichever upright skater is closest to its path this
 * tick. Nearest-wins rather than first-in-array-wins, so home does not get a
 * systematic advantage from iteration order.
 */
export function resolvePickups(
  ctx: SimContext,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  const { state } = ctx;
  if (state.puck.carrierId !== null || state.puck.pickupCooldown > 0) return;

  const dx = toX - fromX;
  const dy = toY - fromY;
  let winner: SkaterSimState | null = null;
  let bestDist: number = PUCK.pickupRadius;

  for (const skater of state.skaters) {
    if (!skater.onIce || skater.stun > 0) continue;
    const closest = sweepClosest(fromX, fromY, dx, dy, skater.x, skater.y);
    if (closest.distance < bestDist) {
      bestDist = closest.distance;
      winner = skater;
    }
  }
  if (winner === null) return;

  const arrivingSpeed = speedOf(state.puck);
  const previous = skaterById(state, state.puck.lastTouchedBy);
  const wasPass =
    previous !== null &&
    previous !== winner &&
    previous.side === winner.side &&
    arrivingSpeed >= PASSING.receptionSpeed;

  state.puck.carrierId = winner.id;
  state.puck.vx = winner.vx;
  state.puck.vy = winner.vy;
  seatPuckOnStick(state.puck, winner);

  if (wasPass && previous !== null) {
    armOneTimer(ctx);
    setPendingAssist(ctx, previous);
  } else {
    state.puck.oneTimerTicks = 0;
    if (previous === null || previous.side !== winner.side) clearPendingAssist(ctx);
  }

  state.puck.lastTouchedBy = winner.id;
  state.puck.lastTouchSide = winner.side;
}

// ---------------------------------------------------------------------------
// Pending assist
// ---------------------------------------------------------------------------

/** Remember who fed the current carrier, so a goal can be credited back to them. */
export function setPendingAssist(ctx: SimContext, passer: SkaterSimState): void {
  ctx.state.assistCandidateId = passer.id;
}

export function clearPendingAssist(ctx: SimContext): void {
  ctx.state.assistCandidateId = null;
}

export function pendingAssist(ctx: SimContext): SkaterSimState | null {
  return skaterById(ctx.state, ctx.state.assistCandidateId);
}

// ---------------------------------------------------------------------------
// Button dispatch
// ---------------------------------------------------------------------------

/**
 * Turn one tick of button state into an action.
 *
 * Shots fire on *release*, which is what makes hold-to-slapshot work with a
 * single button — except for a one-timer, which fires the instant the puck
 * arrives so the shot never loses its rhythm.
 */
export function resolveSkaterActions(
  ctx: SimContext,
  skater: SkaterSimState,
  input: PlayerInput,
): void {
  if (skater.stun > 0) {
    skater.windup = 0;
    return;
  }

  const carrying = isCarrying(ctx, skater);

  if (input.shoot) {
    skater.windup++;
    const oneTimer = carrying && oneTimerTicks(ctx) > 0;
    const held = skater.windup >= SHOOTING.maxHoldTicks;
    if (carrying && skater.actionCooldown === 0 && (oneTimer || held)) {
      releaseShot(ctx, skater);
      return;
    }
    if (skater.windup > SHOOTING.maxHoldTicks) skater.windup = SHOOTING.maxHoldTicks;
  } else if (skater.windup > 0) {
    if (carrying && skater.actionCooldown === 0) {
      releaseShot(ctx, skater);
      return;
    }
    skater.windup = 0;
  }

  if (input.pass) {
    if (carrying) {
      if (skater.actionCooldown === 0) releasePass(ctx, skater);
    } else {
      attemptDefensiveAction(ctx, skater);
    }
  }
}

/**
 * Keep the carried puck glued to the carrier's stick, and run the timers that
 * only tick while somebody has it.
 */
export function attachPuckToCarrier(ctx: SimContext): void {
  const puck = ctx.state.puck;
  const carrier = puckCarrier(ctx.state);
  if (carrier === null) return;
  puck.vx = carrier.vx;
  puck.vy = carrier.vy;
  seatPuckOnStick(puck, carrier);

  if (puck.oneTimerTicks > 0) puck.oneTimerTicks--;
  if (puck.pickupCooldown > 0) puck.pickupCooldown--;
}
