/* ---------------------------------------------------------------------------
   app.js — wire the data, the filters, the map and the charts together.

   Load order is chosen so the page is useful early: meta + summary (10 KB) give
   the headline numbers and the filter domains immediately; the fact table
   (2.5 MB) and the line geometry (1.2 MB) stream in behind that and unlock
   filtering when they land.
--------------------------------------------------------------------------- */

import { loadFacts, domain, FLAG_BIT, timeBin } from './facts.js';
import {
  applyFilter, countBy, countByInt, severityCounts, segmentTotals, headline,
  parseHash, writeHash, defaultState, KABCO_ORDER, KABCO_LABEL, FACTORS,
  SUSPICION_FIELDS,
} from './filters.js';
import {
  columns, bars, stack, table, legend, showTip, hideTip, n, pct,
} from './charts.js';
import {
  createMap, loadLines, paintSegments, paintPoints, applyThemeToMap,
  kabcoColors, popup, addPlaceLabels, removePlaceLabels, setBasemap, isDark,
  hasOwnLabels, followsTheme,
  setReportLayers, setReportData, dimData,
  constrainToMontana, clampToMontana, setLineMode, segmentExposure,
  RATE_TOKENS,
  MT_BOUNDS, MT_MAX_BOUNDS, setViewBounds, getViewBounds,
  WIDTH_STOPS, WIDTH_PX, KA_TOKENS,
  setLrtpData, setLrtpVisible, lrtpIsVisible, setPointMode, setLrtpShow,
} from './mapview.js';
import { createTour, tourTaken } from './tour.js';
import {
  MODES, rankIntersections, rankRising, rankVru,
  rankWildlifeRoutes, pointsFor, areasFor, rankingDiagnostics,
} from './reports.js';

const DATA = (document.body.dataset.dataBase || '/data').replace(/\/$/, '');
const $ = (sel) => document.querySelector(sel);

/* Popup content is built from route attributes that come from MDT's shapefiles.
   They are not user input, but they are interpolated into HTML, so escape. */
/* esc() makes a value safe to place inside an attribute. It says nothing about
   what that attribute then DOES: `javascript:alert(1)` contains no character
   esc touches, so an href built only with esc is still a script sink.
   Everything that becomes an href goes through here first.

   It matters because this app renders a link out of third-party data -- the
   MPO plan's `URL` field, which comes from an ArcGIS service we re-read on
   every data rebuild. Today all six values are https; nothing but this check
   guarantees the seventh is. The CSP would also refuse a javascript: URI, but
   that is the second line, not the first. */
import county from './county.js';

const safeUrl = (v) => {
  // Empty must stay empty. Resolving '' against the origin yields the site
  // root, which is truthy -- so a record with no URL would have rendered a
  // link pointing at the homepage.
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw, location.origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  } catch { return null; }
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  meta: null, summary: null, facts: null, map: null,
  filter: null, mask: null, kept: 0, lineCount: 0,
  basemap: null,
  hotspots: null, countyGeo: null, picked: null,
};

/* The basemaps this build offers, from crashmap.config.json. The first is the
   default; the toolbar shows a toggle only when there is more than one. */
const BASEMAP_IDS = county.basemaps?.length ? county.basemaps : ['openfreemap-liberty'];

/* The basemap choice is a per-viewer preference, not part of the shared view,
   so it lives in localStorage rather than the permalink hash.

   Validated against the CONFIGURED list, not merely read back: a reader who
   used this dashboard before the config changed has a stored id that is no
   longer offered, and restoring it would request tiles from an origin the
   content security policy no longer permits -- a blank map with an error only
   the console shows. */
function savedBasemap() {
  try {
    const saved = localStorage.getItem('basemap');
    if (saved && BASEMAP_IDS.includes(saved)) return saved;
  } catch { /* private mode */ }
  return BASEMAP_IDS[0];
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  const note = $('#loadnote');
  const setNote = (t) => { if (note) note.textContent = t; };

  setNote('Loading summary…');
  const [meta, summary] = await Promise.all([
    fetch(`${DATA}/meta.json`).then((r) => r.json()),
    fetch(`${DATA}/summary.json`).then((r) => r.json()),
  ]);
  state.meta = meta;
  state.summary = summary;
  state.filter = parseHash(meta);
  // Whether the *link* supplied a view, captured before the map exists. The
  // live `filter.map` cannot answer this: the map's own first moveend fills it
  // in, so by the time the opening fit is due it is always set.
  state.hadMapInHash = Boolean(state.filter.map);

  renderVintage();
  renderAbout();
  renderTilesFromSummary();
  if (!hasAcknowledged()) openAbout({ splash: true });
  // The tour offer only rides along with the caveats splash; afterwards it
  // lives in the toolbar, so a returning reader is never nagged.
  $('#abouttour').hidden = tourTaken();

  // Geography comes from the bundle. A scoped build gets bounds derived from
  // its own crashes and a proportional margin.
  //
  // The OPENING view and the PAN LIMIT are separate. Fitting the county bbox
  // centres the map on its centroid, which in a county 1.7 degrees tall is open
  // country, not the place a reader came to look at. So when the bundle names a
  // focus -- the county seat -- the map opens on that and keeps the county as
  // the limit. No coordinate is written here: both boxes are built by the
  // pipeline from the crashes themselves.
  const scope = state.meta.scope || null;
  state.scope = scope;
  if (scope?.focus?.bounds) setViewBounds(scope.focus.bounds, { max: scope.bounds });
  else if (scope?.bounds) setViewBounds(scope.bounds);
  else setViewBounds(MT_BOUNDS, { max: MT_MAX_BOUNDS });

  setNote('Loading map…');
  state.basemap = savedBasemap();
  state.map = await createMap('map', {
    dataBase: DATA, onPick: handlePick, basemap: state.basemap,
  });
  if (state.filter.map) {
    const [z, lat, lon] = state.filter.map;
    state.map.jumpTo({ zoom: z, center: [lon, lat] });
  }
  state.map.on('moveend', () => {
    const c = state.map.getCenter();
    state.filter.map = [state.map.getZoom(), c.lat, c.lng];
    writeHash(state.filter, state.meta, { replace: true });
  });

  setNote(`Loading ${Number(meta.data.rows).toLocaleString()} crash records…`);
  state.facts = await loadFacts(`${DATA}/facts.parquet`, (_f, t) => setNote(`${t}…`));
  // Read-only handle, as with window.__map: lets a test assert the columns that
  // are now derived in the browser rather than shipped.
  window.__facts = state.facts;

  /* The road-segment layer exists only when the bundle was built from inputs
     that carry route geometry. A bundle built from MDT's published workbooks
     has no LRS shapefiles and therefore no lines, and says so in meta.layers
     rather than leaving the dashboard to discover it by 404.
   *
     Asking first, rather than catching the failure, matters: a 404 on every
     load is noise the smoke suite is right to treat as a defect, and it buries
     the real failures it exists to surface. */
  if (state.meta?.layers?.lines !== false) {
    setNote('Loading route network…');
    try {
      state.lineCount = await loadLines(state.map, `${DATA}/lines.geojson`);
    } catch (err) {
      console.warn('line layer unavailable:', err);
    }
  }
  await syncPlaceLabels();

  // Optional, like the report inputs: a missing or stale bundle must cost the
  // reader the overlay, not the dashboard. Wired here in boot only -- the
  // restyle path below re-runs syncPlaceLabels/loadReportInputs too, and
  // binding the click handlers there would stack a new listener on every
  // theme toggle.
  try {
    if (await loadLrtp()) {
      for (const id of ['lrtp-line', 'lrtp-point']) {
        state.map.on('click', id, lrtpPopup);
        state.map.on('mouseenter', id, () => {
          state.map.getCanvas().style.cursor = 'pointer';
        });
        state.map.on('mouseleave', id, () => {
          state.map.getCanvas().style.cursor = '';
        });
      }
      const t = $('#lrtptoggle');
      if (t) {
        t.hidden = false;
        t.addEventListener('click', () => {
          const on = !lrtpIsVisible();
          setLrtpVisible(state.map, on);
          t.setAttribute('aria-pressed', String(on));
          const box = $('#legend-plan');
          if (box) box.hidden = !on;
        });
      }
      // Each status draws independently. Unticking both empties the layer
      // rather than hiding it, so the overlay stays "on" and the boxes stay
      // the thing that decides what is drawn.
      for (const cb of document.querySelectorAll('[data-plan]')) {
        cb.addEventListener('change', () => {
          setLrtpShow(state.map, { [cb.dataset.plan]: cb.checked });
        });
      }
    }
  } catch (err) { console.warn('planned projects unavailable:', err); }

  await loadReportInputs();
  // The county polygons the choropleth joins onto — optional for the same
  // reason the report inputs are.
  try {
    state.countyGeo = await fetch(`${DATA}/counties.geojson`)
      .then((r) => (r.ok ? r.json() : null));
  } catch (err) { console.warn('county polygons unavailable:', err); }

  buildControls();
  initFilterAccordions();
  buildLegend();
  initBasemapToggle();
  initModes();
  initSheet();
  initTour();
  $('#loading').hidden = true;
  $('#maplegend').hidden = false;

  // MapLibre measures its container once at construction. The container is
  // behind the loading overlay and inside a grid that has not settled at that
  // point, so the first fitBounds is computed against the wrong size and
  // Montana ends up parked in a corner. Re-measure now that the layout is
  // final, and re-fit unless the hash asked for a specific view.
  state.map.resize();
  // Two frames, so the top bar has finished wrapping and the sheet has taken
  // its height before the opening extent is computed. Fitting against a
  // half-measured container is what left a phone opening zoomed into the middle
  // of the state.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  state.map.resize();
  // The splash puts a CSS filter on .app, which makes it the containing block
  // for the fixed-position sheet and so changes what the sheet measures. The
  // opening extent is therefore computed once the splash is gone — see
  // dismissSplash — and only done here when there is no splash to wait for.
  if (!state.hadMapInHash && !$('#about').open) fitMontana();
  constrainToMontana(state.map);
  clampToMontana(state.map);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      state.map.resize();
      // The minimum zoom depends on the container, so it is re-derived whenever
      // the container changes — rotating a phone, or opening the bottom sheet.
      constrainToMontana(state.map);
    });
    ro.observe(document.getElementById('map'));
  }

  recompute();

  // hashchange fires on back/forward and on a pasted link, but not on our own
  // replaceState writes from moveend — so restoring the map view here cannot
  // loop. Without this a shared permalink restores the filters but not the
  // view it was shared at.
  addEventListener('hashchange', () => {
    state.filter = parseHash(state.meta);
    syncControls();
    syncModeButtons();
    const m = state.filter.map;
    if (m) {
      const c = state.map.getCenter();
      const moved = Math.abs(c.lat - m[1]) > 1e-4
        || Math.abs(c.lng - m[2]) > 1e-4
        || Math.abs(state.map.getZoom() - m[0]) > 0.05;
      if (moved) state.map.jumpTo({ zoom: m[0], center: [m[2], m[1]] });
    }
    recompute({ moveMap: false });
  });
}

/* ---------------------------------------------------------------- basemap */

/** Place-name markers belong to a basemap that brings no labels of its own;
    any other basemap has them already and would double them up. */
/* Planned transportation projects, from whichever long-range plan this county
   publishes -- named in crashmap.config.json, absent when it names none. Fetched
   from the BUNDLE, never from a live service: the whole site runs under a
   content security policy with no external fetch origins, and adding one to
   draw a reference layer would trade the strongest property this build has.

   Codes are expanded once, here, rather than in a paint expression: the layer
   styles on `committed`, and tying a MapLibre filter to a dictionary INDEX
   would silently repaint the map the first time the upstream plan reorders its
   status values. 887 features is nothing to walk. */
async function loadLrtp() {
  /* Absent unless this county's config names a bundle. Gating on config rather
     than letting the fetch 404 matters for two reasons: a 404 on every load is
     noise that the smoke suite is right to treat as a defect, and "this county
     has no published plan" is a fact about the county, not a missing file. */
  const plan = county.plannedProjects;
  if (!plan || !plan.file) return null;
  const fc = await fetch(`${DATA}/${plan.file}`).then((r) => (r.ok ? r.json() : null));
  if (!fc || !Array.isArray(fc.features)) return null;
  const d = fc.dict || {};
  const at = (k, code) => (code === undefined || code === null
    ? null : (d[k]?.[code] ?? null));
  for (const f of fc.features) {
    const p = f.properties || {};
    const status = at('st', p.st);
    f.properties = {
      name: at('nm', p.nm), desc: at('ds', p.ds), url: at('ur', p.ur),
      ftype: at('ft', p.ft), cat: at('ca', p.ca), src: at('sr', p.sr),
      status, committed: status === 'Committed' ? 1 : 0,
    };
  }
  setLrtpData(state.map, fc);
  return fc;
}

function lrtpPopup(e) {
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties || {};
  // popup-pair, not popup-row: the crash popup's rows flex apart because their
  // values are short numbers, and a plan title like "2017 Transportation
  // Master Plan"
  // right-aligned opposite "Source" reads as two columns of noise. These run
  // label-colon-value inline and wrap. The space before <b> is load-bearing.
  const row = (k, v) => (v
    ? `<div class="popup-pair"><span>${esc(k)}:</span> <b>${esc(v)}</b></div>`
    : '');
  popup(state.map, e.lngLat, `
    <div class="popup-title">${esc(p.name || p.ftype || 'Planned project')}</div>
    ${p.desc ? `<p class="popup-desc">${esc(p.desc)}</p>` : ''}
    ${row('Type', p.ftype)}${row('Category', p.cat)}${row('Status', p.status)}
    ${row('Source', p.src)}
    ${safeUrl(p.url) ? `<p class="popup-desc"><a href="${esc(safeUrl(p.url))}"
      target="_blank" rel="noreferrer noopener">Open the source plan</a></p>` : ''}
    <p class="popup-note">A planned or committed project, not crash data. Its
      presence is not a safety finding.</p>`);
}

async function syncPlaceLabels() {
  if (hasOwnLabels(state.basemap)) { removePlaceLabels(); return; }
  try {
    await addPlaceLabels(state.map, `${DATA}/places.geojson`);
  } catch (err) {
    console.warn('place labels unavailable:', err);
  }
}

async function applyBasemap(kind) {
  state.basemap = kind;
  try { localStorage.setItem('basemap', kind); } catch { /* private mode */ }
  for (const b of document.querySelectorAll('[data-basemap]')) {
    b.setAttribute('aria-pressed', String(b.dataset.basemap === kind));
  }
  removePlaceLabels();
  await setBasemap(state.map, kind, DATA, () => {
    if (state.mask) {
      // Segments only when there is a line layer to paint; recompute() gates on
      // the same pair. The POINTS are not optional -- a style reload drops
      // every layer, so skipping this is what leaves a themed map empty.
      if (state.lineCount) {
        paintSegments(state.map, segmentTotals(state.facts, state.mask));
      }
      paintPoints(state.facts, state.map, state.mask, state.kept);
    }
  });
  await syncPlaceLabels();

  await loadReportInputs();
  // The county polygons the choropleth joins onto — optional for the same
  // reason the report inputs are.
  try {
    state.countyGeo = await fetch(`${DATA}/counties.geojson`)
      .then((r) => (r.ok ? r.json() : null));
  } catch (err) { console.warn('county polygons unavailable:', err); }
}

function initBasemapToggle() {
  for (const b of document.querySelectorAll('[data-basemap]')) {
    b.setAttribute('aria-pressed', String(b.dataset.basemap === state.basemap));
    b.addEventListener('click', () => {
      if (b.dataset.basemap !== state.basemap) applyBasemap(b.dataset.basemap);
    });
  }
}

/* ------------------------------------------------------------- line mode */

/* Quintiles. Five classes is what a reader can hold at once, and the breaks
   come from the segments actually on screen so the map stays informative under
   any filter — the legend prints the values, so a class never means something
   the reader cannot check. */
const RATE_CLASSES = 5;

/**
 * Colour the network by crashes per 100 million vehicle-miles.
 *
 * The rate is (crashes matching the filter) / (exposure over the years in
 * view), where exposure is the segment's AADT x length x 365 x years. Only
 * segments clearing the stability gate get a class: ungated, the worst segment
 * in this network reports 2.7 million crashes per 100 M VMT, because a 0.03
 * mile fragment with one crash is arithmetic rather than evidence.
 */
function paintSegmentRates(totals) {
  const exposure = segmentExposure();
  const years = Math.max(1, state.filter.y1 - state.filter.y0 + 1);
  const rates = [];
  const perSeg = new Map();

  for (const [segId, info] of exposure) {
    if (!info.rateable || !info.mvmty) continue;
    const crashes = totals.get(segId)?.t ?? 0;
    const rate = crashes / (info.mvmty * years) * 100;
    perSeg.set(segId, rate);
    rates.push(rate);
  }
  if (!rates.length) return { breaks: [], rated: 0, zero: 0 };

  // Zero gets its own class and the remaining classes split the positive rates.
  // Plain quintiles over everything collapse under a severity filter: most
  // gated segments have no fatal crash in any given decade, so the lower
  // boundaries all land on 0 and two classes become "0.0-0.0".
  const positive = rates.filter((r) => r > 0).sort((a, b) => a - b);
  const zero = rates.length - positive.length;
  const bins = RATE_CLASSES - 1;
  const breaks = [];
  if (positive.length) {
    for (let i = 1; i < bins; i++) {
      const v = positive[Math.floor((i / bins) * (positive.length - 1))];
      // Ties would make an empty class; keep only strictly increasing cuts.
      if (!breaks.length || v > breaks[breaks.length - 1]) breaks.push(v);
    }
  }

  // No removeFeatureState here: paintSegments has already cleared and
  // repopulated the crash counts for this pass, and wiping again would take
  // them straight back out.
  for (const [segId, rate] of perSeg) {
    let rc = 0;
    if (rate > 0) {
      rc = 1;
      while (rc - 1 < breaks.length && rate > breaks[rc - 1]) rc++;
    }
    state.map.setFeatureState({ source: 'lines', id: segId }, { rc, rate });
  }
  return {
    breaks, rated: perSeg.size, zero,
    max: positive.length ? positive[positive.length - 1] : 0,
  };
}

/**
 * Fit the state into the part of the map the reader can actually see.
 *
 * On a phone the bottom sheet covers the lower third of the map, so padding the
 * fit by its height centres Montana in the visible strip rather than behind the
 * sheet.
 */
function fitMontana({ duration = 0 } = {}) {
  const sheet = $('#side');
  const covered = matchMedia(MOBILE_Q).matches && sheet
    ? Math.round(sheet.getBoundingClientRect().height)
    : 0;
  state.map.fitBounds(getViewBounds(), {
    padding: { top: 20, left: 16, right: 16, bottom: Math.max(20, covered + 16) },
    duration,
  });
}

/* ----------------------------------------------------------- mobile sheet */

/* Snap positions as a fraction of the viewport height, plus a pixel peek that
   shows the stat tiles and nothing else. */
const SNAP = { peek: null, half: 0.42, full: 0.84 };
const MOBILE_Q = '(max-width: 720px)';

/**
 * The bottom sheet: three snap positions, draggable by its handle, tappable to
 * cycle.
 *
 * A sheet rather than a long scroll because the map is the point of the page —
 * pushing it off-screen to reach a filter means you cannot see what the filter
 * did. Peek keeps the stat tiles visible over the map, which is the smallest
 * useful readout of a filter change.
 */
function initSheet() {
  const side = $('#side');
  const handle = $('#sheethandle');
  const label = $('#sheetlabel');
  if (!side || !handle) return;

  const isMobile = () => matchMedia(MOBILE_Q).matches;
  let snap = 'half';

  const apply = (next, { animate = true } = {}) => {
    snap = next;
    side.classList.toggle('is-dragging', !animate);
    side.classList.toggle('peek', next === 'peek');
    side.style.height = next === 'peek' ? '' : `${SNAP[next] * 100}dvh`;
    handle.setAttribute('aria-expanded', String(next !== 'peek'));
    label.textContent = next === 'peek' ? 'Show filters & charts'
      : next === 'half' ? 'Filters & charts' : 'Drag down to see the map';
    if (!animate) requestAnimationFrame(() => side.classList.remove('is-dragging'));
    // The map's usable height changed, so its minimum zoom has to be re-derived.
    setTimeout(() => { state.map?.resize(); constrainToMontana(state.map); }, 240);
  };

  // Tap cycles peek -> half -> full -> peek.
  handle.addEventListener('click', (e) => {
    if (!isMobile() || e.detail === 0 && dragged) return;
    if (dragged) return;
    apply(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek');
  });

  // Drag to any height, then snap to the nearest position on release.
  let startY = 0;
  let startH = 0;
  let dragging = false;
  let dragged = false;

  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    dragging = true;
    dragged = false;
    startY = e.clientY;
    startH = side.getBoundingClientRect().height;
    side.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) dragged = true;
    const h = Math.min(innerHeight * 0.88, Math.max(90, startH + dy));
    side.classList.remove('peek');
    side.style.height = `${h}px`;
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (!dragged) { side.classList.remove('is-dragging'); return; }
    const h = side.getBoundingClientRect().height;
    const peekPx = 118;
    const options = [
      ['peek', peekPx],
      ['half', innerHeight * SNAP.half],
      ['full', innerHeight * SNAP.full],
    ];
    const [best] = options.reduce((a, b) =>
      (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a));
    side.style.height = '';
    apply(best);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // The sheet is position:fixed and overlays the bottom of the map, so anything
  // anchored to the map's bottom edge (the legend, the point-count note) would
  // otherwise sit underneath it — invisible and unclickable, which is what was
  // happening to the legend on every phone. Publish the sheet's live height so
  // those can hold station above it. A ResizeObserver rather than a write
  // inside apply(): it also tracks the drag and the snap transition, so they
  // follow the sheet instead of jumping when it lands.
  const app = document.querySelector('.app') || document.documentElement;
  const publishSheetHeight = () => {
    app.style.setProperty('--sheet-h', `${side.getBoundingClientRect().height}px`);
  };
  new ResizeObserver(publishSheetHeight).observe(side);
  publishSheetHeight();

  const sync = () => {
    if (isMobile()) apply(snap, { animate: false });
    else {
      side.style.height = '';
      side.classList.remove('peek', 'is-dragging');
    }
  };
  matchMedia(MOBILE_Q).addEventListener('change', sync);
  sync();

  // Opening a report or picking a row is a reason to look at the map again.
  state.collapseSheet = () => { if (isMobile() && snap === 'full') apply('half'); };
  // The tour needs the sheet open to point at anything inside it.
  state.expandSheet = () => { if (isMobile() && snap !== 'full') apply('full'); };
}

/**
 * Collapse the filter groups into accordions on mobile only.
 *
 * <details> is used rather than a bespoke widget so the sections stay keyboard
 * and screen-reader operable for free, and so they are simply open on desktop.
 */
function initFilterAccordions() {
  const rail = document.querySelector('.rail');
  if (!rail || rail.dataset.accordion) return;
  rail.dataset.accordion = '1';

  for (const group of rail.querySelectorAll('.group')) {
    const label = group.querySelector('.label');
    if (!label) continue;
    const details = document.createElement('details');
    details.className = 'group-acc';
    const summary = document.createElement('summary');
    // Keep the "Reset all" / "Clear" affordance out of the summary's toggle
    // target, or tapping it would also collapse the section.
    const action = label.querySelector('button');
    summary.appendChild(label.querySelector('span').cloneNode(true));
    details.appendChild(summary);
    if (action) {
      action.classList.add('group-action');
      summary.appendChild(action);
      action.addEventListener('click', (e) => e.stopPropagation());
    }
    label.remove();
    while (group.firstChild) details.appendChild(group.firstChild);
    group.appendChild(details);
    details.open = true;
  }
}

/* ----------------------------------------------------------------- modes */

function initModes() {
  const bar = $('#modebar');
  bar.innerHTML = '';
  for (const m of MODES) {
    // A report with no data behind it is not offered at all, rather than
    // offered and then empty.
    if (m.id === 'intersections' && !state.hotspots) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.setAttribute('aria-pressed', String(m.id === state.filter.mode));
    b.addEventListener('click', () => setMode(m.id));
    bar.appendChild(b);
  }
  syncModeButtons();
}

function syncModeButtons() {
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.filter.mode));
  }
  $('#charts').hidden = state.filter.mode !== 'explore';
  $('#report').hidden = state.filter.mode === 'explore';
}

function setMode(mode) {
  state.filter.mode = mode;
  state.picked = null;
  syncModeButtons();
  writeHash(state.filter, state.meta, { replace: true });
  recompute({ moveMap: false });
}

/* ---------------------------------------------------------------- reports */

function rankRow(cells, { onPick, active = false } = {}) {
  const tr = document.createElement('tr');
  if (active) tr.className = 'active';
  for (const c of cells) {
    const td = document.createElement('td');
    if (c instanceof Node) td.appendChild(c);
    else td.innerHTML = c;
    tr.appendChild(td);
  }
  if (onPick) {
    tr.addEventListener('click', onPick);
    // A row with a click handler and nothing else is a mouse-only control:
    // every ranking in this app was unreachable by keyboard and silent to a
    // screen reader. role="button" costs the row's table semantics, which is
    // the lesser loss -- an unreachable control is worth nothing to anybody,
    // and the figures remain readable as a table either way.
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-pressed', String(active));
    tr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();   // Space would otherwise scroll the panel
      onPick();
    });
  }
  return tr;
}

function rankTable(head, rows) {
  const t = document.createElement('table');
  t.className = 'ranktable';
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    th.scope = 'col';
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  const tb = document.createElement('tbody');
  for (const r of rows) tb.appendChild(r);
  t.append(thead, tb);
  return t;
}

/* A report highlights its ranked set on the map the moment it opens, and a row
   click flies to one of them. Neither had a way back short of reloading the
   page, which is what made the map feel stuck. */
function clearReportSelection() {
  state.picked = null;
  drawReport();
  syncReportLayers();
  fitMontana({ duration: 600 });
}

function reportShell(title, lede) {
  const box = $('#report');
  box.innerHTML = '';
  const h = document.createElement('header');
  h.className = 'report-head';
  const txt = document.createElement('div');
  txt.innerHTML = `<h2>${title}</h2><p class="lede">${lede}</p>`;
  h.appendChild(txt);
  // Always present, not only once a row is picked: there is something to clear
  // from the moment the report opens. Deliberately does NOT touch the filters
  // -- those are visible in the rail, and clearing them from here would be a
  // surprise rather than a convenience.
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'linkbtn report-clear';
  clear.textContent = 'Clear';
  clear.title = 'Drop the highlighted selection and return to the full county view';
  clear.addEventListener('click', clearReportSelection);
  h.appendChild(clear);
  box.appendChild(h);
  return box;
}

function note(box, text) {
  const p = document.createElement('p');
  p.className = 'caveat-note';
  p.innerHTML = text;
  box.appendChild(p);
}

/** "Missoula, Missoula" is noise — the consolidated city-counties and several
    county seats share their county's name. */
/**
 * Expand a dictionary-encoded record file.
 *
 * hotspots.json and corridors.json are long lists of short records, which is
 * the shape that pays most for spelling out a value every time it recurs — one
 * of seven functional-class names appeared 3,296 times, one of 47 county names
 * 4,709 times. The writer sends a code plus one table; this puts the strings
 * back, so the reports downstream are unchanged. A missing code means the field
 * was blank and stays falsy, as it was before.
 *
 * The pre-encoding shape (a bare array) is still accepted, so a stale bundle
 * degrades to working rather than to a blank report.
 */
function expandRecords(packed) {
  if (Array.isArray(packed)) return packed;
  if (!packed?.rows) return null;
  const dict = packed.dict || {};
  const keys = Object.keys(dict);
  return packed.rows.map((r) => {
    const o = { ...r };
    for (const k of keys) {
      const code = r[k];
      o[k] = (code === undefined || code === null) ? null : (dict[k][code] ?? null);
    }
    return o;
  });
}

/* Report inputs: the intersection clusters and the ranked corridors. Both are
   optional — a missing file disables its report rather than breaking the page. */
async function loadReportInputs() {
  try {
    const hs = await fetch(`${DATA}/hotspots.json`).then((r) => (r.ok ? r.json() : null));
    const rows = expandRecords(hs);
    if (rows) state.hotspots = new Map(rows.map((h) => [h.id, h]));
  } catch (err) { console.warn('hotspots unavailable:', err); }
}

function placeOf(d) {
  const parts = [d.city, d.county].filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    return parts[0];
  }
  return parts.join(', ');
}

function flyTo(lon, lat, zoom = 14) {
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    state.map.flyTo({ center: [lon, lat], zoom, duration: 800 });
    // On a phone the sheet is probably covering the place we just flew to.
    state.collapseSheet?.();
  }
}

/* ------------------------------------------------- report: intersections */

function reportIntersections() {
  const metric = state.filter.metric;
  const { rows, total } = rankIntersections(
    state.facts, state.mask, state.hotspots, { top: 25, metric });
  const box = reportShell('Most dangerous intersections',
    'Intersection crash clusters ranked by the chosen measure, under the '
    + 'current filter. Click a row to fly to it.');

  // Metric switch. It is here rather than in a settings menu because which
  // measure you pick changes the answer completely — see the note below.
  const sw = document.createElement('div');
  sw.className = 'modebar';
  sw.style.margin = '0 0 10px';
  for (const [id, label] of [['ka', 'Fatal + serious'], ['k', 'Fatal only']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(metric === id));
    b.addEventListener('click', () => {
      state.filter.metric = id;
      state.picked = null;
      writeHash(state.filter, state.meta, { replace: true });
      drawReport();
      syncReportLayers();
    });
    sw.appendChild(b);
  }
  box.appendChild(sw);

  if (!rows.length) {
    box.insertAdjacentHTML('beforeend',
      '<p class="empty">No intersection clusters match these filters.</p>');
    setReportData(state.map, { points: pointsFor([]) });
    return;
  }

  const trs = rows.map((d, i) => rankRow([
    String(i + 1),
    `${esc(d.label)}<span class="sub">${esc(placeOf(d))}</span>`,
    `<span class="big">${n(metric === 'k' ? d.K : d.ka)}</span>`,
    metric === 'k' ? n(d.A) : n(d.K),
    n(d.n),
  ], {
    active: state.picked === `h${d.id}`,
    onPick: () => {
      state.picked = state.picked === `h${d.id}` ? null : `h${d.id}`;
      if (state.picked) flyTo(d.lon, d.lat);
      drawReport();
    },
  }));
  box.appendChild(rankTable(
    metric === 'k'
      ? ['#', 'Location', 'Fatal', 'Serious', 'Crashes']
      : ['#', 'Location', 'K+A', 'Fatal', 'Crashes'],
    trs));

  const dx = rankingDiagnostics(rows);
  // The concentration warning is generated from the ranking actually on screen,
  // so it stays true under any filter rather than restating a fixed example.
  const sevCoding = state.meta.scope?.severity_coding || null;
  const scopeLabel = state.meta.scope?.label || 'This area';
  if (dx && metric === 'ka' && (dx.topShare >= 50 || dx.zeroFatalShare >= 50)) {
    note(box,
      `<strong>Read this ranking with care.</strong> `
      // Named only when it is a real place. In a county bundle most clusters
      // are unincorporated, and "N% are in <county>" says nothing.
      // "100% of these clusters are in Missoula" reads as a tautology when the
      // seat shares the county's name, though it is really saying they are all
      // inside the city. Disambiguated only in that case; "in Bozeman" inside
      // Gallatin County needs no help.
      + (dx.topPlace && dx.topShare >= 25
        ? `${Math.round(dx.topShare)}% of these clusters are in `
          + `${esc(dx.topPlace === state.meta.scope?.name
            ? `the city of ${dx.topPlace}` : dx.topPlace)}, and `
        : '')
      + `${Math.round(dx.zeroFatalShare)}% recorded no fatal crash at all — `
      + `they rank on <em>suspected serious injury</em>, which is an officer's `
      + `on-scene judgement and is not coded consistently across Montana. `
      // The scoped bundle carries its own version of this. A county build
      // quoting Missoula against Billings is telling the reader about two
      // places the data does not contain.
      + (sevCoding
        ? `${esc(scopeLabel)} records ${sevCoding.a_per_k_here} suspected-serious `
          + `injuries per fatality against ${sevCoding.a_per_k_statewide} `
          + `statewide — fatality is not a judgement call, and this is not a `
          + `claim that injuries here are worse. `
        // Without the person table there is no per-fatality ratio to quote, so
        // the point is made in general terms. Naming two other places here
        // would describe data this bundle does not contain.
        : `Montana agencies differ several-fold in the share of crashes they `
          + `record as suspected-serious, and the ones recording the most are `
          + `not the ones recording the most fatal crashes. Add the person `
          + `table to see this county's own ratio against the statewide one. `)
      + `Switch to <strong>Fatal only</strong> for a measure `
      + `that does not depend on where the injury threshold is drawn.`);
  }
  note(box,
    `${n(total)} clusters match; the top value here is `
    + `${n(metric === 'k' ? rows[0].K : rows[0].ka)}. <strong>These are small `
    + `numbers</strong> — a one-crash difference in rank is not a difference in `
    + `risk — and there is no traffic-volume denominator, so a busy intersection `
    + `and a dangerous one are not separated.`);
  note(box,
    'Clusters are <em>derived</em>: MDT publishes no intersection inventory, so '
    + 'intersection-related crashes are snapped to a 50 m grid and adjacent cells '
    + 'merged, capped at 200 m across. A large interchange may split across '
    + 'clusters, and a cluster is only as good as the coordinates behind it.');

  setReportData(state.map, { points: pointsFor(rows) });
}

/* ------------------------------------------------------ report: wildlife */

function reportWildlife() {
  const res = rankWildlifeRoutes(state.facts, state.mask, { top: 10 });
  const box = reportShell('Wildlife collisions',
    'The ten MDT corridors carrying the most wildlife-involved crashes under '
    + 'the current filter.');

  if (!res.rows.length) {
    box.insertAdjacentHTML('beforeend',
      '<p class="empty">No corridor has a wildlife crash under these '
      + 'filters.</p>');
    return;
  }

  const trs = res.rows.map((d, i) => rankRow([
    String(i + 1),
    esc(d.label),
    `<span class="big">${n(d.n)}</span>`,
    n(d.ka),
  ]));
  box.appendChild(rankTable(
    ['#', 'MDT corridor', 'Wildlife crashes', 'Fatal + serious'], trs));

  // Within one county, ties at the cut are the common case rather than the
  // exception, so this fires on most views.
  if (res.tiedAtCut > 1) {
    note(box,
      `<strong>Rank order here is partly arbitrary.</strong> ${n(res.tiedAtCut)} `
      + `corridors are tied on ${n(res.cut)} wildlife crash`
      + `${res.cut === 1 ? '' : 'es'}, so the last places shown are one `
      + 'selection from a larger tied group.');
  }

  const kaTotal = res.rows.reduce((t, d) => t + d.ka, 0);
  note(box,
    `${n(res.total)} wildlife crashes match the current filter, on `
    + `${n(res.routes)} corridor${res.routes === 1 ? '' : 's'}`
    + (res.offRoute
      ? `, plus ${n(res.offRoute)} the crash table leaves uncoded, which this `
        + 'table cannot rank'
      : '')
    + `. <strong>This ranks volume, not severity.</strong> Wildlife collisions `
    + `are among the most common crash types on Montana's rural network and `
    + `among the least severe: ${n(kaTotal)} of the ranked crashes `
    + `${kaTotal === 1 ? 'is' : 'are'} fatal or suspected-serious. Ranking on `
    + `severity within one county would be ranking counts of zero to two. To `
    + `look at the severe ones, combine the <strong>Wildlife involved</strong> `
    + `and <strong>Fatal or serious</strong> factors instead.`);

  note(box,
    '<strong>These are identifiers, not road names.</strong> MDT\'s crash '
    + 'extract carries a corridor code and no table to resolve it, so the '
    + 'ranking is honest about which stretches of road lead and silent about '
    + 'what they are called.');

  note(box,
    '<strong>No exposure denominator, and no corridor length.</strong> This '
    + 'is a count, not a risk. A long corridor accumulates more crashes than '
    + 'a short one at the same risk per mile, and a corridor can lead by '
    + 'carrying heavy traffic through good habitat. Reporting is also uneven: '
    + 'a collision with no injury and a drivable vehicle is reported '
    + 'inconsistently, so quiet rural corridors are likely undercounted '
    + 'relative to busy ones.');

  note(box,
    'Wildlife here is the union of two signals MDT records independently — the '
    + 'crash-level collision type and the first-harmful-event detail — which '
    + 'do not always agree. Domestic animals and livestock are coded '
    + 'separately by MDT and are not included.');
}

/* -------------------------------------------------------- report: rising */

/* Inside a single county there is one county to rank, so the unit becomes the
   places within it. rankRising already takes the dimension; the column header,
   the exclusion note and the choropleth all have to agree with it, which is
   why this is one function rather than three copies of the condition.

   The choropleth is the part that cannot simply be relabelled: areasFor joins
   rows onto county polygons by name, and a county seat usually shares its
   county's name, so city rows would silently paint the whole county with one
   city's number. A county bundle therefore gets the table without the map. */
function risingDim() {
  return $('#report')?.dataset.by
    || (state.scope?.kind === 'county' ? 'city' : 'county');
}

function reportRising() {
  const by = risingDim();
  const res = rankRising(state.facts, state.mask, state.filter, { by, top: 20 });
  const f = state.filter;
  const box = reportShell('Where severe crashes are rising',
    'Change in fatal and serious injury crashes between the first and second '
    + 'half of the selected period.');

  if (res.tooShort) {
    box.insertAdjacentHTML('beforeend',
      '<p class="empty">Select at least four years to compare two halves.</p>');
    setReportData(state.map, { areas: areasFor(state.countyGeo, []) });
    return;
  }
  const sp = res.split;
  if (!res.rows.length) {
    box.insertAdjacentHTML('beforeend',
      '<p class="empty">No geography has enough severe crashes to compare.</p>');
    setReportData(state.map, { areas: areasFor(state.countyGeo, []) });
    return;
  }

  const trs = res.rows.map((d, i) => rankRow([
    String(i + 1),
    `${esc(d.label)}<span class="sub">${n(d.total)} K+A over ${f.y0}–${f.y1}</span>`,
    n(d.early),
    n(d.late),
    `<span class="${d.change > 0 ? 'up' : d.change < 0 ? 'down' : ''} big">`
      + `${d.change > 0 ? '+' : ''}${n(d.change)}</span>`,
  ], {
    active: state.picked === `c${d.label}`,
    onPick: () => {
      if (by !== 'county') {
        state.picked = state.picked === `c${d.label}` ? null : `c${d.label}`;
        drawReport();
        return;
      }
      // The row highlight has to follow the filter it sets, or clicking twice
      // clears the county while the row stays lit and the panel contradicts
      // the map.
      const on = state.filter.county !== d.label;
      state.picked = on ? `c${d.label}` : null;
      state.filter.county = on ? d.label : null;
      syncControls();
      commit({ moveMap: true });
    },
  }));
  // The map key goes above the table: it explains the choropleth the reader is
  // already looking at, and below twenty rows nobody would find it. No
  // choropleth, no key.
  if (by === 'county') {
    const legend = document.createElement('div');
    legend.className = 'divlegend';
    legend.innerHTML = '<span>fewer</span><span class="ramp">'
      + ['--div-cool-2', '--div-cool-1', '--div-mid', '--div-warm-1', '--div-warm-2']
        .map((t) => `<i style="background:var(${t})"></i>`).join('')
      + '</span><span>more</span>';
    box.appendChild(legend);
  }

  const unit = by === 'city' ? 'Place' : 'County';
  const units = by === 'city' ? 'Places' : 'Counties';
  const one = by === 'city' ? 'place' : 'county';
  box.appendChild(rankTable(
    ['#', unit, `${sp.earlyFrom}–${sp.earlyTo}`, `${sp.lateFrom}–${sp.lateTo}`, 'Change'],
    trs));

  note(box,
    `Two five-year totals, not a fitted trend: at these counts a regression line `
    + `would report a precision the data does not have. ${units} with fewer than `
    + `${res.minTotal} severe crashes in the period are excluded — a ${one} going `
    + `from 1 to 3 is a 200% rise and means nothing.`);
  note(box,
    'A change here is a change in <em>recorded</em> crashes. Reporting practice, '
    + 'population and traffic volume all moved over the decade, and none of them '
    + 'are controlled for.');

  setReportData(state.map,
    { areas: areasFor(state.countyGeo, by === 'county' ? res.all : []) });
}

/* ----------------------------------------------------------- report: VRU */

function reportVru() {
  const res = rankVru(state.facts, state.mask, { top: 20 });
  const box = reportShell('Walking and biking casualties by place',
    'Incorporated cities and towns ranked by pedestrian and bicycle crashes '
    + 'that killed or seriously injured someone.');

  if (!res.rows.length) {
    box.insertAdjacentHTML('beforeend',
      '<p class="empty">No pedestrian or bicycle casualties match these filters.</p>');
    setReportData(state.map, { points: pointsFor([]) });
    return;
  }

  const max = res.rows[0].ka || 1;
  const trs = res.rows.map((d, i) => rankRow([
    String(i + 1),
    `${esc(d.label)}<span class="sub">${n(d.vru)} walk/bike crashes</span>`,
    `<span class="big">${n(d.ka)}</span>`,
    n(d.ped),
    n(d.bike),
  ], {
    // Was `state.filter.city`, which no filter ever sets -- so the highlight
    // could never be true and the row never lit.
    active: state.picked === `v${d.label}`,
    onPick: () => {
      state.picked = state.picked === `v${d.label}` ? null : `v${d.label}`;
      if (state.picked) fitToCityCrashes(d.label);
      drawReport();
    },
  }));
  box.appendChild(rankTable(['#', 'Place', 'K+A', 'Ped', 'Bike'], trs));

  note(box,
    'Pedestrian and bicycle are counted separately and a crash involving both '
    + 'counts in each, so the two columns can sum above K+A. A crash counts as '
    + 'walk/bike if either the collision type says so <em>or</em> a non-motorist '
    + 'person record exists — neither source alone is complete.');
  if (res.outside) {
    note(box,
      `Place is the legal boundary a crash point falls inside, so this table `
      + `excludes <strong>${n(res.outside)}</strong> walk/bike casualties outside `
      + `any incorporated city or town rather than attributing them to the `
      + `nearest one.`);
  }

  setReportData(state.map, { points: pointsFor([]) });
}

function drawReport() {
  if (state.filter.mode === 'intersections') reportIntersections();
  else if (state.filter.mode === 'rising') reportRising();
  else if (state.filter.mode === 'vru') reportVru();
  else if (state.filter.mode === 'wildlife') reportWildlife();
}

/** Map overlay visibility per mode. */
function syncReportLayers() {
  const m = state.filter.mode;
  const risingAreas = m === 'rising' && risingDim() === 'county';
  setReportLayers(state.map, {
    areas: risingAreas,
    points: m === 'intersections',
    // No surviving report draws the corridor overlay. Wildlife ranks signed
    // routes, and this bundle ships no route geometry to highlight.
    corridors: false,
  });
  // In Rising the crash network is dimmed to let the choropleth read, so the
  // road-segment key would be describing marks the reader can barely see.
  dimData(state.map, risingAreas);
  syncLegendForMode(m);
}

/** Swap the map legend to match what the map is currently showing. */
/** Fill the rate legend from the class breaks actually in use. */
function renderRateLegend() {
  const box = $('#legend-rate-rows');
  const note = $('#legend-rate-note');
  const info = state.rateInfo;
  box.innerHTML = '';
  if (!info || !info.breaks.length) {
    note.textContent = 'No segment has both a traffic count and crashes under '
      + 'these filters.';
    return;
  }
  const fmtv = (v) => (v >= 100 ? n(v) : v.toFixed(v >= 10 ? 0 : 1));
  // A zero class with no members is noise; over ten years almost every gated
  // segment has at least one crash, so it only appears under a filter.
  const rows = info.zero
    ? [[RATE_TOKENS[0], `0 — none under this filter (${n(info.zero)})`]]
    : [];
  const cuts = info.breaks;
  for (let i = 0; i <= cuts.length; i++) {
    const lo = i === 0 ? null : cuts[i - 1];
    const hi = i < cuts.length ? cuts[i] : null;
    rows.push([
      RATE_TOKENS[Math.min(i + 1, RATE_TOKENS.length - 1)],
      hi === null ? `over ${fmtv(lo)}`
        : lo === null ? `up to ${fmtv(hi)}`
          : `${fmtv(lo)}–${fmtv(hi)}`,
    ]);
  }
  for (const [token, label] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const sw = document.createElement('i');
    sw.className = 'lineswatch';
    sw.style.height = '5px';
    sw.style.background = `var(${token})`;
    const t = document.createElement('span');
    t.textContent = label;
    row.append(sw, t);
    box.appendChild(row);
  }
  const grey = document.createElement('div');
  grey.className = 'row';
  const gs = document.createElement('i');
  gs.className = 'lineswatch';
  gs.style.height = '2px';
  gs.style.background = 'var(--rate-none)';
  const gt = document.createElement('span');
  gt.textContent = 'no traffic count';
  grey.append(gs, gt);
  box.appendChild(grey);

  const m = state.meta.line_layer || {};
  note.innerHTML = `Crashes per 100 million vehicle-miles. Segments with none `
    + `form their own class; the rest split into four equal-count groups. `
    + `${n(info.rated)} of ${n(state.lineCount)} segments qualify — they need an `
    + `MDT traffic count and must clear the ${m.rate_min_miles ?? 0.5} mi / `
    + `${n(m.rate_min_aadt ?? 1000)} AADT stability gate. Width is flat here: a `
    + `rate is already adjusted for how busy the road is, so widening a busy `
    + `road would put back the bias the metric removes.`;
}

function syncLegendForMode(mode) {
  const box = $('#maplegend');
  const roads = $('#legend-roads');
  const rising = $('#legend-rising');
  const marks = $('#legend-marks');
  if (!box) return;
  const isRising = mode === 'rising';
  // The whole road-segment block -- ramp, width key and the Count/Rate toggle
  // -- describes a layer this bundle may not have. A county bundle built from
  // MDT's crash extract has no route geometry, and a key for lines that are
  // not on the map is worse than no key.
  roads.hidden = isRising || !state.lineCount;
  rising.hidden = !(isRising && risingDim() === 'county');
  marks.hidden = mode !== 'intersections';

  const heat = state.filter.pmode === 'heat';
  $('#legend-sev').hidden = heat;
  $('#legend-heat').hidden = !heat;
  for (const b of document.querySelectorAll('[data-pmode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.pmode === (state.filter.pmode || 'points')));
  }
  const rate = state.filter.lines === 'rate';
  $('#legend-count').hidden = rate;
  $('#legend-rate').hidden = !rate;
  for (const b of document.querySelectorAll('[data-lines]')) {
    b.setAttribute('aria-pressed', String(b.dataset.lines === state.filter.lines));
  }
  if (rate) renderRateLegend();
  $('#legend-note').textContent = isRising
    ? 'County shading is the change in fatal + serious crashes between the two '
      + 'halves of the selected years. The crash network is dimmed underneath.'
    : state.filter.lines === 'rate'
      ? 'Points appear from zoom 8.'
      : 'Line width and colour reflect the crashes matching the current filter, '
        + 'not the full ten years. Points appear from zoom 8.';
}

/* ----------------------------------------------------------------- legend */

/**
 * The map legend, drawn from the same constants the layer paint uses, so the
 * swatch widths and ramp stops cannot drift from what is rendered.
 */
function buildLegend() {
  const widths = $('#legend-width');
  widths.innerHTML = '';
  const labels = ['1 crash', `${WIDTH_STOPS[1]} crashes`, `${WIDTH_STOPS[2]}+ crashes`];
  WIDTH_STOPS.forEach((_stop, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const sw = document.createElement('i');
    sw.className = 'lineswatch';
    // Legend swatches use the z12 widths — the zoom at which a reader is
    // actually comparing segments — floored so the thinnest still reads.
    sw.style.height = `${Math.max(2, WIDTH_PX[12][i])}px`;
    const t = document.createElement('span');
    t.textContent = labels[i];
    row.append(sw, t);
    widths.appendChild(row);
  });

  const ramp = $('#legend-ramp');
  ramp.innerHTML = '';
  for (const token of KA_TOKENS) {
    const i = document.createElement('i');
    i.style.background = `var(${token})`;
    ramp.appendChild(i);
  }

  const dramp = $('#legend-divramp');
  dramp.innerHTML = '';
  for (const token of ['--div-cool-2', '--div-cool-1', '--div-mid',
                       '--div-warm-1', '--div-warm-2']) {
    const i = document.createElement('i');
    i.style.background = `var(${token})`;
    dramp.appendChild(i);
  }

  const sev = kabcoColors();
  const sevBox = $('#legend-sev');
  sevBox.innerHTML = '';
  for (const k of KABCO_ORDER) {
    const row = document.createElement('div');
    row.className = 'row';
    const d = document.createElement('i');
    d.className = 'dot';
    d.style.background = sev[k];
    const t = document.createElement('span');
    t.textContent = `${k} · ${KABCO_LABEL[k]}`;
    row.append(d, t);
    sevBox.appendChild(row);
  }

  // What the lines encode. It lives in the legend because changing it changes
  // what the legend says.
  // How crashes are drawn. Same shape as the line-mode control below, and it
  // lives in the legend for the same reason: switching it changes what the
  // legend has to say.
  for (const b of document.querySelectorAll('[data-pmode]')) {
    if (!b.dataset.wired) {
      b.dataset.wired = '1';
      b.addEventListener('click', () => {
        const next = b.dataset.pmode;
        if (next === (state.filter.pmode || 'points')) return;
        state.filter.pmode = next;
        setPointMode(state.map, next);
        syncLegendForMode(state.mode);
      });
    }
  }

  for (const b of document.querySelectorAll('[data-lines]')) {
    b.setAttribute('aria-pressed', String(b.dataset.lines === state.filter.lines));
    if (!b.dataset.wired) {
      b.dataset.wired = '1';
      b.addEventListener('click', () => {
        if (b.dataset.lines === state.filter.lines) return;
        state.filter.lines = b.dataset.lines;
        writeHash(state.filter, state.meta, { replace: true });
        recompute({ moveMap: false });
      });
    }
  }

  const btn = $('#legendtoggle');
  // A legend that covers a third of a phone screen is not a legend; start it
  // collapsed there and let the reader open it.
  if (matchMedia('(max-width: 720px)').matches && !btn.dataset.init) {
    $('#maplegend').classList.add('collapsed');
    btn.textContent = 'Legend';
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.dataset.init = '1';
  btn.addEventListener('click', () => {
    const box = $('#maplegend');
    const open = !box.classList.toggle('collapsed');
    btn.textContent = open ? 'Hide' : 'Legend';
    btn.setAttribute('aria-expanded', String(open));
  });
}

/* ----------------------------------------------------------------- chrome */

function renderVintage() {
  const d = state.meta.data;
  $('#vintage').textContent =
    `${Number(d.rows).toLocaleString()} crashes · ${d.year_min}–${d.year_max}`;
}

function renderTilesFromSummary() {
  const s = state.summary.statewide;
  drawTiles({
    total: s.total, K: s.K, A: s.A, KA: s.KA,
    kaShare: s.total ? (s.KA / s.total) * 100 : 0,
  });
}

/* Built for the opening splash, which runs BEFORE the fact table finishes
   loading -- so the bundle size here comes from summary.json, not from
   state.facts.n, which is still 0 at that moment. */
function renderAbout() {
  const m = state.meta;
  const box = $('#aboutbody');
  const fields = m.fields || {};
  const caveated = Object.entries(fields)
    .filter(([, v]) => v.caveat)
    .map(([k, v]) => `<li><strong>${fields[k].label || k}</strong> — ${v.caveat}</li>`)
    .join('');
  const cov = m.source?.coordinate_coverage || {};
  box.innerHTML = `
    <h2>About this dashboard</h2>
    <p>${m.disclaimer}</p>
    <h3>What the data is</h3>
    <p>${m.attribution} Source: ${m.source.agency}, datasets
      <code>${m.source.datasets.join('</code>, <code>')}</code>, plus
      <a href="${esc(safeUrl(m.source.rest_service) ?? '#')}"
        rel="noreferrer noopener">MDT's public crash map service</a>.
      Built ${m.generated}.</p>
    <p>${m.source.coordinate_recovery}</p>
    ${cov.geocoded ? `<p>Geocoded: ${Number(cov.geocoded).toLocaleString()} of
      ${Number(m.data.rows).toLocaleString()} crashes
      (${Number(cov.geocoded_pct).toFixed(3)}%).</p>` : ''}
    <h3>Read these fields carefully</h3>
    <ul class="caveats">${caveated}</ul>
    <h3>What is published here</h3>
    <p>${m.disclosure_policy.rule}</p>
    <ul>${Object.entries(m.disclosure_policy.minimized_here)
      .map(([k, v]) => `<li><strong>${k}</strong>: ${v}</li>`).join('')}</ul>
    ${m.scope ? `<h3>This bundle covers ${esc(m.scope.label)} only</h3>
      <p>${esc(m.scope.note)}</p>
      ${m.scope.severity_coding ? `<p>${esc(m.scope.severity_coding.caveat)}</p>` : ''}
      ${m.scope.reference_population ? `<p>${esc(m.scope.reference_population.caveat)}</p>` : ''}
      ${m.scope.sample_size ? `<p>${esc(m.scope.sample_size.caveat)}</p>` : ''}
      ${m.scope.boundary ? `<p>${esc(m.scope.boundary)}</p>` : ''}` : ''}
    <h3>Legal note</h3>
    <p>${m.section_407}</p>
    <h3>Points and heatmap</h3>
    <p>The crash points have two views. <strong>Points</strong> draws one mark
      per crash, coloured by KABCO severity. <strong>Heatmap</strong> draws the
      density of the same crashes — the very same records the current filter
      selects, so the two views cannot disagree about what is on screen.</p>
    <p>The heatmap weights every crash equally. It is a map of <em>how many</em>,
      not of how bad: a dense cluster of property-damage crashes burns as hot as
      a dense cluster of fatal ones. Use the severity filter to ask the other
      question. Its colours are deliberately not the red-orange a heatmap
      usually reaches for, because on this map those are severity's colours and
      a hot spot would read as a fatality.</p>
    <p>Nothing is sampled. The point layer thins itself above 60,000 marks and
      this bundle holds ${n(state.summary?.statewide?.total ?? 0)} crashes, so
      every crash matching your filter is in both views.</p>
    ${county.plannedProjects ? `
    <h3>Planned projects</h3>
    <p>The optional &ldquo;Planned projects&rdquo; overlay is
      ${esc(county.plannedProjects.attribution)}. It is read once and shipped
      with this site rather than fetched from their service, so the map works
      whether or not that service is up and this page makes no request to it.</p>
    <p>It is planned work, not crash data. A project on a road is not a safety
      finding about that road, and the absence of one is not a finding either:
      the plan reflects what has been proposed and funded, on its own timetable,
      which has nothing to do with the crash record shown here. Committed means
      funded; recommended and proposed mean neither.</p>` : ''}
    <h3>Privacy</h3>
    <p><strong>Nothing here is measured.</strong> This dashboard runs on your
      own machine, from files on your own disk. There is no analytics script,
      no beacon, no identifier and no account. Every filter, report, map
      position and download is computed locally and none of it is transmitted
      anywhere.</p>
    <p><strong>What this page stores on your machine.</strong> Four small
      values in your browser's local storage, so the page behaves the way you
      left it: <code>theme</code> (light or dark), <code>basemap</code>,
      <code>tour-done-v1</code> and <code>caveats-ack-v1</code> (so you are not
      shown the tutorial or this notice again). Clearing site data removes
      them.</p>
    <p><strong>The one request that leaves your machine.</strong> Map tiles.
      The basemap under the crash points is fetched from the tile provider
      chosen in the configuration, which therefore sees your requests for the
      areas you look at, as any map service does. Choosing the
      <strong>none</strong> basemap removes even that, and the crash data,
      every chart and every report work exactly the same without it.</p>
    ${m.line_layer ? `<h3>Map generalization</h3><p>Route lines are simplified to
      ${m.line_layer.simplify_m} m for transfer — under one screen pixel at the
      zooms this screening layer is read. Crash points keep full coordinate
      precision.</p>` : ''}
  `;
  for (const el of box.querySelectorAll('.caveats li')) {
    el.classList.add('caveat');
  }
  $('#footnote').textContent = m.attribution;
}

/* --------------------------------------------------------------- controls */

function buildControls() {
  const f = state.filter;
  const d = defaultState(state.meta);

  // Year range — two sliders rather than a single brush, so it is keyboard
  // operable without a custom widget.
  const y0 = $('#y0'), y1 = $('#y1');
  for (const el of [y0, y1]) {
    el.min = d.y0; el.max = d.y1; el.step = 1;
  }
  y0.value = f.y0; y1.value = f.y1;
  const clampYears = (moved) => {
    let a = Number(y0.value), b = Number(y1.value);
    if (a > b) { if (moved === 'lo') b = a; else a = b; y0.value = a; y1.value = b; }
    state.filter.y0 = a; state.filter.y1 = b;
    $('#yearout').textContent = a === b ? `${a}` : `${a}–${b}`;
    commit();
  };
  y0.addEventListener('input', () => clampYears('lo'));
  y1.addEventListener('input', () => clampYears('hi'));
  $('#yearout').textContent = f.y0 === f.y1 ? `${f.y0}` : `${f.y0}–${f.y1}`;

  // Severity chips carry the ramp swatch, so identity never rests on position.
  const sev = kabcoColors();
  const sevBox = $('#sevchips');
  sevBox.innerHTML = '';
  for (const k of KABCO_ORDER) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.dataset.sev = k;
    b.setAttribute('aria-pressed', String(f.sev.includes(k)));
    b.innerHTML = `<span class="swatch" style="background:${sev[k]}"></span>${k}`;
    b.title = KABCO_LABEL[k];
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      const set = new Set(state.filter.sev);
      if (on) set.delete(k); else set.add(k);
      state.filter.sev = [...set];
      commit();
    });
    sevBox.appendChild(b);
  }
  $('#sevclear').addEventListener('click', () => {
    state.filter.sev = [];
    syncControls(); commit();
  });

  // Factor chips.
  const facBox = $('#facchips');
  facBox.innerHTML = '';
  for (const [key, label] of FACTORS) {
    if (!state.facts.flagCols.includes(key)) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.dataset.factor = key;
    b.setAttribute('aria-pressed', String(f.factors.includes(key)));
    b.textContent = label;
    if (SUSPICION_FIELDS.has(key)) {
      b.title = state.meta.fields?.[key]?.caveat || label;
      b.insertAdjacentHTML('beforeend', ' <span class="n" aria-hidden="true">?</span>');
    }
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      const set = new Set(state.filter.factors);
      if (on) set.delete(key); else set.add(key);
      state.filter.factors = [...set];
      commit();
    });
    facBox.appendChild(b);
  }
  $('#facclear').addEventListener('click', () => {
    state.filter.factors = [];
    syncControls(); commit();
  });

  // A county filter inside a single-county bundle filters nothing, so the
  // control is removed rather than left showing one option.
  if (state.scope?.kind === 'county') {
    const grp = $('#county')?.closest('.group');
    if (grp) grp.hidden = true;
  }

  // County select, ordered by crash count so the big ones are reachable.
  const cty = $('#county');
  cty.innerHTML = '<option value="">All counties</option>';
  for (const d2 of domain(state.facts, 'county')) {
    const o = document.createElement('option');
    o.value = d2.value;
    o.textContent = `${d2.value} (${n(d2.n)})`;
    cty.appendChild(o);
  }
  cty.value = f.county || '';
  cty.addEventListener('change', () => {
    state.filter.county = cty.value || null;
    commit({ moveMap: true });
  });

  // Collision type, same shape as county. This filter could previously only be
  // set by clicking a bar in the chart -- a bare SVG rect with a click handler,
  // which no keyboard can reach.
  const ct = $('#ctype');
  ct.innerHTML = '<option value="">All collision types</option>';
  for (const d2 of domain(state.facts, 'collision_type')) {
    const o = document.createElement('option');
    o.value = d2.value;
    o.textContent = `${d2.value} (${n(d2.n)})`;
    ct.appendChild(o);
  }
  ct.value = f.ctype || '';
  ct.addEventListener('change', () => {
    state.filter.ctype = ct.value || null;
    commit();
  });

  $('#reset').addEventListener('click', () => {
    state.filter = defaultState(state.meta);
    syncControls();
    commit({ moveMap: true });
  });

  $('#copylink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      const b = $('#copylink');
      const was = b.textContent;
      b.textContent = 'Link copied';
      setTimeout(() => { b.textContent = was; }, 1400);
    } catch { /* clipboard blocked — the URL is in the address bar regardless */ }
  });
}

function syncControls() {
  const f = state.filter;
  $('#y0').value = f.y0; $('#y1').value = f.y1;
  $('#yearout').textContent = f.y0 === f.y1 ? `${f.y0}` : `${f.y0}–${f.y1}`;
  for (const b of document.querySelectorAll('[data-sev]')) {
    b.setAttribute('aria-pressed', String(f.sev.includes(b.dataset.sev)));
  }
  for (const b of document.querySelectorAll('[data-factor]')) {
    b.setAttribute('aria-pressed', String(f.factors.includes(b.dataset.factor)));
  }
  const cty = $('#county');
  if (cty) cty.value = f.county || '';
  const ct = $('#ctype');
  if (ct) ct.value = f.ctype || '';
}

/**
 * Name every active filter, and let each be removed on its own.
 *
 * A filter set by clicking a chart bar was effectively invisible: the county
 * select did sync, and the collision type grew a chip inside a stat tile, but
 * neither announces itself, and the only global escape was a "Reset all" button
 * sitting in the Years group header where it read as "reset the years".
 */
function syncActiveFilters() {
  const box = $('#activefilters');
  const chips = $('#activechips');
  if (!box || !chips) return;
  const f = state.filter;
  const d = defaultState(state.meta);
  const items = [];

  if (f.y0 !== d.y0 || f.y1 !== d.y1) {
    items.push({ label: `Years: ${f.y0 === f.y1 ? f.y0 : `${f.y0}–${f.y1}`}`,
      clear: () => { f.y0 = d.y0; f.y1 = d.y1; } });
  }
  if (f.sev.length) {
    items.push({ label: `Severity: ${KABCO_ORDER.filter((k) => f.sev.includes(k)).join(', ')}`,
      clear: () => { f.sev = []; } });
  }
  for (const key of f.factors) {
    const label = (FACTORS.find(([k]) => k === key) || [, key])[1];
    items.push({ label, clear: () => { f.factors = f.factors.filter((x) => x !== key); } });
  }
  if (f.county) items.push({ label: `County: ${f.county}`, clear: () => { f.county = null; } });
  if (f.ctype) items.push({ label: `Collision: ${f.ctype}`, clear: () => { f.ctype = null; } });

  box.hidden = !items.length;
  chips.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip removable';
    b.innerHTML = `${esc(it.label)} <span aria-hidden="true">✕</span>`;
    b.title = `Remove: ${it.label}`;
    b.setAttribute('aria-label', `Remove filter ${it.label}`);
    b.addEventListener('click', () => {
      it.clear();
      syncControls();
      commit({ moveMap: true });
    });
    chips.appendChild(b);
  }
}

let commitTimer = null;
function commit(opts = {}) {
  // Sliders fire continuously; coalesce to one pass per frame-ish.
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    writeHash(state.filter, state.meta, { replace: true });
    recompute(opts);
  }, 40);
}

/* -------------------------------------------------------------- recompute */

function recompute({ moveMap = false } = {}) {
  if (!state.facts) return;
  // Here rather than in syncControls(): every filter change runs recompute,
  // but several commit without touching the controls, and the summary has to
  // be true after all of them.
  syncActiveFilters();
  const t0 = performance.now();
  const { mask, kept } = applyFilter(state.facts, state.filter);
  state.mask = mask; state.kept = kept;

  drawTiles(headline(state.facts, mask, kept));

  // The network is painted before the legend is drawn: the rate legend prints
  // the class breaks, and those are a product of this pass. Drawing the legend
  // first showed the previous filter's breaks — and nothing at all on the first
  // pass, when there were none yet.
  if (state.map && state.lineCount) {
    const totals = segmentTotals(state.facts, mask);
    // Crash counts go on in BOTH modes. They are what the segment popup reads,
    // and they are not a property of how the lines happen to be coloured: rate
    // mode used to paint only `rc` and `rate`, after wiping the state, so every
    // popup opened in that mode reported "Crashes (filtered) 0" while the
    // report beside it counted the same segment correctly. setFeatureState
    // merges, so the rate pass below adds to these rather than replacing them.
    paintSegments(state.map, totals);
    state.rateInfo = state.filter.lines === 'rate'
      ? paintSegmentRates(totals)
      : null;
    setLineMode(state.map, state.filter.lines);
  }

  if (state.filter.mode === 'explore') drawCharts();
  else drawReport();
  syncReportLayers();
  if (state.map) {
    const { drawn, stride } = paintPoints(state.facts, state.map, mask, kept);
    $('#pointnote').textContent = stride > 1
      ? `showing 1 in ${stride} crash points (${n(drawn)} of ${n(kept)}); charts and lines use all ${n(kept)}`
      : '';
  }

  if (moveMap && state.filter.county) zoomToCounty(state.filter.county);

  const ms = Math.round(performance.now() - t0);
  $('#perf').textContent = `${n(kept)} crashes · filtered in ${ms} ms`;
}

function zoomToCounty(name) {
  const src = state.map.getSource('counties');
  if (!src || !src._data) return;
  const f = src._data.features?.find(
    (x) => (x.properties.NAME || '').toLowerCase() === name.toLowerCase(),
  );
  if (!f) return;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else c.forEach(walk);
  };
  walk(f.geometry.coordinates);
  state.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 40, duration: 600 });
}

/**
 * Frame a place's matching crashes.
 *
 * The summary carries no coordinates and places.geojson is only fetched for the
 * Minimal basemap, so there is no place geometry to fly to. The fact table has
 * both the city and the coordinates in memory already, and framing the crashes
 * themselves is the better answer anyway: it shows the reader the records the
 * row is counting rather than a point the town is named after.
 */
function fitToCityCrashes(label) {
  const f = state.facts;
  const cityCol = f?.cols?.city;
  if (!cityCol || !f.cols.lon) return;
  const code = cityCol.values.indexOf(label);
  if (code < 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hits = 0;
  for (let r = 0; r < f.n; r++) {
    if (!state.mask[r] || cityCol.codes[r] !== code) continue;
    const x = f.cols.lon[r], y = f.cols.lat[r];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    hits++;
  }
  if (!hits) return;
  // A single crash gives a zero-area box, which fitBounds resolves to maximum
  // zoom; pad it to something a reader can orient in.
  if (maxX - minX < 0.01) { minX -= 0.005; maxX += 0.005; }
  if (maxY - minY < 0.01) { minY -= 0.005; maxY += 0.005; }
  state.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 48, duration: 600 });
  state.collapseSheet?.();
}

/* ------------------------------------------------------------------ tiles */

function drawTiles(h) {
  $('#t-total').textContent = n(h.total);
  $('#t-ka').textContent = n(h.KA);
  $('#t-kashare').textContent = pct(h.kaShare);
  $('#t-k').textContent = n(h.K);
  $('#t-k-sub').textContent = h.fatalInjuries
    ? `${n(h.fatalInjuries)} fatal injuries` : '';
}

/* ----------------------------------------------------------------- charts */

const tableOpen = new Set();

function wireTableToggle(id, build) {
  const btn = document.querySelector(`[data-table="${id}"]`);
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    if (tableOpen.has(id)) tableOpen.delete(id); else tableOpen.add(id);
    btn.textContent = tableOpen.has(id) ? 'Chart' : 'Table';
    build();
  });
}

function showAs(id, svgSel, tableSel) {
  const open = tableOpen.has(id);
  document.querySelector(svgSel).style.display = open ? 'none' : '';
  document.querySelector(tableSel).hidden = !open;
  return open;
}

function drawCharts() {
  const { facts, mask } = state;
  const f = state.filter;
  const sevColors = kabcoColors();

  /* 1. Crashes by year — single series, slot 1. */
  const byYear = countByInt(facts, mask, 'year',
    state.meta.data.year_min, state.meta.data.year_max);
  wireTableToggle('year', drawCharts);
  if (!showAs('year', '#c-year', '#tb-year')) {
    columns($('#c-year'), byYear, {
      labelEvery: byYear.length > 8 ? 2 : 1,
      tipTitle: (d) => String(d.label),
      tipRows: (d) => [['Crashes', n(d.n)]],
    });
  } else {
    table($('#tb-year'), `Crashes by year, ${f.y0}–${f.y1}`,
      ['Year', 'Crashes'], byYear.map((d) => [String(d.label), n(d.n)]));
  }

  /* 2. Severity mix — the ordinal KABCO ramp, with a legend (always, since it
        is more than one series) plus in-mark labels where they fit. */
  const sev = severityCounts(facts, mask);
  wireTableToggle('sev', drawCharts);
  const sevTotal = sev.reduce((a, d) => a + d.n, 0);
  if (!showAs('sev', '#c-sev', '#tb-sev')) {
    stack($('#c-sev'), sev.map((d) => ({
      ...d,
      // K and A are dark enough that white reads better inside the fill.
      onDark: d.key === 'K' || d.key === 'A',
    })), { colorOf: (d) => sevColors[d.key] });
    legend($('#l-sev'), sev.filter((d) => d.n > 0)
      .map((d) => ({ label: `${d.key} · ${d.label}`, color: sevColors[d.key] })));
  } else {
    $('#l-sev').innerHTML = '';
    table($('#tb-sev'), 'Crashes by KABCO severity',
      ['Severity', 'Crashes', 'Share'],
      sev.map((d) => [
        `${d.key} · ${d.label}`, n(d.n),
        sevTotal ? pct((d.n / sevTotal) * 100) : '—',
      ]));
  }

  /* 3. Hour of day — single series. */
  const byHour = countByInt(facts, mask, 'hour', 0, 23);
  wireTableToggle('hour', drawCharts);
  if (!showAs('hour', '#c-hour', '#tb-hour')) {
    columns($('#c-hour'), byHour, {
      labelEvery: 6,
      tickLabel: (d) => `${String(d.label).padStart(2, '0')}`,
      tipTitle: (d) => `${String(d.label).padStart(2, '0')}:00–${String(d.label).padStart(2, '0')}:59`,
      tipRows: (d) => [['Crashes', n(d.n)]],
    });
  } else {
    table($('#tb-hour'), 'Crashes by hour of day',
      ['Hour', 'Crashes'],
      byHour.map((d) => [`${String(d.label).padStart(2, '0')}:00`, n(d.n)]));
  }

  /* 4. Collision types — ranked bars, one colour, clickable to filter. The
        tail folds into one labelled bucket rather than growing new hues. */
  const byType = countBy(facts, mask, 'collision_type', { top: 8 });
  wireTableToggle('ctype', drawCharts);
  if (!showAs('ctype', '#c-ctype', '#tb-ctype')) {
    bars($('#c-ctype'), byType, {
      activeLabel: f.ctype,
      tipRows: (d) => [
        ['Crashes', n(d.n)],
        ['Share', state.kept ? pct((d.n / state.kept) * 100) : '—'],
        ...(d.isOther ? [] : [['', 'Click to filter']]),
      ],
      onPick: (d) => {
        state.filter.ctype = state.filter.ctype === d.label ? null : d.label;
        commit();
      },
    });
  } else {
    table($('#tb-ctype'), 'Crashes by collision type',
      ['Collision type', 'Crashes'], byType.map((d) => [String(d.label), n(d.n)]));
  }

  /* 5. Counties — ranked bars, clickable. Inside a single county the bars
        would be one bar, so the dimension becomes the places within it. */
  const geoDim = state.scope?.kind === 'county' ? 'city' : 'county';
  const geoHead = document.querySelector('[data-table="county"]')?.closest('header')
    ?.querySelector('h3');
  if (geoHead) geoHead.textContent = geoDim === 'city' ? 'Places' : 'Counties';
  const byCounty = countBy(facts, mask, geoDim, { top: 10 });
  wireTableToggle('county', drawCharts);
  if (!showAs('county', '#c-county', '#tb-county')) {
    bars($('#c-county'), byCounty, {
      activeLabel: geoDim === 'county' ? f.county : null,
      tipRows: (d) => (geoDim === 'county'
        ? [['Crashes', n(d.n)], ['', 'Click to filter']]
        : [['Crashes', n(d.n)]]),
      // Places are shown for orientation only: there is no city filter to
      // toggle, so the bars are deliberately not clickable in a county build.
      onPick: geoDim !== 'county' ? undefined : (d) => {
        state.filter.county = state.filter.county === d.label ? null : d.label;
        syncControls();
        commit({ moveMap: true });
      },
    });
  } else {
    table($('#tb-county'), `Crashes by ${geoDim === 'city' ? 'place' : 'county'}`,
      [geoDim === 'city' ? 'Place' : 'County', 'Crashes'],
      byCounty.map((d) => [String(d.label), n(d.n)]));
  }

  const chip = $('#ctypechip');
  chip.hidden = !f.ctype;
  if (f.ctype) chip.textContent = `Collision type: ${f.ctype} ✕`;
}

/* --------------------------------------------------------- segment popups */

/** Route a map pick to the right popup. */
function handlePick({ kind, feature, lngLat }) {
  if (kind === 'point') pickCrash(feature, lngLat);
  else if (kind === 'report') pickReportPoint(feature, lngLat);
  else pickSegment(feature, lngLat);
}

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Popup for one crash, read out of the fact table by row index.
 *
 * Shows what the public tier actually carries: month and hour rather than the
 * exact timestamp, conditions, and whichever factors are set. The officer-
 * assessment fields are labelled as suspected, in the same words as the filter
 * rail and meta.json, so the caveat travels with the individual record too.
 */
function pickCrash(feature, lngLat) {
  const r = Number(feature.properties?.i);
  const c = state.facts?.cols;
  if (!c || !Number.isFinite(r)) return;

  // Test `.codes`, not `.values`: every typed array inherits a `values()`
  // iterator from TypedArray.prototype, so a truthiness check on `.values`
  // matches the numeric columns too and then dereferences a missing `.codes`.
  const val = (name) => {
    const col = c[name];
    if (!col) return null;
    if (col.codes) return col.values[col.codes[r]];
    const v = col[r];
    return v === -1 || Number.isNaN(v) ? null : v;
  };
  const sev = val('kabco') || 'U';
  const hour = val('hour');
  const month = val('month');

  const rows = [
    ['Severity', `${sev} · ${KABCO_LABEL[sev] || 'Unknown'}`],
    ['When', [month ? MONTHS[month] : null, val('year'),
              hour === null ? null : `${String(hour).padStart(2, '0')}:00`]
             .filter(Boolean).join(' · ')],
    ['Collision', val('collision_type') || '—'],
    ['Where', [val('city'), val('county')].filter(Boolean).join(', ') || '—'],
    // MDT's corridor identifier, labelled as one. It is not a road name and
    // there is no table in the extract that turns it into one.
    ['MDT corridor', [val('corridor'), val('road_system')].filter(Boolean).join(' · ') || '—'],
    ['Conditions', [val('weather'), val('surface'), val('lighting')]
      .filter((x) => x && x !== 'Unknown').join(' · ') || '—'],
    ['People', `${val('person_count') ?? 0} in ${val('veh_count') ?? 0} vehicle(s)`],
  ];

  const flagLabels = {
    is_intersection: 'Intersection-related', is_vru: 'Pedestrian or bicycle',
    work_zone: 'Work zone', motorcycle_involved: 'Motorcycle',
    heavy_truck_involved: 'Heavy truck', hit_and_run: 'Hit and run',
    occupant_ejected: 'Occupant ejected',
    unrestrained_occupant: 'Unrestrained occupant',
    alcohol_suspected: 'Alcohol suspected', drug_suspected: 'Drugs suspected',
    distracted_driver: 'Distraction indicated',
    fatigued_driver: 'Fatigue indicated',
  };
  const flags = Object.entries(flagLabels)
    .filter(([k]) => (c.flags[r] & (FLAG_BIT[k] ?? 0)) !== 0)
    .map(([, label]) => label);

  const html = `<div class="popup-title">Crash record</div>
    <div class="popup-sub">${esc([val('dow'), timeBin(hour)]
      .filter(Boolean).join(' · ') || 'MDT crash record')}</div>
    ${rows.map(([k, v]) =>
      `<div class="popup-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
    ${flags.length ? `<div class="popup-flags">${flags.map((f) =>
      `<span>${esc(f)}</span>`).join('')}</div>` : ''}
    ${flags.some((f) => /suspected|indicated/.test(f))
      ? '<p class="popup-note">Suspected and indicated factors are the '
        + 'investigating officer\u2019s field assessment, not a toxicology '
        + 'result or a conviction.</p>' : ''}`;
  popup(state.map, lngLat, html);
}

/** Popup for a ranked location in the intersections report. */
function pickReportPoint(feature, lngLat) {
  const p = feature.properties || {};
  const html = `<div class="popup-title">${esc(p.label || 'Ranked location')}</div>
    <div class="popup-sub">rank ${esc(p.rank)} in the current report</div>
    <div class="popup-row"><span>Fatal + serious</span><b>${esc(p.ka ?? '—')}</b></div>`;
  popup(state.map, lngLat, html);
}

function pickSegment(feature, lngLat) {
  const p = feature.properties || {};
  const st = state.map.getFeatureState({ source: 'lines', id: feature.id }) || {};
  const total = st.t || 0, ka = st.ka || 0;
  // The line layer's own properties are coded for size; segmentExposure() is
  // the decoded form, built once when the file loaded.
  const d = segmentExposure().get(p.i) || {};
  const miles = Number(d.miles) || 0;
  const rows = [
    ['Crashes (filtered)', n(total)],
    ['Fatal + serious', n(ka)],
    ['Segment length', `${miles.toFixed(2)} mi`],
    ...(miles > 0 ? [['Crashes per mile', (total / miles).toFixed(1)]] : []),
    ['County', d.county ? String(d.county).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '—'],
    ['Place', d.place || '—'],
    ['System', d.system || '—'],
  ];
  const title = d.route || `Segment ${p.i}`;
  // Classes rather than inline style, so the popup picks up the theme tokens —
  // MapLibre's own stylesheet hard-codes a white panel and dark close button.
  const html = `<div class="popup-title">${esc(title)}</div>
    <div class="popup-sub">mile ${Number(d.from).toFixed(1)}–${Number(d.to).toFixed(1)}</div>
    ${rows.map(([k, v]) =>
      `<div class="popup-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}`;
  popup(state.map, lngLat, html);
}

/* ------------------------------------------------------------------ theme */

function initTheme() {
  const saved = (() => {
    try { return localStorage.getItem('theme'); } catch { return null; }
  })();
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.dataset.theme = saved;
  }
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
    if (followsTheme(state.basemap)) {
      // The light and dark styles are different documents, so the basemap has
      // to be reloaded rather than repainted.
      applyBasemap(state.basemap);
    } else {
      applyThemeToMap(state.map);
    }
    if (state.facts) { buildLegend(); drawCharts(); }
  });
}

/* ------------------------------------------------------------------- tour */

/**
 * Hand the tour the few verbs it needs to put the dashboard into the state each
 * step describes. It drives the app through the same paths the UI does, so a
 * step can never show something the interface cannot actually reach.
 */
function initTour() {
  const tour = createTour({
    /* The tour quotes figures at the reader. They come from the same bundle
       the About sheet reads, so the two can never disagree -- and switching
       counties needs no figure re-derived by hand. */
    scope: () => state.meta?.scope || null,
    topPlace: () => state.meta?.scope?.focus?.name
      || state.summary?.cities?.[0]?.city || null,
    setMode(mode) {
      if (state.filter.mode === mode) return;
      state.filter.mode = mode;
      state.picked = null;
      syncModeButtons();
      writeHash(state.filter, state.meta, { replace: true });
      recompute({ moveMap: false });
    },
    setLines(lines) {
      if (state.filter.lines === lines) return;
      state.filter.lines = lines;
      writeHash(state.filter, state.meta, { replace: true });
      recompute({ moveMap: false });
    },
    // Driven through the real controls rather than a parallel code path, so
    // a tour step can never demonstrate something the interface cannot do.
    setPoints(mode) {
      const cur = state.filter.pmode || 'points';
      if (cur === mode) return;
      document.querySelector(`[data-pmode="${mode}"]`)?.click();
    },
    setPlanned(on) {
      const t = $('#lrtptoggle');
      if (!t || t.hidden || lrtpIsVisible() === on) return;
      t.click();
    },
    openSheet() { state.expandSheet?.(); },
    flyHome() {
      if (!state.map) return;
      fitMontana();
    },
  });
  state.tour = tour;
  $('#tourbtn')?.addEventListener('click', () => tour.start());
  $('#abouttour')?.addEventListener('click', () => {
    dismissSplash();
    // Wait for the splash's collapse animation so the first step is not
    // measured against a dialog that is still on screen.
    setTimeout(() => tour.start(), 420);
  });
  return tour;
}

/* ------------------------------------------------------------------- about */

/* Bumping this re-shows the splash to everyone, which is what should happen if
   the disclaimer's substance changes. It is deliberately not the build date —
   nobody needs the caveats again because the data was refreshed. */
const CAVEAT_VERSION = 1;
const SEEN_KEY = `caveats-ack-v${CAVEAT_VERSION}`;

function hasAcknowledged() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

function openAbout({ splash = false } = {}) {
  const dlg = $('#about');
  dlg.classList.toggle('is-splash', splash);
  $('#aboutfoot').hidden = !splash;
  $('#aboutclose').hidden = splash;
  document.querySelector('.app')?.classList.toggle('is-splash', splash);
  dlg.showModal();
  if (splash) $('#aboutproceed')?.focus();
}

/**
 * Dismiss the splash by collapsing the dialog toward the button that reopens
 * it, so the relationship between the two is shown rather than described.
 */
function dismissSplash() {
  const dlg = $('#about');
  const btn = $('#aboutbtn');
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
  document.querySelector('.app')?.classList.remove('is-splash');

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finish = () => {
    dlg.close();
    dlg.classList.remove('is-splash');
    $('#aboutfoot').hidden = true;
    $('#aboutclose').hidden = false;
    btn?.classList.add('aboutbtn-pulse');
    setTimeout(() => btn?.classList.remove('aboutbtn-pulse'), 600);
    // Now that the filter is off .app, the sheet measures correctly and the
    // opening extent can be computed against the real layout.
    requestAnimationFrame(() => {
      if (!state.map) return;
      state.map.resize();
      if (!state.hadMapInHash) fitMontana();
      constrainToMontana(state.map);
    });
  };

  if (reduce || !btn || !dlg.animate) { finish(); return; }
  const a = dlg.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
  const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
  const scale = Math.max(0.05, b.width / Math.max(a.width, 1));
  const anim = dlg.animate([
    { transform: 'translate(0,0) scale(1)', opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
  ], { duration: 340, easing: 'cubic-bezier(.4,0,.2,1)' });
  anim.onfinish = finish;
  anim.oncancel = finish;
}

function initAbout() {
  const dlg = $('#about');
  // Both entry points are wired here rather than with an inline onclick
  // attribute: the CSP is `script-src 'self'` with no 'unsafe-inline', so an
  // inline handler is blocked in production while working fine locally.
  for (const sel of ['#aboutbtn', '#aboutbtn2']) {
    $(sel)?.addEventListener('click', () => openAbout());
  }
  $('#aboutclose').addEventListener('click', () => dlg.close());
  $('#aboutproceed').addEventListener('click', dismissSplash);
  dlg.addEventListener('click', (e) => {
    // A backdrop click dismisses the ordinary dialog, but not the splash: the
    // acknowledgement should be deliberate.
    if (e.target === dlg && !dlg.classList.contains('is-splash')) dlg.close();
  });
  dlg.addEventListener('cancel', (e) => {
    if (dlg.classList.contains('is-splash')) e.preventDefault();  // Esc too
  });
}

/* -------------------------------------------------------------------- init */

initTheme();
initAbout();
$('#ctypechip').addEventListener('click', () => {
  state.filter.ctype = null;
  // syncControls, like the active-filter chips do. Without it the filter was
  // cleared but the collision-type select kept showing the old value, so the
  // control still read as active after the chip had gone.
  syncControls();
  commit();
});
addEventListener('resize', () => { if (state.facts) drawCharts(); }, { passive: true });

boot().catch((err) => {
  console.error(err);
  const l = $('#loading');
  if (l) {
    l.innerHTML = `<div style="max-width:420px;text-align:center">
      <strong>Could not load the data.</strong><br>
      <span style="color:var(--text-secondary);font-size:12px">${err.message}</span><br>
      <span style="color:var(--text-muted);font-size:11.5px">
      Run <code>npm run data</code> to build the bundle into
      <code>public/data/</code>.</span></div>`;
  }
});
