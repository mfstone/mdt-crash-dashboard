import { defineConfig } from 'astro/config';
import { county } from './scripts/county.mjs';

// Fully static output: the dashboard reads its data from files next to the page,
// so there is nothing to render on a server and nothing to run at the edge.
export default defineConfig({
  output: 'static',
  /* Undefined unless crashmap.config.json sets "site". This is a tool that
     runs on a laptop: there is no canonical URL, and a site tag left naming
     some previous deployment's hostname is invisible locally and wrong in
     every search result. The page emits canonical and og:url only when this
     is set. */
  site: county.site,
  build: { inlineStylesheets: 'auto' },
  vite: {
    // No analytics of any kind: no beacon, no website id, no endpoint. This
    // runs on the reader's own machine, and the About sheet says so.
    //
    // Every dependency is bundled and self-hosted, which is what lets
    // public/_headers set script-src to 'self' and nothing else.
    build: { target: 'es2022', assetsInlineLimit: 2048 },
  },
});
