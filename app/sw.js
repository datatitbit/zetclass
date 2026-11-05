/* ============================================================
 * sw.js â€” service worker for Zetclass (hand-rolled, no libraries)
 * Makes the app installable + usable offline:
 *   - Navigation: network-first (always get the latest code when online),
 *     fall back to the cached page when offline.
 *   - Static assets (js/css/icons): stale-while-revalidate
 *     (load instantly from cache, refresh in the background).
 * Bump CACHE_VERSION whenever you bump the ?v=YYYYMMDD in index.html
 * so old caches are cleared and users pick up the new build.
 * ============================================================ */
'use strict';

var CACHE_VERSION = 'v20261120';
var CACHE_NAME = 'zetclass-' + CACHE_VERSION;

// Minimum shell needed to boot offline. Everything else is cached
// automatically the first time the app is opened online.
var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) { return caches.delete(key); }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') { return; }

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; } // leave cross-origin requests alone

  // NEVER cache the API. Its answers are private, per-school and change often
  // (student records, subscription status, trial days). Caching them would show
  // one school's data to the next person on a shared computer and let an ended
  // trial still look active. The browser handles /api/ requests directly.
  if (url.pathname.indexOf('/api/') === 0) { return; }

  // App navigation: try the network first so an online user always gets the
  // latest code; fall back to the cached page when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html', { ignoreSearch: true });
      })
    );
    return;
  }

  // Static assets: serve from cache immediately, update in the background.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
