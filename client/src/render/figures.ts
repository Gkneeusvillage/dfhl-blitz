/**
 * The people on the ice, built from a skeleton and drawn a pixel at a time.
 *
 * THE 3/4 "BROADCAST" VIEW
 *
 * v0.1 drew players from straight overhead: a helmet on a jersey, rotated eight
 * ways. From above a hockey player is a disc, and eight rotated discs is what
 * the sprite lab showed. NHL '94 put the camera up in the stands instead, so a
 * player stands UP on the ice: you see the helmet, the sweater, the pants, the
 * legs and the skates, and which way he is skating reads from the whole body.
 *
 * The projection is oblique and deliberately simple. The ice plane is drawn
 * exactly as the rink is (top-down, no foreshortening), so a stick blade drawn
 * 2.4 ft in front of a skater lands on the puck the simulation put 2.4 ft in
 * front of him. Height is then lifted straight up the screen at `Z_SCALE`.
 *
 * HOW A FRAME IS MADE
 *
 * A pose is a handful of joints in body space — forward, sideways, up, in feet.
 * Each joint is projected for the heading being baked, every body part becomes
 * a shaded limb or blob, the parts are painted back to front by how near the
 * camera they are, and the whole figure gets a one-pixel dark outline and a
 * shadow on the ice. Eight headings and every pose come out of the same code,
 * so they can never disagree about where a player's hands are.
 */

import { Raster, luma, mix, parseHex, ramp, type Band, type Ramp, type Rgb } from './pixels.js';

/** Authoring pixels per world foot. The rink is baked at the same density. */
export const PX_PER_FOOT = 6;
/** Height is lifted up the screen at this fraction of a ground foot. */
export const Z_SCALE = 0.8;

/** Square cell every player frame is drawn in. */
export const CELL = 56;
/** Where the player's feet — the simulation's position — sit in the cell. */
export const FEET_X = 28;
export const FEET_Y = 36;

export const DIRECTIONS = 8;

export const SKATER_POSES = [
  'glide',
  'stride0',
  'stride1',
  'stride2',
  'stride3',
  'windup',
  'shoot',
  'check',
  'down',
] as const;
export type SkaterPose = (typeof SKATER_POSES)[number];

export const GOALIE_POSES = ['stance', 'shuffle0', 'shuffle1', 'butterfly', 'glove'] as const;
export type GoaliePose = (typeof GOALIE_POSES)[number];

const OUTLINE: Rgb = 0x0e1119;
const SKIN = ramp(0xe0a878);
const BOOT = ramp(0x23272f);
const STEEL: Rgb = 0xcfd8e3;
/** A tan stick: the retro convention, and it reads against both ice and kit. */
const SHAFT = ramp(0xc99a5b);
const BLADE = ramp(0x2b2f38);
const TAPE: Rgb = 0xf2f4f7;
const PAD_WHITE: Rgb = 0xeef1f5;

export interface JerseyColors {
  primary: string;
  secondary: string;
}

/** Every colour one team's kit needs, derived from its two config colours. */
export interface Kit {
  jersey: Ramp;
  trim: Ramp;
  pants: Ramp;
  gloves: Ramp;
  helmet: Ramp;
  socks: Ramp;
  pads: Ramp;
  padTrim: Ramp;
}

export function kitFor(colors: JerseyColors): Kit {
  const primary = parseHex(colors.primary);
  const secondary = parseHex(colors.secondary);
  return {
    jersey: ramp(primary),
    trim: ramp(secondary),
    // Pants are dark in almost every real kit; a dark take on the primary keeps
    // them in the team's family without competing with the sweater.
    pants: ramp(mix(primary, 0x151922, 0.62)),
    gloves: ramp(mix(primary, 0x151922, 0.3)),
    // The primary, a shade darker — or lifted toward slate when the primary is
    // already near black, so the helmet still has a visible shape. A helmet in
    // the trim colour ran into the shoulder caps and made teams look hooded.
    helmet: ramp(luma(primary) < 0.14 ? mix(primary, 0x5a6275, 0.45) : mix(primary, 0x151922, 0.18)),
    socks: ramp(primary),
    pads: ramp(PAD_WHITE),
    padTrim: ramp(primary),
  };
}

// ---------------------------------------------------------------------------
// Body space and projection
// ---------------------------------------------------------------------------

/** A joint: forward along the heading, sideways (to the right hand), up — feet. */
interface Joint {
  f: number;
  s: number;
  z: number;
}

const j = (f: number, s: number, z: number): Joint => ({ f, s, z });

interface Projected {
  x: number;
  y: number;
  /** How near the camera — world y. Larger draws later. */
  depth: number;
}

function projector(angle: number): (p: Joint) => Projected {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return (p) => {
    const wx = p.f * c - p.s * sn;
    const wy = p.f * sn + p.s * c;
    return {
      x: FEET_X + wx * PX_PER_FOOT,
      y: FEET_Y + wy * PX_PER_FOOT - p.z * PX_PER_FOOT * Z_SCALE,
      depth: wy,
    };
  };
}

type Part =
  | { kind: 'limb'; a: Joint; b: Joint; r: number; color: Ramp; bands?: Band[]; bias?: number }
  | { kind: 'blob'; c: Joint; rx: number; ry: number; color: Ramp; bias?: number }
  | { kind: 'line'; a: Joint; b: Joint; color: Rgb; bias?: number }
  | { kind: 'face'; head: Joint; r: number; goalie: boolean; bias?: number };

function paint(raster: Raster, parts: Part[], angle: number): void {
  const project = projector(angle);
  const facingScreenY = Math.sin(angle);

  const ordered = parts
    .map((part) => {
      let depth: number;
      switch (part.kind) {
        case 'limb':
        case 'line':
          depth = (project(part.a).depth + project(part.b).depth) / 2;
          break;
        case 'blob':
          depth = project(part.c).depth;
          break;
        case 'face':
          depth = project(part.head).depth;
          break;
      }
      return { part, depth: depth + (part.bias ?? 0) };
    })
    // Stable for equal depths, so the declared order breaks ties.
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index);

  for (const { part } of ordered) {
    switch (part.kind) {
      case 'limb': {
        const a = project(part.a);
        const b = project(part.b);
        raster.limb(a.x, a.y, b.x, b.y, part.r * PX_PER_FOOT, part.color, part.bands);
        break;
      }
      case 'blob': {
        const c = project(part.c);
        raster.blob(c.x, c.y, part.rx * PX_PER_FOOT, part.ry * PX_PER_FOOT, part.color);
        break;
      }
      case 'line': {
        const a = project(part.a);
        const b = project(part.b);
        raster.line(a.x, a.y, b.x, b.y, part.color);
        break;
      }
      case 'face': {
        // Facing away from the camera there is no face to see, only the back
        // of the helmet — which is exactly how you tell which way he is going.
        if (facingScreenY < -0.4) break;
        const head = project(part.head);
        const r = part.r * PX_PER_FOOT;
        const toward = projector(angle)(j(part.r * 0.55, 0, 0));
        const fx = head.x + (toward.x - FEET_X);
        const fy = head.y + (toward.y - FEET_Y) + r * 0.25;
        const rx = r * 0.62;
        const ry = r * 0.55;
        for (let py = Math.floor(fy - ry); py <= Math.ceil(fy + ry); py++) {
          for (let px = Math.floor(fx - rx); px <= Math.ceil(fx + rx); px++) {
            const nx = (px + 0.5 - fx) / rx;
            const ny = (py + 0.5 - fy) / ry;
            if (nx * nx + ny * ny > 1) continue;
            // Stay inside the helmet, and below its brow.
            const hx = px + 0.5 - head.x;
            const hy = py + 0.5 - head.y;
            if (hx * hx + hy * hy > r * r || hy < -r * 0.15) continue;
            if (part.goalie) {
              // A mask: dark behind a cage of light bars.
              const bar = px % 2 === 0 || py % 3 === 0;
              raster.set(px, py, bar ? 0xc6ccd6 : 0x2a2f3a);
            } else {
              raster.set(px, py, ny < -0.25 ? SKIN.lo : SKIN.mid);
            }
          }
        }
        break;
      }
    }
  }
}

function finish(raster: Raster, shadowRx: number): void {
  raster.outline(OUTLINE);
  raster.under(FEET_X, FEET_Y + 1, shadowRx, shadowRx * 0.38, 0x0a1a33, 0.26);
}

// ---------------------------------------------------------------------------
// Skater
// ---------------------------------------------------------------------------

interface SkaterRig {
  hip: Joint;
  shoulder: Joint;
  head: Joint;
  footL: Joint;
  footR: Joint;
  kneeL: Joint;
  kneeR: Joint;
  handTop: Joint;
  handBottom: Joint;
  heel: Joint;
  toe: Joint;
  /** Lying on the ice: the shoulders are laid out flat rather than across. */
  lying?: boolean;
}

function knee(hip: Joint, foot: Joint, forward = 0.4, height = 1.25): Joint {
  return j((hip.f + foot.f) / 2 + forward, (hip.s + foot.s) / 2 * 0.85, height);
}

function skaterRig(pose: SkaterPose): SkaterRig {
  switch (pose) {
    case 'windup': {
      const hip = j(-0.1, 0, 2.45);
      const footL = j(0.35, -0.6, 0);
      const footR = j(-0.35, 0.6, 0);
      return {
        hip,
        shoulder: j(0.2, 0.05, 4.2),
        head: j(0.35, 0, 5.05),
        footL,
        footR,
        kneeL: knee(hip, footL),
        kneeR: knee(hip, footR),
        handTop: j(-0.1, -0.3, 4.0),
        handBottom: j(0.2, 0.35, 3.5),
        heel: j(-0.95, 1.1, 4.0),
        toe: j(-1.25, 0.95, 4.3),
      };
    }
    case 'shoot': {
      const hip = j(-0.05, 0, 2.45);
      const footL = j(0.55, -0.5, 0);
      const footR = j(-0.45, 0.6, 0);
      return {
        hip,
        shoulder: j(0.7, -0.05, 4.05),
        head: j(0.9, 0, 4.85),
        footL,
        footR,
        kneeL: knee(hip, footL),
        kneeR: knee(hip, footR),
        handTop: j(0.9, -0.25, 3.4),
        handBottom: j(1.35, 0.1, 3.1),
        heel: j(2.0, -0.4, 2.9),
        toe: j(2.3, -0.7, 3.2),
      };
    }
    case 'check': {
      const hip = j(0, 0, 2.35);
      const footL = j(0.65, -0.55, 0);
      const footR = j(-0.85, 0.6, 0);
      return {
        hip,
        shoulder: j(1.0, -0.15, 3.9),
        head: j(1.25, -0.1, 4.6),
        footL,
        footR,
        kneeL: knee(hip, footL, 0.5),
        kneeR: knee(hip, footR, 0.2),
        handTop: j(0.65, -0.45, 3.0),
        handBottom: j(0.85, 0.45, 2.65),
        heel: j(1.6, 0.9, 0.8),
        toe: j(1.95, 0.6, 0.6),
      };
    }
    case 'down': {
      // Flat on his back, feet toward the way he was going.
      const hip = j(0.25, 0.1, 0.5);
      const footL = j(1.8, -0.45, 0.25);
      const footR = j(1.65, 0.65, 0.25);
      return {
        hip,
        shoulder: j(-1.25, 0, 0.55),
        head: j(-1.95, 0.05, 0.5),
        footL,
        footR,
        kneeL: j(1.05, -0.4, 0.75),
        kneeR: j(1.0, 0.5, 0.6),
        handTop: j(-1.0, -1.35, 0.3),
        handBottom: j(-0.7, 1.35, 0.3),
        heel: j(1.5, 1.85, 0.05),
        toe: j(1.85, 1.6, 0.05),
        lying: true,
      };
    }
    default: {
      // Glide, or one of four stride frames around the push-off cycle.
      const stride = pose === 'glide' ? -1 : Number(pose.slice(-1));
      const phase = stride < 0 ? 0 : (stride / 4) * Math.PI * 2 + Math.PI / 4;
      const a = stride < 0 ? 0 : Math.sin(phase);
      // The recovering foot comes forward off the ice; which one, and whether it
      // is on its way up or down, is what tells the four frames apart.
      const b = stride < 0 ? 0 : Math.cos(phase);
      const push = stride < 0 ? 0 : 0.38;
      const hip = j(-0.15, 0, 2.5 - 0.12 * Math.abs(a));
      const footL = j(stride < 0 ? 0.15 : 0.6 * a, -0.45 - push * Math.max(0, -a), 0.3 * Math.max(0, b));
      const footR = j(stride < 0 ? -0.15 : -0.6 * a, 0.45 + push * Math.max(0, a), 0.3 * Math.max(0, -b));
      const sway = 0.12 * a;
      return {
        hip,
        shoulder: j(0.45, 0, 4.15 - 0.1 * Math.abs(a)),
        head: j(0.62, 0, 5.0 - 0.1 * Math.abs(a)),
        footL,
        footR,
        kneeL: knee(hip, footL),
        kneeR: knee(hip, footR),
        handTop: j(0.55, -0.15 + sway, 2.9),
        handBottom: j(1.05, 0.45 + sway, 2.0),
        heel: j(2.05, 0.45 + sway * 0.5, 0.1),
        toe: j(2.55, 0.0 + sway * 0.5, 0.05),
      };
    }
  }
}

function along(a: Joint, b: Joint, t: number): Joint {
  return j(a.f + (b.f - a.f) * t, a.s + (b.s - a.s) * t, a.z + (b.z - a.z) * t);
}

function offset(p: Joint, df: number, ds: number, dz: number): Joint {
  return j(p.f + df, p.s + ds, p.z + dz);
}

function skaterParts(kit: Kit, pose: SkaterPose): Part[] {
  const rig = skaterRig(pose);
  const parts: Part[] = [];

  // Legs: thigh in the pants, shin in the sock, then boot and blade.
  for (const [foot, kneeJ, side] of [
    [rig.footL, rig.kneeL, -1],
    [rig.footR, rig.kneeR, 1],
  ] as const) {
    const hipSide = offset(rig.hip, 0, side * 0.3, -0.2);
    const ankle = offset(foot, 0, 0, 0.35);
    parts.push({ kind: 'limb', a: hipSide, b: kneeJ, r: 0.42, color: kit.pants });
    parts.push({
      kind: 'limb',
      a: kneeJ,
      b: ankle,
      r: 0.3,
      color: kit.socks,
      bands: [{ from: 0.3, to: 0.5, color: kit.trim }],
    });
    parts.push({ kind: 'blob', c: offset(foot, 0.08, 0, 0.22), rx: 0.36, ry: 0.24, color: BOOT, bias: 0.01 });
    if (!rig.lying) {
      parts.push({ kind: 'line', a: offset(foot, -0.3, 0, 0), b: offset(foot, 0.4, 0, 0), color: STEEL, bias: 0.02 });
    }
  }

  // Pants across the hips.
  const hipL = offset(rig.hip, 0, -0.42, 0);
  const hipR = offset(rig.hip, 0, 0.42, 0);
  parts.push({ kind: 'limb', a: hipL, b: hipR, r: 0.56, color: kit.pants, bias: 0.05 });

  // Sweater: body, a hem stripe, and a yoke across the shoulders.
  parts.push({
    kind: 'limb',
    a: offset(rig.hip, 0, 0, 0.25),
    b: rig.shoulder,
    r: 0.82,
    color: kit.jersey,
    bands: [{ from: 0.1, to: 0.28, color: kit.trim }],
    bias: 0.1,
  });
  // Shoulder pads under the sweater make the frame; caps in the trim colour.
  const shoulderL = offset(rig.shoulder, 0, -0.62, -0.1);
  const shoulderR = offset(rig.shoulder, 0, 0.62, -0.1);
  parts.push({ kind: 'limb', a: shoulderL, b: shoulderR, r: 0.5, color: kit.jersey, bias: 0.11 });
  for (const cap of [shoulderL, shoulderR]) {
    parts.push({ kind: 'blob', c: offset(cap, 0, 0, 0.12), rx: 0.34, ry: 0.3, color: kit.trim, bias: 0.12 });
  }

  // Arms to the gloves, sleeve stripe at the elbow.
  for (const [shoulder, hand] of [
    [shoulderL, rig.handTop],
    [shoulderR, rig.handBottom],
  ] as const) {
    parts.push({
      kind: 'limb',
      a: shoulder,
      b: hand,
      r: 0.29,
      color: kit.jersey,
      bands: [{ from: 0.5, to: 0.66, color: kit.trim }],
      bias: 0.13,
    });
    parts.push({ kind: 'blob', c: hand, rx: 0.3, ry: 0.3, color: kit.gloves, bias: 0.14 });
  }

  // Stick: shaft from the top hand through the bottom hand to the heel, then a
  // taped blade — the blade is where the puck sits.
  parts.push({ kind: 'limb', a: rig.handTop, b: rig.heel, r: 0.12, color: SHAFT, bias: 0.135 });
  parts.push({ kind: 'limb', a: rig.heel, b: rig.toe, r: 0.14, color: BLADE, bias: 0.136 });
  parts.push({ kind: 'line', a: along(rig.heel, rig.toe, 0.25), b: along(rig.heel, rig.toe, 0.8), color: TAPE, bias: 0.137 });

  // Helmet and face, always over the shoulders.
  parts.push({ kind: 'blob', c: rig.head, rx: 0.62, ry: 0.62, color: kit.helmet, bias: 0.6 });
  if (!rig.lying) parts.push({ kind: 'face', head: rig.head, r: 0.62, goalie: false, bias: 0.61 });

  return parts;
}

// ---------------------------------------------------------------------------
// Goalie
// ---------------------------------------------------------------------------

function goalieParts(kit: Kit, pose: GoaliePose): Part[] {
  const parts: Part[] = [];
  const butterfly = pose === 'butterfly';
  const shift = pose === 'shuffle0' ? 0.25 : pose === 'shuffle1' ? -0.25 : 0;

  const hip = butterfly ? j(0.3, 0, 1.25) : j(0.1, shift * 0.5, 2.15);
  const shoulder = butterfly ? j(0.55, 0, 2.85) : j(0.45, shift * 0.5, 3.7);
  const head = butterfly ? j(0.7, 0, 3.55) : j(0.6, shift * 0.5, 4.45);

  // Pads: the widest thing on the ice, and the reason a goalie reads as a wall.
  const padBands: Band[] = [
    { from: 0.28, to: 0.4, color: kit.padTrim },
    { from: 0.62, to: 0.72, color: kit.padTrim },
  ];
  for (const side of [-1, 1]) {
    if (butterfly) {
      parts.push({
        kind: 'limb',
        a: j(0.5, side * 0.35, 0.45),
        b: j(0.05, side * 1.75, 0.3),
        r: 0.42,
        color: kit.pads,
        bands: padBands,
      });
    } else {
      parts.push({
        kind: 'limb',
        a: j(0.25, side * 0.88 + shift, 0.3),
        b: j(0.45, side * 0.5 + shift * 0.5, 1.95),
        r: 0.43,
        color: kit.pads,
        bands: padBands,
      });
      parts.push({ kind: 'blob', c: j(0.3, side * 0.9 + shift, 0.15), rx: 0.38, ry: 0.22, color: BOOT, bias: 0.01 });
    }
  }

  parts.push({ kind: 'limb', a: offset(hip, 0, -0.5, 0), b: offset(hip, 0, 0.5, 0), r: 0.58, color: kit.pants, bias: 0.05 });
  parts.push({
    kind: 'limb',
    a: offset(hip, 0, 0, 0.2),
    b: shoulder,
    r: 0.95,
    color: kit.jersey,
    bands: [{ from: 0.1, to: 0.28, color: kit.trim }],
    bias: 0.1,
  });
  const shoulderL = offset(shoulder, 0, -0.8, 0);
  const shoulderR = offset(shoulder, 0, 0.8, 0);
  parts.push({ kind: 'limb', a: shoulderL, b: shoulderR, r: 0.46, color: kit.trim, bias: 0.12 });

  const gloveHand =
    pose === 'glove'
      ? j(0.65, -1.4, 4.6)
      : butterfly
        ? j(0.9, -1.25, 2.2)
        : j(0.85, -1.15 + shift * 0.5, 2.8);
  const blockerHand = butterfly ? j(0.9, 1.2, 1.9) : j(0.9, 1.1 + shift * 0.5, 2.4);
  parts.push({ kind: 'limb', a: shoulderL, b: gloveHand, r: 0.3, color: kit.jersey, bias: 0.13 });
  parts.push({ kind: 'limb', a: shoulderR, b: blockerHand, r: 0.3, color: kit.jersey, bias: 0.13 });

  const gear = kit.pads;
  parts.push({ kind: 'blob', c: gloveHand, rx: 0.5, ry: 0.46, color: gear, bias: 0.15 });
  parts.push({ kind: 'blob', c: blockerHand, rx: 0.36, ry: 0.5, color: gear, bias: 0.15 });

  // Stick: shaft down from the blocker to a wide paddle, blade flat on the ice.
  const paddleTop = butterfly ? j(1.35, 0.45, 0.7) : j(1.4, 0.6 + shift * 0.5, 0.75);
  const heel = butterfly ? j(1.45, 0.4, 0.08) : j(1.5, 0.55 + shift * 0.5, 0.08);
  const toe = butterfly ? j(1.5, -0.45, 0.05) : j(1.55, -0.3 + shift * 0.5, 0.05);
  parts.push({ kind: 'limb', a: blockerHand, b: paddleTop, r: 0.11, color: SHAFT, bias: 0.14 });
  parts.push({ kind: 'limb', a: paddleTop, b: heel, r: 0.2, color: BLADE, bias: 0.14 });
  parts.push({ kind: 'limb', a: heel, b: toe, r: 0.13, color: BLADE, bias: 0.141 });
  parts.push({ kind: 'line', a: along(heel, toe, 0.2), b: along(heel, toe, 0.85), color: TAPE, bias: 0.142 });

  parts.push({ kind: 'blob', c: head, rx: 0.64, ry: 0.64, color: kit.helmet, bias: 0.6 });
  parts.push({ kind: 'face', head, r: 0.64, goalie: true, bias: 0.61 });
  return parts;
}

// ---------------------------------------------------------------------------
// Public drawing entry points
// ---------------------------------------------------------------------------

/** Heading of baked direction `d`, radians, clockwise on screen from +x. */
export function directionAngle(d: number): number {
  return (d / DIRECTIONS) * Math.PI * 2;
}

/** The baked direction nearest a heading. */
export function directionIndex(facing: number): number {
  const step = (Math.PI * 2) / DIRECTIONS;
  return ((Math.round(facing / step) % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
}

export function drawSkater(kit: Kit, pose: SkaterPose, direction: number): Raster {
  const raster = new Raster(CELL, CELL);
  paint(raster, skaterParts(kit, pose), directionAngle(direction));
  finish(raster, pose === 'down' ? 14 : 10);
  return raster;
}

export function drawGoalie(kit: Kit, pose: GoaliePose, direction: number): Raster {
  const raster = new Raster(CELL, CELL);
  paint(raster, goalieParts(kit, pose), directionAngle(direction));
  finish(raster, 13);
  return raster;
}

// ---------------------------------------------------------------------------
// Puck and net
// ---------------------------------------------------------------------------

export const PUCK_CELL = 12;

/** The puck, two frames of a spin so a sliding puck visibly moves. */
export function drawPuck(frame: number): Raster {
  const raster = new Raster(PUCK_CELL, PUCK_CELL);
  const c = PUCK_CELL / 2;
  raster.blob(c, c + 0.5, 3.4, 2.4, ramp(0x15181f));
  raster.set(frame === 0 ? c - 2 : c + 1, c - 1, 0x59606e);
  raster.set(frame === 0 ? c - 1 : c, c - 1, 0x3a404c);
  raster.outline(0x05070b);
  raster.under(c, c + 2, 4, 1.6, 0x0a1a33, 0.25);
  return raster;
}

export const NET_WIDTH = 42;
export const NET_HEIGHT = 72;
/** Where the goal line's centre sits in the net cell. */
export const NET_ANCHOR_X = 12;
export const NET_ANCHOR_Y = 50;

/**
 * The net, drawn for the goal at +x (mouth facing -x). The other end is the
 * same picture mirrored, so `sprites.ts` flips it rather than baking it twice.
 *
 * Posts and crossbar in the defending side's colour, which is what v0.1 did
 * with the goal frame on the flat rink and is kept for the same reason: it says
 * whose net it is without a caption.
 */
export function drawNet(frameColor: string, halfWidth: number, depth: number): Raster {
  const raster = new Raster(NET_WIDTH, NET_HEIGHT);
  const height = 4;
  const P = (x: number, y: number, z: number): { x: number; y: number } => ({
    x: NET_ANCHOR_X + x * PX_PER_FOOT,
    y: NET_ANCHOR_Y + y * PX_PER_FOOT - z * PX_PER_FOOT * Z_SCALE,
  });
  const w = halfWidth;
  const topDepth = 1.4;
  const backW = w * 0.82;

  const mesh = (px: number, py: number): { c: Rgb; alpha: number } =>
    (px + py) % 3 === 0 || (px - py + 300) % 3 === 0
      ? { c: 0xffffff, alpha: 0.95 }
      : { c: 0xb9c4d3, alpha: 0.45 };

  // Back and sides first (they are behind the frame), then the roof.
  raster.polygon([P(topDepth, -w, height), P(depth, -backW, 0.3), P(depth, backW, 0.3), P(topDepth, w, height)], mesh);
  raster.polygon([P(0, -w, 0), P(depth, -backW, 0), P(depth, -backW, 0.3), P(topDepth, -w, height), P(0, -w, height)], mesh);
  raster.polygon([P(0, w, 0), P(depth, backW, 0), P(depth, backW, 0.3), P(topDepth, w, height), P(0, w, height)], mesh);
  raster.polygon([P(0, -w, height), P(topDepth, -w, height), P(topDepth, w, height), P(0, w, height)], mesh);

  const frame = ramp(parseHex(frameColor));
  const white = ramp(0xf4f6fa);
  const bar = (a: { x: number; y: number }, b: { x: number; y: number }, r: number, c: Ramp): void =>
    raster.limb(a.x, a.y, b.x, b.y, r, c);
  // Base frame, white, along the ice.
  bar(P(0, -w, 0), P(depth, -backW, 0), 0.6, white);
  bar(P(depth, -backW, 0), P(depth, backW, 0), 0.6, white);
  bar(P(0, w, 0), P(depth, backW, 0), 0.6, white);
  // Roof bars and back upright.
  bar(P(0, -w, height), P(topDepth, -w, height), 0.7, frame);
  bar(P(0, w, height), P(topDepth, w, height), 0.7, frame);
  bar(P(topDepth, -w, height), P(depth, -backW, 0.3), 0.7, frame);
  bar(P(topDepth, w, height), P(depth, backW, 0.3), 0.7, frame);
  // Posts and crossbar: the mouth.
  bar(P(0, -w, 0), P(0, -w, height), 1.1, frame);
  bar(P(0, w, 0), P(0, w, height), 1.1, frame);
  bar(P(0, -w, height), P(0, w, height), 1.1, frame);

  raster.outline(OUTLINE);
  return raster;
}
