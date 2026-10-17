#!/usr/bin/env node
/**
 * Serve dist/ with the real public/_headers applied.
 *
 * `astro preview` sends no security headers, so the content security policy --
 * the control this project leans on hardest -- is never exercised until
 * Cloudflare is the one enforcing it. That is how the first production deploy
 * died: WebAssembly was instantiated at import, CSP refused it, and nothing
 * local had ever said so.
 *
 *   node scripts/serve-csp.mjs 4555
 *   SMOKE_URL=http://127.0.0.1:4555/ npm run test:smoke
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'dist');
const port = Number(process.argv[2] || 4555);

// Parse the `/*` block out of _headers. Enough for this file's shape; it is a
// test harness, not a Cloudflare reimplementation.
const headers = {};
try {
  const txt = await readFile(path.join(here, '..', 'public', '_headers'), 'utf8');
  let inGlob = false;
  for (const line of txt.split('\n')) {
    if (/^\/\*/.test(line)) { inGlob = true; continue; }
    if (/^\S/.test(line)) { inGlob = false; continue; }
    const m = inGlob && line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (m) headers[m[1]] = m[2].trim();
  }
} catch { /* no _headers: serve bare, and say so */ }

if (!Object.keys(headers).length) {
  console.warn('! no headers parsed from public/_headers -- serving without a CSP');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.geojson': 'application/geo+json', '.parquet': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end('no'); }
  try {
    const body = await readFile(file);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('not found'); }
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}/ with ${Object.keys(headers).length} header(s)`);
  if (headers['Content-Security-Policy']) console.log('CSP is enforced');
});
