import Phaser from 'phaser';
import { RENDER } from '@dfhl/shared';

import { BootScene } from './scenes/BootScene.js';

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
  scene: [BootScene],
});

/**
 * Exposed for debugging and for automated QA (inspector agents drive the game
 * through this handle). Development builds only.
 */
if (import.meta.env.DEV) {
  (window as unknown as { __game: Phaser.Game }).__game = game;
}
