/* ---------------------------------------------------------------------------
   basemaps.js — the basemaps a dashboard may choose, and what each one costs.

   Every entry carries its CSP origins, and that is the point of this file
   existing rather than a URL being pasted into a style. The site runs under
   `script-src 'self'` with an explicit allowlist for everything else, so
   choosing a basemap is not only a visual decision: it decides which outside
   origins the page may talk to at all.

   public/_headers carries the union of the origins below, so every entry here
   is reachable whichever one the config names -- a static header cannot change
   when the reader presses the toggle. Paste a tile URL anywhere else and the
   map fails silently under CSP with no error a reader could act on, which is
   exactly the failure this indirection exists to prevent.

   Only free, key-less sources are listed. Anything needing an API key would
   put a secret in a static bundle, where it is not secret -- and a key-less
   source that QUIETLY starts requiring one is the same failure arriving late.

   CARTO's three raster basemaps were listed here until they began serving a
   2 KB "API KEY REQUIRED" watermark tile under a 200 response. Nothing threw,
   no request failed, and the map rendered: it simply rendered CARTO's notice
   under the crash points. That is the argument for checking what a tile
   CONTAINS rather than whether it arrived, and for the rule above being a
   rule rather than a preference.
--------------------------------------------------------------------------- */

/** @typedef {{
 *   id: string, label: string, note: string,
 *   kind: 'vector' | 'none',
 *   style?: string, styleDark?: string,
 *   attribution: string,
 *   csp: { connect?: string[], img?: string[], font?: string[] },
 * }} Basemap */

/* OpenFreeMap serves the full OpenMapTiles schema with no key and no rate
   limit, which is why it is the default. Vector tiles mean labels stay sharp
   at any zoom and the style can be restyled for a dark theme rather than
   dimmed with a filter. */
/* Every OpenFreeMap entry shares one dark style. Vector tiles can be restyled,
   so the dark theme swaps the STYLE DOCUMENT rather than dimming the light one
   with a filter -- a filtered basemap drags the data marks down with it. */
const OFM_DARK = 'https://tiles.openfreemap.org/styles/dark';

const OPENFREEMAP = {
  kind: 'vector',
  attribution:
    '© <a href="https://openfreemap.org" rel="noreferrer noopener">OpenFreeMap</a> '
    + '© <a href="https://www.openmaptiles.org/" rel="noreferrer noopener">OpenMapTiles</a> '
    + 'Data from <a href="https://www.openstreetmap.org/copyright" rel="noreferrer noopener">OpenStreetMap</a>',
  /* Vector tiles arrive by fetch (connect-src), sprites as images, and glyph
     PBFs are requested as fonts. Miss any one and the map renders partially
     with no obvious cause. */
  csp: {
    connect: ['https://tiles.openfreemap.org'],
    img: ['https://tiles.openfreemap.org'],
    font: ['https://tiles.openfreemap.org'],
  },
};

/* CARTO's raster basemaps are free for reasonable use with attribution. Raster
   means no restyling -- a dark dashboard needs the dark tiles, not a filtered
   light set, which is why both are listed separately. */
export const BASEMAPS = /** @type {Record<string, Basemap>} */ ({
  'openfreemap-liberty': {
    ...OPENFREEMAP,
    id: 'openfreemap-liberty',
    label: 'Streets',
    note: 'Full street detail. Best when the reader needs to locate a specific place.',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    styleDark: OFM_DARK,
  },
  'openfreemap-positron': {
    ...OPENFREEMAP,
    id: 'openfreemap-positron',
    label: 'Muted',
    note: 'Low-contrast greys. The right default when the data is the figure and the map is the ground.',
    style: 'https://tiles.openfreemap.org/styles/positron',
    styleDark: OFM_DARK,
  },
  'openfreemap-bright': {
    ...OPENFREEMAP,
    id: 'openfreemap-bright',
    label: 'Bright',
    note: 'Saturated. Competes with most data palettes; use only when the data is sparse.',
    style: 'https://tiles.openfreemap.org/styles/bright',
    styleDark: OFM_DARK,
  },

  /* No basemap at all. Not a degraded mode: when the dashboard supplies its own
     polygons, drawing them alone is often clearer than laying them over
     someone else's cartography, and it removes every third-party origin from
     the CSP. */
  none: {
    id: 'none',
    label: 'No basemap',
    note: 'Data and supplied boundaries only. Removes every external origin from the policy.',
    kind: 'none',
    attribution: '',
    csp: {},
  },
});

/** Resolve a basemap id, failing loudly rather than falling back silently. */
export function basemap(id) {
  const b = BASEMAPS[id];
  if (!b) {
    throw new Error(
      `unknown basemap "${id}". Available: ${Object.keys(BASEMAPS).join(', ')}`);
  }
  return b;
}

/**
 * The CSP origins a set of basemaps needs, merged.
 *
 * Takes a LIST because a dashboard may offer the reader a choice between two,
 * and the policy has to permit whichever they pick -- the policy is a static
 * header and cannot change when they press the toggle.
 */
export function cspOrigins(ids) {
  const out = { connect: new Set(), img: new Set(), font: new Set() };
  for (const id of ids) {
    const { csp } = basemap(id);
    for (const k of ['connect', 'img', 'font']) {
      for (const o of csp[k] || []) out[k].add(o);
    }
  }
  return { connect: [...out.connect], img: [...out.img], font: [...out.font] };
}
