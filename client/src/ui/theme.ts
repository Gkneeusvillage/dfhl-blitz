/**
 * Colour work that the stylesheet cannot do for itself.
 *
 * `teams.config.json` is the league owner's file and he is going to edit it —
 * that is the whole point of it existing. So nothing in the UI may assume a team
 * colour is dark, or light, or saturated. The Sharks ship at #14181d and the
 * Penguins at #f7b500; a hardcoded text colour is unreadable on one of them
 * whatever it is. Every place a team colour becomes a background, the ink on top
 * is computed from it here.
 *
 * Pair F owns the art pass in Phase 5. These are the primitives it will want to
 * keep: the palette tokens live in CSS variables (see `styles.ts`) so a restyle
 * is a stylesheet edit, and only the contrast maths lives in TypeScript, because
 * it depends on data that is not known until the file is read.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE_INK = '#ffffff';
const BLACK_INK = '#0a0d14';

function parseHex(hex: string): Rgb {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((char) => char + char)
          .join('')
      : clean;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value) || full.length !== 6) return { r: 128, g: 128, b: 128 };
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** WCAG relative luminance. The sRGB gamma matters here — a naive average calls #f7b500 dark. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Text colour that stays legible on a given team colour. */
export function inkOn(hex: string): string {
  return luminance(parseHex(hex)) > 0.42 ? BLACK_INK : WHITE_INK;
}

/** `rgba()` string for a team colour at a given alpha — for tints and glows. */
export function alpha(hex: string, value: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${value})`;
}

/** Blend toward black (`amount` < 0) or white (> 0). Used for panel fills and borders. */
export function shade(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  const target = amount < 0 ? 0 : 255;
  const t = Math.min(1, Math.abs(amount));
  const mix = (channel: number): number => Math.round(channel + (target - channel) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * A team colour dark enough to sit behind body text.
 *
 * Two franchises ship near-white secondary colours, and a panel filled with one
 * is a white page in a dark app. Anything above this luminance is dropped to a
 * fixed dark tint of itself rather than used raw.
 */
export function panelTint(hex: string): string {
  return luminance(parseHex(hex)) > 0.22 ? alpha(hex, 0.16) : alpha(hex, 0.3);
}
