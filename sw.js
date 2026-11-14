/* Service Worker: Netz zuerst (neue Versionen greifen sofort), Zwischenspeicher nur als Ersatz ohne Netz. */
var CACHE = "haushalt-v1";
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== "GET") return;
  if (u.origin !== location.origin && u.hostname !== "cdn.jsdelivr.net") return;   // Supabase & Co. nie anfassen
  e.respondWith(fetch(r).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(r, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(r, { ignoreSearch: false }).then(function (m) { return m || caches.match(r, { ignoreSearch: true }); });
  }));
});
