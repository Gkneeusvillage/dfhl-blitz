/**
 * Goalie AI and save resolution.
 *
 * The design target is "fair but beatable": routine shots from the outside are
 * stopped about three times in four, while anything that arrives before the
 * goalie can read it — point blank, a one-timer, a shot into a rebound — goes in.
 *
 * Three rules produce that, and none of them is a dice roll on the shot itself:
 *
 *  1. REACTION WINDOW. A shot with less flight time left than the goalie's
 *     reaction beats them clean: they never commit, and an uncommitted goalie
 *     cannot stop a live shot at all. Beating a goalie is therefore about *where
 *     you shoot from*, which is the arcade behaviour tuning.ts describes.
 *  2. READ ERROR. When the goalie does commit, it guesses where the puck will
 *     cross the line and is wrong by up to `readError` feet. The guess is derived
 *     from the shot's own velocity rather than the rng, so it is fixed for the
 *     whole flight — a goalie that re-rolled its read every tick would average
 *     out to a perfect read and never be beaten. The save itself is always the
 *     goalie's body: a save radius wider than the 6 ft mouth would cover the whole
 *     net from anywhere in the crease and make placement meaningless.
 *  3. COMMITMENT COSTS. A committed goalie cannot commit again for
 *     `lungeCooldownTicks`, which is what makes rebounds and cross-crease plays
 *     the highest-percentage chances on the ice.
 *
 * Slow pucks — dribblers, rebounds trickling back — are always stopped by the
 * body, so play cannot stall in the crease.
 */

import { GOALIE, PUCK, RINK, lerpAttr } from '../tuning.js';
import { clamp, defendingGoalX, distance, resolveBoardsCollision } from '../rink.js';
import { randomFloatFromState, seedFromString } from '../rng.js';
import { otherSide } from '../types.js';
import type { GoalieAttributes, GoalieSimState, PuckSimState, TeamSide } from '../types.js';
import type { SimContext } from './context.js';
import { goalieAttrs, goalieFor } from './context.js';
import { speedOf, sweepPointCircle } from './physics.js';

/** Ticks until a loose puck reaches the given goal line, or Infinity if it never will. */
function ticksToGoalLine(puck: PuckSimState, side: TeamSide): number {
  const goalX = defendingGoalX(side);
  if (Math.abs(puck.vx) < 1e-6) return Infinity;
  const ticks = (goalX - puck.x) / puck.vx;
  return ticks > 0 ? ticks : Infinity;
}

/** Where the puck would cross this side's goal line if nothing touched it. */
function crossingY(puck: PuckSimState, ticks: number): number {
  return puck.y + puck.vy * ticks;
}

/**
 * The goalie's misread of this particular shot, in [-1, 1].
 *
 * Derived from the puck's flight rather than from `state.rng`, which is
 * deliberate: the goalie has to commit to one wrong idea and live with it. A
 * misread re-rolled every tick would average out to a perfect read and the goalie
 * would never be beaten. It is still perfectly pure and deterministic — it just
 * reads its entropy from the shot instead of from the stream.
 */
function readNoise(ctx: SimContext, puck: PuckSimState, goalieId: string): number {
  // Keyed on the flight DIRECTION, not the velocity: ice friction scales vx and vy
  // together every tick, so a key built from the components would change under the
  // goalie and let a re-rolled guess converge on the truth.
  //
  // The direction is quantized off a normalized vector rather than off
  // `Math.atan2`. Multiplication, division and `Math.sqrt` are exactly rounded on
  // every engine; `atan2` is only implementation-approximated, and a value that
  // decides a discrete branch is the last place in a lockstep simulation that
  // should depend on which engine is doing the arithmetic.
  const speed = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy) || 1;
  const dx = Math.round((puck.vx / speed) * 256);
  const dy = Math.round((puck.vy / speed) * 256);

  // The match seed is in the key too. Without it the misread was a function of
  // the angle and the goalie id alone — and the ids are only ever 'home-g' and
  // 'away-g', so all 14 franchises shared one pattern and it was the same pattern
  // in every match ever played. An angle that beat a goalie once beat them for
  // the rest of the league's history. Now the read is fixed for a flight, fixed
  // for a match, and different in the next one.
  const key = `${goalieId}|${ctx.config.seed}|${dx}|${dy}`;
  return randomFloatFromState(seedFromString(key)) * 2 - 1;
}

/** Where this goalie thinks the shot is going. Stable for the whole flight. */
function readShot(
  ctx: SimContext,
  puck: PuckSimState,
  goalie: GoalieSimState,
  attrs: GoalieAttributes,
  ticks: number,
): number {
  const error = lerpAttr(attrs.reflexes, GOALIE.readErrorLow, GOALIE.readErrorHigh);
  return clamp(
    crossingY(puck, ticks) + readNoise(ctx, puck, goalie.id) * error,
    -GOALIE.maxLateralOffset,
    GOALIE.maxLateralOffset,
  );
}

/**
 * The angle-cutting spot: on the line from the puck to the middle of the net, out
 * as far as the goalie dares. Better `positioning` means coming out further,
 * which shrinks the net the shooter can see.
 */
function trackingTarget(ctx: SimContext, goalie: GoalieSimState): { x: number; y: number } {
  const attrs = goalieAttrs(ctx.config, goalie);
  const puck = ctx.state.puck;
  const goalX = defendingGoalX(goalie.side);
  const inward = goalie.side === 'home' ? 1 : -1;

  const dx = puck.x - goalX;
  const dy = puck.y;
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

/** Is this puck a live shot, as opposed to something trickling around the crease? */
function isLiveShot(puck: PuckSimState): boolean {
  return puck.carrierId === null && speedOf(puck) >= GOALIE.shotDetectSpeed;
}

/**
 * Flight time of a shot already inbound at this net, or Infinity if there is not
 * one worth setting the feet for.
 *
 * Gated on `lungeTriggerTicks` — the same window `considerCommit` uses — so a
 * hard pass through the neutral zone is not treated as a shot at this net.
 */
function inboundShotTicks(ctx: SimContext, goalie: GoalieSimState): number {
  const puck = ctx.state.puck;
  if (!isLiveShot(puck)) return Infinity;
  const ticks = ticksToGoalLine(puck, goalie.side);
  if (!Number.isFinite(ticks) || ticks > GOALIE.lungeTriggerTicks) return Infinity;
  return ticks;
}

/**
 * Commit to a save if the shot can be read in time.
 *
 * The commitment lasts until the puck arrives, not a fixed number of ticks — a
 * goalie whose dive expired mid-flight would be beaten by every long shot.
 */
function considerCommit(ctx: SimContext, goalie: GoalieSimState): void {
  if (goalie.lunge > 0 || goalie.lungeCooldown > 0) return;

  const puck = ctx.state.puck;
  if (!isLiveShot(puck)) return;

  const ticks = ticksToGoalLine(puck, goalie.side);
  if (!Number.isFinite(ticks) || ticks > GOALIE.lungeTriggerTicks) return;

  const attrs = goalieAttrs(ctx.config, goalie);
  const reaction = lerpAttr(attrs.reflexes, GOALIE.reactionTicksLow, GOALIE.reactionTicksHigh);
  if (ticks < reaction) return;

  // Do not bite on a puck that is missing the net anyway.
  if (Math.abs(crossingY(puck, ticks)) > RINK.goalHalfWidth + GOALIE.radius) return;

  goalie.lunge = Math.max(GOALIE.lungeTicks, Math.ceil(ticks) + 2);
}

/** Move the goalie for one tick: either riding out a commitment or tracking the puck. */
export function updateGoalie(ctx: SimContext, goalie: GoalieSimState): void {
  if (goalie.lungeCooldown > 0) goalie.lungeCooldown--;

  // A commitment is to ONE puck flight. The moment a skater takes possession that
  // flight is over and the goalie has to reset before committing again.
  //
  // Without this the commitment simply carried across: a goalie would read the
  // pass, commit to it, and still be committed — full body, tracking the new
  // flight — when the one-timer came off the stick. That is why one-timers used
  // to be *stopped more often* than ordinary shots. Spending the commitment is
  // what makes the cross-crease play and the rebound the best chances on the ice,
  // which is the behaviour this module has always claimed to have.
  if (goalie.lunge > 0 && ctx.state.puck.carrierId !== null) {
    goalie.lunge = 0;
    goalie.lungeCooldown = GOALIE.lungeCooldownTicks;
  }

  considerCommit(ctx, goalie);

  const attrs = goalieAttrs(ctx.config, goalie);
  const puck = ctx.state.puck;

  let targetX: number;
  let targetY: number;
  let speed: number;

  if (goalie.lunge > 0 && isLiveShot(puck)) {
    const ticks = ticksToGoalLine(puck, goalie.side);
    const guess = Number.isFinite(ticks) ? readShot(ctx, puck, goalie, attrs, ticks) : goalie.y;
    // Square up on the goal line for the save rather than staying out challenging.
    const inward = goalie.side === 'home' ? 1 : -1;
    targetX = defendingGoalX(goalie.side) + inward * GOALIE.restDepth;
    targetY = guess;
    // A dive is speed, not reach: `lungeReach` spread over `lungeTicks` and then
    // multiplied, so a goalie that rides a commitment out covers
    // `lungeSpeedMultiplier` times `lungeReach` of ice. That is what `reflexes`
    // buys — getting there — rather than a bigger hitbox once it has.
    speed =
      (lerpAttr(attrs.reflexes, GOALIE.lungeReachLow, GOALIE.lungeReachHigh) / GOALIE.lungeTicks) *
      GOALIE.lungeSpeedMultiplier;
  } else if (Number.isFinite(inboundShotTicks(ctx, goalie))) {
    /*
     * A shot is on the way and this goalie never committed to it — too quick to
     * read, or the last commitment is still on cooldown. Their feet are set, so
     * they stay exactly where the shot caught them.
     *
     * This is the whole reaction-window mechanic, and leaving it out inverted the
     * game. The tracking branch below aims at the line from the puck to the middle
     * of the net, which is the shot's own path: a goalie too slow to react was
     * therefore left standing perfectly in the way, while one that DID react
     * abandoned that line for a guess it could be wrong about. Measured before this
     * branch existed: unread shots were stopped 91.6% of the time against 78.8% for
     * read ones, the slot was the worst place on the ice to shoot from, and 1,500
     * point-blank wrist shots produced zero goals.
     */
    /*
     * Caught leaning. The goalie keeps drifting the way they were already going
     * instead of holding a perfect stance, and `readNoise` decides which way.
     *
     * Freezing them dead still was not enough on its own, and the measurement said
     * so: a goalie that has been tracking is BY CONSTRUCTION sitting on the line
     * from the puck to the middle of the net, which is the shot's own path, so
     * standing still there still stopped 88.6% of unread shots against 76.3% for
     * read ones. Being unable to react has to cost something. The lean is small
     * and it is fixed for the flight, so a quick shot to the far side beats them
     * and one straight into the crest does not.
     */
    const lean = readNoise(ctx, puck, goalie.id) * GOALIE.flatFootedLean;
    targetX = goalie.x;
    targetY = clamp(goalie.y + lean, -GOALIE.maxLateralOffset, GOALIE.maxLateralOffset);
    speed = lerpAttr(attrs.positioning, GOALIE.moveSpeedLow, GOALIE.moveSpeedHigh);
  } else {
    const track = trackingTarget(ctx, goalie);
    targetX = track.x;
    targetY = track.y;
    speed = lerpAttr(attrs.positioning, GOALIE.moveSpeedLow, GOALIE.moveSpeedHigh);
  }

  const dx = targetX - goalie.x;
  const dy = targetY - goalie.y;
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

  if (goalie.lunge > 0) {
    goalie.lunge--;
    if (goalie.lunge === 0) goalie.lungeCooldown = GOALIE.lungeCooldownTicks;
  }

  // The goalie never leaves the paint, whatever the tracking maths asked for.
  const goalX = defendingGoalX(goalie.side);
  const inward = goalie.side === 'home' ? 1 : -1;
  const limit = goalX + inward * GOALIE.maxChallengeDepth;
  goalie.x = inward > 0 ? clamp(goalie.x, goalX, limit) : clamp(goalie.x, limit, goalX);
  goalie.y = clamp(goalie.y, -GOALIE.maxLateralOffset, GOALIE.maxLateralOffset);
  goalie.facing = Math.atan2(puck.y - goalie.y, puck.x - goalie.x);
}

/**
 * How much of the puck's path this goalie can actually take away right now.
 *
 * A committed goalie gets its full body; a goalie that never read the shot gets
 * only the fraction of that body the puck happens to run into. That difference is
 * the entire reaction-window mechanic, expressed as geometry.
 *
 * The dive deliberately adds nothing here. `lungeReach` is spent as movement in
 * `updateGoalie`, not as radius — a save radius that grew with reflexes would
 * cover the whole 6 ft mouth from anywhere in the crease and make placement
 * meaningless, which is the one thing this module exists to avoid.
 */
function saveRadius(ctx: SimContext, goalie: GoalieSimState): number {
  const body = GOALIE.radius + PUCK.radius;
  if (!isLiveShot(ctx.state.puck)) return body;
  if (goalie.lunge <= 0) return body * GOALIE.flatFootedFactor;
  return body;
}

/** Would this puck, left alone from here, end up in the net? */
function onTarget(puck: PuckSimState, side: TeamSide, fromX: number, fromY: number): boolean {
  const goalX = defendingGoalX(side);
  if (Math.abs(puck.vx) < 1e-6) return false;
  const ticks = (goalX - fromX) / puck.vx;
  if (ticks < 0) return false;
  return Math.abs(fromY + puck.vy * ticks) <= RINK.goalHalfWidth;
}

export interface SaveResult {
  /** The puck was stopped. False means it went straight past the goalie. */
  stopped: boolean;
  /** Stopped a real shot that was going in — the only kind that belongs in a save percentage. */
  save: boolean;
  frozen: boolean;
}

const NO_CONTACT: SaveResult = { stopped: false, save: false, frozen: false };

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
  const radius = saveRadius(ctx, goalie);
  if (radius <= 0) return NO_CONTACT;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const t = sweepPointCircle(fromX, fromY, dx, dy, goalie.x, goalie.y, radius);
  if (t < 0) return NO_CONTACT;

  const attrs = goalieAttrs(ctx.config, goalie);
  const contactX = fromX + dx * t;
  const contactY = fromY + dy * t;
  const incoming = speedOf(puck);
  // A body in the way stops a puck that was missing the net too — it is just not
  // a save, and counting it as one is what quietly inflates a goalie's numbers.
  const wasGoingIn = onTarget(puck, goalie.side, contactX, contactY);
  // Nor is smothering a trickler that bumped the pads. Scrambles in the crease
  // put the puck back on the goalie several ticks running, and counting each of
  // those as a save inflated the pooled save percentage and fired the save cue
  // over and over. `shotDetectSpeed` is the same line the goalie's own AI uses to
  // decide whether a loose puck is a shot at all.
  const wasShot = wasGoingIn && incoming >= GOALIE.shotDetectSpeed;

  puck.x = contactX;
  puck.y = contactY;
  puck.carrierId = null;
  puck.oneTimerTicks = 0;
  puck.lastTouchedBy = goalie.id;
  puck.lastTouchSide = goalie.side;

  if (wasShot) {
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
  }

  /*
   * A goalie only covers up on a shot they actually had to deal with.
   *
   * This used to roll on EVERY contact under `freezeMaxSpeed`, including the
   * dribblers and the wide shots a goalie in the real world simply plays. The
   * result was 49 freeze whistles a match on top of 12.9 goals — a stoppage every
   * 8.7 s of live play, 22.3% of the clock spent dead, and, because lines
   * alternate on every stoppage, a chosen line on the ice in 8.5 s bursts. For a
   * game in the spirit of NHL '94 that is the wrong shape entirely.
   *
   * `freezeOffTargetFactor` keeps the case alive rather than deleting it: a puck
   * that was missing can still be smothered, just rarely enough to be an event.
   */
  const freezeChance =
    lerpAttr(attrs.reboundControl, GOALIE.freezeChanceLow, GOALIE.freezeChanceHigh) *
    (wasShot ? 1 : GOALIE.freezeOffTargetFactor);
  if (incoming <= GOALIE.freezeMaxSpeed && ctx.rng.chance(freezeChance)) {
    puck.vx = 0;
    puck.vy = 0;
    // The whistle is the single most frequent stoppage in the game, and it used
    // to stop play without emitting anything at all — so the client cut from live
    // hockey to a faceoff with no cue to play a whistle or a save reaction over.
    // `SimEvent` is the only channel presentation has.
    ctx.events.push({
      type: 'whistle',
      tick: ctx.state.tick,
      actorId: goalie.id,
      side: goalie.side,
      x: contactX,
      y: contactY,
    });
    return { stopped: true, save: wasShot, frozen: true };
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

  /*
   * Carry the rebound through the rest of the tick.
   *
   * Without this the puck is left sitting exactly on the contact point, and a
   * puck already inside the save circle makes `sweepPointCircle` report t = 0 —
   * so the next tick puts it back on its own origin, and the one after that, for
   * as long as the goalie stands over it. Measured: a loose puck pinned at
   * (84.0, -1.5) for 119 consecutive ticks with the goalie 1.9 ft away and the
   * nearest skater orbiting at 3.2 ft against a 2.2 ft reach, because a skater is
   * held `SKATER.radius + GOALIE.radius` off the goalie and can never get to it.
   * That is the same shape of bug as the puck that used to park on a goal post,
   * in a different circle.
   *
   * The post fix also seats the puck a hair clear of the circle it just left;
   * that half is deliberately NOT copied here. The normal can point at the goal
   * line — the goalie plays two feet off it — and teleporting the puck 2.4 ft
   * that way would put it in the net without any segment ever crossing the line,
   * which is a goal that never gets called. Spending the travel is enough:
   * `reboundMinSpeed` is 0.35 ft/tick against a goalie who tracks at 0.30, so the
   * puck is always outbound and clears the circle within a few ticks.
   */
  const remaining = 1 - t;
  if (remaining > 0) {
    puck.x += puck.vx * remaining;
    puck.y += puck.vy * remaining;
    resolveBoardsCollision(puck, PUCK.radius, PUCK.boardsRestitution);
  }
  return { stopped: true, save: wasShot, frozen: false };
}

/**
 * Deal with a puck that has died at the goalie's feet.
 *
 * This case is not optional and it is not rare: a puck at rest within about a
 * foot of a goalie is *physically unplayable* by anybody else, because a skater
 * is held `SKATER.radius + GOALIE.radius` away from the goalie and cannot get a
 * stick on it. Measured over three AI matches, every single dead-puck stall
 * happened here, at x within 6 ft of a goal line with the goalie 1.9 ft off the
 * puck and the nearest skater orbiting at 3.2-4.7 ft against a 2.2 ft reach.
 *
 * The goalie therefore has to resolve it — but stopping play is the expensive way
 * to do that. Covering it up every time was worth 14.6 whistles a match on its
 * own. So the goalie usually just *plays* the puck: a clearing shove up the ice
 * and toward the near boards, which is what a real goalie does with a puck in the
 * corner of their crease and which leaves the game running. `reboundControl`
 * decides how often they take the safe option and freeze it instead.
 *
 * @returns true if play stopped.
 */
export function tryCoverLoosePuck(ctx: SimContext, goalie: GoalieSimState): boolean {
  const puck = ctx.state.puck;
  if (puck.carrierId !== null) return false;
  if (speedOf(puck) > GOALIE.playPuckMaxSpeed) return false;
  if (distance(puck.x, puck.y, goalie.x, goalie.y) > GOALIE.radius + PUCK.pickupRadius) return false;
  // Somebody can play it: let them, and let the scramble be a scramble.
  for (const skater of ctx.state.skaters) {
    if (!skater.onIce || skater.stun > 0) continue;
    if (distance(skater.x, skater.y, puck.x, puck.y) <= PUCK.pickupRadius) return false;
  }

  const attrs = goalieAttrs(ctx.config, goalie);
  puck.lastTouchedBy = goalie.id;
  puck.lastTouchSide = goalie.side;

  const freezeChance = lerpAttr(
    attrs.reboundControl,
    GOALIE.freezeChanceLow,
    GOALIE.freezeChanceHigh,
  );
  if (ctx.rng.chance(freezeChance)) {
    puck.vx = 0;
    puck.vy = 0;
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

  // Up the ice and out toward the nearer side board, never across the front of
  // their own net: a clearance that curls back in is an own goal waiting to
  // happen. Reported as a `pass`, because that is exactly what it is and the
  // client already has a cue for it.
  const upIce = goalie.side === 'home' ? 1 : -1;
  const towardBoards = puck.y >= 0 ? 1 : -1;
  const len = Math.sqrt(1 + GOALIE.clearWideness * GOALIE.clearWideness);
  puck.vx = (upIce / len) * GOALIE.clearSpeed;
  puck.vy = ((towardBoards * GOALIE.clearWideness) / len) * GOALIE.clearSpeed;
  puck.pickupCooldown = 0;
  puck.oneTimerTicks = 0;
  ctx.events.push({
    type: 'pass',
    tick: ctx.state.tick,
    actorId: goalie.id,
    side: goalie.side,
    x: puck.x,
    y: puck.y,
    power: GOALIE.clearSpeed,
  });
  return false;
}

/** The goalie defending against the given attacking side. */
export function opposingGoalie(ctx: SimContext, attackingSide: TeamSide): GoalieSimState {
  return goalieFor(ctx.state, otherSide(attackingSide));
}
