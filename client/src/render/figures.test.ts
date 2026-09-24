import { SKATER } from '@dfhl/shared';
import { describe, expect, it } from 'vitest';

import {
  CELL,
  DIRECTIONS,
  FEET_X,
  FEET_Y,
  GOALIE_POSES,
  PX_PER_FOOT,
  SKATER_POSES,
  directionAngle,
  directionIndex,
  drawGoalie,
  drawNet,
  drawSkater,
  kitFor,
} from './figures.js';
import type { Raster } from './pixels.js';

const KITS = [
  kitFor({ primary: '#ce1126', secondary: '#ffffff' }),
  kitFor({ primary: '#0b1b3f', secondary: '#8fa7d6' }),
  kitFor({ primary: '#ffb81c', secondary: '#111111' }),
];

/** Opaque pixels on the outermost ring of the cell mean the art was clipped. */
function touchesEdge(r: Raster): boolean {
  for (let i = 0; i < r.width; i++) {
    if (r.alphaAt(i, 0) === 255 || r.alphaAt(i, r.height - 1) === 255) return true;
  }
  for (let i = 0; i < r.height; i++) {
    if (r.alphaAt(0, i) === 255 || r.alphaAt(r.width - 1, i) === 255) return true;
  }
  return false;
}

function opaqueCount(r: Raster): number {
  let n = 0;
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (r.alphaAt(x, y) === 255) n++;
  return n;
}

describe('player art', () => {
  it('fits every skater and goalie frame inside its cell, in every direction', () => {
    for (const kit of KITS) {
      for (let d = 0; d < DIRECTIONS; d++) {
        for (const pose of SKATER_POSES) {
          const frame = drawSkater(kit, pose, d);
          expect(touchesEdge(frame), `skater ${pose} dir ${d}`).toBe(false);
          expect(opaqueCount(frame)).toBeGreaterThan(120);
        }
        for (const pose of GOALIE_POSES) {
          expect(touchesEdge(drawGoalie(kit, pose, d)), `goalie ${pose} dir ${d}`).toBe(false);
        }
      }
    }
  });

  it('puts the stick blade where the simulation puts the puck', () => {
    // The puck rides SKATER.stickReach in front of a carrier. Some pixel of the
    // blade has to be within a foot of that point, or the puck floats in space.
    const kit = KITS[0];
    for (let d = 0; d < DIRECTIONS; d++) {
      const frame = drawSkater(kit, 'glide', d);
      const angle = directionAngle(d);
      const px = FEET_X + Math.cos(angle) * SKATER.stickReach * PX_PER_FOOT;
      const py = FEET_Y + Math.sin(angle) * SKATER.stickReach * PX_PER_FOOT;
      let nearest = Infinity;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          if (frame.alphaAt(x, y) !== 255) continue;
          nearest = Math.min(nearest, Math.hypot(x + 0.5 - px, y + 0.5 - py));
        }
      }
      expect(nearest / PX_PER_FOOT, `direction ${d}`).toBeLessThan(1);
    }
  });

  it('animates: every stride frame is a different picture', () => {
    const kit = KITS[1];
    const frames = ['stride0', 'stride1', 'stride2', 'stride3'].map((pose) =>
      Buffer.from(drawSkater(kit, pose as 'stride0', 0).data).toString('base64'),
    );
    expect(new Set(frames).size).toBe(4);
  });

  it('snaps a heading to the nearest baked direction', () => {
    expect(directionIndex(0)).toBe(0);
    expect(directionIndex(Math.PI / 2)).toBe(2);
    expect(directionIndex(-Math.PI / 2)).toBe(6);
    expect(directionIndex(Math.PI * 2 - 0.1)).toBe(0);
  });

  it('draws the net without clipping it', () => {
    expect(touchesEdge(drawNet('#ce1126', 3, 4))).toBe(false);
  });
});
