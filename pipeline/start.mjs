#!/usr/bin/env node
/**
 * npm start — build what needs building, then serve the dashboard locally.
 *
 * The one command someone runs after setup. It decides what work is actually
 * needed rather than redoing everything: rebuilding a 27,000-row bundle to
 * change a basemap would make the tool feel broken even though it is only
 * slow.
 *
 * Staleness is judged by comparing modification times, not by a flag someone
 * has to remember to pass. The data is rebuilt when the config or the pipeline
 * is newer than the bundle; the theme when the config is newer than the
 * generated stylesheet; the site when anything under src/ is newer than dist/.
 *
 *   npm start -- --rebuild   force the data step
 *   npm start -- --port=4000 serve somewhere else
 *   npm start -- --no-open   do not launch a browser
 */
import { spawnSync, spawn } from 'node:child_process';
import { parseFlags, intFlag } from './flags.mjs';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadConfig } from './config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const flags = parseFlags();
const PORT = intFlag(flags, 'port', 4321);
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const say = (s = '') => process.stdout.write(`${s}\n`);

/** Newest mtime under a path, or 0 if it does not exist. Directories are
 *  walked because "has the site changed" means any file under src/. */
function newest(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    max = Math.max(max, newest(join(path, entry.name)));
  }
  return max;
}

function run(label, cmd, args, cwd = root) {
  say(`\n${B(label)}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    say(`\n${label} failed.`);
    process.exit(r.status ?? 1);
  }
}

/* Fails here with the setup hint rather than deep inside a build. */
const cfg = loadConfig(join(root, 'crashmap.config.json'));
say(`${B(cfg.title)}`);
say(`  ${cfg.county ? `${cfg.county} County` : 'statewide'} · `
  + `${cfg.tables.length} table(s) · ${cfg.basemaps.join(', ')}`);

const configAt = newest(join(root, 'crashmap.config.json'));
const pipelineAt = newest(join(root, 'pipeline'));
const bundleAt = newest(join(site, 'public/data/facts.parquet'));
const themeAt = newest(join(site, 'src/styles/theme.css'));

if (flags.rebuild || bundleAt === 0 || configAt > bundleAt || pipelineAt > bundleAt) {
  const why = bundleAt === 0 ? 'no bundle yet'
    : flags.rebuild ? 'forced'
    : configAt > bundleAt ? 'config changed' : 'pipeline changed';
  run(`Building data (${why}) — this takes a minute`, process.execPath, ['pipeline/build.mjs']);
} else {
  say('\nData bundle is current.');
}

if (themeAt === 0 || configAt > themeAt) {
  run('Deriving theme', process.execPath, ['scripts/build-theme.mjs'], site);
} else {
  say('Theme is current.');
}

const srcAt = Math.max(newest(join(site, 'src')), newest(join(site, 'public')));
if (newest(join(site, 'dist')) < srcAt) {
  run('Building site', 'npm', ['run', 'build', '--workspace', 'site']);
} else {
  say('Site build is current.');
}

/* Served with the real public/_headers, not `astro preview`, so what runs
   locally is under the same content security policy as a deployed copy. A
   policy that is only applied somewhere else is a policy nobody is testing. */
say(`\n${B(`Serving on http://localhost:${PORT}`)}`);
say('  Ctrl+C to stop.\n');
const server = spawn(process.execPath, ['scripts/serve-csp.mjs', String(PORT)],
  { cwd: site, stdio: 'inherit' });

if (!flags['no-open']) {
  /* Best effort, and silent on failure: a headless machine or an unusual
     desktop should not turn "the server is running" into an error. */
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  setTimeout(() => {
    spawn(opener, [`http://localhost:${PORT}`],
      { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }, 800);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.kill(sig); process.exit(0); });
}
server.on('exit', (code) => process.exit(code ?? 0));
