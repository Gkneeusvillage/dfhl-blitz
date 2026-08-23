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
 * `bakeMatchSprites` and `spriteFor` are the same functions a match uses, called
 * here with all fourteen franchises instead of the two on the ice. A second
 * drawing path built "just for the preview" would drift from the real one and
 * then flatter it — you would be reviewing art the game does not ship.
 *
 * THE ZOOM CONTROL IS NOT A LUXURY
 *
 * At 96px you can see every pixel and judge the drawing; at 24px you find out
 * whether a defenceman still reads as a defenceman at the size he is actually
 * played at. Both questions matter and neither answers the other.
 */

import Phaser from 'phaser';

import { colorToInt, TEAM_LIST } from '../data/teams.js';
import { DIRECTIONS, bakeMatchSprites, spriteFor } from '../render/sprites.js';
import { button, div, ensureStyles, write } from '../ui/index.js';

/** Backgrounds worth judging against, in the order the toggle cycles them. */
const BACKDROPS = [
  { name: 'ice', css: '#eef4fb', ink: '#0a0d14' },
  { name: 'dark', css: '#0a0d14', ink: '#e8eef7' },
  // The traditional "does this sprite have a stray pixel" background.
  { name: 'magenta', css: '#ff00ff', ink: '#0a0d14' },
] as const;

/** Display size of one sprite cell, in screen pixels. */
const ZOOMS = [16, 24, 32, 48, 64, 96, 128];
const DEFAULT_ZOOM = 4;

/** Room for the franchise name and its two colour swatches. */
const LABEL_WIDTH = 190;

export class SpriteLabScene extends Phaser.Scene {
  private root!: HTMLDivElement;
  private zoomIndex = DEFAULT_ZOOM;
  private backdropIndex = 0;

  /** Everything the last layout drew, torn down before the next one. */
  private drawn: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super('SpriteLab');
  }

  create(): void {
    ensureStyles();

    // Every franchise, through the real baking path.
    bakeMatchSprites(
      this,
      TEAM_LIST.map((team) => ({
        code: team.code,
        colors: { primary: team.primaryColor, secondary: team.secondaryColor },
      })),
    );

    this.buildChrome();
    this.layout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
      this.root.remove();
    });
  }

  // -------------------------------------------------------------------------

  private buildChrome(): void {
    this.root = div('dfhl lab');

    const zoomValue = div('lab__value', `${ZOOMS[this.zoomIndex]}px`);
    const backdropValue = div('lab__value', BACKDROPS[this.backdropIndex].name);

    const controls = div('lab__controls');
    controls.append(
      button('smaller', {
        className: 'btn--ghost',
        onClick: () => {
          this.zoomIndex = Math.max(0, this.zoomIndex - 1);
          write(zoomValue, `${ZOOMS[this.zoomIndex]}px`);
          this.layout();
        },
      }),
      zoomValue,
      button('larger', {
        className: 'btn--ghost',
        onClick: () => {
          this.zoomIndex = Math.min(ZOOMS.length - 1, this.zoomIndex + 1);
          write(zoomValue, `${ZOOMS[this.zoomIndex]}px`);
          this.layout();
        },
      }),
      button('background', {
        className: 'btn--ghost',
        onClick: () => {
          this.backdropIndex = (this.backdropIndex + 1) % BACKDROPS.length;
          write(backdropValue, BACKDROPS[this.backdropIndex].name);
          this.layout();
        },
      }),
      backdropValue,
      button('back to the game', {
        className: 'btn--primary',
        // Drop the query parameter, or the title screen bounces straight back here.
        onClick: () => window.location.assign(window.location.pathname),
      }),
    );

    this.root.append(
      div('lab__title', 'SPRITE LAB'),
      div(
        'lab__hint',
        'Every franchise, every heading, from the same code a match uses. ' +
          'Judge the drawing large; judge whether it still reads small.',
      ),
      controls,
    );
    document.body.append(this.root);
  }

  /**
   * Rebuild the grid.
   *
   * Sprites and their labels are Phaser objects on the canvas; the controls above
   * are DOM. That is the same split the match view uses, and it is here for the
   * same reason: text and buttons want CSS, and the art wants the canvas.
   */
  private layout(): void {
    for (const object of this.drawn) object.destroy();
    this.drawn = [];

    const backdrop = BACKDROPS[this.backdropIndex];
    this.cameras.main.setBackgroundColor(backdrop.css);

    const size = ZOOMS[this.zoomIndex];
    const gap = Math.max(6, Math.round(size * 0.14));
    const rowHeight = size + gap + 22;
    const top = this.root.getBoundingClientRect().height + 24;

    TEAM_LIST.forEach((team, row) => {
      const y = top + row * rowHeight + size / 2;

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

      let x = LABEL_WIDTH;
      for (let d = 0; d < DIRECTIONS; d++) {
        const facing = (d / DIRECTIONS) * Math.PI * 2;
        this.place(spriteFor('skater', team.code, facing), x, y, size);
        x += size + gap;
      }

      // A clear break, so the goalie is obviously not a ninth heading.
      x += gap * 3;
      this.place(spriteFor('goalie', team.code, 0), x, y, size);
      x += size + gap * 3;
      this.place('dfhl:puck', x, y, size);
    });
  }

  private place(texture: string, x: number, y: number, size: number): void {
    this.keep(this.add.image(x, y, texture).setOrigin(0, 0.5).setDisplaySize(size, size));
  }

  private keep(object: Phaser.GameObjects.GameObject): void {
    this.drawn.push(object);
  }
}
