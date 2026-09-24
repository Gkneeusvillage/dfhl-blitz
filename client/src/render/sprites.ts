/**
 * Turning the generated art into Phaser textures.
 *
 * WHY GENERATED RATHER THAN DRAWN BY HAND
 *
 * Jersey colours come from `teams.config.json`, which the league owner is
 * expected to edit. Hand-authored sprites would mean fourteen sets of art that
 * go stale the moment somebody changes a colour, or a single grey sprite tinted
 * whole — and Phaser's tint multiplies the ENTIRE texture, so a tinted skater
 * gets a red helmet, red skates and a red stick along with the sweater. Drawing
 * per team at match start keeps every pixel under our control.
 *
 * The drawing itself lives in `figures.ts` (pure, testable in node); this module
 * only packs the frames into one sheet per team and names them.
 *
 * ONE SHEET PER TEAM
 *
 * v0.1 made 33 separate little canvases. With animation that would be over two
 * hundred, so each team's skater and goalie frames go into a single canvas and
 * are addressed as named frames: `s:<pose>:<direction>` and `g:<pose>:<direction>`.
 *
 * WHY NEAREST FILTERING
 *
 * The canvas resizes to the window, so the foot-to-pixel scale is not an integer
 * and the sprites are never displayed at exactly their authored size. NEAREST
 * keeps the enlargement blocky instead of blurry, which is the difference
 * between "low resolution on purpose" and "low resolution by accident".
 */

import Phaser from 'phaser';
import { RINK } from '@dfhl/shared';

import {
  CELL,
  DIRECTIONS,
  FEET_X,
  FEET_Y,
  GOALIE_POSES,
  NET_ANCHOR_X,
  NET_ANCHOR_Y,
  NET_HEIGHT,
  NET_WIDTH,
  PUCK_CELL,
  PX_PER_FOOT,
  SKATER_POSES,
  directionIndex,
  drawGoalie,
  drawNet,
  drawPuck,
  drawSkater,
  kitFor,
  type GoaliePose,
  type JerseyColors,
  type SkaterPose,
} from './figures.js';
import type { Raster } from './pixels.js';

export { DIRECTIONS, GOALIE_POSES, SKATER_POSES };
export type { GoaliePose, JerseyColors, SkaterPose };

/** World size of one player cell, in feet. */
export const SPRITE_FEET = CELL / PX_PER_FOOT;
/** Image origin that puts the player's feet on their simulated position. */
export const SPRITE_ORIGIN_X = FEET_X / CELL;
export const SPRITE_ORIGIN_Y = FEET_Y / CELL;

export const PUCK_TEXTURE = 'dfhl:puck';
export const PUCK_FEET = PUCK_CELL / PX_PER_FOOT;

export const NET_FEET_WIDE = NET_WIDTH / PX_PER_FOOT;
export const NET_FEET_TALL = NET_HEIGHT / PX_PER_FOOT;
export const NET_ORIGIN_X = NET_ANCHOR_X / NET_WIDTH;
export const NET_ORIGIN_Y = NET_ANCHOR_Y / NET_HEIGHT;

export function kitTexture(code: string): string {
  return `dfhl:kit:${code}`;
}

export function netTexture(code: string): string {
  return `dfhl:net:${code}`;
}

export function skaterFrame(pose: SkaterPose, facing: number): string {
  return `s:${pose}:${directionIndex(facing)}`;
}

export function goalieFrame(pose: GoaliePose, facing: number): string {
  return `g:${pose}:${directionIndex(facing)}`;
}

export function puckFrame(index: number): string {
  return `p:${index % 2}`;
}

function put(ctx: CanvasRenderingContext2D, raster: Raster, x: number, y: number): void {
  // Copy into a fresh buffer: ImageData wants its own ArrayBuffer.
  ctx.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), x, y);
}

function bakeSheet(
  scene: Phaser.Scene,
  key: string,
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D, add: (name: string, x: number, y: number, w: number, h: number) => void) => void,
): void {
  if (scene.textures.exists(key)) return;
  const texture = scene.textures.createCanvas(key, width, height);
  if (texture === null) return;
  paint(texture.getContext(), (name, x, y, w, h) => {
    texture.add(name, 0, x, y, w, h);
  });
  texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
  texture.refresh();
}

/**
 * Generate every texture a match needs, once.
 *
 * Called with the two teams actually playing: a skater sheet of 9 poses x 8
 * headings and a goalie sheet of 5 x 8 per team, a net in each team's colour,
 * and the puck. Nothing to download.
 */
export function bakeMatchSprites(
  scene: Phaser.Scene,
  teams: Array<{ code: string; colors: JerseyColors }>,
): void {
  for (const team of teams) {
    const kit = kitFor(team.colors);
    const columns = Math.max(SKATER_POSES.length, GOALIE_POSES.length);
    bakeSheet(scene, kitTexture(team.code), columns * CELL, DIRECTIONS * 2 * CELL, (ctx, add) => {
      for (let d = 0; d < DIRECTIONS; d++) {
        SKATER_POSES.forEach((pose, column) => {
          const x = column * CELL;
          const y = d * CELL;
          put(ctx, drawSkater(kit, pose, d), x, y);
          add(`s:${pose}:${d}`, x, y, CELL, CELL);
        });
        GOALIE_POSES.forEach((pose, column) => {
          const x = column * CELL;
          const y = (DIRECTIONS + d) * CELL;
          put(ctx, drawGoalie(kit, pose, d), x, y);
          add(`g:${pose}:${d}`, x, y, CELL, CELL);
        });
      }
    });

    bakeSheet(scene, netTexture(team.code), NET_WIDTH, NET_HEIGHT, (ctx, add) => {
      put(ctx, drawNet(team.colors.primary, RINK.goalHalfWidth, RINK.goalDepth), 0, 0);
      add('net', 0, 0, NET_WIDTH, NET_HEIGHT);
    });
  }

  bakeSheet(scene, PUCK_TEXTURE, PUCK_CELL * 2, PUCK_CELL, (ctx, add) => {
    for (let i = 0; i < 2; i++) {
      put(ctx, drawPuck(i), i * PUCK_CELL, 0);
      add(`p:${i}`, i * PUCK_CELL, 0, PUCK_CELL, PUCK_CELL);
    }
  });
}
