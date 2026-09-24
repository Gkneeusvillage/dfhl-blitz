/**
 * Which skater each seat is driving.
 *
 * MANUAL SWITCHING, WITH ONE EXCEPTION
 *
 * A seat keeps the skater it has. Being nearer the puck does not take a skater
 * away from you — the NHL '94 auto-switch used to, and it made the man under
 * your thumb change without you asking, mid-stride, which is exactly the thing a
 * player cannot plan around. Control moves only when:
 *
 *  1. YOUR SIDE HAS THE PUCK. You always drive the carrier: catch a pass and you
 *     have the receiver, a teammate picks up a loose puck and you have him. This
 *     wins over everything, so pressing switch while your side has the puck does
 *     nothing — there is nobody better to be.
 *  2. YOU PRESS SWITCH. One press moves you to the teammate nearest the puck who
 *     is not the one you already have. It fires on the press, not while held:
 *     `Seat.switchHeld` latches last tick's button, and the server repeats a
 *     seat's last input when a packet is late, so a held button can never read
 *     as a second press.
 *  3. YOU HAVE NOBODY. Match start, a line change, a reconnect — take the skater
 *     nearest the puck, so control still lands on the play.
 *
 * The assignment lives entirely in `controlledBy`, so a client that mispredicts
 * a switch self-corrects on the next snapshot instead of getting stuck driving a
 * skater the server thinks is AI. The AI sends its own chaser after a loose puck
 * (`electChaser` in ai.ts only considers skaters no seat drives), so a seat
 * steering its man somewhere else can no longer stall the play.
 */

import { distance } from '../rink.js';
import { emptyInput } from '../types.js';
import type { PlayerInput, Seat, SkaterSimState } from '../types.js';
import type { SimContext } from './context.js';

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

/** Reassign every seat. */
export function assignControl(ctx: SimContext): void {
  // Last tick's binding, read before it is cleared: the skater a seat keeps.
  const incumbentOf = new Map<string, string>();
  for (const skater of ctx.state.skaters) {
    if (skater.controlledBy !== null) incumbentOf.set(skater.controlledBy, skater.id);
    skater.controlledBy = null;
  }

  const taken = new Set<string>();
  // Seats in array order so two seats on the same side resolve identically everywhere.
  for (const seat of ctx.state.seats) {
    const input = seatInput(ctx, seat);
    const pressed = input.switchPlayer && seat.switchHeld !== true;
    seat.switchHeld = input.switchPlayer;

    if (!seat.connected) continue;
    const candidates = byPuckProximity(ctx, seat, taken);
    if (candidates.length === 0) continue;

    const carrier = candidates.find((s) => s.id === ctx.state.puck.carrierId);
    const incumbent = candidates.find((s) => s.id === incumbentOf.get(seat.id));

    let chosen: SkaterSimState;
    if (carrier !== undefined) {
      chosen = carrier;
    } else if (incumbent === undefined) {
      chosen = candidates[0];
    } else if (pressed) {
      chosen = candidates.find((s) => s !== incumbent) ?? incumbent;
    } else {
      chosen = incumbent;
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
