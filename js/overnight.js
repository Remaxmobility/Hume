// overnight.js — "Overnight mode": denser interval capture (with remember &
// restore) plus a NON-DIAGNOSTIC overview of the overnight signals the band
// records, and the STOP-BANG apnea-risk questionnaire.
//
// IMPORTANT: this is a wellness overview, not a medical test. The band cannot
// detect or rule out sleep apnea (SpO2 is sampled minutes apart at best; apnea
// events last seconds; raw PPG is unavailable). Framing must stay honest.

export const OVERNIGHT_METRICS = [1, 2, 3]; // HR, SpO2, temperature
export const FACTORY = { 1: 10, 2: 30, 3: 5, 4: 60 };
export const FINE_INTERVAL = 1; // minutes (the band's finest)

const PREV_KEY = 'hume-overnight';

export function savePrev(intervals) {
  try { localStorage.setItem(PREV_KEY, JSON.stringify({ intervals, at: Date.now() })); } catch { /* ignore */ }
}
export function loadPrev() {
  try { return JSON.parse(localStorage.getItem(PREV_KEY)); } catch { return null; }
}
export function clearPrev() {
  try { localStorage.removeItem(PREV_KEY); } catch { /* ignore */ }
}

/** Determine the overnight window: last sleep block if available, else ~20:00–10:00. */
export function overnightWindow(sleep, spo2) {
  if (sleep && sleep.length) {
    const n = [...sleep].sort((a, b) => a.time - b.time).pop();
    return { from: n.time, to: new Date(n.time.getTime() + n.stages.length * 60000), label: 'your last recorded sleep period' };
  }
  if (spo2 && spo2.length) {
    const last = spo2[spo2.length - 1].time;
    const nightEnd = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 10, 0, 0);
    const from = new Date(nightEnd.getTime() - 14 * 3600000);
    return { from, to: nightEnd, label: 'approximate overnight window (20:00–10:00)' };
  }
  return null;
}

/** SpO2 overview within the window. Non-diagnostic. */
export function analyzeSpo2(spo2, win) {
  if (!win) return null;
  const inWin = (spo2 || []).filter((r) => r.time >= win.from && r.time <= win.to && r.value > 0 && r.value <= 100);
  if (!inWin.length) return null;
  const vals = inWin.map((r) => r.value);
  const mean = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  const lowest = Math.min(...vals);
  const below90 = vals.filter((v) => v < 90).length;
  const below88 = vals.filter((v) => v < 88).length;
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const dips = vals.filter((v) => median - v >= 4).length;
  const gaps = [];
  for (let i = 1; i < inWin.length; i++) gaps.push((inWin[i].time - inWin[i - 1].time) / 60000);
  gaps.sort((a, b) => a - b);
  const gapMin = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;
  return {
    n: inWin.length, mean, lowest, below90, below88,
    below90pct: Math.round((below90 / vals.length) * 100), dips, gapMin,
    points: inWin.map((r) => ({ time: r.time, value: r.value })),
  };
}

/** HR overview within the window. */
export function hrSummary(hr, win) {
  if (!win) return null;
  const inWin = (hr || []).filter((r) => r.time >= win.from && r.time <= win.to && r.value > 0);
  if (!inWin.length) return null;
  const vals = inWin.map((r) => r.value);
  return {
    n: inWin.length,
    min: Math.min(...vals),
    mean: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
    max: Math.max(...vals),
    points: inWin.map((r) => ({ time: r.time, value: r.value })),
  };
}

export const STOPBANG_KEYS = ['snore', 'tired', 'observed', 'pressure', 'bmi', 'age', 'neck', 'male'];

/** STOP-BANG score (0–8) and risk band. Validated screening questionnaire. */
export function stopBang(answers) {
  const score = STOPBANG_KEYS.reduce((s, k) => s + (answers[k] ? 1 : 0), 0);
  const risk = score >= 5 ? 'High' : score >= 3 ? 'Intermediate' : 'Low';
  return { score, risk };
}
