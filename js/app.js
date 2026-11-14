// app.js — UI controller.

import { BleManager } from './ble.js';
import {
  OP,
  cmdBattery, cmdDeviceName, cmdMac, cmdVersion, cmdStepGoal, cmdDeviceInfo, cmdTime,
  cmdMeasure, cmdStopMeasure, cmdGetAuto, cmdSetAuto,
  decodeBattery, decodeDeviceName, decodeMac, decodeVersion, decodeStepGoal,
  decodeDeviceInfo, decodeTime, decodeMeasurement, decodeAuto, isRejected, toHex,
} from './protocol.js';
import { RECORD_TYPES, downloadHistory, recordsToCsv } from './history.js';
import { lineChart, barChart, hypnogram, SLEEP_COLORS } from './charts.js';
import * as store from './store.js';
import * as insights from './insights.js';
import * as report from './report.js';
import * as profile from './profile.js';
import * as overnight from './overnight.js';

let deviceStepGoal = 10000;

const $ = (id) => document.getElementById(id);
const ble = new BleManager();

// ---------- preferences (localStorage) ----------
const PREF_KEY = 'hume-prefs';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
function savePref(k, v) { try { const p = loadPrefs(); p[k] = v; localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

// ---------- helpers ----------
let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.dataset.kind = kind;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function fmtTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setConnectedUI(on) {
  $('statusDot').dataset.state = on ? 'on' : 'off';
  $('statusText').textContent = on ? 'Connected' : 'Disconnected';
  $('connectBtn').hidden = on;
  $('disconnectBtn').hidden = !on;
  for (const id of ['refreshDevice', 'measureBtn', 'downloadAll', 'readAuto']) $(id).disabled = !on;
  document.querySelectorAll('.hist-types .btn, .auto-item button').forEach((b) => { b.disabled = !on; });
  $('sinceDate').disabled = !on || !$('sinceToggle').checked;
  if (!on) setBattery(null);
  updateOvernightState();
}

function setBattery(percent) {
  const el = $('hdrBattery');
  if (percent == null || isNaN(percent)) { el.hidden = true; return; }
  const pct = Math.max(0, Math.min(100, percent));
  el.hidden = false;
  $('hdrBatteryText').textContent = pct + '%';
  $('hdrBatteryFill').style.width = Math.max(6, pct) + '%';
  el.dataset.level = pct <= 15 ? 'low' : pct <= 40 ? 'mid' : 'ok';
}

// ---------- connection ----------
$('connectBtn').addEventListener('click', async () => {
  try {
    $('statusDot').dataset.state = 'busy';
    $('statusText').textContent = 'Connecting…';
    await ble.connect();
    setConnectedUI(true);
    toast('Connected', 'ok');
    await refreshDevice();
  } catch (e) {
    setConnectedUI(false);
    if (e.name !== 'NotFoundError') toast(e.message || 'Connection failed', 'error');
  }
});

$('disconnectBtn').addEventListener('click', async () => {
  stopMeasuring();
  await ble.disconnect();
});

ble.on('disconnect', () => {
  setConnectedUI(false);
  stopMeasuring();
  toast('Device disconnected');
});

// ---------- device panel ----------
async function refreshDevice() {
  $('refreshDevice').disabled = true;
  try {
    const tasks = [
      ['name', cmdDeviceName(), OP.DEVICE_NAME, (b) => decodeDeviceName(b).name || '—'],
      ['mac', cmdMac(), OP.MAC, (b) => decodeMac(b).mac],
      ['stepGoal', cmdStepGoal(), OP.STEP_GOAL, (b) => { const g = decodeStepGoal(b).goal; if (g) deviceStepGoal = g; return g.toLocaleString(); }],
      ['deviceTime', cmdTime(), OP.TIME, (b) => fmtTime(decodeTime(b).time)],
      ['baseHr', cmdDeviceInfo(), OP.DEVICE_INFO, (b) => decodeDeviceInfo(b).baseHr || '—'],
    ];
    // battery -> header pill
    await runRequest(OP.BATTERY, cmdBattery(), (b) => setBattery(isRejected(b) ? null : decodeBattery(b).percent));
    // version writes two fields
    await runRequest(OP.VERSION, cmdVersion(), (b) => {
      const v = decodeVersion(b);
      $('firmware').textContent = 'v' + v.version;
      $('build').textContent = v.build || '—';
    });
    for (const [elId, frame, op, fmt] of tasks) {
      await runRequest(op, frame, (b) => { $(elId).textContent = isRejected(b) ? '—' : fmt(b); });
    }
    renderInsights();
  } finally {
    $('refreshDevice').disabled = !ble.connected;
  }
}

async function runRequest(opcode, frame, apply) {
  try {
    const b = await ble.request(opcode, [], { frame });
    apply(b);
  } catch (e) {
    // leave the field as-is; surface only once
    console.warn('request failed', opcode.toString(16), e.message);
  }
}

$('refreshDevice').addEventListener('click', refreshDevice);

// ---------- live measurement ----------
const LIVE_METRICS = {
  hr:   { label: 'Heart rate', unit: 'bpm', color: '#f87171', get: (m) => m.hr },
  spo2: { label: 'SpO₂',       unit: '%',   color: '#38bdf8', get: (m) => m.spo2 },
  hrv:  { label: 'HRV',        unit: 'ms',  color: '#a855f7', get: (m) => m.hrv },
  temp: { label: 'Temp',       unit: '°C',  color: '#fbbf24', get: (m) => m.tempC },
};
const emptySeries = () => ({ hr: [], spo2: [], hrv: [], temp: [] });

let measuring = false;
let liveMetric = 'hr';
let liveSeries = emptySeries();

function drawLive() {
  if (liveMetric === 'overlay') {
    const series = Object.entries(LIVE_METRICS).map(([k, d]) => ({ label: d.label, color: d.color, points: liveSeries[k] }));
    lineChart($('liveChart'), series, { height: 220 });
  } else {
    const def = LIVE_METRICS[liveMetric];
    lineChart($('liveChart'), liveSeries[liveMetric], { height: 220, color: def.color, unit: def.unit });
  }
}

function buildLiveControls() {
  const wrap = $('liveChartControls');
  wrap.innerHTML = '';
  const opts = [...Object.entries(LIVE_METRICS).map(([k, d]) => [k, d.label]), ['overlay', 'Overlay']];
  for (const [key, label] of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', key === liveMetric ? 'true' : 'false');
    b.addEventListener('click', () => {
      liveMetric = key;
      savePref('liveMetric', key);
      wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', 'false'));
      b.setAttribute('aria-selected', 'true');
      drawLive();
    });
    wrap.appendChild(b);
  }
}

const liveNotify = (bytes) => {
  if (bytes[0] !== OP.MEASURE) return;
  const m = decodeMeasurement(bytes);
  $('liveType').hidden = false;
  $('liveType').textContent = m.typeName;
  if (m.hr) $('mHr').textContent = m.hr;
  if (m.spo2) $('mSpo2').textContent = m.spo2;
  if (m.hrv) $('mHrv').textContent = m.hrv;
  if (m.stress) $('mStress').textContent = m.stress;
  if (m.systolic || m.diastolic) $('mBp').textContent = `${m.systolic}/${m.diastolic}`;
  if (m.tempC) $('mTemp').textContent = m.tempC.toFixed(1);
  const t = Date.now();
  for (const [key, def] of Object.entries(LIVE_METRICS)) {
    const v = def.get(m);
    if (v) {
      const s = liveSeries[key];
      s.push({ time: t, value: v });
      if (s.length > 150) s.shift();
    }
  }
  drawLive();
};

async function startMeasuring() {
  measuring = true;
  liveSeries = emptySeries();
  $('measureBtn').textContent = 'Stop';
  drawLive();
  ble.on('notify', liveNotify);
  try { await ble.sendRaw(cmdMeasure(1, 0, 0)); }
  catch (e) { toast(e.message, 'error'); stopMeasuring(); }
}

async function stopMeasuring() {
  if (!measuring) return;
  measuring = false;
  $('measureBtn').textContent = 'Start';
  ble.off('notify', liveNotify);
  try { if (ble.connected) await ble.sendRaw(cmdStopMeasure()); } catch (_) {}
}

$('measureBtn').addEventListener('click', () => (measuring ? stopMeasuring() : startMeasuring()));

// ---------- history ----------
function sinceDateValue() {
  if (!$('sinceToggle').checked) return null;
  const v = $('sinceDate').value;
  if (!v) return null;
  const d = new Date(v + 'T00:00:00');
  return isNaN(d) ? null : d;
}

$('sinceToggle').addEventListener('change', () => {
  $('sinceDate').disabled = !ble.connected || !$('sinceToggle').checked;
  savePref('sinceToggle', $('sinceToggle').checked);
});
$('sinceDate').addEventListener('change', () => savePref('sinceDate', $('sinceDate').value));

const histData = {}; // typeKey -> records

function buildHistButtons() {
  const wrap = $('histButtons');
  wrap.innerHTML = '';
  for (const [key, def] of Object.entries(RECORD_TYPES)) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.disabled = !ble.connected;
    btn.dataset.key = key;
    btn.innerHTML = `${def.label}<span class="count"></span>`;
    btn.addEventListener('click', () => downloadOne(key));
    wrap.appendChild(btn);
  }
}

let histBusy = false;
async function downloadOne(key) {
  if (histBusy) { toast('A download is already running'); return; }
  histBusy = true;
  stopMeasuring();
  const def = RECORD_TYPES[key];
  $('histProgress').hidden = false;
  $('histProgressText').textContent = `Downloading ${def.label}…`;
  $('statusDot').dataset.state = 'busy';
  try {
    const records = await downloadHistory(ble, key, {
      since: sinceDateValue(),
      onProgress: (n) => { $('histProgressText').textContent = `${def.label}: ${n} records…`; },
    });
    const added = await store.putRecords(key, records);
    const merged = await store.getRecords(key);
    const all = merged.length ? merged : records;
    histData[key] = all;
    setHistCount(key, all.length);
    renderHistBlock(key, all);
    await refreshStoredNote();
    renderInsights();
    renderProfileDerived();
    renderOvernight();
    toast(`${def.label}: +${added} new · ${all.length} saved`, all.length ? 'ok' : '');
  } catch (e) {
    toast(`${def.label} failed: ${e.message}`, 'error');
  } finally {
    histBusy = false;
    $('histProgress').hidden = true;
    $('statusDot').dataset.state = ble.connected ? 'on' : 'off';
  }
}

$('downloadAll').addEventListener('click', async () => {
  for (const key of Object.keys(RECORD_TYPES)) {
    // run sequentially; the band serves one stream at a time
    // eslint-disable-next-line no-await-in-loop
    await downloadOne(key);
  }
});

function renderHistBlock(key, records) {
  const def = RECORD_TYPES[key];
  let block = document.getElementById('hb-' + key);
  if (!block) {
    block = document.createElement('div');
    block.className = 'hist-block';
    block.id = 'hb-' + key;
    $('histResults').prepend(block);
  }
  block.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'hist-block-head';
  const range = records.length
    ? `${fmtTime(records[0].time)} → ${fmtTime(records[records.length - 1].time)}`
    : 'no records';
  head.innerHTML = `<h3>${def.label}</h3><span class="meta">${records.length} records · ${range}</span>`;
  const csvBtn = document.createElement('button');
  csvBtn.className = 'btn btn-sm';
  csvBtn.textContent = 'CSV';
  csvBtn.disabled = !records.length;
  csvBtn.addEventListener('click', () => downloadCsv(key, records));
  head.appendChild(csvBtn);
  block.appendChild(head);

  if (!records.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Nothing stored for this type (empty on V2 firmware for some types).';
    block.appendChild(p);
    return;
  }

  if (key === 'sleep') { renderSleep(block, records); return; }

  renderSummary(block, key, records);

  {
    const points = records
      .filter((r) => typeof r.value === 'number' || typeof r.steps === 'number')
      .map((r) => ({ time: r.time, value: r.value ?? r.steps }));
    const canvas = document.createElement('canvas');
    canvas.className = 'chart';
    block.appendChild(canvas);
    const color = { hr: '#f87171', spo2: '#38bdf8', temp: '#fbbf24', hrv: '#a855f7', steps: '#22c55e', totals: '#22c55e' }[key] || '#38bdf8';
    requestAnimationFrame(() => lineChart(canvas, points, { height: 200, color }));
  }
}

function renderSummary(block, key, records) {
  const row = document.createElement('div');
  row.className = 'summary-row';
  const vals = records.map((r) => r.value).filter((v) => typeof v === 'number' && v > 0);
  const avg = (a) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : 0);
  if (key === 'steps' || key === 'totals') {
    const total = records.reduce((s, r) => s + (r.steps || 0), 0);
    const kcal = records.reduce((s, r) => s + (r.kcal || 0), 0);
    const km = records.reduce((s, r) => s + (r.km || 0), 0);
    row.innerHTML = `<span>Steps <b>${total.toLocaleString()}</b></span><span>Distance <b>${km.toFixed(2)} km</b></span><span>Calories <b>${Math.round(kcal)}</b></span>`;
  } else if (key === 'sleep') {
    const counts = {};
    records.forEach((r) => r.stages.forEach((s) => { counts[s.stage] = (counts[s.stage] || 0) + 1; }));
    const total = Object.values(counts).reduce((s, x) => s + x, 0) || 1;
    row.innerHTML = Object.entries(counts)
      .map(([st, n]) => `<span>${st} <b>${Math.round((n / total) * 100)}%</b></span>`)
      .join('');
  } else if (vals.length) {
    const unit = def(key).unit;
    row.innerHTML = `<span>Avg <b>${avg(vals).toFixed(unit === '°C' ? 1 : 0)} ${unit}</b></span><span>Min <b>${Math.min(...vals)}</b></span><span>Max <b>${Math.max(...vals)}</b></span>`;
  }
  if (row.innerHTML) block.appendChild(row);
}
function def(key) { return RECORD_TYPES[key]; }

function setHistCount(key, n) {
  const el = document.querySelector(`.hist-types .btn[data-key="${key}"] .count`);
  if (el) el.textContent = `(${n})`;
}

// ---------- sleep report ----------
const timeHM = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const fmtDur = (min) => { const H = Math.floor(min / 60), M = min % 60; return H ? `${H}h ${M}m` : `${M}m`; };
const pct = (c, t) => (t ? Math.round((c || 0) / t * 100) + '%' : '0%');

function renderSleep(block, records) {
  const nights = records.slice().sort((a, b) => a.time - b.time);

  const pickRow = document.createElement('div');
  pickRow.className = 'summary-row';
  const pLabel = document.createElement('span'); pLabel.textContent = 'Night';
  const picker = document.createElement('select'); picker.className = 'night-picker';
  nights.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${n.time.getMonth() + 1}/${n.time.getDate()} ${timeHM(n.time)} · ${fmtDur(n.stages.length)}`;
    picker.appendChild(o);
  });
  pickRow.appendChild(pLabel); pickRow.appendChild(picker);
  block.appendChild(pickRow);

  const stats = document.createElement('div'); stats.className = 'summary-row'; block.appendChild(stats);
  const hypno = document.createElement('canvas'); hypno.className = 'chart'; block.appendChild(hypno);

  const legend = document.createElement('div'); legend.className = 'sleep-legend';
  ['deep', 'light', 'REM', 'awake'].forEach((st) => {
    const s = document.createElement('span'); s.className = 'sl';
    s.innerHTML = `<i style="background:${SLEEP_COLORS[st]}"></i>${st}`;
    legend.appendChild(s);
  });
  block.appendChild(legend);

  function showNight(i) {
    const n = nights[i];
    const total = n.stages.length;
    const counts = {};
    n.stages.forEach((s) => { counts[s.stage] = (counts[s.stage] || 0) + 1; });
    const asleep = total - (counts.awake || 0);
    const eff = total ? Math.round(asleep / total * 100) : 0;
    const wake = new Date(n.time.getTime() + total * 60000);
    stats.innerHTML =
      `<span>Asleep <b>${fmtDur(asleep)}</b></span>` +
      `<span>In bed <b>${fmtDur(total)}</b></span>` +
      `<span>Efficiency <b>${eff}%</b></span>` +
      `<span>Deep <b>${pct(counts.deep, total)}</b></span>` +
      `<span>Light <b>${pct(counts.light, total)}</b></span>` +
      `<span>REM <b>${pct(counts.REM, total)}</b></span>` +
      `<span><b>${timeHM(n.time)}–${timeHM(wake)}</b></span>`;
    requestAnimationFrame(() => hypnogram(hypno, n.stages, { height: 150 }));
  }
  picker.addEventListener('change', () => showNight(parseInt(picker.value, 10)));
  picker.value = String(nights.length - 1);
  showNight(nights.length - 1);

  if (nights.length > 1) {
    const h = document.createElement('div'); h.className = 'summary-row'; h.innerHTML = '<span>Asleep per night (hours)</span>';
    block.appendChild(h);
    const trend = document.createElement('canvas'); trend.className = 'chart';
    block.appendChild(trend);
    const bars = nights.map((n) => ({
      label: `${n.time.getMonth() + 1}/${n.time.getDate()}`,
      value: +(n.stages.filter((s) => s.stage !== 'awake').length / 60).toFixed(1),
      color: '#6366f1',
    }));
    requestAnimationFrame(() => barChart(trend, bars, { height: 150 }));
  }
}

// ---------- profile ----------
function buildProfile() {
  const p = profile.loadProfile();
  if (p.age) $('pAge').value = p.age;
  if (p.sex) $('pSex').value = p.sex;
  if (p.height) $('pHeight').value = p.height;
  if (p.weight) $('pWeight').value = p.weight;
  $('pSave').addEventListener('click', () => {
    profile.saveProfile({ age: $('pAge').value, sex: $('pSex').value, height: $('pHeight').value, weight: $('pWeight').value });
    renderProfileDerived();
    toast('Profile saved', 'ok');
  });
}

function derivedTile(label, value, sub) {
  return `<div class="dtile"><span class="dl">${label}</span><span class="dv">${value}</span><span class="ds">${sub || ''}</span></div>`;
}

function renderProfileDerived() {
  const p = profile.loadProfile();
  const resting = insights.restingHr(histData.hr || []);
  const d = profile.derive(p, resting ? resting.latest : null);
  const el = $('profileDerived');
  if (!d.hasAny) {
    el.innerHTML = '<p class="hint" style="margin-top:12px">Add your details above to personalize HR zones, recovery context and energy estimates. Nothing is sent anywhere — it stays on this device.</p>';
    return;
  }
  const tiles = [];
  if (d.hrMax) tiles.push(derivedTile('Max HR', d.hrMax, 'bpm (est.)'));
  if (d.bmi) tiles.push(derivedTile('BMI', d.bmi.value, d.bmi.category));
  if (d.bmr) tiles.push(derivedTile('BMR', d.bmr.toLocaleString(), 'kcal/day'));
  let zonesHtml = '';
  if (d.zones) {
    const rows = d.zones.map((z) => `<tr><td><span class="zdot" style="background:${z.color}"></span>${z.name}</td><td>${z.min}–${z.max} bpm</td></tr>`).join('');
    zonesHtml = `<div class="prof-zones"><div class="insight-h">Training zones${resting ? ` · based on resting ${d.restingUsed} bpm` : ' · add resting HR by downloading history'}</div><table class="ztable">${rows}</table></div>`;
  }
  el.innerHTML = `<div class="derived-grid">${tiles.join('')}</div>${zonesHtml}`;
}

// ---------- overnight mode ----------
function updateOvernightState() {
  const enableBtn = $('ovEnable');
  if (!enableBtn) return;
  const active = !!overnight.loadPrev();
  enableBtn.hidden = active;
  $('ovRestore').hidden = !active;
  enableBtn.disabled = !ble.connected;
  $('ovRestore').disabled = !ble.connected;
  const status = $('ovStatus');
  if (active) {
    const p = overnight.loadPrev();
    const when = p && p.at ? fmtTime(new Date(p.at)) : null;
    status.textContent = `Overnight capture is ON${when ? ` (since ${when})` : ''} — expect higher battery use and a shorter history window. Tap "Restore normal intervals" when you wake.`;
  } else if (!ble.connected) {
    status.textContent = 'Connect your band to enable denser overnight capture.';
  } else {
    status.textContent = '';
  }
}

$('ovEnable').addEventListener('click', async () => {
  if (!ble.connected) { toast('Connect the band first', 'error'); return; }
  $('ovEnable').disabled = true;
  $('ovStatus').textContent = 'Saving your current intervals…';
  try {
    const prev = {};
    for (const m of overnight.OVERNIGHT_METRICS) {
      try {
        const b = await ble.request(OP.GET_AUTO, [], { frame: cmdGetAuto(m) });
        prev[m] = (!isRejected(b) && decodeAuto(b).intervalMinutes) || overnight.FACTORY[m];
      } catch { prev[m] = overnight.FACTORY[m]; }
    }
    overnight.savePrev(prev);
    $('ovStatus').textContent = 'Setting 1-minute intervals…';
    for (const m of overnight.OVERNIGHT_METRICS) {
      await ble.request(OP.SET_AUTO, [], { frame: cmdSetAuto(m, overnight.FINE_INTERVAL, true) });
    }
    await readAuto();
    updateOvernightState();
    toast('Overnight capture on — charge up, and restore in the morning', 'ok');
  } catch (e) {
    toast(e.message || 'Could not set intervals', 'error');
  } finally {
    updateOvernightState();
  }
});

$('ovRestore').addEventListener('click', async () => {
  if (!ble.connected) { toast('Connect the band first', 'error'); return; }
  const prev = overnight.loadPrev();
  const map = (prev && prev.intervals) || overnight.FACTORY;
  $('ovRestore').disabled = true;
  $('ovStatus').textContent = 'Restoring your intervals…';
  try {
    for (const m of overnight.OVERNIGHT_METRICS) {
      const v = map[m] || overnight.FACTORY[m];
      await ble.request(OP.SET_AUTO, [], { frame: cmdSetAuto(m, v, true) });
    }
    overnight.clearPrev();
    await readAuto();
    updateOvernightState();
    toast('Normal intervals restored', 'ok');
  } catch (e) {
    toast(e.message || 'Could not restore intervals', 'error');
    updateOvernightState();
  }
});

function ovTile(label, value, sub) {
  return `<div class="dtile"><span class="dl">${label}</span><span class="dv">${value}</span><span class="ds">${sub || ''}</span></div>`;
}

function renderOvernight() {
  const el = $('ovAnalysis');
  if (!el) return;
  const win = overnight.overnightWindow(histData.sleep, histData.spo2);
  const sp = overnight.analyzeSpo2(histData.spo2 || [], win);
  const hr = overnight.hrSummary(histData.hr || [], win);
  if (!sp && !hr) {
    el.innerHTML = '<p class="hint">No overnight data yet. Enable overnight capture, wear the band overnight, then sync in the morning to see your SpO₂ and heart-rate overview here.</p>';
    return;
  }
  const tiles = [];
  if (sp) {
    tiles.push(ovTile('Lowest SpO₂', sp.lowest + '%', ''));
    tiles.push(ovTile('Mean SpO₂', sp.mean + '%', ''));
    tiles.push(ovTile('Readings < 90%', String(sp.below90), `of ${sp.n}`));
    tiles.push(ovTile('Dips ≥4%', String(sp.dips), 'coarse'));
  }
  if (hr) tiles.push(ovTile('Overnight HR', `${hr.min}–${hr.max}`, `avg ${hr.mean} bpm`));
  const chart = sp && sp.points.length > 1 ? '<canvas id="ovChart" class="chart"></canvas>' : '';
  const gapNote = sp && sp.gapMin != null ? ` SpO₂ was sampled about every ${sp.gapMin} min — far too sparse to catch apnea events (seconds long).` : '';
  const note = `<p class="hint">Window: ${win.label}.${gapNote} This is a wellness overview, <strong>not a diagnosis</strong>. A low lowest-SpO₂ or many dips here is a reason to see a doctor — not a result on its own.</p>`;
  el.innerHTML = `<div class="derived-grid">${tiles.join('')}</div>${chart}${note}`;
  if (sp && sp.points.length > 1) {
    requestAnimationFrame(() => lineChart($('ovChart'), sp.points, { height: 180, color: '#38bdf8', unit: '%', yMin: Math.min(85, sp.lowest - 2), yMax: 100 }));
  }
}

const STOPBANG_Q = [
  ['snore', 'Snore loudly (louder than talking, or heard through a closed door)?'],
  ['tired', 'Often tired, fatigued or sleepy during the daytime?'],
  ['observed', 'Has anyone observed you stop breathing, gasp or choke during sleep?'],
  ['pressure', 'High blood pressure (or being treated for it)?'],
  ['bmi', 'BMI over 35?'],
  ['age', 'Age over 50?'],
  ['neck', 'Neck circumference over 40 cm (collar larger than 16")?'],
  ['male', 'Male?'],
];

function buildStopBang() {
  const wrap = $('stopbangForm');
  if (!wrap) return;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('hume-stopbang')) || {}; } catch { saved = {}; }
  const prof = profile.derive(profile.loadProfile(), null);
  const ans = { ...saved };
  if (ans.bmi === undefined && prof.bmi) ans.bmi = prof.bmi.value > 35;
  if (ans.age === undefined && prof.age) ans.age = prof.age > 50;
  if (ans.male === undefined && prof.sex) ans.male = prof.sex === 'male';

  wrap.innerHTML = STOPBANG_Q.map(([k, label]) => `<label class="sb"><input type="checkbox" data-k="${k}" ${ans[k] ? 'checked' : ''} /><span>${label}</span></label>`).join('');
  const out = $('stopbangResult');
  function recompute(persist) {
    const a = {};
    wrap.querySelectorAll('input').forEach((i) => { a[i.dataset.k] = i.checked; });
    if (persist) { try { localStorage.setItem('hume-stopbang', JSON.stringify(a)); } catch { /* ignore */ } }
    const r = overnight.stopBang(a);
    const col = r.risk === 'High' ? '#f87171' : r.risk === 'Intermediate' ? '#f59e0b' : '#22c55e';
    const advice = r.score >= 3 ? ' An intermediate or high score is a good reason to discuss a sleep study with a doctor.' : ' Keep in mind this is a general screen, not a diagnosis.';
    out.innerHTML = `<span class="sb-score" style="color:${col}">${r.score}/8 · ${r.risk} risk</span><span class="hint">${advice}</span>`;
  }
  wrap.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => recompute(true)));
  recompute(false);
}

// ---------- local store ----------
async function loadStored() {
  if (!store.available()) return;
  for (const key of Object.keys(RECORD_TYPES)) {
    const recs = await store.getRecords(key);
    if (recs.length) { histData[key] = recs; setHistCount(key, recs.length); renderHistBlock(key, recs); }
  }
  await refreshStoredNote();
  renderInsights();
  renderProfileDerived();
  renderOvernight();
}

// ---------- insights ----------
function renderInsights() {
  const body = $('insightsBody');
  const hr = histData.hr || [];
  const resting = insights.restingHr(hr);
  const zones = insights.hrZones(hr);
  const recovery = insights.recoveryScore({ resting, hrvRecords: histData.hrv || [], sleepRecords: histData.sleep || [] });
  const stepsSum = insights.stepsSummary(histData.totals || [], histData.steps || [], deviceStepGoal);

  if (!resting && !zones && !recovery && !stepsSum) {
    $('insightsSource').hidden = true;
    $('reportBtn').hidden = true;
    body.innerHTML = '<p class="hint">Download history (or connect your band) to see resting heart rate, HR zones, a recovery score and your steps dashboard. Everything is computed from your saved data on this device.</p>';
    return;
  }
  $('insightsSource').hidden = false;
  $('reportBtn').hidden = false;

  const tiles = [];
  if (resting) {
    tiles.push(`<div class="insight"><div class="insight-h">Resting HR</div><div class="insight-big">${resting.latest}<span>bpm</span></div><div class="insight-sub">avg ${resting.avg} · ${resting.daily.length}d</div><canvas class="ins-spark" data-spark="rhr"></canvas></div>`);
  }
  if (recovery) {
    const col = recovery.score >= 80 ? '#22c55e' : recovery.score >= 65 ? '#38bdf8' : recovery.score >= 50 ? '#f59e0b' : '#f87171';
    const parts = [];
    if (recovery.detail.restingHr) parts.push(`RHR ${recovery.detail.restingHr}`);
    if (recovery.detail.hrv) parts.push(`HRV ${recovery.detail.hrv}`);
    if (recovery.detail.sleepH) parts.push(`${recovery.detail.sleepH}h`);
    tiles.push(`<div class="insight"><div class="insight-h">Recovery</div><div class="ring" style="--pct:${recovery.score};--col:${col}"><div class="ring-in"><span class="ring-val">${recovery.score}</span></div></div><div class="insight-sub">${recovery.label}${parts.length ? ' · ' + parts.join(' · ') : ''}</div></div>`);
  }
  if (stepsSum) {
    const pctv = Math.min(100, Math.round(stepsSum.today.steps / stepsSum.goal * 100));
    tiles.push(`<div class="insight"><div class="insight-h">Steps today</div><div class="ring" style="--pct:${pctv};--col:#22c55e"><div class="ring-in"><span class="ring-val">${(stepsSum.today.steps / 1000).toFixed(1)}k</span><span class="ring-sub">${pctv}%</span></div></div><div class="insight-sub">goal ${stepsSum.goal.toLocaleString()} · streak ${stepsSum.streak}d · best ${stepsSum.best.steps.toLocaleString()}</div></div>`);
  }
  if (zones) {
    const bar = zones.filter((z) => z.pct > 0).map((z) => `<div class="zseg" style="width:${z.pct}%;background:${z.color}" title="${z.name} ${z.pct}%"></div>`).join('');
    const leg = zones.map((z) => `<span class="zl"><i style="background:${z.color}"></i>${z.name} ${z.pct}%</span>`).join('');
    tiles.push(`<div class="insight insight-wide"><div class="insight-h">HR zones</div><div class="zones">${bar}</div><div class="zone-legend">${leg}</div></div>`);
  }

  const showTrend = stepsSum && stepsSum.last7.length > 1;
  body.innerHTML = `<div class="insight-grid">${tiles.join('')}</div>` +
    (showTrend ? '<div class="summary-row" style="margin-top:14px"><span>Steps, recent days</span></div><canvas id="stepsTrend" class="chart"></canvas>' : '');

  if (resting && resting.daily.length > 1) {
    const c = body.querySelector('[data-spark="rhr"]');
    if (c) requestAnimationFrame(() => lineChart(c, resting.daily, { height: 56, color: '#f87171', minimal: true }));
  }
  if (showTrend) {
    const c = $('stepsTrend');
    requestAnimationFrame(() => barChart(c, stepsSum.last7.map((d) => ({ label: d.label, value: d.value, color: '#22c55e' })), { height: 150 }));
  }
}

async function refreshStoredNote() {
  if (!store.available()) return;
  const s = await store.summary();
  const total = Object.values(s).reduce((a, x) => a + x.count, 0);
  const note = $('storedNote');
  if (total) {
    const times = Object.values(s).flatMap((x) => [x.from, x.to]);
    const from = new Date(Math.min(...times)), to = new Date(Math.max(...times));
    note.hidden = false;
    $('clearStored').hidden = false;
    note.textContent = `Saved locally: ${total.toLocaleString()} records · ${fmtTime(from)} → ${fmtTime(to)} — kept in this browser so history grows past the band's 4–5 day limit.`;
  } else {
    note.hidden = true;
    $('clearStored').hidden = true;
  }
}

function downloadCsv(key, records) {
  const csv = recordsToCsv(key, records);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hume-${key}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- auto-logging ----------
const AUTO_METRICS = [
  { metric: 1, label: 'Heart rate', factory: 10 },
  { metric: 2, label: 'SpO₂', factory: 30 },
  { metric: 3, label: 'Temperature', factory: 5 },
  { metric: 4, label: 'HRV', factory: 60 },
];

function buildAutoGrid() {
  const grid = $('autoGrid');
  grid.innerHTML = '';
  for (const m of AUTO_METRICS) {
    const item = document.createElement('div');
    item.className = 'auto-item';
    item.innerHTML = `
      <h4>${m.label}</h4>
      <div class="row">
        <input type="number" min="1" max="1440" value="${m.factory}" id="auto-${m.metric}" />
        <span>min</span>
        <button class="btn btn-sm" data-metric="${m.metric}" ${ble.connected ? '' : 'disabled'}>Set</button>
      </div>
      <div class="current" id="autocur-${m.metric}">factory: ${m.factory} min</div>`;
    grid.appendChild(item);
    item.querySelector('button').addEventListener('click', () => setAuto(m.metric));
  }
}

async function readAuto() {
  for (const m of AUTO_METRICS) {
    try {
      const b = await ble.request(OP.GET_AUTO, [], { frame: cmdGetAuto(m.metric) });
      if (isRejected(b)) continue;
      const a = decodeAuto(b);
      $(`autocur-${m.metric}`).textContent = `current: ${a.intervalMinutes} min · ${a.enabled ? 'on' : 'off'}`;
      $(`auto-${m.metric}`).value = a.intervalMinutes || m.factory;
    } catch (_) {}
  }
  toast('Read auto-logging', 'ok');
}

async function setAuto(metric) {
  const v = parseInt($(`auto-${metric}`).value, 10);
  if (!v || v < 1) { toast('Enter a valid interval', 'error'); return; }
  try {
    const b = await ble.request(OP.SET_AUTO, [], { frame: cmdSetAuto(metric, v, true) });
    if (isRejected(b)) { toast('Band rejected the setting', 'error'); return; }
    $(`autocur-${metric}`).textContent = `current: ${v} min · on`;
    toast('Interval updated', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

$('readAuto').addEventListener('click', readAuto);

// ---------- log console ----------
const logLines = [];
ble.on('log', ({ dir, bytes }) => {
  logLines.push(`<span class="${dir}">${dir.toUpperCase()}</span> ${toHex(bytes)}`);
  if (logLines.length > 500) logLines.shift();
  if (!$('logOut').hidden) {
    $('logOut').innerHTML = logLines.join('\n');
    $('logOut').scrollTop = $('logOut').scrollHeight;
  }
});
$('logToggle').addEventListener('change', (e) => {
  $('logOut').hidden = !e.target.checked;
  if (e.target.checked) $('logOut').innerHTML = logLines.join('\n');
});
$('clearLog').addEventListener('click', () => { logLines.length = 0; $('logOut').innerHTML = ''; });

// ---------- redraw charts on resize ----------
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [key, records] of Object.entries(histData)) renderHistBlock(key, records);
    drawLive();
  }, 200);
});

$('clearStored').addEventListener('click', async () => {
  await store.clearAll();
  for (const k of Object.keys(histData)) delete histData[k];
  $('histResults').innerHTML = '';
  document.querySelectorAll('.hist-types .btn .count').forEach((e) => { e.textContent = ''; });
  await refreshStoredNote();
  toast('Saved history cleared');
});

// ---------- PDF health report ----------
$('reportBtn').addEventListener('click', () => {
  const device = {
    name: $('name').textContent,
    mac: $('mac').textContent,
    firmware: $('firmware').textContent,
    build: $('build').textContent,
    stepGoal: $('stepGoal').textContent,
  };
  const ok = report.generateReport(histData, device, deviceStepGoal);
  if (!ok) toast('Allow pop-ups to open the report', 'error');
});

// ---------- PWA install + offline ----------
let deferredPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function updateInstallBtn() { $('installBtn').hidden = isStandalone(); }

function platformInstallSteps() {
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  if (iOS) return 'On iPhone/iPad (Safari): tap the <b>Share</b> icon, then <b>Add to Home Screen</b>.<br><span class="muted">iOS doesn\'t support Web Bluetooth, so an installed copy can view saved data but can\'t connect to the band — pair from Chrome/Edge on desktop or Chrome on Android.</span>';
  if (android) return 'On Android (Chrome): open the <b>⋮</b> menu and tap <b>Install app</b> (or <b>Add to Home screen</b>). Then launch it from your home screen — it runs standalone and offline.';
  return 'On desktop (Chrome or Edge): click the <b>install icon</b> in the address bar, or open the <b>⋮</b> menu and choose <b>Install Hume…</b>.';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  updateInstallBtn();
});

$('installBtn').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    updateInstallBtn();
    return;
  }
  $('installSteps').innerHTML = platformInstallSteps();
  $('installModal').hidden = false;
});
$('installClose').addEventListener('click', () => { $('installModal').hidden = true; });
$('installModal').addEventListener('click', (e) => { if (e.target.id === 'installModal') $('installModal').hidden = true; });
window.addEventListener('appinstalled', () => { $('installModal').hidden = true; updateInstallBtn(); toast('App installed', 'ok'); });

updateInstallBtn();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

// ---------- init ----------
async function init() {
  if (!BleManager.supported) {
    $('unsupported').hidden = false;
    $('connectBtn').disabled = true;
  }
  const prefs = loadPrefs();
  if (prefs.liveMetric && (LIVE_METRICS[prefs.liveMetric] || prefs.liveMetric === 'overlay')) liveMetric = prefs.liveMetric;

  buildHistButtons();
  buildAutoGrid();
  buildLiveControls();
  buildProfile();
  renderProfileDerived();
  buildStopBang();
  renderOvernight();
  setConnectedUI(false);
  drawLive();
  // default "since" date = 5 days ago (band keeps ~4–5 days)
  const d = new Date(); d.setDate(d.getDate() - 5);
  $('sinceDate').value = d.toISOString().slice(0, 10);
  if (prefs.sinceDate) $('sinceDate').value = prefs.sinceDate;
  if (prefs.sinceToggle) $('sinceToggle').checked = true;
  await loadStored();
}
init();
