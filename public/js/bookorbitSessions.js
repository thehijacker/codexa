// BookOrbit reading history for one book — shared by the BookOrbit browser's book dialog
// (bookorbit.js) and the Reading tab of Codexa's own info dialog (library.js). These are BookOrbit's
// own records for the account: every device/reader that reported time, not just what Codexa pushed
// (Codexa's pushed sessions are in there too, indistinguishable from BookOrbit's web reader — it
// sends no source and BookOrbit's list exposes no session ids).
//
// Renders, top to bottom: totals summary → read-throughs (BookOrbit "reading attempts") → facts and
// charts (progress over time, minutes per day) → the paged session table.
import { t } from './i18n.js';
import { setButtonLoading } from './ui.js';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDur(secs) {
  if (!secs || secs < 60) return `${secs || 0}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const fmtDate  = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : '—');
const fmtClock = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

// BookOrbit's date-only strings (YYYY-MM-DD) as a LOCAL date — new Date('2026-09-26') would parse
// as UTC midnight and show the previous day west of Greenwich.
function localDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export const fmtOn = (ymd) => { const d = localDate(ymd); return d ? d.toLocaleDateString() : null; };
const fmtShort = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// A session's `source` (web/ios/watchos/android/koreader/manual/kobo/null) collapses to the same
// display buckets BookOrbit's own UI uses — web, manual and unknown are all just "BookOrbit".
function sourceLabel(source) {
  const bucket = ['ios', 'watchos', 'android', 'koreader', 'kobo'].includes(source) ? source : 'bookorbit';
  const key = `stats.source_${bucket}`;
  const v = t(key);
  return v === key ? bucket : v;
}
const bucketLabel = (b) => { const key = `stats.source_${b}`; const v = t(key); return v === key ? b : v; };

function progressCell(r) {
  if (r.endProgress == null) return '—';
  const end = `${Math.round(r.endProgress)}%`;
  const d = r.progressDelta;
  if (d == null || Math.abs(d) < 0.5) return end;
  return `${end} <span class="imt-session-time">${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))}%</span>`;
}

// Splits a newest-first session list into calendar days (the reader's local day of each session's
// start; a session running past midnight stays on the day it began), keeping the order. Shared with
// the Codexa session table in library.js.
export function groupByDay(rows, tsOf) {
  const days = [];
  for (const r of rows) {
    const d = new Date(tsOf(r) * 1000);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else days.push({ key, rows: [r] });
  }
  return days;
}

// "+12%" / "−3%" for a progress change in percentage points; '' when it rounds to nothing.
export function fmtDeltaPct(d) {
  if (d == null || Math.abs(d) < 0.5) return '';
  return `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))}%`;
}

// The closing row of one day: session count, summed time, devices, the day's end position and gain.
function dayTotalHtml(rows) {
  const secs = rows.reduce((a, r) => a + (r.durationSeconds || 0), 0);
  const srcs = [...new Set(rows.map(r => sourceLabel(r.source)))].join(', ');
  const withEnd = rows.find(r => r.endProgress != null); // rows are newest first
  const hasDelta = rows.some(r => r.progressDelta != null);
  const delta = rows.reduce((a, r) => a + (r.progressDelta || 0), 0);
  const end = withEnd ? `${Math.round(withEnd.endProgress)}%` : '';
  const gain = hasDelta ? fmtDeltaPct(delta) : '';
  const prog = end || gain ? `${end}${gain ? ` <span class="imt-session-time">${gain}</span>` : ''}` : '—';
  return `
    <div class="imt-session-row imt-session-daytotal">
      <span class="imt-session-date">${t('library.session_day_total')}<span class="imt-session-time">${t('library.session_day_count', { n: rows.length })}</span></span>
      <span class="imt-session-dur">${fmtDur(secs)}</span>
      <span class="imt-session-src">${escHtml(srcs)}</span>
      <span class="imt-session-pages">${prog}</span>
    </div>`;
}

function rowHtml(r) {
  const range = r.endedAt ? `${fmtClock(r.startedAt)} – ${fmtClock(r.endedAt)}` : fmtClock(r.startedAt);
  return `
    <div class="imt-session-row">
      <span class="imt-session-date">${fmtDate(r.startedAt)}<span class="imt-session-time">${range}</span></span>
      <span class="imt-session-dur">${fmtDur(r.durationSeconds)}</span>
      <span class="imt-session-src">${escHtml(sourceLabel(r.source))}</span>
      <span class="imt-session-pages">${progressCell(r)}</span>
    </div>`;
}

function summaryHtml(stats) {
  if (!stats || !stats.totalSessions) return '';
  const range = stats.firstSessionAt
    ? ` &nbsp;&middot;&nbsp; ${fmtDate(stats.firstSessionAt)}${stats.lastSessionAt && fmtDate(stats.lastSessionAt) !== fmtDate(stats.firstSessionAt) ? ` – ${fmtDate(stats.lastSessionAt)}` : ''}`
    : '';
  const split = stats.bySource?.length > 1
    ? `<div class="imt-reading-summary" style="opacity:.8">${stats.bySource.map(x => `${escHtml(bucketLabel(x.bucket))}: ${fmtDur(x.totalSeconds)}`).join(' &nbsp;&middot;&nbsp; ')}</div>`
    : '';
  return `
    <div class="imt-reading-summary">${t('library.reading_total_time')}: <strong>${fmtDur(stats.totalSeconds)}</strong> &nbsp;&middot;&nbsp; ${stats.totalSessions} ${t('library.reading_sessions').toLowerCase()}${range}</div>
    ${split}`;
}

// ── read-throughs ────────────────────────────────────────────────────────────
// One row per BookOrbit "reading attempt": when it started/ended, how it ended, and the time and
// sessions recorded against it. Open (no end, no outcome) = still being read.
function attemptsHtml(attempts) {
  if (!attempts?.length) return '';
  const rows = attempts.map(a => {
    const s = fmtOn(a.startedOn);
    const e = fmtOn(a.endedOn);
    const open = !a.endedOn && !a.outcome;
    const dates = s && e ? `${s} – ${e}` : s ? `${s} –` : e ? `– ${e}` : '—';
    const outcomeKey = open ? 'in_progress' : a.outcome;
    const outcome = outcomeKey ? t(`bookorbit.attempt_${outcomeKey}`) : '';
    const detail = a.totalSessions > 0
      ? `${fmtDur(a.totalSeconds)} &middot; ${a.totalSessions} ${t('library.reading_sessions').toLowerCase()}`
      : '';
    return `
      <div class="imt-session-row">
        <span class="imt-session-date">${dates}${detail ? `<span class="imt-session-time">${detail}</span>` : ''}</span>
        <span class="imt-session-dur">${escHtml(outcome)}</span>
      </div>`;
  }).join('');
  return `
    <div class="imt-reading-summary" style="margin-top:.6rem"><strong>${t('bookorbit.attempts_title')}</strong></div>
    <div class="imt-session-list imt-attempts">${rows}</div>`;
}

// ── facts + charts (inline SVG, no library) ──────────────────────────────────
function factsHtml(s) {
  const pairs = [];
  if (s.longestSessionSeconds) {
    pairs.push([t('bookorbit.insight_longest'), `${fmtDur(s.longestSessionSeconds)}${s.longestSessionAt ? ` (${fmtDate(s.longestSessionAt)})` : ''}`]);
  }
  if (s.avgSessionSeconds) pairs.push([t('bookorbit.insight_avg'), fmtDur(s.avgSessionSeconds)]);
  // Progress points per hour of the sessions that actually moved forward. Needs a little data to mean anything.
  if (s.paceDurationSeconds >= 600 && s.paceProgressDelta > 0) {
    pairs.push([t('bookorbit.insight_pace'), `${(s.paceProgressDelta / (s.paceDurationSeconds / 3600)).toFixed(1)}%/h`]);
  }
  if (s.backtrackCount > 0) pairs.push([t('bookorbit.insight_backtracks'), String(s.backtrackCount)]);
  if (!pairs.length) return '';
  return `<div class="imt-meta-grid" style="margin-top:.5rem">${pairs.map(([l, v]) =>
    `<div class="imt-meta-pair"><span class="imt-meta-label">${escHtml(l)}</span><span>${escHtml(v)}</span></div>`).join('')}</div>`;
}

// Progress (0–100%) at the end of each reading day, drawn over real elapsed time.
function progressChart(points) {
  const pts = (points || [])
    .map(p => ({ d: localDate(p.day), v: Math.max(0, Math.min(100, Number(p.endProgress) || 0)) }))
    .filter(p => p.d)
    .map(p => ({ ms: p.d.getTime(), d: p.d, v: p.v }))
    .sort((a, b) => a.ms - b.ms);
  if (pts.length < 2) return '';
  const W = 300, H = 96, L = 28, R = 8, T = 8, B = 18;
  const t0 = pts[0].ms, span = (pts[pts.length - 1].ms - t0) || 1;
  const X = ms => (L + (ms - t0) / span * (W - L - R)).toFixed(1);
  const Y = v  => (T + (1 - v / 100) * (H - T - B)).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ms)} ${Y(p.v)}`).join(' ');
  const grid = [0, 50, 100].map(v =>
    `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Number(Y(v)) + 3}" text-anchor="end">${v}%</text>`).join('');
  const dots = pts.map(p =>
    `<circle class="dt" cx="${X(p.ms)}" cy="${Y(p.v)}" r="2.5"><title>${escHtml(p.d.toLocaleDateString())} · ${Math.round(p.v)}%</title></circle>`).join('');
  return `
    <div class="imt-reading-summary" style="margin-top:.6rem">${t('bookorbit.chart_progress')}</div>
    <div class="imt-bo-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escHtml(t('bookorbit.chart_progress'))}">
      ${grid}<path class="ln" d="${line}"/>${dots}
      <text x="${L}" y="${H - 4}">${escHtml(fmtShort(pts[0].d))}</text>
      <text x="${W - R}" y="${H - 4}" text-anchor="end">${escHtml(fmtShort(pts[pts.length - 1].d))}</text>
    </svg></div>`;
}

// Minutes read on each day that had any reading (most recent 45), one bar per day — days without
// reading are left out, so bars are evenly spaced but not a continuous calendar. A scale on the left
// (the top label used to be the raw maximum, e.g. "101.5m", and got clipped to "01.5m"), and tapping
// a bar — the whole column is the touch target, bars alone are too thin on a phone — shows that
// day's date and time in the line below; the most recent day is selected to start with.
const fmtMinutes = (m) => fmtDur(Math.round(m * 60));
const axisLabel = (m) => (m >= 60 ? (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`) : `${m}m`);
function dayInfo(d) {
  const date = d.d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `<strong>${escHtml(date)}</strong> · ${escHtml(fmtMinutes(d.m))}`;
}
function dailyChart(days) {
  const ds = (days || [])
    .map(d => ({ d: localDate(d.day), m: Number(d.totalMinutes) || 0 }))
    .filter(d => d.d)
    .sort((a, b) => a.d - b.d)
    .slice(-45);
  if (ds.length < 2) return '';
  const W = 300, H = 100, L = 38, R = 8, T = 8, B = 18;
  const max = Math.max(1, ...ds.map(d => d.m));
  // Round step so the scale ends just above the longest day with at most 4 gridlines.
  const step = [5, 10, 15, 30, 60, 90, 120, 180, 240].find(st => max / st <= 4) || Math.ceil(max / 4 / 60) * 60;
  const top = Math.ceil(max / step) * step;
  const Y = m => H - B - (m / top) * (H - T - B);
  const ticks = [];
  for (let v = step; v <= top; v += step) ticks.push(v);
  const grid = ticks.map(v =>
    `<line class="gr gr-dash" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${axisLabel(v)}</text>`).join('');
  const slot = (W - L - R) / ds.length;
  const bw = Math.max(2, slot * 0.7);
  const last = ds.length - 1;
  // Hit columns first (underneath, so a focus tint never hides a bar); bars ignore the pointer.
  const hits = ds.map((d, i) =>
    `<rect class="hit" data-i="${i}" tabindex="0" x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${H - T - B}"><title>${escHtml(d.d.toLocaleDateString())} · ${escHtml(fmtMinutes(d.m))}</title></rect>`).join('');
  const bars = ds.map((d, i) => {
    const h = (d.m / top) * (H - T - B);
    return `<rect class="bar${i === last ? ' sel' : ''}" data-i="${i}" x="${(L + i * slot + (slot - bw) / 2).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  }).join('');
  return `
    <div class="imt-reading-summary" style="margin-top:.6rem">${t('bookorbit.chart_daily')}</div>
    <div class="imt-bo-chart imt-bo-daily" data-days="${escHtml(JSON.stringify(ds.map(d => [d.d.getTime(), d.m])))}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escHtml(t('bookorbit.chart_daily'))}">
      ${hits}${grid}
      <line class="gr" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      <text x="${L - 4}" y="${H - B + 3}" text-anchor="end">0</text>
      ${bars}
      <text x="${L}" y="${H - 4}">${escHtml(fmtShort(ds[0].d))}</text>
      <text x="${W - R}" y="${H - 4}" text-anchor="end">${escHtml(fmtShort(ds[last].d))}</text>
    </svg>
    <div class="imt-bo-chart-info" aria-live="polite">${dayInfo(ds[last])}</div></div>`;
}

// Tap / click / Enter on a day column of the minutes-per-day chart → select it and show its details.
function wireDailyChart(root) {
  const box = root.querySelector('.imt-bo-daily');
  if (!box) return;
  let ds;
  try { ds = JSON.parse(box.dataset.days).map(([ms, m]) => ({ d: new Date(ms), m })); } catch { return; }
  const info = box.querySelector('.imt-bo-chart-info');
  const select = (target) => {
    const hit = target && target.closest ? target.closest('.hit') : null;
    if (!hit) return;
    const i = Number(hit.getAttribute('data-i'));
    if (!ds[i]) return;
    box.querySelectorAll('.bar.sel').forEach(b => b.classList.remove('sel'));
    box.querySelector(`.bar[data-i="${i}"]`)?.classList.add('sel');
    info.innerHTML = dayInfo(ds[i]);
  };
  box.addEventListener('click', e => select(e.target));
  box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e.target); } });
}

function insightsHtml(stats) {
  if (!stats || !stats.totalSessions) return '';
  return `${factsHtml(stats)}${progressChart(stats.progressSummary)}${dailyChart(stats.dailySummary)}`;
}

/**
 * Render a book's BookOrbit reading history into `el`, loading session pages on demand.
 * @param {HTMLElement} el
 * @param {(page:number) => Promise<{items, total, stats}>} load  — resolves one page (newest first)
 * @param {{summary?: boolean, insights?: boolean, attempts?: (() => Promise<Array>)|null}} opts
 *   summary=false when the caller already shows the totals itself; attempts = loader for the
 *   read-throughs block (a failure there just hides it).
 */
export async function mountBoSessions(el, load, { summary = true, insights = true, attempts = null } = {}) {
  if (!el) return;
  let page = 1;
  let items = [];
  let total = 0;
  let stats = null;
  let readThroughs = [];

  function render() {
    const head = `${summary ? summaryHtml(stats) : ''}${attemptsHtml(readThroughs)}${insights ? insightsHtml(stats) : ''}`;
    if (!items.length) {
      el.innerHTML = `${head}<div class="imt-empty">${t('bookorbit.sessions_empty')}</div>`;
      wireDailyChart(el);
      return;
    }
    el.innerHTML = `
      ${head}
      <div class="imt-session-list imt-bo-sessions" style="margin-top:.6rem">
        <div class="imt-session-header">
          <span>${t('library.session_col_date')}</span>
          <span>${t('library.session_col_dur')}</span>
          <span>${t('bookorbit.session_col_source')}</span>
          <span>${t('bookorbit.session_col_progress')}</span>
        </div>
        ${groupByDay(items, r => r.startedAt).map((day, i, days) =>
          // The oldest loaded day may continue on the next page — no total until it's all here.
          day.rows.map(rowHtml).join('') + (i === days.length - 1 && items.length < total ? '' : dayTotalHtml(day.rows))
        ).join('')}
      </div>
      ${items.length < total ? `<button class="btn btn-secondary btn-sm imt-bo-more">${t('bookorbit.sessions_load_more')}</button>` : ''}`;

    wireDailyChart(el);
    el.querySelector('.imt-bo-more')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setButtonLoading(btn, true, t('opds.loading'));
      try {
        const next = await load(page + 1);
        page += 1;
        items = items.concat(next.items || []);
        total = next.total ?? total;
        render();
      } catch (err) {
        setButtonLoading(btn, false, t('bookorbit.sessions_load_more'));
      }
    });
  }

  el.innerHTML = `<div class="imt-empty" style="padding:.5rem 0">${t('opds.loading')}</div>`;
  try {
    const [first, atts] = await Promise.all([
      load(1),
      attempts ? attempts().catch(() => []) : Promise.resolve([]),
    ]);
    items = first?.items || [];
    total = first?.total ?? items.length;
    stats = first?.stats || null;
    readThroughs = Array.isArray(atts) ? atts : [];
    render();
  } catch (err) {
    el.innerHTML = `<div class="imt-empty">${escHtml(t('common.err_prefix') + err.message)}</div>`;
  }
}
