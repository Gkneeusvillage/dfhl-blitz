/**
 * The player art, drawn in code.
 *
 * WHY GENERATED RATHER THAN DRAWN BY HAND
 *
 * Jersey colours come from `teams.config.json`, which the league owner is
 * expected to edit. Hand-authored sprites would mean fourteen sets of art that
 * go stale the moment somebody changes a colour, or a single grey sprite tinted
 * whole — and Phaser's tint multiplies the ENTIRE texture, so a tinted skater
 * gets a red helmet, red skates and a red stick along with the sweater. Drawing
 * per team at match start costs a few milliseconds for the two teams on the ice
 * and keeps every pixel under our control: sweater in the primary, helmet and
 * socks in the secondary, skin and stick in neither.
 *
 * WHY EIGHT BAKED DIRECTIONS INSTEAD OF ROTATING ONE SPRITE
 *
 * Rotating pixel art resamples it, and resampled pixel art stops looking like
 * pixel art — the edges go soft and the whole retro premise leaks away. Eight
 * headings baked at draw time keeps every sprite axis-aligned on screen. Eight
 * is also what the era actually did, and at this size the snapping between them
 * reads as animation rather than as a limitation.
 *
 * WHY NEAREST FILTERING
 *
 * The canvas resizes to the window, so the foot-to-pixel scale is not an integer
 * and the sprites are never displayed at exactly their authored size. NEAREST
 * keeps the enlargement blocky instead of blurry, which is the difference
 * between "low resolution on purpose" and "low resolution by accident".
 */

import Phaser from 'phaser';

/** Authoring grid. Everything below is in these units, then scaled by NEAREST. */
const CELL = 32;

/** Headings baked, starting at +x and going clockwise on screen. */
export const DIRECTIONS = 8;

const SKIN = '#e8b98a';
const STICK = '#c48a4a';
const BLADE = '#2a2f3a';
const DARK = '#12161f';
const ICE_SHADOW = 'rgba(0,0,0,0.28)';

export interface JerseyColors {
  primary: string;
  secondary: string;
}

function textureKey(kind: string, code: string, direction: number): string {
  return `dfhl:${kind}:${code}:${direction}`;
}

/**
 * Draw one skater at one heading.
 *
 * The figure is built from the top down as a real broadcast angle would read it:
 * a shadow on the ice, then skates, then the sweater, then shoulders, then the
 * helmet, with the stick laid across the front. Order matters — the stick has to
 * sit over the sweater or it looks like the player is holding it behind them.
 */
function drawSkater(ctx: CanvasRenderingContext2D, colors: JerseyColors, angle: number): void {
  const c = CELL / 2;
  ctx.clearRect(0, 0, CELL, CELL);

  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(angle);
  // Draw in a space where +x is "the way this player is facing", then let the
  // rotation above place it. The pixels are still snapped by NEAREST on display.
  ctx.imageSmoothingEnabled = false;

  // Shadow, offset slightly so the skater reads as standing on the ice.
  ctx.fillStyle = ICE_SHADOW;
  ctx.beginPath();
  ctx.ellipse(0, 3, 9, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Skates.
  ctx.fillStyle = BLADE;
  ctx.fillRect(-6, -7, 5, 3);
  ctx.fillRect(-6, 4, 5, 3);

  // Sweater: a torso wider at the shoulders than the waist.
  ctx.fillStyle = colors.primary;
  ctx.beginPath();
  ctx.moveTo(-6, -7);
  ctx.lineTo(5, -6);
  ctx.lineTo(5, 6);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fill();

  // Shoulder yoke and socks in the second colour, which is what makes two teams
  // with similar primaries still tell apart at a glance.
  ctx.fillStyle = colors.secondary;
  ctx.fillRect(2, -7, 3, 14);
  ctx.fillRect(-6, -7, 2, 3);
  ctx.fillRect(-6, 4, 2, 3);

  // Gloves.
  ctx.fillStyle = DARK;
  ctx.fillRect(4, -9, 4, 4);
  ctx.fillRect(4, 5, 4, 4);

  // Helmet, with a sliver of face so the heading is readable at a glance.
  ctx.fillStyle = colors.secondary;
  ctx.beginPath();
  ctx.arc(3, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = SKIN;
  ctx.fillRect(6, -2, 2, 4);

  // Stick: shaft forward and across, blade on the ice ahead of the player.
  ctx.strokeStyle = STICK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(5, -7);
  ctx.lineTo(13, 4);
  ctx.stroke();
  ctx.fillStyle = BLADE;
  ctx.fillRect(12, 3, 5, 2);

  ctx.restore();
}

/** The goalie: bigger, squarer, unmistakably not a skater. */
function drawGoalie(ctx: CanvasRenderingContext2D, colors: JerseyColors, angle: number): void {
  const c = CELL / 2;
  ctx.clearRect(0, 0, CELL, CELL);

  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = ICE_SHADOW;
  ctx.beginPath();
  ctx.ellipse(0, 3, 11, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // Pads: the widest thing on the ice, and the reason a goalie reads as a wall.
  ctx.fillStyle = '#f2f4f8';
  ctx.fillRect(2, -11, 7, 9);
  ctx.fillRect(2, 2, 7, 9);

  ctx.fillStyle = colors.primary;
  ctx.beginPath();
  ctx.moveTo(-7, -8);
  ctx.lineTo(4, -7);
  ctx.lineTo(4, 7);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors.secondary;
  ctx.fillRect(1, -8, 3, 16);

  // Blocker and trapper.
  ctx.fillStyle = DARK;
  ctx.fillRect(5, -12, 5, 5);
  ctx.fillRect(5, 7, 5, 5);

  ctx.fillStyle = colors.secondary;
  ctx.beginPath();
  ctx.arc(2, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#cfd6e2';
  ctx.fillRect(5, -2, 2, 4);

  ctx.strokeStyle = STICK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(4, -6);
  ctx.lineTo(12, 6);
  ctx.stroke();

  ctx.restore();
}

/** The puck: a disc with a highlight, so it is findable against white ice. */
function drawPuck(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, CELL, CELL);
  const c = CELL / 2;
  ctx.fillStyle = ICE_SHADOW;
  ctx.beginPath();
  ctx.ellipse(c, c + 2, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0c0f16';
  ctx.beginPath();
  ctx.ellipse(c, c, 6, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#39404f';
  ctx.beginPath();
  ctx.ellipse(c - 1, c - 1, 3, 2, 0, 0, Math.PI * 2);
  ctx.fill();
}

function bake(
  scene: Phaser.Scene,
  key: string,
  paint: (ctx: CanvasRenderingContext2D) => void,
): void {
  if (scene.textures.exists(key)) return;
  const texture = scene.textures.createCanvas(key, CELL, CELL);
  if (texture === null) return;
  paint(texture.getContext());
  // NEAREST is what keeps the enlargement blocky rather than blurry.
  texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
  texture.refresh();
}

/**
 * Generate every texture a match needs, once.
 *
 * Called with the two teams actually playing, so this is 8 headings x 2 kinds x
 * 2 teams plus a puck — 33 small canvases, a few milliseconds, and nothing to
 * download.
 */
export function bakeMatchSprites(
  scene: Phaser.Scene,
  teams: Array<{ code: string; colors: JerseyColors }>,
): void {
  for (const team of teams) {
    for (let d = 0; d < DIRECTIONS; d++) {
      const angle = (d / DIRECTIONS) * Math.PI * 2;
      bake(scene, textureKey('skater', team.code, d), (ctx) => drawSkater(ctx, team.colors, angle));
      bake(scene, textureKey('goalie', team.code, d), (ctx) => drawGoalie(ctx, team.colors, angle));
    }
  }
  bake(scene, 'dfhl:puck', drawPuck);
}

/** The baked texture nearest to a heading in radians. */
export function spriteFor(kind: 'skater' | 'goalie', code: string, facing: number): string {
  const step = (Math.PI * 2) / DIRECTIONS;
  const index = ((Math.round(facing / step) % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
  return textureKey(kind, code, index);
}

/** World size of one sprite cell, in feet. Skaters are 1.6 ft radius. */
export const SPRITE_FEET = 5.4;
