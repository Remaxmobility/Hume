// ble.js — Web Bluetooth connection manager for the J2208 band.
//
// Exposes a tiny event emitter plus request/response helpers over the
// fff0/fff6/fff7 GATT profile.

import { GATT, buildCommand, toHex } from './protocol.js';

export class BleManager extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this._listeners = new Map(); // simple on/off wrappers over CustomEvent
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  on(type, cb) {
    const wrapped = (e) => cb(e.detail);
    this._listeners.set(cb, wrapped);
    this.addEventListener(type, wrapped);
  }

  off(type, cb) {
    const wrapped = this._listeners.get(cb);
    if (wrapped) this.removeEventListener(type, wrapped);
    this._listeners.delete(cb);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect() {
    if (!BleManager.supported) throw new Error('Web Bluetooth is not available in this browser.');

    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'Hume' },
        { namePrefix: 'Dara' },
        { namePrefix: 'FitTrack' },
        { services: [GATT.SERVICE] },
      ],
      optionalServices: [GATT.SERVICE],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this._emit('disconnect', { device: this.device?.name });
    });

    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(GATT.SERVICE);
    this.writeChar = await this.service.getCharacteristic(GATT.WRITE);
    this.notifyChar = await this.service.getCharacteristic(GATT.NOTIFY);

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      this._emit('log', { dir: 'rx', bytes });
      this._emit('notify', bytes);
    });

    this.connected = true;
    this._emit('connect', { device: this.device.name });
    return { name: this.device.name };
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.connected = false;
  }

  async sendRaw(bytes) {
    if (!this.writeChar) throw new Error('not connected');
    this._emit('log', { dir: 'tx', bytes });
    // fff6 supports write-without-response; fall back to write.
    if (this.writeChar.properties.writeWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(bytes);
    } else {
      await this.writeChar.writeValue(bytes);
    }
  }

  /**
   * Send a command and resolve with the first notification carrying `opcode`
   * in byte[0]. Rejects on timeout.
   */
  request(opcode, args = [], { timeout = 4000, frame = null } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const onNotify = (bytes) => {
        if (bytes[0] !== opcode) return;
        cleanup();
        resolve(bytes);
      };
      const cleanup = () => {
        this.off('notify', onNotify);
        if (timer) clearTimeout(timer);
      };
      this.on('notify', onNotify);
      timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for 0x${opcode.toString(16)}`)); }, timeout);
      this.sendRaw(frame || buildCommand(opcode, args)).catch((e) => { cleanup(); reject(e); });
    });
  }
}

export { toHex };
