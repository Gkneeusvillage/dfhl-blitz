/**
 * Phase 0 smoke-test scene.
 *
 * Proves three things at once:
 *   1. Phaser renders,
 *   2. @dfhl/shared resolves and runs in the browser (the rink geometry is drawn
 *      from the same constants the simulation collides against),
 *   3. the Colyseus transport completes a round trip to the server.
 *
 * Pairs D (UI/UX) and F (Art) replace this scene entirely.
 */

import Phaser from 'phaser';
import { Client, type Room } from 'colyseus.js';
import { RENDER, RINK, TICK_RATE } from '@dfhl/shared';

import { resolveServerEndpoint } from '../net/endpoint.js';
import { createRinkTransform, drawRink } from '../render/rink.js';

export class BootScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private room: Room | null = null;

  constructor() {
    super('Boot');
  }

  // Phaser's Scene type does not declare the lifecycle hooks, so `override` is not valid here.
  create(): void {
    const { width, height } = this.scale;

    // Fit the whole 200 ft sheet on screen for this smoke test.
    const pixelsPerFoot = Math.min((width - 60) / RINK.length, (height - 160) / RINK.width);
    const transform = createRinkTransform(width / 2, height / 2, pixelsPerFoot);

    const graphics = this.add.graphics();
    drawRink(graphics, transform);

    this.add
      .text(width / 2, 34, 'DFHL BLITZ', {
        fontFamily: 'Impact, "Arial Black", sans-serif',
        fontSize: '44px',
        color: '#e8eef7',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, 70, `3-on-3 arcade hockey  •  sim ${TICK_RATE}Hz`, {
        fontFamily: 'Consolas, monospace',
        fontSize: '15px',
        color: '#7f93b0',
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(width / 2, height - 40, 'connecting to server…', {
        fontFamily: 'Consolas, monospace',
        fontSize: '16px',
        color: '#f4c542',
      })
      .setOrigin(0.5);

    void this.connect();
  }

  private async connect(): Promise<void> {
    const endpoint = resolveServerEndpoint();
    try {
      const client = new Client(endpoint);
      this.room = await client.joinOrCreate('hello');

      this.room.onMessage('welcome', (message: { sessionId: string; roomId: string }) => {
        console.info('[DFHL Blitz] joined room', message.roomId, 'as', message.sessionId);
      });

      this.room.onMessage('pong', (message: { clientTime: number; serverTime: number }) => {
        const rtt = Date.now() - message.clientTime;
        this.statusText.setColor('#5ddb84');
        this.statusText.setText(
          `connected to ${endpoint}  •  round trip ${rtt} ms  •  room ${this.room?.roomId ?? '?'}`,
        );
      });

      // Ping once a second so the status line keeps showing a live RTT.
      this.time.addEvent({
        delay: 1000,
        loop: true,
        callback: () => this.room?.send('ping', { clientTime: Date.now() }),
      });
      this.room.send('ping', { clientTime: Date.now() });
    } catch (error) {
      this.statusText.setColor('#ff6b6b');
      this.statusText.setText(
        `could not reach ${endpoint} — is the server running? (npm run dev)`,
      );
      console.error('[DFHL Blitz] connection failed:', error);
    }
  }
}

export const BOOT_SCENE_DESIGN = {
  width: RENDER.designWidth,
  height: RENDER.designHeight,
};
