/* ---------------------------------------------------------------------------
   coding.mjs — how MDT's published strings become this dashboard's model.

   Every value below was read off the actual workbooks rather than assumed, and
   the counts in the comments are from the 2016-2025 release so a future reader
   can tell at a glance whether a rule has stopped matching anything. A rule
   that silently matches zero rows is the characteristic failure here: the
   dashboard keeps working, a filter just quietly returns nothing.

   Matching is normalised (lowercased, collapsed whitespace) and done on a
   PREFIX or a substring where MDT's label carries detail that may change --
   "Yes Driver Or Car And Driver Left Scene" is a yes, and will still be a yes
   if they reword the tail. Exact equality is used only where the value is a
   closed set with no detail attached.

   This file is the single place to look when MDT changes a label. Nothing
   elsewhere in the pipeline string-matches on their vocabulary.
--------------------------------------------------------------------------- */

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' '));

/* ---------------------------------------------------------------- severity */

/** KABCO, the federal injury scale this dashboard is built around.
 *  K fatal, A suspected serious, B suspected minor, C possible, O none, U unknown. */
export const KABCO_ORDER = ['K', 'A', 'B', 'C', 'O', 'U'];

/* Crash Severity, as published (statewide counts, 2016-2025):
     No apparent Injury (property damage only crash)  160,441
     Suspected Minor Injury                            23,342
     Possible injury crash                             19,651
     Unknown                                            8,020
     Suspected Serious Injury                           6,180
     Fatal crash                                        1,846                */
const CRASH_SEVERITY = [
  [/^fatal/, 'K'],
  [/^suspected serious/, 'A'],
  [/^suspected minor/, 'B'],
  [/^possible injury/, 'C'],
  [/^no apparent injury/, 'O'],
];

export function kabcoOf(crashSeverity) {
  const s = norm(crashSeverity);
  for (const [re, code] of CRASH_SEVERITY) if (re.test(s)) return code;
  return 'U';
}

/* Occupant Injury Severity on the PERSON table uses its own vocabulary, close
   to but not identical to the crash-level one -- "Fatal Injury" rather than
   "Fatal crash", and it carries a zNonCountFatal category (63 rows) for deaths
   excluded from the official count. Those are NOT counted as K: a dashboard
   that disagreed with MDT's own fatality total would be wrong in the way
   hardest to defend. */
export function personKabcoOf(injurySeverity) {
  const s = norm(injurySeverity);
  if (s.startsWith('znoncount')) return null;      // deliberately uncounted
  if (s.startsWith('fatal')) return 'K';
  if (s.startsWith('suspected serious')) return 'A';
  if (s.startsWith('suspected minor')) return 'B';
  if (s.startsWith('possible injury')) return 'C';
  if (s.startsWith('no apparent injury')) return 'O';
  return 'U';
}

/* ------------------------------------------------------------- crash flags */

/* Intersection-related, from Junction Relation.
 *
 * An EXACT set, not a substring match on "intersection", and the difference is
 * 1,502 crashes in Missoula alone. MDT publishes thirteen junction relations;
 * the four below are the ones this project has always counted:
 *
 *     Intersection                   40,626 statewide
 *     Intersection-Related           26,838
 *     Driveway/Alley Access Related   9,357   <- the one a substring misses
 *     Crossover-Related                 144
 *
 * A driveway or alley access is a junction, and crashes there behave like
 * intersection crashes rather than like mid-block ones, which is why it was
 * included. Writing it as /intersection/ looked equivalent and quietly
 * dropped 12% of the count -- caught by checking a rebuild against the
 * deployed dashboard rather than by reading the code. */
const INTERSECTION_RELATIONS = new Set([
  'intersection', 'intersection-related', 'crossover-related',
  'driveway/alley access related',
]);
export const isIntersection = (junction) => INTERSECTION_RELATIONS.has(norm(junction));

/** In a work zone. Published as a plain Yes/No. */
export const isWorkZone = (v) => norm(v) === 'yes';

/* Wildlife. MDT records this as the first harmful event rather than a flag;
   "Collision Fixed Object"/"Non-Fixed Object" is the type and the animal is in
   the detail, so both are checked. */
export const isWildlife = (harmfulType, harmfulDetail) =>
  /animal|deer|wildlife/.test(norm(harmfulType) + ' ' + norm(harmfulDetail));

/* ----------------------------------------------------------- vehicle flags */

/* Hit and Run: "Yes Driver Or Car And Driver Left Scene" (44,870) vs
   "No Did Not Leave Scene" (298,150). Prefix, because the tail is descriptive. */
export const isHitAndRun = (v) => norm(v).startsWith('yes');

/* Motorcycle, from Motor Vehicle Body Type Category (3,714 vehicles).
   Vehicle Type is NOT usable for this -- it distinguishes in-transport from
   parked, not what the vehicle is. */
export const isMotorcycle = (bodyType) => norm(bodyType) === 'motorcycle';

/* Heavy truck. Two independent signals, either sufficient: the body-type
   category (13,532) and the gross-weight rating (11,533 over 10,000 lbs).
   They disagree often enough that taking one alone undercounts. */
export const isHeavyTruck = (bodyType, gvw) => {
  const b = norm(bodyType), g = norm(gvw);
  return /medium \/ heavy trucks|heavy truck/.test(b)
      || /more than 26000|10001-26000/.test(g);
};

export const isHazmat = (v) => norm(v) === 'yes';
export const isSchoolBus = (busUse) => norm(busUse) === 'school';

/* ------------------------------------------------------------ person flags */

/* Suspicion fields. "Yes" / "No" / "Unknown" / null -- and the distinction
   matters enough that the dashboard labels these as officer suspicion rather
   than findings. Unknown is NOT a yes. */
export const isSuspected = (v) => norm(v) === 'yes';

/* Ejection: "Totally Ejected" (2,564) and "Partially Ejected" (721) both count;
   "Not Ejected", "Not Applicable" and "Unknown" do not. */
export const isEjected = (v) => /ejected/.test(norm(v)) && !/not ejected/.test(norm(v));

/* Unrestrained. Only the explicit "None Used" counts (19,476). "Unknown"
   (56,247) must not: treating unknown as unrestrained would nearly quadruple
   the figure and the error would run in the direction that looks like a
   finding. */
export const isUnrestrained = (v) => norm(v).startsWith('none used');

/* Unhelmeted, for motorcycle crashes. Null dominates because the column only
   applies to riders. */
export const isUnhelmeted = (v) => norm(v) === 'no helmet';

/* Vulnerable road users, from the person record. MDT files these under Person
   Type "Non-Motorist" with the kind in Person Type Details:
     PEDESTRIAN 1,896 | BICYCLIST 1,067 | OTHER PEDESTRIAN 36 | OTHER CYCLIST 6
   The "OTHER" categories are included -- a person in a wheelchair struck by a
   car is a pedestrian casualty by every definition that matters here. */
export const isPedestrian = (personType, details) =>
  /non-motorist/.test(norm(personType)) && /pedestrian/.test(norm(details));
export const isBicyclist = (personType, details) =>
  /non-motorist/.test(norm(personType)) && /(bicyclist|cyclist)/.test(norm(details));

/* --------------------------------------------------------------- the flags */

/* The filterable factors, in display order, each with where it comes from.
   `source` is documentation that earns its keep: it is what tells a user why a
   factor is missing when they build from the Crash table alone. */
export const FACTORS = [
  { key: 'is_ka', label: 'Fatal or serious', source: 'crash' },
  { key: 'is_vru', label: 'Pedestrian or bicycle', source: 'crash+person' },
  { key: 'is_wildlife', label: 'Wildlife involved', source: 'crash' },
  { key: 'is_intersection', label: 'Intersection-related', source: 'crash' },
  { key: 'alcohol_suspected', label: 'Alcohol suspected', source: 'person' },
  { key: 'drug_suspected', label: 'Drugs suspected', source: 'person' },
  { key: 'distracted_driver', label: 'Distraction indicated', source: 'person' },
  { key: 'fatigued_driver', label: 'Fatigue indicated', source: 'person' },
  { key: 'unrestrained_occupant', label: 'Unrestrained occupant', source: 'person' },
  { key: 'occupant_ejected', label: 'Occupant ejected', source: 'person' },
  { key: 'motorcycle_involved', label: 'Motorcycle involved', source: 'vehicle' },
  { key: 'heavy_truck_involved', label: 'Heavy truck involved', source: 'vehicle' },
  { key: 'hit_and_run', label: 'Hit and run', source: 'vehicle' },
  { key: 'work_zone', label: 'Work zone', source: 'crash' },
];

/** Bit position per flag, packed into one integer column. 14 flags fit a
 *  Uint16 with room to spare; testing "alcohol AND pedestrian" is then one
 *  mask comparison rather than two array lookups. */
export const FLAG_BIT = Object.fromEntries(FACTORS.map((f, i) => [f.key, 1 << i]));

/** The four that record an officer's on-scene suspicion, not a test result.
 *  The dashboard says so wherever they appear; this is the list it says it of. */
export const SUSPICION = new Set([
  'alcohol_suspected', 'drug_suspected', 'distracted_driver', 'fatigued_driver',
]);

export { norm };
