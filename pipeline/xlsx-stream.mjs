/* ---------------------------------------------------------------------------
   xlsx-stream.mjs — read one sheet of a large workbook, a row at a time.

   All three MDT workbooks have the same shape: a "Section 407" legal notice
   sheet, then one data sheet whose name is unpredictable -- the Crash table
   calls it "Crash" (it was "download" before the 2026 release), and the
   companions use their own filename truncated to Excel's 31-character sheet
   limit, so "CrashDatabase_VehicleTable(2016". Matching by prefix rather than
   by exact name is what keeps this working across releases.

   Streaming is not an optimisation here. The Person table is 60 MB and 455,000
   rows; read whole it costs over a gigabyte, which is the difference between a
   tool that runs on a laptop and one that gets killed by the OS.
--------------------------------------------------------------------------- */
import ExcelJS from 'exceljs';

/** Normalise a cell to a trimmed string or null.
 *
 *  ExcelJS returns {richText:[...]} for styled cells and {result} for formula
 *  cells. Both stringify to "[object Object]", which then silently becomes a
 *  category value, a county name that matches nothing, or a flag that never
 *  fires -- so they are unwrapped here rather than anywhere downstream. */
export function cell(v) {
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else if ('hyperlink' in v) v = v.text ?? v.hyperlink;
  }
  if (v instanceof Date) return v;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Stream a sheet, yielding `{ get, raw }` per data row.
 *
 * `get(key)` reads a mapped column; `raw` is the underlying 1-based array for
 * the rare case something unmapped is needed. Yielding an accessor rather than
 * a built object matters at this scale: constructing 455,000 objects with
 * forty keys each, to read six of them, is most of the run time.
 *
 * @param {string} path
 * @param {string[]} sheetPrefixes  accepted data-sheet name prefixes
 * @param {Record<string,{header:string,required?:boolean}>} columns
 * @param {{ onProgress?: (n:number)=>void, progressEvery?: number }} [opts]
 */
export async function* streamSheet(path, sheetPrefixes, columns, opts = {}) {
  const { onProgress = null, progressEvery = 50000 } = opts;
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: 'emit', sharedStrings: 'cache', entries: 'emit', styles: 'ignore',
  });

  let found = null;
  let n = 0;
  for await (const sheet of wb) {
    if (!sheetPrefixes.some((p) => sheet.name.startsWith(p))) continue;
    found = sheet.name;
    let idx = null;

    for await (const row of sheet) {
      const raw = row.values;                   // 1-based; raw[0] is unused
      if (!idx) {
        const headers = raw.map((v) => (v == null ? '' : String(v).trim()));
        idx = {};
        const missing = [];
        for (const [key, spec] of Object.entries(columns)) {
          const at = headers.indexOf(spec.header);
          if (at === -1) { if (spec.required) missing.push(spec.header); continue; }
          idx[key] = at;
        }
        if (missing.length) {
          throw new Error(
            `${path} (sheet "${sheet.name}") is missing required column(s): `
            + `${missing.join(', ')}.\n  Found: ${headers.filter(Boolean).join(', ')}\n`
            + '  MDT has changed this schema before; see pipeline/coding.mjs.');
        }
        continue;
      }
      const get = (k) => (idx[k] === undefined ? null : cell(raw[idx[k]]));
      n++;
      if (onProgress && n % progressEvery === 0) onProgress(n);
      yield { get, raw };
    }
  }
  if (!found) {
    throw new Error(`${path}: no sheet whose name starts with `
      + `${sheetPrefixes.map((p) => `"${p}"`).join(' or ')}. `
      + 'Is this the workbook you meant?');
  }
  if (onProgress) onProgress(n);
}
