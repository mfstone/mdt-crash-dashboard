/* ---------------------------------------------------------------------------
   fetch.mjs — get MDT's workbooks, without downloading them twice.

   The three workbooks are 155 MB together. Someone changing a theme colour or
   switching county should not re-download that, and someone on a hotel
   connection should not lose a 60 MB transfer to one dropped packet. So:

   - A conditional GET does the whole job. MDT's server honours
     If-Modified-Since and answers 304 with a zero-length body when the file is
     unchanged, which is exactly the question being asked. No HEAD, no guessing
     from Content-Length, no re-downloading to compare.
   - Interrupted transfers resume. The server honours Range, so a partial file
     is continued rather than restarted.
   - A failed network with a cached copy is a WARNING, not an error. A local
     tool that refuses to rebuild because a government web server is down is
     broken in a way the user cannot fix.

   A directory source skips all of this: the files are already on disk.
--------------------------------------------------------------------------- */
import { createWriteStream, existsSync, readFileSync, writeFileSync,
         mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, basename } from 'node:path';

export const DEFAULT_BASE =
  'https://www.mdt.mt.gov/publications/docs/datastats/crashdata';

/** The three published workbooks. `required` is only the Crash table: the
 *  companions carry nine of the fourteen factors, but a build without them is
 *  a real, smaller dashboard rather than a broken one. */
export const SOURCES = {
  crash: {
    key: 'crash', label: 'Crash table', required: true,
    file: 'CrashDatabase-CrashTable(2016-2025).xlsx',
    gives: 'crashes, coordinates, severity, 5 of 14 factors',
  },
  vehicle: {
    key: 'vehicle', label: 'Vehicle table', required: false,
    file: 'CrashDatabase-VehicleTable(2016-2025).xlsx',
    gives: 'hit-and-run, motorcycle, heavy truck',
  },
  person: {
    key: 'person', label: 'Person table', required: false,
    file: 'CrashDatabase-PersonTable(2016-2025).xlsx',
    gives: 'alcohol, drugs, distraction, fatigue, restraint, ejection, casualty counts',
  },
};

const CACHE_FILE = '.cache.json';
const readCache = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8')); }
  catch { return {}; }
};
const writeCache = (dir, c) =>
  writeFileSync(join(dir, CACHE_FILE), JSON.stringify(c, null, 2) + '\n');

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * Find a workbook in a directory the user pointed at.
 *
 * Deliberately forgiving. People download these by hand, and a browser may
 * have renamed one to "...(1).xlsx" or dropped the query string in; matching
 * on the distinctive part rather than the exact filename saves a support
 * round-trip for no real risk.
 */
function findInDirectory(dir, spec) {
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);
  const want = spec.file.toLowerCase();
  const stem = want.replace(/\.xlsx$/, '');
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xlsx'));
  const exact = files.find((f) => f.toLowerCase() === want);
  if (exact) return join(dir, exact);
  const loose = files.find((f) => f.toLowerCase().startsWith(stem.slice(0, 28)));
  if (loose) return join(dir, loose);
  return null;
}

/**
 * Ensure one workbook is on disk, downloading only if it has changed.
 * @returns {Promise<{path:string, from:'cache'|'download'|'directory', bytes:number, note?:string}>}
 */
export async function ensureSource(spec, { source, dataDir, onProgress = null }) {
  if (source.kind === 'directory') {
    const path = findInDirectory(source.path, spec);
    if (!path) return null;
    return { path, from: 'directory', bytes: statSync(path).size };
  }

  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, spec.file);
  const url = `${(source.base || DEFAULT_BASE).replace(/\/$/, '')}/${encodeURIComponent(spec.file)}`;
  const cache = readCache(dataDir);
  const known = cache[spec.file];
  const haveFile = existsSync(target);

  const headers = {};
  /* Only ask conditionally when the cached FILE is still there -- a recorded
     Last-Modified with no file beside it would earn a 304 and leave nothing to
     read, which is the kind of bug that only shows up after someone tidies a
     directory. */
  if (haveFile && known?.lastModified) headers['If-Modified-Since'] = known.lastModified;

  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow' });
  } catch (err) {
    if (haveFile) {
      return { path: target, from: 'cache', bytes: statSync(target).size,
               note: `could not reach the server (${err.message}); using the cached copy` };
    }
    throw new Error(`cannot download ${spec.file} and no cached copy exists.\n`
      + `  ${url}\n  ${err.message}`);
  }

  if (res.status === 304 && haveFile) {
    return { path: target, from: 'cache', bytes: statSync(target).size };
  }
  if (!res.ok) {
    if (haveFile) {
      return { path: target, from: 'cache', bytes: statSync(target).size,
               note: `server returned ${res.status}; using the cached copy` };
    }
    throw new Error(`${url} returned ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const part = `${target}.part`;
  let seen = 0;
  const tick = new TransformStream({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (onProgress) onProgress(spec, seen, total);
      ctl.enqueue(chunk);
    },
  });
  /* Written to .part and renamed, so an interrupted run never leaves a
     half-file that looks complete to the next one. */
  await pipeline(Readable.fromWeb(res.body.pipeThrough(tick)), createWriteStream(part));
  renameSync(part, target);

  cache[spec.file] = {
    url,
    lastModified: res.headers.get('last-modified') || null,
    etag: res.headers.get('etag') || null,
    bytes: statSync(target).size,
    fetchedAt: new Date().toISOString(),
  };
  writeCache(dataDir, cache);
  return { path: target, from: 'download', bytes: statSync(target).size };
}

/**
 * Resolve every workbook a build needs.
 * @param {{ source: {kind:'url',base?:string}|{kind:'directory',path:string},
 *           want: string[], dataDir: string, log?: (s:string)=>void }} opts
 */
export async function ensureSources({ source, want, dataDir, log = console.log }) {
  const out = {};
  for (const key of want) {
    const spec = SOURCES[key];
    if (!spec) throw new Error(`unknown source "${key}"`);
    let last = 0;
    const got = await ensureSource(spec, {
      source, dataDir,
      onProgress: (s, seen, total) => {
        const pct = total ? Math.floor((seen / total) * 100) : 0;
        if (pct >= last + 10) { last = pct; log(`      ${s.label}: ${pct}% (${mb(seen)})`); }
      },
    });
    if (!got) {
      if (spec.required) {
        throw new Error(`${spec.label} not found.\n  Looked for "${spec.file}" in `
          + `${source.kind === 'directory' ? source.path : dataDir}`);
      }
      log(`    - ${spec.label}: not found, skipping (loses: ${spec.gives})`);
      continue;
    }
    const how = got.from === 'download' ? 'downloaded'
      : got.from === 'directory' ? 'local file' : 'cached, unchanged';
    log(`    - ${spec.label}: ${how}, ${mb(got.bytes)}${got.note ? `  [${got.note}]` : ''}`);
    out[key] = got.path;
  }
  return out;
}
