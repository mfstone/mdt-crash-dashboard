/* Command-line flags, parsed the same way everywhere.
 *
 * One file because three scripts take flags and two of them had their own
 * parser that accepted only `--flag=value`. `npm start -- --port 4737` then
 * set `port` to the boolean true, `Number(true)` is 1, and the server tried
 * to listen on port 1 and died with EACCES -- an error naming a port the user
 * never typed. Both spellings are what anyone expects, so both are accepted.
 *
 *   --port=4737   --port 4737   --yes
 *
 * A bare flag is `true`. A following token that does not itself begin with
 * `--` is the flag's value; nothing here takes a negative number, so that
 * ambiguity does not arise.
 */
export function parseFlags(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

/**
 * A flag that must be a positive integer, or a default.
 *
 * Rejects rather than coerces: `Number(true)` is 1 and `Number('')` is 0, so
 * a plain `Number(flags.port) || DEFAULT` turns a malformed flag into a port
 * number instead of an error.
 */
export function intFlag(flags, name, def) {
  const v = flags[name];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer; got ${JSON.stringify(v)}`);
  }
  return n;
}
