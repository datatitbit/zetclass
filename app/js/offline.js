/* ============================================================
 * offline.js — keeps Zetclass usable when the network is bad or off.
 *
 *   - READS: every school record the person views is also saved on this device
 *     (IndexedDB), so the same screens open with the last-known data offline.
 *   - WRITES: day-to-day work (pupil and staff details and new registrations, scores,
 *     attendance, fees and payments, stock, remarks...) made offline is saved on the device in
 *     a queue and shown straight away; when the network returns, store.js replays the queue in
 *     order (sync). New ID numbers come from a batch the device reserved beforehand, so two
 *     phones can never issue the same ID.
 *   - Only things that must be decided by the server (sign-in, login accounts, school settings,
 *     text messages, bulk import/reset) need the internet.
 *
 * Privacy: everything here belongs to ONE signed-in person (the "scope" = school +
 * user) and is wiped when they log out. It is only used when the browser says the
 * network failed; online, the server is always the source of truth.
 * ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'zetclass-offline', DB_VER = 2;
  var idb = null, idbFailed = false, scope = null;
  var listeners = [];
  var state = { offline: false, offlineSince: 0, pending: 0, syncing: false, lastSynced: 0, failed: 0 };

  function snapshot() {
    return { offline: state.offline, pending: state.pending, syncing: state.syncing, failed: state.failed, lastSynced: state.lastSynced };
  }
  function emit() { listeners.slice().forEach(function (f) { try { f(snapshot()); } catch (e) { /* a listener must never break syncing */ } }); }

  function open() {
    if (idb) return Promise.resolve(idb);
    if (idbFailed || !global.indexedDB) return Promise.reject(new Error('Offline storage is not available'));
    return new Promise(function (resolve, reject) {
      var r;
      try { r = global.indexedDB.open(DB_NAME, DB_VER); } catch (e) { idbFailed = true; return reject(e); }
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'n', autoIncrement: true });
        if (!d.objectStoreNames.contains('blocks')) d.createObjectStore('blocks', { keyPath: 'k' });
      };
      r.onsuccess = function () { idb = r.result; resolve(idb); };
      r.onerror = function () { idbFailed = true; reject(r.error); };
      r.onblocked = function () { /* another tab is upgrading: try again on the next call */ };
    });
  }
  function wrap(r) { return new Promise(function (resolve, reject) { r.onsuccess = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; }); }
  function os(name, mode) { return open().then(function (d) { return d.transaction(name, mode).objectStore(name); }); }
  function key(path) { return scope + '|' + path; }

  function enabled() { return !!scope && !idbFailed && !!global.indexedDB; }

  function refreshPending() {
    if (!enabled()) { state.pending = 0; emit(); return Promise.resolve(0); }
    return queueAll().then(function (items) { state.pending = items.length; emit(); return items.length; }, function () { return 0; });
  }
  function setScope(s) { scope = s || null; state.failed = 0; return scope ? refreshPending() : (state.pending = 0, emit(), Promise.resolve(0)); }

  // ---- cache ----
  function putCache(path, data) {
    if (!enabled()) return Promise.resolve();
    return os('cache', 'readwrite').then(function (s) { return wrap(s.put({ k: key(path), d: data, t: Date.now() })); }).catch(function () { /* full or blocked: the app still works online */ });
  }
  function getCache(path) {
    if (!enabled()) return Promise.resolve({ found: false });
    return os('cache', 'readonly').then(function (s) { return wrap(s.get(key(path))); }).then(function (r) { return r ? { found: true, data: r.d, savedAt: r.t } : { found: false }; }, function () { return { found: false }; });
  }

  // Applies a write to the saved copy so the screens show it straight away (also used after an online write,
  // so the saved copy never lags behind). head = collection name, arg = record id.
  function applyLocal(method, head, arg, body, result) {
    if (!enabled()) return Promise.resolve(null);
    var merged = null;
    return getCache(head).then(function (hit) {
      var list = (hit.found && Array.isArray(hit.data)) ? hit.data.slice() : null;
      var id = method === 'POST' ? ((result && result.id) || (body && body.id)) : arg;
      var idx = -1;
      if (list) for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === id) { idx = i; break; } }
      if (method === 'POST') {
        merged = Object.assign({}, body || {}, result || {});
        if (list) { if (idx >= 0) list[idx] = merged; else list.push(merged); }
      } else if (method === 'PUT') {
        var base = idx >= 0 ? list[idx] : null;
        merged = Object.assign({}, base || {}, body || {});
        if (list && idx >= 0) list[idx] = merged;
      } else if (method === 'DELETE') {
        if (list && idx >= 0) list.splice(idx, 1);
      }
      var jobs = [];
      if (list) jobs.push(putCache(head, list));
      if (id) { jobs.push(method === 'DELETE' ? deleteCache(head + '/' + id) : putCache(head + '/' + id, merged)); }
      return Promise.all(jobs).then(function () { return merged; });
    });
  }
  function deleteCache(path) {
    if (!enabled()) return Promise.resolve();
    return os('cache', 'readwrite').then(function (s) { return wrap(s.delete(key(path))); }).catch(function () {});
  }

  // ---- the queue of changes made offline ----
  function enqueue(entry) {
    entry.scope = scope; entry.ts = Date.now();
    return os('queue', 'readwrite').then(function (s) { return wrap(s.add(entry)); }).then(function () { state.pending++; emit(); });
  }
  function queueAll() {
    return os('queue', 'readonly').then(function (s) { return wrap(s.getAll()); }).then(function (all) {
      return (all || []).filter(function (e) { return e.scope === scope; }).sort(function (a, b) { return a.n - b.n; });
    });
  }
  function dequeue(n) {
    return os('queue', 'readwrite').then(function (s) { return wrap(s.delete(n)); }).then(function () { if (state.pending > 0) state.pending--; emit(); });
  }
  // Wipes everything saved for this device (log out). Returns when done.
  function clearAll() {
    state.pending = 0; state.failed = 0; state.offline = false; scope = null;
    return open().then(function (d) {
      return new Promise(function (resolve) {
        var tx = d.transaction(['cache', 'queue', 'blocks'], 'readwrite');
        tx.objectStore('cache').clear(); tx.objectStore('queue').clear(); tx.objectStore('blocks').clear();
        tx.oncomplete = tx.onerror = tx.onabort = function () { emit(); resolve(); };
      });
    }).catch(function () { emit(); });
  }

  // ---- batches of ID numbers (student / staff / stock-transaction numbers) ----
  // The server issues these one at a time. So a device can keep working offline, it reserves a small batch
  // beforehand (nobody else can be given those numbers) and uses them in order. Unused numbers are handed back
  // when the person logs out online, so a single device leaves no gaps.
  function blockGet(kind) {
    return os('blocks', 'readonly').then(function (s) { return wrap(s.get(scope + '|' + kind)); }).then(function (r) { return r || { k: scope + '|' + kind, ranges: [] }; }, function () { return { k: scope + '|' + kind, ranges: [] }; });
  }
  function blockPut(rec) { return os('blocks', 'readwrite').then(function (s) { return wrap(s.put(rec)); }); }
  function blockLeft(kind) {
    if (!enabled()) return Promise.resolve(0);
    return blockGet(kind).then(function (r) { return r.ranges.reduce(function (n, g) { return n + (g.to - g.from + 1); }, 0); });
  }
  function blockAdd(kind, first, last) {
    if (!enabled()) return Promise.resolve();
    return blockGet(kind).then(function (r) { r.ranges.push({ from: first, to: last }); return blockPut(r); }).catch(function () {});
  }
  // The next number from this device's batch, or null when the batch is used up.
  function takeNumber(kind) {
    if (!enabled()) return Promise.resolve(null);
    return blockGet(kind).then(function (r) {
      while (r.ranges.length && r.ranges[0].from > r.ranges[0].to) r.ranges.shift();
      if (!r.ranges.length) return null;
      var n = r.ranges[0].from++;
      if (r.ranges[0].from > r.ranges[0].to) r.ranges.shift();
      return blockPut(r).then(function () { return n; });
    }).catch(function () { return null; });
  }
  function blockRanges(kind) { return blockGet(kind).then(function (r) { return r.ranges.filter(function (g) { return g.from <= g.to; }); }); }
  function blockClear(kind) { if (!enabled()) return Promise.resolve(); return blockPut({ k: scope + '|' + kind, ranges: [] }).catch(function () {}); }

  // ---- status ----
  function setOffline(v) {
    v = !!v;
    if (state.offline === v) return;
    state.offline = v; state.offlineSince = v ? Date.now() : 0; emit();
  }
  // True when we already know the network is down, so a request should not wait for a timeout.
  function shouldSkipNetwork() {
    if (global.navigator && global.navigator.onLine === false) return true;
    return state.offline && (Date.now() - state.offlineSince) < 20000;
  }
  function setSyncing(v) { state.syncing = !!v; emit(); }
  function noteSynced(done, failed) { if (done) state.lastSynced = Date.now(); state.failed = failed || 0; emit(); }

  global.Offline = {
    enabled: enabled, setScope: setScope, getScope: function () { return scope; },
    putCache: putCache, getCache: getCache, applyLocal: applyLocal,
    enqueue: enqueue, queueAll: queueAll, dequeue: dequeue, clearAll: clearAll, refreshPending: refreshPending,
    setOffline: setOffline, isOffline: function () { return state.offline; }, shouldSkipNetwork: shouldSkipNetwork,
    setSyncing: setSyncing, noteSynced: noteSynced, pending: function () { return state.pending; },
    blockLeft: blockLeft, blockAdd: blockAdd, takeNumber: takeNumber, blockRanges: blockRanges, blockClear: blockClear,
    state: snapshot, onChange: function (fn) { listeners.push(fn); }
  };
})(window);
