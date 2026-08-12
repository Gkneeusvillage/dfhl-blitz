/**
 * The game server, in this process, on a port nobody else is using.
 *
 * WHY IN-PROCESS: the harness needs a third opinion. Two clients agreeing about
 * the score proves only that they were sent the same bytes — they both read the
 * same broadcast, so agreement between them is nearly free. The question worth
 * asking is whether what the clients believe matches what the SERVER believes,
 * and the only way to ask that without going back through the wire the clients
 * already read is to hold the room object and look.
 *
 * WHY PORT 0: the harness must never collide with a dev server on 2567, and a
 * test that strands a port is worse than a test that fails. The OS hands out a
 * free one and everything downstream is told where to connect.
 *
 * The room class, the room name, and the `filterBy(['code'])` that makes room
 * codes work are all imported from the server itself rather than restated here —
 * a harness that configures matchmaking differently from production is a harness
 * that tests a server nobody ships.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { MATCH_ROOM } from '@dfhl/shared';
import type { GameSimState } from '@dfhl/shared';

import { MatchRoom } from '../server/src/rooms/MatchRoom.js';

/**
 * The private shape of a live `MatchRoom`.
 *
 * Reaching past `private` is deliberate and is the entire reason this file
 * exists: see the header. Written as a structural type rather than `any` so a
 * rename in the server breaks the harness loudly instead of quietly reporting
 * that the server has no opinion about the score.
 */
interface RoomInternals {
  roomCode: string;
  runner: {
    state: GameSimState;
    buffers: Map<string, { accepted: number; refused: number; overrun: number; ackTick: number; pending: unknown[] }>;
  } | null;
}

export interface SeatInputStats {
  seatId: string;
  accepted: number;
  refused: number;
  overrun: number;
  ackTick: number;
  pending: number;
}

export interface HarnessServer {
  readonly port: number;
  readonly endpoint: string;
  /** The authoritative match state, or null when no match is running in that room. */
  peekState(roomId: string): GameSimState | null;
  /** Per-seat input buffer counters, which is where a refused input shows up. */
  peekInputStats(roomId: string): SeatInputStats[];
  /** Whether the matchmaker still lists the room. */
  isListed(roomId: string): Promise<boolean>;
  stop(): Promise<void>;
}

function internals(roomId: string): RoomInternals | null {
  try {
    const room = matchMaker.getLocalRoomById(roomId);
    if (room === undefined || room === null) return null;
    return room as unknown as RoomInternals;
  } catch {
    // A disposed room is not an error here — it is the answer to the question.
    return null;
  }
}

export async function startMatchServer(port = 0): Promise<HarnessServer> {
  const httpServer: HttpServer = createServer();
  const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });

  gameServer.define(MATCH_ROOM, MatchRoom).filterBy(['code']);

  await gameServer.listen(port);
  const address = httpServer.address() as AddressInfo | null;
  if (address === null) throw new Error('harness server failed to bind');

  return {
    port: address.port,
    endpoint: `ws://127.0.0.1:${address.port}`,

    peekState(roomId: string): GameSimState | null {
      return internals(roomId)?.runner?.state ?? null;
    },

    peekInputStats(roomId: string): SeatInputStats[] {
      const runner = internals(roomId)?.runner;
      if (runner === undefined || runner === null) return [];
      return [...runner.buffers.entries()].map(([seatId, buffer]) => ({
        seatId,
        accepted: buffer.accepted,
        refused: buffer.refused,
        overrun: buffer.overrun,
        ackTick: buffer.ackTick,
        pending: buffer.pending.length,
      }));
    },

    async isListed(roomId: string): Promise<boolean> {
      const rooms = await matchMaker.query({ name: MATCH_ROOM });
      return rooms.some((room) => room.roomId === roomId);
    },

    async stop(): Promise<void> {
      // `false`: shutting the harness down must not take the process with it, or
      // a vitest run ends the moment the first suite finishes.
      await gameServer.gracefullyShutdown(false);
    },
  };
}
