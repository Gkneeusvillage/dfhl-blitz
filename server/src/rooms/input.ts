/**
 * The input path: the only thing a client is allowed to send that changes the
 * match.
 *
 * THE SECURITY MODEL, IN ONE SENTENCE: nothing that arrives from a client is
 * ever stored, forwarded, or simulated — `sanitizeInput` builds a brand new
 * `PlayerInput` out of exactly seven fields it reads by name, and that object is
 * the only thing the rest of the server sees. A payload carrying `x`, `score`,
 * `seatId`, or a prototype-polluting key does not need to be detected and
 * refused, because there is no code path that would read it. Structural, not
 * vigilant: vigilance is what you rely on when the structure lets you down.
 *
 * The seat an input belongs to is likewise never taken from the payload — the
 * room keys these buffers by Colyseus `sessionId` (see `seats.ts`).
 *
 * The other half of the file is the jitter buffer. Clients send the last
 * `NETWORK.inputRedundancy` inputs every tick, so a dropped packet costs
 * nothing as long as the next one lands; the server applies ticks it has not
 * seen and quietly ignores the repeats.
 */

import { AXIS_QUANT, NETWORK, emptyInput } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

export const INPUT_LIMITS = {
  /**
   * Inputs considered from one packet. Twice the redundancy leaves room for a
   * client that batches a little generously without letting one packet enqueue
   * a minute of intent.
   */
  maxPacketInputs: NETWORK.inputRedundancy * 2,
  /**
   * How far ahead of the server an input tick may legitimately be.
   *
   * A client predicts at most `NETWORK.maxPredictionTicks` past the last
   * snapshot it received, and that snapshot is up to a round trip old, so twice
   * the prediction cap (a full second at 60 Hz) is generous but still bounded.
   * Beyond it the sender is either badly broken or trying to run the clock
   * forward, and either way the input is refused.
   */
  maxLeadTicks: NETWORK.maxPredictionTicks * 2,
  /** Depth of the per-seat jitter buffer, in ticks. */
  maxBufferedTicks: NETWORK.maxPredictionTicks,
} as const;

export interface SeatInputBuffer {
  /** Unapplied inputs, ascending by tick, no duplicates. */
  pending: PlayerInput[];
  /** The most recently applied input, repeated while the buffer is dry. */
  last: PlayerInput;
  /**
   * Newest input tick applied for this seat — the `ackInputTick` the client
   * reconciles from. -1 until the seat has sent anything, which correctly tells
   * a fresh client to replay its entire input history.
   */
  ackTick: number;
  /** Counters, for the room's diagnostics. Never read by the simulation. */
  accepted: number;
  refused: number;
  overrun: number;
}

export function createInputBuffer(): SeatInputBuffer {
  return { pending: [], last: emptyInput(0), ackTick: -1, accepted: 0, refused: 0, overrun: 0 };
}

/**
 * Coerce one analog axis into the quantized integer range the simulation is
 * defined over.
 *
 * Clamping rather than refusing the whole input is deliberate. An out-of-range
 * axis cannot reach the simulation either way, so both are safe; the difference
 * is what happens to a client with an off-by-one in its own quantizer, and
 * "your skater keeps moving in the last direction you held" is a considerably
 * worse failure than "your skater moves at full speed", which is all a clamped
 * 99999 amounts to.
 */
function sanitizeAxis(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded < -AXIS_QUANT) return -AXIS_QUANT;
  if (rounded > AXIS_QUANT) return AXIS_QUANT;
  return rounded;
}

/**
 * Rebuild one input from an untrusted payload, or null if the tick makes it
 * unusable.
 *
 * A bad tick is fatal to the input because there is nothing sensible to fall
 * back to: the tick is what says *when* this intent applies, and guessing is
 * how you get a stale button press applied to the wrong faceoff.
 */
export function sanitizeInput(raw: unknown, serverTick: number): PlayerInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;

  const tick = source.tick;
  if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) return null;
  if (tick > serverTick + INPUT_LIMITS.maxLeadTicks) return null;

  return {
    tick,
    moveX: sanitizeAxis(source.moveX),
    moveY: sanitizeAxis(source.moveY),
    // `=== true` and not a truthiness test: a client sending `shoot: "yes"` gets
    // false, which is the safe reading of a message we do not understand.
    shoot: source.shoot === true,
    pass: source.pass === true,
    turbo: source.turbo === true,
    switchPlayer: source.switchPlayer === true,
  };
}

/** Insert keeping `pending` ascending by tick. Returns false for a duplicate tick. */
function insertPending(buffer: SeatInputBuffer, input: PlayerInput): boolean {
  const pending = buffer.pending;
  // Walk back from the end: packets arrive in order almost always, so the common
  // case is a single comparison and an append.
  let index = pending.length;
  while (index > 0 && pending[index - 1].tick > input.tick) index--;
  if (index > 0 && pending[index - 1].tick === input.tick) return false;
  pending.splice(index, 0, input);
  return true;
}

/**
 * Keep the buffer inside `maxBufferedTicks` by dropping from the FRONT.
 *
 * A seat whose packets arrive in a burst after a stall has a queue of intent
 * that is already historical. Replaying it in order to stay faithful would put
 * that seat half a second behind the match it is playing in; the newest intent
 * is the one worth having, so the stale end goes.
 */
function trimPending(buffer: SeatInputBuffer): void {
  const excess = buffer.pending.length - INPUT_LIMITS.maxBufferedTicks;
  if (excess <= 0) return;
  buffer.pending.splice(0, excess);
  buffer.overrun += excess;
}

/**
 * Take an `InputMessage` off the wire.
 *
 * @returns how many previously-unseen input ticks were queued. Zero is normal
 *          and expected — most of every packet is redundant by design.
 */
export function acceptInputPacket(
  buffer: SeatInputBuffer,
  message: unknown,
  serverTick: number,
): number {
  if (typeof message !== 'object' || message === null) {
    buffer.refused++;
    return 0;
  }
  const inputs = (message as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs)) {
    buffer.refused++;
    return 0;
  }

  // If a packet is oversized, keep the newest end of it: the tail is the intent
  // closest to now, and the head is what redundancy would have covered anyway.
  const window =
    inputs.length > INPUT_LIMITS.maxPacketInputs
      ? inputs.slice(inputs.length - INPUT_LIMITS.maxPacketInputs)
      : inputs;

  let accepted = 0;
  for (const raw of window) {
    const input = sanitizeInput(raw, serverTick);
    if (input === null) {
      buffer.refused++;
      continue;
    }
    // Already applied. Not a refusal — this is the redundancy doing its job.
    if (input.tick <= buffer.ackTick) continue;
    if (insertPending(buffer, input)) accepted++;
  }

  buffer.accepted += accepted;
  trimPending(buffer);
  return accepted;
}

/**
 * The input this seat acts on for one simulated tick.
 *
 * Exactly one queued input is consumed per tick so button presses keep their
 * sequence — skipping to the newest would swallow a tapped shot that happened
 * to share a frame with a burst. When nothing is queued the last input repeats,
 * which is what makes a single lost packet invisible.
 */
export function consumeInput(buffer: SeatInputBuffer): PlayerInput {
  const next = buffer.pending.shift();
  if (next === undefined) return buffer.last;
  buffer.last = next;
  buffer.ackTick = next.tick;
  return next;
}
