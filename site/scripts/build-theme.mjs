#!/usr/bin/env node
/**
 * Derive a whole theme from three brand colours, and refuse to ship a bad one.
 *
 * A template cannot ask its user to hand-pick forty tokens, and it must not
 * take three hex values on trust either: a brand palette is chosen for a
 * letterhead, where nothing has to clear 4.5:1 against a background it was
 * never tested on. So the tokens are DERIVED -- hue and chroma held, lightness
 * solved until each one clears the contrast its role requires -- and the build
 * FAILS, loudly and with numbers, when a role cannot be satisfied.
 *
 * Failing is the feature. A silent near-miss ships a dashboard whose muted text
 * is unreadable for some portion of its readers, and nobody finds out.
 *
 *   node site/scripts/build-theme.mjs   ->  site/src/styles/theme.css
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLCH, fromLCH, contrast, deltaE, solveContrast, hexToRgb } from '../src/lib/oklab.js';
import { load as loadConfig } from '../../pipeline/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* WCAG minimums, named so the failure report can say which rule was missed.
   Graphics are 3:1 because a 1px rule and a 12px letter are not the same
   perceptual task; text is 4.5:1 because it is. */
const TEXT = 4.5;
const GRAPHIC = 3.0;

/* Below this chroma a mark stops reading as a colour and starts reading as
   grey. It is not taste: an earlier palette here harmonised beautifully and
   failed at exactly 0.100, which is where the eye gives up. */
const CHROMA_FLOOR = 0.10;

/* Reads the same config the pipeline does, through the same validator, so a
   value the build accepts cannot be one the theme rejects. */
const cfg = loadConfig(join(root, '..', 'crashmap.config.json'));

const { primary, secondary, accent } = cfg.theme;
const P = toLCH(primary);

/* ---- the one structural decision -------------------------------------- */
/* Can the primary be a MARK on a dark ground, or must it BE the ground?
   A deep brand colour -- navy, maroon, forest -- measures 1.4:1 on near-black
   and is invisible as a mark there, so the only honest use for it in a dark
   theme is as the surface itself. A mid or light primary can be a mark, and
   then the dark ground is a neutral carrying a trace of its hue. Choosing
   wrong here is what makes a derived dark theme look broken. */
const NEAR_BLACK = '#101114';
const primaryIsGround = contrast(primary, NEAR_BLACK) < GRAPHIC;

const darkSurface1 = primaryIsGround ? primary : fromLCH({ L: 0.20, C: Math.min(P.C, 0.04), h: P.h });
const darkSurface0 = fromLCH({ ...toLCH(darkSurface1), L: Math.max(0.06, toLCH(darkSurface1).L - 0.085) });
const darkSurface2 = fromLCH({ ...toLCH(darkSurface1), L: toLCH(darkSurface1).L + 0.055 });

/* Light surfaces carry a trace of the primary's hue so the ground sits with
   the brand instead of beside it. Chroma stays under the floor deliberately:
   a surface is not a mark and must not read as one. */
const tint = (L, C) => fromLCH({ L, C, h: P.h });
const lightSurface0 = tint(0.975, 0.006);
const lightSurface1 = '#FFFFFF';
const lightSurface2 = tint(0.945, 0.010);

/* Several identity tokens are not bare colours -- a wash at 7% alpha, a glow
   made of two rings, a drop shadow. They still have to follow the brand, so
   they are composed here from the same three inputs rather than left behind in
   the stylesheet as the one maroon thing in a navy theme. */
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
/* Shift a colour along lightness only, clamped to the usable range. */
const shiftL = (hex, dL) => {
  const c = toLCH(hex);
  return fromLCH({ ...c, L: Math.min(0.99, Math.max(0.02, c.L + dL)) });
};
/* A near-neutral at the primary's hue: grounds and gridlines that sit with the
   brand without reading as a mark. */
const neutral = (L) => fromLCH({ L, C: 0.004, h: P.h });

const S = toLCH(secondary);
const A3 = toLCH(accent);

const problems = [];
/** Solve a token for its ground, recording a precise failure if it cannot. */
function role(name, src, bg, target, { lighter = null } = {}) {
  const got = solveContrast(src, bg, target, { lighter });
  if (!got) {
    problems.push(`${name}: cannot reach ${target}:1 against ${bg} from ${src} `
      + `without changing its hue (best ${contrast(src, bg).toFixed(2)}:1)`);
    return src;
  }
  return got;
}

const light = {
  '--surface-0': lightSurface0,
  '--surface-1': lightSurface1,
  '--surface-2': lightSurface2,
  '--border': tint(0.880, 0.016),
  '--border-strong': tint(0.760, 0.024),
  '--text-primary': role('text-primary (light)', tint(0.20, 0.01), lightSurface1, 7.0, { lighter: false }),
  '--text-secondary': role('text-secondary (light)', tint(0.42, 0.02), lightSurface1, TEXT, { lighter: false }),
  '--text-muted': role('text-muted (light)', tint(0.55, 0.02), lightSurface1, TEXT, { lighter: false }),
  '--accent': role('accent (light)', primary, lightSurface1, TEXT, { lighter: false }),
  '--accent-2': role('accent-2 (light)', secondary, lightSurface1, TEXT, { lighter: false }),
  '--accent-3': role('accent-3 (light)', accent, lightSurface1, TEXT, { lighter: false }),
  '--series-1': role('series-1 (light)', fromLCH({ L: 0.58, C: Math.max(P.C, CHROMA_FLOOR + 0.04), h: P.h }),
    lightSurface1, GRAPHIC, { lighter: false }),
  /* Slot 2 is the secondary at reading contrast -- the same value --accent-2
     resolves to, named separately because one is identity and one is a data
     mark, and a later palette may want them apart. */
  '--series-2': role('series-2 (light)', secondary, lightSurface1, GRAPHIC, { lighter: false }),

  /* MapLibre's control glyphs are near-black SVG data URIs, recolourable only
     by filter. Light mode leaves them alone. */
  '--ctrl-icon-filter': 'none',

  /* Chrome: the brand at its loudest, for a wordmark and a pressed control. */
  '--wordmark': role('wordmark (light)', primary, lightSurface1, TEXT, { lighter: false }),
  '--active-ink': role('active-ink (light)', primary, lightSurface1, TEXT, { lighter: false }),
  '--active-bg': rgba(primary, '.07'),
  /* A hairline of the tertiary, lightened to a rule rather than a mark. */
  '--hairline': fromLCH({ L: 0.80, C: Math.min(A3.C, 0.09), h: A3.h }),

  /* Two rings rather than a blur: an outline that survives `overflow: hidden`
     on a segmented control, which a spread shadow does not. */
  '--glow': `0 0 0 1px ${rgba(primary, '.30')}, 0 0 12px ${rgba(primary, '.16')}`,
  '--glow-strong': `0 0 0 1px ${rgba(primary, '.48')}, 0 0 16px ${rgba(primary, '.26')}`,

  /* Map and chart grounds: recessive by construction, never a mark. */
  '--grid': neutral(0.905),
  '--map-ground': neutral(0.925),
  '--map-county': neutral(0.875),

  /* Frosted panels. The blur radius is geometry and stays in app.css. */
  '--glass-1': 'rgba(255, 255, 255, .78)',
  '--glass-2': 'rgba(255, 255, 255, .84)',
  '--glass-sheen': 'rgba(255, 255, 255, .85)',
  '--glass-hairline': 'rgba(255, 255, 255, .55)',
  '--glass-shadow': `0 1px 2px ${rgba(shiftL(primary, -0.10), '.06')}, `
    + `0 12px 34px ${rgba(shiftL(primary, -0.10), '.10')}`,
  '--shadow': '0 1px 2px rgba(0, 0, 0, .05), 0 1px 10px rgba(0, 0, 0, .04)',

  /* The page wash: two faint grounds plus a brand tint over them. */
  '--app-wash-a': fromLCH({ L: 0.955, C: 0.012, h: (P.h + 40) % 360 }),
  '--app-wash-b': fromLCH({ L: 0.970, C: 0.010, h: A3.h }),
  '--app-wash-c': rgba(primary, '.07'),
};
const dark = {
  '--surface-0': darkSurface0,
  '--surface-1': darkSurface1,
  '--surface-2': darkSurface2,
  '--border': fromLCH({ ...toLCH(darkSurface1), L: toLCH(darkSurface1).L + 0.12 }),
  '--border-strong': fromLCH({ ...toLCH(darkSurface1), L: toLCH(darkSurface1).L + 0.20 }),
  '--text-primary': '#FFFFFF',
  '--text-secondary': role('text-secondary (dark)', tint(0.80, 0.03), darkSurface1, TEXT, { lighter: true }),
  '--text-muted': role('text-muted (dark)', tint(0.70, 0.03), darkSurface1, TEXT, { lighter: true }),
  '--accent': role('accent (dark)', secondary, darkSurface1, TEXT, { lighter: true }),
  '--accent-2': role('accent-2 (dark)', accent, darkSurface1, TEXT, { lighter: true }),
  /* The primary's own hue, LIFTED until it reads on its own ground. Falling
     back to the secondary here produced a token identical to --accent: three
     slots, two colours, and a legend that cannot show three series. A deep
     brand colour can still be a third mark in a dark theme -- just not at the
     lightness it was given. */
  '--accent-3': role('accent-3 (dark)',
    fromLCH({ L: Math.max(P.L, 0.55), C: Math.max(P.C, CHROMA_FLOOR), h: P.h }),
    darkSurface1, TEXT, { lighter: true }),
  '--series-1': role('series-1 (dark)', fromLCH({ L: 0.72, C: Math.max(P.C, CHROMA_FLOOR), h: P.h }),
    darkSurface1, GRAPHIC, { lighter: true }),
  '--series-2': role('series-2 (dark)', secondary, darkSurface1, GRAPHIC, { lighter: true }),

  /* Inverted to white, then dimmed back to roughly --text-secondary, so the
     glyphs read as part of the UI instead of punching holes in it. */
  '--ctrl-icon-filter': 'invert(1) brightness(.72)',

  /* On a brand-coloured ground the wordmark and the pressed state are white:
     the brand is already the surface, so repeating it would be invisible. */
  '--wordmark': '#FFFFFF',
  '--active-ink': '#FFFFFF',
  '--active-bg': rgba(secondary, '.14'),
  '--hairline': role('hairline (dark)',
    fromLCH({ L: Math.max(A3.L, 0.60), C: Math.max(A3.C, CHROMA_FLOOR), h: A3.h }),
    darkSurface1, GRAPHIC, { lighter: true }),

  '--glow': `0 0 0 1px ${rgba(secondary, '.30')}, 0 0 12px ${rgba(secondary, '.18')}`,
  '--glow-strong': `0 0 0 1px ${rgba(secondary, '.46')}, 0 0 16px ${rgba(secondary, '.28')}`,

  /* Gridlines carry a trace of the ground's hue so they read as part of it.
     The map ground goes DARKER than surface-0: the basemap sits behind the
     panels, and a ground lighter than its chrome inverts the depth order. */
  '--grid': fromLCH({ ...toLCH(darkSurface1), L: toLCH(darkSurface1).L + 0.13, C: Math.min(P.C, 0.05) }),
  '--map-ground': shiftL(darkSurface1, -0.055),
  '--map-county': shiftL(darkSurface1, -0.015),

  '--glass-1': rgba(darkSurface1, '.82'),
  '--glass-2': rgba(darkSurface1, '.84'),
  '--glass-sheen': 'rgba(255, 255, 255, .10)',
  '--glass-hairline': 'rgba(255, 255, 255, .07)',
  '--glass-shadow': '0 1px 2px rgba(0, 0, 0, .5), 0 12px 34px rgba(0, 0, 0, .34)',
  '--shadow': '0 1px 2px rgba(0, 0, 0, .4), 0 1px 10px rgba(0, 0, 0, .3)',

  '--app-wash-a': shiftL(darkSurface1, -0.10),
  '--app-wash-b': shiftL(darkSurface1, -0.06),
  '--app-wash-c': rgba(secondary, '.10'),
};

/* The three brand colours must also be distinguishable FROM EACH OTHER, or a
   legend with all three in it is a legend of one colour. */
const pairs = [['primary', primary, 'secondary', secondary],
               ['primary', primary, 'accent', accent],
               ['secondary', secondary, 'accent', accent]];
const separation = pairs.map(([an, a, bn, b]) => ({ pair: `${an}/${bn}`, dE: deltaE(a, b) }));
/* A WARNING, not a failure -- the distinction matters and the first version of
   this file got it wrong.
 *
 * The 15 floor governs colours that appear as ADJACENT SERIES in one chart.
 * These three are brand inputs: they become a ground, an accent and a hazard
 * stripe, and the slots that do appear together are the DERIVED ones, which
 * are separated below and fail the build if they cannot be. Rejecting a
 * palette because two of its inputs are close would have refused the maroon /
 * red / orange scheme already shipped on this dashboard, where #F9423A and
 * #ED8B00 sit dE 14.9 apart and are deliberately never drawn as peers.
 *
 * Still worth saying out loud: it constrains how they may be used. */
const warnings = [];
for (const s of separation) {
  if (s.dE < 15) {
    warnings.push(`${s.pair}: dE ${s.dE.toFixed(1)}, under the 15 floor for normal `
      + `vision. Fine as chrome; never put these two side by side as series.`);
  }
}

/* The three accent slots must differ FROM EACH OTHER, not merely from their
   ground, or a three-series legend is a legend of two.
 *
 * This needs its own pass because solving every slot to the same contrast
 * target is what creates the collision: it drives all three to a similar
 * lightness, leaving hue as the only separator, and two adjacent brand hues
 * (a teal and a blue, say) then land ~9 dE apart. Contrast is a FLOOR, not a
 * target, so the fix is to spend the headroom above it -- push the later slot
 * further along lightness until it separates, which keeps its hue and its
 * readability and costs only that it is lighter than strictly required.
 */
const FLOOR_DE = 15;
function separate(tok, bg, lighter) {
  const slots = ['--accent', '--accent-2', '--accent-3'];
  for (let j = 1; j < slots.length; j++) {
    for (let i = 0; i < j; i++) {
      if (deltaE(tok[slots[i]], tok[slots[j]]) >= FLOOR_DE) continue;
      const { C, h } = toLCH(tok[slots[j]]);
      let fixed = null;
      for (let step = 1; step <= 60; step++) {
        const L = toLCH(tok[slots[j]]).L + (lighter ? 1 : -1) * step * 0.01;
        if (L <= 0.02 || L >= 0.99) break;
        const cand = fromLCH({ L, C, h });
        if (contrast(cand, bg) >= TEXT
            && slots.slice(0, j).every((s) => deltaE(tok[s], cand) >= FLOOR_DE)) {
          fixed = cand; break;
        }
      }
      if (fixed) { tok[slots[j]] = fixed; }
      else {
        problems.push(`${slots[i]} vs ${slots[j]} on ${bg}: dE `
          + `${deltaE(tok[slots[i]], tok[slots[j]]).toFixed(1)} and no lightness along `
          + `this hue both clears ${TEXT}:1 and separates them. The two brand colours `
          + `behind these slots are too close in hue to carry three series.`);
      }
    }
  }
}
separate(light, lightSurface1, false);
separate(dark, darkSurface1, true);

/* --accent-strong is the hover/pressed step of --accent, so it is solved from
   the SETTLED accent rather than from the brand input: separate() may have
   moved --accent to clear the dE floor, and a strong step derived from the
   pre-move value can end up lighter than the thing it is meant to deepen. */
light['--accent-strong'] = shiftL(light['--accent'], -0.08);
dark['--accent-strong'] = shiftL(dark['--accent'], +0.10);

const fmt = (o) => Object.entries(o).map(([k, v]) => `  ${k}: ${v};`).join('\n');
const report = (o, bg) => Object.entries(o)
  .filter(([k]) => /text|accent|series/.test(k))
  .map(([k, v]) => `   ${k.padEnd(18)} ${v}  ${contrast(v, bg).toFixed(2)}:1`).join('\n');

console.log(`--> theme from ${primary} / ${secondary} / ${accent}`);
console.log(`    primary L ${P.L.toFixed(3)} chroma ${P.C.toFixed(3)} hue ${P.h.toFixed(1)}`);
console.log(`    primary on near-black ${contrast(primary, NEAR_BLACK).toFixed(2)}:1 -> `
  + `${primaryIsGround ? 'used AS the dark ground' : 'usable as a mark on dark'}`);
console.log(`\n  light (on ${lightSurface1})\n${report(light, lightSurface1)}`);
console.log(`\n  dark (on ${darkSurface1})\n${report(dark, darkSurface1)}`);
console.log(`\n  brand separation: ${separation.map((s) => `${s.pair} dE ${s.dE.toFixed(1)}`).join(', ')}`);

if (warnings.length) {
  console.log('');
  for (const w of warnings) console.log(`  note: ${w}`);
}

if (problems.length) {
  console.error(`\n!! ${problems.length} contrast problem(s) — not writing theme.css:\n`);
  for (const p of problems) console.error(`   - ${p}`);
  console.error('\n   Adjust the brand colours in crashmap.config.json, or run');
  console.error('   `npm run setup` again. A palette that cannot clear these ratios');
  console.error('   will be unreadable for some readers.');
  process.exit(1);
}

writeFileSync(join(root, 'src/styles/theme.css'), `/* GENERATED by scripts/build-theme.mjs — do not edit.
   Derived from dashboard.config.json: ${primary} / ${secondary} / ${accent}.
   Every token below was solved for its contrast target; the build fails
   rather than emit one that misses. */
:root {
  color-scheme: light;
${fmt(light)}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${fmt(dark).replace(/^/gm, '  ')}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
${fmt(dark)}
}
`);
console.log('\n--> wrote src/styles/theme.css');
