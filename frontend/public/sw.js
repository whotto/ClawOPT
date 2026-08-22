// ClawOPT - Service Worker
// Strategy:
//   - HTML (navigation): always network-first, never cache → prevents stale index.html white screen
//   - /assets/* (hashed JS/CSS): cache-first → fast load after first visit
//   - Everything else: network-first

const ASSET_CACHE = 'clawopt-assets-v2';

// On install: skip waiting so new SW takes effect immediately
self.addEventListener('install', () => {
  self.skipWaiting();
});

// On activate: clean up ALL old caches (including the broken cache-first v1 cache)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // HTML navigation: always go to network (never serve stale HTML from cache)
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() => caches.match(request))
    );
    return;
  }

  // Hashed assets (/assets/*): cache-first (safe because filename changes with content)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            caches.open(ASSET_CACHE).then(cache => cache.put(request, response.clone()));
          }
          return response;
        });
      })
    );
    return;
  }

  // Default: network-first
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
