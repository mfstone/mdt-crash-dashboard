/* ---------------------------------------------------------------------------
   config.mjs — what crashmap.config.json may say.

   The wizard writes this file; a user may then hand-edit it, so every value is
   validated and every failure names the key, what was found, and what was
   allowed. The alternative is a dashboard that builds successfully and is
   quietly wrong -- branded for one county while showing another's crashes.
--------------------------------------------------------------------------- */
import { readFileSync, existsSync } from 'node:fs';
import { BASEMAPS } from '../site/src/lib/basemaps.js';
import { derive } from '../site/src/lib/county-derive.js';
import { SOURCES } from './fetch.mjs';

export const CONFIG_FILE = 'crashmap.config.json';
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

class ConfigError extends Error {
  constructor(where, msg) { super(`${CONFIG_FILE} — ${where}: ${msg}`); this.name = 'ConfigError'; }
}
const list = (a) => a.map((x) => `"${x}"`).join(', ');

export function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('root', 'expected a JSON object');
  const cfg = {};

  /* null means statewide, and that is a real choice rather than a missing
     value -- so the key must be PRESENT, even when empty. Leaving it out is
     more likely a forgotten edit than a decision. */
  if (!('county' in raw)) {
    throw new ConfigError('county',
      'required. Name a Montana county, or use null for a statewide build.');
  }
  cfg.county = raw.county == null ? null : String(raw.county).trim();
  /* Shared with the Astro build and the browser bundle, so the bundle's title
     and the page's <title> cannot disagree. */
  const named = derive({ county: cfg.county, title: raw.title?.trim() || undefined });
  cfg.title = named.title;
  cfg.shortName = named.shortName;

  /* Optional, and only meaningful if this is being deployed somewhere: the
     public origin, used for the canonical link and the share card. A local
     run has no canonical URL and emits neither. */
  if (raw.site != null) {
    try { cfg.site = new URL(String(raw.site)).href.replace(/\/$/, ''); }
    catch { throw new ConfigError('site', `not a URL: ${JSON.stringify(raw.site)}`); }
  }

  /* Present-and-null is a decision; absent is the common case and means the
     same thing. Unlike `county`, there is nothing to forget here. */
  cfg.plannedProjects = raw.plannedProjects ?? null;

  const src = raw.source || { kind: 'url' };
  if (src.kind === 'directory') {
    if (!src.path) throw new ConfigError('source', 'a "directory" source needs a "path"');
    if (!existsSync(src.path)) throw new ConfigError('source', `no such directory: ${src.path}`);
    cfg.source = { kind: 'directory', path: src.path };
  } else if (src.kind === 'url' || src.kind === undefined) {
    cfg.source = { kind: 'url', base: src.base || undefined };
  } else {
    throw new ConfigError('source', `"kind" is ${JSON.stringify(src.kind)}; allowed: "url", "directory"`);
  }

  const tables = raw.tables ?? ['crash', 'vehicle', 'person'];
  if (!Array.isArray(tables) || !tables.includes('crash')) {
    throw new ConfigError('tables', 'must be an array including "crash" — the other two are optional');
  }
  for (const t of tables) {
    if (!SOURCES[t]) throw new ConfigError('tables', `unknown table ${JSON.stringify(t)}; allowed: ${list(Object.keys(SOURCES))}`);
  }
  cfg.tables = [...tables];

  const theme = raw.theme || {};
  cfg.theme = {};
  for (const k of ['primary', 'secondary', 'accent']) {
    const v = theme[k];
    if (typeof v !== 'string' || !HEX.test(v)) {
      throw new ConfigError('theme', `"${k}" must be a hex colour like "#70002E"; found ${JSON.stringify(v)}`);
    }
    cfg.theme[k] = v.toUpperCase();
  }

  const bm = raw.basemaps ?? ['openfreemap-liberty', 'openfreemap-positron'];
  if (!Array.isArray(bm) || !bm.length) throw new ConfigError('basemaps', 'must be a non-empty array');
  for (const id of bm) {
    if (!BASEMAPS[id]) {
      throw new ConfigError('basemaps', `unknown id ${JSON.stringify(id)}; available: ${list(Object.keys(BASEMAPS))}`);
    }
  }
  cfg.basemaps = [...bm];
  return cfg;
}

export function load(path = CONFIG_FILE) {
  if (!existsSync(path)) {
    throw new Error(`No ${CONFIG_FILE} found.\n  Run "npm run setup" to create one.`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
  return validate(raw);
}

export { ConfigError };
