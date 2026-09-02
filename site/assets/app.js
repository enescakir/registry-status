/* registry-status — renders the measurements produced by scripts/aggregate.py.
   No dependencies: plain DOM and hand-built SVG. */

'use strict';

const DATA_URL = 'data/ghcr.json';

/* Region order puts Europe first: the page is asking about Europe.
   Colours are bound to the region here and nowhere else, so a filter can
   never repaint a series. */
const REGIONS = [
  { key: 'ubicloud', name: 'Europe', color: 'var(--eu)' },
  { key: 'github', name: 'United States', color: 'var(--us)' },
];

const RANGES = {
  '24h': { source: 'series', hours: 24, label: 'last 24 hours', grain: 'run' },
  '7d': { source: 'series', hours: 24 * 7, label: 'last 7 days', grain: 'run' },
  '30d': { source: 'daily', hours: 24 * 30, label: 'last 30 days', grain: 'day' },
  '90d': { source: 'daily', hours: 24 * 90, label: 'last 90 days', grain: 'day' },
};

/* Each chart names the field it reads at run grain and at day grain. */
const CHARTS = {
  latency: {
    run: 'manifest_ms', day: 'manifest_p50_ms',
    unit: 'ms', axis: 'ms', height: 210, better: 'lower',
  },
  pull: {
    run: 'pull_mbps', day: 'pull_p50_mbps',
    unit: 'MB/s', axis: 'MB/s', height: 180, better: 'higher',
  },
  push: {
    run: 'push_mbps', day: 'push_p50_mbps',
    unit: 'MB/s', axis: 'MB/s', height: 180, better: 'higher',
  },
};

const STATE = { data: null, range: '7d', hover: {} };

/* ------------------------------------------------------------- formatting */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function fmtMs(v) {
  if (!isNum(v)) return '—';
  if (v >= 10000) return `${(v / 1000).toFixed(1)} s`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${Math.round(v)} ms`;
  return `${v.toFixed(1)} ms`;
}

function fmtMbps(v) {
  return isNum(v) ? `${v.toFixed(1)} MB/s` : '—';
}

function fmtPct(v) {
  if (!isNum(v)) return '—';
  if (v >= 100) return '100%';
  return `${v.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function fmtValue(v, unit) {
  if (!isNum(v)) return '—';
  return unit === 'ms' ? fmtMs(v) : fmtMbps(v);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const STATUS_WORDS = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Failing',
  unknown: 'No data',
};

/* ------------------------------------------------------------------ ribbon */

/* curl reports handshake timings cumulatively, so each stage is the gap to
   the one before it. */
function phaseSegments(window_) {
  if (!window_) return null;
  const marks = [window_.dns_p50_ms, window_.tcp_p50_ms, window_.tls_p50_ms, window_.ttfb_p50_ms];
  if (!marks.every(isNum)) return null;
  const segs = [];
  let prev = 0;
  for (const mark of marks) {
    segs.push(Math.max(0, mark - prev));
    prev = Math.max(prev, mark);
  }
  return { segs, total: marks[3] };
}

function renderRibbon(groups) {
  const host = document.getElementById('ribbon-rows');
  const verdict = document.getElementById('ribbon-verdict');
  host.textContent = '';

  const rows = REGIONS.map((region) => ({
    region,
    phases: phaseSegments(groups[region.key] && groups[region.key].windows['24h']),
  })).filter((row) => row.phases);

  if (!rows.length) {
    host.append(el('p', 'empty', 'No handshake timings yet. The first hourly run will fill this in.'));
    verdict.textContent = '';
    return;
  }

  const scale = Math.max(...rows.map((row) => row.phases.total));
  const names = ['DNS', 'TCP connect', 'TLS handshake', 'Waiting for first byte'];
  const bars = [];

  for (const { region, phases } of rows) {
    const row = el('div', 'ribbon-row');

    const label = el('div', 'ribbon-label');
    const dot = el('span', 'dot');
    dot.style.background = region.color;
    label.append(dot, el('span', 'ribbon-place', region.name));

    const track = el('div', 'ribbon-track');
    const bar = el('div', 'ribbon-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label',
      `${region.name}: ${names.map((n, i) => `${n} ${fmtMs(phases.segs[i])}`).join(', ')}. Total ${fmtMs(phases.total)}.`);

    phases.segs.forEach((value, i) => {
      const seg = el('div', `seg seg-${i + 1}`);
      seg.title = `${names[i]} · ${fmtMs(value)}`;
      seg.dataset.target = `${(value / scale) * 100}%`;
      seg.style.width = '0%';
      bar.append(seg);
      bars.push(seg);
    });

    track.append(bar, el('span', 'ribbon-total', fmtMs(phases.total)));
    row.append(label, track);
    host.append(row);
  }

  /* One orchestrated reveal, skipped when the visitor asked for less motion. */
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = () => bars.forEach((seg) => { seg.style.width = seg.dataset.target; });
  if (still) paint();
  else requestAnimationFrame(() => requestAnimationFrame(paint));

  const eu = rows.find((r) => r.region.key === 'ubicloud');
  const us = rows.find((r) => r.region.key === 'github');
  if (!eu || !us) {
    verdict.textContent = 'Waiting for measurements from both regions.';
    return;
  }

  /* State the totals, then explain the mechanism. Written to hold whichever
     way round the measurements come out: the handshake and the registry's own
     response time move independently, and they often point opposite ways. */
  const sum = (segs, from, to) => segs.slice(from, to).reduce((a, b) => a + b, 0);
  const euShake = sum(eu.phases.segs, 0, 3);
  const usShake = sum(us.phases.segs, 0, 3);
  const euWait = eu.phases.segs[3];
  const usWait = us.phases.segs[3];
  const dShake = euShake - usShake;
  const dWait = euWait - usWait;
  const flat = (v) => Math.abs(v) < 3;

  let mechanism;
  if (flat(dShake) && flat(dWait)) {
    mechanism = 'Both paths behave the same at every stage.';
  } else if (dShake < 0 && dWait > 0) {
    mechanism = `Europe opens the connection <b>${fmtMs(-dShake)}</b> faster, then waits `
      + `<b>${fmtMs(dWait)}</b> longer for the registry to answer.`;
  } else if (dShake > 0 && dWait < 0) {
    mechanism = `Europe spends <b>${fmtMs(dShake)}</b> more opening the connection, then gets `
      + `its answer <b>${fmtMs(-dWait)}</b> sooner.`;
  } else if (dShake <= 0 && dWait <= 0) {
    mechanism = 'Europe is ahead at both the handshake and the response.';
  } else {
    mechanism = 'Europe is behind at both the handshake and the response.';
  }

  verdict.innerHTML =
    `ghcr.io returns a first byte in <b>${fmtMs(eu.phases.total)}</b> from Europe and `
    + `<b>${fmtMs(us.phases.total)}</b> from the United States. ${mechanism}`;
}

/* -------------------------------------------------------------- hero facts */

/* Cadence is read back off the data rather than hard-coded, so the page stays
   honest if the schedule changes. */
function measuredCadence(groups) {
  const stamps = REGIONS
    .flatMap((r) => ((groups[r.key] && groups[r.key].series) || []).map((p) => Date.parse(p.ts)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) {
    const gap = stamps[i] - stamps[i - 1];
    if (gap > 60000) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mins = Math.round(gaps[Math.floor(gaps.length / 2)] / 60000);
  if (mins >= 55 && mins <= 65) return 'Every hour';
  if (mins >= 120) return `Every ${Math.round(mins / 60)} hours`;
  return `Every ${mins} minutes`;
}

function renderHeroFacts(data) {
  const host = document.getElementById('hero-facts');
  if (!host) return;
  host.textContent = '';

  const latest = REGIONS
    .map((r) => data.groups[r.key] && data.groups[r.key].latest)
    .find((l) => l && isNum(l.blob_bytes));
  const reps = REGIONS
    .map((r) => data.groups[r.key] && data.groups[r.key].latest)
    .find((l) => l && isNum(l.reps));

  const facts = [
    ['Cadence', measuredCadence(data.groups) || '—',
      reps ? `${reps.reps} repetitions per runner` : ''],
    ['Payload', latest ? `${Math.round(latest.blob_bytes / 1048576)} MB` : '—',
      'random bytes, new every run'],
    ['Stages timed', '5', 'DNS through docker pull'],
    ['History', isNum(data.total_samples) ? data.total_samples.toLocaleString() : '—',
      data.first_sample ? `probes since ${dayFmt.format(new Date(data.first_sample))}` : 'probes recorded'],
  ];

  for (const [label, value, note] of facts) {
    const fact = el('div', 'fact');
    fact.append(el('dt', null, label));
    const dd = el('dd', null, value);
    if (note) dd.append(el('span', null, note));
    fact.append(dd);
    host.append(fact);
  }
}

/* ------------------------------------------------------------------- cards */

function metric(label, value, unit, foot) {
  const wrap = el('div', 'metric');
  wrap.append(el('p', 'metric-label', label));
  const line = el('p', 'metric-value');
  line.append(document.createTextNode(value));
  if (unit) line.append(el('span', 'metric-unit', unit));
  wrap.append(line);
  if (foot) wrap.append(el('p', 'metric-foot', foot));
  return wrap;
}

function splitUnit(text) {
  const match = /^(-?[\d.]+)\s*(.*)$/.exec(text);
  return match ? [match[1], match[2]] : [text, ''];
}

function renderCards(groups) {
  const host = document.getElementById('cards');
  host.textContent = '';

  for (const region of REGIONS) {
    const group = groups[region.key];
    const card = el('article', 'card');

    const top = el('div', 'card-top');
    const heading = el('div');
    const place = el('h3', 'card-place');
    const dot = el('span', 'dot');
    dot.style.cssText = `background:${region.color};display:inline-block;margin-right:9px;vertical-align:0.08em`;
    place.append(dot, document.createTextNode(region.name));
    heading.append(place);

    const latest = group && group.latest;
    const status = latest ? latest.status : 'unknown';
    const state = el('div', 'card-state');
    state.append(el('span', `dot dot-${status}`), el('span', null, STATUS_WORDS[status] || status));
    top.append(heading, state);
    card.append(top);

    if (!latest) {
      card.append(el('p', 'empty', 'No measurement recorded yet.'));
      host.append(card);
      continue;
    }

    /* Labels stay short enough not to wrap in the two-column mobile grid;
       the window and the comparison live on the footnote line. */
    const w24 = (group.windows && group.windows['24h']) || {};
    const metrics = el('div', 'metrics');
    metrics.append(
      metric('Availability', fmtPct(w24.availability), '',
        `24 h · ${w24.samples || 0} probe${w24.samples === 1 ? '' : 's'}`),
      metric('Manifest p50', ...splitUnit(fmtMs(w24.manifest_p50_ms)),
        `p95 ${fmtMs(w24.manifest_p95_ms)}`),
      metric('Pull p50', ...splitUnit(fmtMbps(w24.pull_p50_mbps)),
        `latest ${fmtMbps(latest.pull_mbps)}`),
      metric('Push p50', ...splitUnit(fmtMbps(w24.push_p50_mbps)),
        `latest ${fmtMbps(latest.push_mbps)}`),
    );
    card.append(metrics);

    const bits = [`last run ${relativeTime(latest.ts)}`];
    if (latest.remote_ip) bits.push(`edge ${latest.remote_ip}`);
    if (isNum(latest.blob_bytes)) bits.push(`${Math.round(latest.blob_bytes / 1048576)} MB payload`);
    if (latest.failing_probes && latest.failing_probes.length) {
      bits.push(`failing: ${latest.failing_probes.join(', ')}`);
    }
    card.append(el('p', 'card-foot', bits.join('  ·  ')));
    host.append(card);
  }
}

/* ------------------------------------------------------------------ uptime */

function availabilityLevel(v) {
  if (!isNum(v)) return 'none';
  if (v >= 100) return 'full';
  if (v >= 98) return 'warning';
  if (v >= 95) return 'serious';
  return 'critical';
}

function lastDays(count) {
  const days = [];
  const today = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/* Span the days actually recorded, capped at 90 and floored at 30, so a young
   deployment shows a short honest strip instead of a wall of empty cells. */
function stripSpan(groups) {
  const dates = REGIONS
    .flatMap((r) => ((groups[r.key] && groups[r.key].daily) || []).map((d) => d.date))
    .sort();
  if (!dates.length) return 30;
  const first = Date.parse(`${dates[0]}T00:00:00Z`);
  const days = Math.floor((Date.now() - first) / 86400000) + 1;
  return Math.min(90, Math.max(30, days));
}

function renderUptime(groups) {
  const host = document.getElementById('uptime');
  host.textContent = '';
  const span = stripSpan(groups);
  const days = lastDays(span);
  const byRegion = {};

  for (const region of REGIONS) {
    const group = groups[region.key];
    const lookup = new Map((group && group.daily ? group.daily : []).map((d) => [d.date, d]));
    byRegion[region.key] = lookup;

    const row = el('div', 'uptime-row');
    const head = el('div', 'uptime-head');
    const place = el('div', 'uptime-place');
    const dot = el('span', 'dot');
    dot.style.background = region.color;
    place.append(dot, document.createTextNode(region.name));
    const pct = (group && group.windows && group.windows['30d'] && group.windows['30d'].availability);
    const pctText = el('span', 'uptime-pct');
    pctText.append(el('b', null, fmtPct(pct)), document.createTextNode(' available over 30 days'));
    head.append(place, pctText);

    const strip = el('div', 'uptime-strip');
    for (const day of days) {
      const entry = lookup.get(day);
      const cell = el('div', 'uptime-cell');
      cell.dataset.level = availabilityLevel(entry && entry.availability);
      cell.title = entry
        ? `${day} · ${fmtPct(entry.availability)} of ${entry.samples} probes passed`
        : `${day} · no data`;
      strip.append(cell);
    }

    const scale = el('div', 'uptime-scale');
    scale.append(el('span', null, dayFmt.format(new Date(`${days[0]}T12:00:00Z`))), el('span', null, 'today'));

    const plot = el('div', 'uptime-plot');
    plot.append(strip, scale);
    row.append(head, plot);
    host.append(row);
  }

  /* Table twin, so no value is reachable only by colour. */
  const details = el('details', 'table-view');
  details.append(el('summary', null, 'Show daily availability as a table'));
  const scroll = el('div', 'table-scroll');
  const table = el('table', 'data');
  const caption = el('caption', null, 'Daily availability, share of probes that passed every stage');
  const thead = el('thead');
  const hrow = el('tr');
  hrow.append(el('th', null, 'Day'));
  for (const region of REGIONS) hrow.append(el('th', null, region.name));
  thead.append(hrow);
  const tbody = el('tbody');
  for (const day of [...days].reverse()) {
    if (!REGIONS.some((r) => byRegion[r.key].has(day))) continue;
    const tr = el('tr');
    const th = el('th', null, day);
    th.setAttribute('scope', 'row');
    tr.append(th);
    for (const region of REGIONS) {
      const entry = byRegion[region.key].get(day);
      tr.append(el('td', null, entry ? fmtPct(entry.availability) : '—'));
    }
    tbody.append(tr);
  }
  table.append(caption, thead, tbody);
  if (!tbody.childElementCount) {
    host.append(el('p', 'empty', 'No daily history yet.'));
    return;
  }
  scroll.append(table);
  details.append(scroll);
  host.append(details);
}

/* ------------------------------------------------------------------ charts */

function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * pow;
}

function axisTicks(max, target = 4) {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / target);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TICK_STRIDES = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 5 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/* Ticks land on real hour or midnight boundaries, so labels read
   "Aug 26, Aug 28, Aug 30" instead of drifting across a day. */
function timeTicks(t0, t1, maxTicks) {
  const span = t1 - t0;
  if (!(span > 0)) return [t0];
  const stride = TICK_STRIDES.find((s2) => span / s2 <= maxTicks) || TICK_STRIDES[TICK_STRIDES.length - 1];

  const snap = (ms) => {
    const d = new Date(ms);
    if (stride >= DAY) {
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    d.setMinutes(0, 0, 0);
    const hours = Math.round(stride / HOUR);
    d.setHours(Math.floor(d.getHours() / hours) * hours);
    return d.getTime();
  };

  const ticks = [];
  for (let t = snap(t0 + stride); t <= t1; t += stride) {
    if (t >= t0) ticks.push(snap(t));
  }
  if (!ticks.length) ticks.push(t0, t1);
  return ticks;
}

/* Points for one chart at the current range, per region. */
function chartSeries(chartKey) {
  const spec = CHARTS[chartKey];
  const range = RANGES[STATE.range];
  const cutoff = Date.now() - range.hours * 3600 * 1000;
  const out = [];

  for (const region of REGIONS) {
    const group = STATE.data.groups[region.key];
    if (!group) continue;
    const raw = range.source === 'series' ? group.series || [] : group.daily || [];
    const field = range.source === 'series' ? spec.run : spec.day;

    /* `key` aligns the regions exactly. The two runners timestamp their own
       results minutes apart, so matching on time would split every row. */
    const points = raw
      .map((row) => ({
        key: range.source === 'series' ? String(row.run_id ?? row.ts) : row.date,
        t: new Date(range.source === 'series' ? row.ts : `${row.date}T12:00:00Z`).getTime(),
        v: isNum(row[field]) ? row[field] : null,
      }))
      .filter((p) => Number.isFinite(p.t) && p.t >= cutoff)
      .sort((a, b) => a.t - b.t);

    out.push({ region, points, byKey: new Map(points.map((p) => [p.key, p])) });
  }
  return out;
}

function svgEl(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

function linePath(points, x, y) {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.v === null) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

function renderChart(chartKey) {
  const spec = CHARTS[chartKey];
  const host = document.querySelector(`.plot[data-chart="${chartKey}"]`);
  if (!host) return;

  const width = Math.max(280, host.clientWidth || 480);
  const series = chartSeries(chartKey);
  const withData = series.filter((s) => s.points.some((p) => p.v !== null));

  host.textContent = '';
  if (!withData.length) {
    host.append(el('p', 'empty', `No ${RANGES[STATE.range].label} data for this measurement yet.`));
    renderChartTable(chartKey, series);
    return;
  }

  const M = { top: 14, right: 62, bottom: 28, left: 48 };
  const H = spec.height;
  const innerW = width - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const times = withData.flatMap((s) => s.points.map((p) => p.t));
  const values = withData.flatMap((s) => s.points.filter((p) => p.v !== null).map((p) => p.v));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const vMax = Math.max(...values);
  const ticks = axisTicks(vMax * 1.1);
  const yMax = ticks[ticks.length - 1] || 1;

  const x = (t) => (t1 === t0 ? M.left + innerW / 2 : M.left + ((t - t0) / (t1 - t0)) * innerW);
  const y = (v) => M.top + innerH - (v / yMax) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, role: 'img' });
  svg.setAttribute('aria-label',
    `${chartKey} over the ${RANGES[STATE.range].label}. ` +
    withData.map((s) => {
      const last = [...s.points].reverse().find((p) => p.v !== null);
      return `${s.region.name} latest ${fmtValue(last && last.v, spec.unit)}`;
    }).join('. '));

  /* Gridlines: solid hairlines, one shade off the surface. */
  for (const tick of ticks) {
    svg.append(svgEl('line', {
      class: tick === 0 ? 'axis-line' : 'grid-line',
      x1: M.left, x2: M.left + innerW, y1: y(tick), y2: y(tick),
    }));
    const label = svgEl('text', { class: 'tick-text', x: M.left - 10, y: y(tick) + 3.5, 'text-anchor': 'end' });
    label.textContent = tick >= 1000 ? `${tick / 1000}k` : String(tick);
    svg.append(label);
  }

  /* X ticks, snapped to boundaries and never repeating a label. */
  const grain = RANGES[STATE.range].grain;
  const useDays = grain === 'day' || (t1 - t0) > 36 * HOUR;
  let previous = null;
  for (const t of timeTicks(t0, t1, Math.max(2, Math.floor(innerW / 105)))) {
    const text = useDays ? dayFmt.format(new Date(t)) : clockFmt.format(new Date(t));
    if (text === previous) continue;
    previous = text;
    const px = x(t);
    const anchor = px - M.left < 24 ? 'start' : (M.left + innerW) - px < 24 ? 'end' : 'middle';
    const label = svgEl('text', { class: 'tick-text', x: px, y: H - 8, 'text-anchor': anchor });
    label.textContent = text;
    svg.append(label);
  }

  for (const s of withData) {
    svg.append(svgEl('path', {
      class: 'series-line', d: linePath(s.points, x, y), stroke: s.region.color,
    }));
  }

  /* End dot and, when the two lines are far enough apart to stay attached to
     their own line, an end label. Otherwise the legend and tooltip carry it. */
  const ends = withData.map((s) => {
    const last = [...s.points].reverse().find((p) => p.v !== null);
    return last ? { s, last } : null;
  }).filter(Boolean);

  const roomForLabels = ends.length < 2
    || Math.abs(y(ends[0].last.v) - y(ends[1].last.v)) >= 17;

  for (const { s, last } of ends) {
    svg.append(svgEl('circle', {
      class: 'end-dot', cx: x(last.t), cy: y(last.v), r: 4.5, fill: s.region.color,
    }));
    if (roomForLabels) {
      const label = svgEl('text', { class: 'end-label', x: x(last.t) + 10, y: y(last.v) + 4 });
      label.textContent = fmtValue(last.v, spec.unit);
      svg.append(label);
    }
  }

  const crosshair = svgEl('line', { class: 'crosshair', y1: M.top, y2: M.top + innerH, opacity: 0 });
  svg.append(crosshair);
  const hoverDots = ends.map(({ s }) => {
    const dot = svgEl('circle', { class: 'hover-dot', r: 5, fill: s.region.color, opacity: 0 });
    svg.append(dot);
    return { series: s, dot };
  });

  const capture = svgEl('rect', {
    x: M.left, y: M.top, width: innerW, height: innerH, fill: 'transparent',
    tabindex: '0', 'aria-label': 'Chart values. Use the left and right arrow keys to step through time.',
  });
  svg.append(capture);
  host.append(svg);

  const tooltip = el('div', 'tooltip');
  host.append(tooltip);

  /* One shared index across the region series, taken from the longest one. */
  const spine = withData.reduce((a, b) => (b.points.length > a.points.length ? b : a), withData[0]).points;

  const show = (index) => {
    const point = spine[index];
    if (!point) return;
    crosshair.setAttribute('x1', x(point.t));
    crosshair.setAttribute('x2', x(point.t));
    crosshair.setAttribute('opacity', 1);

    const rows = [];
    for (const { series: s, dot } of hoverDots) {
      const match = s.byKey.get(point.key);
      if (match && match.v !== null) {
        dot.setAttribute('cx', x(match.t));
        dot.setAttribute('cy', y(match.v));
        dot.setAttribute('opacity', 1);
        rows.push({ region: s.region, value: match.v });
      } else {
        dot.setAttribute('opacity', 0);
        rows.push({ region: s.region, value: null });
      }
    }

    tooltip.textContent = '';
    tooltip.append(el('p', 'tooltip-when',
      RANGES[STATE.range].grain === 'day' ? dayFmt.format(new Date(point.t)) : timeFmt.format(new Date(point.t))));
    for (const row of rows) {
      const line = el('div', 'tooltip-row');
      const key = el('span', 'legend-key');
      key.style.background = row.region.color;
      line.append(key, el('span', null, row.region.name), el('b', null, fmtValue(row.value, spec.unit)));
      tooltip.append(line);
    }
    tooltip.dataset.open = 'true';

    const px = x(point.t);
    const flip = px > M.left + innerW - 170;
    tooltip.style.left = `${flip ? px - 168 : px + 14}px`;
    /* Sit in the half the cursor is not in, so the marks stay visible. */
    const highest = rows.reduce((acc, r) => (isNum(r.value) ? Math.min(acc, y(r.value)) : acc), Infinity);
    const low = Number.isFinite(highest) && highest > M.top + innerH * 0.45;
    tooltip.style.top = low ? `${M.top + 4}px` : 'auto';
    tooltip.style.bottom = low ? 'auto' : `${M.bottom + 4}px`;
    STATE.hover[chartKey] = index;
  };

  const hide = () => {
    crosshair.setAttribute('opacity', 0);
    hoverDots.forEach(({ dot }) => dot.setAttribute('opacity', 0));
    tooltip.dataset.open = 'false';
  };

  const indexFromClientX = (clientX) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / width;
    const local = (clientX - box.left) / scale;
    let best = 0;
    let bestDist = Infinity;
    spine.forEach((p, i) => {
      const dist = Math.abs(x(p.t) - local);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  };

  svg.addEventListener('pointermove', (event) => show(indexFromClientX(event.clientX)));
  svg.addEventListener('pointerleave', hide);
  capture.addEventListener('focus', () => show(STATE.hover[chartKey] ?? spine.length - 1));
  capture.addEventListener('blur', hide);
  capture.addEventListener('keydown', (event) => {
    const current = STATE.hover[chartKey] ?? spine.length - 1;
    if (event.key === 'ArrowLeft') { show(Math.max(0, current - 1)); event.preventDefault(); }
    if (event.key === 'ArrowRight') { show(Math.min(spine.length - 1, current + 1)); event.preventDefault(); }
    if (event.key === 'Home') { show(0); event.preventDefault(); }
    if (event.key === 'End') { show(spine.length - 1); event.preventDefault(); }
    if (event.key === 'Escape') hide();
  });

  renderChartTable(chartKey, series);
}

function renderChartTable(chartKey, series) {
  const details = document.querySelector(`.table-view[data-table="${chartKey}"]`);
  if (!details) return;
  const scroll = details.querySelector('.table-scroll');
  scroll.textContent = '';

  const spec = CHARTS[chartKey];
  /* One row per run (or per day), newest first, with each region's own value. */
  const keys = new Map();
  for (const s of series) {
    for (const p of s.points) {
      const existing = keys.get(p.key);
      if (!existing || p.t < existing) keys.set(p.key, p.t);
    }
  }
  const stamps = [...keys.entries()].sort((a, b) => b[1] - a[1]);
  if (!stamps.length) {
    scroll.append(el('p', 'empty', 'Nothing recorded in this range.'));
    return;
  }

  const table = el('table', 'data');
  table.append(el('caption', null,
    `${document.querySelector(`.plot[data-chart="${chartKey}"]`).closest('.chart-card').querySelector('.chart-title').textContent}, ${RANGES[STATE.range].label}`));
  const thead = el('thead');
  const hrow = el('tr');
  hrow.append(el('th', null, RANGES[STATE.range].grain === 'day' ? 'Day' : 'Run'));
  for (const s of series) hrow.append(el('th', null, `${s.region.name} (${spec.axis})`));
  thead.append(hrow);

  const tbody = el('tbody');
  for (const [key, t] of stamps) {
    const tr = el('tr');
    const th = el('th', null,
      RANGES[STATE.range].grain === 'day' ? dayFmt.format(new Date(t)) : timeFmt.format(new Date(t)));
    th.setAttribute('scope', 'row');
    tr.append(th);
    for (const s of series) {
      const hit = s.byKey.get(key);
      tr.append(el('td', null, hit ? fmtValue(hit.v, spec.unit) : '—'));
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
}

function renderLegends() {
  for (const id of ['legend-latency', 'legend-pull', 'legend-push']) {
    const host = document.getElementById(id);
    if (!host) continue;
    host.textContent = '';
    for (const region of REGIONS) {
      const item = el('li', 'legend-item');
      const key = el('span', 'legend-key');
      key.style.background = region.color;
      item.append(key, document.createTextNode(region.name));
      host.append(item);
    }
  }
}

function renderCharts() {
  Object.keys(CHARTS).forEach(renderChart);
}

/* ------------------------------------------------------------ percentiles */

const WINDOW_ROWS = [
  ['Availability', (w) => fmtPct(w.availability)],
  ['Registry API availability', (w) => fmtPct(w.api_availability)],
  ['Manifest read, p50', (w) => fmtMs(w.manifest_p50_ms)],
  ['Manifest read, p95', (w) => fmtMs(w.manifest_p95_ms)],
  ['TLS handshake, p50', (w) => fmtMs(w.tls_p50_ms)],
  ['Pull throughput, p50', (w) => fmtMbps(w.pull_p50_mbps)],
  ['Push throughput, p50', (w) => fmtMbps(w.push_p50_mbps)],
  ['Probes recorded', (w) => (isNum(w.samples) ? String(w.samples) : '—')],
  ['Probes failed', (w) => (isNum(w.failed_samples) ? String(w.failed_samples) : '—')],
];

function renderWindows(groups) {
  const host = document.getElementById('windows-table');
  host.textContent = '';
  const cols = ['24h', '7d', '30d'];
  const labels = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

  const table = el('table', 'data');
  const thead = el('thead');
  const hrow = el('tr');
  hrow.append(el('th', null, 'Measurement'));
  for (const c of cols) hrow.append(el('th', null, labels[c]));
  thead.append(hrow);
  table.append(thead);

  let any = false;
  for (const region of REGIONS) {
    const group = groups[region.key];
    if (!group) continue;
    any = true;
    const tbody = el('tbody');
    const grouprow = el('tr');
    const gth = el('th', null, region.name);
    gth.setAttribute('scope', 'rowgroup');
    gth.setAttribute('colspan', String(cols.length + 1));
    grouprow.append(gth);
    tbody.append(grouprow);

    for (const [label, read] of WINDOW_ROWS) {
      const tr = el('tr');
      const th = el('th', null, label);
      th.setAttribute('scope', 'row');
      tr.append(th);
      for (const c of cols) tr.append(el('td', null, read((group.windows && group.windows[c]) || {})));
      tbody.append(tr);
    }
    table.append(tbody);
  }

  if (!any) {
    host.append(el('p', 'empty', 'No windows to summarise yet.'));
    return;
  }
  host.append(table);
}

/* -------------------------------------------------------------- incidents */

function renderIncidents(groups) {
  const host = document.getElementById('incidents');
  host.textContent = '';

  const items = [];
  for (const region of REGIONS) {
    const group = groups[region.key];
    for (const incident of (group && group.incidents) || []) {
      items.push({ region, incident });
    }
  }
  items.sort((a, b) => new Date(b.incident.ts) - new Date(a.incident.ts));

  if (!items.length) {
    const empty = el('p', 'empty');
    empty.append(el('span', 'dot dot-operational'),
      document.createTextNode('No failed probes on record. Every measurement in the retained history completed.'));
    host.append(empty);
    return;
  }

  const list = el('ul', 'log');
  for (const { region, incident } of items.slice(0, 14)) {
    const item = el('li', 'log-item');
    item.append(el('span', 'log-when', timeFmt.format(new Date(incident.ts))));

    const where = el('span', 'log-where');
    const dot = el('span', 'dot');
    dot.style.background = region.color;
    where.append(dot, document.createTextNode(region.name));
    item.append(where);

    const reps = el('span', 'log-reps');
    reps.textContent = isNum(incident.reps_total)
      ? `${incident.reps_failed} of ${incident.reps_total} reps`
      : `${incident.reps_failed || 1} rep`;
    item.append(reps);

    const what = el('span', 'log-what');
    const parts = Object.entries(incident.probes || {});
    parts.forEach(([name, detail], i) => {
      if (i) what.append(document.createTextNode(' · '));
      what.append(el('code', null, name));
      what.append(document.createTextNode(` ${detail}`));
    });
    if (!parts.length) what.append(document.createTextNode('failed'));
    item.append(what);
    list.append(item);
  }
  host.append(list);
}

/* ----------------------------------------------------------------- header */

function renderHeader(data) {
  const dot = document.getElementById('global-dot');
  const state = document.getElementById('global-state');
  const stamp = document.getElementById('global-stamp');

  const states = REGIONS
    .map((r) => data.groups[r.key] && data.groups[r.key].latest && data.groups[r.key].latest.status)
    .filter(Boolean);

  let overall = 'unknown';
  let text = 'No measurements yet';
  if (states.length) {
    if (states.every((s) => s === 'operational')) {
      overall = 'operational';
      text = 'ghcr.io reachable from both regions';
    } else if (states.some((s) => s === 'down')) {
      overall = 'down';
      const failing = REGIONS.filter((r) => data.groups[r.key] && data.groups[r.key].latest
        && data.groups[r.key].latest.status === 'down').map((r) => r.name);
      text = `ghcr.io failing from ${failing.join(' and ')}`;
    } else {
      overall = 'degraded';
      text = 'Partial failures in the latest run';
    }
  }

  dot.className = `dot dot-${overall}`;
  state.textContent = text;
  stamp.textContent = data.generated_at
    ? `updated ${relativeTime(data.generated_at)}`
    : '';

  const note = document.getElementById('footer-note');
  const parts = [];
  if (isNum(data.total_samples)) parts.push(`${data.total_samples.toLocaleString()} probes on record`);
  if (data.first_sample) parts.push(`since ${dayFmt.format(new Date(data.first_sample))}`);
  parts.push('times in your local timezone');
  note.textContent = `${parts.join(' · ')}.`;

  if (data.repository) {
    const link = document.getElementById('source-link');
    if (link) {
      link.href = `https://github.com/${data.repository}`;
      link.hidden = false;
    }
  }
}

/* -------------------------------------------------------------------- boot */

function bindRanges() {
  for (const chip of document.querySelectorAll('.chip[data-range]')) {
    chip.addEventListener('click', () => {
      if (chip.dataset.range === STATE.range) return;
      STATE.range = chip.dataset.range;
      STATE.hover = {};
      for (const other of document.querySelectorAll('.chip[data-range]')) {
        other.setAttribute('aria-pressed', String(other.dataset.range === STATE.range));
      }
      renderCharts();
    });
  }
}

/* Fills every data region with the same sentence. Used for both "nothing
   recorded yet" and "the file would not load" - the two differ only in what the
   header says and in whose problem it is. */
function fillPlaceholders(message) {
  for (const id of ['cards', 'uptime', 'incidents', 'windows-table', 'ribbon-rows']) {
    const host = document.getElementById(id);
    if (host) {
      host.textContent = '';
      host.append(el('p', 'empty', message));
    }
  }
  for (const plot of document.querySelectorAll('.plot')) {
    plot.textContent = '';
    plot.append(el('p', 'empty', message));
  }
  for (const details of document.querySelectorAll('.table-view')) details.hidden = true;
  for (const chip of document.querySelectorAll('.chip[data-range]')) chip.disabled = true;
  const verdict = document.getElementById('ribbon-verdict');
  if (verdict) verdict.textContent = '';
}

function showLoadError(message) {
  document.getElementById('global-dot').className = 'dot dot-unknown';
  document.getElementById('global-state').textContent = 'Measurements unavailable';
  fillPlaceholders(message);
}

async function boot() {
  bindRanges();
  renderLegends();

  let data;
  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    data = await response.json();
  } catch (error) {
    showLoadError(`Could not load ${DATA_URL} (${error.message}). The hourly workflow writes this file; check that it has run at least once.`);
    return;
  }

  STATE.data = data;
  if (!data.groups || !Object.keys(data.groups).length) {
    /* A freshly deployed repository: the header already reads "No measurements
       yet", so say what happens next rather than reporting a fault. */
    renderHeader(data);
    fillPlaceholders('Nothing recorded yet. The first scheduled run publishes results here within the hour.');
    return;
  }

  renderHeader(data);
  renderHeroFacts(data);
  renderRibbon(data.groups);
  renderCards(data.groups);
  renderUptime(data.groups);
  renderWindows(data.groups);
  renderIncidents(data.groups);
  renderCharts();

  let timer;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(renderCharts, 120);
  });
  const first = document.querySelector('.plot');
  if (first) observer.observe(first);
}

boot();
