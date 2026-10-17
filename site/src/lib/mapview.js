/* ---------------------------------------------------------------------------
   mapview.js — MapLibre setup, basemaps, and the filtered data layers.

   Two basemaps, switchable at runtime:

   - "streets" (default) — OpenFreeMap's OpenStreetMap vector tiles, positron
     for light and dark for dark. No API key, no registration, no request cap,
     commercial use explicitly allowed, MIT. This is the one external origin the
     app talks to, and it is here because county outlines alone are not enough
     to orient by once a filter thins the crash network out: you need roads,
     water and town structure to know where you are looking.

     Deliberately NOT tile.openstreetmap.org — the OSMF tile policy carries no
     SLA and says access "may be withdrawn at any point" for commercial
     services. Pointing a business-branded dashboard at a volunteer-funded tile
     server is an abuse of it.

   - "minimal" — the project's own county outlines and place labels, 45 KB
     gzipped. Nothing leaves the origin, so the page still works under a CSP
     with no external hosts and keeps rendering if OpenFreeMap is unreachable.

   Two data layers sit on top of whichever basemap is active:

   - lines: the 25,762 crash-bearing route segments, coloured and widened by the
     count that survives the current filter. Counts are not baked into the
     geometry; they are joined client-side on seg_id with setFeatureState, so one
     geometry serves every filter combination.
   - points: individual crashes, coloured by KABCO severity, from z7.5.
--------------------------------------------------------------------------- */

// maplibre-gl 6 is ESM-only and dropped its default export; the namespace
// import keeps every maplibregl.X call site working unchanged.
import * as maplibregl from 'maplibre-gl';

/* v6 no longer inlines its web worker. It must be served as its own file, and
   `?url` makes Vite emit it into _astro/ and hand back the hashed path -- which
   keeps it same-origin, so `worker-src 'self'` covers it and no CSP change is
   needed. Left unset, v6 fails at startup with "Worker failed to load". */
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

export const MT_BOUNDS = [[-116.4, 44.2], [-103.7, 49.1]];

/* The view bounds are a property of the BUNDLE, not of this file. A statewide
   build uses Montana; a county build ships its own in meta.scope.bounds. Set
   once at boot, before the map is created, so nothing here has to know which
   geography it is showing.

   The outer box is the opening box grown by a margin -- the limit on how far
   the reader may pan, not where they start. Montana keeps its hand-tuned one
   because it was chosen against the state's shape; a derived scope gets a
   proportional margin. */
let viewBounds = MT_BOUNDS;
let maxBounds = null;   // null = derive from viewBounds

export function setViewBounds(bounds, { max = null } = {}) {
  if (Array.isArray(bounds) && bounds.length === 2) viewBounds = bounds;
  maxBounds = max;
}

export function getViewBounds() { return viewBounds; }

function outerBounds() {
  if (maxBounds) return maxBounds;
  const [[w, s], [e, n]] = viewBounds;
  // A quarter of the span on each side: enough to see what is next door
  // without letting the subject scroll off the screen entirely.
  const mx = (e - w) * 0.25, my = (n - s) * 0.25;
  return [[w - mx, s - my], [e + mx, n + my]];
}

/* Panning limit: Montana plus roughly a degree of context, so border towns stay
   legible without the map wandering into Alberta or Wyoming. It constrains the
   map *centre*, not the viewport — see clampToMontana(). */
export const MT_MAX_BOUNDS = [[-117.2, 43.7], [-102.9, 49.7]];

/* OpenFreeMap's required attribution ("OpenFreeMap © OpenMapTiles Data from
   OpenStreetMap") arrives on its own: it is declared in the TileJSON at
   /planet, which MapLibre fetches for the vector source and folds into the
   attribution control. Passing it as customAttribution as well prints it twice.
   Only the crash-data credit is added here.

   The credit links to MDT's own publications page, so a reader who wants the
   underlying workbooks can reach them from the map rather than from the About
   sheet. target="_blank" matters because the dashboard is embeddable (see
   frame-ancestors in public/_headers) — without it the link would navigate
   inside the host page's iframe. No CSP change is needed: a navigation is not
   a fetch, and `form-action 'none'` governs form submission only. */
/* Resolved rather than hardcoded: see styleFor. */
import { basemap as basemapDef } from './basemaps.js';

export const MDT_SOURCE_URL = 'https://www.mdt.mt.gov/publications/datastats.aspx';

export const MDT_ATTRIBUTION =
  `Crash data: <a href="${MDT_SOURCE_URL}" target="_blank" `
  + 'rel="noopener noreferrer">MDT</a>';


const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function kabcoColors() {
  return {
    K: css('--kabco-K'), A: css('--kabco-A'), B: css('--kabco-B'),
    C: css('--kabco-C'), O: css('--kabco-O'), U: css('--kabco-U'),
  };
}

export function isDark() {
  const stamp = document.documentElement.getAttribute('data-theme');
  if (stamp) return stamp === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

/** The self-hosted fallback style: county fill + outline, no external requests. */
function minimalStyle(dataBase) {
  return {
    version: 8,
    // No glyphs endpoint, so no symbol layers: MapLibre renders text from SDF
    // glyph PBFs fetched from a glyph server and has no built-in font. Place
    // names are HTML markers in this mode (see addPlaceLabels).
    sources: {
      counties: { type: 'geojson', data: `${dataBase}/counties.geojson` },
    },
    layers: [
      { id: 'ground', type: 'background', paint: { 'background-color': css('--map-ground') } },
      {
        id: 'county-fill', type: 'fill', source: 'counties',
        paint: { 'fill-color': css('--map-county'), 'fill-opacity': 0.55 },
      },
      {
        id: 'county-line', type: 'line', source: 'counties',
        paint: {
          'line-color': css('--border-strong'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 1],
          'line-opacity': 0.75,
        },
      },
    ],
  };
}

/**
 * The MapLibre style for a configured basemap id.
 *
 * The id comes from crashmap.config.json and is resolved through basemaps.js,
 * which is also what public/_headers was written from -- so a basemap the
 * config can name is a basemap the policy already permits. Resolving it here
 * rather than hardcoding a URL is what keeps those two in step.
 */
export function styleFor(id, dataBase) {
  const b = basemapDef(id);
  if (b.kind === 'none') return minimalStyle(dataBase);
  /* Every shipped entry is vector or none. A raster entry would need its own
     style document built here; basemaps.js explains why none is listed. */
  return (isDark() && b.styleDark) ? b.styleDark : b.style;
}

/**
 * Lift every text label in the basemap above the crash data.
 *
 * Inserting the data below the trailing label block is not enough on its own,
 * because the two styles order their labels differently. In positron every
 * label sits in that trailing block; in dark only the place names do —
 * `highway_name_other` and `highway_name_motorway` are at indices 32-33 and
 * `water_name` at 8, interleaved among the road geometry, so street and river
 * names would stay buried under the crash network exactly where they are most
 * useful.
 *
 * moveLayer with no target moves a layer to the top, so walking the text layers
 * in their existing order reassembles them above the data with their relative
 * stacking intact. Icon-only symbol layers (the one-way arrows) are left where
 * the style put them: they are basemap decoration, not orientation.
 */
export function raiseLabels(map) {
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type !== 'symbol') continue;
    if (!l.layout || l.layout['text-field'] === undefined) continue;
    try {
      map.moveLayer(l.id);
    } catch {
      /* layer vanished mid-restyle; the next addDataLayers pass will redo it */
    }
  }
}

/**
 * Id of the first layer in the basemap's trailing block of label layers.
 *
 * Data layers are inserted before it, which puts them above every fill, line
 * and raster in the basemap but below its place labels — so the crash network
 * never paints over the names the reader is orienting by.
 *
 * Deliberately NOT "the first symbol layer in the style". Label layers are not
 * all at the top: positron's first symbol layer is `waterway_line_label` at
 * index 36 with nothing but labels after it, but dark's is `water_name` at
 * index 8, with 24 geometry layers after it — every road and building. Taking
 * the first symbol layer therefore buried the whole crash network under the
 * road network in dark mode only.
 *
 * Scanning back from the end for the last non-symbol layer finds the contiguous
 * label block that both styles do share, whatever its depth.
 */
function labelBlockId(map) {
  const layers = map.getStyle()?.layers ?? [];
  let i = layers.length - 1;
  while (i >= 0 && layers[i].type === 'symbol') i -= 1;
  return layers[i + 1]?.id;   // undefined when the style ends in geometry
}

/* -------------------------------------------------------------- data layers */

const lineColor = () => ([
  'case',
  ['==', ['coalesce', ['feature-state', 't'], 0], 0], css('--grid'),
  ['interpolate', ['linear'], ['coalesce', ['feature-state', 'ka'], 0],
    0, css('--seq-2'), 1, css('--seq-3'), 4, css('--seq-4'), 12, css('--seq-5')],
]);

/* The width breakpoints. The legend draws from these, so they live in one
   place and cannot drift from what the map actually renders. */
export const WIDTH_STOPS = [1, 25, 150];
export const WIDTH_PX = { 5: [0.7, 2.2, 3.4], 12: [2, 6, 11] };

const lineWidth = () => ([
  'interpolate', ['linear'], ['zoom'],
  5, ['case', ['==', ['coalesce', ['feature-state', 't'], 0], 0], 0.3,
      ['interpolate', ['linear'], ['coalesce', ['feature-state', 't'], 0],
        WIDTH_STOPS[0], WIDTH_PX[5][0], WIDTH_STOPS[1], WIDTH_PX[5][1],
        WIDTH_STOPS[2], WIDTH_PX[5][2]]],
  12, ['case', ['==', ['coalesce', ['feature-state', 't'], 0], 0], 0.8,
       ['interpolate', ['linear'], ['coalesce', ['feature-state', 't'], 0],
         WIDTH_STOPS[0], WIDTH_PX[12][0], WIDTH_STOPS[1], WIDTH_PX[12][1],
         WIDTH_STOPS[2], WIDTH_PX[12][2]]],
]);

/* The K+A ramp stops the legend swatches mirror. */
export const KA_STOPS = [0, 1, 4, 12];
export const KA_TOKENS = ['--seq-2', '--seq-3', '--seq-4', '--seq-5'];

/* Five classes for the crash-rate map. */
export const RATE_TOKENS = ['--rate-1', '--rate-2', '--rate-3', '--rate-4', '--rate-5'];

/* Paint for the rate map.
 *
 * Width is deliberately flat. In count mode width carries the magnitude, but a
 * rate is already normalized by exposure — widening a high-rate road because it
 * is busy would put the very bias the metric removes straight back in. Class
 * comes from feature-state `rc`; -1 means the segment has no usable traffic
 * count or falls below the stability gate, and draws as a faint hairline so the
 * network stays legible without implying a value. */
const rateColor = () => ([
  'match', ['coalesce', ['feature-state', 'rc'], -1],
  0, css('--rate-1'), 1, css('--rate-2'), 2, css('--rate-3'),
  3, css('--rate-4'), 4, css('--rate-5'),
  css('--rate-none'),
]);

const rateWidth = () => ([
  'interpolate', ['linear'], ['zoom'],
  5, ['case', ['<', ['coalesce', ['feature-state', 'rc'], -1], 0], 0.4, 2.4],
  12, ['case', ['<', ['coalesce', ['feature-state', 'rc'], -1], 0], 0.8, 7],
]);

/* Only ~2,000 of 25,762 segments carry a usable traffic count, so the rated
   network is a thin tracery over a much larger grey one. The unrated lines are
   pushed well back so the signal is not lost in the context. */
const rateOpacity = () => ([
  'case', ['<', ['coalesce', ['feature-state', 'rc'], -1], 0], 0.22, 0.95,
]);

const pointColor = () => {
  const s = kabcoColors();
  return ['match', ['get', 's'],
    'K', s.K, 'A', s.A, 'B', s.B, 'C', s.C, 'O', s.O, s.U];
};

/**
 * Add the crash sources and layers. Called on first load and again after every
 * setStyle, which discards everything the new style does not itself declare.
 */
export function addDataLayers(map) {
  const before = labelBlockId(map);

  if (!map.getSource('lines')) {
    map.addSource('lines', { type: 'geojson', data: emptyFC(), promoteId: 'i' });
  }
  if (!map.getSource('points')) {
    map.addSource('points', { type: 'geojson', data: emptyFC() });
  }
  // Report overlays. County polygons are carried here rather than in the
  // minimal style so the choropleth works on either basemap.
  if (!map.getSource('report-areas')) {
    map.addSource('report-areas', { type: 'geojson', data: emptyFC() });
  }
  if (!map.getSource('report-points')) {
    map.addSource('report-points', { type: 'geojson', data: emptyFC() });
  }
  if (!map.getSource('lrtp')) {
    map.addSource('lrtp', { type: 'geojson', data: lrtpData || emptyFC() });
  }

  // Choropleth first, so it sits beneath the crash network: the county shading
  // is context for the lines, not a replacement for them.
  if (!map.getLayer('report-areas')) {
    map.addLayer({
      id: 'report-areas', type: 'fill', source: 'report-areas',
      paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'chg'],
          -12, css('--div-cool-2'), -3, css('--div-cool-1'),
          0, css('--div-mid'),
          3, css('--div-warm-1'), 12, css('--div-warm-2')],
        'fill-opacity': 0.55,
      },
    }, before);
    map.addLayer({
      id: 'report-areas-line', type: 'line', source: 'report-areas',
      paint: { 'line-color': css('--border-strong'), 'line-width': 0.8 },
    }, before);
  }

  if (!map.getLayer('lines')) {
    map.addLayer({
      id: 'lines', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': lineColor(),
        'line-width': lineWidth(),
        'line-opacity': ['case',
          ['==', ['coalesce', ['feature-state', 't'], 0], 0], 0.45, 0.9],
      },
    }, before);
  }

  if (!map.getLayer('points')) {
    /* Planned projects sit ABOVE the crash network and BELOW the crash points:
       over the lines because an overlay hidden under 2,166 segments is not an
       overlay, under the points because those stay the clickable thing.

       One hue for all of it, and dash for status. Splitting by category would
       want a second hue, and the only two the palette has left -- PMS 124 and
       465 -- are dE 11.1 apart, under the 15 floor. Navy was the other option
       and it is what the crash lines already use. So: gold means "planned",
       solid means funded, dashed means proposed. */
    map.addLayer({
      id: 'lrtp-line', type: 'line', source: 'lrtp',
      filter: lrtpFilter('LineString'),
      layout: { visibility: lrtpVisible ? 'visible' : 'none',
                'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'committed'], 1],
          css('--plan-committed'), css('--plan')],
        // Committed runs half again as wide. Width is the third channel, and
        // the one that survives being squinted at.
        //
        // The case goes in each STOP, not around the interpolate: MapLibre
        // allows ['zoom'] only as the direct input of a top-level interpolate
        // or step, so wrapping one in a multiply makes the whole layer invalid
        // and it silently stops drawing.
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, ['case', ['==', ['get', 'committed'], 1], 2.1, 1.4],
          16, ['case', ['==', ['get', 'committed'], 1], 5.1, 3.4]],
        'line-opacity': 0.9,
        'line-dasharray': ['case', ['==', ['get', 'committed'], 1],
          ['literal', [1]], ['literal', [2.2, 1.6]]],
      },
    }, before);
    map.addLayer({
      id: 'crash-heat', type: 'heatmap', source: 'points',
      layout: { visibility: pointMode === 'heat' ? 'visible' : 'none' },
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 11, 1.1, 16, 2.2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 11, 16, 16, 38],
        'heatmap-color': heatColor(),
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.85, 16, 0.7],
      },
    }, before);
    map.addLayer({
      id: 'points', type: 'circle', source: 'points', minzoom: 7.5,
      paint: {
        'circle-color': pointColor(),
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7.5, 1.6, 11, 3.2, 15, 6],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0.5, 11, 0.85],
        // A surface-coloured ring keeps overlapping points legible; it fades in
        // only where the points are big enough for it to read.
        'circle-stroke-color': css('--surface-1'),
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0, 13, 1.2],
      },
    }, before);
  }

  // Ranked corridors: the same line geometry, filtered to the ids a report has
  // flagged and drawn thick on top. Highlighting by filter rather than by a
  // second copy of the geometry keeps one source of truth for the network.
  if (!map.getLayer('report-corridors')) {
    map.addLayer({
      id: 'report-corridors', type: 'line', source: 'lines',
      filter: ['in', ['get', 'c'], ['literal', []]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': css('--report-mark'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 7],
        'line-opacity': 0.95,
      },
    }, before);
  }

  // Ranked locations for the intersection and city reports. Drawn above the
  // crash points so a highlighted location is never buried under them.
  if (!map.getLayer('report-points')) {
    map.addLayer({
      id: 'report-points', type: 'circle', source: 'report-points',
      paint: {
        'circle-color': css('--report-mark'),
        'circle-radius': ['interpolate', ['linear'], ['get', 'rank'],
          1, 11, 10, 7, 25, 5],
        'circle-opacity': 0.9,
        'circle-stroke-color': css('--surface-1'),
        'circle-stroke-width': 2,
      },
    }, before);
    map.addLayer({
      id: 'report-points-halo', type: 'circle', source: 'report-points',
      filter: ['==', ['get', 'rank'], 1],
      paint: {
        'circle-color': 'transparent',
        'circle-radius': 17,
        'circle-stroke-color': css('--report-mark'),
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.55,
      },
    }, before);
  }

  if (!map.getLayer('lrtp-point')) {
    map.addLayer({
      id: 'lrtp-point', type: 'circle', source: 'lrtp',
      filter: lrtpFilter('Point'),
      layout: { visibility: lrtpVisible ? 'visible' : 'none' },
      paint: {
        'circle-color': ['case', ['==', ['get', 'committed'], 1],
          css('--plan-committed'), css('--plan')],
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          10, ['case', ['==', ['get', 'committed'], 1], 3.6, 2.6],
          16, ['case', ['==', ['get', 'committed'], 1], 8.4, 6]],
        'circle-stroke-color': css('--surface-1'),
        'circle-stroke-width': 1.2,
        'circle-opacity': 0.95,
      },
    }, before);
  }

  raiseLabels(map);
}

/* ------------------------------------------------------------ crash heat */

/* Density of the crashes matching the current filter -- the SAME features the
   point layer draws, so the two views cannot disagree.

   Weight is flat. This is dot density, not a severity surface: weighting a
   fatal crash heavier would make the hot spots mean something the legend does
   not say, and the severity filter already exists for that question.
   
   PMS 124 at the cool end, PMS 465 at the hot end, with density carried by
   ALPHA. 465 is the darker of the two, so a straight colour ramp would climb
   correctly on the pale basemap and run backwards on the dark one; rising
   opacity makes a single ramp ascend against both. Deliberately NOT the
   red-orange a heatmap usually reaches for: on a crash map those are
   severity's colours and a hot spot would read as a fatality, not a count. */
function heatColor() {
  const t = (n) => css(`--heat-${n}`);
  return ['interpolate', ['linear'], ['heatmap-density'],
    0, 'rgba(0,0,0,0)',
    0.15, t(1), 0.38, t(2), 0.58, t(3), 0.78, t(4), 1, t(5)];
}

let pointMode = 'points';

/** 'points' or 'heat'. The other view is hidden, not removed. */
export function setPointMode(map, mode) {
  pointMode = mode === 'heat' ? 'heat' : 'points';
  if (map.getLayer('points')) {
    map.setLayoutProperty('points', 'visibility',
      pointMode === 'heat' ? 'none' : 'visible');
  }
  if (map.getLayer('crash-heat')) {
    map.setLayoutProperty('crash-heat', 'visibility',
      pointMode === 'heat' ? 'visible' : 'none');
  }
  // The blue network competes with the heat surface for the same pixels, so it
  // steps back rather than being switched off -- the roads are what the heat is
  // *on*, and removing them leaves density floating over nothing.
  if (map.getLayer('lines')) {
    map.setPaintProperty('lines', 'line-opacity', pointMode === 'heat' ? 0.35 : 1);
  }
}

export function getPointMode() { return pointMode; }

/* ------------------------------------------------- planned projects (LRTP) */

/* Cached like lineData, and for the same reason: setStyle discards every
   source the new style does not declare, so a basemap or theme swap has to put
   the data and the visibility back. */
let lrtpData = null;
let lrtpVisible = false;
let lrtpShow = { committed: true, proposed: true };

/* The geometry-type test has to survive: each layer draws one kind from a
   shared source, so the status filter is ANDed with it rather than replacing
   it. With neither box ticked the expression is a literal false, which empties
   the layer without a second visibility flag to keep in sync. */
function lrtpFilter(geomType) {
  const { committed, proposed } = lrtpShow;
  const geom = ['==', ['geometry-type'], geomType];
  if (committed && proposed) return geom;
  if (!committed && !proposed) return ['all', geom, false];
  return ['all', geom, ['==', ['get', 'committed'], committed ? 1 : 0]];
}

export function setLrtpShow(map, next) {
  lrtpShow = { ...lrtpShow, ...next };
  if (map.getLayer('lrtp-line')) map.setFilter('lrtp-line', lrtpFilter('LineString'));
  if (map.getLayer('lrtp-point')) map.setFilter('lrtp-point', lrtpFilter('Point'));
}

export function getLrtpShow() { return { ...lrtpShow }; }

export function setLrtpData(map, fc) {
  lrtpData = fc;
  if (map.getSource('lrtp')) map.getSource('lrtp').setData(fc);
}

export function setLrtpVisible(map, on) {
  lrtpVisible = Boolean(on);
  for (const id of ('lrtp-line lrtp-point').split(' ')) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', lrtpVisible ? 'visible' : 'none');
    }
  }
}

export function lrtpIsVisible() { return lrtpVisible; }

export function reapplyLrtp(map) {
  if (lrtpData && map.getSource('lrtp')) map.getSource('lrtp').setData(lrtpData);
  setLrtpVisible(map, lrtpVisible);
  setLrtpShow(map, lrtpShow);
}

/** Show or hide the report overlays. */
export function setReportLayers(map, { areas = false, points = false,
                                       corridors = false } = {}) {
  for (const [id, on] of [
    ['report-areas', areas], ['report-areas-line', areas],
    ['report-points', points], ['report-points-halo', points],
    ['report-corridors', corridors],
  ]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }
}

/** Highlight a set of corridor ids on the line layer. */
export function setReportCorridors(map, ids, key = 'c') {
  if (!map.getLayer('report-corridors')) return;
  map.setFilter('report-corridors', ['in', ['get', key], ['literal', ids ?? []]]);
}

export function setReportData(map, { areas, points }) {
  if (areas && map.getSource('report-areas')) map.getSource('report-areas').setData(areas);
  if (points && map.getSource('report-points')) map.getSource('report-points').setData(points);
}

/** Dim the crash network so a report overlay reads above it. */
export function dimData(map, dim) {
  if (map.getLayer('lines')) {
    // Undimming has to restore the CURRENT mode's opacity, not the count
    // mode's. dimData runs after setLineMode, so writing the count expression
    // unconditionally overwrote the rate ramp's -- which pushes unrated
    // segments back to 0.22 so the rated tracery reads above them. That was
    // invisible while rate mode carried no `t` state (everything coalesced to
    // 0 and went uniformly faint); the moment crash counts were restored to
    // that mode it would have lit every unrated segment with a crash.
    map.setPaintProperty('lines', 'line-opacity', dim
      ? 0.25
      : (currentLineMode === 'rate' ? rateOpacity() : ([
        'case', ['==', ['coalesce', ['feature-state', 't'], 0], 0], 0.45, 0.9,
      ])));
  }
  if (map.getLayer('points')) {
    map.setPaintProperty('points', 'circle-opacity', dim
      ? 0.18
      : ['interpolate', ['linear'], ['zoom'], 7.5, 0.5, 11, 0.85]);
  }
}

/* -------------------------------------------------------------------- setup */

export async function createMap(container, {
  dataBase, onPick, basemap = 'streets',
}) {
  const map = new maplibregl.Map({
    container,
    style: styleFor(basemap, dataBase),
    bounds: viewBounds,
    fitBoundsOptions: { padding: 24 },
    attributionControl: false,
    maxZoom: 17,
    minZoom: 4,
    dragRotate: false,
    pitchWithRotate: false,
    /* Default is [4096, 4096], which a wide high-DPI display passes easily --
       a 2560 px window at devicePixelRatio 2 wants 5120. Over the limit
       MapLibre does not refuse the canvas, it quietly drops the pixel ratio,
       so the map renders soft on exactly the screens most likely to be
       reading it. 8192 is the common MAX_TEXTURE_SIZE floor on anything
       current, and MapLibre clamps to the GPU's real limit anyway, so this
       cannot ask for more than the hardware has. */
    maxCanvasSize: [8192, 8192],
  });
  /* OpenFreeMap's style asks for an icon its own sprite does not contain:
     place_town / place_city / place_city_large set icon-image "circle-11"
     below zoom 9, and the sprite (which loads fine, 200 on both files) has no
     such image. MapLibre then warns on every load, because this map opens at
     about z5.3.

     Supplying a 1x1 transparent image answers the request without drawing
     anything, which is deliberate rather than merely quiet: this map already
     uses circles for crash points, and a ring of basemap dots beside every
     city name is exactly the kind of mark a reader could mistake for data.
     The label itself still renders, which is the part that orients anyone.

     Registered before the style finishes loading, since the event fires once
     per missing id and will not fire again for one already handled. */
  const blank = (id) => {
    if (!map.hasImage(id)) {
      map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    }
  };
  /* v6 routes this through a resolver first and only fires styleimagemissing
     once the resolver has declined -- its own docs say a listener "cannot
     resolve the missing image for the current request". Registering only the
     event, as v5 required, left the warning on every load. Both are kept: the
     resolver answers the current request, the listener covers anything that
     reaches the event by another path. */
  if (typeof map.setMissingStyleImageResolver === 'function') {
    map.setMissingStyleImageResolver(blank);
  }
  map.on('styleimagemissing', (e) => blank(e.id));

  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: MDT_ATTRIBUTION,
  }), 'bottom-right');

  await new Promise((res) => map.on('load', res));
  addDataLayers(map);

  // Read-only handles for the smoke tests, which otherwise have no way to
  // assert either the camera (the URL hash is written on moveend and so can lag
  // the map) or the decoded line properties (lines.geojson ships them coded, so
  // a decode regression would be invisible from the DOM alone).
  window.__map = map;
  window.__segExposure = segmentExposure;

  if (onPick) {
    wirePicking(map, onPick);
  }

  return map;
}

/**
 * Keep the view on Montana without fighting the viewport's shape.
 *
 * MapLibre's `maxBounds` constrains the *viewport*, which cannot work here.
 * Montana is wide and short — 12.7° by 4.9° — and a phone is narrow and tall.
 * Fitting the state's width on a 414 px screen needs about z5.3, and at that
 * zoom an 825 px-tall viewport spans roughly 20° of latitude. A bounds box
 * tight enough to be useful therefore forces the zoom *in* to about z7, which
 * is why a phone opened on Havre instead of the state.
 *
 * So the centre is clamped instead of the viewport. The user can never navigate
 * away from Montana, every part of it is reachable at every zoom, and the only
 * cost is seeing some of Idaho at the edges when zoomed out — which is honest
 * context rather than a bug.
 */
export function clampToMontana(map) {
  const [[w, s2], [e, n]] = outerBounds();
  let guard = false;

  // The rule is "you cannot pan the state out of view", not "the centre must
  // sit inside the state". Clamping the centre to the box itself is too tight:
  // on a tall phone the opening fit deliberately pushes the centre south so the
  // state clears the bottom sheet, and a box-tight clamp drags it back.
  //
  // So the allowed centre is the box grown by a quarter of the current viewport
  // on each side. At high zoom the viewport is small and this is effectively the
  // box; at low zoom it relaxes, which is exactly when the whole state is on
  // screen anyway. At the limit a quarter-viewport of Montana is still visible.
  const clamp = () => {
    if (guard) return;
    const b = map.getBounds();
    const padLng = Math.abs(b.getEast() - b.getWest()) / 4;
    const padLat = Math.abs(b.getNorth() - b.getSouth()) / 4;
    const c = map.getCenter();
    const lng = Math.min(e + padLng, Math.max(w - padLng, c.lng));
    const lat = Math.min(n + padLat, Math.max(s2 - padLat, c.lat));
    if (lng === c.lng && lat === c.lat) return;
    guard = true;                       // setCenter re-fires 'move'
    map.setCenter([lng, lat]);
    guard = false;
  };
  map.on('move', clamp);
  clamp();
}

/**
 * Floor the zoom so the state cannot be zoomed away from.
 *
 * Derived from the zoom at which Montana's *width* fills the container, since
 * that is the dimension that actually bounds a useful view; it has to be
 * recomputed on resize because it depends on the container size.
 */
export function constrainToMontana(map) {
  try {
    const [[w, s2], [e, n]] = outerBounds();
    const mid = (s2 + n) / 2;
    // Ask MapLibre for the zoom rather than deriving it: the arithmetic depends
    // on the basemap's tile size, and OpenFreeMap serves 512 px tiles, not the
    // 256 that the textbook formula assumes. Hard-coding 256 put this floor a
    // whole zoom level too high, which then clamped the opening fitBounds and
    // left a phone showing half the state.
    //
    // The box is deliberately flat — a sliver of latitude around the centre —
    // so only the longitude span can bind. Montana is wide and short and a
    // phone is narrow and tall; constraining on height would force the zoom in.
    const cam = map.cameraForBounds([[w, mid - 0.01], [e, mid + 0.01]],
      { padding: 0 });
    if (cam && Number.isFinite(cam.zoom)) map.setMinZoom(Math.max(3, cam.zoom));
  } catch {
    /* container not measurable yet; the next resize will retry */
  }
}

/* ------------------------------------------------------------------ picking */

/* Click tolerance in screen pixels.
 *
 * MapLibre's layer-scoped `click` and `mouseenter` hit-test a single pixel
 * against the rendered geometry, which is unusable here: at statewide zoom a
 * one-crash segment renders 0.7 px wide and a crash point has a 1.6 px radius.
 * The antialiased mark looks far wider than that, so the pointer cursor only
 * appeared when the cursor sat exactly on the mathematical centreline — which
 * reads as the cursor and the mark disagreeing about where the mark is.
 *
 * Querying a box instead gives a forgiving target, and because the cursor and
 * the click now run the *same* query they cannot disagree by construction.
 */
export const HIT_RADIUS = 8;

const PICK_LAYERS = ['report-points', 'points', 'report-corridors', 'lines'];

/**
 * Topmost feature within the tolerance box, preferring the most specific mark.
 *
 * Order matters: a crash point sits on top of the segment it was matched to, so
 * a click near both should open the crash, not the road. Among several points
 * the nearest to the cursor wins rather than whichever the index returns first.
 */
export function pickAt(map, point) {
  const box = [
    [point.x - HIT_RADIUS, point.y - HIT_RADIUS],
    [point.x + HIT_RADIUS, point.y + HIT_RADIUS],
  ];
  const layers = PICK_LAYERS.filter((id) => {
    if (!map.getLayer(id)) return false;
    return map.getLayoutProperty(id, 'visibility') !== 'none';
  });
  if (!layers.length) return null;

  let feats;
  try {
    feats = map.queryRenderedFeatures(box, { layers });
  } catch {
    return null;
  }
  if (!feats?.length) return null;

  const pts = feats.filter((f) => f.layer.id === 'points'
    || f.layer.id === 'report-points');
  if (pts.length) {
    let best = pts[0];
    let bestD = Infinity;
    for (const f of pts) {
      const c = f.geometry?.coordinates;
      if (!c) continue;
      const p = map.project(c);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (d < bestD) { bestD = d; best = f; }
    }
    return { kind: best.layer.id === 'report-points' ? 'report' : 'point',
             feature: best };
  }
  const line = feats.find((f) => f.layer.id === 'lines'
    || f.layer.id === 'report-corridors');
  return line ? { kind: 'line', feature: line } : null;
}

function wirePicking(map, onPick) {
  const canvas = map.getCanvas();
  let queued = null;

  // queryRenderedFeatures is a spatial-index lookup rather than a raster probe,
  // but mousemove fires faster than frames; coalescing to one query per frame
  // keeps panning smooth.
  const updateCursor = () => {
    queued = null;
    const hit = pickAt(map, lastPoint);
    canvas.classList.toggle('is-pickable', Boolean(hit));
  };
  let lastPoint = { x: 0, y: 0 };

  map.on('mousemove', (e) => {
    lastPoint = e.point;
    if (queued === null) queued = requestAnimationFrame(updateCursor);
  });
  map.on('mouseout', () => canvas.classList.remove('is-pickable'));

  map.on('click', (e) => {
    const hit = pickAt(map, e.point);
    if (hit) onPick({ ...hit, lngLat: e.lngLat });
  });
}

/**
 * Swap the basemap, or re-swap it after a theme change.
 *
 * setStyle discards every source and layer the new style does not declare, so
 * the crash layers, their data and their feature state all have to be put back;
 * `restore` is called once the new style is live.
 */
/** Does this basemap bring its own labels? If not, the app supplies them as
    HTML markers -- the self-hosted style has no glyph server, and MapLibre has
    no built-in font to fall back on. */
export function hasOwnLabels(id) { return basemapDef(id).kind !== 'none'; }

/** Does switching the theme change this basemap's style document? Vector
    basemaps swap light for dark and must be reloaded; a raster set and the
    self-hosted style are repainted in place. */
export function followsTheme(id) {
  const b = basemapDef(id);
  return b.kind === 'vector' && !!b.styleDark;
}

export function setBasemap(map, basemap, dataBase, restore) {
  return new Promise((resolve) => {
    const done = () => {
      addDataLayers(map);
      reapplyLines(map);
      reapplyLrtp(map);
      setPointMode(map, pointMode);
      if (restore) restore(map);
      resolve();
    };
    map.once('styledata', done);
    map.setStyle(styleFor(basemap, dataBase), { diff: false });
  });
}

/* ------------------------------------------------------------ place labels */

let placeMarkers = [];

/**
 * Place names as HTML markers, for the minimal basemap only — the streets
 * basemap brings its own. HTML markers need no glyph server and inherit the
 * page font and theme tokens.
 */
export async function addPlaceLabels(map, url, { minZoom = 6.6 } = {}) {
  removePlaceLabels();
  const res = await fetch(url);
  if (!res.ok) return 0;
  const gj = await res.json();
  for (const f of gj.features) {
    const name = f.properties?.NAME;
    if (!name) continue;
    const el = document.createElement('div');
    el.className = 'placelabel';
    el.textContent = name;
    placeMarkers.push(
      new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(f.geometry.coordinates)
        .addTo(map),
    );
  }
  const sync = () => {
    const show = map.getZoom() >= minZoom;
    for (const m of placeMarkers) m.getElement().style.display = show ? '' : 'none';
  };
  map.on('zoomend', sync);
  sync();
  return placeMarkers.length;
}

export function removePlaceLabels() {
  for (const m of placeMarkers) m.remove();
  placeMarkers = [];
}

/* -------------------------------------------------------------------- data */

let lineData = null;

/** Load the line geometry once; cached so a basemap swap does not refetch it. */
export async function loadLines(map, url) {
  if (!lineData) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`lines.geojson: HTTP ${res.status}`);
    lineData = await res.json();
    // The file ships coded: short keys, the string fields as integer codes into
    // a `dict` member, and null or derivable values omitted. Decoding happens
    // exactly once, here, into segExposure -- so the features MapLibre retains
    // for the session stay small integers, and every consumer downstream sees
    // the same records it always did.
    //
    // Exposure lives on the geometry, the crash counts live in the fact table;
    // the rate is their quotient, so the lookup is built once here too.
    const dict = lineData.dict || {};
    const str = (key, code) => (code === undefined || code === null
      ? null : (dict[key]?.[code] ?? null));
    segExposure = new Map();
    for (const f of lineData.features) {
      const p = f.properties || {};
      // RECORD_LEN was exactly END_MILE - BEGIN_MILE on every segment, so it is
      // recomputed rather than shipped; round to the 3 decimals it had.
      const miles = (p.b !== undefined && p.e !== undefined)
        ? Math.round((p.e - p.b) * 1000) / 1000 : null;
      segExposure.set(p.i, {
        // `v` is published only where the segment clears the stability gate,
        // so its presence *is* the rateable flag.
        mvmty: p.v ?? null,
        rateable: p.v !== undefined && p.v !== null,
        aadt: p.a ?? null,
        miles,
        route: str('rt', p.rt) || str('rn', p.rn) || null,
        county: str('co', p.co),
        place: str('pl', p.pl),
        fc: str('fc', p.fc),
        system: str('sy', p.sy),
        from: p.b ?? null,
        to: p.e ?? null,
        lon: null, lat: null,
      });
      // Midpoint of the geometry, so a ranked row can fly to its segment.
      const g = f.geometry;
      const coords = g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates;
      if (coords?.length) {
        const mid = coords[Math.floor(coords.length / 2)];
        const e = segExposure.get(p.i);
        e.lon = mid[0]; e.lat = mid[1];
      }
    }
  }
  map.getSource('lines').setData(lineData);
  return lineData.features.length;
}

export function reapplyLines(map) {
  if (lineData && map.getSource('lines')) map.getSource('lines').setData(lineData);
}

/**
 * Push per-segment counts into feature state.
 *
 * Previously-set states must be cleared first, or a segment that drops out of
 * the filter keeps its old width.
 */
export function paintSegments(map, totals) {
  if (!map.getSource('lines')) return;
  map.removeFeatureState({ source: 'lines' });
  for (const [id, v] of totals) {
    map.setFeatureState({ source: 'lines', id }, { t: v.t, ka: v.ka });
  }
}

/**
 * Replace the point layer with the filtered set.
 *
 * Capped: past ~60k circles the main thread stalls on every pan, and a
 * statewide smear of points says less than the line layer already does. Over
 * the cap the points are a systematic sample and the caller says so — the line
 * layer and every chart stay exact.
 */
export const POINT_CAP = 60000;

export function paintPoints(facts, map, mask, kept) {
  if (!map.getSource('points')) return { drawn: 0, stride: 1 };
  const { n, cols } = facts;
  const stride = kept > POINT_CAP ? Math.ceil(kept / POINT_CAP) : 1;
  const lon = cols.lon, lat = cols.lat, kab = cols.kabco;
  const features = [];
  let seen = 0;
  for (let r = 0; r < n; r++) {
    if (!mask[r]) continue;
    if (stride > 1 && seen++ % stride !== 0) continue;
    const x = lon[r], y = lat[r];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    features.push({
      type: 'Feature',
      // `i` is the fact-table row index: the popup reads the crash's attributes
      // straight out of the columns rather than duplicating them into every
      // one of up to 60,000 features.
      properties: { s: kab.values[kab.codes[r]] ?? 'U', i: r },
      geometry: { type: 'Point', coordinates: [x, y] },
    });
  }
  map.getSource('points').setData({ type: 'FeatureCollection', features });
  return { drawn: features.length, stride };
}

/**
 * Switch the line layer between crash count and crash rate.
 *
 * Both modes read the same geometry and the same feature state, so the swap is
 * three paint properties rather than a second layer.
 */
export function setLineMode(map, mode) {
  currentLineMode = mode === 'rate' ? 'rate' : 'count';
  if (!map.getLayer('lines')) return;
  const rate = mode === 'rate';
  map.setPaintProperty('lines', 'line-color', rate ? rateColor() : lineColor());
  map.setPaintProperty('lines', 'line-width', rate ? rateWidth() : lineWidth());
  map.setPaintProperty('lines', 'line-opacity', rate ? rateOpacity() : ([
    'case', ['==', ['coalesce', ['feature-state', 't'], 0], 0], 0.45, 0.9,
  ]));
}

/** The active line mode, so a theme repaint keeps the right ramp. */
export let currentLineMode = 'count';

/** Per-segment exposure, read off the line layer once it loads. */
let segExposure = new Map();
export function segmentExposure() { return segExposure; }

/** Repaint the theme-derived colours in place. */
export function applyThemeToMap(map) {
  if (!map || !map.isStyleLoaded()) return;
  if (map.getLayer('ground')) {
    map.setPaintProperty('ground', 'background-color', css('--map-ground'));
    map.setPaintProperty('county-fill', 'fill-color', css('--map-county'));
    map.setPaintProperty('county-line', 'line-color', css('--border-strong'));
  }
  if (map.getLayer('points')) {
    map.setPaintProperty('points', 'circle-color', pointColor());
    map.setPaintProperty('points', 'circle-stroke-color', css('--surface-1'));
  }
  if (map.getLayer('crash-heat')) {
    // The ramp is the same in both themes -- density rides on alpha rather
    // than on lightness, which is what lets one ramp serve both grounds. Kept
    // in the repaint anyway so it stays correct if that ever changes.
    map.setPaintProperty('crash-heat', 'heatmap-color', heatColor());
  }
  if (map.getLayer('lines')) {
    map.setPaintProperty('lines', 'line-color',
      currentLineMode === 'rate' ? rateColor() : lineColor());
  }
  if (map.getLayer('report-corridors')) {
    map.setPaintProperty('report-corridors', 'line-color', css('--report-mark'));
  }
  if (map.getLayer('report-points')) {
    map.setPaintProperty('report-points', 'circle-color', css('--report-mark'));
    map.setPaintProperty('report-points', 'circle-stroke-color', css('--surface-1'));
    map.setPaintProperty('report-points-halo', 'circle-stroke-color', css('--report-mark'));
  }
  if (map.getLayer('report-areas')) {
    map.setPaintProperty('report-areas', 'fill-color',
      ['interpolate', ['linear'], ['get', 'chg'],
        -12, css('--div-cool-2'), -3, css('--div-cool-1'),
        0, css('--div-mid'),
        3, css('--div-warm-1'), 12, css('--div-warm-2')]);
  }
}

/** Open a popup. Lives here because this module already owns the maplibregl
    import; calling it from app.js via a dynamic import would pull a second copy
    of the library into its own chunk. */
export function popup(map, lngLat, html) {
  return new maplibregl.Popup({
    closeButton: true, maxWidth: '290px', className: 'crash-popup',
  }).setLngLat(lngLat).setHTML(html).addTo(map);
}
