// protocol.js — J2208-family band BLE protocol
// Framing, opcodes, encoders and decoders.
//
// Spec: https://github.com/brendangooden/j2208-band-tools/blob/main/PROTOCOL.md
// Verified against a Hume Band V2 (firmware v0.0.3.9).
//
// All command frames are exactly 16 bytes:
//   byte[0]      opcode
//   byte[1..14]  arguments (zero padded)
//   byte[15]     checksum = sum(byte[0..14]) & 0xFF
//
// Notifications reuse the request opcode in byte[0].
// byte[1] === 0xFF means the firmware rejected the command.

export const GATT = {
  SERVICE: 0xfff0,
  WRITE: 0xfff6,
  NOTIFY: 0xfff7,
};

// Opcodes from humeBandJ2208/constant/DeviceConst.java
export const OP = {
  SET_TIME: 0x01,
  DEVICE_INFO: 0x04,
  BATTERY: 0x13,
  MAC: 0x22,
  VERSION: 0x27,
  MEASURE: 0x28,
  SET_AUTO: 0x2a,
  GET_AUTO: 0x2b,
  DEVICE_NAME: 0x3e,
  TIME: 0x41,
  STEP_GOAL: 0x4b,
  STOP_MEASURE: 0x98,
  OPEN_ECG_PPG: 0x99,
  RAW_PPG: 0x3a,
  // History record / request opcodes
  TOTALS: 0x51,
  STEPS: 0x52,
  SLEEP: 0x53,
  HR: 0x55,
  HRV: 0x56,
  SPO2: 0x66,
  TEMP: 0x65,
};

// History download modes (byte[1] of the request)
export const HIST_MODE = { START: 0x00, CONTINUE: 0x02, DELETE: 0x99 };

// Measurement notification types (byte[1] of a 0x28 response)
export const MEASURE_TYPE = { 1: 'HRV', 2: 'Heart', 3: 'SpO2', 4: 'Temperature' };

// Sleep stage codes (derived, see PROTOCOL.md)
export const SLEEP_STAGE = { 1: 'deep', 2: 'light', 3: 'REM', 5: 'awake' };

// ---------- low level helpers ----------

export function checksum(bytes) {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) s = (s + bytes[i]) & 0xff;
  return s;
}

/** Build a 16-byte command frame with trailing checksum. */
export function buildCommand(opcode, args = []) {
  const frame = new Uint8Array(16);
  frame[0] = opcode & 0xff;
  for (let i = 0; i < args.length && i < 14; i++) frame[1 + i] = args[i] & 0xff;
  // checksum covers bytes 0..14
  let s = 0;
  for (let i = 0; i < 15; i++) s = (s + frame[i]) & 0xff;
  frame[15] = s;
  return frame;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function bcdEncode(n) {
  return (((Math.floor(n / 10) % 10) << 4) | (n % 10)) & 0xff;
}

export function bcdDecode(b) {
  return (b >> 4) * 10 + (b & 0x0f);
}

/** 6-byte BCD timestamp: yy mm dd HH MM SS (yy = year - 2000). */
export function bcdTimestamp(date) {
  return [
    bcdEncode(date.getFullYear() - 2000),
    bcdEncode(date.getMonth() + 1),
    bcdEncode(date.getDate()),
    bcdEncode(date.getHours()),
    bcdEncode(date.getMinutes()),
    bcdEncode(date.getSeconds()),
  ];
}

/** Parse a 6-byte BCD timestamp starting at `off`. Returns a Date or null. */
export function parseBcdTimestamp(bytes, off) {
  const yy = bcdDecode(bytes[off]);
  const mm = bcdDecode(bytes[off + 1]);
  const dd = bcdDecode(bytes[off + 2]);
  const HH = bcdDecode(bytes[off + 3]);
  const MM = bcdDecode(bytes[off + 4]);
  const SS = bcdDecode(bytes[off + 5]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return new Date(2000 + yy, mm - 1, dd, HH, MM, SS);
}

/** Parse a 3-byte BCD date (yy mm dd) — used by daily totals. */
export function parseBcdDate(bytes, off) {
  const yy = bcdDecode(bytes[off]);
  const mm = bcdDecode(bytes[off + 1]);
  const dd = bcdDecode(bytes[off + 2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return new Date(2000 + yy, mm - 1, dd);
}

export const u16le = (b, o) => b[o] | (b[o + 1] << 8);
export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// ---------- request builders ----------

export function cmdBattery() { return buildCommand(OP.BATTERY); }
export function cmdDeviceName() { return buildCommand(OP.DEVICE_NAME); }
export function cmdMac() { return buildCommand(OP.MAC); }
export function cmdVersion() { return buildCommand(OP.VERSION); }
export function cmdStepGoal() { return buildCommand(OP.STEP_GOAL); }
export function cmdDeviceInfo() { return buildCommand(OP.DEVICE_INFO); }
export function cmdTime() { return buildCommand(OP.TIME); }
export function cmdStopMeasure() { return buildCommand(OP.STOP_MEASURE); }

/** 0x28 measurement: [0x28, 1, start, openPPG, openPPI] */
export function cmdMeasure(start = 1, openPPG = 0, openPPI = 0) {
  return buildCommand(OP.MEASURE, [1, start ? 1 : 0, openPPG ? 1 : 0, openPPI ? 1 : 0]);
}

/** 0x2B read auto-logging for a metric (1=HR 2=SpO2 3=temp 4=HRV). */
export function cmdGetAuto(metric) { return buildCommand(OP.GET_AUTO, [metric]); }

/** 0x2A set auto-logging. Writes a full-day 00:00–23:59, all-days window. */
export function cmdSetAuto(metric, intervalMinutes, enabled = true) {
  // layout: enabled, start(HH MM BCD), end(HH MM BCD), weekday mask, interval u16 LE, metric
  return buildCommand(OP.SET_AUTO, [
    enabled ? 2 : 0,
    bcdEncode(0), bcdEncode(0), // window start 00:00
    bcdEncode(23), bcdEncode(59), // window end 23:59
    0xff, // every day
    intervalMinutes & 0xff, (intervalMinutes >> 8) & 0xff,
    metric,
  ]);
}

/** History request. mode START/CONTINUE/DELETE; since=null → everything. */
export function cmdHistory(opcode, mode = HIST_MODE.START, since = null) {
  const ts = since ? bcdTimestamp(since) : [0, 0, 0, 0, 0, 0];
  // [0]=opcode [1]=mode [2..3]=0 [4..9]=BCD yy mm dd HH MM SS
  return buildCommand(opcode, [mode, 0, 0, ...ts]);
}

// ---------- response decoders ----------

export function isRejected(b) { return b.length >= 2 && b[1] === 0xff; }

export function decodeBattery(b) { return { percent: b[1] }; }

export function decodeDeviceName(b) {
  let s = '';
  for (let i = 1; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
  return { name: s };
}

export function decodeMac(b) {
  const parts = [];
  for (let i = 1; i <= 6; i++) parts.push(b[i].toString(16).padStart(2, '0'));
  return { mac: parts.join(':').toUpperCase() };
}

export function decodeVersion(b) {
  const version = [b[1], b[2], b[3], b[4]].join('.');
  const build = parseBcdDate(b, 5);
  return {
    version,
    build: build ? `${build.getFullYear()}-${String(build.getMonth() + 1).padStart(2, '0')}-${String(build.getDate()).padStart(2, '0')}` : null,
  };
}

export function decodeStepGoal(b) { return { goal: u16le(b, 1) }; }

export function decodeTime(b) {
  const d = parseBcdTimestamp(b, 1);
  return { time: d };
}

export function decodeDeviceInfo(b) {
  // Fields beyond base HR are not fully documented; expose what the spec names.
  return { baseHr: b[9], raw: toHex(b) };
}

export function decodeMeasurement(b) {
  const temp = u16le(b, 8);
  return {
    type: b[1],
    typeName: MEASURE_TYPE[b[1]] || `#${b[1]}`,
    hr: b[2],
    spo2: b[3],
    hrv: b[4],
    stress: b[5],
    systolic: b[6],
    diastolic: b[7],
    tempC: temp ? temp / 10 : null,
  };
}

export function decodeAuto(b) {
  return {
    enabled: b[1] === 2,
    intervalMinutes: u16le(b, 7),
    metric: b[9],
    raw: toHex(b),
  };
}
