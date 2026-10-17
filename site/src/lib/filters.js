/* ---------------------------------------------------------------------------
   filters.js — filter state, the filter pass, and URL-hash permalinks.

   State lives in the URL hash so any view is shareable and the back button
   works, with no server and no storage. The hash is the single source of truth:
   the UI writes to it, and everything redraws from parsing it back.
--------------------------------------------------------------------------- */

import { FLAG_BIT } from './facts.js';

export const KABCO_ORDER = ['K', 'A', 'B', 'C', 'O', 'U'];

export const KABCO_LABEL = {
  K: 'Fatal',
  A: 'Suspected serious',
  B: 'Suspected minor',
  C: 'Possible injury',
  O: 'Property damage only',
  U: 'Unknown',
};

/* Factors offered as filters. The four officer-assessment fields carry the
   caveat from meta.json in their tooltip — they are a field judgement, not a
   toxicology result or a conviction. */
export const FACTORS = [
  ['is_ka', 'Fatal or serious'],
  ['is_vru', 'Pedestrian or bicycle'],
  ['is_wildlife', 'Wildlife involved'],
  ['is_intersection', 'Intersection-related'],
  ['alcohol_suspected', 'Alcohol suspected'],
  ['drug_suspected', 'Drugs suspected'],
  ['distracted_driver', 'Distraction indicated'],
  ['fatigued_driver', 'Fatigue indicated'],
  ['unrestrained_occupant', 'Unrestrained occupant'],
  ['occupant_ejected', 'Occupant ejected'],
  ['motorcycle_involved', 'Motorcycle involved'],
  ['heavy_truck_involved', 'Heavy truck involved'],
  ['hit_and_run', 'Hit and run'],
  ['work_zone', 'Work zone'],
];

export const SUSPICION_FIELDS = new Set([
  'alcohol_suspected', 'drug_suspected', 'distracted_driver', 'fatigued_driver',
]);

/** @returns {{y0:number,y1:number,sev:string[],factors:string[],county:string|null,ctype:string|null,map:number[]|null}} */
/* The opening state. Derived from the bundle rather than written down: a
   statewide build and a county build have different year ranges and different
   sensible defaults, and the dashboard should not have to be edited to serve
   either. */
export function defaultState(meta) {
  return {
    y0: meta?.data?.year_min ?? 2016,
    y1: meta?.data?.year_max ?? 2025,
    sev: [],        // empty = all severities
    factors: [],    // all must hold (AND)
    county: null,
    ctype: null,
    map: null,      // [zoom, lat, lon]
    mode: 'explore',
    // `metric` belongs to the rankings where severity coding is the question
    // (fatal+serious vs fatal only). The rate ranking asks a different one
    // (every crash vs the severe ones) and so carries its own key rather than
    // coercing a shared one into meaning two things.
    metric: 'ka',
    rmetric: 'all',
    lines: 'count',   // or 'rate' — what the road network encodes
  };
}

/* Parse the hash back into state.

   Every field is validated against the bundle rather than trusted, because the
   hash is user-editable by definition -- it arrives from a pasted link, an
   edited address bar, or a stale bookmark pointing at a bundle whose columns
   have since changed. An unparseable field falls back to its default instead
   of throwing; a dashboard that refuses to load because someone truncated a
   URL is worse than one that opens unfiltered. */
export function parseHash(meta) {
  const s = defaultState(meta);
  const h = location.hash.replace(/^#/, '');
  if (!h) return s;
  const q = new URLSearchParams(h);
  const yr = q.get('yr');
  if (yr && /^\d{4}-\d{4}$/.test(yr)) {
    const [a, b] = yr.split('-').map(Number);
    s.y0 = Math.min(a, b); s.y1 = Math.max(a, b);
  }
  const sev = q.get('sev');
  if (sev) s.sev = sev.split('').filter((k) => KABCO_ORDER.includes(k));
  const f = q.get('f');
  if (f) s.factors = f.split(',').filter((k) => k in FLAG_BIT);
  s.county = q.get('county') || null;
  s.ctype = q.get('ct') || null;
  // A report is a finding worth sharing, so the mode travels in the link.
  const mode = q.get('mode');
  if (mode && ['explore', 'intersections', 'risk', 'rates', 'rising', 'vru',
               'wildlife'].includes(mode)) s.mode = mode;
  // One vocabulary: 'all' = every crash, 'ka' = fatal + serious, 'k' = fatal
  // only. Each key takes the two values that make sense for its report.
  const metric = q.get('metric');
  if (metric === 'k' || metric === 'ka') s.metric = metric;
  const rmetric = q.get('rmetric');
  if (rmetric === 'all' || rmetric === 'ka') s.rmetric = rmetric;
  const lines = q.get('lines');
  if (lines === 'rate' || lines === 'count') s.lines = lines;
  const m = q.get('map');
  if (m) {
    const p = m.split('/').map(Number);
    if (p.length === 3 && p.every(Number.isFinite)) s.map = p;
  }
  return s;
}

/* Write state back to the hash.

   Fields at their default are OMITTED, so a shared link carries only what was
   actually chosen and stays readable. `replace` distinguishes a state change
   the reader made (pushState -- the back button should undo it) from one the
   app made on their behalf, such as the map writing its view after a fitBounds
   (replaceState -- there is nothing for the reader to go back to). */
export function writeHash(s, meta, { replace = false } = {}) {
  const d = defaultState(meta);
  const q = new URLSearchParams();
  if (s.y0 !== d.y0 || s.y1 !== d.y1) q.set('yr', `${s.y0}-${s.y1}`);
  if (s.sev.length) q.set('sev', KABCO_ORDER.filter((k) => s.sev.includes(k)).join(''));
  if (s.factors.length) q.set('f', s.factors.join(','));
  if (s.county) q.set('county', s.county);
  if (s.ctype) q.set('ct', s.ctype);
  if (s.mode && s.mode !== d.mode) q.set('mode', s.mode);
  if (['intersections', 'risk'].includes(s.mode) && s.metric !== d.metric) {
    q.set('metric', s.metric);
  }
  if (s.mode === 'rates' && s.rmetric !== d.rmetric) q.set('rmetric', s.rmetric);
  if (s.lines !== d.lines) q.set('lines', s.lines);
  if (s.map) q.set('map', `${s.map[0].toFixed(1)}/${s.map[1].toFixed(3)}/${s.map[2].toFixed(3)}`);
  const hash = q.toString() ? `#${q.toString()}` : location.pathname;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
}

/**
 * Run the filter. Returns a Uint8Array mask plus the surviving row count.
 *
 * One pass, early-exit per predicate, over typed arrays — this is why the
 * columns were transposed at load.
 */
/* The filter pass: one linear loop over the whole table.

   The work that matters happens BEFORE the loop. Every dictionary comparison
   is resolved to an integer code up front, so the hot path compares integers
   and never touches a string -- `indexOf` on a values array inside the loop
   would make this O(n * cardinality) instead of O(n).

   Returns a MASK, not a filtered copy. Everything downstream -- charts, map
   paint, the ranked reports -- counts through the mask over the original
   arrays, so no pass ever materialises a second array of rows. At 27k rows
   that is the difference between a few milliseconds and a visible stutter;
   at 219k it is the difference between working and not. */
export function applyFilter(facts, s) {
  const { n, cols } = facts;
  const mask = new Uint8Array(n);
  const year = cols.year;
  const flags = cols.flags;

  let flagMask = 0;
  for (const f of s.factors) flagMask |= FLAG_BIT[f] ?? 0;

  const kab = cols.kabco;
  let sevCodes = null;
  if (s.sev.length && kab) {
    sevCodes = new Set(s.sev.map((k) => kab.values.indexOf(k)).filter((c) => c > 0));
    if (!sevCodes.size) sevCodes = null;
  }

  const cty = cols.county;
  const ctyCode = s.county && cty ? cty.values.indexOf(s.county) : -1;
  const ct = cols.collision_type;
  const ctCode = s.ctype && ct ? ct.values.indexOf(s.ctype) : -1;

  let kept = 0;
  for (let r = 0; r < n; r++) {
    const y = year[r];
    if (y < s.y0 || y > s.y1) continue;
    if (flagMask && (flags[r] & flagMask) !== flagMask) continue;
    if (sevCodes && !sevCodes.has(kab.codes[r])) continue;
    if (ctyCode > 0 && cty.codes[r] !== ctyCode) continue;
    if (ctCode > 0 && ct.codes[r] !== ctCode) continue;
    mask[r] = 1;
    kept++;
  }
  return { mask, kept };
}

/* ------------------------------------------------------------- aggregation */

/** Counts of a dictionary column under the mask, descending, with a tail fold. */
export function countBy(facts, mask, name, { top = 0 } = {}) {
  const col = facts.cols[name];
  if (!col) return [];
  const counts = new Int32Array(col.values.length);
  for (let r = 0; r < facts.n; r++) if (mask[r]) counts[col.codes[r]]++;
  const rows = col.values
    .map((v, code) => ({ label: v, n: counts[code] }))
    .filter((d) => d.label !== null && d.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!top || rows.length <= top) return rows;
  const head = rows.slice(0, top);
  const tail = rows.slice(top).reduce((a, d) => a + d.n, 0);
  // Never invent a new hue for a long tail — fold it into one labelled bucket.
  if (tail) head.push({ label: 'All other types', n: tail, isOther: true });
  return head;
}

/** Counts of an integer column under the mask over an inclusive range. */
/* Histogram over a small integer column -- year, hour of day.

   `mask` may be null, meaning "count everything". That is not a convenience:
   the chart axes have to be stable across filter changes, so the domain is
   computed unmasked once while the bars are computed masked on every pass. A
   y-axis that rescaled under the reader as they filtered would make two
   adjacent states incomparable, which is the one thing a bar chart is for. */
export function countByInt(facts, mask, name, lo, hi) {
  const a = facts.cols[name];
  const out = new Array(hi - lo + 1).fill(0);
  for (let r = 0; r < facts.n; r++) {
    if (!mask[r]) continue;
    const v = a[r];
    if (v < lo || v > hi) continue;
    out[v - lo]++;
  }
  return out.map((n, i) => ({ label: lo + i, n }));
}

/** Severity counts in KABCO order (always all six, so the ramp stays stable). */
export function severityCounts(facts, mask) {
  const col = facts.cols.kabco;
  const byCode = new Int32Array(col.values.length);
  for (let r = 0; r < facts.n; r++) if (mask[r]) byCode[col.codes[r]]++;
  return KABCO_ORDER.map((k) => {
    const code = col.values.indexOf(k);
    return { key: k, label: KABCO_LABEL[k], n: code > 0 ? byCode[code] : 0 };
  });
}

/** Per-segment totals under the mask — drives the line layer. */
/* Crash totals per road segment, for painting the network.

   Keyed by segment id and accumulated in one pass over the mask, because the
   alternative -- grouping rows then summing groups -- allocates a Map of
   arrays for something that is only ever reduced to a number. */
export function segmentTotals(facts, mask) {
  const seg = facts.cols.seg_id;
  const flags = facts.cols.flags;
  const kaBit = FLAG_BIT.is_ka;
  /** @type {Map<number, {t:number, ka:number}>} */
  const out = new Map();
  // County bundles carry no segment column -- the line layer is off for them,
  // so there is nothing to total. Returning empty keeps every caller's shape
  // intact without each one having to know which bundle it is looking at.
  if (!seg) return out;
  for (let r = 0; r < facts.n; r++) {
    if (!mask[r]) continue;
    const id = seg[r];
    if (id < 0) continue;
    let e = out.get(id);
    if (!e) { e = { t: 0, ka: 0 }; out.set(id, e); }
    e.t++;
    if (flags[r] & kaBit) e.ka++;
  }
  return out;
}

/** Headline numbers for the stat tiles. */
export function headline(facts, mask, kept) {
  const sev = severityCounts(facts, mask);
  const byKey = Object.fromEntries(sev.map((d) => [d.key, d.n]));
  const ka = (byKey.K || 0) + (byKey.A || 0);
  let personK = 0;
  const pk = facts.cols.person_K;
  if (pk) for (let r = 0; r < facts.n; r++) if (mask[r] && pk[r] > 0) personK += pk[r];
  return {
    total: kept,
    K: byKey.K || 0,
    A: byKey.A || 0,
    KA: ka,
    kaShare: kept ? (ka / kept) * 100 : 0,
    fatalInjuries: personK,
  };
}
