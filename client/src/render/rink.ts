/**
 * Draws the ice sheet.
 *
 * Geometry comes entirely from @dfhl/shared so the rendered rink and the rink
 * the simulation collides against can never drift apart.
 *
 * Pair F (Art, Audio & Game Feel) owns replacing these vector primitives with
 * the final retro art pass; the coordinate transform below is the stable part.
 */

import Phaser from 'phaser';
import { RENDER, RINK, defendingGoalX } from '@dfhl/shared';

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
  pixelsPerFoot: number = RENDER.pixelsPerFoot,
): RinkTransform {
  return {
    pixelsPerFoot,
    toScreenX: (worldX) => centerScreenX + worldX * pixelsPerFoot,
    toScreenY: (worldY) => centerScreenY + worldY * pixelsPerFoot,
  };
}

const ICE = 0xeef4fb;
const LINE_RED = 0xc8102e;
const LINE_BLUE = 0x0b5fa5;
const BOARDS = 0x2a3346;
const CREASE = 0x9fd0f5;

/**
 * Whose end is whose.
 *
 * The crease and the goal frame are the two places a team colour belongs on the
 * ice: they say which net you are shooting at without a caption, and they are
 * the only marks a real rink paints differently at each end anyway. `home`
 * defends the left end — `defendingGoalX` in shared is the authority, and it is
 * read rather than assumed so a change there cannot leave the colours swapped.
 */
export interface RinkColors {
  /** 0xRRGGBB for the side defending each net. */
  home: number;
  away: number;
}

export function drawRink(
  graphics: Phaser.GameObjects.Graphics,
  t: RinkTransform,
  colors?: RinkColors,
): void {
  const ppf = t.pixelsPerFoot;
  const left = t.toScreenX(-RINK.halfLength);
  const top = t.toScreenY(-RINK.halfWidth);
  const width = RINK.length * ppf;
  const height = RINK.width * ppf;
  const radius = RINK.cornerRadius * ppf;

  graphics.clear();

  // Ice surface.
  graphics.fillStyle(ICE, 1);
  graphics.fillRoundedRect(left, top, width, height, radius);

  // Center red line.
  graphics.lineStyle(Math.max(2, ppf * 0.9), LINE_RED, 1);
  graphics.beginPath();
  graphics.moveTo(t.toScreenX(0), top);
  graphics.lineTo(t.toScreenX(0), top + height);
  graphics.strokePath();

  // Blue lines.
  graphics.lineStyle(Math.max(2, ppf * 0.9), LINE_BLUE, 1);
  for (const x of [-RINK.blueLineX, RINK.blueLineX]) {
    graphics.beginPath();
    graphics.moveTo(t.toScreenX(x), top);
    graphics.lineTo(t.toScreenX(x), top + height);
    graphics.strokePath();
  }

  // Goal lines.
  graphics.lineStyle(Math.max(1, ppf * 0.35), LINE_RED, 1);
  for (const x of [-RINK.goalLineX, RINK.goalLineX]) {
    graphics.beginPath();
    graphics.moveTo(t.toScreenX(x), top);
    graphics.lineTo(t.toScreenX(x), top + height);
    graphics.strokePath();
  }

  // Center faceoff circle and dot.
  graphics.lineStyle(Math.max(1, ppf * 0.35), LINE_BLUE, 1);
  graphics.strokeCircle(t.toScreenX(0), t.toScreenY(0), RINK.centerCircleRadius * ppf);
  graphics.fillStyle(LINE_BLUE, 1);
  graphics.fillCircle(t.toScreenX(0), t.toScreenY(0), ppf * 0.6);

  // End-zone faceoff dots.
  graphics.fillStyle(LINE_RED, 1);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      graphics.fillCircle(
        t.toScreenX(sx * RINK.faceoffDotX),
        t.toScreenY(sy * RINK.faceoffDotY),
        ppf * 0.6,
      );
      graphics.lineStyle(Math.max(1, ppf * 0.3), LINE_RED, 1);
      graphics.strokeCircle(
        t.toScreenX(sx * RINK.faceoffDotX),
        t.toScreenY(sy * RINK.faceoffDotY),
        RINK.centerCircleRadius * ppf,
      );
    }
  }

  // Creases and nets, tinted with the colours of the side defending each end.
  const homeGoalX = defendingGoalX('home');
  for (const sign of [-1, 1]) {
    const worldGoalX = sign * RINK.goalLineX;
    const defender =
      colors === undefined
        ? null
        : Math.sign(worldGoalX) === Math.sign(homeGoalX)
          ? colors.home
          : colors.away;

    const goalX = t.toScreenX(worldGoalX);
    graphics.fillStyle(defender ?? CREASE, defender === null ? 0.75 : 0.45);
    graphics.slice(
      goalX,
      t.toScreenY(0),
      6 * ppf,
      sign > 0 ? Phaser.Math.DegToRad(90) : Phaser.Math.DegToRad(270),
      sign > 0 ? Phaser.Math.DegToRad(270) : Phaser.Math.DegToRad(90),
      false,
    );
    graphics.fillPath();

    graphics.lineStyle(Math.max(2, ppf * 0.4), defender ?? LINE_RED, 1);
    graphics.strokeRect(
      sign > 0 ? goalX : goalX - RINK.goalDepth * ppf,
      t.toScreenY(-RINK.goalHalfWidth),
      RINK.goalDepth * ppf,
      RINK.goalHalfWidth * 2 * ppf,
    );
  }

  // Boards.
  graphics.lineStyle(Math.max(3, ppf * 0.7), BOARDS, 1);
  graphics.strokeRoundedRect(left, top, width, height, radius);
}
