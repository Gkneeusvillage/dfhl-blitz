/**
 * The arena, painted a pixel at a time: ice, markings, boards, glass, benches
 * and a crowd.
 *
 * Geometry comes entirely from @dfhl/shared so the rendered rink and the rink
 * the simulation collides against can never drift apart — the ice ends exactly
 * where `signedDistanceToBoards` says it does.
 *
 * AT THE SPRITES' PIXEL DENSITY
 *
 * v0.1 redrew flat vector lines on a Graphics object every frame. The arena is
 * now painted once, at `PX_PER_FOOT` — the density the players are drawn at —
 * and scaled with NEAREST like they are. A pixel of ice and a pixel of sweater
 * are then the same size on screen, which is what makes the scene read as one
 * piece of art rather than sprites pasted on a diagram. It also means the
 * thousands of crowd pixels cost nothing per frame.
 *
 * Pure — no DOM, no Phaser — so it runs, and is tested, in node. `rink.ts`
 * turns it into a texture.
 */

import { RINK, defendingGoalX, signedDistanceToBoards } from '@dfhl/shared';

import { PX_PER_FOOT } from './figures.js';
import { Raster, luma, mix, parseHex, ramp, seededRandom, type Rgb } from './pixels.js';

/** Arena beyond the boards, in feet: room for glass, benches and seats. */
export const ARENA_MARGIN_X = 16;
export const ARENA_MARGIN_Y = 14;
/** How far outside the ice the boards and glass run, in feet. */
const BOARDS_FEET = 2;
const GLASS_FEET = 0.6;

export const ARENA_FEET_WIDE = RINK.length + ARENA_MARGIN_X * 2;
export const ARENA_FEET_TALL = RINK.width + ARENA_MARGIN_Y * 2;

const ICE: Rgb = 0xedf3f9;
const LINE_RED: Rgb = 0xc8102e;
const LINE_BLUE: Rgb = 0x0b5fa5;
const BOARDS: Rgb = 0xf2f3ee;
const KICKPLATE: Rgb = 0xe9c53b;
const RAIL: Rgb = 0x8993a4;
const GLASS: Rgb = 0xbfe3f2;
const ARENA_FLOOR: Rgb = 0x171b24;
const SEAT: Rgb = 0x262c3a;
const LOGO_INK: Rgb = 0x1b2a4a;

/** What the arena needs to know about the two teams on the ice. */
export interface ArenaTeams {
  home: { color: string; trim: string; name: string };
  away: { color: string; trim: string; name: string };
}

// ---------------------------------------------------------------------------
// A 3x5 pixel font for the boards and centre ice
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111',
  '2': '110001010100111', '3': '110001010001110', '4': '101101111001001', '5': '111100110001110',
  '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  '-': '000000111000000', '.': '000000000000010', "'": '010010000000000', '&': '010101010101011',
  ' ': '000000000000000',
};

export function textWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : (text.length * 4 - 1) * scale;
}

/** Stamp text in the pixel font. Unknown characters draw as spaces. */
export function drawText(
  raster: Raster,
  text: string,
  x: number,
  y: number,
  c: Rgb,
  scale = 1,
  alpha = 1,
): void {
  let cursor = Math.round(x);
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row * 3 + col] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            raster.blend(cursor + col * scale + sx, Math.round(y) + row * scale + sy, c, alpha);
          }
        }
      }
    }
    cursor += 4 * scale;
  }
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Pixel column/row for a world coordinate in feet. */
const PX = (x: number): number => (x + RINK.halfLength + ARENA_MARGIN_X) * PX_PER_FOOT;
const PY = (y: number): number => (y + RINK.halfWidth + ARENA_MARGIN_Y) * PX_PER_FOOT;
/** World feet at the centre of a pixel. */
const WX = (px: number): number => (px + 0.5) / PX_PER_FOOT - RINK.halfLength - ARENA_MARGIN_X;
const WY = (py: number): number => (py + 0.5) / PX_PER_FOOT - RINK.halfWidth - ARENA_MARGIN_Y;

export function paintArena(teams: ArenaTeams): Raster {
  const width = Math.round(ARENA_FEET_WIDE * PX_PER_FOOT);
  const height = Math.round(ARENA_FEET_TALL * PX_PER_FOOT);
  const r = new Raster(width, height);
  const rand = seededRandom(0xdf41);

  const home = parseHex(teams.home.color);
  const away = parseHex(teams.away.color);

  // Distance outside the ice for every pixel, computed once and reused by
  // every layer so the boards, glass and seats are concentric by construction.
  const sd = new Float32Array(width * height);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) sd[py * width + px] = signedDistanceToBoards(WX(px), WY(py));
  }
  const onIce = (px: number, py: number): boolean =>
    px >= 0 && py >= 0 && px < width && py < height && sd[py * width + px] < 0;

  paintCrowd(r, sd, rand, home, away, parseHex(teams.home.trim), parseHex(teams.away.trim));
  paintBenches(r, home, away);
  paintIce(r, sd, rand);
  paintMarkings(r, onIce, home, away);
  paintBoards(r, sd, teams);
  return r;
}

function paintCrowd(
  r: Raster,
  sd: Float32Array,
  rand: () => number,
  home: Rgb,
  away: Rgb,
  homeTrim: Rgb,
  awayTrim: Rgb,
): void {
  const skins = [0xf1c7a0, 0xe0a878, 0xc68652, 0x8d5a3b, 0x5c3a28];
  const shirts = [home, home, home, away, away, away, homeTrim, awayTrim, 0xf2f2f2, 0x3a4152, 0x7a8294];
  const start = BOARDS_FEET + GLASS_FEET + 0.8;

  for (let py = 0; py < r.height; py++) {
    for (let px = 0; px < r.width; px++) {
      const d = sd[py * r.width + px];
      if (d < start) continue;
      r.set(px, py, ARENA_FLOOR);
    }
  }

  // Fans on a 4x5 grid: a 2x2 head over a 4x3 shirt, with a seat row between.
  for (let gy = 0; gy < r.height; gy += 5) {
    for (let gx = 0; gx < r.width; gx += 4) {
      const d = sd[Math.min(r.height - 1, gy + 2) * r.width + Math.min(r.width - 1, gx + 2)];
      if (d < start + 0.6) continue;
      // Aisles: a stair every so often, which breaks the wallpaper look.
      const aisle = Math.floor((gx + gy * 0.0) / 4) % 23 === 0;
      if (aisle) {
        r.rect(gx, gy, 4, 5, 0x3a4152);
        continue;
      }
      r.rect(gx, gy + 4, 4, 1, SEAT);
      if (rand() < 0.1) {
        r.rect(gx, gy, 4, 4, SEAT);
        continue;
      }
      // Pulled toward the dark of the stands, so the crowd frames the ice
      // rather than competing with it.
      const shirt = mix(shirts[Math.floor(rand() * shirts.length)], ARENA_FLOOR, 0.42);
      const skin = mix(skins[Math.floor(rand() * skins.length)], ARENA_FLOOR, 0.35);
      r.rect(gx, gy + 2, 4, 2, shirt);
      r.rect(gx + 1, gy, 2, 2, skin);
      // The odd raised arm, so the stands are not a still photograph.
      if (rand() < 0.08) r.set(gx + (rand() < 0.5 ? 0 : 3), gy, skin);
    }
  }
}

function paintBenches(r: Raster, home: Rgb, away: Rgb): void {
  const top = -RINK.halfWidth - BOARDS_FEET - GLASS_FEET;
  const bottom = RINK.halfWidth + BOARDS_FEET + GLASS_FEET;
  const depth = 5.5;

  // Player benches on the far side, one each; penalty boxes on the near side.
  const benches: Array<{ x0: number; x1: number; y0: number; color: Rgb }> = [
    { x0: -58, x1: -16, y0: top - depth, color: defendingGoalX('home') < 0 ? home : away },
    { x0: 16, x1: 58, y0: top - depth, color: defendingGoalX('home') < 0 ? away : home },
  ];
  for (const b of benches) {
    r.rect(PX(b.x0), PY(b.y0), (b.x1 - b.x0) * PX_PER_FOOT, depth * PX_PER_FOOT, 0x2b3242);
    r.rect(PX(b.x0), PY(b.y0) + 3, (b.x1 - b.x0) * PX_PER_FOOT, 6, 0x4a5163);
    // The rest of the roster, sat on the bench in their sweaters.
    for (let x = b.x0 + 2; x < b.x1 - 2; x += 2.6) {
      const sx = Math.round(PX(x));
      const sy = PY(b.y0) + 4;
      r.rect(sx, sy + 3, 5, 5, b.color);
      r.rect(sx + 1, sy, 3, 3, mix(b.color, 0x151922, 0.35));
    }
    r.rect(PX(b.x0), PY(b.y0), (b.x1 - b.x0) * PX_PER_FOOT, 1, 0x0e1119);
  }

  for (const [x0, x1] of [
    [-14, -4],
    [4, 14],
  ]) {
    r.rect(PX(x0), PY(bottom), (x1 - x0) * PX_PER_FOOT, 4 * PX_PER_FOOT, 0x2b3242);
    r.rect(PX(x0), PY(bottom) + 4 * PX_PER_FOOT - 1, (x1 - x0) * PX_PER_FOOT, 1, 0x0e1119);
  }
  // Timekeeper between the boxes.
  r.rect(PX(-3), PY(bottom), 6 * PX_PER_FOOT, 3 * PX_PER_FOOT, 0x4a5163);
}

function paintIce(r: Raster, sd: Float32Array, rand: () => number): void {
  for (let py = 0; py < r.height; py++) {
    for (let px = 0; px < r.width; px++) {
      const d = sd[py * r.width + px];
      if (d >= 0) continue;
      // A faint sheen: brightest mid-ice, a touch greyer toward the boards
      // where the snow collects — plus per-pixel grain.
      const edge = Math.max(0, 1 + d / 10);
      const grain = (rand() - 0.5) * 0.035;
      r.set(px, py, mix(ICE, grain > 0 ? 0xffffff : 0x9fb3c8, Math.abs(grain) + edge * 0.06));
    }
  }

  // Skate scuffs: short strokes, thickest where the play lives — around the
  // faceoff circles and in front of the nets.
  const hotspots = [
    { x: 0, y: 0 },
    { x: -RINK.faceoffDotX, y: -RINK.faceoffDotY },
    { x: -RINK.faceoffDotX, y: RINK.faceoffDotY },
    { x: RINK.faceoffDotX, y: -RINK.faceoffDotY },
    { x: RINK.faceoffDotX, y: RINK.faceoffDotY },
    { x: -RINK.goalLineX + 10, y: 0 },
    { x: RINK.goalLineX - 10, y: 0 },
  ];
  for (let i = 0; i < 900; i++) {
    const spot = i < 300 ? null : hotspots[i % hotspots.length];
    const x = spot === null ? (rand() - 0.5) * RINK.length : spot.x + (rand() - 0.5) * 30;
    const y = spot === null ? (rand() - 0.5) * RINK.width : spot.y + (rand() - 0.5) * 24;
    if (signedDistanceToBoards(x, y) > -1) continue;
    const angle = rand() * Math.PI;
    const length = 2 + rand() * 7;
    const x0 = PX(x);
    const y0 = PY(y);
    const color = rand() < 0.6 ? 0xc9d6e4 : 0xffffff;
    r.line(x0, y0, x0 + Math.cos(angle) * length, y0 + Math.sin(angle) * length * 0.5, color, 90);
  }
}

function paintMarkings(
  r: Raster,
  onIce: (px: number, py: number) => boolean,
  home: Rgb,
  away: Rgb,
): void {
  // Every marking is painted UNDER the ice in reality, so it is blended at a
  // little under full strength and never leaves the rink.
  const paint = (px: number, py: number, c: Rgb, alpha = 0.9): void => {
    if (onIce(px, py)) r.blend(px, py, c, alpha);
  };
  const vLine = (x: number, widthFeet: number, c: Rgb): void => {
    const x0 = Math.round(PX(x - widthFeet / 2));
    const x1 = Math.max(x0 + 2, Math.round(PX(x + widthFeet / 2)));
    for (let py = 0; py < r.height; py++) for (let px = x0; px < x1; px++) paint(px, py, c);
  };
  const disc = (x: number, y: number, radiusFeet: number, c: Rgb, alpha = 0.9): void => {
    const cx = PX(x);
    const cy = PY(y);
    const rad = radiusFeet * PX_PER_FOOT;
    for (let py = Math.floor(cy - rad); py <= Math.ceil(cy + rad); py++) {
      for (let px = Math.floor(cx - rad); px <= Math.ceil(cx + rad); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= rad * rad) paint(px, py, c, alpha);
      }
    }
  };
  const ring = (x: number, y: number, radiusFeet: number, thickness: number, c: Rgb, alpha = 0.9): void => {
    const cx = PX(x);
    const cy = PY(y);
    const outer = radiusFeet * PX_PER_FOOT;
    const inner = outer - thickness;
    for (let py = Math.floor(cy - outer); py <= Math.ceil(cy + outer); py++) {
      for (let px = Math.floor(cx - outer); px <= Math.ceil(cx + outer); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= outer * outer && d2 > inner * inner) paint(px, py, c, alpha);
      }
    }
  };
  const segment = (x0: number, y0: number, x1: number, y1: number, c: Rgb, thickness = 2): void => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * PX_PER_FOOT);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = Math.floor(PX(x0 + (x1 - x0) * t));
      const py = Math.floor(PY(y0 + (y1 - y0) * t));
      for (let o = 0; o < thickness; o++) {
        if (x0 === x1) paint(px + o, py, c);
        else paint(px, py + o, c);
      }
    }
  };

  // Centre ice: the league mark, faint, under everything.
  disc(0, 0, 11, LOGO_INK, 0.06);
  ring(0, 0, 11, 2, LOGO_INK, 0.3);
  const logo = 'DFHL';
  const scale = 4;
  drawText(r, logo, PX(0) - textWidth(logo, scale) / 2, PY(0) - (5 * scale) / 2 - 6, LOGO_INK, scale, 0.28);
  const tag = 'BLITZ';
  drawText(r, tag, PX(0) - textWidth(tag, 2) / 2, PY(0) + 8, LOGO_INK, 2, 0.28);

  vLine(0, 1, LINE_RED);
  // The centre line's white dashes, which is what separates it from a blue line
  // at a glance on a black-and-white screen.
  for (let py = 0; py < r.height; py += 8) {
    for (let px = Math.round(PX(-0.15)); px < Math.round(PX(0.15)) + 1; px++) {
      for (let k = 0; k < 3; k++) paint(px, py + k, 0xffffff, 0.8);
    }
  }
  for (const x of [-RINK.blueLineX, RINK.blueLineX]) vLine(x, 1, LINE_BLUE);
  for (const x of [-RINK.goalLineX, RINK.goalLineX]) vLine(x, 0.34, LINE_RED);

  ring(0, 0, RINK.centerCircleRadius, 2, LINE_BLUE);
  disc(0, 0, 0.6, LINE_BLUE);

  // End-zone circles with their hash marks, and the neutral-zone dots.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx * RINK.faceoffDotX;
      const cy = sy * RINK.faceoffDotY;
      ring(cx, cy, RINK.centerCircleRadius, 2, LINE_RED);
      disc(cx, cy, 1, LINE_RED);
      for (const hx of [-2.9, 2.9]) {
        segment(cx + hx, cy - RINK.centerCircleRadius, cx + hx, cy - RINK.centerCircleRadius - 2, LINE_RED);
        segment(cx + hx, cy + RINK.centerCircleRadius, cx + hx, cy + RINK.centerCircleRadius + 2, LINE_RED);
      }
      disc(sx * (RINK.blueLineX - 5), cy, 1, LINE_RED);
    }
  }

  // Creases in the defending side's colour, and the trapezoids behind the nets.
  const homeGoalX = defendingGoalX('home');
  for (const sign of [-1, 1]) {
    const goalX = sign * RINK.goalLineX;
    const defender = Math.sign(goalX) === Math.sign(homeGoalX) ? home : away;
    const fill = mix(defender, ICE, 0.55);
    const cx = PX(goalX);
    const cy = PY(0);
    const rad = 6 * PX_PER_FOOT;
    for (let py = Math.floor(cy - rad); py <= Math.ceil(cy + rad); py++) {
      for (let px = Math.floor(cx - rad); px <= Math.ceil(cx + rad); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        // Only the half of the circle in front of the goal line.
        if (Math.sign(dx) === sign || dx * dx + dy * dy > rad * rad) continue;
        const edge = dx * dx + dy * dy > (rad - 2) * (rad - 2);
        paint(px, py, edge ? LINE_RED : fill, edge ? 0.9 : 0.75);
      }
    }
    segment(goalX, -11, sign * RINK.halfLength, -14, LINE_RED, 1);
    segment(goalX, 11, sign * RINK.halfLength, 14, LINE_RED, 1);
  }

  // Referee's crease at the timekeeper's bench.
  ring(0, RINK.halfWidth, 10, 1, LINE_RED);
}

function paintBoards(r: Raster, sd: Float32Array, teams: ArenaTeams): void {
  for (let py = 0; py < r.height; py++) {
    for (let px = 0; px < r.width; px++) {
      const d = sd[py * r.width + px];
      if (d < 0 || d >= BOARDS_FEET + GLASS_FEET) continue;
      if (d < 0.34) r.set(px, py, KICKPLATE);
      else if (d < BOARDS_FEET - 0.3) r.set(px, py, BOARDS);
      else if (d < BOARDS_FEET) r.set(px, py, RAIL);
      else r.blend(px, py, GLASS, 0.75);
    }
  }

  // Ads along the long boards, clear of the corners.
  const home = parseHex(teams.home.color);
  const away = parseHex(teams.away.color);
  const ads: Array<{ text: string; bg: Rgb }> = [
    { text: 'DFHL', bg: 0x1b2a4a },
    { text: teams.home.name, bg: home },
    { text: 'BLITZ', bg: 0xc8102e },
    { text: teams.away.name, bg: away },
    { text: 'GO LEAGUE', bg: 0x0e1119 },
  ];
  const bandTop = BOARDS_FEET - 0.3;
  for (const side of [-1, 1]) {
    const yFeet = side * (RINK.halfWidth + (0.34 + bandTop) / 2);
    const centreY = Math.round(PY(yFeet));
    let x = PX(-RINK.halfLength + RINK.cornerRadius + 2);
    const end = PX(RINK.halfLength - RINK.cornerRadius - 2);
    let i = side < 0 ? 0 : 2;
    while (x < end) {
      const ad = ads[i % ads.length];
      const w = textWidth(ad.text) + 8;
      if (x + w > end) break;
      r.rect(x, centreY - 4, w, 8, ad.bg);
      const ink = luma(ad.bg) > 0.6 ? 0x0e1119 : 0xffffff;
      drawText(r, ad.text, x + 4, centreY - 2, ink);
      x += w + 10;
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// Goal lamps
// ---------------------------------------------------------------------------

export const LAMP_WIDTH = 10;
export const LAMP_HEIGHT = 12;

/** The red light behind the net. Two frames: off, and lit with a halo. */
export function drawLamp(lit: boolean): Raster {
  const r = new Raster(LAMP_WIDTH, LAMP_HEIGHT);
  if (lit) r.under(5, 5, 5, 5, 0xff3b30, 0.35);
  r.rect(2, 8, 6, 3, 0x4a5163);
  r.blob(5, 6, 3, 3.5, ramp(lit ? 0xff3b30 : 0x6b1b1b));
  if (lit) r.set(4, 4, 0xffe1dc);
  r.outline(0x0e1119);
  return r;
}

