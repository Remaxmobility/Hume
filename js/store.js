// store.js — local persistence for downloaded history (IndexedDB).
//
// The band only keeps ~4–5 days before overwriting. Each sync is merged into
// a local store keyed by type + record timestamp, so repeated syncs accumulate
// into long-term history. Everything stays in the browser; nothing is uploaded.
//
// All methods degrade gracefully: if IndexedDB is unavailable (private mode,
// blocked storage), they resolve to empty/no-op and the app falls back to
// in-session data.

const DB_NAME = 'hume-history';
const DB_VER = 1;
const STORE = 'records';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

const keyOf = (type, rec) => `${type}|${rec.time instanceof Date ? rec.time.getTime() : rec.time}`;

/** Merge records for a type. Returns the number of newly-added records. */
export async function putRecords(type, records) {
  if (!records || !records.length) return 0;
  let db;
  try { db = await openDB(); } catch { return 0; }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    let added = 0, pending = 0, done = false;
    const finish = () => { if (done) return; done = true; resolve(added); };
    for (const rec of records) {
      const id = keyOf(type, rec);
      pending++;
      const getReq = os.get(id);
      getReq.onsuccess = () => {
        if (!getReq.result) { added++; os.put({ id, type, t: rec.time instanceof Date ? rec.time.getTime() : rec.time, rec }); }
        if (--pending === 0 && tx.readyState) { /* let oncomplete handle */ }
      };
      getReq.onerror = () => { pending--; };
    }
    tx.oncomplete = finish;
    tx.onerror = finish;
    tx.onabort = finish;
  });
}

/** All stored records for a type, time-ascending (time rehydrated to Date). */
export async function getRecords(type) {
  let db;
  try { db = await openDB(); } catch { return []; }
  return new Promise((resolve) => {
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('type');
    const req = idx.openCursor(IDBKeyRange.only(type));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const r = cur.value.rec;
        if (r && r.time != null && !(r.time instanceof Date)) r.time = new Date(r.time);
        out.push(r);
        cur.continue();
      } else {
        out.sort((a, b) => (a.time?.getTime?.() || 0) - (b.time?.getTime?.() || 0));
        resolve(out);
      }
    };
    req.onerror = () => resolve(out);
  });
}

/** { type: {count, from, to} } summary across all stored types. */
export async function summary() {
  let db;
  try { db = await openDB(); } catch { return {}; }
  return new Promise((resolve) => {
    const acc = {};
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const { type, t } = cur.value;
        const a = acc[type] || (acc[type] = { count: 0, from: t, to: t });
        a.count++; if (t < a.from) a.from = t; if (t > a.to) a.to = t;
        cur.continue();
      } else resolve(acc);
    };
    req.onerror = () => resolve(acc);
  });
}

export async function clearAll() {
  let db;
  try { db = await openDB(); } catch { return; }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function available() {
  return typeof indexedDB !== 'undefined';
}
