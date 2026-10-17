/* ---------------------------------------------------------------------------
   oklab.js — colour maths, in the one space where "lighter" means lighter.

   sRGB is not perceptually uniform: #0000FF and #FFFF00 have wildly different
   apparent lightness at the same nominal value, and interpolating between two
   colours in it swings through muddy greys. OKLab is uniform enough that
   lightness, chroma and hue can be manipulated independently -- which is what
   makes a theme derivable from three brand colours rather than hand-picked.

   Everything here is pure and dependency-free so it can run in the build, in
   the browser, and in a test without ceremony.
--------------------------------------------------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB 0-255 -> linear-light 0-1. The gamma curve, not a simple /255. */
const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(clamp01(v / 255) * 255)
    .toString(16).padStart(2, '0')).join('').toUpperCase();

export function rgbToOklab([r, g, b]) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function oklabToRgb([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((v) => Math.round(clamp01(fromLinear(clamp01(v))) * 255));
}

/** Lightness, chroma, hue (degrees) — the form a human reasons in. */
export function toLCH(hex) {
  const [L, A, B] = rgbToOklab(hexToRgb(hex));
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

export function fromLCH({ L, C, h }) {
  const rad = (h * Math.PI) / 180;
  return rgbToHex(oklabToRgb([L, C * Math.cos(rad), C * Math.sin(rad)]));
}

/** WCAG relative luminance, which is a different quantity from OKLab L and is
 *  the one the contrast ratio is defined against. Using L here would give
 *  plausible numbers that fail a real accessibility check. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Perceptual distance, OKLab scaled by 100 — the units the 15-point
 *  normal-vision separation floor is expressed in. */
export function deltaE(a, b) {
  const p = rgbToOklab(hexToRgb(a)), q = rgbToOklab(hexToRgb(b));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

/**
 * Move a colour along its own lightness until it clears a contrast target.
 *
 * Hue and chroma are held, so the result still reads as the same colour -- a
 * brand navy darkened for a white background is still that navy. Returns null
 * when the target is unreachable at this hue, which is a real outcome worth
 * reporting rather than silently returning the nearest miss.
 */
export function solveContrast(src, bg, target, { lighter = null, steps = 400 } = {}) {
  const { L, C, h } = toLCH(src);
  if (contrast(src, bg) >= target) return src;
  const up = lighter === null ? luminance(bg) < luminance(src) : lighter;
  for (let i = 1; i <= steps; i++) {
    const t = up ? L + (1 - L) * (i / steps) : L * (1 - i / steps);
    const cand = fromLCH({ L: t, C, h });
    if (contrast(cand, bg) >= target) return cand;
  }
  return null;
}
