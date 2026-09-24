import { describe, expect, it } from 'vitest';

import { HOLD_MS, PoseTracker, STRIDE_FEET } from './poses.js';

const FRAME = 1000 / 60;

describe('skater poses', () => {
  it('glides while standing and strides once moving, legs paced by distance', () => {
    const poses = new PoseTracker();
    expect(poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME)).toBe('glide');

    // 30 ft/s: well over the stride threshold.
    const seen = new Set<string>();
    let x = 0;
    for (let i = 0; i < 60; i++) {
      x += 30 / 60;
      seen.add(poses.skater('a', { x, y: 0, windup: 0, stunned: false }, FRAME));
    }
    expect(seen).toEqual(new Set(['stride0', 'stride1', 'stride2', 'stride3']));
    expect(30 / STRIDE_FEET).toBeGreaterThan(4);
  });

  it('does not count a faceoff teleport as skating', () => {
    const poses = new PoseTracker();
    poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME);
    expect(poses.skater('a', { x: 60, y: 0, windup: 0, stunned: false }, FRAME)).toBe('glide');
  });

  it('shows the windup, then the follow-through on release', () => {
    const poses = new PoseTracker();
    poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME);
    expect(poses.skater('a', { x: 0, y: 0, windup: 10, stunned: false }, FRAME)).toBe('windup');
    expect(poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME)).toBe('shoot');
    // And it lets go again.
    let pose = '';
    for (let t = 0; t < HOLD_MS.shot + 50; t += FRAME) {
      pose = poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME);
    }
    expect(pose).toBe('glide');
  });

  it('follows through on a shot event it never saw wound up', () => {
    const poses = new PoseTracker();
    poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME);
    poses.observe([{ type: 'shot', tick: 1, actorId: 'a' }]);
    expect(poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME)).toBe('shoot');
  });

  it('lunges on a check and lies down while stunned', () => {
    const poses = new PoseTracker();
    poses.observe([{ type: 'hit', tick: 1, actorId: 'a', targetId: 'b' }]);
    expect(poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME)).not.toBe('down');
    expect(poses.skater('a', { x: 0, y: 0, windup: 0, stunned: false }, FRAME)).toBe('check');
    expect(poses.skater('b', { x: 0, y: 0, windup: 0, stunned: true }, FRAME)).toBe('down');
  });
});

describe('goalie poses', () => {
  it('stands set, shuffles when moving, and drops on a lunge', () => {
    const poses = new PoseTracker();
    expect(poses.goalie('g', { x: 80, y: 0, lunge: 0 }, FRAME)).toBe('stance');
    let y = 0;
    let pose = '';
    for (let i = 0; i < 20; i++) {
      y += 0.1;
      pose = poses.goalie('g', { x: 80, y, lunge: 0 }, FRAME);
    }
    expect(pose).toMatch(/^shuffle/);
    expect(poses.goalie('g', { x: 80, y, lunge: 5 }, FRAME)).toBe('butterfly');
  });

  it('gloves a save above him and pads one below', () => {
    const poses = new PoseTracker();
    poses.goalie('g', { x: 80, y: 0, lunge: 0 }, FRAME);
    poses.observe([{ type: 'save', tick: 1, actorId: 'g', x: 80, y: -2 }]);
    expect(poses.goalie('g', { x: 80, y: 0, lunge: 0 }, FRAME)).toBe('glove');
    poses.observe([{ type: 'save', tick: 2, actorId: 'g', x: 80, y: 2 }]);
    expect(poses.goalie('g', { x: 80, y: 0, lunge: 0 }, FRAME)).toBe('butterfly');
  });
});
