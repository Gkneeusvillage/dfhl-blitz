import Phaser from 'phaser';
import { RENDER } from '@dfhl/shared';

import { audio } from './audio/index.js';
import { MatchSession } from './net/session.js';
import { ControlsScene } from './scenes/ControlsScene.js';
import { LinePickerScene } from './scenes/LinePickerScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { MatchScene } from './scenes/MatchScene.js';
import { PostGameScene } from './scenes/PostGameScene.js';
import { SpriteLabScene } from './scenes/SpriteLabScene.js';
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
    SpriteLabScene,
  ],
  callbacks: {
    preBoot: (instance) => instance.registry.set('session', session),
    postBoot: () => {
      fitCanvas();
      /*
       * `?sprites` opens the art lab instead of the game.
       *
       * A query parameter rather than a build flag, deliberately: the art has to
       * be judged where it will actually be seen, which is the deployed URL on
       * somebody else's monitor, not a dev build on this machine. It costs one
       * scene in the bundle and nothing at runtime for anyone who does not ask.
       */
      if (new URLSearchParams(window.location.search).has('sprites')) {
        game.scene.start('SpriteLab');
        game.scene.stop('Title');
      }
    },
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

/*
 * Audio starts on the player's first real gesture, not before.
 *
 * Browsers refuse to run an AudioContext until the page has been interacted
 * with, and one created earlier lands in "suspended" and stays there — so the
 * horn on the first goal would never sound. These listeners are `once` and cover
 * every way into the game: a click, a key, or a gamepad button pressed on the
 * title screen.
 */
for (const type of ['pointerdown', 'keydown', 'gamepadconnected'] as const) {
  window.addEventListener(type, () => audio.unlock(), { once: true });
}

window.addEventListener('resize', fitCanvas);
// A tab restored from the background is the case where the window had no size
// at boot and gains one without a resize event ever being dispatched.
document.addEventListener('visibilitychange', fitCanvas);

/*
 * The backstop: watch the element, not the events.
 *
 * Both listeners above are event-driven, and a window that boots at 0x0 and
 * later gains a size without dispatching either one leaves the canvas pinned at
 * the 320x240 floor forever — measured exactly that, a 320x240 canvas inside a
 * 1280x720 window, with the game running happily in the corner. A ResizeObserver
 * fires on the box actually changing, whatever did or did not emit an event, so
 * the layout can no longer be wrong and stay wrong.
 */
if (typeof ResizeObserver !== 'undefined') {
  const parent = document.getElementById('game') ?? document.body;
  new ResizeObserver(() => fitCanvas()).observe(parent);
}

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
