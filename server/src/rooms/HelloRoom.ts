/**
 * Phase 0 smoke-test room.
 *
 * Its only job is to prove the transport works end to end: a client connects,
 * sends a message, and gets one back. Pair C (Netcode & Server) replaces this
 * with the real LobbyRoom and MatchRoom.
 *
 * Note the deliberate absence of @colyseus/schema state. DFHL Blitz does not
 * mirror GameSimState into Schema classes — the simulation owns a plain object
 * and the server broadcasts it as snapshot messages. Colyseus is used for
 * rooms, matchmaking, and transport only.
 */

import { Room, type Client } from '@colyseus/core';

interface PingMessage {
  clientTime: number;
}

export class HelloRoom extends Room {
  override maxClients = 6;

  override onCreate(): void {
    this.onMessage('ping', (client: Client, message: PingMessage) => {
      client.send('pong', {
        clientTime: message?.clientTime ?? 0,
        serverTime: Date.now(),
      });
    });
  }

  override onJoin(client: Client): void {
    console.log(`[HelloRoom] ${client.sessionId} joined (${this.clients.length} in room)`);
    client.send('welcome', { sessionId: client.sessionId, roomId: this.roomId });
  }

  override onLeave(client: Client): void {
    console.log(`[HelloRoom] ${client.sessionId} left`);
  }
}
