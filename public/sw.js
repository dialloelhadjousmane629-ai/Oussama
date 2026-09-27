// Garde une copie de la fiche pour l'ouvrir même sans connexion.
// Le réseau passe toujours en premier : une nouvelle version du site est prise dès qu'elle est en ligne.
var CACHE = 'carnet-dettes-v1';
var FICHIERS = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FICHIERS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (cles) {
    return Promise.all(cles.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && !res.redirected) {
      var copie = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copie); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (r) { return r || (req.mode === 'navigate' ? caches.match('./') : undefined); });
  }));
});
