/**
 * Rink geometry: the rounded-rectangle ice surface, the nets, and collision helpers.
 *
 * Coordinate system (feet, origin at center ice):
 *   +x  toward the AWAY team's net (the right end on screen)
 *   -x  toward the HOME team's net (the left end on screen)
 *   +y  toward the bottom of the screen
 *
 * So HOME defends x = -89 and attacks x = +89.
 *
 * This module is pure geometry — it is used by the simulation for collision and
 * by the renderer for drawing, and must stay free of any game state.
 */

import { RINK } from './tuning.js';
import type { TeamSide } from './types.js';

/** Half-extents of the straight portion, i.e. the rounded rect's inner box. */
const INNER_HX = RINK.halfLength - RINK.cornerRadius;
const INNER_HY = RINK.halfWidth - RINK.cornerRadius;

export interface BoardsContact {
  /** True when a circle of the given radius overlaps the boards. */
  hit: boolean;
  /** How far the circle has penetrated, in feet. */
  penetration: number;
  /** Unit normal pointing from the boards toward the ice interior. */
  nx: number;
  ny: number;
}

const NO_CONTACT: BoardsContact = { hit: false, penetration: 0, nx: 0, ny: 0 };

/**
 * Signed distance from a point to the boards.
 * Negative inside the rink, positive outside, zero on the boards.
 */
export function signedDistanceToBoards(x: number, y: number): number {
  const qx = Math.abs(x) - INNER_HX;
  const qy = Math.abs(y) - INNER_HY;
  const mx = qx > 0 ? qx : 0;
  const my = qy > 0 ? qy : 0;
  const outside = Math.sqrt(mx * mx + my * my);
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - RINK.cornerRadius;
}

/**
 * Test a circle against the boards.
 * Returns the inward normal and penetration depth so the caller can push the
 * circle back onto the ice and reflect its velocity.
 */
export function collideWithBoards(x: number, y: number, radius: number): BoardsContact {
  const penetration = signedDistanceToBoards(x, y) + radius;
  if (penetration <= 0) return NO_CONTACT;

  const qx = Math.abs(x) - INNER_HX;
  const qy = Math.abs(y) - INNER_HY;

  // Outward normal in the first quadrant, then mirrored back to the point's quadrant.
  let ax: number;
  let ay: number;
  if (qx > 0 && qy > 0) {
    // Rounded corner: the normal radiates from the corner arc's center.
    const len = Math.sqrt(qx * qx + qy * qy) || 1;
    ax = qx / len;
    ay = qy / len;
  } else if (qx > qy) {
    // End boards.
    ax = 1;
    ay = 0;
  } else {
    // Side boards.
    ax = 0;
    ay = 1;
  }

  const sx = x < 0 ? -1 : 1;
  const sy = y < 0 ? -1 : 1;
  // Negated so the normal points inward, toward the ice.
  return { hit: true, penetration, nx: -sx * ax, ny: -sy * ay };
}

/** Push a circle back inside the boards and reflect its velocity. Returns true if it hit. */
export function resolveBoardsCollision(
  body: { x: number; y: number; vx: number; vy: number },
  radius: number,
  restitution: number,
): BoardsContact {
  const contact = collideWithBoards(body.x, body.y, radius);
  if (!contact.hit) return contact;

  body.x += contact.nx * contact.penetration;
  body.y += contact.ny * contact.penetration;

  // Reflect only the component heading into the boards.
  const along = body.vx * contact.nx + body.vy * contact.ny;
  if (along < 0) {
    body.vx -= (1 + restitution) * along * contact.nx;
    body.vy -= (1 + restitution) * along * contact.ny;
  }
  return contact;
}

// ---------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------

/** x coordinate of the goal line the given side DEFENDS. */
export function defendingGoalX(side: TeamSide): number {
  return side === 'home' ? -RINK.goalLineX : RINK.goalLineX;
}

/** x coordinate of the goal line the given side ATTACKS. */
export function attackingGoalX(side: TeamSide): number {
  return side === 'home' ? RINK.goalLineX : -RINK.goalLineX;
}

/** Direction (+1 or -1) the given side shoots. */
export function attackDirection(side: TeamSide): number {
  return side === 'home' ? 1 : -1;
}

/**
 * Has the puck fully crossed into the net that `defendingSide` guards?
 * The puck must cross the goal line between the posts.
 */
export function isPuckInNet(
  puckX: number,
  puckY: number,
  puckRadius: number,
  defendingSide: TeamSide,
): boolean {
  if (Math.abs(puckY) > RINK.goalHalfWidth) return false;
  const goalX = defendingGoalX(defendingSide);
  return defendingSide === 'home'
    ? puckX + puckRadius < goalX
    : puckX - puckRadius > goalX;
}

/**
 * The two goal posts for the net that `defendingSide` guards, as circles.
 *
 * Their centers sit one radius OUTSIDE the mouth so the inner edge of each post
 * lands exactly on `goalHalfWidth`. Centering them on the mouth edge instead
 * would block the outer 0.35 ft of net on each side while `isPuckInNet` still
 * counted that band as a goal — the puck would be waved off by a post it should
 * have missed.
 */
export function goalPosts(defendingSide: TeamSide): Array<{ x: number; y: number; radius: number }> {
  const goalX = defendingGoalX(defendingSide);
  const offset = RINK.goalHalfWidth + RINK.postRadius;
  return [
    { x: goalX, y: -offset, radius: RINK.postRadius },
    { x: goalX, y: offset, radius: RINK.postRadius },
  ];
}

/** Center of the net mouth that `defendingSide` guards. */
export function netCenter(defendingSide: TeamSide): { x: number; y: number } {
  return { x: defendingGoalX(defendingSide), y: 0 };
}

// ---------------------------------------------------------------------------
// Faceoff spots
// ---------------------------------------------------------------------------

export const FACEOFF_SPOTS = {
  center: { x: 0, y: 0 },
  /** Ordered so index parity maps cleanly onto which end and which side. */
  zones: [
    { x: -RINK.faceoffDotX, y: -RINK.faceoffDotY },
    { x: -RINK.faceoffDotX, y: RINK.faceoffDotY },
    { x: RINK.faceoffDotX, y: -RINK.faceoffDotY },
    { x: RINK.faceoffDotX, y: RINK.faceoffDotY },
  ],
} as const;

// ---------------------------------------------------------------------------
// Small vector helpers used throughout the sim
// ---------------------------------------------------------------------------

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Shortest signed angular difference from `from` to `to`, in radians. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}
