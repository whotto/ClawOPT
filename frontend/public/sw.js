// ClawOPT - Service Worker
// Strategy:
//   - HTML (navigation): always network-first, never cache → prevents stale index.html white screen
//   - /assets/* (hashed JS/CSS): cache-first → fast load after first visit
//   - Everything else: network-first

// 缓存版本由构建时注入（scripts/write-build-meta.mjs 或 vite define）
// 写死版本号会导致旧 SW 永远赖着不更新——这是"改了没生效"的常见根因
// 构建戳从注册 URL 的 ?v= 取（public/ 下的文件不经 vite 变量替换）
const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'dev';
const ASSET_CACHE = `clawopt-assets-${BUILD_ID}`;

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
