/* ---------------------------------------------------------------------------
   read-crash-table.mjs — stream MDT's CrashTable workbook into plain rows.

   The published workbook is ~32 MB and ~219,000 rows. Loading it whole costs
   well over a gigabyte; streaming it costs about 120 MB and ten seconds, which
   is the difference between this running on a laptop and not. ExcelJS's
   WorkbookReader is used in `emit` mode for exactly that reason.

   This module does ONE job: get the sheet into rows with usable JavaScript
   values. Deriving severity flags, time bins and the rest belongs in
   derive.mjs, so that a change to MDT's column names touches only this file
   and a change to the analysis touches only that one.
--------------------------------------------------------------------------- */
import ExcelJS from 'exceljs';

/** The sheet holding the data. MDT renamed it from "download" to "Crash" when
 *  they added coordinates, so both are accepted rather than assuming either. */
const DATA_SHEETS = ['Crash', 'download'];

/* The columns this pipeline reads, by MDT's own header text. Anything else in
   the workbook is ignored -- deliberately, so a new column appearing upstream
   is additive rather than breaking.

   `required` is the set that must exist for a build to mean anything. MDT has
   changed this schema at least twice (29 columns, then 31 with coordinates),
   so the failure when they change it again should name the missing column
   rather than surface as undefined rows three functions later. */
export const COLUMNS = {
  id: { header: 'Crash ID', required: true },
  corridor: { header: 'Corridor Name' },
  refpost: { header: 'Reference Post and Offset' },
  city: { header: 'City Name' },
  county: { header: 'County Name', required: true },
  date: { header: 'Crash Date', required: true },
  time: { header: 'Crash Time' },
  dow: { header: 'Day of Week' },
  collision_type: { header: 'Collision Type' },
  junction: { header: 'Junction Relation' },
  severity: { header: 'Crash Severity', required: true },
  relation_tw: { header: 'Relation to Traffic Way' },
  weather: { header: 'Weather' },
  surface: { header: 'Road Surface Condition' },
  lighting: { header: 'Lighting Condition' },
  harmful_1: { header: 'First Harmful Event Type' },
  harmful_detail: { header: 'First Harmful Event Detail' },
  cc_env_1: { header: 'Contributing Circumstances (Environment) 1' },
  cc_road_1: { header: 'Contributing Circumstances (Road) 1' },
  work_zone: { header: 'Work Zone Related' },
  x: { header: 'X Coordinate', required: true },
  y: { header: 'Y Coordinate', required: true },
};

/* Excel counts days from 1899-12-30, not 1900-01-01: Lotus 1-2-3 treated 1900
   as a leap year and Excel kept the bug for compatibility, so the epoch is
   shifted two days to make the arithmetic come out right. A cell that is not
   date-FORMATTED arrives as this raw serial, which is what MDT publishes. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

export function excelSerialToDate(v) {
  if (v instanceof Date) return v;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(EXCEL_EPOCH_MS + Math.round(n) * DAY_MS);
}

/** "14:35" / 1435 / 0.6076... -> minutes past midnight, or null. */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes();
  if (typeof v === 'number') {
    /* A time-formatted cell is a fraction of a day; a plain number is HHMM. */
    if (v > 0 && v < 1) return Math.round(v * 1440) % 1440;
    const h = Math.floor(v / 100), m = v % 100;
    return (h >= 0 && h < 24 && m >= 0 && m < 60) ? h * 60 + m : null;
  }
  const m = String(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

const clean = (v) => {
  if (v == null) return null;
  /* ExcelJS hands back {richText:[...]} for styled cells and {result:...} for
     formulas; both stringify to "[object Object]" if taken at face value. */
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Stream the workbook, yielding one plain object per crash.
 *
 * @param {string} path
 * @param {{ county?: string|null, onProgress?: (n:number)=>void }} [opts]
 *        `county` filters during the pass rather than after: a county build
 *        otherwise materialises all 219k rows to keep 27k of them.
 */
export async function* readCrashTable(path, { county = null, onProgress = null } = {}) {
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: 'emit', sharedStrings: 'cache', entries: 'emit', styles: 'ignore',
  });
  const want = county ? county.trim().toLowerCase() : null;
  let seenSheet = false;
  let n = 0;

  for await (const sheet of wb) {
    if (!DATA_SHEETS.includes(sheet.name)) continue;
    seenSheet = true;
    let idx = null;

    for await (const row of sheet) {
      const vals = row.values;            // 1-based; vals[0] is always empty
      if (!idx) {
        const headers = vals.map((v) => (v == null ? '' : String(v).trim()));
        idx = {};
        const missing = [];
        for (const [key, spec] of Object.entries(COLUMNS)) {
          const at = headers.indexOf(spec.header);
          if (at === -1) {
            if (spec.required) missing.push(spec.header);
            continue;
          }
          idx[key] = at;
        }
        if (missing.length) {
          throw new Error(
            `${path}: the sheet "${sheet.name}" is missing required column(s): `
            + `${missing.join(', ')}.\nFound: ${headers.filter(Boolean).join(', ')}\n`
            + 'MDT has changed this schema before. Check the published workbook.');
        }
        continue;
      }
      const at = (k) => (idx[k] === undefined ? null : vals[idx[k]]);

      /* Filtered here, before any parsing work, so a county build does not pay
         to decode 192,000 rows it is about to discard. */
      const countyName = clean(at('county'));
      if (want && (countyName || '').toLowerCase() !== want) continue;

      const d = excelSerialToDate(at('date'));
      const out = { county: countyName, date: d, minutes: parseTime(at('time')) };
      for (const k of Object.keys(COLUMNS)) {
        if (k === 'county' || k === 'date' || k === 'time') continue;
        out[k] = (k === 'x' || k === 'y') ? Number(at(k)) : clean(at(k));
      }
      if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) { out.x = out.y = null; }
      n++;
      if (onProgress && n % 25000 === 0) onProgress(n);
      yield out;
    }
  }
  if (!seenSheet) {
    throw new Error(`${path}: no sheet named ${DATA_SHEETS.map((s) => `"${s}"`).join(' or ')}.`);
  }
}
