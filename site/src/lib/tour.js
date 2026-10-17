/* ---------------------------------------------------------------------------
   tour.js — a guided walkthrough of the dashboard.

   The dashboard has grown five report modes, two map encodings, a basemap
   and thirteen filter factors, and several of those carry caveats that change
   how the numbers should be read. A legend can say what a colour means; it
   cannot say why a ranking of fatal-and-serious crashes is partly a ranking of
   how one city codes injuries. So the tour does the explaining, on the real
   interface, with the real data.

   Each step may run `before()` to put the dashboard into the state the step is
   describing — switching to a report, turning on the rate map — so the reader
   sees the actual thing rather than a description of it. The tour therefore
   changes app state as it runs, and restores the opening view when it ends.
--------------------------------------------------------------------------- */

import county from './county.js';

const SEEN_KEY = 'tour-done-v1';
const PAD = 8;

export function tourTaken() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

function markTaken() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
}

/**
 * The script.
 *
 * `target` is a selector, or null for a centred card with no spotlight.
 * `before(api)` may change app state; it is awaited, then the target is
 * measured, so a step can reveal its own subject.
 */
export function steps(api) {
  const { setMode, setLines, setPoints, setPlanned, openSheet, flyHome } = api;
  /* Everything the narrative quotes comes from the built bundle, not from
     this file and not from the county config. A county swap is then a data
     rebuild, with no prose to re-derive and no second copy of a statistic to
     fall out of step with the About sheet. */
  const scope = api.scope?.() || null;
  const where = scope?.label || 'this county';
  const place = api.topPlace?.() || null;
  const sev = scope?.severity_coding || null;
  /* Read off the tile the reader is looking at rather than written here. A
     tour that quotes a different total from the dashboard beside it is worse
     than one that quotes none. */
  const total = document.getElementById('t-total')?.textContent?.trim() || '';
  return [
    {
      target: null,
      title: county.title,
      body: `Every police-reported crash in ${where} from 2016 to 2025
        ${total ? `— <strong>${total} of them</strong> —` : ''} mapped and
        filterable. Nothing is pre-computed: every number you see is calculated
        from the full record set as you change the filters.
        <br><br>This tour takes about a minute. You can leave at any point and
        restart it from the <strong>Tutorial</strong> button.`,
      before: async () => {
        setMode('explore'); setLines('count'); setPoints('points');
        setPlanned(false); flyHome();
      },
    },
    {
      target: '#map',
      title: 'The road network',
      body: `Lines are the <strong>2,166 road segments that carry at least one
        crash</strong>. Line width is the number of crashes and colour is how
        many were fatal or seriously injurious.
        <br><br>This is a <em>count</em> map, so it mostly shows you where the
        traffic is: cities glow because cities are busy.`,
      placement: 'right',
    },
    {
      target: '#legend-roads',
      title: 'Count, or rate',
      body: `Switch the network to <strong>crashes per 100 million
        vehicle-miles</strong> — the standard way to compare roads that carry
        very different amounts of traffic.
        <br><br>Watch the map change: the urban glow fades and rural corridors
        come forward. Those roads carry few vehicles, so even a handful of
        crashes is a high rate. It is a different question, and a different
        answer.`,
      before: async () => { setLines('rate'); },
    },
    {
      target: '#map',
      title: 'Crash points',
      body: `Zoom past level 8 and individual crashes appear, coloured by
        severity on the <strong>KABCO</strong> scale. Click any crash — or any
        road segment — for its details.
        <br><br>Only roads with an MDT traffic count can carry a rate —
        <strong>171 of 2,166 segments here, about one in thirteen</strong>. The
        rest stay a faint grey: context, not a value of zero.`,
      placement: 'right',
    },
    {
      target: '#pmodebar',
      title: 'Points, or density',
      body: `<strong>Heatmap</strong> swaps the individual marks for the density
        of the same crashes — the very records your filter selects, so the two
        views cannot disagree.
        <br><br>It weights every crash equally, so it answers <em>how many</em>,
        not how bad: a cluster of parking-lot scrapes burns as hot as a cluster
        of fatal crashes. Use the severity filter for the other question.`,
      before: async () => { setPoints('heat'); },
    },
    {
      // Not `.rail .group:first-child` -- that is the active-filters bar, which
      // is hidden until something is filtered, so this step spotlighted nothing
      // at exactly the moment it was explaining the filters.
      target: '#yearsgroup',
      title: 'Filters change everything at once',
      body: `Narrow the years and the map, the charts and every report
        recalculate together — typically in under 50 milliseconds, because the
        whole dataset is held in your browser.
        <br><br>Nothing here calls a server. The page works the same whether
        one person or ten thousand are using it.`,
      before: async () => { openSheet(); setLines('count'); setPoints('points'); },
    },
    {
      target: '#sevchips',
      title: 'Severity',
      body: `<strong>K</strong> fatal · <strong>A</strong> suspected serious ·
        <strong>B</strong> suspected minor · <strong>C</strong> possible injury ·
        <strong>O</strong> property damage only · <strong>U</strong> unknown.
        <br><br>K and A together — "K+A" — are the standard measure of serious
        road harm, and most of this dashboard is built around them. They are
        <strong>2.8% of crashes here</strong> — 562 of 19,778.`,
    },
    {
      target: '#facchips',
      title: 'Contributing factors',
      body: `Factors combine with <strong>AND</strong>: pick two and you get
        crashes where both are recorded.
        <br><br>Four of them — alcohol, drugs, distraction, fatigue — record the
        <strong>investigating officer's field assessment</strong>. They are not
        toxicology results, charges or convictions, and they can be wrong. The
        dashboard labels them "suspected" and "indicated" everywhere for that
        reason.`,
    },
    {
      target: '#modebar',
      title: 'Seven ways to read the data',
      body: `<strong>Explore</strong> is the general view. The other six answer
        specific questions, and each respects whatever filters you have set — so
        "most dangerous intersections" and "most dangerous intersections at
        night in winter" are the same tool.`,
    },
    {
      target: '#report',
      title: 'Intersections — and a warning',
      body: `Intersection crash clusters ranked by fatal and serious crashes.
        ${place ? `<br><br>Most of them are in ${place}, which is mostly a fact
        about where the traffic is. But read` : '<br><br>Read'} the ranking
        carefully: <strong>suspected serious injury is an officer's on-scene
        judgement</strong>, and it is not coded to one threshold across Montana.
        ${sev ? `${where} records ${sev.a_per_k_here} suspected-serious injuries
        per fatality against ${sev.a_per_k_statewide} statewide — and that gap
        is wider inside one county, where a single agency's habits are not
        averaged against the rest of the state.` : `A county-level ranking is
        therefore partly a ranking of local reporting practice, because one
        agency's habits are not averaged against the rest of the state.`}
        <br><br>Switch to <strong>Fatal only</strong> for a measure that does
        not depend on where the threshold is drawn. The dashboard says so on the
        report itself.`,
      before: async () => { setMode('intersections'); openSheet(); },
    },
    {
      target: '#report',
      title: 'Rising, walking and biking, wildlife',
      body: `<strong>Rising</strong> compares the first and second half of your
        selected years by place — two totals rather than a fitted trend line,
        because at these counts a trend line would claim precision the data does
        not have.
        <br><br><strong>Walk / bike</strong> ranks places by pedestrian and
        bicycle casualties. Those are rare but far more severe — a much larger
        share of them are fatal or serious than of crashes overall.
        <br><br><strong>Wildlife</strong> ranks signed routes by volume, not
        severity. Animal collisions are common and rarely severe, so ranking
        them by harm would be ranking noise. Each report states its own counts
        and the gates it applied.`,
      before: async () => { setMode('rising'); openSheet(); },
    },
    {
      target: '#copylink',
      title: 'Everything is a link',
      body: `Filters, report mode, map position — all of it lives in the URL.
        <strong>Copy link</strong> gives you exactly what is on your screen, so
        a finding can be sent to someone else as a link rather than a
        screenshot. The back button works too.`,
      before: async () => { setMode('explore'); },
    },
    /* Only for a county whose config names a plan bundle. A tour step pointing
       at a button that was never unhidden strands the reader on a highlight of
       nothing. */
    ...(county.plannedProjects ? [{
      target: '#lrtptoggle',
      title: 'What is planned here',
      body: `An optional layer of the <strong>${county.plannedProjects.label}</strong>
        — committed projects as solid lines, recommended and proposed as dashed,
        each switchable on its own.
        <br><br>It is planned work, not crash data. A project on a road is not a
        safety finding about that road, and the absence of one is not a finding
        either: the plan runs on its own timetable. It is here so you can see
        the two side by side and ask your own question.`,
      before: async () => { setPlanned(true); },
    }] : []),
    {
      target: '#aboutbtn',
      title: 'Read the caveats',
      body: `Crash records are administrative data: they contain errors, they
        are coded to the standards of the year they were filed, and the most
        recent year may be incomplete.
        <br><br>The About panel documents where every number comes from, what
        was deliberately left out, and what each field can and cannot support.
        It is worth reading before you draw a conclusion from any of this.`,
    },
    {
      target: null,
      title: 'That’s the tour',
      body: `Restart it any time from <strong>Tutorial</strong> in the toolbar.
        <br><br>A good place to begin: set the severity filter to
        <strong>K</strong> and <strong>A</strong>, switch the network to
        <strong>Rate</strong>, and see which roads come forward.`,
      before: async () => {
        setMode('explore'); setLines('count'); setPoints('points');
        setPlanned(false); flyHome();
      },
    },
  ];
}

/* ------------------------------------------------------------------ runner */

export function createTour(api) {
  let list = [];
  let i = 0;
  let root = null;
  let spot = null;
  let card = null;
  let onKey = null;
  let onReflow = null;

  function build() {
    root = document.createElement('div');
    root.className = 'tour-root';
    root.innerHTML = `
      <div class="tour-spot" id="tourspot" hidden></div>
      <div class="tour-card" id="tourcard" role="dialog" aria-modal="true"
           aria-labelledby="tourtitle">
        <div class="tour-step" id="tourstep"></div>
        <h2 id="tourtitle"></h2>
        <div class="tour-body" id="tourbody"></div>
        <div class="tour-nav">
          <button type="button" class="linkbtn" id="tourskip">Skip tour</button>
          <span class="spacer"></span>
          <button type="button" class="btn" id="tourback">Back</button>
          <button type="button" class="btn primary" id="tournext">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    spot = root.querySelector('#tourspot');
    card = root.querySelector('#tourcard');
    root.querySelector('#tourskip').addEventListener('click', end);
    root.querySelector('#tourback').addEventListener('click', () => go(i - 1));
    root.querySelector('#tournext').addEventListener('click', () => go(i + 1));
    // A click on the dim area advances; a click on the spotlit element does not,
    // so a reader can try the thing being described.
    root.addEventListener('click', (e) => { if (e.target === root) go(i + 1); });
  }

  function place(target) {
    if (!target) {
      spot.hidden = true;
      card.classList.add('centred');
      card.style.left = ''; card.style.top = '';
      return;
    }
    const el = document.querySelector(target);
    const r = el?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) { place(null); return; }

    // Clamp to the viewport. A report panel can be 2,000 px tall; an unclamped
    // cut-out that size reads as "no highlight at all" because its edges are
    // off-screen, and the card then has nowhere sensible to sit beside it.
    const left = Math.max(6, r.left - PAD);
    const top = Math.max(6, r.top - PAD);
    const right = Math.min(innerWidth - 6, r.right + PAD);
    const bottom = Math.min(innerHeight - 6, r.bottom + PAD);
    spot.hidden = false;
    spot.style.left = `${left}px`;
    spot.style.top = `${top}px`;
    spot.style.width = `${Math.max(0, right - left)}px`;
    spot.style.height = `${Math.max(0, bottom - top)}px`;

    card.classList.remove('centred');
    const cw = card.offsetWidth || 360;
    const ch = card.offsetHeight || 220;
    const gap = 16;
    // Prefer the side with the most room, then clamp into the viewport. Rooms
    // are measured against the clamped spotlight, not the raw element.
    const rightRoom = innerWidth - right;
    const leftRoom = left;
    const belowRoom = innerHeight - bottom;
    let x; let y;
    if (rightRoom > cw + gap || leftRoom > cw + gap) {
      x = rightRoom >= leftRoom ? right + gap : left - cw - gap;
      y = (top + bottom) / 2 - ch / 2;
    } else {
      x = (left + right) / 2 - cw / 2;
      y = belowRoom > ch + gap ? bottom + gap : top - ch - gap;
    }
    card.style.left = `${Math.max(10, Math.min(innerWidth - cw - 10, x))}px`;
    card.style.top = `${Math.max(10, Math.min(innerHeight - ch - 10, y))}px`;
  }

  async function go(n) {
    if (n < 0) return;
    if (n >= list.length) { end(); return; }
    i = n;
    const step = list[i];
    if (step.before) {
      try { await step.before(); } catch { /* a step must never trap the tour */ }
      // Let the layout settle before measuring the target.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    root.querySelector('#tourstep').textContent = `${i + 1} of ${list.length}`;
    root.querySelector('#tourtitle').textContent = step.title;
    root.querySelector('#tourbody').innerHTML = step.body;
    root.querySelector('#tourback').disabled = i === 0;
    root.querySelector('#tournext').textContent =
      i === list.length - 1 ? 'Finish' : 'Next';
    place(step.target);
    root.querySelector('#tournext').focus();
  }

  function start() {
    if (root) end();
    list = steps(api);
    build();
    i = -1;
    onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); end(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    };
    onReflow = () => place(list[i]?.target);
    addEventListener('keydown', onKey);
    addEventListener('resize', onReflow, { passive: true });
    addEventListener('scroll', onReflow, { passive: true, capture: true });
    document.body.classList.add('tour-open');
    go(0);
  }

  function end() {
    markTaken();
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onReflow);
    removeEventListener('scroll', onReflow, { capture: true });
    document.body.classList.remove('tour-open');
    root?.remove();
    root = null;
    api.onEnd?.();
  }

  return { start, end, isOpen: () => Boolean(root) };
}
