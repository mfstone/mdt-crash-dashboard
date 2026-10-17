/* The county, as the browser bundle sees it.
 *
 * The SAME file the pipeline validates and the Astro build reads, imported
 * through Vite rather than fs. There is one crashmap.config.json and it lives
 * at the repo root, so pointing this app at another county is editing that one
 * file and rebuilding -- not a fork, which is how the second county's build
 * came to exist in the first place.
 */
import raw from '../../../crashmap.config.json';
import { derive } from './county-derive.js';

export default derive(raw);
