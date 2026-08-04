/**
 * Puck movement and everything it can run into during one tick.
 *
 * The puck tops out at 3.2 ft/tick, which is wider than a goalie is thick, so
 * every test in here is swept rather than point-in-place. A discrete check would
 * let hard shots teleport through the goalie and through the goal line, and that
 * kind of bug only shows up on the shots that matter most.
 */

import { GOALIE, PUCK, RINK } from '../tuning.js';
import { defendingGoalX, goalPosts, resolveBoardsCollision } from '../rink.js';
import type { GameSimState, TeamSide } from '../types.js';
import type { SimContext } from './context.js';
import { goalieFor } from './context.js';
import { resolveGoalieSave, tryCoverLoosePuck } from './goalie.js';
import { clampSpeed, applyFriction, reflect, speedOf, sweepPointCircle } from './physics.js';

export type PuckOutcome =
  | { kind: 'none' }
  | { kind: 'goal'; conceding: TeamSide }
  | { kind: 'save' }
  | { kind: 'freeze' };

const NO_OUTCOME: PuckOutcome = { kind: 'none' };

/**
 * Gap left between the puck and a post after a deflection, in feet.
 *
 * Small enough to be invisible, large enough to survive the rounding in the next
 * tick's sweep so the puck can never re-enter the contact circle it just left.
 */
const POST_SEPARATION = 1e-3;

/**
 * Does the segment cross a goal line between the posts, travelling in the
 * direction an attacker would be shooting? Returns the crossing parameter, or -1.
 */
function goalCrossing(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  defending: TeamSide,
): number {
  const goalX = defendingGoalX(defending);
  // Attackers shoot toward -x at the home net and +x at the away net.
  const scoringDirection = defending === 'home' ? -1 : 1;

  if (scoringDirection > 0) {
    if (!(x0 <= goalX && x1 > goalX)) return -1;
  } else if (!(x0 >= goalX && x1 < goalX)) {
    return -1;
  }

  const span = x1 - x0;
  if (Math.abs(span) < 1e-9) return -1;
  const t = (goalX - x0) / span;
  const y = y0 + (y1 - y0) * t;
  return Math.abs(y) <= RINK.goalHalfWidth ? t : -1;
}

/** Both nets, checked for a crossing on this segment. */
function checkGoal(x0: number, y0: number, x1: number, y1: number): TeamSide | null {
  if (goalCrossing(x0, y0, x1, y1, 'home') >= 0) return 'home';
  if (goalCrossing(x0, y0, x1, y1, 'away') >= 0) return 'away';
  return null;
}

/** Earliest post contact on this segment, if any. */
function firstPostHit(
  x0: number,
  y0: number,
  dx: number,
  dy: number,
): { t: number; x: number; y: number; radius: number } | null {
  let bestT = Infinity;
  let hit: { x: number; y: number; radius: number } | null = null;

  for (const side of ['home', 'away'] as const) {
    for (const post of goalPosts(side)) {
      const t = sweepPointCircle(x0, y0, dx, dy, post.x, post.y, post.radius + PUCK.radius);
      if (t >= 0 && t < bestT) {
        bestT = t;
        hit = { x: post.x, y: post.y, radius: post.radius };
      }
    }
  }
  return hit === null ? null : { t: bestT, ...hit };
}

/**
 * One tick of loose-puck motion.
 *
 * Resolution order is goalie, then post, then goal line, then boards — earliest
 * contact wins and ends the puck's travel for the tick, so nothing is resolved
 * against a position it never actually occupied.
 */
export function stepLoosePuck(ctx: SimContext): PuckOutcome {
  const { state } = ctx;
  const puck = state.puck;
  if (puck.pickupCooldown > 0) puck.pickupCooldown--;

  const x0 = puck.x;
  const y0 = puck.y;
  const dx = puck.vx;
  const dy = puck.vy;
  const x1 = x0 + dx;
  const y1 = y0 + dy;

  // --- goalies -------------------------------------------------------------
  // Widest possible contact circle; resolveGoalieSave decides whether the goalie
  // is actually able to take that much of the path away this tick.
  const goalieMaxRadius = PUCK.radius + GOALIE.radius + GOALIE.lungeReachHigh;
  let goalieT = Infinity;
  let goalieSide: TeamSide | null = null;
  for (const goalie of state.goalies) {
    const contact = sweepPointCircle(x0, y0, dx, dy, goalie.x, goalie.y, goalieMaxRadius);
    if (contact >= 0 && contact < goalieT) {
      goalieT = contact;
      goalieSide = goalie.side;
    }
  }

  const post = firstPostHit(x0, y0, dx, dy);
  const goalConceded = checkGoal(x0, y0, x1, y1);
  const goalT =
    goalConceded === null ? Infinity : goalCrossing(x0, y0, x1, y1, goalConceded);

  const postT = post === null ? Infinity : post.t;

  // Earliest event wins. A goalie who cannot reach the shot returns no contact,
  // and the puck carries on to the post and goal-line tests below.
  if (goalieSide !== null && goalieT <= postT && goalieT <= goalT) {
    const result = resolveGoalieSave(ctx, goalieFor(state, goalieSide), x0, y0, x1, y1);
    if (result.frozen) return { kind: 'freeze' };
    if (result.stopped) return { kind: 'save' };
  }

  if (post !== null && postT <= goalT) {
    const contactX = x0 + dx * postT;
    const contactY = y0 + dy * postT;
    let nx = contactX - post.x;
    let ny = contactY - post.y;
    const len = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= len;
    ny /= len;

    // Seat the puck just clear of the post rather than exactly on it. Landing on
    // the contact circle leaves the next tick's sweep starting inside it, and
    // sweepPointCircle reports t=0 for that — which pins the puck at x0 forever,
    // spraying a post event every tick until somebody skates over and collects it.
    const clearance = post.radius + PUCK.radius + POST_SEPARATION;
    puck.x = post.x + nx * clearance;
    puck.y = post.y + ny * clearance;

    reflect(puck, nx, ny, PUCK.boardsRestitution);

    // Carry the puck through the rest of the tick so a post hit costs no travel,
    // then let it settle against the boards it may have been deflected into.
    const remaining = 1 - postT;
    if (remaining > 0) {
      puck.x += puck.vx * remaining;
      puck.y += puck.vy * remaining;
      resolveBoardsCollision(puck, PUCK.radius, PUCK.boardsRestitution);
    }

    applyFriction(puck, PUCK.friction);
    clampSpeed(puck, PUCK.maxSpeed);

    ctx.events.push({
      type: 'post',
      tick: state.tick,
      x: contactX,
      y: contactY,
      power: speedOf(puck),
    });
    return NO_OUTCOME;
  }

  if (goalConceded !== null) {
    puck.x = x0 + dx * goalT;
    puck.y = y0 + dy * goalT;
    return { kind: 'goal', conceding: goalConceded };
  }

  puck.x = x1;
  puck.y = y1;

  const contact = resolveBoardsCollision(puck, PUCK.radius, PUCK.boardsRestitution);
  if (contact.hit) {
    ctx.events.push({
      type: 'boardsHit',
      tick: state.tick,
      x: puck.x,
      y: puck.y,
      power: speedOf(puck),
    });
  }

  applyFriction(puck, PUCK.friction);
  clampSpeed(puck, PUCK.maxSpeed);
  if (speedOf(puck) < PUCK.restSpeed) {
    puck.vx = 0;
    puck.vy = 0;
  }

  // A rebound dying in the crease is a stalled game; the goalie smothers it.
  for (const goalie of state.goalies) {
    if (tryCoverLoosePuck(ctx, goalie)) return { kind: 'freeze' };
  }

  return NO_OUTCOME;
}

/** A carried puck can still be walked over the line — the goalie's body is what stops it. */
export function checkCarriedGoal(
  state: GameSimState,
  previousX: number,
  previousY: number,
): TeamSide | null {
  return checkGoal(previousX, previousY, state.puck.x, state.puck.y);
}
