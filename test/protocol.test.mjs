// Protocol decoder tests — run with: node test/protocol.test.mjs
// Checks the encode/decode layer against the example frames in PROTOCOL.md.

import {
  buildCommand, checksum, bcdEncode, bcdDecode,
  decodeVersion, decodeMeasurement, decodeTime, cmdHistory, OP,
} from '../js/protocol.js';
import { parsePacket } from '../js/history.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓', name); }
  else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const hx = (s) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

// framing + checksum
const c = buildCommand(0x28, [1, 1, 0, 0]);
eq('frame length 16', c.length, 16);
eq('checksum covers bytes 0..14', c[15], (0x28 + 1 + 1) & 0xff);

// BCD roundtrip
eq('bcd roundtrip 47', bcdDecode(bcdEncode(47)), 47);
eq('bcd encode 26 -> 0x26', bcdEncode(26).toString(16), '26');

// 0x27 version example: v0.0.3.9, build 2026-07-07
eq('version decode',
  decodeVersion(hx('27 00 00 03 09 26 07 07 00 00 19 06 06 00 09 95')),
  { version: '0.0.3.9', build: '2026-07-07' });

// 0x28 measurement example (off-wrist): HR 0, temp 35.7
const mf = hx('28 01 00 00 00 00 00 00 65 01 00 00 00 00 00 8f');
eq('measurement off-wrist',
  decodeMeasurement(mf),
  { type: 1, typeName: 'HRV', hr: 0, spo2: 0, hrv: 0, stress: 0, systolic: 0, diastolic: 0, tempC: 35.7 });
eq('measurement frame checksum valid', mf[15], checksum(mf.subarray(0, 15)));

// 0x41 device time (BCD) 2026-07-27 12:24:47
const t = decodeTime(hx('41 26 07 27 12 24 47 01 f4 00 00 00 00 00 00 00')).time;
eq('time decode',
  [t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()],
  [2026, 7, 27, 12, 24, 47]);

// history request: all-zero date = everything
const hreq = cmdHistory(OP.HR, 0, null);
eq('history request opcode/mode', [hreq[0], hreq[1]], [0x55, 0x00]);
eq('history request zero date', Array.from(hreq.subarray(4, 10)), [0, 0, 0, 0, 0, 0]);

// packet parsing
eq('end-of-data marker', parsePacket(0x55, hx('55 ff')), { records: [], end: true });

const pr = parsePacket(0x55, hx('55 00 00 26 07 27 15 00 00 48'));
eq('HR record count', pr.records.length, 1);
eq('HR record value', pr.records[0].value, 0x48);

eq('two HR records in one packet',
  parsePacket(0x55, hx('55 00 00 26 07 27 15 00 00 48 55 00 00 26 07 27 15 10 00 4b')).records.map((r) => r.value),
  [0x48, 0x4b]);

eq('temperature x0.1 degC',
  parsePacket(0x65, hx('65 00 00 26 07 27 15 00 00 65 01')).records[0].value,
  35.7);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
