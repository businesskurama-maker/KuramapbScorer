/* Kurama Pickleball Scorer service worker: app shell offline, CDN libs + fonts cached on first use. */
const VERSION = 'aopb-v8';
const SHELL = [
  './', './index.html', './display.html', './remote.html',
  './admin.html', './css/app.css', './js/config.js', './js/auth.js', './js/admin.js', './js/common.js', './js/engine.js', './js/link.js', './js/display.js', './js/remote.js',
  './manifest.webmanifest',
  './icons/kurama-mark.png', './icons/icon-192.png', './icons/icon-512.png'
];
const RUNTIME_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin: network first (so updates land), fall back to cache offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Libraries & fonts: cache first.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
  // Everything else (PeerJS signalling) goes straight to the network.
});
