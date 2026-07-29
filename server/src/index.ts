/**
 * DFHL Blitz game server.
 *
 * A single Node process serves both the built client (static files) and the
 * Colyseus WebSocket endpoint, so the whole game deploys as one service behind
 * one URL — which is all the league needs to share.
 */

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';

import { HelloRoom } from './rooms/HelloRoom.js';

/**
 * Port resolution, most explicit first:
 *   --port 2567   (used by the dev script, so a PORT injected by a launcher for
 *                  the Vite client can never steal the game server's port)
 *   $PORT         (what Railway / Render / Fly set in production)
 *   2567          (default)
 */
function resolvePort(): number {
  const flagIndex = process.argv.indexOf('--port');
  if (flagIndex !== -1) {
    const value = Number(process.argv[flagIndex + 1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return Number(process.env.PORT ?? 2567);
}

const PORT = resolvePort();
const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * In development the client is served by Vite on its own port.
 * In production `npm run build` emits the client into server/public.
 */
const publicDir = path.resolve(dirname, '../public');

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  // SPA fallback. Express 5 rejects the bare '*' route pattern, so this is
  // expressed as terminal middleware instead.
  app.use((_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  app.use((_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send('DFHL Blitz server is running. Client is served by Vite in dev (npm run dev).');
  });
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('hello', HelloRoom);

gameServer
  .listen(PORT)
  .then(() => {
    console.log(`[DFHL Blitz] server listening on http://localhost:${PORT}`);
  })
  .catch((error: unknown) => {
    console.error('[DFHL Blitz] failed to start:', error);
    process.exit(1);
  });
