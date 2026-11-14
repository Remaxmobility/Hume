// charts.js — tiny zero-dependency canvas charts (line + sleep hypnogram).

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
  axis: 'rgba(148,163,184,0.25)',
  text: 'rgba(148,163,184,0.9)',
  line: '#38bdf8',
  fill: 'rgba(56,189,248,0.12)',
  point: '#38bdf8',
};

function fmtDay(d) {
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Draw a line chart.
 * @param canvas
 * @param points [{time:Date, value:Number}]
 * @param opts { height, color, yMin, yMax, unit }
 */
export function lineChart(canvas, points, opts = {}) {
  const height = opts.height || 200;
  const { ctx, w, h } = setupCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  const padL = 44, padR = 12, padT = 12, padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (!points.length) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', w / 2, h / 2);
    return;
  }

  const xs = points.map((p) => (p.time instanceof Date ? p.time.getTime() : p.time));
  const ys = points.map((p) => p.value);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = opts.yMin ?? Math.min(...ys);
  let yMax = opts.yMax ?? Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.1;
  yMin -= yPad; yMax += yPad;

  const xToPx = (x) => padL + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const yToPx = (y) => padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  // grid + y labels
  ctx.strokeStyle = COLORS.axis;
  ctx.fillStyle = COLORS.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (i / ticks) * (yMax - yMin);
    const py = yToPx(v);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(w - padR, py);
    ctx.stroke();
    ctx.fillText(v.toFixed(v < 10 ? 1 : 0), padL - 6, py);
  }

  // x labels (first & last)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(fmtDay(new Date(xMin)), padL, h - 8);
  ctx.textAlign = 'right';
  ctx.fillText(fmtDay(new Date(xMax)), w - padR, h - 8);

  // area fill
  const color = opts.color || COLORS.line;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = xToPx(xs[i]), py = yToPx(p.value);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.lineTo(xToPx(xs[xs.length - 1]), padT + plotH);
  ctx.lineTo(xToPx(xs[0]), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = opts.fill || COLORS.fill;
  ctx.fill();

  // line
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = xToPx(xs[i]), py = yToPx(p.value);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

const SLEEP_COLORS = { deep: '#6366f1', light: '#38bdf8', REM: '#a855f7', awake: '#f59e0b', unknown: '#475569' };
const SLEEP_LEVEL = { awake: 3, REM: 2, light: 1, deep: 0 };

/** Draw a hypnogram from a sleep block's stages array. */
export function hypnogram(canvas, stages, opts = {}) {
  const height = opts.height || 140;
  const { ctx, w, h } = setupCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  const padL = 50, padR = 12, padT = 10, padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (!stages || !stages.length) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No sleep data', w / 2, h / 2);
    return;
  }

  const levels = ['awake', 'REM', 'light', 'deep'];
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  levels.forEach((lvl) => {
    const py = padT + (SLEEP_LEVEL[lvl] / 3) * plotH;
    ctx.fillText(lvl, padL - 6, py);
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(w - padR, py);
    ctx.stroke();
  });

  const barW = plotW / stages.length;
  stages.forEach((s, i) => {
    const lvl = SLEEP_LEVEL[s.stage] ?? 0;
    const py = padT + (lvl / 3) * plotH;
    ctx.fillStyle = SLEEP_COLORS[s.stage] || SLEEP_COLORS.unknown;
    ctx.fillRect(padL + i * barW, py - 6, Math.max(barW, 1), 12);
  });

  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${stages.length} min`, padL, h - 6);
}
