/* The rules that turn crashmap.config.json into the county the app shows.
 *
 * Deliberately free of imports so all THREE sides can share it: the pipeline's
 * validator (Node, fs), the Astro build (Node, fs) and the browser bundle
 * (Vite, a JSON import). Two copies of these rules is how the page title and
 * the data build would eventually come to disagree about which county this is.
 */
export function derive(raw) {
  const c = { ...raw };
  /* "Missoula" plus "County Crash Explorer" is not a decision worth making
     twice per county, but either can still be set explicitly for a place whose
     name does not take the pattern -- or for a statewide build, which has no
     county at all. */
  c.shortName ||= c.county ? `${c.county} County` : 'Montana';
  c.title ||= c.county ? `${c.county} County Crash Explorer` : 'Montana Crash Explorer';
  /* Absent means "this county has no published long-range plan bundle", which
     is the common case and must not read as a missing edit. The overlay is
     then absent rather than broken. */
  c.plannedProjects ??= null;
  return c;
}
