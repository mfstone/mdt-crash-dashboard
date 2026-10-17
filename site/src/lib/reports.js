/* ---------------------------------------------------------------------------
   reports.js — the analytical report modes.

   Each mode is one aggregation over the already-loaded fact table plus a map
   overlay. They respect the active filters, so "most dangerous intersections"
   and "most dangerous intersections at night in winter" are the same code path.

   Every ranking here is a count of rare events over a ten-year window, which
   means small numbers. The highest fatal-or-serious total at any single
   intersection cluster statewide is 11. A table of 1-vs-2 differences would be
   noise dressed as a finding, so each report states its own minimum and the
   gating is visible rather than silent.
--------------------------------------------------------------------------- */

import { FLAG_BIT } from './facts.js';

/* Severity weights, used only to break ties sensibly: a cluster whose K+A is
   two fatals outranks one whose K+A is two serious injuries. */
const KABCO_WEIGHT = { K: 12, A: 6, B: 3, C: 2, O: 1, U: 0 };

export const MODES = [
  { id: 'explore', label: 'Explore' },
  { id: 'intersections', label: 'Intersections' },
  { id: 'rising', label: 'Rising' },
  { id: 'vru', label: 'Walk / bike' },
  { id: 'wildlife', label: 'Wildlife' },
];

/* ------------------------------------------------------------------ helpers */

function kabcoCodes(facts) {
  const col = facts.cols.kabco;
  const byKey = {};
  for (const k of Object.keys(KABCO_WEIGHT)) byKey[k] = col.values.indexOf(k);
  return { col, byKey };
}

/** Severity-weighted score, for tie-breaking a ranking of small counts. */
function scoreOf(counts) {
  let s = 0;
  for (const [k, w] of Object.entries(KABCO_WEIGHT)) s += w * (counts[k] || 0);
  return s;
}

/* --------------------------------------------------- 1. intersection ranking */

/**
 * Rank derived intersection clusters by fatal+serious count under the filter.
 *
 * The clusters come from pipeline/derive.mjs: intersection-related crashes
 * snapped to a 40 m grid, cells with at least three crashes becoming clusters.
 * A cluster is where crashes coincide, which usually but not always means one
 * junction -- it is not a surveyed intersection. They are crash clusters, not surveyed intersections.
 */
export function rankIntersections(facts, mask, hotspots,
  { top = 25, minKA = 1, metric = 'ka' } = {}) {
  const hid = facts.cols.hotspot_id;
  if (!hid || !hotspots?.size) return { rows: [], total: 0 };

  const { col, byKey } = kabcoCodes(facts);
  /** @type {Map<number, {n:number, K:number, A:number, counts:object}>} */
  const agg = new Map();
  for (let r = 0; r < facts.n; r++) {
    if (!mask[r]) continue;
    const id = hid[r];
    if (id < 0) continue;
    let e = agg.get(id);
    if (!e) { e = { n: 0, counts: {} }; agg.set(id, e); }
    e.n++;
    const code = col.codes[r];
    for (const [k, c] of Object.entries(byKey)) {
      if (c === code) { e.counts[k] = (e.counts[k] || 0) + 1; break; }
    }
  }

  const rows = [];
  for (const [id, e] of agg) {
    const K = e.counts.K || 0;
    const A = e.counts.A || 0;
    const ka = K + A;
    const value = metric === 'k' ? K : ka;
    if (value < minKA) continue;
    const h = hotspots.get(id);
    if (!h) continue;
    rows.push({
      id, ka, value, n: e.n, K, A,
      score: scoreOf(e.counts),
      label: h.label, city: h.city, county: h.county, lon: h.lon, lat: h.lat,
    });
  }
  // Ties are everywhere at these counts, so break them by severity weight and
  // then by total crashes rather than leaving the order to insertion chance.
  rows.sort((a, b) => b.value - a.value || b.score - a.score || b.n - a.n);
  return { rows: rows.slice(0, top), total: rows.length };
}

/**
 * How concentrated a ranking is in one place, and how much of it rests on
 * "suspected serious" coding rather than fatalities.
 *
 * Severity coding is not applied uniformly across Montana, so a K+A ranking
 * partly measures who codes injuries how. That has to be visible rather than
 * left for the reader to infer from a column of one place's name. The caller
 * supplies the comparison figures, because the right ones differ between a
 * statewide bundle and a county one.
 *
 * Only real places are counted. The fallback used to be `d.city || d.county`,
 * which in a county-scoped bundle made every unincorporated cluster report the
 * county's own name -- yielding "44% of these clusters are in Missoula" inside
 * a bundle that is nothing but Missoula. True of whichever county is built.
 */
export function rankingDiagnostics(rows) {
  if (!rows.length) return null;
  const places = new Map();
  let zeroFatal = 0;
  let noPlace = 0;
  for (const d of rows) {
    if (d.city) places.set(d.city, (places.get(d.city) || 0) + 1);
    else noPlace++;
    if (!d.K) zeroFatal++;
  }
  const top = [...places.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return {
    places: places.size,
    topPlace: top ? top[0] : null,
    topCount: top ? top[1] : 0,
    topShare: top ? (top[1] / rows.length) * 100 : 0,
    noPlace,
    noPlaceShare: (noPlace / rows.length) * 100,
    zeroFatal,
    zeroFatalShare: (zeroFatal / rows.length) * 100,
  };
}

/* ------------------------------------------------------- 2. rising severity */

/**
 * Split the active year range in half and compare fatal+serious counts.
 *
 * A first-half/second-half comparison rather than a fitted slope: with a median
 * county seeing well under ten K+A crashes a year, a regression line reports a
 * precision the data does not have. Two five-year totals are what the counts
 * can actually support, and they are directly checkable against the table.
 *
 * `minTotal` gates the small-sample noise that otherwise dominates: a county
 * going from 1 to 3 is a 200% rise and means nothing.
 */
export function rankRising(facts, mask, state, { by = 'county', top = 20, minTotal = 12 } = {}) {
  const col = facts.cols[by];
  const year = facts.cols.year;
  const flags = facts.cols.flags;
  const kaBit = FLAG_BIT.is_ka;
  if (!col) return { rows: [], split: null, total: 0 };

  const y0 = state.y0, y1 = state.y1;
  if (y1 - y0 < 3) return { rows: [], split: null, total: 0, tooShort: true };
  // Odd spans put the middle year in the later half.
  const mid = Math.floor((y0 + y1) / 2);

  const early = new Int32Array(col.values.length);
  const late = new Int32Array(col.values.length);
  const earlyAll = new Int32Array(col.values.length);
  const lateAll = new Int32Array(col.values.length);

  for (let r = 0; r < facts.n; r++) {
    if (!mask[r]) continue;
    const c = col.codes[r];
    if (!c) continue;                       // code 0 is null
    const isLate = year[r] > mid;
    if (isLate) lateAll[c]++; else earlyAll[c]++;
    if (flags[r] & kaBit) {
      if (isLate) late[c]++; else early[c]++;
    }
  }

  const rows = [];
  for (let c = 1; c < col.values.length; c++) {
    const total = early[c] + late[c];
    if (total < minTotal) continue;
    rows.push({
      label: col.values[c],
      early: early[c], late: late[c],
      change: late[c] - early[c],
      pct: early[c] ? ((late[c] - early[c]) / early[c]) * 100 : null,
      crashesEarly: earlyAll[c], crashesLate: lateAll[c],
      total,
    });
  }
  rows.sort((a, b) => b.change - a.change || b.total - a.total);
  return {
    rows: rows.slice(0, top),
    all: rows,
    split: { earlyFrom: y0, earlyTo: mid, lateFrom: mid + 1, lateTo: y1 },
    total: rows.length,
    minTotal,
  };
}

/* --------------------------------------------------------- 3. walking/biking */

/**
 * Rank places by pedestrian and bicycle fatal+serious crashes.
 *
 * Pedestrian and bicycle are counted separately and a crash involving both
 * counts in each, so the two columns can sum above the VRU total — the same
 * arithmetic the GIS layers use. "City" is CityTown, the point-in-polygon
 * result against legal place boundaries, so crashes outside any incorporated
 * place are excluded rather than attributed to the nearest town.
 */
export function rankVru(facts, mask, { by = 'city', top = 20, minKA = 1 } = {}) {
  const col = facts.cols[by];
  const flags = facts.cols.flags;
  if (!col) return { rows: [], total: 0, outside: 0 };

  const pedBit = FLAG_BIT.is_pedestrian;
  const bikeBit = FLAG_BIT.is_bicycle;
  const vruBit = FLAG_BIT.is_vru;
  const kaBit = FLAG_BIT.is_ka;

  const pedKA = new Int32Array(col.values.length);
  const bikeKA = new Int32Array(col.values.length);
  const vruKA = new Int32Array(col.values.length);
  const vruAll = new Int32Array(col.values.length);
  let outside = 0;

  for (let r = 0; r < facts.n; r++) {
    if (!mask[r]) continue;
    const f = flags[r];
    if (!(f & vruBit)) continue;
    const c = col.codes[r];
    if (!c) { if (f & kaBit) outside++; continue; }
    vruAll[c]++;
    if (!(f & kaBit)) continue;
    vruKA[c]++;
    if (f & pedBit) pedKA[c]++;
    if (f & bikeBit) bikeKA[c]++;
  }

  const rows = [];
  for (let c = 1; c < col.values.length; c++) {
    if (vruKA[c] < minKA) continue;
    rows.push({
      label: col.values[c],
      ka: vruKA[c], ped: pedKA[c], bike: bikeKA[c],
      vru: vruAll[c],
      share: vruAll[c] ? (vruKA[c] / vruAll[c]) * 100 : 0,
    });
  }
  rows.sort((a, b) => b.ka - a.ka || b.vru - a.vru);
  return { rows: rows.slice(0, top), total: rows.length, outside };
}

/* --------------------------------------------------------------- overlays */

/** Ranked points as GeoJSON for the map overlay. */
export function pointsFor(rows, { lonKey = 'lon', latKey = 'lat' } = {}) {
  return {
    type: 'FeatureCollection',
    features: rows
      .filter((d) => Number.isFinite(d[lonKey]) && Number.isFinite(d[latKey]))
      .map((d, i) => ({
        type: 'Feature',
        properties: { rank: i + 1, label: d.label, ka: d.ka },
        geometry: { type: 'Point', coordinates: [d[lonKey], d[latKey]] },
      })),
  };
}

/** Join a per-county measure onto the county polygons for the choropleth. */
export function areasFor(countyGeo, rows, key = 'change') {
  if (!countyGeo) return { type: 'FeatureCollection', features: [] };
  const by = new Map(rows.map((d) => [String(d.label).toLowerCase(), d]));
  return {
    type: 'FeatureCollection',
    features: countyGeo.features.map((f) => {
      const d = by.get(String(f.properties.NAME || '').toLowerCase());
      return {
        ...f,
        properties: {
          NAME: f.properties.NAME,
          chg: d ? d[key] : 0,
          has: d ? 1 : 0,
          early: d?.early ?? null,
          late: d?.late ?? null,
        },
      };
    }).filter((f) => f.properties.has),
  };
}


/* --------------------------------------------------------- 4. wildlife

   Wildlife collisions are among the most common crash types on Montana's
   rural network and among the least severe -- a few tenths of a percent are
   fatal or suspected-serious, against roughly 3-4% of crashes overall.

   That ratio is why this ranks VOLUME and offers no severity option. Within
   a single county, ranking routes on wildlife K+A means ranking on counts of
   zero to two, so most of the order would be arbitrary. Severe wildlife
   crashes stay reachable through the Wildlife + Fatal-or-serious factor
   filters, which is the honest way to look at a handful of records -- as a
   set to inspect, not a leaderboard.

   Grouped by MDT's corridor identifier, which is the only road-grouping key
   the crash extract carries. The statewide build this tool descends from
   grouped by AADT-weighted road segment; the published extract has no traffic
   counts, so there is no exposure denominator and no segment geometry to
   group on. A corridor is coarser than a segment and its length is unknown,
   so the counts below are not comparable between corridors of different
   length -- see the caveat the report prints.

   `tiedAtCut` is still computed and returned: within one county ties at the
   cut are common, and the warning is drawn from the ranking on screen.
*/
export function rankWildlifeRoutes(facts, mask, { by = 'corridor', top = 10 } = {}) {
  const col = facts.cols[by];
  const flags = facts.cols.flags;
  const wildBit = FLAG_BIT.is_wildlife;
  if (!col || !flags || !wildBit) {
    return { rows: [], routes: 0, tiedAtCut: 0, cut: 0, total: 0, offRoute: 0 };
  }

  const kaBit = FLAG_BIT.is_ka;
  const { col: sev, byKey } = kabcoCodes(facts);
  const kCode = byKey.K;
  const aCode = byKey.A;

  const n = new Int32Array(col.values.length);
  const nK = new Int32Array(col.values.length);
  const nA = new Int32Array(col.values.length);
  const nKA = new Int32Array(col.values.length);
  // Wildlife crashes the crash table leaves uncoded -- the corridor field is
  // blank. They are in `total` but cannot be ranked, so the report says so
  // rather than quietly dropping them.
  let offRoute = 0;
  let total = 0;

  for (let r = 0; r < facts.n; r++) {
    if (!mask[r]) continue;
    if ((flags[r] & wildBit) === 0) continue;
    total++;
    const c = col.codes[r];
    if (!c) { offRoute++; continue; }
    n[c]++;
    const code = sev.codes[r];
    if (code === kCode) nK[c]++;
    else if (code === aCode) nA[c]++;
    if (flags[r] & kaBit) nKA[c]++;
  }

  const rows = [];
  for (let c = 1; c < col.values.length; c++) {
    if (!n[c]) continue;
    rows.push({ label: col.values[c], n: n[c], K: nK[c], A: nA[c], ka: nKA[c] });
  }
  // Severity breaks ties, so where two routes carry the same number of
  // wildlife crashes the one with worse outcomes ranks first rather than the
  // order falling out of dictionary order.
  rows.sort((a, b) => b.n - a.n
    || scoreOf({ K: b.K, A: b.A }) - scoreOf({ K: a.K, A: a.A }));

  const head = rows.slice(0, top);
  const cut = head.length ? head[head.length - 1].n : 0;
  const tiedAtCut = cut ? rows.filter((d) => d.n === cut).length : 0;

  return { rows: head, routes: rows.length, tiedAtCut, cut, total, offRoute };
}
