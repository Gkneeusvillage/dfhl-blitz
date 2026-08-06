/**
 * AI for every skater no seat is currently driving.
 *
 * The AI produces a `PlayerInput` and nothing else. It has exactly the same
 * vocabulary as a human — a stick and three buttons — which is what keeps CPU
 * teammates from being able to do things a player cannot, and keeps the sim's
 * only entry point honest.
 */

import { AI, CHECKING, PUCK, RINK, SHOOTING } from '../tuning.js';
import { attackDirection, attackingGoalX, clamp, defendingGoalX, distance } from '../rink.js';
import { quantizeAxis } from '../types.js';
import type { PlayerInput, SkaterSimState, TeamSide } from '../types.js';
import type { SimContext } from './context.js';
import { puckCarrier } from './context.js';
import { speedOf, sweepClosest } from './physics.js';
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

/**
 * On-ice skater of `side` closest to a point, tie-broken by slot so it is stable.
 * `accept` narrows the pool; without it every on-ice skater is a candidate.
 */
export function nearestOnIce(
  ctx: SimContext,
  side: TeamSide,
  x: number,
  y: number,
  accept?: (skater: SkaterSimState) => boolean,
): SkaterSimState | null {
  let best: SkaterSimState | null = null;
  let bestDist = Infinity;
  for (const skater of ctx.state.skaters) {
    if (skater.side !== side || !skater.onIce) continue;
    if (accept !== undefined && !accept(skater)) continue;
    const dist = distance(skater.x, skater.y, x, y);
    if (dist < bestDist) {
      bestDist = dist;
      best = skater;
    }
  }
  return best;
}

/**
 * The one skater this side's AI sends after the puck.
 *
 * Emphatically NOT "whoever is nearest the puck". `assignControl` hands every
 * connected seat the skater nearest the puck, so on any side with a human on it
 * the nearest skater is *always* the human's — and each AI teammate, electing by
 * the same rule, concluded somebody else was going and fell through to
 * `postUpInput`. With one seat a side (the MVP layout) that left both CPU
 * teammates standing still: a dead puck in open ice was measured uncollected for
 * an entire 3,000-tick probe, and under random human input the loose puck sat
 * motionless at one spot for 1,175 consecutive ticks.
 *
 * The AI therefore elects from the skaters it actually drives. A skater who is
 * down cannot chase either, so a knocked-over teammate no longer blocks pursuit
 * for the 0.4-0.8 s they spend on the ice.
 *
 * The stun fallback is what keeps this total: with everyone down we still send
 * the nearest one, who is about to get up. The second call can never come back
 * null from `aiInput`, because the skater asking is itself AI-driven and so is
 * always a candidate for it.
 */
function electChaser(
  ctx: SimContext,
  side: TeamSide,
  x: number,
  y: number,
): SkaterSimState | null {
  const drivable = (skater: SkaterSimState): boolean => skater.controlledBy === null;
  return (
    nearestOnIce(ctx, side, x, y, (skater) => drivable(skater) && skater.stun <= 0) ??
    nearestOnIce(ctx, side, x, y, drivable)
  );
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

/**
 * Is the lane from the puck to the net clear enough to shoot through?
 *
 * `shootUrge` has always been documented as firing "in range with a lane", but
 * there was no lane test — the AI shot straight through whichever defender was
 * standing in front of it, and a body in the path collects the puck rather than
 * deflecting it. Checking the lane is what turns a shot from a die roll into a
 * decision, and it is the same read a human makes before pulling the trigger.
 */
function shootingLaneClear(ctx: SimContext, shooter: SkaterSimState): boolean {
  const puck = ctx.state.puck;
  const goalX = attackingGoalX(shooter.side);
  const dx = goalX - puck.x;
  const dy = -puck.y;

  for (const other of ctx.state.skaters) {
    // Only opponents close a lane. A teammate in front is a screen, which is a
    // reason to shoot rather than a reason to hold on to it.
    if (!other.onIce || other.side === shooter.side || other.stun > 0) continue;
    const near = sweepClosest(puck.x, puck.y, dx, dy, other.x, other.y);
    // Bodies behind the shooter or past the goal line block nothing.
    if (near.t <= 0 || near.t >= 1) continue;
    if (near.distance < AI.laneClearance) return false;
  }
  return true;
}

/**
 * Is this a shot worth taking at all?
 *
 * Range alone is not enough. Measured over twelve AI matches, 40% of every shot
 * taken came from inside 10 ft — on top of the goalie or from behind the goal
 * line — and not one of them ever scored, because from there `releaseShot` has no
 * angle left to aim through. Meanwhile shots from 40 ft went in a third of the
 * time. Refusing the ones that cannot go in is what turns shot volume into
 * scoring chances.
 */
function hasShootingAngle(skater: SkaterSimState, goalX: number, range: number): boolean {
  if (range < AI.shootRangeMin || range > AI.shootRange) return false;
  // Behind the goal line there is no net to see; keep the puck and come back out.
  const depth = (goalX - skater.x) * attackDirection(skater.side);
  if (depth <= 0) return false;
  // Off the goal line extended the goalie covers everything the shooter can see:
  // measured, shots from beyond 45 degrees were stopped 98% of the time.
  return Math.atan2(Math.abs(skater.y), depth) <= AI.shootMaxAngle;
}

/**
 * How many ticks the AI holds the shoot button before letting it go.
 *
 * Zero in tight — release on the next tick, which is a wrist shot — climbing to a
 * full slapshot from the edge of the AI's range. `resolveSkaterActions` fires on
 * release, so this is the whole of the CPU's windup: it has exactly the same
 * button vocabulary as a human and this is how it uses it.
 */
function windupFor(range: number): number {
  const spread = AI.shootRange - AI.slapshotRange;
  const load = spread <= 0 ? 0 : clamp((range - AI.slapshotRange) / spread, 0, 1);
  return Math.round(SHOOTING.maxWindupTicks * load);
}

/** Carrying the puck: drive the slot, move it when pressured, shoot when the look is there. */
function carrierInput(ctx: SimContext, skater: SkaterSimState): PlayerInput {
  const tick = ctx.state.tick;
  const goalX = attackingGoalX(skater.side);
  const range = distance(skater.x, skater.y, goalX, 0);
  const pressure = nearestOpponentDistance(ctx, skater);

  // Attack the slot, not the crease. Steering at the goal line itself walked the
  // carrier into the goalie and left it shooting from a spot with no net in view.
  const laneY = clamp(skater.y, -RINK.faceoffDotY, RINK.faceoffDotY);
  const driveX = goalX - attackDirection(skater.side) * AI.driveDepth;
  const input = steer(tick, driveX, laneY * 0.35, skater);

  // One shared read for both kinds of shot. A one-timer that ignored the lane was
  // being fired into a defender's shins from wherever the pass happened to land,
  // which is why one-timers used to convert *worse* than ordinary shots — the
  // opposite of what the mechanic is for.
  const shootable = hasShootingAngle(skater, goalX, range) && shootingLaneClear(ctx, skater);
  if (shootable && oneTimerTicks(ctx) > 0) {
    input.shoot = true;
    return input;
  }

  // A windup already under way is carried through to the shot it was started for.
  // Without this the AI re-rolled `shootUrge` every tick, held the button for
  // exactly one tick, and therefore fired a wrist shot from everywhere on the ice.
  // Letting go early is a decision too: if the lane closes mid-windup the shot
  // goes now rather than into somebody's shins.
  if (skater.windup > 0) {
    input.shoot = shootable && skater.windup < windupFor(range);
    return input;
  }

  if (shootable && ctx.rng.chance(AI.shootUrge)) {
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

/**
 * The opponent this defender is responsible for.
 *
 * Off-puck defenders take marks in slot order and the opponents nearest our own
 * net are handed out first, so two defenders can never end up covering the same
 * man and the most dangerous one is never left alone.
 */
function assignMark(
  ctx: SimContext,
  defender: SkaterSimState,
  chaser: SkaterSimState | null,
): SkaterSimState | null {
  const { state } = ctx;
  const carrier = puckCarrier(state);
  const ownGoalX = defendingGoalX(defender.side);

  let rank = 0;
  for (const mate of state.skaters) {
    if (!mate.onIce || mate.side !== defender.side || mate === chaser) continue;
    if (mate.slot < defender.slot) rank++;
  }

  // Threats sorted by how close they are to our net. At most three candidates, so
  // an insertion sort over a small local array beats any cleverer structure.
  const threats: SkaterSimState[] = [];
  for (const foe of state.skaters) {
    if (!foe.onIce || foe.side === defender.side || foe === carrier) continue;
    const d = distance(foe.x, foe.y, ownGoalX, 0);
    let i = threats.length;
    // Ties break on slot so the assignment cannot depend on array order.
    while (i > 0 && distance(threats[i - 1].x, threats[i - 1].y, ownGoalX, 0) > d) i--;
    threats.splice(i, 0, foe);
  }
  if (threats.length === 0) return null;
  return threats[Math.min(rank, threats.length - 1)];
}

/**
 * Everyone else on defence: pick up a man, goal-side.
 *
 * This used to sit on the line from our own net to the puck, which made every
 * off-puck defender a permanent shot blocker — a body parked at exactly the range
 * shots are taken from, on exactly the line they travel. Because a blocked shot
 * here is a clean pickup rather than a deflection, that one line of positioning
 * swallowed 61% of all on-target shots before the goalie ever saw one, measured
 * over twelve AI matches.
 *
 * Marking a man instead takes away the cross-crease one-timer — the chance
 * actually worth denying — and leaves the shooting lane contested rather than
 * closed by construction.
 */
function postUpInput(
  ctx: SimContext,
  skater: SkaterSimState,
  chaser: SkaterSimState | null,
): PlayerInput {
  const tick = ctx.state.tick;
  const ownGoalX = defendingGoalX(skater.side);

  const mark = assignMark(ctx, skater, chaser);
  let anchorX: number;
  let anchorY: number;
  if (mark === null) {
    // Nobody to cover: hold the slot against the puck, a half-beat behind it.
    const puck = laggedPuck(ctx);
    anchorX = puck.x;
    anchorY = puck.y;
  } else {
    anchorX = mark.x;
    anchorY = mark.y;
  }

  const dx = anchorX - ownGoalX;
  const dy = anchorY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  // Goal-side of the man, and never further out than the defensive post distance:
  // chasing a mark to the far blue line would leave the slot wide open.
  const depth = clamp(len - AI.markGoalSideDistance, 0, AI.defensivePostDistance);
  const targetX = ownGoalX + (dx / len) * depth;
  const targetY = (dy / len) * depth;

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

  // Loose or on an opponent's stick: exactly one AI skater per side goes to the puck.
  const puckTarget = state.puck.carrierId === null ? interceptPoint(ctx) : { x: state.puck.x, y: state.puck.y };
  const chaser = electChaser(ctx, skater.side, puckTarget.x, puckTarget.y);
  if (chaser === skater) return chaseInput(ctx, skater);
  return postUpInput(ctx, skater, chaser);
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
