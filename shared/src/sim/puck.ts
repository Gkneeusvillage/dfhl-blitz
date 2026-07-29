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
): { t: number; x: number; y: number } | null {
  let bestT = Infinity;
  let hit: { x: number; y: number } | null = null;

  for (const side of ['home', 'away'] as const) {
    for (const post of goalPosts(side)) {
      const t = sweepPointCircle(x0, y0, dx, dy, post.x, post.y, post.radius + PUCK.radius);
      if (t >= 0 && t < bestT) {
        bestT = t;
        hit = { x: post.x, y: post.y };
      }
    }
  }
  return hit === null ? null : { t: bestT, x: hit.x, y: hit.y };
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
  let goalieT = Infinity;
  let goalieSide: TeamSide | null = null;
  for (const goalie of state.goalies) {
    const contact = sweepPointCircle(x0, y0, dx, dy, goalie.x, goalie.y, PUCK.radius + GOALIE.radius);
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

  // Earliest event wins.
  if (goalieSide !== null && goalieT <= postT && goalieT <= goalT) {
    const result = resolveGoalieSave(ctx, goalieFor(state, goalieSide), x0, y0, x1, y1);
    if (result.frozen) return { kind: 'freeze' };
    return { kind: 'save' };
  }

  if (post !== null && postT <= goalT) {
    puck.x = x0 + dx * postT;
    puck.y = y0 + dy * postT;
    const nx = puck.x - post.x;
    const ny = puck.y - post.y;
    const len = Math.sqrt(nx * nx + ny * ny) || 1;
    reflect(puck, nx / len, ny / len, PUCK.boardsRestitution);
    ctx.events.push({
      type: 'post',
      tick: state.tick,
      x: puck.x,
      y: puck.y,
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
