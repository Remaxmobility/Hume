// insights.js — derived analytics from recorded history (pure functions).

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function byDay(records) {
  const m = new Map();
  for (const r of records) {
    if (!(r.time instanceof Date)) continue;
    const k = dayKey(r.time);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

/** Resting HR: per-day 10th-percentile of HR samples; overall = median of daily. */
export function restingHr(hrRecords) {
  const days = byDay(hrRecords);
  const daily = [];
  for (const [, recs] of days) {
    const vals = recs.map((r) => r.value).filter((v) => v > 30 && v < 220);
    const rest = percentile(vals, 10);
    if (rest != null) daily.push({ time: recs[0].time, value: rest });
  }
  daily.sort((a, b) => a.time - b.time);
  if (!daily.length) return null;
  const latest = daily[daily.length - 1].value;
  const avg = Math.round(daily.reduce((s, d) => s + d.value, 0) / daily.length);
  return { latest, avg, daily };
}

const ZONES = [
  { name: 'Rest', min: 0, max: 60, color: '#64748b' },
  { name: 'Fat burn', min: 60, max: 100, color: '#22c55e' },
  { name: 'Cardio', min: 100, max: 140, color: '#f59e0b' },
  { name: 'Peak', min: 140, max: 170, color: '#f87171' },
  { name: 'Max', min: 170, max: 999, color: '#ef4444' },
];

/** HR zone distribution across all HR samples. */
export function hrZones(hrRecords) {
  const vals = hrRecords.map((r) => r.value).filter((v) => v > 30 && v < 220);
  if (!vals.length) return null;
  const zones = ZONES.map((z) => ({ ...z, count: 0 }));
  for (const v of vals) {
    const z = zones.find((zz) => v >= zz.min && v < zz.max) || zones[zones.length - 1];
    z.count++;
  }
  const total = vals.length;
  return zones.map((z) => ({ name: z.name, color: z.color, count: z.count, pct: Math.round((z.count / total) * 100) }));
}

/** Composite 0–100 recovery score from resting HR, HRV and last night's sleep. */
export function recoveryScore({ resting, hrvRecords, sleepRecords }) {
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const parts = [];
  const detail = {};

  if (resting && resting.latest) {
    const s = clamp(((80 - resting.latest) / (80 - 45)) * 100);
    parts.push(s); detail.restingHr = resting.latest;
  }
  if (hrvRecords && hrvRecords.length) {
    const days = byDay(hrvRecords);
    const last = [...days.values()].pop();
    const avg = last.reduce((s, r) => s + (r.hrv || r.value || 0), 0) / last.length;
    if (avg > 0) { parts.push(clamp(((avg - 20) / (70 - 20)) * 100)); detail.hrv = Math.round(avg); }
  }
  if (sleepRecords && sleepRecords.length) {
    const n = [...sleepRecords].sort((a, b) => a.time - b.time).pop();
    const total = n.stages.length;
    const asleep = n.stages.filter((s) => s.stage !== 'awake').length;
    const eff = total ? (asleep / total) * 100 : 0;
    const durScore = clamp((asleep / 60 / 8) * 100);
    parts.push((eff + durScore) / 2);
    detail.sleepEff = Math.round(eff);
    detail.sleepH = +(asleep / 60).toFixed(1);
  }

  if (!parts.length) return null;
  const score = Math.round(parts.reduce((s, x) => s + x, 0) / parts.length);
  const label = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : 'Low';
  return { score, label, detail, basis: parts.length };
}

/** Steps dashboard from daily totals (preferred) or 10-min step records. */
export function stepsSummary(totals, steps, goal = 10000) {
  let perDay = [];
  if (totals && totals.length) {
    perDay = totals.map((t) => ({ time: t.time, steps: t.steps, km: t.km, kcal: t.kcal }));
  } else if (steps && steps.length) {
    const days = byDay(steps);
    for (const [, recs] of days) {
      perDay.push({
        time: recs[0].time,
        steps: recs.reduce((s, r) => s + (r.steps || 0), 0),
        km: recs.reduce((s, r) => s + (r.km || 0), 0),
        kcal: recs.reduce((s, r) => s + (r.kcal || 0), 0),
      });
    }
  }
  perDay = perDay.filter((d) => d.steps > 0).sort((a, b) => a.time - b.time);
  if (!perDay.length) return null;

  const today = perDay[perDay.length - 1];
  const best = perDay.reduce((m, d) => (d.steps > m.steps ? d : m), perDay[0]);
  let streak = 0;
  for (let i = perDay.length - 1; i >= 0; i--) { if (perDay[i].steps >= goal) streak++; else break; }
  const last7 = perDay.slice(-7).map((d) => ({ label: `${d.time.getMonth() + 1}/${d.time.getDate()}`, value: d.steps }));

  return { today, goal, best, streak, last7, days: perDay.length };
}
