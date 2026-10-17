/* ---------------------------------------------------------------------------
   read-companions.mjs — fold the Vehicle and Person tables onto crash records.

   Nine of the fourteen filterable factors live here rather than on the crash
   record: whether a driver was suspected of drinking is a fact about a person,
   whether a motorcycle was involved a fact about a vehicle. MDT publishes them
   one row per person and one row per vehicle, keyed by Crash ID.

   Each table is streamed once and OR-ed onto the crashes already in hand. Rows
   whose Crash ID is not in that set are skipped without being parsed, which is
   what makes a single-county build cheap: Missoula is 12% of the state, so 88%
   of 800,000 companion rows are discarded on one integer lookup.

   Nothing here knows what MDT's strings mean -- that is coding.mjs. This file
   knows only how to walk the tables and where to put the answers.
--------------------------------------------------------------------------- */
import { streamSheet } from './xlsx-stream.mjs';
import {
  FLAG_BIT, personKabcoOf,
  isHitAndRun, isMotorcycle, isHeavyTruck, isHazmat, isSchoolBus,
  isSuspected, isEjected, isUnrestrained, isUnhelmeted,
  isPedestrian, isBicyclist,
} from './coding.mjs';

const VEHICLE_SHEETS = ['CrashDatabase_VehicleTable', 'Vehicle'];
const PERSON_SHEETS = ['CrashDatabase_PersonTable', 'Person'];

const VEHICLE_COLUMNS = {
  id: { header: 'Crash ID', required: true },
  county: { header: 'County Name' },
  bodyType: { header: 'Motor Vehicle Body Type Category' },
  gvw: { header: 'GVW Rating' },
  hitRun: { header: 'Hit and Run' },
  hazmat: { header: 'Carrying Hazardous Materials' },
  busUse: { header: 'Bus Use' },
  occupants: { header: 'Vehicle Occupant Count' },
};

const PERSON_COLUMNS = {
  id: { header: 'Crash ID', required: true },
  county: { header: 'County Name' },
  personType: { header: 'Person Type' },
  personDetails: { header: 'Person Type Details' },
  injury: { header: 'Occupant Injury Severity' },
  alcohol: { header: 'Law Enforcement Suspected Alcohol Use' },
  drug: { header: 'Law Enforcement Suspected Drug Use' },
  distracted: { header: 'Distracted Driver' },
  fatigued: { header: 'Fatigued Driver' },
  restraint: { header: 'Restraint Type Used' },
  ejection: { header: 'Ejection' },
  helmet: { header: 'Helmet Use' },
};

/** Vehicle rows -> flags and an occupant tally on each crash. */
export async function foldVehicles(path, crashes, opts = {}) {
  let matched = 0, scanned = 0;
  for await (const { get } of streamSheet(path, VEHICLE_SHEETS, VEHICLE_COLUMNS, opts)) {
    scanned++;
    const rec = crashes.get(get('id'));
    if (!rec) continue;                       // a crash outside this build
    matched++;
    const body = get('bodyType'), gvw = get('gvw');
    if (isHitAndRun(get('hitRun'))) rec.flags |= FLAG_BIT.hit_and_run;
    if (isMotorcycle(body)) rec.flags |= FLAG_BIT.motorcycle_involved;
    if (isHeavyTruck(body, gvw)) rec.flags |= FLAG_BIT.heavy_truck_involved;
    if (isHazmat(get('hazmat'))) rec.hazmat = 1;
    if (isSchoolBus(get('busUse'))) rec.school_bus = 1;
    rec.veh_count = (rec.veh_count || 0) + 1;
    const occ = Number(get('occupants'));
    if (Number.isFinite(occ)) rec.occupants = (rec.occupants || 0) + occ;
  }
  return { scanned, matched };
}

/** Person rows -> flags, casualty counts, and the pedestrian/bicyclist union.
 *
 *  Also returns STATEWIDE person-level K and A totals, counted from every row
 *  rather than only the matched ones. The dashboard's severity-coding caveat
 *  compares this scope's suspected-serious-per-fatality ratio against the
 *  state's, and a county build folds only its own crashes -- so without this
 *  the comparison would have nothing to compare against. The rows are
 *  streaming past regardless, so the two extra counters are free. */
export async function foldPersons(path, crashes, opts = {}) {
  let matched = 0, scanned = 0;
  let stateK = 0, stateA = 0;
  for await (const { get } of streamSheet(path, PERSON_SHEETS, PERSON_COLUMNS, opts)) {
    scanned++;
    const statewide = personKabcoOf(get('injury'));
    if (statewide === 'K') stateK++;
    else if (statewide === 'A') stateA++;

    const rec = crashes.get(get('id'));
    if (!rec) continue;
    matched++;

    if (isSuspected(get('alcohol'))) rec.flags |= FLAG_BIT.alcohol_suspected;
    if (isSuspected(get('drug'))) rec.flags |= FLAG_BIT.drug_suspected;
    if (isSuspected(get('distracted'))) rec.flags |= FLAG_BIT.distracted_driver;
    if (isSuspected(get('fatigued'))) rec.flags |= FLAG_BIT.fatigued_driver;
    if (isUnrestrained(get('restraint'))) rec.flags |= FLAG_BIT.unrestrained_occupant;
    if (isEjected(get('ejection'))) rec.flags |= FLAG_BIT.occupant_ejected;
    if (isUnhelmeted(get('helmet'))) rec.unhelmeted = 1;

    const type = get('personType'), details = get('personDetails');
    const ped = isPedestrian(type, details), bike = isBicyclist(type, details);
    if (ped) rec.ped = (rec.ped || 0) + 1;
    if (bike) rec.bike = (rec.bike || 0) + 1;
    /* The VRU flag is the UNION of the collision type recorded on the crash and
       the person records found here. Either alone undercounts: a crash coded
       "Rear-End" can still have struck a cyclist, and a pedestrian collision
       type can appear with no non-motorist person record. */
    if (ped || bike) rec.flags |= FLAG_BIT.is_vru;

    /* Person-level casualty counts, which are a different quantity from the
       crash-level severity: one fatal crash can kill more than one person.
       Both are published, and the dashboard is careful to say which it means
       wherever a number appears. */
    const k = personKabcoOf(get('injury'));
    if (k === 'K') rec.person_K = (rec.person_K || 0) + 1;
    else if (k === 'A') rec.person_A = (rec.person_A || 0) + 1;
    rec.person_count = (rec.person_count || 0) + 1;
  }
  return { scanned, matched, statewide: { person_K: stateK, person_A: stateA } };
}
