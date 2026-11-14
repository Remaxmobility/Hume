// sw.js — offline app shell. Stale-while-revalidate so new deploys propagate
// (network-first for navigations keeps index.html fresh), with offline fallback.

const CACHE = 'hume-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/ble.js',
  './js/protocol.js',
  './js/history.js',
  './js/store.js',
  './js/insights.js',
  './js/report.js',
  './js/profile.js',
  './js/charts.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't intercept cross-origin

  // Navigations: network-first so a new deploy's index.html is picked up.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, net.clone()).catch(() => {});
        return net;
      } catch (_) {
        return (await caches.match(req)) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  // Everything else: stale-while-revalidate.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fetching = fetch(req).then((net) => {
      if (net && net.ok) { caches.open(CACHE).then((c) => c.put(req, net.clone())).catch(() => {}); }
      return net;
    }).catch(() => null);
    return cached || (await fetching) || new Response('', { status: 504 });
  })());
});
