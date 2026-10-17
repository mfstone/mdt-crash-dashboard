/* ---------------------------------------------------------------------------
   notices.mjs — the legal text, the disclosure policy, and the field dictionary.

   Reproduced VERBATIM from the build this tool replaces. These are not derived
   from data and must not be paraphrased: the Section 407 notice is a statutory
   evidentiary rule carried on MDT's own workbooks, and the disclaimer is what
   separates an independent analysis of public data from something presenting
   itself as an MDT product.

   The field dictionary documents only the columns this pipeline emits. An
   entry describing a column that no longer exists is worse than no entry --
   the About sheet would promise data the bundle does not contain.
--------------------------------------------------------------------------- */

/** 23 U.S.C. 407, as carried on the source workbooks. */
export const SECTION_407 = "The source workbooks carry a 23 U.S.C. 407 notice. Section 407 is an evidentiary rule: data compiled for identifying or evaluating highway safety improvements is not subject to discovery and is not admissible in an action for damages arising at a location the data addresses. It is reproduced here as provenance, not as a restriction on this bundle.";

export const DISCLAIMER = "This dashboard is an independent analysis of public crash data published by the Montana Department of Transportation. It is not an MDT product and is not endorsed by MDT. Crash records are administrative data collected by investigating officers: they contain errors and omissions, they are coded to the reporting standards of the year they were filed, and fields describing driver condition record an officer's field assessment rather than any adjudicated or laboratory finding. Counts for the most recent year may be incomplete. Nothing here establishes the cause of any crash, the condition of any road, or the conduct of any person.";

/** What is deliberately coarsened, and why. Published rather than done quietly. */
export const DISCLOSURE_POLICY = {
    "rule": "Publish no more precision than MDT already publishes, on any axis the dashboard does not need.",
    "already_public_via_mdt": [
      "exact coordinates",
      "exact crash date",
      "county",
      "city",
      "collision type",
      "severity",
      "weather",
      "surface",
      "lighting"
    ],
    "minimized_here": {
      "exact date": "reduced to month",
      "exact time": "reduced to hour",
      "vehicle make/model/year": "dropped",
      "per-person records": "aggregated to counts"
    }
  };

/** One entry per column the bundle ships, quoted verbatim from the statewide
 *  build these notices came from.
 *
 *  Entries for columns this pipeline cannot produce were dropped rather than
 *  left in: seg_id and road_system need an LRS route layer, and corridor_id
 *  was a second encoding of what now ships as `corridor`. The decode suite
 *  checks this list against the columns actually shipped, in both directions,
 *  so an entry that outlives its column fails the build's tests. */
export const FIELDS = {
    "county": {
      "type": "category",
      "label": "County",
      "desc": "County from the crash report."
    },
    "city": {
      "type": "category",
      "label": "City or town",
      "desc": "City/town from the crash report; null for crashes outside an incorporated place (55% of records)."
    },
    "collision_type": {
      "type": "category",
      "label": "Collision type",
      "desc": "MDT collision type."
    },
    "weather": {
      "type": "category",
      "label": "Weather",
      "desc": "Reported weather condition."
    },
    "surface": {
      "type": "category",
      "label": "Road surface",
      "desc": "Reported surface condition."
    },
    "lighting": {
      "type": "category",
      "label": "Lighting",
      "desc": "Reported lighting condition."
    },
    "dow": {
      "type": "category",
      "label": "Day of week",
      "desc": "Three-letter abbreviation."
    },
    "kabco": {
      "type": "category",
      "label": "Severity (KABCO)",
      "desc": "K fatal, A suspected serious, B suspected minor, C possible injury, O property damage only, U unknown."
    },
    "hotspot_id": {
      "type": "int32",
      "label": "Intersection cluster",
      "desc": "Derived cluster of intersection-related crashes; -1 where the crash is not intersection-related or its cluster is too small to rank. Not a surveyed intersection -- see meta.hotspots."
    },
    "corridor": {
      "type": "category",
      "label": "MDT corridor",
      "desc": "MDT's \"Corridor Name\" field. It holds an opaque identifier (C000007, C008128), not a road name, and the published extract ships no table to resolve one into the other. It groups crashes onto the same stretch of road reliably; it does not tell you which road that is."
    },
    "year": {
      "type": "Int16",
      "label": "Year",
      "desc": "Crash year, 2016-2025."
    },
    "month": {
      "type": "Int8",
      "label": "Month",
      "desc": "Calendar month, 1-12."
    },
    "hour": {
      "type": "Int8",
      "label": "Hour of day",
      "desc": "0-23, from the reported crash time."
    },
    "lon": {
      "type": "float32",
      "label": "Longitude",
      "desc": "WGS84. See coord_source for where this build's coordinates came from."
    },
    "lat": {
      "type": "float32",
      "label": "Latitude",
      "desc": "WGS84."
    },
    "veh_count": {
      "type": "int16",
      "label": "Vehicles",
      "desc": "Vehicles on the crash record."
    },
    "person_count": {
      "type": "int16",
      "label": "People",
      "desc": "People on the crash record."
    },
    "person_K": {
      "type": "int16",
      "label": "Fatal injuries",
      "desc": "People with a fatal injury. Coded independently of crash severity; the two disagree on 10 of 219,480 records (see master_manifest.json)."
    },
    "is_ka": {
      "type": "bool",
      "label": "Fatal or serious",
      "desc": "KABCO K or A. The standard severity screening measure."
    },
    "is_intersection": {
      "type": "bool",
      "label": "Intersection-related",
      "desc": "Junction relation is an intersection, intersection-related, crossover-related, or driveway/alley access related."
    },
    "work_zone": {
      "type": "bool",
      "label": "Work zone related",
      "desc": "Reported as work-zone related."
    },
    "is_vru": {
      "type": "bool",
      "label": "Vulnerable road user",
      "desc": "Pedestrian or bicycle involved. Union of the crash-level collision type and a non-motorist person record -- neither source alone is complete."
    },
    "is_pedestrian": {
      "type": "bool",
      "label": "Pedestrian involved",
      "desc": "See is_vru for the definition."
    },
    "is_bicycle": {
      "type": "bool",
      "label": "Bicycle involved",
      "desc": "See is_vru for the definition."
    },
    "motorcycle_involved": {
      "type": "bool",
      "label": "Motorcycle involved",
      "desc": "A vehicle with a motorcycle body type."
    },
    "heavy_truck_involved": {
      "type": "bool",
      "label": "Heavy truck involved",
      "desc": "Medium/heavy truck body type, or GVW over 26,000 lb."
    },
    "hit_and_run": {
      "type": "bool",
      "label": "Hit and run",
      "desc": "A driver left the scene."
    },
    "alcohol_suspected": {
      "type": "bool",
      "label": "Alcohol suspected",
      "desc": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment.",
      "caveat": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment."
    },
    "drug_suspected": {
      "type": "bool",
      "label": "Drugs suspected",
      "desc": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment.",
      "caveat": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment."
    },
    "distracted_driver": {
      "type": "bool",
      "label": "Distraction indicated",
      "desc": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment.",
      "caveat": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment."
    },
    "fatigued_driver": {
      "type": "bool",
      "label": "Fatigue indicated",
      "desc": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment.",
      "caveat": "Derived from the investigating officer's field assessment on the crash report. This is not a toxicology result, a charge, or a conviction, and it may be incorrect. Do not read it as a factual finding of impairment."
    },
    "unrestrained_occupant": {
      "type": "bool",
      "label": "Unrestrained occupant",
      "desc": "At least one occupant recorded as using no restraint."
    },
    "occupant_ejected": {
      "type": "bool",
      "label": "Occupant ejected",
      "desc": "At least one occupant partially or totally ejected."
    },
    "is_wildlife": {
      "type": "bool",
      "label": "Wildlife involved",
      "desc": "Collision with a wild animal. Union of the crash-level Collision Type and the First Harmful Event detail, which disagree on 508 crashes. Domestic animals and livestock are coded separately by MDT and are NOT included. Wildlife crashes are common but rarely severe: 0.79% are fatal or suspected-serious against 3.66% statewide."
    }
  };
