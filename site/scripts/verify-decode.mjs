/* Verify that what the browser decodes is what the pipeline encoded.
 *
 * The bundle crosses three format boundaries between the spreadsheet and the
 * screen, and every one of them can fail SILENTLY -- producing a dashboard
 * that renders, responds and lies:
 *
 *   1. Parquet typing. The writer infers a column's type from its first rows.
 *      A column that is non-null for the first thousand records and null after
 *      that has already broken this build once.
 *   2. Dictionary decode. Strings travel as a code plus a value table. An
 *      off-by-one in the null slot shifts every label by one category, which
 *      looks perfectly plausible on screen.
 *   3. Flag packing. Sixteen BOOLEAN columns are packed into one integer
 *      bitmask IN THE BROWSER, and the bit index is the position in
 *      FLAG_COLS. Reordering that list silently changes what every filter
 *      means.
 *
 * None of those raise an exception, so the smoke test cannot catch them. The
 * check here is a round trip against an INDEPENDENT source: summary.json is
 * computed by the pipeline from the folded rows, before any of the three
 * encodings happen. The browser recomputes the same totals from the decoded
 * parquet and its own packed flags. If the two agree on fifteen counts, the
 * chain is intact; if a bit moved, the counts move with it.
 *
 *   node scripts/verify-decode.mjs          (expects a server on :4399)
 *   SMOKE_URL=http://127.0.0.1:4631/ node scripts/verify-decode.mjs
 */
import puppeteer from 'puppeteer-core';

/* Chrome comes from the environment, with the workstation path as the fallback.
   A CI runner puts it somewhere else, and a hard-coded path is the difference
   between a suite that runs anywhere and one that runs on one machine. */
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4399/';
const BASE = URL.replace(/\/$/, '');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('about')?.open
  || document.getElementById('loading')?.hidden, { timeout: 90000 });
await page.evaluate(() => document.getElementById('aboutproceed')?.click());
await page.waitForFunction(() => document.getElementById('loading')?.hidden, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 1500));

/* The two files the pipeline wrote, read over HTTP rather than off the page,
   so the expected values never come from the thing being tested. */
const summary = await (await fetch(`${BASE}/data/summary.json`)).json();
const meta = await (await fetch(`${BASE}/data/meta.json`)).json().catch(() => ({}));
const want = summary.statewide;

const fail = [];
const need = (cond, msg) => { if (!cond) fail.push(msg); };
const eq = (got, exp, what) => need(got === exp, `${what}: decoded ${got}, pipeline says ${exp}`);

/* ---- 1. recompute every total from the decoded columns ---- */
const got = await page.evaluate(() => {
  const f = window.__facts;
  /* Spelled out rather than imported: if FLAG_COLS is reordered, this list
     keeps the OLD meaning and the comparison below fails, which is the entire
     point. Importing the list would make the test agree with the bug. */
  const FLAGS = ['is_ka', 'is_intersection', 'work_zone', 'is_vru', 'is_pedestrian',
    'is_bicycle', 'motorcycle_involved', 'heavy_truck_involved', 'hit_and_run',
    'alcohol_suspected', 'drug_suspected', 'distracted_driver', 'fatigued_driver',
    'unrestrained_occupant', 'occupant_ejected', 'is_wildlife'];
  const flags = f.cols.flags;
  const bits = {};
  FLAGS.forEach((name, i) => {
    const bit = 1 << i;
    let c = 0;
    for (let r = 0; r < f.n; r++) if (flags[r] & bit) c++;
    bits[name] = c;
  });

  const kab = f.cols.kabco;
  const sev = {};
  for (let r = 0; r < f.n; r++) {
    const v = kab.values[kab.codes[r]];
    sev[v] = (sev[v] || 0) + 1;
  }

  /* Dictionary health. Code 0 is the null slot by construction; a value
     table whose slot 0 is a real string means every code is off by one. */
  const dicts = {};
  for (const [k, v] of Object.entries(f.cols)) {
    if (!v || !v.values || !v.codes) continue;
    const real = v.values.slice(1);
    dicts[k] = {
      size: v.values.length,
      nullSlotEmpty: v.values[0] === null || v.values[0] === undefined || v.values[0] === '',
      allStrings: real.every((x) => typeof x === 'string' && x.length > 0),
      poisoned: real.filter((x) => x === 'undefined' || x === 'null' || x === 'NaN').length,
      maxCode: v.codes.reduce((a, b) => (b > a ? b : a), 0),
    };
  }

  let personK = 0; let vehNZ = 0; let perNZ = 0; let badCoord = 0; let noCoord = 0;
  for (let r = 0; r < f.n; r++) {
    personK += f.cols.person_K[r];
    if (f.cols.veh_count[r] > 0) vehNZ++;
    if (f.cols.person_count[r] > 0) perNZ++;
    const lon = f.cols.lon[r]; const lat = f.cols.lat[r];
    /* NaN is the documented sentinel for "no usable coordinate" and every
       renderer skips it. A FINITE coordinate outside Montana is the failure
       -- most of all 0,0, which is finite, plottable and wrong. */
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) { noCoord++; continue; }
    if (!(lon < -103.5 && lon > -116.5 && lat > 44.0 && lat < 49.5)) badCoord++;
  }
  return { n: f.n, bits, sev, dicts, personK, vehNZ, perNZ, badCoord, noCoord,
           cols: Object.keys(f.cols) };
});

console.log('=== decoded fact table ===');
console.log(JSON.stringify({ n: got.n, personK: got.personK, columns: got.cols.length }, null, 1));

eq(got.n, want.total, 'row count');

/* ---- 2. the packed flags, against counts taken before packing ---- */
console.log('\n=== packed flags vs pipeline counts ===');
const FLAG_CHECKS = [
  ['is_ka', 'KA'], ['is_intersection', 'intersection'], ['work_zone', 'work_zone'],
  ['is_vru', 'vru'], ['is_pedestrian', 'ped'], ['is_bicycle', 'bike'],
  ['alcohol_suspected', 'alcohol'], ['is_wildlife', 'wildlife'],
];
for (const [bit, key] of FLAG_CHECKS) {
  const ok = got.bits[bit] === want[key];
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${bit.padEnd(18)} ${String(got.bits[bit]).padStart(7)}`
    + `  expected ${want[key]}`);
  eq(got.bits[bit], want[key], `flag ${bit}`);
}
/* The eight flags with no summary counterpart still have to be non-degenerate:
   an all-zero column is what a mis-set bit index produces. */
for (const name of ['motorcycle_involved', 'heavy_truck_involved', 'hit_and_run',
  'drug_suspected', 'distracted_driver', 'fatigued_driver',
  'unrestrained_occupant', 'occupant_ejected']) {
  need(got.bits[name] > 0, `flag ${name} is set on no row at all`);
  need(got.bits[name] < got.n, `flag ${name} is set on every row`);
}

/* ---- 3. the severity dictionary, category by category ---- */
console.log('\n=== KABCO decode vs pipeline counts ===');
for (const k of ['K', 'A', 'B', 'C', 'O', 'U']) {
  const ok = (got.sev[k] || 0) === want[k];
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k}  ${String(got.sev[k] || 0).padStart(7)}`
    + `  expected ${want[k]}`);
  eq(got.sev[k] || 0, want[k], `severity ${k}`);
}
need(Object.values(got.sev).reduce((a, b) => a + b, 0) === got.n,
  'severity counts do not sum to the row count');

/* ---- 4. dictionary integrity for every coded column ---- */
console.log('\n=== dictionary columns ===');
for (const [name, d] of Object.entries(got.dicts)) {
  console.log(`  ${name.padEnd(16)} ${String(d.size).padStart(5)} values`
    + `  maxCode ${String(d.maxCode).padStart(5)}`);
  need(d.nullSlotEmpty, `${name}: slot 0 is a real value, so every code is shifted`);
  need(d.allStrings, `${name}: value table holds a non-string or an empty string`);
  need(d.poisoned === 0, `${name}: ${d.poisoned} values are the literal "undefined"/"null"/"NaN"`);
  need(d.maxCode < d.size, `${name}: code ${d.maxCode} indexes past a ${d.size}-value table`);
}

/* ---- 5. the companion tables actually landed ---- */
console.log('\n=== vehicle and person folds ===');
console.log(JSON.stringify({ personK: got.personK,
  withVehicles: got.vehNZ, withPeople: got.perNZ, of: got.n }, null, 1));
/* One fatal crash kills at least one person, so this is a floor, not a guess.
   A broken join shows up as zero. */
need(got.personK >= want.K,
  `person fold: ${got.personK} fatalities across ${want.K} fatal crashes`);
need(got.vehNZ / got.n > 0.95,
  `vehicle fold: only ${got.vehNZ}/${got.n} crashes have a vehicle`);
need(got.perNZ / got.n > 0.95,
  `person fold: only ${got.perNZ}/${got.n} crashes have an occupant`);

/* ---- 6. coordinates survived the reprojection ---- */
console.log('\n=== coordinates ===');
console.log(JSON.stringify({ plottable: got.n - got.noCoord,
  noCoordinate: got.noCoord, outsideMontana: got.badCoord }, null, 1));
need(got.badCoord === 0,
  `${got.badCoord} rows hold a finite coordinate outside Montana`);
need(got.noCoord / got.n < 0.01,
  `${got.noCoord}/${got.n} rows have no usable coordinate`);

/* ---- 7. every report renders from the decoded columns ---- */
console.log('\n=== reports ===');
const modes = await page.$$eval('#modebar button', (bs) => bs.map((b) => b.dataset.mode));
for (const mode of modes.filter((m) => m !== 'explore')) {
  const res = await page.evaluate(async (m) => {
    location.hash = `#mode=${m}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((r) => setTimeout(r, 1600));
    const rows = [...document.querySelectorAll('#report tbody tr, .rankrow')];
    const body = document.querySelector('#report')?.innerText || '';
    return { rows: rows.length, empty: !!document.querySelector('#report .empty'),
             bad: /NaN|undefined/.test(body),
             first: rows[0]?.innerText.replace(/\n/g, ' | ') || null };
  }, mode);
  console.log(`  ${mode.padEnd(14)} rows=${String(res.rows).padStart(3)}`
    + `  ${res.first ? res.first.slice(0, 64) : '(none)'}`);
  need(res.rows > 0 || res.empty, `${mode}: rendered neither rows nor an empty-state`);
  need(!res.bad, `${mode}: report body contains NaN or undefined`);
}

/* ---- 8. the crash popup reads the decoded row, not the raw codes ---- */
const popup = await page.evaluate(async () => {
  const m = window.__map;
  const f = window.__facts;
  let r = -1;
  for (let i = 0; i < f.n; i++) {
    if (f.cols.hour[i] === 21 && Number.isFinite(f.cols.lon[i])) { r = i; break; }
  }
  if (r < 0) return { err: 'no crash with hour=21' };
  const lon = f.cols.lon[r]; const lat = f.cols.lat[r];
  m.jumpTo({ center: [lon, lat], zoom: 16 });
  await new Promise((res) => m.once('idle', res));
  const p = m.project([lon, lat]);
  const el = m.getCanvas(); const b = el.getBoundingClientRect();
  for (const t of ['mousedown', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: b.left + p.x, clientY: b.top + p.y }));
  }
  await new Promise((res) => setTimeout(res, 600));
  const node = document.querySelector('.maplibregl-popup-content');
  return { html: node ? node.innerText : null };
});
console.log('\n=== crash popup (hour 21) ===');
console.log(popup.html ? popup.html.replace(/\n/g, ' | ') : JSON.stringify(popup));
if (popup.html) {
  need(!/NaN|undefined/.test(popup.html), 'crash popup contains NaN or undefined');
  /* A decode failure shows up as a bare integer where a label belongs. */
  need(!/\b(Collision|Conditions)\b[^|]*\b\d+\b\s*$/m.test(popup.html),
    'crash popup shows a raw dictionary code where a label belongs');
}

/* ---- 9. the fields the About dialog documents are the ones that shipped ---- */
/* The sixteen booleans ARE shipped -- as named parquet columns -- but the
   loader packs them into one `flags` integer and drops the names, so the
   browser's column list is not the bundle's. Count them as shipped under the
   names meta.fields documents them by. */
const PACKED = ['is_ka', 'is_intersection', 'work_zone', 'is_vru', 'is_pedestrian',
  'is_bicycle', 'motorcycle_involved', 'heavy_truck_involved', 'hit_and_run',
  'alcohol_suspected', 'drug_suspected', 'distracted_driver', 'fatigued_driver',
  'unrestrained_occupant', 'occupant_ejected', 'is_wildlife'];
const documented = Object.keys(meta.fields || {});
const shipped = new Set([...got.cols.filter((c) => c !== 'flags'), ...PACKED]);
const undocumented = [...shipped].filter((c) => !documented.includes(c));
const phantom = documented.filter((c) => !shipped.has(c));
console.log('\n=== field documentation ===');
console.log(JSON.stringify({ documented: documented.length, shipped: shipped.size,
  undocumented, phantom }, null, 1));
need(undocumented.length === 0,
  `columns shipped but not documented in meta.fields: ${undocumented.join(', ')}`);
need(phantom.length === 0,
  `meta.fields documents columns the bundle does not ship: ${phantom.join(', ')}`);

/* ---- verdict ---- */
if (errors.length) {
  console.log('\n=== console errors ===');
  for (const e of errors) console.log('  ' + e);
}
if (fail.length || errors.length) {
  console.error(`\n!! ${fail.length} decode failure(s), ${errors.length} console error(s)`);
  for (const f of fail) console.error('   - ' + f);
  await browser.close();
  process.exit(1);
}
console.log('\n--> decode verified: '
  + `${got.n.toLocaleString()} rows, ${Object.keys(got.dicts).length} dictionary columns, `
  + '16 packed flags, all agreeing with the pipeline.');
await browser.close();
