import Phaser from 'phaser';
import { RENDER } from '@dfhl/shared';

import { MatchSession } from './net/session.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { MatchScene } from './scenes/MatchScene.js';

/**
 * The session outlives every scene.
 *
 * The socket, the predictor and the playout buffer must survive the lobby ->
 * match -> lobby transitions: tearing them down and rebuilding them on a scene
 * change would drop the connection at exactly the moment the puck drops. Scenes
 * read it out of the Phaser registry.
 */
const session = new MatchSession();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: RENDER.designWidth,
  height: RENDER.designHeight,
  backgroundColor: '#0a0d14',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // The simulation owns all physics; Phaser is rendering and input only.
  physics: undefined,
  scene: [LobbyScene, MatchScene],
  callbacks: {
    preBoot: (instance) => instance.registry.set('session', session),
  },
});

/**
 * Exposed for debugging and for automated QA — the bot harness and inspector
 * agents drive the client through these. Development builds only.
 */
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, { __game: game, __session: session });
}
