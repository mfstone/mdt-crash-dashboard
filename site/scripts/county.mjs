/* The county, as the Astro build sees it.
 *
 * Reads the same crashmap.config.json the pipeline validates and the browser
 * imports, and applies the same derivation. Node-side because astro.config.mjs
 * needs it before Vite exists.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { derive } from '../src/lib/county-derive.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '..', '..', 'crashmap.config.json');

let raw;
try { raw = JSON.parse(readFileSync(CONFIG, 'utf8')); }
catch (e) {
  throw new Error(`Cannot read crashmap.config.json (${e.message}).\n`
    + '  Run "npm run setup" at the repo root to create one.');
}
/* Only this. The pipeline's config.mjs is the validator and reports every
   other problem with a key, a found value and an allowed set; repeating a
   weaker version of those checks here would mean two error messages for one
   mistake, disagreeing about what is wrong. */
if (!('county' in raw)) {
  throw new Error('crashmap.config.json is missing "county" '
    + '(name a Montana county, or null for a statewide build).');
}

export const county = derive(raw);

/* The config names a county; the bundle was BUILT for one. Nothing downstream
   compares them, and every string a reader sees comes from the first while
   every number comes from the second -- so a build after `npm run setup` and
   before `npm run data` produces a page headed "Gallatin County Crash
   Explorer" over Missoula's 26,996 crashes, with no warning anywhere.
   `npm start` rebuilds the data when the config is newer, but a bare
   `npm run build` does not, and CI would not catch it either: its config and
   its committed bundle agree.
 *
 * This is the failure the config validator exists to prevent, arriving one
 * step later. Checked here rather than in the page because it costs a file
 * read and stops the build before Vite starts. */
const BUNDLE = join(here, '..', 'public', 'data', 'meta.json');
let meta;
try { meta = JSON.parse(readFileSync(BUNDLE, 'utf8')); }
catch {
  throw new Error('No data bundle at site/public/data/meta.json.\n'
    + '  Run "npm run data" to build one.');
}
const builtFor = meta.scope?.name ?? null;
if ((builtFor ?? null) !== (county.county ?? null)) {
  const name = (c) => (c == null ? 'statewide' : `${c} County`);
  throw new Error(
    `crashmap.config.json says ${name(county.county)}, but the data bundle was `
    + `built for ${name(builtFor)}.\n`
    + '  Every label would come from the config and every number from the '
    + 'bundle.\n'
    + '  Run "npm run data" to rebuild the bundle for the configured county.');
}
