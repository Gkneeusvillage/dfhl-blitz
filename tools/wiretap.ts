/**
 * The byte meter and the impairment layer, both wrapped around the TRANSPORT.
 *
 * WHY THE TRANSPORT AND NOT THE GAME LOGIC: a latency harness that adds delay by
 * holding back `room.send` calls, or by sitting on snapshots inside the client's
 * message handler, is measuring the harness. The thing under test is what the
 * netcode does when the *wire* is slow, so the impairment goes where the wire
 * is: `connection.transport.send` on the way out, `ws.onmessage` on the way in.
 * Everything above that — the protocol, the prediction, the reconciliation —
 * cannot tell the difference between this and a bad hotel connection.
 *
 * WHY THE BYTES ARE COUNTED HERE TOO: this is the only place the *encoded* frame
 * exists. Above it there are decoded objects, and JSON.stringify of a decoded
 * object is a fine number to quote but it is not what the socket carried.
 * Colyseus frames a room message as
 *
 *     [ 1 byte protocol code ][ msgpack fixstr message type ][ msgpackr payload ]
 *
 * so a frame is self-describing enough to attribute bytes per message type
 * without decoding the payload, which is what makes a per-message-type bandwidth
 * breakdown cheap enough to run for a whole match.
 *
 * WHAT LOSS MAY AND MAY NOT EAT: Colyseus rides TCP and has no retransmission of
 * its own, so a dropped JOIN_ROOM or matchStart is not "2% packet loss", it is a
 * broken room — the harness would be testing its own impairment layer rather
 * than the netcode. Loss is therefore applied only to the two message types the
 * design already treats as expendable: `input`, which is resent with
 * NETWORK.inputRedundancy redundancy, and `snapshot`, which is a whole state and
 * is superseded 20 times a second. Those are exactly the frames a real UDP-style
 * loss event would cost us, and they are the ones the netcode claims to survive.
 *
 * Ordering is preserved even under jitter (a delayed frame delays the frames
 * behind it) because that is what a TCP stream does; reordering is a datagram
 * behaviour and inventing it here would test a failure mode the transport cannot
 * actually produce.
 */

import type { Room } from 'colyseus.js';

import { ClientMessage, ServerMessage, Rng } from '@dfhl/shared';

/** Colyseus protocol code for a room message. Everything else is handshake/lifecycle. */
const ROOM_DATA = 13;

/** msgpack fixstr: the top three bits are 101 and the low five are the length. */
const FIXSTR_MASK = 0xe0;
const FIXSTR_TAG = 0xa0;
const FIXSTR_LENGTH = 0x1f;

const decoder = new TextDecoder();

export type Direction = 'sent' | 'received';

export interface Impairment {
  /** One-way delay added in EACH direction. 150 here is a 300 ms round trip. */
  delayMs: number;
  /** Extra uniform random delay on top, 0..jitterMs, drawn per frame. */
  jitterMs: number;
  /** Probability that one droppable frame is discarded. */
  lossRate: number;
  /** Seeds the loss/jitter draws so an impaired run is reproducible. */
  seed: number;
}

export const CLEAN_LINK: Impairment = { delayMs: 0, jitterMs: 0, lossRate: 0, seed: 1 };

/** The rubric's number: 150 ms one way, 2% loss. */
export const RUBRIC_LINK: Impairment = { delayMs: 150, jitterMs: 0, lossRate: 0.02, seed: 0x5eed };

/**
 * Message types loss is allowed to eat.
 *
 * Both are redundant by design — see the file header. Anything else is carried
 * faithfully no matter how bad the link is configured to be.
 */
const DROPPABLE = new Set<string>([ClientMessage.Input, ServerMessage.Snapshot]);

export interface Tally {
  frames: number;
  /** Bytes the socket carried, i.e. after msgpack. */
  wireBytes: number;
  /** Bytes the same payload would be as JSON. Filled in by the caller, which has the object. */
  jsonBytes: number;
}

function emptyTally(): Tally {
  return { frames: 0, wireBytes: 0, jsonBytes: 0 };
}

export interface DirectionStats {
  total: Tally;
  byType: Map<string, Tally>;
  dropped: number;
}

function emptyDirection(): DirectionStats {
  return { total: emptyTally(), byType: new Map(), dropped: 0 };
}

/**
 * The message type a frame carries, or a `protocol:N` label for the handshake
 * and lifecycle frames that have no type string.
 *
 * Only fixstr type names are decoded, which covers every name in `protocol.ts`
 * — all of them are far under 32 characters, and a longer one would be a
 * protocol change that wants looking at anyway.
 */
export function frameMessageType(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'protocol:empty';
  if (bytes[0] !== ROOM_DATA) return `protocol:${bytes[0]}`;
  if (bytes.length < 2) return 'protocol:13';

  const prefix = bytes[1];
  if ((prefix & FIXSTR_MASK) !== FIXSTR_TAG) return 'protocol:13';
  const length = prefix & FIXSTR_LENGTH;
  if (bytes.length < 2 + length) return 'protocol:13';
  return decoder.decode(bytes.subarray(2, 2 + length));
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

/**
 * One direction of the link.
 *
 * `earliest` is what preserves ordering: every frame is scheduled at least as
 * late as the one before it, so jitter stretches the stream rather than
 * shuffling it.
 */
class Pipe {
  private earliest = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly impairment: Impairment,
    private readonly rng: Rng,
    private readonly stats: DirectionStats,
    private readonly deliver: (data: Uint8Array) => void,
  ) {}

  push(data: Uint8Array): void {
    const type = frameMessageType(data);

    this.stats.total.frames++;
    this.stats.total.wireBytes += data.byteLength;
    const perType = this.stats.byType.get(type) ?? emptyTally();
    perType.frames++;
    perType.wireBytes += data.byteLength;
    this.stats.byType.set(type, perType);

    if (this.impairment.lossRate > 0 && DROPPABLE.has(type) && this.rng.chance(this.impairment.lossRate)) {
      this.stats.dropped++;
      return;
    }

    if (this.impairment.delayMs <= 0 && this.impairment.jitterMs <= 0) {
      this.deliver(data);
      return;
    }

    // The outbound buffer belongs to colyseus.js's packr and is reused by the
    // very next `room.send`. Holding a view of it for 150 ms would deliver
    // whatever the client said next, which looks exactly like a desync bug and
    // is not one.
    const held = new Uint8Array(data);

    const now = performance.now();
    const wait = this.impairment.delayMs + this.impairment.jitterMs * this.rng.next();
    const at = Math.max(now + wait, this.earliest);
    this.earliest = at;

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.deliver(held);
    }, at - now);
    // A harness that cannot exit because a 150 ms timer is still pending is a
    // harness people stop running.
    timer.unref?.();
    this.timers.add(timer);
  }

  /** Deliver nothing further. Used when the room is closing. */
  discardPending(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * Instrumentation clamped onto one room's socket.
 *
 * Attached after `joinOrCreate` resolves, so the handshake itself is neither
 * counted nor impaired. That is deliberate on both counts: the handshake is a
 * one-off and the number worth having is steady-state gameplay bandwidth.
 */
export class Wiretap {
  readonly sent = emptyDirection();
  readonly received = emptyDirection();

  private outbound: Pipe | null = null;
  private inbound: Pipe | null = null;
  private restore: (() => void) | null = null;
  private windowStartMs = performance.now();
  private windowEndMs: number | null = null;
  private windowOpened = false;

  constructor(private readonly impairment: Impairment = CLEAN_LINK) {}

  attach(room: Room): void {
    // colyseus.js's Connection exposes `transport`, and its WebSocket transport
    // exposes `ws`; neither is in the published ITransport interface, hence the
    // structural cast rather than `any`. If a future version renames them this
    // throws immediately instead of silently measuring nothing.
    const transport = room.connection.transport as unknown as {
      send(data: Uint8Array): void;
      ws?: { onmessage: ((event: { data: unknown }) => void) | null };
    };
    const socket = transport.ws;
    if (socket === undefined || typeof socket.onmessage !== 'function') {
      throw new Error('Wiretap: colyseus.js transport has no live WebSocket to tap');
    }

    const realSend = transport.send.bind(transport);
    const realOnMessage = socket.onmessage.bind(socket);
    const rng = new Rng(this.impairment.seed);

    this.outbound = new Pipe(this.impairment, rng, this.sent, (data) => realSend(data));
    // colyseus.js reads `event.data` and immediately does `new Uint8Array(...)`
    // over it, which copies for a typed array — so handing it the view is safe
    // even for a frame this pipe has been sitting on.
    this.inbound = new Pipe(this.impairment, rng, this.received, (data) => realOnMessage({ data }));

    transport.send = (data: Uint8Array) => this.outbound?.push(toBytes(data));
    socket.onmessage = (event: { data: unknown }) => this.inbound?.push(toBytes(event.data));

    this.restore = () => {
      transport.send = realSend;
      socket.onmessage = realOnMessage;
    };

    // Only the FIRST attach opens the window. A client that drops and reconnects
    // mid-match gets a second socket, and restarting the clock there would report
    // a match's worth of bytes over the seconds since the reconnect.
    if (!this.windowOpened) {
      this.windowOpened = true;
      this.windowStartMs = performance.now();
    }
  }

  /** Stop counting. Called at the final whistle so a slow shutdown does not dilute the rates. */
  closeWindow(): void {
    if (this.windowEndMs === null) this.windowEndMs = performance.now();
  }

  detach(): void {
    this.outbound?.discardPending();
    this.inbound?.discardPending();
    this.restore?.();
    this.restore = null;
  }

  /** Seconds the counters cover. */
  get windowSeconds(): number {
    const end = this.windowEndMs ?? performance.now();
    return Math.max(1e-3, (end - this.windowStartMs) / 1000);
  }

  /**
   * Record what one message would have cost as JSON.
   *
   * Supplied by the caller because only it has the decoded object; the tap sees
   * bytes. Both numbers are wanted: JSON is what the design document quoted and
   * what a delta-encoding argument would be made against, msgpack is what the
   * league's connections actually pay.
   */
  noteJson(direction: Direction, type: string, message: unknown): void {
    const stats = direction === 'sent' ? this.sent : this.received;
    const bytes = Buffer.byteLength(JSON.stringify(message ?? null), 'utf8');
    stats.total.jsonBytes += bytes;
    const perType = stats.byType.get(type) ?? emptyTally();
    perType.jsonBytes += bytes;
    stats.byType.set(type, perType);
  }
}

/**
 * WebSocket framing overhead the byte counts above do NOT include.
 *
 * A server-to-client frame costs 2 bytes of header for payloads under 126 bytes
 * and 4 for anything up to 64 KB; a client-to-server frame adds a 4-byte mask on
 * top. Quoted separately rather than folded in, because the encoder is what the
 * netcode controls and the framing is what the protocol costs regardless.
 */
export function framingOverheadBytes(direction: Direction, payloadBytes: number): number {
  const header = payloadBytes < 126 ? 2 : payloadBytes < 65536 ? 4 : 10;
  return direction === 'sent' ? header + 4 : header;
}
