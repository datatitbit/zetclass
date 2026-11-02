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
  function loadApiToken() {
    try { localStorage.removeItem(API_TOKEN_KEY); } catch (e) {}
    try { return sessionStorage.getItem(API_TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function saveApiToken(t) {
    try { if (t) sessionStorage.setItem(API_TOKEN_KEY, t); else sessionStorage.removeItem(API_TOKEN_KEY); } catch (e) {}
    try { localStorage.removeItem(API_TOKEN_KEY); } catch (e) {}
  }

  function ApiAdapter(base) { this.base = base; this.token = loadApiToken(); }
  ApiAdapter.prototype._req = function (method, path, body, opts) {
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
    return fetch(url, fetchOpts).then(function (r) {
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
    }).catch(function (e) {
      if (e && e.status) throw e; // already reported above (401/403/other HTTP error)
      if (global.U && global.U.toast) global.U.toast('Network/API error — check your connection.', 'err');
      throw e;
    });
  };
  ApiAdapter.prototype.all = function (coll) { return this._req('GET', coll); };
  ApiAdapter.prototype.get = function (coll, id) { return this._req('GET', coll + '/' + id); };
  ApiAdapter.prototype.insert = function (coll, obj) { return this._req('POST', coll, obj); };
  ApiAdapter.prototype.update = function (coll, id, patch) { return this._req('PUT', coll + '/' + id, patch); };
  ApiAdapter.prototype.remove = function (coll, id) { return this._req('DELETE', coll + '/' + id); };
  ApiAdapter.prototype.replaceAll = function (coll, arr) { return this._req('PUT', coll, { replace: arr }); };
  ApiAdapter.prototype.getSingleton = function (name) { return this._req('GET', 'singleton/' + name); };
  ApiAdapter.prototype.setSingleton = function (name, obj) { return this._req('PUT', 'singleton/' + name, obj); };
  ApiAdapter.prototype.nextSeq = function (kind) { return this._req('POST', 'seq/' + kind, {}); };
  ApiAdapter.prototype.bumpSeq = function (kind, n) { return this._req('POST', 'seq/' + kind, { at_least: n }); };
  ApiAdapter.prototype.exportAll = function () { return this._req('GET', 'export'); };
  ApiAdapter.prototype.importAll = function (data) { return this._req('PUT', 'import', data); };
  ApiAdapter.prototype.reset = function () { return this._req('POST', 'reset', {}); };

  // login/logout are the only calls that ever send a client-chosen school_id —
  // and only as a LOOKUP HINT for ?r=auth/login (find this school's user by
  // username), never as something the server trusts. A wrong/malicious value
  // here just fails to find a matching user; no other route accepts school_id
  // from the client at all (every other request is scoped by the token alone).
  ApiAdapter.prototype.login = function (username, password, schoolId) {
    var self = this;
    return this._req('POST', 'auth/login', { username: username, password: password, school_id: schoolId || undefined }, { noAuth: true })
      .then(function (res) { self.token = res.token; saveApiToken(res.token); return res; });
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
    apiLogin: function (username, password, schoolId) {
      if (!DB.isApi) return Promise.reject(new Error('apiLogin is only available when DB_CONFIG.useApi is true.'));
      return adapter.login(username, password, schoolId);
    },
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
