/**
 * Which skater each seat is driving.
 *
 * NHL '94 rules: you always have the puck carrier if your team has the puck, and
 * otherwise you have whoever is closest to it. The assignment is recomputed from
 * scratch every tick and stored only in `controlledBy`, so a client that
 * mispredicts a switch self-corrects on the next snapshot instead of getting
 * stuck driving a skater the server thinks is AI.
 */

import { distance } from '../rink.js';
import { emptyInput } from '../types.js';
import type { PlayerInput, Seat, SkaterSimState } from '../types.js';
import type { SimContext } from './context.js';

function seatInput(ctx: SimContext, seat: Seat): PlayerInput {
  return ctx.inputs[seat.id] ?? emptyInput(ctx.state.tick);
}

/** On-ice skaters for a side, sorted by distance to the puck. Stable: ties break by slot. */
function byPuckProximity(ctx: SimContext, seat: Seat, taken: Set<string>): SkaterSimState[] {
  const puck = ctx.state.puck;
  return ctx.state.skaters
    .filter((s) => s.side === seat.side && s.onIce && !taken.has(s.id))
    .map((s) => ({ s, d: distance(s.x, s.y, puck.x, puck.y) }))
    .sort((a, b) => (a.d === b.d ? a.s.slot - b.s.slot : a.d - b.d))
    .map((entry) => entry.s);
}

/**
 * Reassign every seat.
 *
 * `switchPlayer` picks the *second* closest skater rather than cycling through a
 * list. Cycling would need last tick's button state to edge-detect, which is not
 * in GameSimState — and a held-down cycle that spins every tick is unplayable.
 * Second-closest-while-held is stable, needs no history, and does what a player
 * actually wants: "not that guy, the other one."
 */
export function assignControl(ctx: SimContext): void {
  for (const skater of ctx.state.skaters) skater.controlledBy = null;

  const taken = new Set<string>();
  // Seats in array order so two seats on the same side resolve identically everywhere.
  for (const seat of ctx.state.seats) {
    if (!seat.connected) continue;
    const candidates = byPuckProximity(ctx, seat, taken);
    if (candidates.length === 0) continue;

    const input = seatInput(ctx, seat);
    const carrier = candidates.find((s) => s.id === ctx.state.puck.carrierId);

    let chosen: SkaterSimState;
    if (input.switchPlayer) {
      chosen = candidates[1] ?? candidates[0];
    } else if (carrier !== undefined) {
      chosen = carrier;
    } else {
      chosen = candidates[0];
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
