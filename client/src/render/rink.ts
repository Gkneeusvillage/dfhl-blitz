/**
 * The rink on screen: the world-to-pixel transform, and baking the painted
 * arena (`arena.ts`) into a texture.
 */

import Phaser from 'phaser';

import {
  LAMP_HEIGHT,
  LAMP_WIDTH,
  drawLamp,
  paintArena,
  type ArenaTeams,
} from './arena.js';

export interface RinkTransform {
  /** Screen x for a world x, in feet. */
  toScreenX(worldX: number): number;
  /** Screen y for a world y, in feet. */
  toScreenY(worldY: number): number;
  pixelsPerFoot: number;
}

export function createRinkTransform(
  centerScreenX: number,
  centerScreenY: number,
  pixelsPerFoot: number,
): RinkTransform {
  return {
    pixelsPerFoot,
    toScreenX: (worldX) => centerScreenX + worldX * pixelsPerFoot,
    toScreenY: (worldY) => centerScreenY + worldY * pixelsPerFoot,
  };
}

// ---------------------------------------------------------------------------
// Phaser
// ---------------------------------------------------------------------------

export const ARENA_TEXTURE = 'dfhl:arena';
export const LAMP_TEXTURE = 'dfhl:lamp';

/**
 * Bake the arena and the lamp. Re-baked when the teams change (a new match);
 * the texture is keyed per pairing so a rematch reuses it.
 */
export function bakeArena(scene: Phaser.Scene, teams: ArenaTeams): string {
  const key = `${ARENA_TEXTURE}:${teams.home.name}:${teams.away.name}`;
  if (!scene.textures.exists(key)) {
    const raster = paintArena(teams);
    const texture = scene.textures.createCanvas(key, raster.width, raster.height);
    if (texture !== null) {
      texture.getContext().putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
      texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      texture.refresh();
    }
  }
  if (!scene.textures.exists(LAMP_TEXTURE)) {
    const texture = scene.textures.createCanvas(LAMP_TEXTURE, LAMP_WIDTH * 2, LAMP_HEIGHT);
    if (texture !== null) {
      [false, true].forEach((lit, i) => {
        const lamp = drawLamp(lit);
        texture.getContext().putImageData(new ImageData(new Uint8ClampedArray(lamp.data), LAMP_WIDTH, LAMP_HEIGHT), i * LAMP_WIDTH, 0);
        texture.add(lit ? 'on' : 'off', 0, i * LAMP_WIDTH, 0, LAMP_WIDTH, LAMP_HEIGHT);
      });
      texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      texture.refresh();
    }
  }
  return key;
}
