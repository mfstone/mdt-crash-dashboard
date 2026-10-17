/* ---------------------------------------------------------------------------
   facts.js — load the crash fact table and reshape it for fast crossfiltering.

   The bundle ships one Parquet file holding every crash in scope -- 26,991 rows
   for Missoula County, 219,480 for a statewide build, at 301 KB over the wire.
   It carries only the columns the UI reads: one the dashboard never decodes
   still costs every byte of transfer.

   That is small enough to filter in the browser, which is why there is no
   server and no pre-aggregated cube. A cube would mean deciding in advance
   which questions may be asked; the whole table answers any combination of
   facets from the same pass.

   Parquet arrives row-oriented. Filtering 219k rows on every slider nudge needs
   columns, and it needs them as typed arrays — so each column is transposed once
   at load into either a typed array (numerics) or a dictionary (small integer
   codes plus a values list). After that a filter pass is a tight loop over
   contiguous memory and the whole table re-filters in a few milliseconds.
--------------------------------------------------------------------------- */

import { parquetMetadataAsync, parquetRead } from 'hyparquet';
// Deep import, deliberately. The package index also imports hysnappy, fzstd,
// brotli and lz4, and hysnappy instantiates an embedded WebAssembly module
// EAGERLY at import time -- which `script-src 'self'` forbids, since compiling
// wasm needs 'wasm-unsafe-eval'. The page therefore died at boot in production
// while working perfectly against a dev server, because astro preview does not
// apply public/_headers and so serves no CSP at all.
//
// The alternative was adding 'wasm-unsafe-eval' to the CSP. Reaching past the
// index instead keeps `script-src 'self'` absolute, which is this project's
// whole security posture, and drops four decompressors the dashboard never
// uses. gzip.js imports one pure-JS huffman table and nothing else.
//
// This is why hyparquet-compressors is pinned exactly in package.json: a deep
// import is not part of the package's public API, so a version bump could move
// the file. It would fail at build time, not silently at runtime.
import { gunzip } from 'hyparquet-compressors/src/gzip.js';

/* The writer uses the GZIP page codec: smaller over the wire than zstd once the
   CDN re-compresses, and it does not depend on the CDN compressing
   application/octet-stream at all. hyparquet only has SNAPPY built in, so the
   codec is supplied here. */
const COMPRESSORS = {
  GZIP: (input, outputLength) => gunzip(input, new Uint8Array(outputLength)),
};

/* Columns pulled into memory. Everything the UI can filter or chart on; the
   rest of the file is never decoded. */
export const DICT_COLS = [
  'county', 'city', 'kabco', 'collision_type', 'weather',
  'surface', 'lighting', 'dow', 'corridor', 'road_system',
];

export const NUM_COLS = {
  year: Int16Array,
  month: Int8Array,
  hour: Int8Array,
  seg_id: Int32Array,
  hotspot_id: Int32Array,
  lon: Float32Array,
  lat: Float32Array,
  veh_count: Int16Array,
  person_count: Int16Array,
  person_K: Int16Array,
};

/* Six-way split of the clock, derived rather than shipped: the writer used to
   send a `time_bin` category alongside `hour`, which is the same information
   twice. Index with the hour. */
export const TIME_BINS = [
  'night (00-06)', 'night (00-06)', 'night (00-06)', 'night (00-06)',
  'night (00-06)', 'night (00-06)',
  'am peak (06-10)', 'am peak (06-10)', 'am peak (06-10)', 'am peak (06-10)',
  'midday (10-16)', 'midday (10-16)', 'midday (10-16)', 'midday (10-16)',
  'midday (10-16)', 'midday (10-16)',
  'pm peak (16-20)', 'pm peak (16-20)', 'pm peak (16-20)', 'pm peak (16-20)',
  'evening (20-24)', 'evening (20-24)', 'evening (20-24)', 'evening (20-24)',
];

/** The label the writer used to ship per row. */
export function timeBin(hour) {
  return hour === null || hour === undefined || hour < 0 ? null : TIME_BINS[hour];
}

/* Boolean columns, packed one bit each into a Uint32 per row. 15 flags x 219k
   rows is 3.3 MB as separate byte arrays and 878 KB packed, and a bitmask test
   is cheaper than fifteen array lookups in the filter loop. */
export const FLAG_COLS = [
  'is_ka', 'is_intersection', 'work_zone', 'is_vru', 'is_pedestrian',
  'is_bicycle', 'motorcycle_involved', 'heavy_truck_involved', 'hit_and_run',
  'alcohol_suspected', 'drug_suspected', 'distracted_driver',
  'fatigued_driver', 'unrestrained_occupant', 'occupant_ejected',
  // Appended, never inserted: the bit index is the position, so reordering
  // this list silently changes the meaning of every packed row.
  'is_wildlife',
];

export const FLAG_BIT = Object.fromEntries(FLAG_COLS.map((f, i) => [f, 1 << i]));

/**
 * Wrap an ArrayBuffer as the AsyncBuffer interface hyparquet expects.
 *
 * Deliberately NOT hyparquet's own asyncBufferFromUrl: that reads the file
 * through HTTP Range requests, and Cloudflare Pages does not honour Range — it
 * answers 200 with the whole body and no accept-ranges header. A ranged reader
 * works perfectly against a dev server and then fails only in production, which
 * is the same trap that breaks PMTiles on Pages.
 *
 * One plain GET is also simply the right shape here: the dashboard reads nearly
 * every column, so there is nothing to save by fetching pieces.
 */
function bufferOf(arrayBuffer) {
  return {
    byteLength: arrayBuffer.byteLength,
    async slice(start, end) { return arrayBuffer.slice(start, end); },
  };
}

/**
 * Fetch and reshape the fact table.
 * @param {string} url
 * @param {(frac:number, note:string)=>void} [onProgress]
 */
export async function loadFacts(url, onProgress = () => {}) {
  onProgress(0.05, 'downloading');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`facts.parquet: HTTP ${res.status}`);
  const file = bufferOf(await res.arrayBuffer());
  const metadata = await parquetMetadataAsync(file);
  const n = Number(metadata.num_rows);

  const present = new Set(
    metadata.row_groups[0].columns.map((c) => c.meta_data.path_in_schema.join('.')),
  );
  const dictCols = DICT_COLS.filter((c) => present.has(c));
  const numCols = Object.keys(NUM_COLS).filter((c) => present.has(c));
  const flagCols = FLAG_COLS.filter((c) => present.has(c));
  const columns = [...dictCols, ...numCols, ...flagCols];

  onProgress(0.15, `decoding ${n.toLocaleString()} crashes`);

  /** @type {any[][]} */
  let rows = [];
  await parquetRead({
    file, metadata, columns, compressors: COMPRESSORS,
    onComplete: (d) => { rows = d; },
  });

  onProgress(0.75, 'building indexes');

  const idx = Object.fromEntries(columns.map((c, i) => [c, i]));
  const cols = {};

  for (const name of numCols) {
    const Arr = NUM_COLS[name];
    const out = new Arr(n);
    const at = idx[name];
    for (let r = 0; r < n; r++) {
      const v = rows[r][at];
      out[r] = v === null || v === undefined ? (Arr === Float32Array ? NaN : -1) : v;
    }
    cols[name] = out;
  }

  for (const name of dictCols) {
    const at = idx[name];
    /** @type {Map<string, number>} */
    const lookup = new Map();
    const values = [];
    // Code 0 is reserved for null so a missing value is never confused with a
    // real category — city is null for the 54% of crashes outside any place.
    values.push(null);
    lookup.set(null, 0);
    const first = new Uint16Array(n);
    for (let r = 0; r < n; r++) {
      const raw = rows[r][at];
      const key = raw === null || raw === undefined || raw === '' ? null : String(raw);
      let code = lookup.get(key);
      if (code === undefined) {
        code = values.length;
        values.push(key);
        lookup.set(key, code);
      }
      first[r] = code;
    }
    // Narrow to a byte array when the domain allows it.
    const codes = values.length <= 256 ? Uint8Array.from(first) : first;
    cols[name] = { codes, values };
  }

  const flags = new Uint32Array(n);
  for (const name of flagCols) {
    const at = idx[name];
    const bit = FLAG_BIT[name];
    for (let r = 0; r < n; r++) if (rows[r][at]) flags[r] |= bit;
  }
  cols.flags = flags;

  rows = null; // let the row-oriented copy go before the first filter pass

  onProgress(1, 'ready');
  return { n, cols, dictCols, numCols, flagCols };
}

/** Distinct non-null values of a dictionary column, with counts, most common first. */
export function domain(facts, name) {
  const col = facts.cols[name];
  if (!col) return [];
  const counts = new Int32Array(col.values.length);
  for (let r = 0; r < facts.n; r++) counts[col.codes[r]]++;
  return col.values
    .map((v, code) => ({ value: v, code, n: counts[code] }))
    .filter((d) => d.value !== null && d.n > 0)
    .sort((a, b) => b.n - a.n);
}

/** Observed [min, max] of a numeric column, ignoring the -1 null marker. */
export function extent(facts, name) {
  const a = facts.cols[name];
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < facts.n; r++) {
    const v = a[r];
    if (v < 0 || Number.isNaN(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}
