/* Service Worker: Netz zuerst (neue Versionen greifen sofort), Zwischenspeicher nur als Ersatz ohne Netz. */
var CACHE = "haushalt-v2";
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url), key = u.origin + u.pathname;   // ohne ?v=… → alte Versionen stapeln sich nicht
  if (r.method !== "GET") return;
  if (u.origin !== location.origin) return;   // Supabase & Co. nie anfassen
  e.respondWith(fetch(r).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(key);
  }));
});
