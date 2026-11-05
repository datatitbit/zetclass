/* ============================================================
 * store.js — Clean swappable data-access layer.
 * Screens ONLY ever call DB.* — never localStorage or fetch directly.
 * Two adapters implement the same async interface:
 *   - LocalAdapter : browser localStorage (default; runs with no server)
 *   - ApiAdapter   : PHP/MySQL REST API (set DB_CONFIG.useApi = true)
 * Swapping backend = flip one flag. No screen changes.
 * ============================================================ */
(function (global) {
  'use strict';

  var DB_CONFIG = global.DB_CONFIG || { useApi: false, apiBase: 'api/index.php' };

  // Collections that are single objects (one per school) vs arrays.
  var SINGLETONS = ['school', 'academic', 'idRules', 'admissionFields', 'weighting', 'labels', 'payrollSettings', 'automation', 'inventorySettings', 'dashboardSettings', 'demoSettings'];
  var SPECIAL = ['reportTemplates', 'permissions']; // arrays/objects handled normally

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(p) { return (p || 'id') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------------- LocalAdapter ---------------- */
  function LocalAdapter() {
    this.key = 'sms_db_v2';
  }
  LocalAdapter.prototype._read = function () {
    var raw = localStorage.getItem(this.key);
    if (!raw) { this._write(clone(global.SMS_SEED)); raw = localStorage.getItem(this.key); }
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('sms_db_v2 was corrupted; restoring Ghana defaults.', e);
      this._write(clone(global.SMS_SEED));
      return JSON.parse(localStorage.getItem(this.key));
    }
  };
  LocalAdapter.prototype._write = function (data) {
    try {
      localStorage.setItem(this.key, JSON.stringify(data));
    } catch (e) {
      if (global.U && global.U.toast) global.U.toast('Could not save: browser storage is full. Export your data (Settings → Data) and free up space.', 'err');
      throw e;
    }
  };
  LocalAdapter.prototype.reset = function () {
    localStorage.removeItem(this.key); this._read(); return Promise.resolve(true);
  };
  LocalAdapter.prototype.exportAll = function () { return Promise.resolve(this._read()); };
  LocalAdapter.prototype.importAll = function (data) { this._write(data); return Promise.resolve(true); };

  LocalAdapter.prototype.all = function (coll) {
    var d = this._read(); return Promise.resolve(clone(d[coll] || []));
  };
  LocalAdapter.prototype.get = function (coll, id) {
    var d = this._read(), arr = d[coll] || [];
    var f = arr.filter(function (x) { return x.id === id; })[0];
    return Promise.resolve(f ? clone(f) : null);
  };
  LocalAdapter.prototype.insert = function (coll, obj) {
    var d = this._read(); if (!d[coll]) d[coll] = [];
    if (!obj.id) obj.id = uid(coll);
    if (!obj.school_id) obj.school_id = global.SMS_SEED.constants.SCHOOL_ID;
    d[coll].push(obj); this._write(d); return Promise.resolve(clone(obj));
  };
  LocalAdapter.prototype.update = function (coll, id, patch) {
    var d = this._read(), arr = d[coll] || [], out = null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { arr[i] = Object.assign({}, arr[i], patch); out = arr[i]; break; }
    }
    this._write(d); return Promise.resolve(out ? clone(out) : null);
  };
  LocalAdapter.prototype.remove = function (coll, id) {
    var d = this._read(); d[coll] = (d[coll] || []).filter(function (x) { return x.id !== id; });
    this._write(d); return Promise.resolve(true);
  };
  LocalAdapter.prototype.replaceAll = function (coll, arr) {
    var d = this._read(); d[coll] = arr; this._write(d); return Promise.resolve(clone(arr));
  };
  LocalAdapter.prototype.getSingleton = function (name) {
    var d = this._read(); return Promise.resolve(clone(d[name] || null));
  };
  LocalAdapter.prototype.setSingleton = function (name, obj) {
    var d = this._read(); d[name] = obj; this._write(d); return Promise.resolve(clone(obj));
  };
  LocalAdapter.prototype.nextSeq = function (kind) {
    var d = this._read(); d.meta = d.meta || { seq: {} };
    d.meta.seq[kind] = (d.meta.seq[kind] || 0) + 1; this._write(d);
    return Promise.resolve(d.meta.seq[kind]);
  };
  // Raise a counter to at least n (never lowers it).
  LocalAdapter.prototype.bumpSeq = function (kind, n) {
    var d = this._read(); d.meta = d.meta || { seq: {} };
    d.meta.seq[kind] = Math.max(d.meta.seq[kind] || 0, n); this._write(d);
    return Promise.resolve(d.meta.seq[kind]);
  };

  /* ---------------- ApiAdapter (PHP/MySQL) ---------------- */
  // Bearer token persistence: kept separate from the app-level session (app.js
  // owns non-secret user/role/school_id metadata) so the adapter can rehydrate
  // itself and start sending authenticated requests before app.js's boot logic
  // even runs. The token is the ONLY thing that decides which school a request
  // is scoped to (the server never trusts a client-sent school_id on any
  // authenticated route) — this file never invents or overrides that.
  // Kept in sessionStorage (not localStorage) so the signed-in session ends
  // when the browser window closes — opening the app fresh always requires
  // logging in again. See the matching note in app.js. Any token left behind
  // by a pre-2026-08-03 build is purged on sight.
  var API_TOKEN_KEY = 'sms_api_token';
  // OPT-IN exception: if the person ticked "Keep me signed in on this device", the token is also kept in
  // localStorage (so the installed app reopens, even offline) until it would expire anyway (12 hours).
  // Without that tick nothing here changes: the token lives only in sessionStorage.
  var KEEP_FLAG = 'zc_keep_until', KEEP_TOKEN = 'zc_keep_token';
  function keepActive() { try { var u = Number(localStorage.getItem(KEEP_FLAG) || 0); return u > Date.now(); } catch (e) { return false; } }
  function setKeepSignedIn(on) {
    try {
      if (on) localStorage.setItem(KEEP_FLAG, String(Date.now() + 12 * 3600 * 1000));
      else { localStorage.removeItem(KEEP_FLAG); localStorage.removeItem(KEEP_TOKEN); localStorage.removeItem('zc_keep_meta'); }
    } catch (e) {}
  }
  function loadApiToken() {
    try { localStorage.removeItem(API_TOKEN_KEY); } catch (e) {}
    var t = null;
    try { t = sessionStorage.getItem(API_TOKEN_KEY) || null; } catch (e) {}
    if (!t && keepActive()) { try { t = localStorage.getItem(KEEP_TOKEN) || null; if (t) sessionStorage.setItem(API_TOKEN_KEY, t); } catch (e) {} }
    return t;
  }
  function saveApiToken(t) {
    try { if (t) sessionStorage.setItem(API_TOKEN_KEY, t); else sessionStorage.removeItem(API_TOKEN_KEY); } catch (e) {}
    try { localStorage.removeItem(API_TOKEN_KEY); } catch (e) {}
    try { if (t && keepActive()) localStorage.setItem(KEEP_TOKEN, t); else localStorage.removeItem(KEEP_TOKEN); } catch (e) {}
  }

  function ApiAdapter(base) { this.base = base; this.token = loadApiToken(); }
  // _net() is one real trip to the server. A failure to reach it is thrown as an error with .network = true;
  // _req() (below) decides whether that means "use the saved copy / queue it" or "tell the person".
  ApiAdapter.prototype._net = function (method, path, body, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (this.token && !opts.noAuth) headers['Authorization'] = 'Bearer ' + this.token;
    var fetchOpts = { method: method, headers: headers };
    if (body) fetchOpts.body = JSON.stringify(body);
    // opts.query adds extra querystring parameters alongside ?r= — used by the
    // platform routes that scope by ?school=<id> rather than by the token.
    var url = this.base + '?r=' + encodeURIComponent(path);
    if (opts.query) {
      Object.keys(opts.query).forEach(function (k) {
        var v = opts.query[k];
        if (v === undefined || v === null || v === '') return;
        url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
      });
    }
    // A slow, half-working connection must not hang the app: give up after 15 seconds.
    var ctl = global.AbortController ? new global.AbortController() : null, timer = null;
    if (ctl) { fetchOpts.signal = ctl.signal; timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 15000); }
    return fetch(url, fetchOpts).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* non-JSON error page etc. */ }
        if (!r.ok) {
          var msg = (data && data.error) ? data.error : ('API request failed (' + r.status + '): ' + path);
          var err = new Error(msg);
          err.status = r.status; err.body = data;
          // Sign-in and signup calls (noAuth) report their own problems next to
          // the form, so a wrong password must NOT look like an expired session
          // or wipe what the person typed.
          var isAuthCall = !!opts.noAuth;
          var roleDenied = !!(data && data.code === 'role');
          var cfgHooks = global.DB_CONFIG || {};
          // 401 = token missing/expired/invalid -> the session is dead, force re-login.
          // 403 = valid session but the school's subscription is inactive/ended -> surface
          // the server's own message as a banner (a role refusal is just a small notice).
          if (r.status === 401 && !isAuthCall && typeof cfgHooks.onUnauthorized === 'function') {
            cfgHooks.onUnauthorized();
          } else if (r.status === 403 && !isAuthCall && !roleDenied && typeof cfgHooks.onForbidden === 'function') {
            cfgHooks.onForbidden(msg);
          } else if (r.status === 403 && roleDenied && global.U && global.U.toast) {
            global.U.toast(msg, 'warn');
          } else if (r.status >= 500 && global.U && global.U.toast) {
            global.U.toast('The service had a problem. Please try again in a moment.', 'err');
          }
          // Other 4xx (typos, duplicates, "too many tries"): no popup — the
          // screen that asked shows err.message beside the form.
          throw err;
        }
        return data;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      var ne = new Error('You appear to be offline. Please check your internet connection and try again.');
      ne.network = true; ne.original = e;
      throw ne;
    });
  };

  /* ---- Offline layer (see offline.js) ---------------------------------------------------------------
   * Online: every call goes to the server; what is read or written is also saved on the device.
   * Offline / bad network: reads come from the saved copy; teaching work (the collections below) is
   * queued and shown straight away, then sent when the network returns. Everything else says
   * "needs internet", because money and ID numbers must be issued by the server, one at a time. */
  // Day-to-day work that can be done without a network (core details, registration, scores, attendance, fees, stock).
  var OFFLINE_WRITE_OK = { students: 1, parents: 1, staff: 1, attendance: 1, staffAttendance: 1, scores: 1, studentRemarks: 1, conduct: 1, checklists: 1,
    invoices: 1, payments: 1, expenses: 1, otherIncome: 1, inventoryItems: 1, inventoryStock: 1, stockMovements: 1, inventoryTransactions: 1, inventoryAudit: 1, announcements: 1 };
  var NUMBER_KINDS = ['student', 'staff', 'invtxn'], BATCH = 20, LOW = 6;
  var NO_SAVED_COPY = { users: 1, export: 1, import: 1, platform: 1, schools: 1, auth: 1, impersonate: 1, provision: 1, register: 1, reset: 1, suspend: 1, trial: 1, plan: 1, seq: 1, verification: 1, pay: 1, sms: 1 };
  function splitPath(path) { var p = String(path).split('/'); return { head: p[0], arg: p[1] || null }; }
  function netToast(e) {
    if (e && e.network && global.U && global.U.toast) global.U.toast('Network/API error — check your connection.', 'err');
    throw e;
  }
  function offlineToast(msg) { if (global.U && global.U.toast) global.U.toast(msg, 'warn'); }
  function newId(head) { var a = new Uint8Array(5); (global.crypto || {}).getRandomValues ? global.crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); }); return head + '-' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  ApiAdapter.prototype._req = function (method, path, body, opts) {
    var self = this; opts = opts || {};
    var O = global.Offline;
    if (opts.noAuth || !O || !O.enabled()) return this._net(method, path, body, opts).catch(netToast);
    var info = splitPath(path);
    var cacheKey = path + (opts.query ? '?' + JSON.stringify(opts.query) : '');

    // ----- reads -----
    if (method === 'GET') {
      if (NO_SAVED_COPY[info.head]) return this._net(method, path, body, opts).catch(netToast);
      var fromSaved = function () {
        return O.getCache(cacheKey).then(function (hit) {
          if (hit.found) return hit.data;
          offlineToast('This is not available offline yet. Open it once while online.');
          var e = new Error('Not available offline'); e.network = true; throw e;
        });
      };
      if (O.shouldSkipNetwork()) return fromSaved();
      return this._flushIfNeeded().then(function () { return self._net(method, path, body, opts); }).then(function (data) {
        O.setOffline(false); O.putCache(cacheKey, data); return data;
      }, function (err) {
        if (!err || !err.network) throw err;
        O.setOffline(true); return fromSaved();
      });
    }

    // ----- writes -----
    var canQueue = !!OFFLINE_WRITE_OK[info.head] && !(method === 'PUT' && !info.arg) && !!body !== (method === 'DELETE');
    if (method === 'POST' && canQueue && body && !body.id) body.id = newId(info.head);   // the id is chosen here, so a repeated send changes nothing
    var queueIt = function () {
      return O.enqueue({ method: method, path: path, body: body || null }).then(function () {
        return O.applyLocal(method, info.head, info.arg, body, null);
      }).then(function (merged) { return method === 'DELETE' ? { ok: true } : (merged || body || { ok: true }); });
    };
    var online = function () {
      return self._net(method, path, body, opts).then(function (res) {
        O.setOffline(false);
        if (OFFLINE_WRITE_OK[info.head]) O.applyLocal(method, info.head, info.arg, body, res);
        return res;
      });
    };
    if (O.shouldSkipNetwork()) {
      if (canQueue) return queueIt();
      offlineToast('This needs an internet connection. Please try again when you are back online.');
      var ne = new Error('This needs an internet connection.'); ne.network = true; return Promise.reject(ne);
    }
    return this._flushIfNeeded().then(online).catch(function (err) {
      if (!err || !err.network) throw err;
      O.setOffline(true);
      if (canQueue) return queueIt();
      offlineToast('This needs an internet connection. Please try again when you are back online.');
      throw err;
    });
  };

  // Sends the changes made offline, in order. Stops (and keeps the rest) if the network drops again or the
  // session has expired; drops a change the server refuses (for example a view-only school) and says so.
  ApiAdapter.prototype._flushIfNeeded = function () {
    var O = global.Offline;
    if (O && O.enabled() && O.pending() > 0 && !O.shouldSkipNetwork()) return this.syncNow();
    return Promise.resolve();
  };
  ApiAdapter.prototype.syncNow = function () {
    var self = this, O = global.Offline;
    if (!O || !O.enabled()) return Promise.resolve({ done: 0, failed: 0 });
    if (self._syncing) return self._syncing;
    O.setSyncing(true);
    self._syncing = O.queueAll().then(function (items) {
      var done = 0, failed = 0, i = 0, touched = {};
      function step() {
        if (i >= items.length) return null;
        var it = items[i++];
        return self._net(it.method, it.path, it.body, {}).then(function () {
          done++; touched[splitPath(it.path).head] = 1;
          return O.dequeue(it.n).then(step);
        }, function (err) {
          if (err && (err.network || err.status === 401)) throw err;   // keep the queue; try again later / after signing in
          failed++; return O.dequeue(it.n).then(step);                 // refused by the server: drop it, and tell the person
        });
      }
      return Promise.resolve(step()).then(function () { return { done: done, failed: failed, touched: touched }; });
    }).then(function (r) {
      O.setOffline(false);
      var heads = Object.keys(r.touched);
      return Promise.all(heads.map(function (h) { return self._net('GET', h, null, {}).then(function (d) { return O.putCache(h, d); }, function () {}); })).then(function () { O.noteSynced(r.done, r.failed); return r; });
    }, function (err) {
      if (err && err.network) O.setOffline(true);
      return { done: 0, failed: 0, stopped: true };
    }).then(function (r) { O.setSyncing(false); self._syncing = null; return r; });
    return self._syncing;
  };
  // Is the server reachable again? Any answer (even "not signed in") means the network is back.
  ApiAdapter.prototype.probe = function () {
    var self = this, O = global.Offline;
    return fetch(self.base + '?r=ping', { cache: 'no-store' }).then(function () {
      if (O) O.setOffline(false);
      return self.syncNow();
    }, function () { if (O) O.setOffline(true); return null; });
  };
  ApiAdapter.prototype.all = function (coll) { return this._req('GET', coll); };
  ApiAdapter.prototype.get = function (coll, id) { return this._req('GET', coll + '/' + id); };
  ApiAdapter.prototype.insert = function (coll, obj) { return this._req('POST', coll, obj); };
  ApiAdapter.prototype.update = function (coll, id, patch) { return this._req('PUT', coll + '/' + id, patch); };
  ApiAdapter.prototype.remove = function (coll, id) { return this._req('DELETE', coll + '/' + id); };
  ApiAdapter.prototype.replaceAll = function (coll, arr) { return this._req('PUT', coll, { replace: arr }); };
  ApiAdapter.prototype.getSingleton = function (name) { return this._req('GET', 'singleton/' + name); };
  ApiAdapter.prototype.setSingleton = function (name, obj) { return this._req('PUT', 'singleton/' + name, obj); };
  // ID numbers: use this device's reserved batch first (so numbers stay in order, online or not); when it runs out
  // ask the server, then top the batch up in the background. With no network and no batch left, say so.
  ApiAdapter.prototype.nextSeq = function (kind) {
    var self = this, O = global.Offline;
    if (!O || !O.enabled() || NUMBER_KINDS.indexOf(kind) === -1) return this._req('POST', 'seq/' + kind, {});
    return O.takeNumber(kind).then(function (n) {
      if (n != null) { self._topUp(kind); return n; }
      var needNet = function () { offlineToast('Please connect to the internet to get the next ID number.'); var e = new Error('This needs an internet connection.'); e.network = true; throw e; };
      if (O.shouldSkipNetwork()) return needNet();
      return self._net('POST', 'seq/' + kind, {}, {}).then(function (num) { O.setOffline(false); self._topUp(kind); return num; }, function (err) {
        if (err && err.network) { O.setOffline(true); return needNet(); }
        throw err;
      });
    });
  };
  // Keep a few numbers in hand for working offline.
  ApiAdapter.prototype._topUp = function (kind) {
    var self = this, O = global.Offline;
    if (!O || !O.enabled() || O.shouldSkipNetwork() || self['_topping_' + kind]) return Promise.resolve();
    self['_topping_' + kind] = true;
    return O.blockLeft(kind).then(function (left) {
      if (left >= LOW) return null;
      return self._net('POST', 'seq/' + kind, { count: BATCH }, {}).then(function (r) { if (r && r.last) return O.blockAdd(kind, r.first, r.last); });
    }).catch(function () {}).then(function () { self['_topping_' + kind] = false; });
  };
  ApiAdapter.prototype.prepareOffline = function () { var self = this; return Promise.all(NUMBER_KINDS.map(function (k) { return self._topUp(k); })); };
  // On log out (online): hand unused numbers back to the school, so no gaps are left.
  ApiAdapter.prototype.releaseNumbers = function () {
    var self = this, O = global.Offline;
    if (!O || !O.enabled() || O.shouldSkipNetwork()) return Promise.resolve();
    return Promise.all(NUMBER_KINDS.map(function (k) {
      return O.blockRanges(k).then(function (rs) {
        return rs.reduce(function (p, g) { return p.then(function () { return self._net('POST', 'seq/' + k, { release_last: g.to, release_count: g.to - g.from + 1 }, {}).catch(function () {}); }); }, Promise.resolve());
      }).then(function () { return O.blockClear(k); });
    })).catch(function () {});
  };
  ApiAdapter.prototype.bumpSeq = function (kind, n) { return this._req('POST', 'seq/' + kind, { at_least: n }); };
  ApiAdapter.prototype.exportAll = function () { return this._req('GET', 'export'); };
  ApiAdapter.prototype.importAll = function (data) { return this._req('PUT', 'import', data).then(function (r) { NUMBER_KINDS.forEach(function (k) { if (global.Offline) global.Offline.blockClear(k); }); return r; }); };
  ApiAdapter.prototype.reset = function () { return this._req('POST', 'reset', {}).then(function (r) { NUMBER_KINDS.forEach(function (k) { if (global.Offline) global.Offline.blockClear(k); }); return r; }); };

  // login/logout are the only calls that ever send a client-chosen school_id —
  // and only as a LOOKUP HINT for ?r=auth/login (find this school's user by
  // username), never as something the server trusts. A wrong/malicious value
  // here just fails to find a matching user; no other route accepts school_id
  // from the client at all (every other request is scoped by the token alone).
  ApiAdapter.prototype.login = function (username, password, schoolId, userType) {
    var self = this;
    return this._req('POST', 'auth/login', { username: username, password: password, school_id: schoolId || undefined, user_type: userType || undefined }, { noAuth: true })
      .then(function (res) { self.token = res.token; saveApiToken(res.token); return res; });
  };
  // School-name suggestions for the sign-in box: [{id, name}], at most 8. Public; names only.
  ApiAdapter.prototype.searchSchools = function (q) {
    return this._req('GET', 'schools/search', null, { noAuth: true, query: { q: q } });
  };
  // Web-address helper for the signup form: three free suggestions, and a live check of what was typed.
  ApiAdapter.prototype.slugSuggest = function (name, town) {
    return this._req('GET', 'schools/slug-suggest', null, { noAuth: true, query: { name: name, town: town } });
  };
  ApiAdapter.prototype.slugCheck = function (slug, name) {
    return this._req('GET', 'schools/slug-check', null, { noAuth: true, query: { s: slug, name: name } });
  };
  // Self-service signup. The server creates the school + its Admin login and
  // answers with a ready session token, so the new school lands straight in
  // the app. Field-level problems come back as err.body.fields = {field: msg}.
  ApiAdapter.prototype.register = function (form) {
    var self = this;
    return this._req('POST', 'register', form, { noAuth: true })
      .then(function (res) { self.token = res.token; saveApiToken(res.token); return res; });
  };
  // Forgot password (school Administrators). The server always answers the same way,
  // so this reveals nothing about which schools or usernames exist.
  ApiAdapter.prototype.forgotPassword = function (schoolId, username) {
    return this._req('POST', 'auth/forgot', { school_id: schoolId, username: username }, { noAuth: true });
  };
  ApiAdapter.prototype.resetPassword = function (schoolId, token, password) {
    return this._req('POST', 'auth/reset', { school_id: schoolId, token: token, password: password }, { noAuth: true });
  };
  ApiAdapter.prototype.logout = function () { this.token = null; saveApiToken(null); return Promise.resolve(true); };
  ApiAdapter.prototype.hasToken = function () { return !!this.token; };

  // ---- Platform (super-admin) routes — only meaningful for a Platform token.
  // The server independently re-checks claims.plat on every one of these; the
  // client never decides who is allowed to call them, it just relays 403s.
  ApiAdapter.prototype.platformSchoolsList = function () { return this._req('GET', 'schools/list'); };
  // details: { school_id?, name, email?, phone?, contact_name?, demo? } — the
  // answer includes a one-time temp_password for the new school's Admin.
  ApiAdapter.prototype.platformProvision = function (details) {
    return this._req('POST', 'provision', details);
  };
  // Record a payment / renewal: { school_id, plan, days | paid_until, amount?, note? }.
  ApiAdapter.prototype.platformPayment = function (p) { return this._req('POST', 'platform/payment', p); };
  ApiAdapter.prototype.platformDelete = function (schoolId, confirm) { return this._req('POST', 'platform/delete', { school_id: schoolId, confirm: confirm }); };
  ApiAdapter.prototype.platformRequests = function () { return this._req('GET', 'platform/requests'); };
  ApiAdapter.prototype.platformDismissRequest = function (id) { return this._req('POST', 'platform/request', { id: id }); };
  ApiAdapter.prototype.platformNote = function (schoolId, note) { return this._req('POST', 'platform/note', { school_id: schoolId, note: note }); };
  // Correct a school's name / contact person / email / phone: { name?, contact_name?, email?, phone? }.
  ApiAdapter.prototype.platformDetails = function (schoolId, d) {
    return this._req('POST', 'platform/details', Object.assign({ school_id: schoolId }, d));
  };
  // Developer marks a school's ownership as checked (or removes the mark).
  ApiAdapter.prototype.platformVerify = function (schoolId, verified, note) {
    return this._req('POST', 'platform/verify', { school_id: schoolId, verified: !!verified, note: note || '' });
  };
  // School Admin submits their school's licence / registration number for checking.
  ApiAdapter.prototype.submitVerification = function (licenceNo) { return this._req('POST', 'verification', { licence_no: licenceNo }); };
  // One-time temporary password for a user (default: the school's first Admin).
  ApiAdapter.prototype.platformResetPassword = function (schoolId, userId) {
    return this._req('POST', 'platform/password', { school_id: schoolId, user_id: userId || undefined });
  };
  ApiAdapter.prototype.platformSuspend = function (schoolId, status) {
    return this._req('POST', 'suspend', { school_id: schoolId, status: status });
  };
  ApiAdapter.prototype.platformReset = function (schoolId) { return this._req('POST', 'reset', { school_id: schoolId }); };
  ApiAdapter.prototype.platformExtendTrial = function (schoolId, days) {
    return this._req('POST', 'trial', { school_id: schoolId, days: days });
  };
  // Set an exact trial end date (YYYY-MM-DD), or clear the trial entirely to
  // mark a school as fully paid. Same server route as platformExtendTrial.
  ApiAdapter.prototype.platformSetTrial = function (schoolId, endDate) {
    return this._req('POST', 'trial', { school_id: schoolId, trial_ends_at: endDate });
  };
  ApiAdapter.prototype.platformClearTrial = function (schoolId) {
    return this._req('POST', 'trial', { school_id: schoolId, clear: true });
  };
  ApiAdapter.prototype.platformPlan = function (schoolId, plan) {
    return this._req('POST', 'plan', { school_id: schoolId, plan: plan });
  };
  ApiAdapter.prototype.platformUsers = function (schoolId) {
    return this._req('GET', 'platform/users', null, { query: { school: schoolId } });
  };
  ApiAdapter.prototype.platformUserStatus = function (schoolId, userId, disabled) {
    return this._req('POST', 'platform/user', { school_id: schoolId, user_id: userId, disabled: !!disabled });
  };
  ApiAdapter.prototype.platformAudit = function (schoolId, limit) {
    return this._req('GET', 'platform/audit', null, { query: { school: schoolId, limit: limit } });
  };
  // Impersonation issues a NEW token scoped to the target school — swap the
  // adapter's active token to it exactly like login() does, so every
  // subsequent request (until the impersonated token expires or the caller
  // logs out) acts as that school, not the platform account.
  ApiAdapter.prototype.impersonate = function (schoolId) {
    var self = this;
    return this._req('POST', 'impersonate', { school_id: schoolId }).then(function (res) {
      self.token = res.token; saveApiToken(res.token); return res;
    });
  };

  var adapter = DB_CONFIG.useApi ? new ApiAdapter(DB_CONFIG.apiBase) : new LocalAdapter();

  // ---- Public facade. The whole app talks only to DB.* ----
  var DB = {
    config: DB_CONFIG,
    isApi: !!DB_CONFIG.useApi,
    uid: uid,
    SINGLETONS: SINGLETONS,

    all: function (c) { return adapter.all(c); },
    get: function (c, id) { return adapter.get(c, id); },
    insert: function (c, o) { return adapter.insert(c, o); },
    update: function (c, id, p) { return adapter.update(c, id, p); },
    remove: function (c, id) { return adapter.remove(c, id); },
    replaceAll: function (c, a) { return adapter.replaceAll(c, a); },
    singleton: function (n) { return adapter.getSingleton(n); },
    setSingleton: function (n, o) { return adapter.setSingleton(n, o); },
    nextSeq: function (k) { return adapter.nextSeq(k); },
    bumpSeq: function (k, n) { return adapter.bumpSeq(k, n); },
    exportAll: function () { return adapter.exportAll(); },
    importAll: function (d) { return adapter.importAll(d); },
    reset: function () { return adapter.reset(); },

    // ---- API-mode session (no-ops / rejects when running in local mode) ----
    apiLogin: function (username, password, schoolId, userType) {
      if (!DB.isApi) return Promise.reject(new Error('apiLogin is only available when DB_CONFIG.useApi is true.'));
      return adapter.login(username, password, schoolId, userType);
    },
    slugSuggest: function (name, town) { return DB.isApi ? adapter.slugSuggest(name, town) : Promise.resolve({ suggestions: [] }); },
    slugCheck: function (slug, name) { return DB.isApi ? adapter.slugCheck(slug, name) : Promise.resolve({ ok: true }); },
    searchSchools: function (q) { return DB.isApi ? adapter.searchSchools(q) : Promise.resolve([]); },
    apiRegister: function (form) {
      if (!DB.isApi) return Promise.reject(new Error('Signup is only available on the live service.'));
      return adapter.register(form);
    },
    apiForgotPassword: function (schoolId, username) {
      if (!DB.isApi) return Promise.reject(new Error('Password reset is only available on the live service.'));
      return adapter.forgotPassword(schoolId, username);
    },
    apiResetPassword: function (schoolId, token, password) {
      if (!DB.isApi) return Promise.reject(new Error('Password reset is only available on the live service.'));
      return adapter.resetPassword(schoolId, token, password);
    },
    apiLogout: function () { return DB.isApi ? adapter.logout() : Promise.resolve(true); },
    // ---- offline use (see offline.js) ----
    keepSignedIn: function (on) { setKeepSignedIn(on); },
    isKeptSignedIn: function () { return keepActive(); },
    offlineScope: function (scope) { return global.Offline ? global.Offline.setScope(scope) : Promise.resolve(); },
    offlineClear: function () { setKeepSignedIn(false); return global.Offline ? global.Offline.clearAll() : Promise.resolve(); },
    offlinePending: function () { return global.Offline ? global.Offline.pending() : 0; },
    syncNow: function () { return DB.isApi ? adapter.syncNow() : Promise.resolve(); },
    probeNetwork: function () { return DB.isApi ? adapter.probe() : Promise.resolve(); },
    prepareOffline: function () { return DB.isApi ? adapter.prepareOffline() : Promise.resolve(); },
    releaseNumbers: function () { return DB.isApi ? adapter.releaseNumbers() : Promise.resolve(); },
    hasApiToken: function () { return DB.isApi && adapter.hasToken(); },

    // This school's own licence/trial state, straight from the server. Resolves
    // to null in local mode so license-lib.js can fall back to its offline
    // trial clock — there is no server to be authoritative in that mode.
    subscriptionState: function () {
      if (!DB.isApi) return Promise.resolve(null);
      return adapter._req('GET', 'subscription').catch(function () { return null; });
    },

    // ---- Platform (super-admin) routes — API mode only; reject in local mode. ----
    platformSchoolsList: function () { return DB.isApi ? adapter.platformSchoolsList() : Promise.reject(new Error('Platform routes require API mode.')); },
    platformProvision: function (details) { return DB.isApi ? adapter.platformProvision(details) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformPayment: function (p) { return DB.isApi ? adapter.platformPayment(p) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformDelete: function (schoolId, confirm) { return DB.isApi ? adapter.platformDelete(schoolId, confirm) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformRequests: function () { return DB.isApi ? adapter.platformRequests() : Promise.reject(new Error('Platform routes require API mode.')); },
    platformDismissRequest: function (id) { return DB.isApi ? adapter.platformDismissRequest(id) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformNote: function (schoolId, note) { return DB.isApi ? adapter.platformNote(schoolId, note) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformDetails: function (schoolId, d) { return DB.isApi ? adapter.platformDetails(schoolId, d) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformVerify: function (schoolId, verified, note) { return DB.isApi ? adapter.platformVerify(schoolId, verified, note) : Promise.reject(new Error('Platform routes require API mode.')); },
    submitVerification: function (licenceNo) { return DB.isApi ? adapter.submitVerification(licenceNo) : Promise.reject(new Error('Verification requires the hosted version.')); },
    platformResetPassword: function (schoolId, userId) { return DB.isApi ? adapter.platformResetPassword(schoolId, userId) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformSuspend: function (schoolId, status) { return DB.isApi ? adapter.platformSuspend(schoolId, status) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformReset: function (schoolId) { return DB.isApi ? adapter.platformReset(schoolId) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformExtendTrial: function (schoolId, days) { return DB.isApi ? adapter.platformExtendTrial(schoolId, days) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformSetTrial: function (schoolId, endDate) { return DB.isApi ? adapter.platformSetTrial(schoolId, endDate) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformClearTrial: function (schoolId) { return DB.isApi ? adapter.platformClearTrial(schoolId) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformPlan: function (schoolId, plan) { return DB.isApi ? adapter.platformPlan(schoolId, plan) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformUsers: function (schoolId) { return DB.isApi ? adapter.platformUsers(schoolId) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformUserStatus: function (schoolId, userId, disabled) { return DB.isApi ? adapter.platformUserStatus(schoolId, userId, disabled) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformAudit: function (schoolId, limit) { return DB.isApi ? adapter.platformAudit(schoolId, limit) : Promise.reject(new Error('Platform routes require API mode.')); },
    platformImpersonate: function (schoolId) { return DB.isApi ? adapter.impersonate(schoolId) : Promise.reject(new Error('Platform routes require API mode.')); },

    // Convenience: find within a collection
    find: function (coll, pred) {
      return adapter.all(coll).then(function (arr) { return arr.filter(pred); });
    },

    // Generate next ST/SF code, e.g. ST0001
    nextCode: function (kind, prefix, digits) {
      return adapter.nextSeq(kind).then(function (n) {
        var s = '' + n; while (s.length < digits) s = '0' + s;
        return prefix + s;
      });
    }
  };

  global.DB = DB;
})(window);
