/* Kurama Pickleball Scorer service worker: app shell offline, CDN libs + fonts cached on first use. */
const VERSION = 'aopb-v59';
const SHELL = [
  './', './index.html', './display.html', './remote.html',
  './admin.html', './live.html', './obs.html', './js/live.js', './js/strip.js', './css/live.css', './css/strip.css', './owner/', './owner/index.html', './css/app.css', './js/config.js', './js/auth.js', './js/admin.js', './js/common.js', './js/engine.js', './js/link.js', './js/display.js', './js/remote.js',
  './manifest.webmanifest', './owner/manifest.webmanifest', './icons/admin-192.png', './icons/admin-512.png', './privacy.html', './terms.html',
  './icons/kurama-mark.png', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.png', './icons/instapay-qr.png', './icons/dinkykong-logo.png', './icons/dk-anim.webm', './icons/dk-anim.webp'
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
        if (res.ok && res.status !== 206) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
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

// Owner donation alerts: show a notification and put the pending count on the app icon.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'New donation', body: e.data ? e.data.text() : '' }; }
  const tasks = [self.registration.showNotification(d.title || 'New donation', {
    body: d.body || 'A player sent a donation reference. Tap to check and approve.',
    icon: 'icons/admin-192.png', badge: 'icons/admin-192.png',
    tag: d.tag || 'donation', renotify: true, requireInteraction: true, vibrate: [120, 60, 120],
    data: { url: d.url || '/owner/' }
  })];
  if (self.navigator && 'setAppBadge' in self.navigator) tasks.push(self.navigator.setAppBadge(d.count || 1).catch(() => {}));
  tasks.push(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ t: 'donation', d }))));
  e.waitUntil(Promise.all(tasks));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/owner/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((w) => w.url.includes('/owner'));
    if (c) { c.focus(); return c.navigate ? c.navigate(url).catch(() => {}) : null; }
    return self.clients.openWindow(url);
  }));
});
