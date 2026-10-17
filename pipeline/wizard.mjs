#!/usr/bin/env node
/**
 * npm run setup — ask what this dashboard should be, and write the config.
 *
 * Five questions, each validated as it is answered rather than at the end. A
 * wizard that collects five answers and then reports that the second was wrong
 * has wasted the other four.
 *
 * Nothing here downloads anything. The county list comes from the shipped
 * boundary file, so someone can configure the tool on a slow connection and
 * fetch 155 MB later, once, when they choose to.
 *
 * Re-running is normal and safe: the existing config supplies the defaults, so
 * changing one colour means pressing Enter four times.
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASEMAPS } from '../site/src/lib/basemaps.js';
import { toLCH, contrast, deltaE } from '../site/src/lib/oklab.js';
import { validate, CONFIG_FILE } from './config.mjs';
import { SOURCES } from './fetch.mjs';
import { parseFlags } from './flags.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(root, CONFIG_FILE);

/* Flags skip the corresponding question. Any flag at all implies
   non-interactive: whatever is not given falls back to the existing config, or
   to a default.
 *
 * This exists for two reasons beyond convenience. Readline cannot be driven by
 * a pipe -- with a non-TTY stdin the remaining lines are emitted and discarded
 * before the next question registers -- so a prompt-only wizard can be tested
 * only by a human typing at it. And setup that cannot be scripted cannot be
 * put in a Dockerfile, a CI job, or an install script.
 *
 *   node pipeline/wizard.mjs --county="Lewis And Clark" --tables=crash \
 *     --primary=#70002E --secondary=#F9423A --accent=#ED8B00 \
 *     --basemap=carto-dark --yes
 *
 * Both `--flag=value` and `--flag value` are accepted; see flags.mjs.
 */
const flags = parseFlags();
const BATCH = Object.keys(flags).length > 0;

const rl = BATCH ? null : createInterface({ input, output });

/* Ctrl+C during a prompt should leave the terminal usable and say nothing was
   written -- the default behaviour is a raw SIGINT trace and an ambiguous
   outcome. */
rl?.on('SIGINT', () => {
  output.write('\n\nCancelled. Nothing was written.\n');
  process.exit(130);
});

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const say = (s = '') => output.write(`${s}\n`);

const existing = existsSync(CONFIG_PATH)
  ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};

/** Ask until the answer validates. `check` returns a value or throws a message.
 *
 *  In batch mode there is nobody to re-ask, so a bad flag fails immediately
 *  and names itself rather than looping forever on the same value. */
async function ask(question, { def = null, check = (v) => v, flag = null } = {}) {
  if (BATCH) {
    const given = flag && flags[flag] !== undefined ? String(flags[flag]) : null;
    const v = given ?? (def == null ? '' : String(def));
    try { return check(v); }
    catch (e) { say(`--${flag ?? '?'}: ${e.message}`); process.exit(1); }
  }
  for (;;) {
    const hint = def == null ? '' : DIM(` [${def}]`);
    const raw = (await rl.question(`${question}${hint}: `)).trim();
    const v = raw === '' && def != null ? String(def) : raw;
    try { return check(v); }
    catch (e) { say(`    ${e.message}`); }
  }
}

async function choose(question, options, def = 1, { flag = null, byValue = null } = {}) {
  /* A flag names its choice ("carto-dark"), not its position: a number would
     silently mean something different the moment an option is inserted. */
  if (BATCH && flag && flags[flag] !== undefined) {
    const want = String(flags[flag]);
    const hit = options.find((o) => (byValue ? byValue(o.value) : String(o.value)) === want);
    if (!hit) {
      const allowed = options.map((o) => (byValue ? byValue(o.value) : String(o.value)));
      say(`--${flag}: ${JSON.stringify(want)} is not one of: ${allowed.join(', ')}`);
      process.exit(1);
    }
    return hit.value;
  }
  if (BATCH) return options[def - 1].value;
  say(`\n${B(question)}`);
  options.forEach((o, i) => {
    say(`  ${i + 1}) ${o.label}`);
    if (o.note) say(`     ${DIM(o.note)}`);
  });
  const pick = await ask('  choice', {
    def,
    check: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > options.length) {
        throw new Error(`enter a number from 1 to ${options.length}`);
      }
      return options[n - 1];
    },
  });
  return pick.value;
}

say(`\n${B('Montana Crash Dashboard — setup')}`);
say(DIM('Press Enter to accept the value in brackets. Ctrl+C to cancel.\n'));

/* ---- 1. where the data comes from -------------------------------------- */
const sourceKind = await choose('1/5  Where should the crash data come from?', [
  { value: 'url', label: 'Download from MDT',
    note: 'Public, no account needed. Cached, so later builds re-download nothing.' },
  { value: 'directory', label: 'A folder on this machine',
    note: 'If you already have the workbooks, or this machine has no internet.' },
], existing.source?.kind === 'directory' ? 2 : 1, { flag: 'source' });

let source = { kind: 'url' };
if (sourceKind === 'directory') {
  const path = await ask('  folder containing the .xlsx files', {
    flag: 'path',
    def: existing.source?.path ?? null,
    check: (v) => {
      if (!v) throw new Error('a path is required');
      const p = resolve(v.replace(/^~/, process.env.HOME || '~'));
      if (!existsSync(p)) throw new Error(`no such folder: ${p}`);
      return p;
    },
  });
  source = { kind: 'directory', path };
}

/* ---- 2. which tables ---------------------------------------------------- */
const tables = await choose('2/5  How much of the data?', [
  { value: ['crash', 'vehicle', 'person'], label: 'Everything — all 14 filters',
    note: `${SOURCES.crash.label}, ${SOURCES.vehicle.label}, ${SOURCES.person.label}. About 155 MB.` },
  { value: ['crash'], label: 'Crash table only — faster, 5 of 14 filters',
    note: 'Drops alcohol, drugs, distraction, fatigue, restraint, ejection, '
        + 'motorcycle, heavy truck and hit-and-run. About 31 MB.' },
], (existing.tables?.length ?? 3) === 1 ? 2 : 1,
   { flag: 'tables', byValue: (v) => (v.length === 1 ? 'crash' : 'all') });

/* ---- 3. the county ------------------------------------------------------ */
const counties = JSON.parse(readFileSync(join(root, 'reference/counties.geojson'), 'utf8'))
  .features.map((f) => f.properties.NAME).sort();

say(`\n${B('3/5  Which county?')}`);
say(DIM(`  ${counties.length} Montana counties. Type a name, or "all" for statewide.`));
const county = await ask('  county', {
  flag: 'county',
  def: existing.county ?? 'Missoula',
  check: (v) => {
    if (/^(all|statewide|montana)$/i.test(v)) return null;
    const hit = counties.find((c) => c.toLowerCase() === v.toLowerCase());
    if (hit) return hit;
    /* Name the near misses rather than just rejecting. "Lewis and Clark" is
       spelled "Lewis And Clark" upstream, and a user cannot be expected to
       guess that. */
    const near = counties.filter((c) => c.toLowerCase().includes(v.toLowerCase().slice(0, 4)));
    throw new Error(near.length
      ? `no county "${v}". Did you mean: ${near.slice(0, 5).join(', ')}?`
      : `no county "${v}". Try "all", or a name like ${counties[0]}.`);
  },
});

/* ---- 4. theme ----------------------------------------------------------- */
say(`\n${B('4/5  Theme colours')}`);
say(DIM('  Three hex colours. Each is checked as you enter it; the build will'));
say(DIM('  refuse a palette that cannot be read, so it is better to know now.'));

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
async function askColour(role, def, flag) {
  return ask(`  ${role}`, {
    flag,
    def,
    check: (v) => {
      const m = HEX.exec(v.trim());
      if (!m) throw new Error('a hex colour, like #70002E');
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const hex = `#${h.toUpperCase()}`;
      const { L, C } = toLCH(hex);
      const onWhite = contrast(hex, '#FFFFFF');
      /* Reported, not enforced: a colour too light for white text is still a
         fine choice for a dark theme's ground, and the build does the real
         gatekeeping once it knows every role. */
      say(`    ${DIM(`L ${L.toFixed(2)}  chroma ${C.toFixed(2)}  ${onWhite.toFixed(1)}:1 on white`
        + (C < 0.04 ? '  — nearly grey' : ''))}`);
      return hex;
    },
  });
}
const theme = {
  primary: await askColour('primary  ', existing.theme?.primary ?? '#1F3A5F', 'primary'),
  secondary: await askColour('secondary', existing.theme?.secondary ?? '#C8553D', 'secondary'),
  accent: await askColour('accent   ', existing.theme?.accent ?? '#588B8B', 'accent'),
};
for (const [a, b] of [['primary', 'secondary'], ['primary', 'accent'], ['secondary', 'accent']]) {
  const d = deltaE(theme[a], theme[b]);
  if (d < 15) {
    say(`  ${DIM(`note: ${a} and ${b} are only ${d.toFixed(0)} apart perceptually; `
      + 'they will be hard to tell apart in a legend.')}`);
  }
}

/* ---- 5. basemap --------------------------------------------------------- */
const ids = Object.keys(BASEMAPS);
const basemap = await choose('5/5  Cartographic scheme', ids.map((id) => ({
  value: id, label: `${BASEMAPS[id].label}  ${DIM(`(${id})`)}`, note: BASEMAPS[id].note,
})), Math.max(1, ids.indexOf(existing.basemaps?.[0] ?? 'openfreemap-liberty') + 1),
   { flag: 'basemap' });

/* The second entry gives the reader a toggle. Paired light/dark where the
   choice is raster, since a raster basemap cannot be restyled for a theme. */
const partner = { 'openfreemap-liberty': 'openfreemap-positron',
                  'openfreemap-positron': 'openfreemap-liberty',
                  'openfreemap-bright': 'openfreemap-positron',
                  'carto-positron': 'carto-dark',
                  'carto-dark': 'carto-positron',
                  'carto-voyager': 'carto-dark' }[basemap];
const basemaps = partner ? [basemap, partner] : [basemap];

/* ---- write -------------------------------------------------------------- */
const cfg = { county, source, tables, theme, basemaps };
let checked;
try {
  checked = validate(cfg);
} catch (e) {
  say(`\n${e.message}`);
  say('Nothing was written.');
  process.exit(1);
}

writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
say(`\n${B('Wrote')} ${CONFIG_FILE}`);
say(`  ${checked.title}`);
say(`  ${county ? `${county} County` : 'statewide'} · ${tables.length} table(s) · `
  + `${basemaps.map((b) => BASEMAPS[b].label).join(' / ')}`);
say(`\nNext: ${B('npm start')}  ${DIM('— builds the data and opens the dashboard')}`);
rl?.close();
