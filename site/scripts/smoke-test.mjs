import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
/* Chrome comes from the environment, with the workstation path as the fallback.
   A CI runner puts it somewhere else, and a hard-coded path is the difference
   between a suite that runs anywhere and one that runs on one machine. */
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4321/';
const OUT = process.env.OUT_DIR || 'test-output';
// Screenshots are written unconditionally; on a fresh checkout the directory
// does not exist yet and page.screenshot would throw before any assertion ran.
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000',
         '--force-device-scale-factor=1', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const errors = [], warnings = [], failed = [], reqs = [];
page.on('console', m => {
  if (m.type() === 'error') errors.push(m.text());
  // Warnings are reported but do not fail the run. MapLibre logs genuine
  // defects at warn level -- a missing sprite image, a bad expression -- and
  // capturing only console.error left one sitting in production, unseen,
  // through several releases.
  // Puppeteer reports console.warn as 'warn'; older versions said 'warning'.
  // Matching only one of them is how this capture first shipped reporting
  // "(none)" against a page that was warning on every load.
  else if (m.type() === 'warn' || m.type() === 'warning') {
    // Headless Chrome software-renders, and says so loudly. That noise is a
    // property of this test environment, not of the page.
    if (!/WebGL|swiftshader|GPU stall|GL Driver/i.test(m.text())) warnings.push(m.text());
  }
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
/* The basemap is someone else's server. A tile that fails says nothing about
   this build, and letting it fail the suite would hand a third party a veto
   over every deploy. Reported, never fatal -- and narrowly, by origin, so a
   failure of anything we actually ship still counts. */
const THIRD_PARTY = /^https:\/\/tiles\.openfreemap\.org\//;
const thirdParty = [];
page.on('requestfailed', (r) => {
  const line = `${r.url()} — ${r.failure()?.errorText}`;
  (THIRD_PARTY.test(r.url()) ? thirdParty : failed).push(line);
});
page.on('response', r => reqs.push({ url: r.url(), status: r.status() }));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });

// Acknowledge the caveats splash, as a first-time reader must. Everything
// after this runs against the real, unblurred app.
await page.waitForFunction(
  () => document.getElementById('about')?.open || document.getElementById('loading')?.hidden,
  { timeout: 90000 });
const hadSplash = await page.evaluate(() => {
  const b = document.getElementById('aboutproceed');
  const showing = document.getElementById('about')?.classList.contains('is-splash');
  if (showing && b) { b.click(); return true; }
  return false;
});
console.log('caveats splash shown on first load:', hadSplash);
if (!hadSplash) errors.push('assert: caveats splash did not appear on a fresh profile');

// wait for the loading overlay to go away
await page.waitForFunction(
  () => { const l = document.getElementById('loading'); return l && l.hidden; },
  { timeout: 90000 });
await new Promise(r => setTimeout(r, 1200));
await new Promise(r => setTimeout(r, 2500)); // let tiles/labels settle

const probe = await page.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim() || null;
  const svgMarks = (id) => document.getElementById(id)?.querySelectorAll('path,rect,text').length || 0;
  return {
    vintage: t('vintage'), perf: t('perf'),
    tiles: { total: t('t-total'), ka: t('t-ka'), kaShare: t('t-kashare'), k: t('t-k') },
    charts: { year: svgMarks('c-year'), sev: svgMarks('c-sev'), hour: svgMarks('c-hour'),
              ctype: svgMarks('c-ctype'), county: svgMarks('c-county') },
    sevLegend: document.querySelectorAll('#l-sev .item').length,
    sevChips: document.querySelectorAll('[data-sev]').length,
    facChips: document.querySelectorAll('[data-factor]').length,
    counties: document.getElementById('county')?.options.length ?? 0,
    canvas: !!document.querySelector('#map canvas'),
    mapLayers: (() => { try { return null; } catch { return null; } })(),
  };
});

// Camera assertions. The URL hash is written on moveend and so can lag the
// map; reading the live camera is what caught a zoom floor computed for 256 px
// tiles when the basemap serves 512, which clamped a phone to half the state.
const cam = await page.evaluate(() => {
  const m = window.__map;
  if (!m) return null;
  const b = m.getBounds();
  return { zoom: m.getZoom(), minZoom: m.getMinZoom(),
    lonSpan: b.getEast() - b.getWest(),
    west: b.getWest(), east: b.getEast() };
});
console.log('=== camera ===', JSON.stringify(cam));

console.log('=== probe ===');
console.log(JSON.stringify(probe, null, 1));

// Hard assertions: these are the numbers the Python build verified against the
// master dataset, so a mismatch means the bundle and the page disagree.
// The headline figures are read from summary.json rather than written here.
// That is still a real cross-check and not a tautology: summary.json is
// computed by the Python build straight from the master table, while the tiles
// are crossfiltered from facts.parquet in the browser. Two routes, one answer.
// It also means this suite describes whichever county is built, instead of
// failing loudly the first time the app is pointed somewhere new.
const expect = (cond, msg) => { if (!cond) errors.push(`assert: ${msg}`); };
expect(probe.canvas, 'map canvas missing');
expect(cam, 'map handle not exposed');
// The subject is whatever the bundle says it is: a statewide build must show
// all of Montana, a scoped build must show its own bounds. Reading it from
// meta.json means one test describes both rather than one of them lying.
const meta = await (await fetch(`${URL.replace(/\/$/, '')}/data/meta.json`)).json()
  .catch(() => ({}));
// The opening view is the FOCUS box when the bundle names one, not the whole
// scope -- the map deliberately opens on the county seat rather than the county
// centroid. Asserting the scope bounds here would fail that on purpose.
const _f = meta?.scope?.focus?.bounds;
const want = _f
  ? { west: _f[0][0], east: _f[1][0],
      label: `${meta.scope.focus.name} (the opening focus)` }
  : meta?.scope?.bounds
  ? { west: meta.scope.bounds[0][0], east: meta.scope.bounds[1][0],
      label: meta.scope.label || 'the scoped area' }
  : { west: -116.0, east: -104.0, label: 'Montana' };
expect(cam && cam.west <= want.west + 0.01 && cam.east >= want.east - 0.01,
  `opening view does not contain ${want.label}: `
  + `${cam?.west?.toFixed(2)}..${cam?.east?.toFixed(2)}`);
expect(cam && cam.zoom >= cam.minZoom - 0.01,
  `zoom ${cam?.zoom} below its floor ${cam?.minZoom}`);
const summary = await (await fetch(`${URL.replace(/\/$/, '')}/data/summary.json`)).json()
  .catch(() => null);
const scope = summary?.statewide;
const fmt = (v) => Number(v).toLocaleString('en-US');
expect(scope, 'summary.json missing or unreadable — cannot check the tiles');
if (scope) {
  expect(probe.tiles.total === fmt(scope.total),
    `total tile was ${probe.tiles.total}, bundle says ${fmt(scope.total)}`);
  expect(probe.tiles.ka === fmt(scope.KA),
    `K+A tile was ${probe.tiles.ka}, bundle says ${fmt(scope.KA)}`);
  expect(probe.tiles.k === fmt(scope.K),
    `K tile was ${probe.tiles.k}, bundle says ${fmt(scope.K)}`);
}
// A single-county bundle removes the county control by design, so this only
// applies to a statewide build.
if (!meta?.scope) {
  expect(probe.counties === 57, `county select had ${probe.counties} options`);
}
expect(probe.sevLegend === 6, `severity legend had ${probe.sevLegend} items`);
for (const [k, v] of Object.entries(probe.charts)) {
  /* A single-county bundle has one bar to draw, so the county chart cannot
     clear this bar and should not be asked to -- the same reason the county
     select is exempt above. */
  if (k === 'county' && meta?.scope) { expect(v > 0, 'county chart drew nothing'); continue; }
  expect(v > 4, `chart ${k} rendered only ${v} marks`);
}
await page.screenshot({ path: `${OUT}/01-initial.png` });

// interact: filter to fatal + serious, 2023-2025
await page.evaluate(() => {
  document.querySelector('[data-sev="K"]').click();
  document.querySelector('[data-sev="A"]').click();
});
await new Promise(r => setTimeout(r, 900));
const after = await page.evaluate(() => ({
  total: document.getElementById('t-total').textContent,
  kaShare: document.getElementById('t-kashare').textContent,
  hash: location.hash,
  perf: document.getElementById('perf').textContent,
}));
console.log('=== after severity filter K+A ===');
console.log(JSON.stringify(after, null, 1));
if (scope) {
  expect(after.total === fmt(scope.KA),
    `K+A filter gave ${after.total}, bundle says ${fmt(scope.KA)}`);
}
// The hash also carries the map view, which fitBounds writes on moveend, so
// assert the filter is present rather than pinning the whole string.
expect(after.hash.includes('sev=KA'), `hash was ${after.hash}`);
await page.screenshot({ path: `${OUT}/02-filtered.png` });

// a factor filter
await page.evaluate(() => document.querySelector('[data-factor="alcohol_suspected"]')?.click());
await new Promise(r => setTimeout(r, 900));
const afterAlc = await page.evaluate(() => ({
  total: document.getElementById('t-total').textContent,
  hash: location.hash,
}));
console.log('=== + alcohol_suspected ===', JSON.stringify(afterAlc));
/* No precomputed cross-tab of severity against factor exists to check this
   against, so assert the shape rather than a number: combining filters must
   narrow the set without emptying it. That still catches a factor chip that
   does nothing, one that clears the severity filter, and one that matches
   everything -- which is every way this has actually broken. */
const alcN = Number(String(afterAlc.total).replace(/,/g, ''));
const kaN = scope ? scope.KA : Infinity;
expect(alcN > 0 && alcN < kaN,
  `K+A + alcohol gave ${afterAlc.total}, which does not narrow K+A (${fmt(kaN)})`);

// table view toggle (the accessibility relief)
await page.evaluate(() => document.querySelector('[data-table="sev"]').click());
await new Promise(r => setTimeout(r, 400));
const tbl = await page.evaluate(() => {
  const t = document.querySelector('#tb-sev table');
  return { present: !!t, rows: t?.querySelectorAll('tbody tr').length ?? 0,
           caption: t?.querySelector('caption')?.textContent };
});
console.log('=== severity table view ===', JSON.stringify(tbl));
expect(tbl.present && tbl.rows === 6, 'severity table view did not render 6 rows');

// Theme toggle. Assert it CHANGES the resolved surface, not that it lands on a
// particular mode — the starting mode depends on the OS preference, and
// headless Chrome reports prefers-color-scheme: dark.
const before = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim());
await page.evaluate(() => document.getElementById('theme').click());
await new Promise(r => setTimeout(r, 1200));
const after1 = await page.evaluate(() => ({
  stamp: document.documentElement.getAttribute('data-theme'),
  surface: getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim(),
}));
await page.screenshot({ path: `${OUT}/03-theme-toggled.png` });
await page.evaluate(() => document.getElementById('theme').click());
await new Promise(r => setTimeout(r, 900));
const after2 = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim());
const themeOk = after1.surface !== before && after2 === before;
console.log('=== theme toggle ===', JSON.stringify({
  before, toggled: after1, backAgain: after2, roundTrips: themeOk }));
if (!themeOk) errors.push('theme toggle did not round-trip the surface token');

// about dialog
await page.evaluate(() => document.getElementById('aboutbtn').click());
await new Promise(r => setTimeout(r, 500));
const about = await page.evaluate(() => {
  const d = document.getElementById('about');
  return { open: d.open, caveats: d.querySelectorAll('.caveat').length,
           text: d.textContent.length };
});
console.log('=== about ===', JSON.stringify(about));
expect(about.open, 'about dialog did not open');
expect(about.caveats >= 4, `about showed ${about.caveats} field caveats`);
await page.screenshot({ path: `${OUT}/04-about.png` });

console.log('\n=== console warnings (reported, not fatal) ===');
console.log(warnings.length ? [...new Set(warnings)].map(w => w.slice(0, 160)).join('\n') : '(none)');
/* Cloudflare's bot JS-detection is injected into the response by the zone's
   edge as an inline <script>, and its body embeds a per-request ray id and
   timestamp -- so it can be neither hashed nor allowlisted, and nothing in this
   repo can stop it being added. This app's CSP refuses it, which is the policy
   doing its job rather than a defect, so it must not fail the run.

   Tolerated only on evidence: the marker has to be in the HTML that was
   actually served. Without that condition an inline script of our own would
   hide behind the identical message, which is exactly the regression this
   suite exists to catch. */
const edgeInjected = (await page.content()).includes('__CF$cv$params');
const tolerated = errors.filter(e =>
  edgeInjected && /Executing inline script violates/.test(e));
const appErrors = errors.filter(e => !tolerated.includes(e));

if (tolerated.length) {
  console.log('\n=== edge-injected, refused by CSP (expected) ===');
  console.log(tolerated.map(e => e.slice(0, 120)).join('\n'));
}
console.log('\n=== console errors ===');
console.log(appErrors.length ? appErrors.slice(0, 12).join('\n') : '(none)');
console.log('=== failed requests ===');
console.log(failed.length ? failed.slice(0, 12).join('\n') : '(none)');
console.log('=== non-2xx/3xx responses ===');
const bad = reqs.filter(r => r.status >= 400 && !THIRD_PARTY.test(r.url));
const badThirdParty = reqs.filter(r => r.status >= 400 && THIRD_PARTY.test(r.url));
console.log(bad.length ? bad.map(r => `${r.status} ${r.url}`).join('\n') : '(none)');
if (thirdParty.length || badThirdParty.length) {
  console.log('=== third-party basemap, reported not fatal ===');
  console.log([...new Set([...thirdParty,
    ...badThirdParty.map(r => `${r.status} ${r.url}`)])].slice(0, 6).join('\n'));
}

await browser.close();
process.exit(appErrors.length || failed.length || bad.length ? 1 : 0);
