/**
 * A tiny pixel-art raster: the drawing surface every piece of generated art is
 * painted on before it becomes a texture.
 *
 * WHY NOT CANVAS PATHS
 *
 * v0.1 drew with canvas arcs and rotated paths. Canvas anti-aliases every edge,
 * so a 32 px skater came out as a soft blob with a grey halo, and NEAREST
 * upscaling then enlarged the blur rather than a pixel. Here every shape is
 * decided per pixel — a pixel is in or out — so the art is crisp at any scale.
 *
 * It is also pure: no DOM, no Phaser. The figures, the rink and their tests all
 * run in node, and only `sprites.ts` touches a real canvas.
 */

/** 0xRRGGBB. */
export type Rgb = number;

export function parseHex(hex: string): Rgb {
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const value = Number.parseInt(full, 16);
  return Number.isFinite(value) ? value & 0xffffff : 0x808080;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Perceived brightness, 0..1. */
export function luma(c: Rgb): number {
  return (0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff)) / 255;
}

/**
 * A base colour with a highlight and a shadow, which is all the shading a
 * sprite this size can carry. Dark colours get a stronger highlight, or navy and
 * black would have no visible form at all.
 */
export interface Ramp {
  hi: Rgb;
  mid: Rgb;
  lo: Rgb;
}

export function ramp(base: Rgb): Ramp {
  const l = luma(base);
  return {
    hi: mix(base, 0xffffff, l < 0.25 ? 0.32 : 0.26),
    mid: base,
    lo: mix(base, 0x000000, l > 0.8 ? 0.2 : 0.32),
  };
}

/** Light comes from the top left of the screen, as it did on every console. */
const LIGHT_X = -0.62;
const LIGHT_Y = -0.78;

function shadeFor(r: Ramp, nx: number, ny: number): Rgb {
  const d = nx * LIGHT_X + ny * LIGHT_Y;
  if (d > 0.42) return r.hi;
  if (d < -0.38) return r.lo;
  return r.mid;
}

/** A stretch of a limb in another colour, 0..1 along its length. */
export interface Band {
  from: number;
  to: number;
  color: Ramp;
}

function pointInPolygon(x: number, y: number, points: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export class Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, straight alpha. */
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  alphaAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.data[(y * this.width + x) * 4 + 3];
  }

  colorAt(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 4;
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }

  set(x: number, y: number, c: Rgb, alpha = 255): void {
    if (!this.inBounds(x, y)) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = (c >> 16) & 0xff;
    this.data[i + 1] = (c >> 8) & 0xff;
    this.data[i + 2] = c & 0xff;
    this.data[i + 3] = alpha;
  }

  /** Alpha-blend over what is there. */
  blend(x: number, y: number, c: Rgb, alpha: number): void {
    if (!this.inBounds(x, y) || alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const under = this.data[i + 3];
    if (under === 0) {
      this.set(x, y, c, Math.round(alpha * 255));
      return;
    }
    const mixed = mix(this.colorAt(x, y), c, alpha);
    this.set(x, y, mixed, Math.max(under, Math.round(alpha * 255)));
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb, alpha = 255): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.set(px, py, c, alpha);
  }

  /** Filled ellipse, shaded as a rounded form lit from the top left. */
  blob(cx: number, cy: number, rx: number, ry: number, color: Rgb | Ramp): void {
    const r = typeof color === 'number' ? null : color;
    const flat = typeof color === 'number' ? color : 0;
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        const nx = (px + 0.5 - cx) / rx;
        const ny = (py + 0.5 - cy) / ry;
        if (nx * nx + ny * ny > 1) continue;
        this.set(px, py, r === null ? flat : shadeFor(r, nx, ny));
      }
    }
  }

  /**
   * A thick line with round ends, shaded across its width.
   *
   * `bands` recolour a stretch of it, measured as 0..1 along its length — the
   * stripe on a sock, the hem of a sweater. Done per pixel rather than as a
   * second shape on top, so a stripe follows the limb exactly.
   */
  limb(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    color: Rgb | Ramp,
    bands: readonly Band[] = [],
  ): void {
    const r = typeof color === 'number' ? null : color;
    const flat = typeof color === 'number' ? color : 0;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSq = dx * dx + dy * dy;
    const minX = Math.floor(Math.min(x0, x1) - radius);
    const maxX = Math.ceil(Math.max(x0, x1) + radius);
    const minY = Math.floor(Math.min(y0, y1) - radius);
    const maxY = Math.ceil(Math.max(y0, y1) + radius);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const qx = px + 0.5 - x0;
        const qy = py + 0.5 - y0;
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (qx * dx + qy * dy) / lengthSq));
        const ox = qx - dx * t;
        const oy = qy - dy * t;
        const d2 = ox * ox + oy * oy;
        if (d2 > radius * radius) continue;
        const band = bands.find((b) => t >= b.from && t <= b.to);
        const paint = band?.color ?? r;
        this.set(px, py, paint === null ? flat : shadeFor(paint, ox / radius, oy / radius));
      }
    }
  }

  /**
   * Fill a polygon, with `pick` deciding each pixel's colour and alpha — which is
   * how the net gets a mesh pattern rather than a flat sheet.
   */
  polygon(
    points: ReadonlyArray<{ x: number; y: number }>,
    pick: (x: number, y: number) => { c: Rgb; alpha: number } | null,
  ): void {
    if (points.length < 3) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    for (let py = Math.floor(Math.min(...ys)); py <= Math.ceil(Math.max(...ys)); py++) {
      for (let px = Math.floor(Math.min(...xs)); px <= Math.ceil(Math.max(...xs)); px++) {
        if (!pointInPolygon(px + 0.5, py + 0.5, points)) continue;
        const paint = pick(px, py);
        if (paint !== null) this.blend(px, py, paint.c, paint.alpha);
      }
    }
  }

  /** A one-pixel line: stick tape, skate blades, scuffs on the ice. */
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, alpha = 255): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = Math.floor(x0 + (x1 - x0) * t);
      const py = Math.floor(y0 + (y1 - y0) * t);
      // Opaque lines overwrite; translucent ones blend, so a faint stroke tints
      // what is under it rather than punching a hole in it.
      if (alpha >= 255) this.set(px, py, c);
      else this.blend(px, py, c, alpha / 255);
    }
  }

  /** Circle outline `thickness` pixels wide, inside radius `r`. */
  ring(cx: number, cy: number, r: number, thickness: number, c: Rgb, alpha = 255): void {
    const inner = r - thickness;
    for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
      for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r * r && d2 > inner * inner) this.set(px, py, c, alpha);
      }
    }
  }

  /**
   * Draw a one-pixel dark outline around everything opaque.
   *
   * This is the single biggest readability win on white ice: a pale jersey with
   * no outline simply dissolves into the sheet. Only fully transparent pixels
   * touching an opaque one are painted, so the outline never eats the art.
   */
  outline(c: Rgb): void {
    const marks: number[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.alphaAt(x, y) !== 0) continue;
        if (
          this.alphaAt(x - 1, y) === 255 ||
          this.alphaAt(x + 1, y) === 255 ||
          this.alphaAt(x, y - 1) === 255 ||
          this.alphaAt(x, y + 1) === 255
        ) {
          marks.push(x, y);
        }
      }
    }
    for (let i = 0; i < marks.length; i += 2) this.set(marks[i], marks[i + 1], c);
  }

  /** Paint `c` at `alpha` only where nothing has been drawn yet — a cast shadow. */
  under(cx: number, cy: number, rx: number, ry: number, c: Rgb, alpha: number): void {
    const a = Math.round(alpha * 255);
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        const nx = (px + 0.5 - cx) / rx;
        const ny = (py + 0.5 - cy) / ry;
        if (nx * nx + ny * ny > 1 || this.alphaAt(px, py) !== 0) continue;
        this.set(px, py, c, a);
      }
    }
  }

  /** Copy `src` onto this raster at an offset, skipping transparent pixels. */
  stamp(src: Raster, ox: number, oy: number): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const a = src.alphaAt(x, y);
        if (a === 0) continue;
        if (a === 255) this.set(ox + x, oy + y, src.colorAt(x, y));
        else this.blend(ox + x, oy + y, src.colorAt(x, y), a / 255);
      }
    }
  }
}

/** Small deterministic generator, so baked art is identical on every load. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
