#!/usr/bin/env node
/**
 * Run the browser suites against a freshly served build.
 *
 * Both suites drive a real Chrome against a real HTTP server, because the two
 * failures this project actually shipped could only be seen there: a Content
 * Security Policy refusing a WebAssembly instantiation, and a parquet column
 * whose type was inferred from its first thousand rows. Neither is visible to
 * a unit test, and neither is visible to `astro preview`, which sends no
 * security headers at all.
 *
 * So this starts scripts/serve-csp.mjs -- the dist/ directory with the real
 * public/_headers applied -- waits for it to answer, runs both suites against
 * it, and shuts it down on the way out however the run ended.
 *
 *   npm test
 *   npm test -- --port 4700
 *
 * Chrome is found via $CHROME, defaulting to /usr/bin/google-chrome.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, intFlag } from './flags.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');

/* An unusual default on purpose: 4555 and 3000 are the ports a developer is
   most likely to already have something on, and a suite that silently tests
   someone else's server is worse than one that fails to start. */
const PORT = intFlag(parseFlags(), 'port', 4731);
const URL = `http://127.0.0.1:${PORT}/`;

if (!existsSync(join(site, 'dist', 'index.html'))) {
  console.error('! no site/dist -- run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(join(site, 'public', 'data', 'facts.parquet'))) {
  console.error('! no bundle in site/public/data -- run `npm run data` first.');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => spawn(cmd, args, { stdio: 'inherit', ...opts });

const server = spawn(process.execPath, [join(site, 'scripts', 'serve-csp.mjs'), String(PORT)],
  { cwd: site, stdio: ['ignore', 'pipe', 'inherit'] });

/* Kill the server however this process ends -- a thrown suite, a failed
   assertion, Ctrl-C -- or the next run finds the port taken and tests a build
   from twenty minutes ago. */
let stopped = false;
const stop = () => { if (!stopped) { stopped = true; server.kill('SIGTERM'); } };
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });

/* Wait for the port to answer rather than sleeping a fixed interval: a cold
   first build on a slow disk takes longer than any sleep worth writing. */
await new Promise((resolve, reject) => {
  const started = Date.now();
  server.stdout.on('data', (b) => process.stdout.write(b));
  const tick = setInterval(async () => {
    if (server.exitCode !== null) {
      clearInterval(tick); reject(new Error('server exited before it listened'));
    } else if (Date.now() - started > 20000) {
      clearInterval(tick); reject(new Error(`server did not answer on ${PORT} in 20s`));
    } else {
      try {
        const r = await fetch(URL, { method: 'HEAD' });
        if (r.ok || r.status === 404) { clearInterval(tick); resolve(); }
      } catch { /* not up yet */ }
    }
  }, 150);
});

const suites = [
  ['smoke', join(site, 'scripts', 'smoke-test.mjs')],
  ['decode', join(site, 'scripts', 'verify-decode.mjs')],
];

let failed = 0;
for (const [name, script] of suites) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
  const code = await new Promise((resolve) => {
    const p = run(process.execPath, [script], {
      cwd: site, env: { ...process.env, SMOKE_URL: URL },
    });
    p.on('close', resolve);
  });
  /* Both suites run even when the first one fails. Two reports in one run is
     the difference between fixing two things and fixing one, rebuilding, and
     finding the second. */
  if (code !== 0) { failed++; console.error(`\n!! ${name} failed (exit ${code})`); }
}

stop();
if (failed) {
  console.error(`\n!! ${failed} of ${suites.length} suites failed.`);
  process.exit(1);
}
console.log(`\n--> ${suites.length} suites passed.`);
