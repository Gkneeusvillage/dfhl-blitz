import Phaser from 'phaser';
import { RENDER } from '@dfhl/shared';

import { MatchSession } from './net/session.js';
import { ControlsScene } from './scenes/ControlsScene.js';
import { LinePickerScene } from './scenes/LinePickerScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { MatchScene } from './scenes/MatchScene.js';
import { PostGameScene } from './scenes/PostGameScene.js';
import { TeamSelectScene } from './scenes/TeamSelectScene.js';
import { TitleScene } from './scenes/TitleScene.js';

/**
 * The session outlives every scene.
 *
 * The socket, the predictor and the playout buffer must survive the lobby ->
 * team select -> match -> post-game -> lobby transitions: tearing them down and
 * rebuilding them on a scene change would drop the connection at exactly the
 * moment the puck drops. Scenes read it out of the Phaser registry.
 */
const session = new MatchSession();

/**
 * The scene graph, in flow order.
 *
 *   Title ─▶ Lobby ─▶ TeamSelect ─▶ LinePicker ─▶ (host starts) ─▶ Match
 *     ▲        ▲          │             │                            │
 *     │        └──────────┴─────────────┘                            ▼
 *     └───────────────── Lobby ◀── PostGame ◀───────────────── final whistle
 *
 * Controls hangs off Title, Lobby and the in-match menu, and returns to
 * whichever asked for it. Phaser starts the first entry, so Title is the boot
 * scene; every other transition is an explicit `scene.start`.
 */
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: RENDER.designWidth,
  height: RENDER.designHeight,
  backgroundColor: '#0a0d14',
  scale: {
    /*
     * Sized by hand — see `fitCanvas` below for why neither FIT nor RESIZE
     * is used.
     */
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  // The simulation owns all physics; Phaser is rendering and input only.
  physics: undefined,
  scene: [
    TitleScene,
    LobbyScene,
    TeamSelectScene,
    LinePickerScene,
    MatchScene,
    PostGameScene,
    ControlsScene,
  ],
  callbacks: {
    preBoot: (instance) => instance.registry.set('session', session),
    postBoot: () => fitCanvas(),
  },
});

/**
 * The canvas is one game pixel per CSS pixel, resized to the window by hand.
 *
 * Neither of Phaser's automatic modes is right here, for two different reasons.
 *
 * FIT renders at the 1280x720 design size and magnifies the result, so on the
 * 1440p monitors the league plays on every rink line and every name on the ice
 * arrives as a blurred 2x pixel. The rink is vector graphics recomputed from
 * `RINK` each layout, so there is nothing to gain by drawing it small first.
 *
 * RESIZE would size the canvas from the parent element — and a parent that
 * measures 0x0, which is what a background or not-yet-laid-out tab reports,
 * makes Phaser build a 0x0 framebuffer. WebGL answers that with "Framebuffer
 * status: Incomplete Attachment" and the game never finishes booting. Measured,
 * not theorised: it is exactly what happened in the automated browser pane.
 *
 * So the game boots at a known-good size and is resized afterwards, with a floor
 * under it. A window that reports nothing gets a small canvas; it never gets an
 * impossible one.
 */
function fitCanvas(): void {
  const width = Math.max(320, Math.floor(window.innerWidth));
  const height = Math.max(240, Math.floor(window.innerHeight));
  game.scale.resize(width, height);
}

window.addEventListener('resize', fitCanvas);
// A tab restored from the background is the case where the window had no size
// at boot and gains one without a resize event ever being dispatched.
document.addEventListener('visibilitychange', fitCanvas);

/**
 * Exposed for debugging and for automated QA — the bot harness and inspector
 * agents drive the client through these. Development builds only.
 *
 * `requestAnimationFrame` does not fire while the page is hidden, which is the
 * normal state for an automated browser pane, so nothing ticks by itself there.
 * Stepping a scene by hand is the supported way in:
 *   __game.scene.getScene('Match').update(performance.now(), 16.67)
 *   __session.update(16.67)
 */
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, { __game: game, __session: session });
}
