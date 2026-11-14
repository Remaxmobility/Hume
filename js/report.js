// report.js — build a printable, light-themed health report (opens in a new
// window; the user prints or saves it as PDF via the browser).

import * as insights from './insights.js';
import * as profile from './profile.js';
import { lineChart, barChart, hypnogram } from './charts.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fmtDur = (min) => { const H = Math.floor(min / 60), M = Math.round(min % 60); return H ? `${H}h ${M}m` : `${M}m`; };

function chartImg(width, height, drawFn) {
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px`;
  const c = document.createElement('canvas');
  c.style.width = '100%';
  holder.appendChild(c);
  document.body.appendChild(holder);
  let url = '';
  try { drawFn(c); url = c.toDataURL('image/png'); } catch (_) { url = ''; }
  document.body.removeChild(holder);
  return url;
}

function statOf(records) {
  const vals = (records || []).map((r) => r.value).filter((v) => typeof v === 'number' && v > 0);
  if (!vals.length) return null;
  return {
    avg: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
    min: Math.min(...vals), max: Math.max(...vals), n: vals.length,
  };
}

function dataRange(histData) {
  let lo = Infinity, hi = -Infinity;
  for (const recs of Object.values(histData)) {
    for (const r of recs) { const t = r.time instanceof Date ? r.time.getTime() : 0; if (t) { if (t < lo) lo = t; if (t > hi) hi = t; } }
  }
  return isFinite(lo) ? { from: new Date(lo), to: new Date(hi) } : null;
}

export function generateReport(histData, device = {}, goal = 10000) {
  const hr = histData.hr || [];
  const resting = insights.restingHr(hr);
  const zones = insights.hrZones(hr);
  const recovery = insights.recoveryScore({ resting, hrvRecords: histData.hrv || [], sleepRecords: histData.sleep || [] });
  const stepsSum = insights.stepsSummary(histData.totals || [], histData.steps || [], goal);
  const range = dataRange(histData);
  const sleepLast = (histData.sleep || []).slice().sort((a, b) => a.time - b.time).pop();
  const prof = profile.derive(profile.loadProfile(), resting ? resting.latest : null);

  let profileHtml = '';
  if (prof.hasAny) {
    const bits = [];
    if (prof.age) bits.push(`Age <b>${prof.age}</b>`);
    if (prof.sex) bits.push(`Sex <b>${esc(prof.sex)}</b>`);
    if (prof.height) bits.push(`Height <b>${prof.height} cm</b>`);
    if (prof.weight) bits.push(`Weight <b>${prof.weight} kg</b>`);
    if (prof.bmi) bits.push(`BMI <b>${prof.bmi.value}</b> (${prof.bmi.category})`);
    if (prof.bmr) bits.push(`BMR <b>${prof.bmr.toLocaleString()}</b> kcal/day`);
    if (prof.hrMax) bits.push(`Max HR <b>${prof.hrMax}</b> bpm`);
    let zt = '';
    if (prof.zones) {
      const rows = prof.zones.map((z) => `<tr><td><span class="zdot" style="background:${z.color}"></span>${z.name}</td><td>${z.min}–${z.max} bpm</td></tr>`).join('');
      zt = `<table class="stats"><thead><tr><th>Training zone (from resting ${prof.restingUsed} bpm)</th><th>Range</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    profileHtml = `<div class="dev" style="margin-bottom:10px">${bits.map((x) => `<span>${x}</span>`).join('')}</div>${zt}`;
  }

  // charts as PNG data URLs (light theme)
  const W = 760;
  const imgResting = resting && resting.daily.length > 1 ? chartImg(W, 170, (c) => lineChart(c, resting.daily, { height: 170, color: '#ef4444', light: true })) : '';
  const imgHr = hr.length > 1 ? chartImg(W, 180, (c) => lineChart(c, hr, { height: 180, color: '#ef4444', light: true })) : '';
  const imgSteps = stepsSum && stepsSum.last7.length > 1 ? chartImg(W, 180, (c) => barChart(c, stepsSum.last7.map((d) => ({ label: d.label, value: d.value, color: '#16a34a' })), { height: 180, light: true })) : '';
  const imgSleep = sleepLast ? chartImg(W, 160, (c) => hypnogram(c, sleepLast.stages, { height: 160, light: true })) : '';

  // snapshot cards
  const cards = [];
  if (resting) cards.push(card('Resting HR', `${resting.latest}`, 'bpm', `avg ${resting.avg} over ${resting.daily.length} days`));
  if (recovery) cards.push(card('Recovery', `${recovery.score}`, '/100', recovery.label));
  if (stepsSum) cards.push(card('Steps (latest day)', stepsSum.today.steps.toLocaleString(), '', `goal ${stepsSum.goal.toLocaleString()} · best ${stepsSum.best.steps.toLocaleString()}`));
  if (sleepLast) {
    const total = sleepLast.stages.length;
    const asleep = sleepLast.stages.filter((s) => s.stage !== 'awake').length;
    cards.push(card('Sleep (last night)', fmtDur(asleep), '', `${Math.round(asleep / total * 100)}% efficiency`));
  }

  // zones bar (HTML)
  let zonesHtml = '';
  if (zones) {
    const seg = zones.filter((z) => z.pct > 0).map((z) => `<div style="width:${z.pct}%;background:${z.color}"></div>`).join('');
    const leg = zones.map((z) => `<span class="zl"><i style="background:${z.color}"></i>${z.name} ${z.pct}%</span>`).join('');
    zonesHtml = `<div class="zbar">${seg}</div><div class="zleg">${leg}</div>`;
  }

  // metric stats table
  const rows = [];
  const add = (label, s, unit) => { if (s) rows.push(`<tr><td>${label}</td><td>${s.avg} ${unit}</td><td>${s.min}</td><td>${s.max}</td><td>${s.n.toLocaleString()}</td></tr>`); };
  add('Heart rate', statOf(hr), 'bpm');
  add('SpO₂', statOf(histData.spo2), '%');
  add('Temperature', statOf(histData.temp), '°C');
  add('HRV', statOf(histData.hrv), 'ms');
  const statsTable = rows.length ? `<table class="stats"><thead><tr><th>Metric</th><th>Average</th><th>Min</th><th>Max</th><th>Samples</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '';

  const section = (title, body) => body ? `<section><h2>${title}</h2>${body}</section>` : '';
  const img = (src, alt) => src ? `<img src="${src}" alt="${alt}" />` : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hume Health Report — ${esc(fmtDate(new Date()))}</title>
<style>
  :root { --ink:#1e293b; --muted:#64748b; --line:#e2e8f0; --accent:#0ea5e9; }
  * { box-sizing:border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:var(--ink); background:#f8fafc; }
  .page { max-width:820px; margin:0 auto; padding:32px 28px 48px; background:#fff; }
  header.rep { display:flex; align-items:center; gap:14px; border-bottom:2px solid var(--accent); padding-bottom:16px; margin-bottom:8px; }
  .logo { width:44px; height:44px; border-radius:12px; background:linear-gradient(135deg,#0ea5e9,#6366f1); display:grid; place-items:center; }
  .logo svg { width:30px; height:30px; }
  h1 { font-size:22px; margin:0; }
  .sub { color:var(--muted); font-size:13px; margin-top:2px; }
  .meta { color:var(--muted); font-size:12px; margin:10px 0 18px; }
  .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:8px; }
  .c { border:1px solid var(--line); border-radius:12px; padding:14px; }
  .c .l { font-size:12px; color:var(--muted); }
  .c .v { font-size:28px; font-weight:800; }
  .c .v span { font-size:13px; color:var(--muted); font-weight:600; margin-left:3px; }
  .c .s { font-size:12px; color:var(--muted); margin-top:2px; }
  section { margin-top:22px; page-break-inside:avoid; }
  h2 { font-size:15px; margin:0 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  img { width:100%; border:1px solid var(--line); border-radius:10px; }
  .zbar { display:flex; height:18px; border-radius:9px; overflow:hidden; border:1px solid var(--line); }
  .zbar div { height:100%; }
  .zleg { display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:var(--muted); margin-top:8px; }
  .zleg .zl { display:inline-flex; align-items:center; gap:6px; }
  .zleg .zl i { width:11px; height:11px; border-radius:3px; display:inline-block; }
  table.stats { width:100%; border-collapse:collapse; font-size:13px; }
  table.stats th, table.stats td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); }
  table.stats th { color:var(--muted); font-weight:600; }
  .dev { font-size:12px; color:var(--muted); display:flex; flex-wrap:wrap; gap:16px; }
  .zdot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:7px; vertical-align:middle; }
  footer.rep { margin-top:26px; padding-top:14px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); }
  .toolbar { position:sticky; top:0; background:#f1f5f9; border-bottom:1px solid var(--line); padding:10px; text-align:center; }
  .toolbar button { font:inherit; padding:8px 16px; border-radius:9px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; font-weight:600; }
  @media print { .toolbar { display:none; } body { background:#fff; } .page { max-width:none; padding:0; } @page { margin:14mm; } }
</style></head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="page">
    <header class="rep">
      <span class="logo"><svg viewBox="0 0 100 100"><path d="M20 62 L38 62 L46 30 L55 76 L62 48 L69 62 L80 62" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <div><h1>Hume Health Report</h1><div class="sub">J2208 band · generated ${esc(fmtDateTime(new Date()))}</div></div>
    </header>
    <div class="meta">${range ? `Data range: ${esc(fmtDate(range.from))} → ${esc(fmtDate(range.to))}` : 'No saved history'}${device.name && device.name !== '—' ? ` · Device: ${esc(device.name)}` : ''}</div>

    <div class="cards">${cards.join('')}</div>

    ${section('Profile &amp; training zones', profileHtml)}
    ${section('Resting heart rate trend', img(imgResting, 'Resting HR trend'))}
    ${section('Heart rate', img(imgHr, 'Heart rate') + zonesHtml)}
    ${section('Steps', img(imgSteps, 'Steps trend') + (stepsSum ? `<div class="sub" style="margin-top:8px">Current streak at goal: <b>${stepsSum.streak}</b> day(s) · ${stepsSum.days} days recorded</div>` : ''))}
    ${section('Sleep (last night)', img(imgSleep, 'Hypnogram'))}
    ${section('Metric summary', statsTable)}

    <section>
      <h2>Device</h2>
      <div class="dev">
        <span>Name: <b>${esc(device.name || '—')}</b></span>
        <span>Firmware: <b>${esc(device.firmware || '—')}</b></span>
        <span>Build: <b>${esc(device.build || '—')}</b></span>
        <span>Step goal: <b>${esc(device.stepGoal || '—')}</b></span>
      </div>
    </section>

    <footer class="rep">
      Generated by the Hume companion app from data recorded on this device. This is a consumer fitness device, <b>not a medical device</b> — do not use these figures for diagnosis or treatment.
    </footer>
  </div>
  <script>window.addEventListener('load', function(){ setTimeout(function(){ try { window.print(); } catch(e){} }, 400); });</script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  return true;
}

function card(label, value, unit, sub) {
  return `<div class="c"><div class="l">${esc(label)}</div><div class="v">${esc(value)}${unit ? `<span>${esc(unit)}</span>` : ''}</div><div class="s">${esc(sub || '')}</div></div>`;
}
