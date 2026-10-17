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
