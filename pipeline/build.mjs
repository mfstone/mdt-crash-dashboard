#!/usr/bin/env node
/**
 * Build the dashboard's data bundle from MDT's published workbooks.
 *
 *   npm run data
 *
 * Reads crashmap.config.json, fetches or reuses the workbooks, folds the three
 * tables together, and writes everything site/ loads at runtime. One command,
 * no Python, and nothing downloaded that has not changed.
 */
import { writeFileSync, copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetWriteFile } from 'hyparquet-writer';

import { load as loadConfig } from './config.mjs';
import { ensureSources, SOURCES, DEFAULT_BASE } from './fetch.mjs';
import { readCrashTable } from './read-crash-table.mjs';
import { foldVehicles, foldPersons } from './read-companions.mjs';
import { deriveColumns, BOOLEAN_COLUMNS } from './derive.mjs';
import { KABCO_ORDER, FACTORS, FLAG_BIT } from './coding.mjs';
import { SECTION_407, DISCLAIMER, DISCLOSURE_POLICY, FIELDS } from './notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, 'site/public/data');
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (s) => console.log(s);

const cfg = loadConfig(join(root, 'crashmap.config.json'));
log(`--> building ${cfg.title}`);
log(`    scope: ${cfg.county ? `${cfg.county} County` : 'statewide'}   tables: ${cfg.tables.join(', ')}`);

/* ---- 1. the workbooks --------------------------------------------------- */
log('\n[1/5] sources');
const paths = await ensureSources({
  source: cfg.source, want: cfg.tables, dataDir: join(root, 'data'), log,
});

/* ---- 2. the crash table ------------------------------------------------- */
log('\n[2/5] crash table');
const crashes = new Map();
for await (const r of readCrashTable(paths.crash, { county: cfg.county })) {
  crashes.set(r.id, r);
}
if (!crashes.size) {
  throw new Error(cfg.county
    ? `no crashes found for county "${cfg.county}". Check the spelling — MDT writes `
      + 'county names without the word "County", e.g. "Lewis And Clark".'
    : 'the crash table produced no rows.');
}
log(`    ${crashes.size.toLocaleString()} crashes  ${secs()}`);

/* ---- 3. the companions -------------------------------------------------- */
log('\n[3/5] companion tables');
let statewidePersons = null;
if (paths.vehicle) {
  const v = await foldVehicles(paths.vehicle, crashes);
  log(`    vehicles: ${v.matched.toLocaleString()} of ${v.scanned.toLocaleString()} rows  ${secs()}`);
}
if (paths.person) {
  const p = await foldPersons(paths.person, crashes);
  statewidePersons = p.statewide;
  log(`    persons:  ${p.matched.toLocaleString()} of ${p.scanned.toLocaleString()} rows  ${secs()}`);
}
/* Factors whose source table was not built are absent, not false. Shipping
   them as all-zero would give the reader a filter that silently matches
   nothing, which is worse than not offering it. */
const haveSources = new Set(['crash', ...(paths.vehicle ? ['vehicle'] : []),
                             ...(paths.person ? ['person'] : [])]);
const activeFactors = FACTORS.filter((f) =>
  f.source.split('+').every((s) => haveSources.has(s)));
if (activeFactors.length < FACTORS.length) {
  const missing = FACTORS.filter((f) => !activeFactors.includes(f)).map((f) => f.label);
  log(`    note: ${missing.length} factor(s) unavailable without those tables: ${missing.join(', ')}`);
}

/* ---- 4. derive ---------------------------------------------------------- */
log('\n[4/5] deriving');
const d = deriveColumns(crashes);
log(`    ${d.n.toLocaleString()} rows, ${d.hotspots.length} intersection clusters`
  + `  ${secs()}`);
if (d.dropped.outsideMontana || d.dropped.noCoordinate) {
  log(`    dropped: ${d.dropped.noCoordinate} with no coordinate, `
    + `${d.dropped.outsideMontana} outside Montana`);
}

/* ---- 5. write ----------------------------------------------------------- */
log('\n[5/5] writing bundle');
mkdirSync(OUT, { recursive: true });

/* The build OWNS this directory. Anything here it does not write is a leftover
   from a previous build with different inputs -- a lines.geojson from when the
   old pipeline had route geometry, a series.json it no longer emits -- and a
   stale file the dashboard still fetches is worse than a missing one: it looks
   like data. Removed rather than left, and named so the removal is visible. */
const PRODUCES = new Set([
  'facts.parquet', 'meta.json', 'summary.json', 'hotspots.json',
  'counties.geojson', 'places.geojson',
]);
for (const f of readdirSync(OUT)) {
  if (PRODUCES.has(f) || f.startsWith('.')) continue;
  rmSync(join(OUT, f), { recursive: true, force: true });
  log(`    removed stale ${f}`);
}

/* The dashboard rebuilds dictionaries and packs the booleans itself at load,
   so the Parquet carries plain columns. Writing pre-encoded structures here
   would ship something it ignores. */
const C = d.columns;
const str = (dict) => dict.codes.length === 0 ? []
  : Array.from(dict.codes, (c) => (c < 0 ? null : dict.values[c]));
const num = (a) => Array.from(a);

/* `nullable` is declared on every column rather than inferred.
 *
 * The writer auto-detects a column's type from its first 1000 values when none
 * is given, and infers REQUIRED when it sees no null among them. `city` is
 * "Missoula" for the first thousand rows of a Missoula build and null for the
 * 54% of crashes outside any incorporated place -- so inference declared it
 * required and the write threw thousands of rows later. Sample-based inference
 * is exactly the kind of thing that passes a test and fails on real data.
 *
 * Text columns can be null; the numeric and boolean columns are filled for
 * every row, and saying so lets the writer skip definition levels. */
const columnData = [
  { name: 'county', data: str(C.county), type: 'STRING', nullable: true },
  { name: 'city', data: str(C.city), type: 'STRING', nullable: true },
  { name: 'kabco', data: str(C.kabco), type: 'STRING', nullable: true },
  { name: 'collision_type', data: str(C.collision_type), type: 'STRING', nullable: true },
  { name: 'weather', data: str(C.weather), type: 'STRING', nullable: true },
  { name: 'surface', data: str(C.surface), type: 'STRING', nullable: true },
  { name: 'lighting', data: str(C.lighting), type: 'STRING', nullable: true },
  { name: 'dow', data: str(C.dow), type: 'STRING', nullable: true },
  { name: 'corridor', data: str(C.corridor), type: 'STRING', nullable: true },
  { name: 'year', data: num(C.year), type: 'INT32', nullable: false },
  { name: 'month', data: num(C.month), type: 'INT32', nullable: false },
  { name: 'hour', data: num(C.hour), type: 'INT32', nullable: false },
  { name: 'hotspot_id', data: num(C.hotspot_id), type: 'INT32', nullable: false },
  { name: 'lon', data: num(C.lon), type: 'DOUBLE', nullable: false },
  { name: 'lat', data: num(C.lat), type: 'DOUBLE', nullable: false },
  { name: 'veh_count', data: num(C.veh_count), type: 'INT32', nullable: false },
  { name: 'person_count', data: num(C.person_count), type: 'INT32', nullable: false },
  { name: 'person_K', data: num(C.person_K), type: 'INT32', nullable: false },
  ...BOOLEAN_COLUMNS.map((name) => ({
    name, data: Array.from(d.booleans[name], Boolean),
    type: 'BOOLEAN', nullable: false,
  })),
];
parquetWriteFile({ filename: join(OUT, 'facts.parquet'), columnData, compressed: true });

/* ---- aggregates --------------------------------------------------------- */
const rows = d.rows;
const count = (pred) => rows.reduce((a, r) => a + (pred(r) ? 1 : 0), 0);
const sev = Object.fromEntries(KABCO_ORDER.map((k) => [k, count((r) => r.kabco === k)]));
const years = rows.map((r) => r.year).filter(Boolean);
const yearMin = Math.min(...years), yearMax = Math.max(...years);
const bit = (k) => (r) => (r.flags & FLAG_BIT[k]) !== 0;

const scopeTotals = {
  total: d.n, ...sev, KA: sev.K + sev.A,
  vru: count(bit('is_vru')),
  ped: rows.reduce((a, r) => a + (r.ped > 0 ? 1 : 0), 0),
  bike: rows.reduce((a, r) => a + (r.bike > 0 ? 1 : 0), 0),
  alcohol: count(bit('alcohol_suspected')),
  intersection: count(bit('is_intersection')),
  wildlife: count(bit('is_wildlife')),
  work_zone: count(bit('work_zone')),
};
/* "statewide" is the builder's name for scope-wide totals; in a county bundle
   it is this county's. Kept because the dashboard reads that key. */
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
  statewide: scopeTotals,
  counties: [{ county: cfg.county ?? 'Montana', ...scopeTotals }],
  cities: [],
}, null, 1));

writeFileSync(join(OUT, 'hotspots.json'), JSON.stringify(d.hotspots));

for (const f of ['counties.geojson', 'places.geojson']) {
  copyFileSync(join(root, 'reference', f), join(OUT, f));
}

/* ---- meta --------------------------------------------------------------- */
/* The opening view.
 *
 * Derived from the crashes themselves rather than from a boundary polygon,
 * because what a reader wants to see first is where the data is -- a county
 * whose population sits in one corner should open on that corner, not on its
 * geometric centre with most of the frame empty.
 *
 * `focus` narrows further to the busiest place, which is how the previous
 * build opened on a county seat rather than a centroid. Both are published:
 * the dashboard prefers focus and falls back to the full extent. */
function extentOf(sel) {
  let w = Infinity, s2 = Infinity, e = -Infinity, n2 = -Infinity, k = 0;
  for (const r of rows) {
    if (r.lon == null || !sel(r)) continue;
    k++;
    if (r.lon < w) w = r.lon; if (r.lon > e) e = r.lon;
    if (r.lat < s2) s2 = r.lat; if (r.lat > n2) n2 = r.lat;
  }
  return k ? { count: k, bounds: [[+w.toFixed(5), +s2.toFixed(5)], [+e.toFixed(5), +n2.toFixed(5)]] } : null;
}
const scopeExtent = extentOf(() => true);
const places = new Map();
for (const r of rows) if (r.city) places.set(r.city, (places.get(r.city) || 0) + 1);
const topPlace = [...places.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
let focusExtent = topPlace ? extentOf((r) => r.city === topPlace) : null;
/* Padded, as the previous build padded it. The raw extent of one city's
   crashes opens the map hard against the edge of that city, so the roads
   leading into it -- which is where a reader looks next -- are off-screen.
   45% of the span on each side, matching what this dashboard shipped. */
if (focusExtent) {
  const [[w, s2], [e, n2]] = focusExtent.bounds;
  const padX = Math.max((e - w) * 0.45, 0.012);
  const padY = Math.max((n2 - s2) * 0.45, 0.012);
  focusExtent = { ...focusExtent, bounds: [
    [+(w - padX).toFixed(5), +(s2 - padY).toFixed(5)],
    [+(e + padX).toFixed(5), +(n2 + padY).toFixed(5)]] };
}

const personK = rows.reduce((a, r) => a + (r.person_K || 0), 0);
const personA = rows.reduce((a, r) => a + (r.person_A || 0), 0);
const sc = (statewidePersons && personK)
  ? {
      a_per_k_here: +(personA / personK).toFixed(2),
      a_per_k_statewide: +(statewidePersons.person_A / statewidePersons.person_K).toFixed(2),
      caveat: '',
    } : null;
if (sc) {
  sc.caveat = `${cfg.county ? `${cfg.county} County` : 'Montana'} records ${sc.a_per_k_here} `
    + `suspected-serious injuries per fatality against ${sc.a_per_k_statewide} statewide. `
    + 'Fatality is not a judgement call; suspected serious is, and it is not coded to one '
    + 'threshold across Montana. Any ranking that counts fatal-plus-serious is therefore '
    + 'partly measuring reporting practice.';
}

writeFileSync(join(OUT, 'meta.json'), JSON.stringify({
  schema_version: 2,
  generated: new Date().toISOString().slice(0, 10),
  builder: 'pipeline/build.mjs',
  title: cfg.title,
  data: { rows: d.n, year_min: yearMin, year_max: yearMax },
  /* What this build can draw. The dashboard asks before fetching, so a layer
     that cannot exist is absent rather than a 404 on every load. */
  layers: { lines: false, corridor_geometry: false, rate_screening: false },
  factors: activeFactors.map((f) => ({ key: f.key, label: f.label, source: f.source })),
  source: {
    agency: 'Montana Department of Transportation',
    datasets: cfg.tables.map((t) => SOURCES[t].file),
    rest_service: cfg.source.kind === 'url' ? (cfg.source.base || DEFAULT_BASE) : null,
    coordinate_recovery:
      'Coordinates are MDT\'s own, read directly from the Crash table\'s X and Y '
      + 'columns (EPSG:32100) and reprojected to WGS84. MDT added these columns to '
      + 'the published decade release in October 2026; earlier extracts required '
      + 'recovering them by a Crash ID join to the Vehicle and Person tables.',
  },
  scope: cfg.county ? {
    kind: 'county', name: cfg.county, label: `${cfg.county} County`,
    bounds: scopeExtent?.bounds ?? null,
    focus: focusExtent && topPlace
      ? { name: topPlace, crashes: focusExtent.count,
          center: [ +((focusExtent.bounds[0][0] + focusExtent.bounds[1][0]) / 2).toFixed(5),
                    +((focusExtent.bounds[0][1] + focusExtent.bounds[1][1]) / 2).toFixed(5) ],
          bounds: focusExtent.bounds }
      : null,
    note: 'This bundle covers one county. Intersection clusters are derived from '
        + 'crashes inside it, so the comparison is between this county\'s roads '
        + 'rather than against the state.',
    boundary: `Crashes are included by the county recorded on the report, so a route `
            + `is cut at the ${cfg.county} County line.`,
    severity_coding: sc,
  } : null,
  attribution: 'Analysis of MDT public crash data. Not an MDT product; not endorsed by MDT.',

  /* Carried verbatim from notices.mjs. The dashboard dereferences these without
     guarding -- meta.disclosure_policy.rule, meta.source.agency and the rest --
     so a bundle missing one does not degrade, it fails to boot. That is the
     right behaviour for a legal notice: a dashboard over crash data should not
     render while silently dropping the terms it is published under. */
  section_407: SECTION_407,
  disclaimer: DISCLAIMER,
  disclosure_policy: DISCLOSURE_POLICY,
  fields: FIELDS,
  caveats: [],
  hotspots: {
    count: d.hotspots.length,
    method: 'Intersection-related crashes snapped to a 40 m grid; cells with at '
          + 'least 3 crashes become clusters. Not surveyed intersections -- a '
          + 'cluster is a place where crashes coincide, which usually but not '
          + 'always means one junction.',
  },
}, null, 1));

log(`    wrote ${OUT.replace(root + '/', '')}  ${secs()}`);
log(`\n--> done. ${d.n.toLocaleString()} crashes, ${yearMin}-${yearMax}.`);
