// charts.js — zero-dependency canvas charts.
// lineChart: one or many series, legend, and hover tooltips.
// barChart:  simple labelled bars (used for the sleep-per-night trend).
// hypnogram: sleep stage timeline.

function dpr() { return window.devicePixelRatio || 1; }

function setupCanvas(canvas, cssHeight) {
  const ratio = dpr();
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = cssHeight;
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}

const COLORS = {
  axis: 'rgba(148,163,184,0.22)',
  text: 'rgba(166,183,205,0.95)',
  line: '#38bdf8',
  fill: 'rgba(56,189,248,0.12)',
};
// light palette for the printable report (dark text on white)
const LIGHT = {
  axis: 'rgba(15,23,42,0.14)',
  text: 'rgba(51,65,85,0.95)',
  line: '#0ea5e9',
  fill: 'rgba(14,165,233,0.12)',
};
const palette = (opts) => (opts && opts.light ? LIGHT : COLORS);

function fmtDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const xval = (p) => (p.time instanceof Date ? p.time.getTime() : p.time);

/**
 * Line chart with hover tooltips.
 * @param canvas
 * @param data   either [{time,value}] (single series) or
 *               [{label,color,points:[{time,value}]}] (multi-series)
 * @param opts   { height, color, label, yMin, yMax, unit, area }
 */
export function lineChart(canvas, data, opts = {}) {
  const height = opts.height || 220;
  const { ctx, w, h } = setupCanvas(canvas, height);

  const series = (Array.isArray(data) && data[0] && Array.isArray(data[0].points))
    ? data
    : [{ label: opts.label || '', color: opts.color || C.line, points: data || [] }];
  const multi = series.length > 1;
  const hasLegend = multi && series.some((s) => s.label);
  const all = series.flatMap((s) => s.points);
  const C = palette(opts);

  if (canvas._hoverCleanup) { canvas._hoverCleanup(); canvas._hoverCleanup = null; }

  if (!all.length) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.text;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', w / 2, h / 2);
    return;
  }

  const minimal = !!opts.minimal;
  const padL = minimal ? 3 : 46, padR = minimal ? 3 : 14;
  const padT = minimal ? 3 : (hasLegend ? 28 : 12), padB = minimal ? 3 : 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xs = all.map(xval);
  const ys = all.map((p) => p.value);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = opts.yMin ?? Math.min(...ys);
  let yMax = opts.yMax ?? Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.12;
  yMin -= yPad; yMax += yPad;

  const xToPx = (x) => padL + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const yToPx = (y) => padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  function drawBase() {
    ctx.clearRect(0, 0, w, h);

    if (minimal) {
      series.forEach((s) => {
        if (!s.points.length) return;
        const color = s.color || C.line;
        ctx.beginPath();
        s.points.forEach((p, i) => { const x = xToPx(xval(p)), y = yToPx(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.lineTo(xToPx(xval(s.points[s.points.length - 1])), padT + plotH);
        ctx.lineTo(xToPx(xval(s.points[0])), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = C.fill; ctx.fill();
        ctx.beginPath();
        s.points.forEach((p, i) => { const x = xToPx(xval(p)), y = yToPx(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
      });
      return;
    }

    // grid + y labels
    ctx.strokeStyle = C.axis;
    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = yMin + (i / ticks) * (yMax - yMin);
      const py = yToPx(v);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      ctx.fillText(v.toFixed(Math.abs(v) < 10 ? 1 : 0), padL - 6, py);
    }

    // x labels
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDay(new Date(xMin)), padL, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDay(new Date(xMax)), w - padR, h - 8);

    series.forEach((s) => {
      if (!s.points.length) return;
      const color = s.color || C.line;
      if (!multi && opts.area !== false) {
        ctx.beginPath();
        s.points.forEach((p, i) => { const x = xToPx(xval(p)), y = yToPx(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.lineTo(xToPx(xval(s.points[s.points.length - 1])), padT + plotH);
        ctx.lineTo(xToPx(xval(s.points[0])), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = C.fill; ctx.fill();
      }
      ctx.beginPath();
      s.points.forEach((p, i) => { const x = xToPx(xval(p)), y = yToPx(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
    });

    // legend
    if (hasLegend) {
      let lx = padL;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '11px system-ui, sans-serif';
      series.forEach((s) => {
        ctx.strokeStyle = s.color || C.line; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(lx, 14); ctx.lineTo(lx + 16, 14); ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(s.label, lx + 21, 15);
        lx += 32 + ctx.measureText(s.label).width;
      });
    }
  }

  function nearest(points, t) {
    let best = null, bd = Infinity;
    for (const p of points) { const d = Math.abs(xval(p) - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  function draw(hoverX) {
    drawBase();
    if (hoverX == null || hoverX < padL || hoverX > w - padR) return;
    const t = xMin + ((hoverX - padL) / plotW) * (xMax - xMin);

    // crosshair
    const hx = Math.max(padL, Math.min(w - padR, hoverX));
    ctx.strokeStyle = 'rgba(226,232,240,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();

    const rows = [];
    let refTime = null;
    series.forEach((s) => {
      const p = nearest(s.points, t);
      if (!p) return;
      refTime = p.time;
      const px = xToPx(xval(p)), py = yToPx(p.value);
      ctx.fillStyle = s.color || C.line;
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
      const val = Number.isInteger(p.value) ? p.value : p.value.toFixed(1);
      rows.push({ color: s.color || C.line, text: multi ? `${s.label} ${val}` : `${val}${opts.unit ? ' ' + opts.unit : ''}` });
    });
    if (!rows.length) return;

    // tooltip box
    ctx.font = '11px system-ui, sans-serif';
    const timeStr = refTime instanceof Date ? fmtDay(refTime) : '';
    const lines = [timeStr, ...rows.map((r) => r.text)];
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + (multi ? 18 : 12) + 12;
    const th = lines.length * 15 + 8;
    let bx = hx + 12; if (bx + tw > w - 4) bx = hx - tw - 12;
    let by = padT + 6; by = Math.min(by, h - th - 4);

    ctx.fillStyle = 'rgba(12,18,32,0.92)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, bx, by, tw, th, 8); ctx.fill(); ctx.stroke();

    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.fillText(timeStr, bx + 8, by + 13);
    rows.forEach((r, i) => {
      const ly = by + 13 + (i + 1) * 15;
      if (multi) { ctx.fillStyle = r.color; ctx.fillRect(bx + 8, ly - 4, 8, 8); }
      ctx.fillStyle = '#e8eef7';
      ctx.fillText(r.text, bx + (multi ? 20 : 8), ly);
    });
  }

  // Pointer events cover mouse, touch and pen (tooltips work on phones).
  const onMove = (e) => { const rect = canvas.getBoundingClientRect(); draw(e.clientX - rect.left); };
  const onLeave = () => draw(null);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointercancel', onLeave);
  canvas._hoverCleanup = () => {
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerdown', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('pointercancel', onLeave);
  };

  draw(null);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Simple vertical bar chart. bars: [{label, value, color?}] */
export function barChart(canvas, bars, opts = {}) {
  const height = opts.height || 160;
  const { ctx, w, h } = setupCanvas(canvas, height);
  const C = palette(opts);
  ctx.clearRect(0, 0, w, h);
  const padL = 40, padR = 12, padT = 12, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (!bars.length) { ctx.fillStyle = C.text; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('No data', w / 2, h / 2); return; }

  const maxV = Math.max(...bars.map((b) => b.value), opts.yMax || 0) || 1;
  ctx.strokeStyle = C.axis; ctx.fillStyle = C.text; ctx.font = '11px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = (i / 3) * maxV, py = padT + plotH - (v / maxV) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
    ctx.fillText(v.toFixed(maxV < 10 ? 1 : 0), padL - 6, py);
  }
  const bw = plotW / bars.length;
  bars.forEach((b, i) => {
    const bh = (b.value / maxV) * plotH;
    const bx = padL + i * bw + bw * 0.18, by = padT + plotH - bh, barW = bw * 0.64;
    ctx.fillStyle = b.color || C.line;
    roundRect(ctx, bx, by, barW, Math.max(bh, 1), 4); ctx.fill();
    ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(b.label, bx + barW / 2, h - 10);
  });
}

const SLEEP_COLORS = { deep: '#6366f1', light: '#38bdf8', REM: '#a855f7', awake: '#f59e0b', unknown: '#475569' };
const SLEEP_LEVEL = { awake: 3, REM: 2, light: 1, deep: 0 };
export { SLEEP_COLORS };

/** Hypnogram from a sleep block's stages array. */
export function hypnogram(canvas, stages, opts = {}) {
  const height = opts.height || 140;
  const { ctx, w, h } = setupCanvas(canvas, height);
  const C = palette(opts);
  ctx.clearRect(0, 0, w, h);
  const padL = 50, padR = 12, padT = 10, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  if (!stages || !stages.length) { ctx.fillStyle = C.text; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('No sleep data', w / 2, h / 2); return; }

  const levels = ['awake', 'REM', 'light', 'deep'];
  ctx.font = '11px system-ui'; ctx.fillStyle = C.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  levels.forEach((lvl) => {
    const py = padT + (SLEEP_LEVEL[lvl] / 3) * plotH;
    ctx.fillText(lvl, padL - 6, py);
    ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
  });

  const barW = plotW / stages.length;
  stages.forEach((s, i) => {
    const lvl = SLEEP_LEVEL[s.stage] ?? 0;
    const py = padT + (lvl / 3) * plotH;
    ctx.fillStyle = SLEEP_COLORS[s.stage] || SLEEP_COLORS.unknown;
    ctx.fillRect(padL + i * barW, py - 6, Math.max(barW, 1), 12);
  });

  ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${stages.length} min`, padL, h - 6);
}
