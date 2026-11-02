/* ============================================================
 * license-lib.js — offline licence & free-trial engine.
 * Dependency-free. Verifies cryptographically-signed licence keys
 * with the browser's built-in WebCrypto (ECDSA P-256 / SHA-256).
 * The matching PRIVATE key lives only in Zetranova's generator tool,
 * so keys cannot be forged. Public key below is safe to ship.
 * ============================================================ */
(function (global) {
  'use strict';
  var DB = global.DB;

  // Public verification key (safe to publish).
  var PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'Ri2HWiYBSXnd0CtpXcIJZUANUK3uGw2MMIML4c7s_Xc', y: 'MG-kk2yycEkCqT2TLRjGhSDq7ow8dyb1S1AdpWWtPXA' };

  var TRIAL_DAYS = 30;
  var CURRENCY = 'GHS';
  // Plans: enrolment cap + termly / annual (3-term prepay) price in GHS. Tune freely.
  // Tiers by enrolment: Basic 0–199, Growth 200–499, Premium 500+ (unlimited).
  // term = per-term price, year = 3-term prepay. Prices are a guide; tune freely.
  var PLANS = {
    basic:   { label: 'Basic',   max: 199,    term: 600,  year: 1500 },
    growth:  { label: 'Growth',  max: 499,    term: 1200, year: 3000 },
    premium: { label: 'Premium', max: 100000, term: 2000, year: 5000 }
  };

  function b64uToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = global.atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function asciiBytes(s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; }
  function decodePayload(head) {
    var bytes = b64uToBytes(head), json;
    if (global.TextDecoder) json = new global.TextDecoder().decode(bytes);
    else { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); json = decodeURIComponent(escape(s)); }
    return JSON.parse(json);
  }

  var keyPromise = null;
  function pubKey() {
    if (!keyPromise) {
      keyPromise = (global.crypto && global.crypto.subtle)
        ? global.crypto.subtle.importKey('jwk', PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        : Promise.reject(new Error('WebCrypto unavailable'));
    }
    return keyPromise;
  }

  // verify(token) -> Promise<{valid, payload}>
  function verify(token) {
    try {
      var parts = String(token || '').trim().split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return Promise.resolve({ valid: false });
      var head = parts[0], sig = b64uToBytes(parts[1]), data = asciiBytes(head);
      return pubKey()
        .then(function (k) { return global.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, data); })
        .then(function (ok) { return { valid: !!ok, payload: ok ? decodePayload(head) : null }; })
        .catch(function () { return { valid: false }; });
    } catch (e) { return Promise.resolve({ valid: false }); }
  }

  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function daysBetween(aISO, bISO) { return Math.floor((Date.parse(bISO + 'T00:00:00') - Date.parse(aISO + 'T00:00:00')) / 86400000); }
  function addDaysISO(aISO, n) { var d = new Date(Date.parse(aISO + 'T00:00:00') + n * 86400000); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  function finalize(st) {
    st.planLabel = (st.plan && PLANS[st.plan]) ? PLANS[st.plan].label : (st.trial ? 'Free trial' : '—');
    st.locked = (st.state === 'expired');
    return st;
  }
  // Admin can customize/extend the trial length per school (Settings/Subscription);
  // falls back to the 30-day TRIAL_DAYS default whenever trial_days is unset/invalid.
  function effectiveTrialDays(rec) {
    var n = Number(rec && rec.trial_days);
    return (n > 0) ? Math.floor(n) : TRIAL_DAYS;
  }
  function localTrial(rec, today) {
    var start = rec.trial_start, save = Promise.resolve(rec);
    if (!start) { start = today; save = DB.setSingleton('license', Object.assign({}, rec, { trial_start: start })); }
    var days = effectiveTrialDays(rec);
    return save.then(function () {
      var left = days - daysBetween(start, today);
      return finalize({ state: left >= 0 ? 'trialing' : 'expired', plan: null, school: '', expires: addDaysISO(start, days), daysLeft: left, trial: true, source: 'local', trialDays: days });
    });
  }

  // resolve() -> Promise<state>  { state, plan, planLabel, school, expires, daysLeft, trial, source, locked }
  //
  // TWO MODES, deliberately different:
  //   API mode   — the SERVER is authoritative. Trial end date, plan and status
  //                live on the school's registry row and are only changeable
  //                from the owner/platform dashboard. A school cannot extend
  //                its own trial by clearing browser storage, editing its own
  //                singletons, or importing a doctored dataset. Offline licence
  //                keys are ignored here: in a hosted (SaaS) deployment the
  //                owner sets the plan centrally, so a pasted key must not be
  //                able to override what the owner decided.
  //   Local mode — no server exists, so the original offline behaviour stands:
  //                a signed licence key if one is pasted, otherwise a local
  //                trial clock. Local mode is for demos/training only.
  function resolve() {
    if (DB.isApi && DB.subscriptionState) {
      return DB.subscriptionState().then(function (s) {
        if (!s || s.source !== 'server') { return localResolve(); }
        // A paid period (paid_until) outranks any leftover trial date — mirrors
        // subscription_state() in api/index.php.
        var paid = !!s.paid_until;
        var onTrial = !paid && !!s.trial_ends_at;
        // A suspended school is surfaced as locked/read-only, same as expired —
        // it should never silently look like a healthy paid account.
        var state = (s.state === 'suspended') ? 'expired' : s.state;
        return finalize({
          state:     state,
          plan:      s.plan || null,
          school:    s.name || '',
          expires:   s.paid_until || s.trial_ends_at || '',
          // Nothing counting down (no trial, no paid end date) means a large
          // number keeps "days remaining" displays harmless rather than showing 0.
          daysLeft:  (s.days_left === null || s.days_left === undefined) ? 9999 : s.days_left,
          trial:     onTrial,
          paid:      paid,
          suspended: s.state === 'suspended',
          source:    'server'
        });
      }).catch(function () { return localResolve(); });
    }
    return localResolve();
  }

  function localResolve() {
    return DB.singleton('license').then(function (rec) {
      rec = rec || {};
      var today = todayISO();
      if (rec.token) {
        return verify(rec.token).then(function (res) {
          if (res.valid && res.payload) {
            var p = res.payload, exp = p.expires || '2100-01-01', left = daysBetween(today, exp);
            return finalize({ state: left >= 0 ? (p.trial ? 'trialing' : 'active') : 'expired', plan: p.plan || 'growth', school: p.school || '', expires: exp, daysLeft: left, trial: !!p.trial, source: 'key' });
          }
          return localTrial(rec, today); // bad/foreign key -> fall back to trial (never lock on a bad paste)
        });
      }
      return localTrial(rec, today);
    }).catch(function () {
      return finalize({ state: 'trialing', plan: null, school: '', expires: '', daysLeft: TRIAL_DAYS, trial: true, source: 'error' });
    });
  }

  // activate(token) -> Promise<{ok, payload, error}>
  function activate(token) {
    return verify(token).then(function (res) {
      if (!res.valid || !res.payload) return { ok: false, error: 'That key is not valid. Please paste the whole key exactly as sent.' };
      var exp = res.payload.expires || '2100-01-01';
      if (daysBetween(todayISO(), exp) < 0) return { ok: false, error: 'That key expired on ' + exp + '. Ask for a fresh key.' };
      return DB.singleton('license').then(function (rec) {
        return DB.setSingleton('license', Object.assign({}, rec || {}, { token: String(token).trim() })).then(function () { return { ok: true, payload: res.payload }; });
      });
    });
  }
  function deactivate() { return DB.singleton('license').then(function (rec) { rec = rec || {}; delete rec.token; return DB.setSingleton('license', rec); }); }

  // setTrialDays(n) -> Promise<{ok, error}>. Pass null/0 to reset to the 30-day default.
  // Changes only the LENGTH of the trial, never the recorded start date, so extending
  // an in-progress trial adds days rather than restarting the clock.
  // LOCAL MODE ONLY — in API mode the trial lives on the server and is set from
  // the owner console; nothing in the school's own app can change it.
  function setTrialDays(n) {
    var days = (n == null || n === '') ? null : Number(n);
    if (days != null && (!isFinite(days) || days < 1 || days > 3650)) {
      return Promise.resolve({ ok: false, error: 'Enter a whole number of days between 1 and 3650.' });
    }
    return DB.singleton('license').then(function (rec) {
      rec = Object.assign({}, rec || {});
      if (days == null) delete rec.trial_days; else rec.trial_days = Math.floor(days);
      return DB.setSingleton('license', rec).then(function () { return { ok: true }; });
    });
  }

  global.License = {
    PLANS: PLANS, TRIAL_DAYS: TRIAL_DAYS, CURRENCY: CURRENCY,
    verify: verify, resolve: resolve, activate: activate, deactivate: deactivate,
    setTrialDays: setTrialDays, todayISO: todayISO, daysBetween: daysBetween
  };
})(window);
