/**
 * The physics primitives: integration, friction, circle-vs-circle resolution,
 * and the swept tests that keep a 3.2 ft/tick puck from tunnelling through a
 * goalie or a goal line.
 *
 * Boards collision itself lives in rink.ts — this module only calls it.
 */

import { PUCK, RINK, SKATER } from '../tuning.js';
import { clamp, resolveBoardsCollision } from '../rink.js';

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function speedOf(body: Body): number {
  return Math.sqrt(body.vx * body.vx + body.vy * body.vy);
}

export function integrate(body: Body): void {
  body.x += body.vx;
  body.y += body.vy;
}

export function applyFriction(body: Body, retention: number): void {
  body.vx *= retention;
  body.vy *= retention;
}

/** Scale velocity down to `max` while preserving heading. */
export function clampSpeed(body: Body, max: number): void {
  const speed = speedOf(body);
  if (speed <= max || speed === 0) return;
  const scale = max / speed;
  body.vx *= scale;
  body.vy *= scale;
}

/**
 * Push two overlapping circles apart and exchange the normal component of their
 * velocities. Returns true if they were touching.
 *
 * `aMass`/`bMass` are positional weights, not real masses: pass 0 to pin a body
 * (the goalie shrugging off a skater) and 1 for a normal skater.
 */
export function separateCircles(
  a: Body,
  b: Body,
  radiusA: number,
  radiusB: number,
  restitution: number,
  aMass = 1,
  bMass = 1,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const minimum = radiusA + radiusB;
  let dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= minimum) return false;

  // Exactly coincident centers have no normal; pick one deterministically rather
  // than dividing by zero — an rng call here would be wasteful churn.
  let nx = 1;
  let ny = 0;
  if (dist > 1e-6) {
    nx = dx / dist;
    ny = dy / dist;
  } else {
    dist = 1e-6;
  }

  const overlap = minimum - dist;
  const total = aMass + bMass;
  if (total > 0) {
    a.x -= nx * overlap * (aMass / total);
    a.y -= ny * overlap * (aMass / total);
    b.x += nx * overlap * (bMass / total);
    b.y += ny * overlap * (bMass / total);
  }

  const approach = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (approach < 0 && total > 0) {
    const impulse = -(1 + restitution) * approach;
    a.vx -= impulse * nx * (aMass / total);
    a.vy -= impulse * ny * (aMass / total);
    b.vx += impulse * nx * (bMass / total);
    b.vy += impulse * ny * (bMass / total);
  }
  return true;
}

/**
 * Earliest time in [0, 1] at which the point sweeping from (px, py) along
 * (dx, dy) touches a circle of radius `r` at (cx, cy). Returns -1 for no hit.
 * Returns 0 when the sweep starts already overlapping.
 */
export function sweepPointCircle(
  px: number,
  py: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const fx = px - cx;
  const fy = py - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;

  const a = dx * dx + dy * dy;
  if (a <= 1e-12) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;

  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + root) / (2 * a);
  if (t2 >= 0 && t2 <= 1) return t2;
  return -1;
}

/** Closest approach of a swept point to a static point, as (parameter, distance). */
export function sweepClosest(
  px: number,
  py: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
): { t: number; distance: number } {
  const lengthSq = dx * dx + dy * dy;
  let t = 0;
  if (lengthSq > 1e-12) {
    t = clamp(((cx - px) * dx + (cy - py) * dy) / lengthSq, 0, 1);
  }
  const nx = px + dx * t - cx;
  const ny = py + dy * t - cy;
  return { t, distance: Math.sqrt(nx * nx + ny * ny) };
}

/** Reflect a velocity about a unit normal, keeping `restitution` of the normal component. */
export function reflect(body: Body, nx: number, ny: number, restitution: number): void {
  const along = body.vx * nx + body.vy * ny;
  if (along >= 0) return;
  body.vx -= (1 + restitution) * along * nx;
  body.vy -= (1 + restitution) * along * ny;
}

/**
 * Keep a skater out of both goal frames.
 *
 * The nets are the only interior obstacle on the sheet. A skater is pushed to
 * whichever face of the frame they are nearer, so you can still cut behind the
 * net — you just cannot stand in it.
 */
export function keepSkaterOutOfNets(body: Body, radius: number): void {
  const halfWidth = RINK.goalHalfWidth + radius;
  if (Math.abs(body.y) >= halfWidth) return;

  for (const goalX of [-RINK.goalLineX, RINK.goalLineX]) {
    const front = goalX < 0 ? goalX + radius : goalX - radius;
    const back = goalX < 0 ? goalX - RINK.goalDepth - radius : goalX + RINK.goalDepth + radius;
    const inside = goalX < 0 ? body.x < front && body.x > back : body.x > front && body.x < back;
    if (!inside) continue;

    // Nearest way out, measured along x only — the frame is much shallower than it is wide.
    if (Math.abs(body.x - front) <= Math.abs(body.x - back)) {
      body.x = front;
      if ((goalX < 0 && body.vx < 0) || (goalX > 0 && body.vx > 0)) body.vx = 0;
    } else {
      body.x = back;
      if ((goalX < 0 && body.vx > 0) || (goalX > 0 && body.vx < 0)) body.vx = 0;
    }
  }
}

/** Put a skater back on the ice after moving. Boards last, so the result is always in bounds. */
export function confineSkater(body: Body, radius: number): boolean {
  keepSkaterOutOfNets(body, radius);
  const contact = resolveBoardsCollision(body, radius, SKATER.boardsRestitution);
  return contact.hit;
}

/** Ticks for the puck to travel `distance` at its current speed, or Infinity when at rest. */
export function puckTravelTicks(distance: number, speed: number): number {
  if (speed <= PUCK.restSpeed) return Infinity;
  return distance / speed;
}
