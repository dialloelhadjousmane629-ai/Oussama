// Service worker de la caisse : permet l'installation comme application.
// Les données (/api) ne sont jamais mises en cache : on voit toujours les chiffres à jour.
const CACHE = 'famille-best-caisse-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/caisse/', '/caisse/manifest.webmanifest', '/caisse/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith('/caisse/')) return;
  e.respondWith(fetch(r).then(res => { if (res.ok && !res.redirected) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; }).catch(() => caches.match(r).then(m => m || (r.mode === 'navigate' ? caches.match('/caisse/') : undefined))));
});
