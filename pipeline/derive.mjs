/* ---------------------------------------------------------------------------
   derive.mjs — turn folded crash records into the columns the dashboard reads.

   The browser crossfilters typed arrays, so this is where row-shaped records
   become column-shaped data: dictionaries for low-cardinality text, typed
   arrays for numbers, and one packed integer for the fourteen boolean factors.

   Nothing here reads MDT's vocabulary -- that is coding.mjs. This file knows
   the SHAPE the dashboard wants.
--------------------------------------------------------------------------- */
import proj4 from 'proj4';
import { kabcoOf, isIntersection, isWorkZone, isWildlife, FLAG_BIT } from './coding.mjs';

/* EPSG:32100 — NAD83 / Montana, Lambert Conformal Conic 2SP, metres. This is
   what MDT publishes in X Coordinate / Y Coordinate.
 *
 * Verified against 5,000 coordinates from the previous build: reprojecting its
 * EPSG:6514 columns through this implementation reproduces its stored
 * longitude and latitude to 0.00000 m, so the projection itself is exact.
 *
 * Reprojecting the PUBLISHED 32100 values instead lands about 0.34 m from
 * those stored values (1.05 m worst case). That is not an error: 32100 is
 * NAD83 (1986) and 6514 is NAD83(2011), and the two realizations really do
 * differ by about a metre in Montana. Correcting for it would need grid-shift
 * files, for a displacement far below the accuracy of an officer recording a
 * crash location. So the published values are used as published. */
const EPSG_32100 = '+proj=lcc +lat_0=44.25 +lon_0=-109.5 +lat_1=49 +lat_2=45 '
                 + '+x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs';
const toWGS84 = proj4(EPSG_32100, 'EPSG:4326');

/* Montana's bounding box, generously padded. A coordinate outside it is not
   plotted: the previous build found one crash at 5,272,055 / 2,454,050, which
   is neither a units error nor a sign error but simply wrong, and plotting it
   put a dot in the North Atlantic. Rejecting is better than drawing a lie. */
const MT_LON = [-116.6, -103.6];
const MT_LAT = [44.0, 49.3];

/** Day-of-week, normalised to the order a chart wants. MDT publishes "MON". */
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Build a dictionary column: distinct values plus an integer code per row. */
function dictionary(values) {
  const index = new Map();
  const list = [];
  const codes = new Int16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { codes[i] = -1; continue; }
    let c = index.get(v);
    if (c === undefined) { c = list.length; list.push(v); index.set(v, c); }
    codes[i] = c;
  }
  return { values: list, codes };
}

/**
 * Cluster intersection crashes into hotspots by snapping to a grid.
 *
 * Not DBSCAN or k-means. An intersection is a fixed physical place and the
 * question is "which crashes happened at the same one", so snapping to a grid
 * a little larger than a large intersection answers it directly, in one pass,
 * with no parameters to tune and no run-to-run variation. The cost is that a
 * cluster can straddle a cell boundary and split; the benefit is that the same
 * input always gives the same clusters, which matters when a reader is going
 * to cite a ranking.
 *
 * @param {number} cell metres; ~40 m is wider than most intersections
 */
export function clusterHotspots(rows, { cell = 40, minCrashes = 3 } = {}) {
  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.isIntersection || r.x == null) continue;
    const key = `${Math.round(r.x / cell)}:${Math.round(r.y / cell)}`;
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(i);
  }
  const ids = new Int32Array(rows.length).fill(-1);
  const clusters = [];
  for (const members of buckets.values()) {
    if (members.length < minCrashes) continue;
    const id = clusters.length;
    let sx = 0, sy = 0, k = 0, a = 0, total = 0;
    for (const i of members) {
      ids[i] = id;
      sx += rows[i].x; sy += rows[i].y; total++;
      if (rows[i].kabco === 'K') k++;
      else if (rows[i].kabco === 'A') a++;
    }
    const [lon, lat] = toWGS84.forward([sx / members.length, sy / members.length]);
    clusters.push({ id, lon: +lon.toFixed(6), lat: +lat.toFixed(6), total, K: k, A: a,
                    KA: k + a, city: rows[members[0]].city || null });
  }
  return { ids, clusters };
}

/**
 * Columnarise. Returns everything the bundle writer needs.
 * @param {Map<string, object>} crashes  as folded by the readers
 */
export function deriveColumns(crashes) {
  const rows = [];
  let outside = 0, noCoord = 0;

  for (const r of crashes.values()) {
    const kabco = kabcoOf(r.severity);
    let lon = null, lat = null;
    if (Number.isFinite(r.x) && Number.isFinite(r.y)) {
      const [lo, la] = toWGS84.forward([r.x, r.y]);
      if (lo >= MT_LON[0] && lo <= MT_LON[1] && la >= MT_LAT[0] && la <= MT_LAT[1]) {
        lon = +lo.toFixed(6); lat = +la.toFixed(6);
      } else outside++;
    } else noCoord++;

    let flags = r.flags || 0;
    if (kabco === 'K' || kabco === 'A') flags |= FLAG_BIT.is_ka;
    const inter = isIntersection(r.junction);
    if (inter) flags |= FLAG_BIT.is_intersection;
    if (isWorkZone(r.work_zone)) flags |= FLAG_BIT.work_zone;
    if (isWildlife(r.harmful_1, r.harmful_detail)) flags |= FLAG_BIT.is_wildlife;
    /* The collision-type half of the VRU union; the person-record half was
       OR-ed in during the person fold. Either alone undercounts. */
    if (/pedestrian|bicycl/i.test(r.collision_type || '')) flags |= FLAG_BIT.is_vru;

    const d = r.date;
    rows.push({
      kabco, flags, lon, lat, x: r.x, y: r.y,
      isIntersection: inter,
      county: r.county, city: r.city, corridor: r.corridor,
      collision_type: r.collision_type, weather: r.weather,
      surface: r.surface, lighting: r.lighting,
      dow: r.dow ? r.dow.toUpperCase().slice(0, 3) : null,
      year: d ? d.getUTCFullYear() : null,
      month: d ? d.getUTCMonth() + 1 : null,
      hour: r.minutes == null ? -1 : Math.floor(r.minutes / 60),
      veh_count: r.veh_count || 0,
      person_count: r.person_count || 0,
      person_K: r.person_K || 0,
      /* Not a bundle column: the only consumer is the A-per-K severity-coding
         caveat in meta.json. It still has to be carried here, because the
         builder sums these rows and not the folded originals. */
      person_A: r.person_A || 0,
      ped: r.ped || 0,
      bike: r.bike || 0,
    });
  }

  const hot = clusterHotspots(rows);
  const col = (k) => rows.map((r) => r[k]);

  return {
    n: rows.length,
    rows,
    dropped: { outsideMontana: outside, noCoordinate: noCoord },
    hotspots: hot.clusters,
    columns: {
      /* Dictionary columns: low-cardinality text the UI filters or charts on. */
      county: dictionary(col('county')),
      city: dictionary(col('city')),
      kabco: dictionary(col('kabco')),
      collision_type: dictionary(col('collision_type')),
      weather: dictionary(col('weather')),
      surface: dictionary(col('surface')),
      lighting: dictionary(col('lighting')),
      dow: dictionary(col('dow')),
      /* MDT's "Corridor Name" column. Despite the header it holds an opaque
         identifier -- C000007, C008128 -- not a name: all 1,416 distinct
         values in a sample county match /^C\d+$/, and the published extract
         ships no lookup table to resolve them. Carried because it is still
         the only road-grouping key in the file and the wildlife report ranks
         on it; named for what it is, so nothing downstream prints it as
         though it were "US 93". */
      corridor: dictionary(col('corridor')),
      /* Numeric columns, typed to the smallest that holds the range. */
      year: Int16Array.from(col('year').map((v) => v ?? 0)),
      month: Int8Array.from(col('month').map((v) => v ?? 0)),
      hour: Int8Array.from(col('hour')),
      hotspot_id: hot.ids,
      /* NaN, not 0, for a crash whose coordinate was missing or fell outside
         Montana. 0 is a real place -- null island, in the Gulf of Guinea --
         and it is inside no filter's idea of "invalid", so a zero-filled row
         gets drawn as a crash point and dragged into every bounding box that
         scans these columns. Every consumer already tests isFinite/isNaN,
         because NaN is the sentinel they were written against. */
      lon: Float32Array.from(col('lon').map((v) => v ?? NaN)),
      lat: Float32Array.from(col('lat').map((v) => v ?? NaN)),
      veh_count: Int16Array.from(col('veh_count')),
      person_count: Int16Array.from(col('person_count')),
      person_K: Int16Array.from(col('person_K')),
    },
    /* The sixteen boolean columns the bundle ships, UNPACKED.
     *
     * The pipeline carries these as bits in one integer because that is the
     * cheap way to OR them together across three tables. The dashboard wants
     * them as named columns and packs them itself at load, against its own bit
     * order -- so writing a packed integer here would ship a column the app
     * ignores while every filter reads zero.
     *
     * Named rather than positional on purpose. The app's list carries the
     * warning "appended, never inserted: the bit index is the position", and
     * matching by name means the two orders can never silently disagree. */
    booleans: booleanColumns(rows),
  };
}

/** The flag columns the dashboard reads, by name, as arrays of 0/1. */
export const BOOLEAN_COLUMNS = [
  'is_ka', 'is_intersection', 'work_zone', 'is_vru', 'is_pedestrian',
  'is_bicycle', 'motorcycle_involved', 'heavy_truck_involved', 'hit_and_run',
  'alcohol_suspected', 'drug_suspected', 'distracted_driver',
  'fatigued_driver', 'unrestrained_occupant', 'occupant_ejected', 'is_wildlife',
];

function booleanColumns(rows) {
  const out = {};
  for (const name of BOOLEAN_COLUMNS) out[name] = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].flags;
    for (const name of BOOLEAN_COLUMNS) {
      const bit = FLAG_BIT[name];
      if (bit && (f & bit)) out[name][i] = 1;
    }
    /* These two have no bit of their own in the pipeline -- they are counts of
       person records, folded in from the Person table -- so they are set from
       the counts rather than from the packed integer. */
    if (rows[i].ped > 0) out.is_pedestrian[i] = 1;
    if (rows[i].bike > 0) out.is_bicycle[i] = 1;
  }
  return out;
}

export { toWGS84, DOW };
