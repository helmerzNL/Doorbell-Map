// Service worker: app-shell + kaartgegevens + kaarttegels offline beschikbaar.
const VERSION = 'v1';
const SHELL = `sm-shell-${VERSION}`;
const DATA = `sm-data-${VERSION}`;
const TILES = 'sm-tiles-v1'; // blijft bij nieuwe versies bestaan
const TILE_HOST = 'tile.openstreetmap.org';
const MAX_TILES = 1500;

// Scripts en stijlen worden met ?v=<build> opgevraagd (cache-busting); hier staan de paden zonder versie.
const VERSIONED = [
  '/css/style.css', '/css/ui.css', '/css/public.css', '/js/theme.js', '/js/icons.js', '/js/lang-core.js', '/js/lang-en.js', '/js/i18n.js', '/js/wijk.js', '/js/public.js', '/js/pwa.js', '/js/resident.js',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/jspdf.js',
];
const OTHER = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const PRECACHE = [...OTHER, ...VERSIONED.map((p) => `${p}?v=${VERSION}`)];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== DATA && k !== TILES) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

async function networkFirst(req, cacheName, ms = 4000, key = req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await withTimeout(fetch(req), ms);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  // Altijd met CORS ophalen: dan kan dezelfde respons zowel <img> als canvas (PDF) bedienen.
  const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
  if (res.ok) {
    await cache.put(req.url, res.clone());
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES + 200).map((k) => cache.delete(k)));
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === TILE_HOST) return e.respondWith(tile(req));
  if (url.origin !== self.location.origin) return;

  const p = url.pathname;
  if (p === '/api/map') return e.respondWith(networkFirst(req, DATA));
  if (p.startsWith('/uploads/')) return e.respondWith(cacheFirst(req, DATA));
  if (req.mode === 'navigate' && (p === '/' || p === '/index.html')) {
    return e.respondWith(networkFirst(req, SHELL, 3000, '/'));
  }
  if (VERSIONED.includes(p) || OTHER.includes(p) || p.startsWith('/vendor/leaflet/') || p.startsWith('/icons/')) {
    return e.respondWith(staleWhileRevalidate(req));
  }
  // beheer, auth en overige API's: altijd netwerk
});

// ---- pushmeldingen (voor de beheerder) ----
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : '' }; }
  // badge op het app-icoon (aantal wachtende wijzigingen en berichten), ook als de app dicht is
  const badge = typeof data.badge === 'number' && self.navigator.setAppBadge
    ? (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {})
    : null;
  if (badge) e.waitUntil(badge);
  e.waitUntil(self.registration.showNotification(data.title || 'Melding', {
    body: data.body || '',
    icon: '/icons/admin-192.png',
    badge: '/icons/admin-favicon-32.png',
    tag: data.tag || 'melding',
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname.startsWith(target.pathname)) {
        await c.focus();
        c.postMessage({ type: 'open-tab', hash: target.hash });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
