/* ---------------------------------------------------------------------------
   charts.js — small inline-SVG charts.

   Hand-rolled rather than a chart library: four simple forms, and the whole
   module is smaller than any library's entry point. Every chart follows the same
   fixed specs — bars capped at 24px with a 4px rounded data-end square at the
   baseline, 2px lines, hairline solid gridlines one step off the surface,
   selective direct labels (never a value on every mark), text in text tokens
   rather than the data colour, and a hover tooltip.

   Most charts here are single-series and use categorical slot 1 only. The
   severity chart is the one multi-colour form and uses the ordinal KABCO ramp
   with a legend plus in-mark labels where they fit.
--------------------------------------------------------------------------- */

const NS = 'http://www.w3.org/2000/svg';
const BAR_MAX = 24;      // never fill the band; leftover is air
const END_R = 4;         // rounded data-end
const GAP = 2;           // surface gap between touching marks

const fmt = new Intl.NumberFormat('en-US');
export const n = (v) => fmt.format(Math.round(v));
export const pct = (v) => `${v.toFixed(1)}%`;

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(e);
  return e;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/** Nice round axis maximum, so ticks land on 0 / 1,000 / 2,000. */
/* Round an axis maximum up to something a reader can divide in their head.

   Not `Math.ceil` to a power of ten: 2,170 would become 10,000 and flatten
   every bar into the bottom fifth of the plot. This picks the nearest 1/2/5
   step at the right magnitude, so the tallest bar always fills most of the
   band and the gridlines land on numbers worth printing. */
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (v <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/* ------------------------------------------------------------------ tooltip */

let tipNode = null;
function tip() {
  if (!tipNode) {
    tipNode = document.createElement('div');
    tipNode.className = 'tip';
    tipNode.hidden = true;
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

export function showTip(evt, title, rows) {
  const t = tip();
  t.innerHTML = '';
  if (title) {
    const d = document.createElement('div');
    d.className = 't';
    d.textContent = title;
    t.appendChild(d);
  }
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    r.className = 'r';
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('span'); b.textContent = v;
    r.append(a, b);
    t.appendChild(r);
  }
  t.hidden = false;
  // Keep the tooltip inside the viewport without covering the cursor.
  const pad = 12;
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 4) x = evt.clientX - w - pad;
  if (y + h > innerHeight - 4) y = evt.clientY - h - pad;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}

export function hideTip() { if (tipNode) tipNode.hidden = true; }

/* ------------------------------------------------- columns (counts by band) */

/**
 * Column chart for an ordered band — years, hours of day.
 * Single series, categorical slot 1. Labels only the extreme, per the
 * selective-labelling rule; the axis and tooltip carry the rest.
 */
/* Vertical columns — crashes by year, hour of day.

   `onPick` makes the bars a filter control rather than a readout, which is why
   the whole chart is keyboard-reachable and the active column is marked with
   `activeLabel` rather than colour alone. A reader who cannot distinguish the
   active bar by hue still sees it named beneath the chart.

   The domain is passed in rather than derived from `data`, because `data` is
   already filtered: deriving it here would rescale the y-axis on every filter
   change and make two adjacent states incomparable. */
export function columns(svg, data, opts = {}) {
  const {
    height = 132, color = 'var(--series-1)', labelEvery = 1,
    tipTitle = (d) => String(d.label), tipRows = (d) => [['Crashes', n(d.n)]],
    highlight = null,
  } = opts;

  clear(svg);
  const W = svg.clientWidth || svg.parentElement.clientWidth || 320;
  const padL = 34, padR = 6, padT = 8, padB = 18;
  const H = height;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);

  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(1, ...data.map((d) => d.n)));
  const band = plotW / Math.max(1, data.length);
  const bw = Math.min(BAR_MAX, Math.max(2, band - GAP));

  // Hairline solid gridlines, one step off the surface.
  for (const frac of [0, 0.5, 1]) {
    const y = padT + plotH * (1 - frac);
    el('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }, svg);
    el('text', {
      class: 'axis-text num', x: padL - 5, y: y + 3.5, 'text-anchor': 'end',
    }, svg).textContent = n(max * frac);
  }

  const peak = data.reduce((a, d) => (d.n > a.n ? d : a), data[0] ?? { n: 0 });

  data.forEach((d, i) => {
    const h = (d.n / max) * plotH;
    const x = padL + i * band + (band - bw) / 2;
    const y = padT + plotH - h;
    const isHi = highlight ? highlight(d) : false;

    if (h > 0) {
      // Rounded at the data end, square at the baseline: draw a path rather
      // than a rect so only the top corners are radiused.
      const r = Math.min(END_R, bw / 2, h);
      el('path', {
        d: `M${x},${padT + plotH} V${y + r} Q${x},${y} ${x + r},${y}
            H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r}
            V${padT + plotH} Z`.replace(/\s+/g, ' '),
        fill: color, opacity: isHi ? 1 : 0.92,
      }, svg);
    }

    if (i % labelEvery === 0) {
      el('text', {
        class: 'axis-text', x: x + bw / 2, y: H - 5, 'text-anchor': 'middle',
      }, svg).textContent = opts.tickLabel ? opts.tickLabel(d, i) : d.label;
    }

    // Hit target spans the whole band, not just the bar.
    const hit = el('rect', {
      class: 'hit', x: padL + i * band, y: padT, width: band, height: plotH,
    }, svg);
    hit.addEventListener('pointermove', (e) => showTip(e, tipTitle(d), tipRows(d)));
    hit.addEventListener('pointerleave', hideTip);
  });

  // One direct label, on the peak only.
  if (peak && peak.n > 0) {
    const i = data.indexOf(peak);
    const h = (peak.n / max) * plotH;
    const x = padL + i * band + band / 2;
    const y = padT + plotH - h - 4;
    if (y > padT + 7) {
      el('text', {
        class: 'mark-label', x, y, 'text-anchor': 'middle',
      }, svg).textContent = n(peak.n);
    }
  }
}

/* ------------------------------------------------------ horizontal bar list */

/**
 * Ranked horizontal bars — collision types, counties.
 * One series, one colour; value at the tip. A value-ramp across nominal
 * categories would double-encode bar length as hue, so it is not used.
 */
/* Horizontal bars — collision type, county.

   Horizontal because these categories carry long names. A vertical form would
   need rotated tick labels, which cost more legibility than the extra width
   costs layout. */
export function bars(svg, data, opts = {}) {
  const {
    rowH = 20, color = 'var(--series-1)', labelW = 118,
    tipRows = (d) => [['Crashes', n(d.n)]], onPick = null, activeLabel = null,
  } = opts;

  clear(svg);
  const W = svg.clientWidth || svg.parentElement.clientWidth || 320;
  const H = Math.max(1, data.length) * rowH + 4;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);

  const padR = 44;
  const plotW = Math.max(10, W - labelW - padR);
  const max = Math.max(1, ...data.map((d) => d.n));
  const bh = Math.min(BAR_MAX, rowH - 6);

  data.forEach((d, i) => {
    const y = i * rowH + 2;
    const w = (d.n / max) * plotW;
    const active = activeLabel !== null && d.label === activeLabel;

    const label = el('text', {
      class: 'axis-text', x: 0, y: y + bh / 2 + 3.5,
      fill: active ? 'var(--text-primary)' : null,
      'font-weight': active ? 600 : null,
    }, svg);
    label.textContent = d.label;
    // Truncate in the DOM rather than clipping with overflow, which would crop
    // characters mid-glyph.
    if (String(d.label).length > 18) {
      label.textContent = `${String(d.label).slice(0, 17)}…`;
    }

    if (w > 0) {
      const r = Math.min(END_R, bh / 2, w);
      el('path', {
        d: `M${labelW},${y} H${labelW + w - r} Q${labelW + w},${y} ${labelW + w},${y + r}
            V${y + bh - r} Q${labelW + w},${y + bh} ${labelW + w - r},${y + bh}
            H${labelW} Z`.replace(/\s+/g, ' '),
        fill: d.isOther ? 'var(--text-muted)' : color,
        opacity: activeLabel === null || active ? 0.92 : 0.45,
      }, svg);
    }

    el('text', {
      class: 'mark-label', x: labelW + w + 6, y: y + bh / 2 + 3.5,
    }, svg).textContent = n(d.n);

    const hit = el('rect', {
      class: 'hit', x: 0, y, width: W, height: rowH,
      style: onPick ? 'cursor:pointer' : null,
    }, svg);
    hit.addEventListener('pointermove', (e) => showTip(e, String(d.label), tipRows(d)));
    hit.addEventListener('pointerleave', hideTip);
    if (onPick && !d.isOther) {
      hit.addEventListener('click', () => { hideTip(); onPick(d); });
    }
  });
}

/* ------------------------------------------------------- 100% stacked strip */

/**
 * One horizontal 100% stack — the severity mix.
 * The ordinal KABCO ramp, with a 2px surface gap between segments (never a
 * stroke), and an in-segment label only where the text actually fits.
 */
/* A single stacked bar — the severity mix.

   The one multi-colour form here, and the only one using the ordinal KABCO
   ramp. Segments are separated by a 2px gap of the surface colour rather than
   a stroke: a stroke would sit INSIDE the segment and shrink the thing being
   measured, which is a lie about a proportion.

   Labels print inside a segment only where they fit; the legend carries the
   rest. Printing every one would overplot the narrow severities, which are
   exactly the ones that matter most. */
export function stack(svg, data, opts = {}) {
  const { height = 30, colorOf = () => 'var(--series-1)' } = opts;
  clear(svg);
  const W = svg.clientWidth || svg.parentElement.clientWidth || 320;
  const H = height;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);

  const total = data.reduce((a, d) => a + d.n, 0);
  if (!total) {
    el('text', { class: 'axis-text', x: 0, y: H / 2 + 4 }, svg)
      .textContent = 'No crashes match these filters';
    return;
  }

  const barH = Math.min(BAR_MAX, H - 8);
  let x = 0;
  const live = data.filter((d) => d.n > 0);

  live.forEach((d, i) => {
    const raw = (d.n / total) * W;
    // Reserve the surface gap from the segment, so the gap width is constant
    // across the stack rather than varying with segment size.
    const w = Math.max(1, raw - (i < live.length - 1 ? GAP : 0));
    const first = i === 0, last = i === live.length - 1;
    const r = Math.min(END_R, w / 2, barH / 2);

    let d2;
    if (first || last) {
      // Round only the outer ends of the whole strip.
      d2 = first
        ? `M${x + r},0 H${x + w} V${barH} H${x + r} Q${x},${barH} ${x},${barH - r} V${r} Q${x},0 ${x + r},0 Z`
        : `M${x},0 H${x + w - r} Q${x + w},0 ${x + w},${r} V${barH - r} Q${x + w},${barH} ${x + w - r},${barH} H${x} Z`;
    } else {
      d2 = `M${x},0 H${x + w} V${barH} H${x} Z`;
    }
    el('path', { d: d2.replace(/\s+/g, ' '), fill: colorOf(d) }, svg);

    const share = (d.n / total) * 100;
    const text = share >= 10 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`;
    // ~6.2px per character at 10px; only label when it fits with padding.
    if (w > text.length * 6.2 + 10) {
      el('text', {
        x: x + w / 2, y: barH / 2 + 3.5, 'text-anchor': 'middle',
        'font-size': 10, 'font-variant-numeric': 'tabular-nums',
        fill: d.onDark ? '#fff' : 'var(--text-primary)',
      }, svg).textContent = text;
    }

    const hit = el('rect', { class: 'hit', x, y: 0, width: w, height: barH }, svg);
    hit.addEventListener('pointermove', (e) => showTip(e, d.label, [
      ['Crashes', n(d.n)], ['Share', pct(share)],
    ]));
    hit.addEventListener('pointerleave', hideTip);

    x += raw;
  });
}

/* --------------------------------------------------------------- table view */

/** The accessible equivalent of any chart above, and the relief for the
    low-contrast light-mode severity steps. */
/* The table view of a chart — the accessibility relief, one click away.

   Every chart has one. It is not a fallback for when SVG fails; it is the
   form that works with a screen reader, with a colour-vision deficiency, and
   when someone needs the actual numbers rather than their shape. The chart
   specs permit marks below 3:1 contrast on the light surface precisely BECAUSE
   this exists, so it is a load-bearing part of the design rather than a
   courtesy. */
export function table(container, caption, head, rows) {
  container.innerHTML = '';
  const t = document.createElement('table');
  t.className = 'datatable';
  const cap = document.createElement('caption');
  cap.textContent = caption;
  t.appendChild(cap);
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    th.scope = 'col';
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = document.createElement('tbody');
  for (const r of rows) {
    const row = document.createElement('tr');
    r.forEach((cell, i) => {
      const td = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) td.scope = 'row';
      else td.className = 'num';
      td.textContent = cell;
      row.appendChild(td);
    });
    tb.appendChild(row);
  }
  t.appendChild(tb);
  container.appendChild(t);
}

export function legend(container, items) {
  container.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('span');
    d.className = 'item';
    const s = document.createElement('span');
    s.className = 'swatch';
    s.style.background = it.color;
    const t = document.createElement('span');
    t.textContent = it.label;
    d.append(s, t);
    container.appendChild(d);
  }
}
