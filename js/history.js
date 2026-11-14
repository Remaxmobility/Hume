// history.js — history download state machine + record parsers.
//
// The band stores several days of data and streams it over notifications,
// pausing until prompted again. We send a START, collect notifications, and
// re-prompt with CONTINUE whenever the stream goes idle, until we see the
// end-of-data marker (`<opcode> 0xFF`).

import {
  OP, HIST_MODE, SLEEP_STAGE,
  cmdHistory, parseBcdTimestamp, parseBcdDate, u16le, u32le,
} from './protocol.js';

// Record definitions. `stride` is the fixed per-record length (incl. opcode,
// 2 header bytes and the 6-byte BCD timestamp at +3..+8). Payload starts at +9.
export const RECORD_TYPES = {
  totals: { opcode: OP.TOTALS, label: 'Daily totals', stride: 'variable', unit: '' },
  steps: { opcode: OP.STEPS, label: 'Steps', stride: 25, unit: 'steps' },
  sleep: { opcode: OP.SLEEP, label: 'Sleep', stride: 130, unit: '' },
  hr: { opcode: OP.HR, label: 'Heart rate', stride: 10, unit: 'bpm' },
  hrv: { opcode: OP.HRV, label: 'HRV', stride: 15, unit: 'ms' },
  spo2: { opcode: OP.SPO2, label: 'SpO₂', stride: 10, unit: '%' },
  temp: { opcode: OP.TEMP, label: 'Temperature', stride: 11, unit: '°C' },
};

// ---------- per-record parsers ----------
// Each receives one record slice (record[0] = opcode) and returns an object,
// or null if it can't be read.

function parseTimestamped(rec) {
  return parseBcdTimestamp(rec, 3);
}

const PARSERS = {
  [OP.STEPS]: (rec) => {
    const t = parseTimestamped(rec);
    if (!t) return null;
    return {
      time: t,
      steps: u16le(rec, 9),
      kcal: u16le(rec, 11) / 100,
      km: u16le(rec, 13) / 100,
    };
  },
  [OP.HR]: (rec) => {
    const t = parseTimestamped(rec);
    if (!t) return null;
    return { time: t, value: rec[9] };
  },
  [OP.SPO2]: (rec) => {
    const t = parseTimestamped(rec);
    if (!t) return null;
    return { time: t, value: rec[9] };
  },
  [OP.TEMP]: (rec) => {
    const t = parseTimestamped(rec);
    if (!t) return null;
    return { time: t, value: u16le(rec, 9) / 10 };
  },
  [OP.HRV]: (rec) => {
    const t = parseTimestamped(rec);
    if (!t) return null;
    return {
      time: t,
      hrv: rec[9],
      vascularAge: rec[10],
      hr: rec[11],
      stress: rec[12],
      systolic: rec[13],
      diastolic: rec[14],
      value: rec[9],
    };
  },
  [OP.SLEEP]: (rec) => {
    const t = parseTimestamped(rec);
    if (!t) return null;
    const count = rec[9];
    const stages = [];
    for (let i = 0; i < count && 10 + i < rec.length; i++) {
      stages.push({ code: rec[10 + i], stage: SLEEP_STAGE[rec[10 + i]] || 'unknown' });
    }
    return { time: t, count, stages };
  },
  [OP.TOTALS]: (rec) => {
    // date-only at +2..+4; stride 26 or 27 picked from the record length.
    const d = parseBcdDate(rec, 2);
    if (!d) return null;
    const stride = rec.length;
    const goal = stride >= 27 ? u16le(rec, 21) : rec[21];
    return {
      time: d,
      steps: u32le(rec, 5),
      exercise: u32le(rec, 9),
      km: u32le(rec, 13) / 100,
      kcal: u32le(rec, 17) / 100,
      goal,
      activeMinutes: u16le(rec, stride - 4),
    };
  },
};

/**
 * Split a notification packet into records and parse them.
 * Returns { records: [...], end: bool }.
 */
export function parsePacket(opcode, bytes) {
  // end-of-data: standalone 2-byte frame <opcode> 0xFF
  if (bytes.length === 2 && bytes[0] === opcode && bytes[1] === 0xff) {
    return { records: [], end: true };
  }

  const def = Object.values(RECORD_TYPES).find((d) => d.opcode === opcode);
  const records = [];
  let end = false;

  if (opcode === OP.TOTALS) {
    // 0x51 may append the end marker to the final data packet.
    let data = bytes;
    if (bytes.length > 2 && bytes[bytes.length - 2] === opcode && bytes[bytes.length - 1] === 0xff) {
      data = bytes.subarray(0, bytes.length - 2);
      end = true;
    }
    if (data.length >= 22) {
      const parsed = PARSERS[opcode](data);
      if (parsed) records.push(parsed);
    }
    return { records, end };
  }

  if (opcode === OP.SLEEP) {
    // One 130-byte block per record; a packet may carry one or more.
    const stride = 130;
    for (let off = 0; off + 10 <= bytes.length; off += stride) {
      const rec = bytes.subarray(off, Math.min(off + stride, bytes.length));
      if (rec[0] !== opcode) break;
      const parsed = PARSERS[opcode](rec);
      if (parsed) records.push(parsed);
    }
    return { records, end };
  }

  const stride = def ? def.stride : 0;
  if (!stride || typeof stride !== 'number') return { records, end };

  for (let off = 0; off + stride <= bytes.length; off += stride) {
    const rec = bytes.subarray(off, off + stride);
    if (rec[0] !== opcode) {
      // trailing end marker mixed into the packet
      if (rec[0] === opcode && rec[1] === 0xff) end = true;
      break;
    }
    const parser = PARSERS[opcode];
    const parsed = parser ? parser(rec) : null;
    if (parsed) records.push(parsed);
  }
  return { records, end };
}

/**
 * Download one record type. Resolves with an array of parsed records.
 *
 * @param ble       connected BleManager
 * @param typeKey   key of RECORD_TYPES
 * @param opts      { since?: Date, onProgress?: (n)=>void, idleMs?, timeoutMs? }
 */
export function downloadHistory(ble, typeKey, opts = {}) {
  const def = RECORD_TYPES[typeKey];
  if (!def) return Promise.reject(new Error(`unknown type ${typeKey}`));
  const opcode = def.opcode;
  const idleMs = opts.idleMs ?? 600;
  const timeoutMs = opts.timeoutMs ?? 60000;

  return new Promise((resolve, reject) => {
    const records = [];
    let finished = false;
    let idleTimer = null;
    let hardTimer = null;

    const cleanup = () => {
      ble.off('notify', onNotify);
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const done = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(records);
    };
    const scheduleContinue = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (finished) return;
        // Stream went quiet without an end marker: either prompt again, or
        // if we've received nothing at all, assume there's no data.
        if (records.length === 0) { done(); return; }
        ble.sendRaw(cmdHistory(opcode, HIST_MODE.CONTINUE, opts.since || null))
          .catch(() => {});
        scheduleContinue();
      }, idleMs);
    };

    const onNotify = (bytes) => {
      if (bytes[0] !== opcode) return;
      const { records: recs, end } = parsePacket(opcode, bytes);
      for (const r of recs) records.push(r);
      if (recs.length && opts.onProgress) opts.onProgress(records.length);
      if (end) { done(); return; }
      scheduleContinue();
    };

    ble.on('notify', onNotify);
    hardTimer = setTimeout(() => { done(); }, timeoutMs);

    ble.sendRaw(cmdHistory(opcode, HIST_MODE.START, opts.since || null))
      .then(() => scheduleContinue())
      .catch((e) => { cleanup(); reject(e); });
  });
}

// ---------- CSV export ----------

function fmtTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function recordsToCsv(typeKey, records) {
  const rows = [];
  if (typeKey === 'steps') {
    rows.push('time,steps,kcal,km');
    for (const r of records) rows.push(`${fmtTime(r.time)},${r.steps},${r.kcal},${r.km}`);
  } else if (typeKey === 'totals') {
    rows.push('date,steps,exercise,km,kcal,goal,active_minutes');
    for (const r of records) rows.push(`${fmtTime(r.time)},${r.steps},${r.exercise},${r.km},${r.kcal},${r.goal},${r.activeMinutes}`);
  } else if (typeKey === 'hrv') {
    rows.push('time,hrv,vascular_age,hr,stress,systolic,diastolic');
    for (const r of records) rows.push(`${fmtTime(r.time)},${r.hrv},${r.vascularAge},${r.hr},${r.stress},${r.systolic},${r.diastolic}`);
  } else if (typeKey === 'sleep') {
    rows.push('time,minute,stage');
    for (const r of records) {
      r.stages.forEach((s, i) => rows.push(`${fmtTime(r.time)},${i},${s.stage}`));
    }
  } else {
    rows.push('time,value');
    for (const r of records) rows.push(`${fmtTime(r.time)},${r.value}`);
  }
  return rows.join('\n');
}
