const CACHE = 'bellomind-shell-v3';
const CACHE_PREFIX = 'bellomind-';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  const shellPaths = new Set(SHELL);
  const isShellAsset = shellPaths.has(url.pathname);
  const isRefreshableShellAsset = ['/index.html', '/styles.css', '/app.js'].includes(url.pathname);
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (request.mode === 'navigate' || isRefreshableShellAsset) {
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return (await cache.match(request)) || (isRefreshableShellAsset ? (await cache.match(url.pathname)) : null) || (request.mode === 'navigate' ? (await cache.match('/index.html')) : null) || Response.error();
      }
    }
    if (!isShellAsset) return fetch(request);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  }));
});
