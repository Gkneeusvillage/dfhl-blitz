/**
 * The sprite lab: every piece of player art, large enough to actually judge.
 *
 * WHY THIS EXISTS
 *
 * The art in `render/sprites.ts` is drawn in code, and code that draws pictures
 * cannot be reviewed by reading it — it has to be looked at. This page is the
 * feedback loop: open `?sprites`, screenshot it, say what is wrong. It routes off
 * a query parameter rather than a build flag so it works on the deployed URL too,
 * which is where anyone judging it will actually be.
 *
 * IT CALLS THE REAL BAKING PATH
 *
 * `bakeMatchSprites` and the frame lookups are the same functions a match uses, called
 * here with all fourteen franchises instead of the two on the ice. A second
 * drawing path built "just for the preview" would drift from the real one and
 * then flatter it — you would be reviewing art the game does not ship.
 *
 * IT IS A `UiScreen`, NOT A BARE DIV
 *
 * The first version built its controls as loose DOM buttons, and the d-pad did
 * nothing on it — which was reported, correctly, as a bug. Focus navigation lives
 * in `UiScreen`, and every other screen in the game gets it by using one. A
 * debug page is still a page somebody has to drive with whatever is in their
 * hands.
 *
 * IT PLAYS THE ANIMATIONS
 *
 * v0.2 added a stride cycle, shots, checks, falls and goalie saves. A still
 * frame of a stride says nothing about whether the cycle reads as skating, so
 * the eight headings run the stride live, next to the one-off poses and the
 * goalie's. The Arena button swaps the grid for the baked rink, so the ice can
 * be judged the same way.
 *
 * THE ZOOM CONTROL IS NOT A LUXURY
 *
 * At 96px you can see every pixel and judge the drawing; at 24px you find out
 * whether a defenceman still reads as a defenceman at the size he is actually
 * played at. Both questions matter and neither answers the other.
 */

import Phaser from 'phaser';

import { colorToInt, TEAM_LIST } from '../data/teams.js';
import { bakeArena } from '../render/rink.js';
import {
  DIRECTIONS,
  PUCK_TEXTURE,
  bakeMatchSprites,
  goalieFrame,
  kitTexture,
  netTexture,
  skaterFrame,
  type GoaliePose,
  type SkaterPose,
} from '../render/sprites.js';
import { UiScreen, button, div, write } from '../ui/index.js';

/** Backgrounds worth judging against, in the order the toggle cycles them. */
const BACKDROPS = [
  { name: 'ice', css: '#eef4fb', ink: '#0a0d14' },
  { name: 'dark', css: '#0a0d14', ink: '#e8eef7' },
  // The traditional "does this sprite have a stray pixel" background.
  { name: 'magenta', css: '#ff00ff', ink: '#0a0d14' },
] as const;

/** Display size of one sprite cell, in screen pixels. */
const ZOOMS = [28, 42, 56, 84, 112, 168];
const DEFAULT_ZOOM = 2;

const STRIDE: SkaterPose[] = ['stride0', 'stride1', 'stride2', 'stride3'];
const ONE_OFFS: SkaterPose[] = ['glide', 'windup', 'shoot', 'check', 'down'];
const GOALIE: GoaliePose[] = ['stance', 'butterfly', 'glove'];
/** Stride frames per second in the lab — about a skater at full speed. */
const STRIDE_FPS = 9;

/** Room for the franchise name and its two colour swatches. */
const LABEL_WIDTH = 190;

export class SpriteLabScene extends Phaser.Scene {
  private screen!: UiScreen;
  private zoomValue!: HTMLDivElement;
  private backdropValue!: HTMLDivElement;
  private zoomIndex = DEFAULT_ZOOM;
  private backdropIndex = 0;
  private showArena = false;
  private arenaValue!: HTMLDivElement;
  /** The images running the stride cycle, with the heading each one shows. */
  private striders: Array<{ image: Phaser.GameObjects.Image; texture: string; facing: number }> = [];
  private strideClock = 0;

  /** Everything the last layout drew, torn down before the next one. */
  private drawn: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super('SpriteLab');
  }

  create(): void {
    // Every franchise, through the real baking path.
    bakeMatchSprites(
      this,
      TEAM_LIST.map((team) => ({
        code: team.code,
        colors: { primary: team.primaryColor, secondary: team.secondaryColor },
      })),
    );

    this.buildScreen();
    this.layout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    const teardown = (): void => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
      this.screen.destroy();
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, teardown);
    this.events.once(Phaser.Scenes.Events.DESTROY, teardown);
  }

  override update(_time: number, delta: number): void {
    // What drives focus navigation. Without it the d-pad does nothing.
    this.screen.update(delta);

    this.strideClock += delta;
    const frame = STRIDE[Math.floor((this.strideClock / 1000) * STRIDE_FPS) % STRIDE.length];
    for (const s of this.striders) s.image.setTexture(s.texture, skaterFrame(frame, s.facing));
  }

  // -------------------------------------------------------------------------

  private buildScreen(): void {
    this.screen = new UiScreen({
      title: 'SPRITE LAB',
      subtitle: 'every franchise, from the same code a match uses',
      onBack: () => this.exit(),
    });

    this.zoomValue = div('lab__value', `${ZOOMS[this.zoomIndex]}px`);
    this.backdropValue = div('lab__value', BACKDROPS[this.backdropIndex].name);
    this.arenaValue = div('lab__value', 'off');

    /*
     * The body is left empty and made transparent on purpose: the art is on the
     * canvas underneath, and a panel over it would be reviewing the panel. The
     * screen is here for its header, its footer and its focus navigation.
     */
    this.screen.body.style.pointerEvents = 'none';
    this.screen.root.style.background = 'transparent';
    this.screen.body.append(
      div(
        'dim',
        'Judge the drawing large; judge whether it still reads small. ' +
          'Magenta is the stray-pixel check.',
      ),
    );

    this.screen.addFooter(
      button('Smaller', { className: 'btn--ghost', onClick: () => this.zoom(-1) }),
      this.zoomValue,
      button('Larger', {
        className: 'btn--ghost',
        onClick: () => this.zoom(1),
        attrs: { 'data-autofocus': 'true' },
      }),
      button('Background', { className: 'btn--ghost', onClick: () => this.cycleBackdrop() }),
      this.backdropValue,
      button('Arena', { className: 'btn--ghost', onClick: () => this.toggleArena() }),
      this.arenaValue,
      button('Back to the game', { className: 'btn--primary', onClick: () => this.exit() }),
    );
    this.screen.focusFirst();
  }

  private zoom(step: number): void {
    this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + step));
    write(this.zoomValue, `${ZOOMS[this.zoomIndex]}px`);
    this.layout();
  }

  private toggleArena(): void {
    this.showArena = !this.showArena;
    write(this.arenaValue, this.showArena ? 'on' : 'off');
    this.layout();
  }

  private cycleBackdrop(): void {
    this.backdropIndex = (this.backdropIndex + 1) % BACKDROPS.length;
    write(this.backdropValue, BACKDROPS[this.backdropIndex].name);
    this.layout();
  }

  /** Drop the query parameter, or the title screen bounces straight back here. */
  private exit(): void {
    this.screen.suspend();
    window.location.assign(window.location.pathname);
  }

  /**
   * Rebuild the grid.
   *
   * Sprites and their labels are Phaser objects on the canvas; the chrome is DOM.
   * That is the same split the match view uses, for the same reason: text and
   * buttons want CSS, and the art wants the canvas.
   */
  private layout(): void {
    for (const object of this.drawn) object.destroy();
    this.drawn = [];
    this.striders = [];

    const backdrop = BACKDROPS[this.backdropIndex];
    this.cameras.main.setBackgroundColor(backdrop.css);
    const top = this.screen.head.getBoundingClientRect().height + 40;

    if (this.showArena) {
      this.layoutArena(top);
      return;
    }

    const size = ZOOMS[this.zoomIndex];
    const gap = Math.max(4, Math.round(size * 0.08));
    const rowHeight = size + 22;

    TEAM_LIST.forEach((team, row) => {
      const y = top + row * rowHeight + size / 2;
      const kit = kitTexture(team.code);

      this.keep(
        this.add
          .text(14, y - 9, `${team.abbreviation}  ${team.displayName}`, {
            fontFamily: 'Consolas, monospace',
            fontSize: '13px',
            color: backdrop.ink,
          })
          .setOrigin(0, 0.5),
      );

      // The two colours as swatches, so a jersey that looks wrong can be checked
      // against the config rather than argued about.
      [team.primaryColor, team.secondaryColor].forEach((hex, i) => {
        this.keep(this.add.rectangle(20 + i * 18, y + 12, 14, 14, colorToInt(hex)));
      });

      // Eight headings, skating.
      let x = LABEL_WIDTH;
      for (let d = 0; d < DIRECTIONS; d++) {
        const facing = (d / DIRECTIONS) * Math.PI * 2;
        const image = this.place(kit, skaterFrame('stride0', facing), x, y, size);
        this.striders.push({ image, texture: kit, facing });
        x += size + gap;
      }

      // The one-off poses, all facing the same way so they compare.
      x += gap * 3;
      for (const pose of ONE_OFFS) {
        this.place(kit, skaterFrame(pose, 0), x, y, size);
        x += size + gap;
      }

      // A clear break, so the goalie is obviously not another skater pose.
      x += gap * 3;
      for (const pose of GOALIE) {
        this.place(kit, goalieFrame(pose, Math.PI), x, y, size);
        x += size + gap;
      }

      x += gap * 3;
      this.keep(this.add.image(x, y, netTexture(team.code), 'net').setOrigin(0, 0.5).setScale(size / 56));
      x += size * 0.8;
      this.keep(this.add.image(x, y, PUCK_TEXTURE, 'p:0').setOrigin(0, 0.5).setScale(size / 56));
    });
  }

  /** The baked arena for the first two franchises, fitted to the window. */
  private layoutArena(top: number): void {
    const [a, b] = TEAM_LIST;
    const key = bakeArena(this, {
      home: { color: a.primaryColor, trim: a.secondaryColor, name: a.displayName },
      away: { color: b.primaryColor, trim: b.secondaryColor, name: b.displayName },
    });
    const image = this.add.image(this.scale.width / 2, top, key).setOrigin(0.5, 0);
    const fit = Math.min((this.scale.width - 40) / image.width, (this.scale.height - top - 90) / image.height);
    image.setScale(Math.max(0.25, fit));
    this.keep(image);
  }

  private place(texture: string, frame: string, x: number, y: number, size: number): Phaser.GameObjects.Image {
    const image = this.add.image(x, y, texture, frame).setOrigin(0, 0.5).setDisplaySize(size, size);
    this.keep(image);
    return image;
  }

  private keep(object: Phaser.GameObjects.GameObject): void {
    this.drawn.push(object);
  }
}
