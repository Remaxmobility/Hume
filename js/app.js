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
import { lineChart, hypnogram } from './charts.js';

const $ = (id) => document.getElementById(id);
const ble = new BleManager();

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
      ['battery', cmdBattery(), OP.BATTERY, (b) => `${decodeBattery(b).percent}%`],
      ['name', cmdDeviceName(), OP.DEVICE_NAME, (b) => decodeDeviceName(b).name || '—'],
      ['mac', cmdMac(), OP.MAC, (b) => decodeMac(b).mac],
      ['stepGoal', cmdStepGoal(), OP.STEP_GOAL, (b) => decodeStepGoal(b).goal.toLocaleString()],
      ['deviceTime', cmdTime(), OP.TIME, (b) => fmtTime(decodeTime(b).time)],
      ['baseHr', cmdDeviceInfo(), OP.DEVICE_INFO, (b) => decodeDeviceInfo(b).baseHr || '—'],
    ];
    // version writes two fields
    await runRequest(OP.VERSION, cmdVersion(), (b) => {
      const v = decodeVersion(b);
      $('firmware').textContent = 'v' + v.version;
      $('build').textContent = v.build || '—';
    });
    for (const [elId, frame, op, fmt] of tasks) {
      await runRequest(op, frame, (b) => { $(elId).textContent = isRejected(b) ? '—' : fmt(b); });
    }
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
let measuring = false;
let liveSeries = [];
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
  if (m.hr) {
    liveSeries.push({ time: Date.now(), value: m.hr });
    if (liveSeries.length > 120) liveSeries.shift();
    lineChart($('liveChart'), liveSeries, { height: 180, color: '#38bdf8' });
  }
};

async function startMeasuring() {
  measuring = true;
  liveSeries = [];
  $('measureBtn').textContent = 'Stop';
  $('liveChart').hidden = false;
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
});

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
    histData[key] = records;
    const btn = document.querySelector(`.hist-types .btn[data-key="${key}"] .count`);
    if (btn) btn.textContent = `(${records.length})`;
    renderHistBlock(key, records);
    toast(`${def.label}: ${records.length} records`, records.length ? 'ok' : '');
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

  renderSummary(block, key, records);

  if (key === 'sleep') {
    // show the most recent sleep block as a hypnogram
    const last = records[records.length - 1];
    const canvas = document.createElement('canvas');
    canvas.className = 'chart';
    block.appendChild(canvas);
    requestAnimationFrame(() => hypnogram(canvas, last.stages, { height: 150 }));
  } else {
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
    if (measuring && liveSeries.length) lineChart($('liveChart'), liveSeries, { height: 180, color: '#38bdf8' });
  }, 200);
});

// ---------- init ----------
function init() {
  if (!BleManager.supported) {
    $('unsupported').hidden = false;
    $('connectBtn').disabled = true;
  }
  buildHistButtons();
  buildAutoGrid();
  setConnectedUI(false);
  // default "since" date = 5 days ago (band keeps ~4–5 days)
  const d = new Date(); d.setDate(d.getDate() - 5);
  $('sinceDate').value = d.toISOString().slice(0, 10);
}
init();
