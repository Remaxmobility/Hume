// profile.js — personal attributes + derived reference values.
// Stored locally (on this device only); used to make the band's numbers
// meaningful (max HR, training zones, BMI, BMR).

const KEY = 'hume-profile';

export function loadProfile() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// Karvonen training zones as fractions of heart-rate reserve.
const ZONE_DEFS = [
  { name: 'Z1 Warm up', lo: 0.50, hi: 0.60, color: '#64748b' },
  { name: 'Z2 Fat burn', lo: 0.60, hi: 0.70, color: '#22c55e' },
  { name: 'Z3 Aerobic', lo: 0.70, hi: 0.80, color: '#f59e0b' },
  { name: 'Z4 Anaerobic', lo: 0.80, hi: 0.90, color: '#f87171' },
  { name: 'Z5 Maximum', lo: 0.90, hi: 1.00, color: '#ef4444' },
];

/** Max HR — Tanaka (208 − 0.7·age), or Gulati (206 − 0.88·age) for women. */
export function hrMax(age, sex) {
  if (!age) return null;
  if (sex === 'female') return Math.round(206 - 0.88 * age);
  return Math.round(208 - 0.7 * age);
}

export function bmiOf(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  const v = weightKg / (m * m);
  const category = v < 18.5 ? 'Underweight' : v < 25 ? 'Healthy' : v < 30 ? 'Overweight' : 'Obese';
  return { value: +v.toFixed(1), category };
}

/** Basal metabolic rate — Mifflin-St Jeor. */
export function bmrOf(weightKg, heightCm, age, sex) {
  if (!weightKg || !heightCm || !age) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  const c = sex === 'female' ? -161 : sex === 'male' ? 5 : -78;
  return Math.round(base + c);
}

/** Karvonen zones from max HR and measured resting HR. */
export function trainingZones(maxHr, restingHr) {
  if (!maxHr) return null;
  const rest = restingHr || 60;
  const hrr = maxHr - rest;
  return ZONE_DEFS.map((z) => ({
    name: z.name, color: z.color,
    min: Math.round(rest + z.lo * hrr),
    max: Math.round(rest + z.hi * hrr),
  }));
}

/** Everything derived from a profile + the user's measured resting HR. */
export function derive(p, restingHr) {
  const age = +p.age || 0;
  const height = +p.height || 0;
  const weight = +p.weight || 0;
  const sex = p.sex || '';
  const out = { age, sex, height, weight, hasAny: !!(age || height || weight || sex) };
  out.hrMax = hrMax(age, sex);
  out.bmi = bmiOf(weight, height);
  out.bmr = bmrOf(weight, height, age, sex);
  if (out.hrMax) {
    out.restingUsed = restingHr || 60;
    out.zones = trainingZones(out.hrMax, out.restingUsed);
  }
  return out;
}
