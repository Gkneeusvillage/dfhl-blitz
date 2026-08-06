/**
 * Which skater each seat is driving.
 *
 * NHL '94 rules: you always have the puck carrier if your team has the puck, and
 * otherwise you have whoever is closest to it. The assignment lives entirely in
 * `controlledBy`, so a client that mispredicts a switch self-corrects on the next
 * snapshot instead of getting stuck driving a skater the server thinks is AI.
 *
 * Two rules bend "closest to the puck", and both exist because a seat that simply
 * holds one stick direction used to be able to stall the match outright:
 *
 *  1. HYSTERESIS. A challenger has to be nearer by `CONTROL.switchMarginFeet`
 *     before it takes a seat's skater away. Straight nearest-wins flipped the
 *     seat-to-skater binding 46 times per 1,000 ticks in a measured run, which is
 *     unplayable long before it is a bug.
 *  2. THE CHASER IS OFF LIMITS. While the puck is loose and dead, the one skater
 *     the AI has sent to fetch it cannot be *taken over* mid-errand. Without this
 *     the held stick dragged away whichever teammate got closest, `electChaser`
 *     re-elected from the rest, and the new chaser was hijacked in turn: measured,
 *     a loose puck sat motionless at one spot for 9,217 consecutive ticks
 *     (153.6 s) of a 180 s period with one seat a side and both sticks held.
 *
 * Neither rule can cost a seat its *first* skater — a seat with nothing to drive
 * always takes the nearest, so control still snaps to the play the moment a line
 * changes or a match starts.
 */

import { CONTROL } from '../tuning.js';
import { distance } from '../rink.js';
import { emptyInput } from '../types.js';
import type { PlayerInput, Seat, SkaterSimState } from '../types.js';
import type { SimContext } from './context.js';
import { isLive } from './context.js';

function seatInput(ctx: SimContext, seat: Seat): PlayerInput {
  return ctx.inputs[seat.id] ?? emptyInput(ctx.state.tick);
}

function puckDistance(ctx: SimContext, skater: SkaterSimState): number {
  const puck = ctx.state.puck;
  return distance(skater.x, skater.y, puck.x, puck.y);
}

/** On-ice skaters for a side, sorted by distance to the puck. Stable: ties break by slot. */
function byPuckProximity(ctx: SimContext, seat: Seat, taken: Set<string>): SkaterSimState[] {
  return ctx.state.skaters
    .filter((s) => s.side === seat.side && s.onIce && !taken.has(s.id))
    .map((s) => ({ s, d: puckDistance(ctx, s) }))
    .sort((a, b) => (a.d === b.d ? a.s.slot - b.s.slot : a.d - b.d))
    .map((entry) => entry.s);
}

/**
 * Is the puck sitting there waiting to be fetched?
 *
 * Only a *dead* puck reserves a chaser. A loose puck still travelling is the play
 * itself, and a seat must be able to follow it to whichever skater it reaches —
 * snapping control to the man the puck is arriving at is the whole feel of the
 * auto-switch and is not something to trade away.
 */
function puckIsDead(ctx: SimContext): boolean {
  const puck = ctx.state.puck;
  if (puck.carrierId !== null) return false;
  // Squared, so the branch is decided by multiplications and a comparison. Every
  // engine rounds those identically; `Math.hypot` is only approximated, and a
  // value that decides who a seat is driving is the last place in a lockstep
  // simulation that should depend on whose libm is doing the arithmetic.
  return puck.vx * puck.vx + puck.vy * puck.vy <= CONTROL.deadPuckSpeed * CONTROL.deadPuckSpeed;
}

/**
 * The skaters no seat may take over this tick: one per side, the nearest skater
 * to a dead puck that the AI was driving last tick.
 *
 * "Last tick" is what makes this non-circular. `electChaser` in ai.ts picks the
 * nearest skater with `controlledBy === null`, and `controlledBy` still holds the
 * previous tick's answer at the point this runs — so the reservation names the
 * same skater the AI is about to send, without either module having to run first.
 */
function reservedChasers(ctx: SimContext): Set<string> {
  const reserved = new Set<string>();
  if (!isLive(ctx.state) || !puckIsDead(ctx)) return reserved;

  for (const side of ['home', 'away'] as const) {
    let best: SkaterSimState | null = null;
    let bestDist = Infinity;
    for (const skater of ctx.state.skaters) {
      if (skater.side !== side || !skater.onIce || skater.controlledBy !== null) continue;
      const d = puckDistance(ctx, skater);
      // Ties break on slot so the reservation cannot depend on array order.
      if (d < bestDist || (d === bestDist && best !== null && skater.slot < best.slot)) {
        bestDist = d;
        best = skater;
      }
    }
    if (best !== null) reserved.add(best.id);
  }
  return reserved;
}

/**
 * Reassign every seat.
 *
 * `switchPlayer` picks the *second* closest skater rather than cycling through a
 * list. Cycling would need last tick's button state to edge-detect, which is not
 * in GameSimState — and a held-down cycle that spins every tick is unplayable.
 * Second-closest-while-held is stable, needs no history, and does what a player
 * actually wants: "not that guy, the other one." It is also an explicit
 * instruction, so it overrides both the hysteresis and the chaser reservation.
 */
export function assignControl(ctx: SimContext): void {
  const reserved = reservedChasers(ctx);

  // Last tick's binding, read before it is cleared: the incumbent a seat keeps
  // unless something clearly better comes along.
  const incumbentOf = new Map<string, string>();
  for (const skater of ctx.state.skaters) {
    if (skater.controlledBy !== null) incumbentOf.set(skater.controlledBy, skater.id);
    skater.controlledBy = null;
  }

  const taken = new Set<string>();
  // Seats in array order so two seats on the same side resolve identically everywhere.
  for (const seat of ctx.state.seats) {
    if (!seat.connected) continue;
    const candidates = byPuckProximity(ctx, seat, taken);
    if (candidates.length === 0) continue;

    const input = seatInput(ctx, seat);
    const carrier = candidates.find((s) => s.id === ctx.state.puck.carrierId);
    const incumbent = candidates.find((s) => s.id === incumbentOf.get(seat.id));

    let chosen: SkaterSimState;
    if (input.switchPlayer) {
      chosen = candidates[1] ?? candidates[0];
    } else if (carrier !== undefined) {
      // Your side has it: you have the man with it, no questions asked.
      chosen = carrier;
    } else if (incumbent === undefined) {
      chosen = candidates[0];
    } else {
      const challenger = candidates.find((s) => s !== incumbent && !reserved.has(s.id));
      chosen =
        challenger !== undefined &&
        puckDistance(ctx, challenger) < puckDistance(ctx, incumbent) - CONTROL.switchMarginFeet
          ? challenger
          : incumbent;
    }

    chosen.controlledBy = seat.id;
    taken.add(chosen.id);
  }
}

/** The input a skater acts on this tick: their seat's, or nothing if they are AI. */
export function humanInputFor(ctx: SimContext, skater: SkaterSimState): PlayerInput | null {
  if (skater.controlledBy === null) return null;
  const input = ctx.inputs[skater.controlledBy];
  return input ?? emptyInput(ctx.state.tick);
}
