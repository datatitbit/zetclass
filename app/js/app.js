/* ============================================================
 * app.js — App shell, session/role, router, permission gating.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB;

  var MODULES = global.SMS_SEED.constants.MODULES;
  var ICONS = {
    Dashboard: '▤', Students: '👥', Assessment: '✎', Finance: '₵', Attendance: '✓',
    Communication: '✉', Administration: '⚙', Inventory: '▦',
    Accounting: '∑', Payroll: '💼', Settings: '⚙', Subscription: '★'
  };
  var ROUTES = {
    Dashboard: 'dashboard', Students: 'students', Assessment: 'assessment', Finance: 'finance',
    Attendance: 'attendance', Communication: 'communication', Administration: 'administration',
    Inventory: 'inventory', Accounting: 'accounting', Payroll: 'payroll', Settings: 'settings', Subscription: 'subscription'
  };

  // Last-resort fallback only — used if the `permissions` collection is
  // completely empty/unreadable (e.g. a corrupted install). The real default
  // lives in seed.js's `permissions` object; normalisePerms() below reads that
  // directly so there is exactly one authored source of truth for defaults.
  // Kept here in the same shape as seed.js for the rare case both are needed.
  function defaultPerms() {
    function mk(list) { var o = {}; MODULES.forEach(function (m) { o[m] = list.indexOf(m) !== -1; }); return o; }
    return {
      'Admin': mk(MODULES),
      'Director': mk(MODULES.filter(function (m) { return m !== 'Settings'; })),
      'Teacher': mk(['Dashboard', 'Students', 'Assessment', 'Attendance']),
      'Other staff': mk(['Dashboard', 'Students', 'Finance', 'Communication', 'Administration', 'Inventory', 'Accounting', 'Payroll']),
      'Parent': mk(['Dashboard', 'Students', 'Assessment', 'Finance', 'Attendance', 'Communication'])
    };
  }

  var App = {
    ctx: {},        // cached settings/context
    user: null,
    permissions: {},
    license: null,  // licence/trial state, set at boot by License.resolve()
    // API mode only: the current session's school id (from the login response —
    // never client-chosen after login) and optional URL-slug hints a router can
    // set BEFORE start()/chooseRoleApi() run, purely to pre-fill the login form.
    schoolId: null,
    schoolIdHint: null,
    schoolSlugLabel: null,
    // Set once at load by the /school/:slug and /admin path parser below.
    // pendingHash/pendingAdminHash are consumed (and cleared) the first time
    // boot()/the admin area renders, so they only ever affect the very next
    // render — later in-app navigation is untouched.
    isAdminArea: false,
    isSignupArea: false,   // true when the address is /signup (API mode only)
    isForgotArea: false,   // /forgot-password
    isResetArea: false,    // /reset-password?school=...&token=...
    pendingHash: null,
    pendingAdminHash: null,
    // API mode only: set when a background request comes back 403 (subscription
    // inactive) — rendered as a persistent banner until the page is reloaded.
    forbiddenMessage: null,
    // API mode only: true when the current school session was opened via the
    // platform admin's "Impersonate" control (POST ?r=impersonate), not a real
    // login. impExpiresAt is the server-issued expiry of that short-lived token.
    impersonating: false,
    impExpiresAt: null,
    // View-only roles: Parent and Director can view & download but never edit.
    get readOnly() { return App.user && (App.user.role === 'Parent' || App.user.role === 'Director'); },
    // When the free trial / subscription has lapsed the whole app becomes read-only.
    get locked() { return !!(App.license && App.license.locked); }
  };

  // ---- Load shared context (settings used everywhere) ----
  App.refresh = function () {
    return Promise.all([
      DB.singleton('school'), DB.singleton('academic'), DB.singleton('idRules'),
      DB.singleton('weighting'), DB.singleton('labels'),
      DB.all('permissions'), DB.all('gradeBands'), DB.all('categories'),
      DB.all('classes'), DB.all('reportTemplates'), DB.all('feeTypes'), DB.all('parents'),
      DB.singleton('admissionFields'), DB.all('staff'), DB.singleton('dashboardSettings')
    ]).then(function (r) {
      App.ctx = {
        school: r[0], academic: r[1], idRules: r[2], weighting: r[3], labels: r[4],
        gradeBands: r[6], categories: r[7], classes: r[8], reportTemplates: r[9], feeTypes: r[10], parents: r[11],
        admissionFields: (Array.isArray(r[12]) && r[12].length) ? r[12] : JSON.parse(JSON.stringify(global.SMS_SEED.admissionFields || [])),
        staff: r[13] || [],
        dashboardSettings: r[14] || JSON.parse(JSON.stringify(global.SMS_SEED.dashboardSettings))
      };
      // permissions stored as array of {role, perms} OR object — normalise
      App.permissions = normalisePerms(r[5]);
      applyTheme(App.ctx.school);
      return App.ctx;
    });
  };

  // ---- Per-school theme colors (Settings -> Profile -> Branding) ----
  // Custom branding is OFF by default (theme_enabled: false) — the app, admission
  // forms and printed reports keep the standard Zetranova look until an admin
  // turns it on AND has set valid colors. Derived shades come from U.shade() so
  // a client only has to pick three swatches, not every CSS variable individually.
  var DEFAULT_THEME = { primary: '#0f5e5e', secondary1: '#e0ab2b', secondary2: '#1c6b6b' };
  function resolveTheme(school) {
    var on = !!(school && school.theme_enabled) && U.isHexColor(school.theme_primary);
    return {
      primary: on ? school.theme_primary : DEFAULT_THEME.primary,
      secondary1: (on && U.isHexColor(school.theme_secondary1)) ? school.theme_secondary1 : DEFAULT_THEME.secondary1,
      secondary2: (on && U.isHexColor(school.theme_secondary2)) ? school.theme_secondary2 : DEFAULT_THEME.secondary2
    };
  }
  function applyTheme(school) {
    if (!school || !U.shade) return;
    var t = resolveTheme(school);
    var root = document.documentElement.style;
    root.setProperty('--teal', t.primary);
    root.setProperty('--teal-dark', U.shade(t.primary, -0.3));
    root.setProperty('--teal-deep', U.shade(t.primary, -0.5));
    root.setProperty('--teal-mid', U.shade(t.primary, 0.15));
    root.setProperty('--teal-light', U.shade(t.primary, 0.88));
    root.setProperty('--gold', t.secondary1);
    root.setProperty('--gold-dark', U.shade(t.secondary1, -0.25));
    root.setProperty('--gold-soft', U.shade(t.secondary1, 0.82));
    root.setProperty('--sec2', t.secondary2);
    root.setProperty('--sec2-dark', U.shade(t.secondary2, -0.25));
  }
  App.themeHex = function () {
    var t = resolveTheme(App.ctx.school || {});
    return { primary: t.primary, accent: t.secondary1, secondary1: t.secondary1, secondary2: t.secondary2 };
  };

  function normalisePerms(p) {
    if (Array.isArray(p) && p.length) {
      var o = {}; p.forEach(function (row) { o[row.role] = row.perms; });
      if (Object.keys(o).length) return o;
    } else if (p && typeof p === 'object' && Object.keys(p).length) {
      // seed.js ships `permissions` as a plain {role: {module: bool}} object —
      // this is the real, single-authored default until Settings -> Roles is
      // first saved (which then persists it as the {role,perms} array shape).
      return p;
    }
    return defaultPerms();
  }

  // The parents record backing the signed-in Parent user (matched by linked ward).
  function parentRecordFor(user) {
    var ids = (user && user.linked_student_ids) || [];
    return (App.ctx.parents || []).filter(function (p) {
      return (p.student_ids || []).some(function (c) { return ids.indexOf(c) !== -1; });
    })[0];
  }
  App.parentRecord = function () { return parentRecordFor(App.user); };

  // "Other staff" is a broad catch-all role (front desk, cooks, security,
  // whoever handles fees/accounts — see canFullDashboard's comment above).
  // By default every person in that role shares identical module access,
  // which means a security guard's account and an accounts clerk's account
  // are functionally identical. This lets an Admin optionally scope an
  // INDIVIDUAL "Other staff" person down to a subset of their role's normal
  // modules (Administration → Staff → "Restrict to specific modules"),
  // without having to change the role-wide default for everyone else in it.
  // Unset/empty list = no restriction (default, unchanged behaviour).
  function withinModuleRestrict(module) {
    var st = App.myStaff();
    if (!st || !Array.isArray(st.module_restrict) || !st.module_restrict.length) return true;
    return st.module_restrict.indexOf(module) !== -1;
  }

  App.can = function (module) {
    if (!App.user) return false;
    if (App.user.role === 'Admin') return true;      // Admin always full
    if (module === 'Subscription') return App.user.role === 'Director'; // Admin above; Director may view
    if (App.user.role === 'Parent') {
      // Admin can switch OFF an individual parent's portal (Students → Parents).
      var pr = parentRecordFor(App.user);
      if (pr && pr.portal_enabled === false) return false;
    }
    var perms = App.permissions[App.user.role] || {};
    if (!perms[module]) return false;
    if (App.user.role === 'Other staff' && !withinModuleRestrict(module)) return false;
    return true;
  };

  // Can this role EDIT (create/update/delete) in the given module?
  App.canEdit = function (module) {
    if (!App.user) return false;
    if (App.locked) return false;                 // trial/subscription lapsed → read-only
    var role = App.user.role;
    if (role === 'Admin') return true;                         // edit everywhere
    if (role === 'Director' || role === 'Parent') return false; // view / download only
    if (role === 'Teacher') return module === 'Assessment' || module === 'Attendance';
    if (role === 'Other staff') {
      if (['Finance', 'Accounting', 'Payroll', 'Inventory', 'Students', 'Administration'].indexOf(module) === -1) return false;
      return withinModuleRestrict(module); // per-person restriction, if one is set
    }
    return false;
  };

  // The staff record linked to the signed-in user (via staff_id) — the single
  // source of truth for a teacher's class-teacher / subject-teacher assignments.
  App.myStaff = function () {
    if (!App.user || !App.user.staff_id) return null;
    return (App.ctx.staff || []).filter(function (s) { return s.staff_id === App.user.staff_id; })[0] || null;
  };
  // Classes this Teacher can act on: class-teacher assignments (whole class,
  // all subjects) unioned with the classes covered by their subject-teacher
  // assignments (one subject, one or more classes).
  App.teacherClassIds = function () {
    var st = App.myStaff();
    var ids = (st && st.class_ids) || App.user.class_ids || [];
    var subj = (st && st.subject_teacher_of) || [];
    subj.forEach(function (a) { (a.class_ids || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); }); });
    return ids;
  };
  // Subjects a Teacher may enter for a given class: all of them if they are
  // the class teacher there, otherwise only the subjects assigned to them.
  App.teacherSubjectsFor = function (classId) {
    var st = App.myStaff();
    if (!st) return null; // null = no restriction (non-staff-linked teacher account)
    if ((st.class_ids || []).indexOf(classId) !== -1) return null; // class teacher — all subjects
    var subj = (st.subject_teacher_of || []).filter(function (a) { return (a.class_ids || []).indexOf(classId) !== -1; }).map(function (a) { return a.subject; });
    return subj; // restricted list (possibly empty)
  };

  // Full dashboard (Finance KPIs + enrolment/attendance) is open to Admin and
  // Director by default. "Other staff" is a broad catch-all role (front desk,
  // office support, whoever handles fees, etc.) — not everyone in it should
  // see financial figures by default, so it does NOT auto-qualify here.
  // Instead, Admin individually flags the specific person who needs it (e.g.
  // the one actually handling accounts) via Administration → Staff → "Full
  // dashboard access". Everyone without that flag sees Enrolment & Attendance
  // only — what a person can SEE here follows what they've actually been
  // granted, not a blanket rule tied to their role label.
  App.canFullDashboard = function () {
    if (!App.user) return false;
    var role = App.user.role;
    if (role === 'Admin' || role === 'Director') return true;
    var st = App.myStaff();
    return !!(st && st.dashboard_full_access);
  };

  App.className = function (id) {
    var c = (App.ctx.classes || []).filter(function (x) { return x.id === id; })[0];
    return c ? c.name : '—';
  };
  App.termName = function () {
    var a = App.ctx.academic; if (!a) return '';
    var t = (a.terms || []).filter(function (x) { return x.n === a.current_term; })[0];
    return t ? t.name : ('Term ' + a.current_term);
  };

  // ---- Session ----
  // Only non-sensitive fields are persisted; the fresh record (incl. password
  // hash, used only for change-password checks) is re-fetched from DB on boot.
  //
  // Stored in sessionStorage, NOT localStorage. sessionStorage is wiped when
  // the browser tab/window is closed, so opening the app fresh always lands on
  // the login screen, while reloading the same tab keeps you signed in.
  // localStorage would survive indefinitely — on a shared school computer that
  // means the next person to open the link walks straight into the previous
  // user's account, which is exactly what we do not want.
  var SESSION_KEY = 'sms_session';
  function purgeLegacySession(key) {
    // Builds before 2026-08-03 kept sessions in localStorage, which made the
    // app auto-open straight into the dashboard. Remove any leftover on sight
    // so upgrading installs stop silently auto-logging in.
    try { localStorage.removeItem(key); } catch (e) {}
  }
  function loadSession() {
    purgeLegacySession(SESSION_KEY);
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }
  function saveSession(u) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: u.id, role: u.role, name: u.name })); } catch (e) {}
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    purgeLegacySession(SESSION_KEY);
  }

  // ---- API-mode session metadata (non-secret: user/role/school_id only).
  // The actual bearer token lives separately in store.js's own storage key,
  // so the adapter can rehydrate itself independently of this file.
  // Same sessionStorage reasoning as above.
  var API_SESSION_KEY = 'sms_api_session_meta';
  function loadApiSessionMeta() {
    purgeLegacySession(API_SESSION_KEY);
    try { return JSON.parse(sessionStorage.getItem(API_SESSION_KEY)); } catch (e) { return null; }
  }
  function saveApiSessionMeta(meta) {
    try { sessionStorage.setItem(API_SESSION_KEY, JSON.stringify(meta)); } catch (e) {}
  }
  function clearApiSessionMeta() {
    try { sessionStorage.removeItem(API_SESSION_KEY); } catch (e) {}
    purgeLegacySession(API_SESSION_KEY);
  }

  function initials(name) {
    return (name || 'School').split(/\s+/).slice(0, 3).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  function logout() {
    if (DB.isApi) {
      DB.apiLogout().then(function () {
        App.user = null; App.schoolId = null; App.forbiddenMessage = null;
        App.impersonating = false; App.impExpiresAt = null;
        clearApiSessionMeta(); chooseRoleApi();
      });
      return;
    }
    App.user = null; clearSession(); chooseRole();
  }

  // ---- API mode: global 401/403 handling ----
  // Registered unconditionally (harmless in local mode — ApiAdapter is never
  // instantiated there, so these callbacks simply never fire).
  global.DB_CONFIG = global.DB_CONFIG || {};
  global.DB_CONFIG.onUnauthorized = function () {
    clearApiSessionMeta();
    App.user = null; App.schoolId = null; App.forbiddenMessage = null;
    App.impersonating = false; App.impExpiresAt = null;
    if (U && U.toast) U.toast('Your session has expired. Please sign in again.', 'warn');
    chooseRoleApi();
  };
  global.DB_CONFIG.onForbidden = function (message) {
    // The "trial/subscription ended" banner is already on screen: don't stack a
    // second red bar saying the same thing — a short popup is enough.
    if (App.license && App.license.locked && App.user) { if (U && U.toast) U.toast(message || 'Changes are switched off.', 'warn'); return; }
    App.forbiddenMessage = message || "This school's subscription is inactive.";
    if (App.user && App.ctx && App.ctx.school) { renderShell(); router(); }
    else if (U && U.toast) U.toast(App.forbiddenMessage, 'err');
  };

  // Fingerprint of each seeded demo account's UNCHANGED password hash -> its known
  // demo password. These 5 passwords are already public (README, seed.js comments) —
  // fine to auto-fill for convenience. The moment any of these 5 accounts' password is
  // reset or changed (by anyone, on any device), its stored hash changes forever and
  // stops matching here, so auto-fill silently and permanently stops for that account.
  // It never applies to accounts the school creates itself (Settings -> Access Control).
  var DEMO_CREDS = {
    'u-admin':   { hash: '13c96df114026eb5585524e418b7d24f422b5ccfb982ab5dfc4bbbc96d7293ef', password: '123' },
    'u-dir':     { hash: '6fca94685b351d4fc0de847e6bcd440abf9593fd588acda346d634fbc29a87ee', password: '123' },
    'u-teacher': { hash: 'd3f5d81d2cdb78af4cd59958e71fa09dc2fc501ddb7ca43cb75358f7c01e2327', password: '123' },
    'u-staff':   { hash: '6a8c3db8ad51f7cd31e2c327c53a993f754a714634897bf17614005f01c13f77', password: '123' },
    'u-parent':  { hash: '43715fc1427c99b4274c03a585233547449e99427b4d942dd792cc9b6fc87dee', password: '123' }
  };
  function knownDemoPassword(user) {
    var d = user && DEMO_CREDS[user.id];
    return (d && d.hash === user.password_hash) ? d.password : null;
  }

  // Try a password against every account sharing a role (no separate "which user" step —
  // the password itself, individually salted/hashed per account, identifies the account).
  // Note: if two people on the same role pick the same password, whichever is checked
  // first wins the ambiguity — schools should keep each person's password unique.
  function verifyAgainstAny(candidates, password) {
    function tryNext(i) {
      if (i >= candidates.length) return Promise.resolve(null);
      var u = candidates[i];
      return global.Auth.verifyPassword(password, u.password_salt, u.password_hash).then(function (ok) {
        return ok ? u : tryNext(i + 1);
      });
    }
    return tryNext(0);
  }

  // ---- Login: school name + user type + password (per-account, PBKDF2-hashed) ----
  function chooseRole() {
    DB.all('users').then(function (users) {
      var root = U.clear(U.$('#root'));
      var wrap = U.el('div', { class: 'login-wrap' });
      var card = U.el('div', { class: 'card' });
      var sName = App.ctx.school ? App.ctx.school.name : 'Zetclass';
      card.appendChild(U.el('div', { class: 'login-badge', text: initials(sName) }));
      card.appendChild(U.el('h1', { text: sName }));
      card.appendChild(U.el('p', { class: 'muted', text: 'Sign in with your school name, user type, and password.' }));

      var errBox = U.el('div', { class: 'login-error', style: 'display:none;color:#b3261e;font-size:.85rem;margin:.4rem 0' });

      function field(labelText, inputEl) { return U.el('div', { class: 'field' }, [U.el('label', { text: labelText }), inputEl]); }

      var schoolInput = U.el('input', { type: 'text', autocomplete: 'organization', value: sName });
      var roleSelect = U.el('select');
      roleSelect.appendChild(U.el('option', { value: '', text: 'Select user type…' }));
      var rolesSeen = [];
      users.forEach(function (u) { if (rolesSeen.indexOf(u.role) === -1) rolesSeen.push(u.role); });
      rolesSeen.forEach(function (r) { roleSelect.appendChild(U.el('option', { value: r, text: r })); });

      var passInput = U.el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });

      // If exactly one account for the chosen role is still on its untouched demo
      // password, fill it in — the user can still overwrite it with a real password.
      roleSelect.addEventListener('change', function () {
        var matches = users.filter(function (u) { return u.role === roleSelect.value; });
        var demoMatches = matches.map(knownDemoPassword).filter(Boolean);
        passInput.value = (demoMatches.length === 1) ? demoMatches[0] : '';
      });

      function showError(msg) { errBox.textContent = msg; errBox.style.display = 'block'; }

      var submitBtn = U.el('button', { class: 'btn gold', type: 'submit', text: 'Sign in' });
      function doLogin(e) {
        if (e) e.preventDefault();
        errBox.style.display = 'none';
        var schoolVal = schoolInput.value.trim();
        var roleVal = roleSelect.value;
        var passVal = passInput.value;
        if (!schoolVal || !roleVal || !passVal) { showError('Please fill in all fields.'); return; }
        var realSchoolName = ((App.ctx.school && App.ctx.school.name) || '').trim();
        if (schoolVal.toLowerCase() !== realSchoolName.toLowerCase()) {
          showError('Incorrect school name, user type, or password.'); return;
        }
        // Excludes disabled accounts (mirrors api/index.php's check at login)
        // so Settings → Demo Data → "Demo Login Accounts" actually blocks
        // sign-in in local/PWA mode too, not just in API mode.
        var candidates = users.filter(function (u) { return u.role === roleVal && !u.disabled; });
        submitBtn.disabled = true; submitBtn.textContent = 'Signing in…';
        verifyAgainstAny(candidates, passVal).then(function (user) {
          submitBtn.disabled = false; submitBtn.textContent = 'Sign in';
          if (!user) { showError('Incorrect school name, user type, or password.'); return; }
          App.user = user; saveSession(user); boot();
        });
      }

      var form = U.el('form', { class: 'form login-form', onsubmit: doLogin });
      form.appendChild(errBox);
      form.appendChild(field('School name', schoolInput));
      form.appendChild(field('User type', roleSelect));
      form.appendChild(field('Password', passInput));

      // Demo hint. Shown only while at least one seeded account is still on its
      // original password — those are already published in the README, so
      // stating them here costs nothing. The instant a school changes any of
      // them the stored hash stops matching DEMO_CREDS and this disappears for
      // good, so a real school never shows its password on the login screen.
      if (users.some(function (u) { return !!knownDemoPassword(u); })) {
        form.appendChild(U.el('div', { class: 'help', style: 'margin:-.4rem 0 .8rem', text: 'Demo password: 123 — for every user type. It fills in automatically once you pick one. Change it in Settings → Access Control before a real school uses this.' }));
      }

      form.appendChild(submitBtn);

      // Small, permanent footnote (not tied to the demo-password hint above,
      // which disappears once passwords are changed) — an Admin can clear or
      // restore the sample students/staff/inventory at any time from Settings
      // → Demo Data. Purely a testing convenience; it never touches real data.
      form.appendChild(U.el('div', { class: 'help', style: 'margin-top:.8rem;text-align:center;font-size:.75rem', text: 'This school starts with sample demo data for testing. An Admin can clear or restore it anytime in Settings → Sample Data.' }));

      card.appendChild(form);
      wrap.appendChild(brandPanel('Sign up','/signup')); wrap.appendChild(card);
      root.appendChild(wrap);
      roleSelect.focus();
    });
  }

  // ---- Change password (self-service; also used after an admin reset) ----
  function openChangePasswordModal() {
    var body = U.el('div');
    var cur = U.el('input', { type: 'password', placeholder: 'Current password' });
    var next = U.el('input', { type: 'password', placeholder: 'New password (min 8 characters)' });
    var next2 = U.el('input', { type: 'password', placeholder: 'Confirm new password' });
    function field(l, i) { return U.el('div', { class: 'field' }, [U.el('label', { text: l }), i]); }
    body.appendChild(field('Current password', cur));
    body.appendChild(field('New password', next));
    body.appendChild(field('Confirm new password', next2));
    var errBox = U.el('div', { style: 'color:#b3261e;font-size:.85rem;display:none' });
    body.appendChild(errBox);
    U.modal({
      title: 'Change password', body: body,
      actions: [
        { label: 'Cancel', onClick: function (c) { c(); } },
        { label: 'Save', kind: 'gold', onClick: function (c) {
          errBox.style.display = 'none';
          if (next.value.length < 8) { errBox.textContent = 'New password must be at least 8 characters.'; errBox.style.display = 'block'; return; }
          if (next.value !== next2.value) { errBox.textContent = 'New passwords do not match.'; errBox.style.display = 'block'; return; }
          // Re-fetch the full record for the CURRENT-password check: in API mode
          // App.user came from the login response, which deliberately omits
          // password_salt/password_hash (never sent over the wire at login).
          DB.get('users', App.user.id).then(function (fullUser) {
            return global.Auth.verifyPassword(cur.value, fullUser && fullUser.password_salt, fullUser && fullUser.password_hash);
          }).then(function (ok) {
            if (!ok) { errBox.textContent = 'Current password is incorrect.'; errBox.style.display = 'block'; return; }
            return global.Auth.hashPassword(next.value).then(function (r) {
              return DB.update('users', App.user.id, { password_salt: r.salt, password_hash: r.hash, must_change_password: false });
            }).then(function (u) {
              App.user = u;
              if (DB.isApi) { saveApiSessionMeta({ user: u, school_id: App.schoolId, role: u.role }); }
              else { saveSession(u); }
              U.toast('Password changed.'); c(); renderShell(); router();
            });
          });
        } }
      ]
    });
  }

  function accountMenu() {
    var body = U.el('div', { class: 'role-grid' });
    body.appendChild(U.el('button', { text: 'Change password', onclick: function () { m.close(); openChangePasswordModal(); } }));
    body.appendChild(U.el('button', { text: 'Log out', onclick: function () { m.close(); logout(); } }));
    var m = U.modal({ title: App.user.name + ' (' + App.user.role + ')', body: body, actions: [{ label: 'Close', onClick: function (c) { c(); } }] });
  }

  // ---- Licence/trial banner ----
  function licenseBanner() {
    var lic = App.license; if (!lic) return null;
    // A paid school is left alone until its paid period is about to run out.
    var renewSoon = lic.state === 'active' && lic.paid && lic.daysLeft >= 0 && lic.daysLeft <= 14;
    if (lic.state === 'active' && !renewSoon) return null;
    var trial = lic.state === 'trialing';
    var warn = trial || renewSoon;
    var style = 'display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.45rem .8rem;font-size:.85rem;font-weight:600;flex-wrap:wrap;'
      + (warn ? 'background:#fff7e6;color:#7a5b00;border-bottom:1px solid #f0d98c' : 'background:#fde8e8;color:#8a1c1c;border-bottom:1px solid #f3b4b4');
    var n = lic.daysLeft >= 0 ? lic.daysLeft : 0;
    var days = n + ' day' + (n === 1 ? '' : 's');
    var msg;
    if (trial) msg = 'Free trial — ' + days + ' left';
    else if (renewSoon) msg = 'Your subscription ends in ' + days + ' — renew to keep editing.';
    else if (lic.suspended) msg = 'This school’s account is suspended — view-only. Please contact Zetranova.';
    else if (lic.trial) msg = 'Your free trial has ended — view-only until you subscribe. Your data is safe.';
    else msg = 'Your subscription has ended — view-only until it is renewed. Your data is safe.';
    var bar = U.el('div', { style: style }, [U.el('span', { text: msg })]);
    if (App.user && App.user.role === 'Admin') bar.appendChild(U.el('button', { class: 'btn sm', text: warn ? 'Manage subscription' : 'How to subscribe', onclick: function () { location.hash = '#/subscription'; } }));
    return bar;
  }

  function passwordBanner() {
    if (!App.user || !App.user.must_change_password) return null;
    var style = 'display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.45rem .8rem;font-size:.85rem;font-weight:600;flex-wrap:wrap;background:#fde8e8;color:#8a1c1c;border-bottom:1px solid #f3b4b4';
    var bar = U.el('div', { style: style }, [U.el('span', { text: 'You are using a default password — please change it.' })]);
    bar.appendChild(U.el('button', { class: 'btn sm', text: 'Change password', onclick: openChangePasswordModal }));
    return bar;
  }

  // ---- API mode: subscription-inactive banner (set by DB_CONFIG.onForbidden) ----
  function forbiddenBanner() {
    if (!App.forbiddenMessage) return null;
    var style = 'display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.45rem .8rem;font-size:.85rem;font-weight:600;flex-wrap:wrap;background:#fde8e8;color:#8a1c1c;border-bottom:1px solid #f3b4b4';
    return U.el('div', { style: style }, [U.el('span', { text: App.forbiddenMessage })]);
  }

  // ---- API mode: platform-admin impersonation banner ----
  // Visible for the whole life of an impersonated session so the operator
  // never forgets they are inside a subscriber's data as that school's Admin;
  // "Exit impersonation" is the explicit control, the token's own short TTL
  // (see index.php ?r=impersonate) is the automatic backstop.
  function impersonationBanner() {
    if (!App.impersonating) return null;
    var style = 'display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.45rem .8rem;font-size:.85rem;font-weight:600;flex-wrap:wrap;background:#eef2ff;color:#1e3a8a;border-bottom:1px solid #c7d2fe';
    var msg = 'Impersonating this school as Admin (platform session)';
    if (App.impExpiresAt) { msg += ' — expires ' + new Date(App.impExpiresAt).toLocaleTimeString(); }
    var bar = U.el('div', { style: style }, [U.el('span', { text: msg })]);
    bar.appendChild(U.el('button', { class: 'btn sm', text: 'Exit impersonation', onclick: exitImpersonation }));
    return bar;
  }
  function exitImpersonation() {
    DB.apiLogout().then(function () {
      App.user = null; App.schoolId = null; App.impersonating = false; App.impExpiresAt = null;
      App.forbiddenMessage = null;
      clearApiSessionMeta();
      App.isAdminArea = true; // land back in the platform area, not this school's login
      startAdmin();
    });
  }

  // ---- Shell ----
  function renderShell() {
    var root = U.clear(U.$('#root'));

    var topbar = U.el('div', { class: 'topbar' }, [
      U.el('button', { class: 'menu-btn', html: '&#9776;', 'aria-label': 'Menu', onclick: toggleSidebar }),
      U.el('div', { class: 'school-name' }, [
        document.createTextNode(App.ctx.school.name),
        U.el('small', { text: App.ctx.academic.year + ' · ' + App.termName() })
      ]),
      U.el('div', { class: 'spacer' }),
      U.el('button', { class: 'role-pill', text: App.user.name + ' (' + App.user.role + ') ▾', onclick: accountMenu })
    ]);

    var sidebar = U.el('div', { class: 'sidebar', id: 'sidebar' });
    sidebar.appendChild(U.el('div', { class: 'brand', text: 'Zetclass · ' + (App.ctx.school.motto || '') }));
    var nav = U.el('nav');
    MODULES.forEach(function (m) {
      var allowed = App.can(m);
      var a = U.el('a', { href: '#/' + ROUTES[m], class: allowed ? '' : 'disabled', 'data-mod': m }, [
        U.el('span', { class: 'ico', text: ICONS[m] || '•' }),
        document.createTextNode(m)
      ]);
      if (!allowed) a.addEventListener('click', function (e) { e.preventDefault(); U.toast('Your role cannot access ' + m, 'warn'); });
      else a.addEventListener('click', closeSidebar);
      nav.appendChild(a);
    });
    if (App.user.role === 'Admin' || App.user.role === 'Director') {
      var subA = U.el('a', { href: '#/subscription', 'data-mod': 'Subscription' }, [U.el('span', { class: 'ico', text: ICONS.Subscription }), document.createTextNode('Subscription')]);
      subA.addEventListener('click', closeSidebar);
      nav.appendChild(subA);
    }
    sidebar.appendChild(nav);
    sidebar.appendChild(U.el('div', { style: 'margin-top:auto;padding:1rem;font-size:.72rem;opacity:.6', text: 'v1.0 · ' + (DB.isApi ? 'API mode' : 'Local mode') }));

    var backdrop = U.el('div', { class: 'backdrop', id: 'backdrop', onclick: closeSidebar });
    var main = U.el('main', { class: 'main', id: 'view' });

    root.appendChild(topbar);
    var lb = licenseBanner(); if (lb) root.appendChild(lb);
    var pb = passwordBanner(); if (pb) root.appendChild(pb);
    var fb = forbiddenBanner(); if (fb) root.appendChild(fb);
    var ib = impersonationBanner(); if (ib) root.appendChild(ib);
    root.appendChild(sidebar);
    root.appendChild(backdrop);
    root.appendChild(main);
  }

  function toggleSidebar() { U.$('#sidebar').classList.toggle('open'); U.$('#backdrop').classList.toggle('show'); }
  function closeSidebar() { var s = U.$('#sidebar'); if (s) { s.classList.remove('open'); U.$('#backdrop').classList.remove('show'); } }

  function setActive(route) {
    U.$all('.sidebar a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#/' + route);
    });
  }

  // ============================================================
  // Path-based routing: /:slug/... and /admin/...
  // ============================================================
  // NOT A TRUST BOUNDARY. This only ever reads the URL to (a) pre-fill which
  // school's login screen renders, and (b) remember which section to land on
  // right after login. Nothing derived from this URL is ever sent to the
  // server as something to be trusted: school_id reaches ?r=auth/login purely
  // as a LOOKUP HINT (see store.js ApiAdapter.login's comment), and every
  // route after login is scoped solely by the signed token it returns. A
  // wrong or hostile slug in the address bar can, at worst, pre-fill the
  // wrong login form or fail to find a matching user — it can never grant
  // access to another school's data once a session exists.
  //
  // There is no /school/ prefix: a school's slug sits directly at the root
  // (zetclass.com/indigo-academy) instead of zetclass.com/school/indigo-academy.
  // Because there's no namespace separating "this is a school" from "this is
  // a real page," every word that might ever become a real top-level route
  // (or already means something, like /admin) must be reserved here so a
  // school's slug can never collide with one. api/index.php's ?r=provision
  // enforces the SAME list server-side, so a colliding slug can never be
  // created in the first place either — add new reserved words to BOTH.
  var RESERVED_SLUGS = [
    'admin', 'school', 'api', 'app', 'login', 'logout', 'signup', 'register', 'forgot-password', 'reset-password',
    'pricing', 'about', 'contact', 'help', 'support', 'www', 'blog', 'terms',
    'privacy', 'docs', 'status', 'assets', 'static'
  ];
  function parsePathRoute() {
    var path = (global.location && global.location.pathname) || '/';
    var parts = path.split('/').filter(Boolean); // drop leading/trailing slashes
    if (parts[0] === 'admin') {
      return { area: 'admin', subRoute: parts[1] || null };
    }
    if (parts[0] && parts[0].toLowerCase() === 'signup') {
      return { area: 'signup' };
    }
    if (parts[0] && parts[0].toLowerCase() === 'forgot-password') { return { area: 'forgot' }; }
    if (parts[0] && parts[0].toLowerCase() === 'reset-password')  { return { area: 'reset' }; }
    if (parts[0] && RESERVED_SLUGS.indexOf(parts[0].toLowerCase()) === -1) {
      var slug = decodeURIComponent(parts[0]);
      var sub = parts[1] || null; // 'login', 'dashboard', 'students', ... (mirrors ROUTES)
      return { area: 'school', slug: slug, subRoute: (sub && sub !== 'login') ? sub : null };
    }
    return { area: 'root' };
  }
  // Local mode ignores the URL entirely — path-based tenant selection only
  // means anything once there is more than one tenant to select (API mode).
  function applyPathRoute() {
    var r = parsePathRoute();
    // Ask crawlers not to index the owner console or a school portal, even if
    // one is opened directly. This backs up /robots.txt. NEITHER is a security
    // control — anyone can still type the address. They only keep these URLs
    // out of search results, which is the usual way an admin page gets found.
    // The real controls are server-side (own hostname + IP allowlist / VPN /
    // HTTP Basic Auth + 2FA) and are documented in DEPLOY.md.
    if (r.area === 'admin' || r.area === 'school') {
      var noIndex = document.createElement('meta');
      noIndex.setAttribute('name', 'robots');
      noIndex.setAttribute('content', 'noindex, nofollow');
      document.head.appendChild(noIndex);
    }
    if (!DB.isApi) return;
    if (r.area === 'admin') {
      App.isAdminArea = true;
      App.pendingAdminHash = r.subRoute ? ('#/' + r.subRoute) : null;
    } else if (r.area === 'signup') {
      App.isSignupArea = true;
    } else if (r.area === 'forgot') {
      App.isForgotArea = true;
    } else if (r.area === 'reset') {
      App.isResetArea = true;
    } else if (r.area === 'school') {
      App.schoolIdHint = r.slug;
      // Cosmetic-only label for the PRE-login screen — the real school name
      // is only known after login, from an authenticated App.refresh() call.
      App.schoolSlugLabel = r.slug.replace(/^sch-/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      App.pendingHash = r.subRoute ? ('#/' + r.subRoute) : null;
    }
  }

  // ---- Router ----
  function router() {
    var hash = (location.hash || '#/dashboard').replace(/^#\//, '');
    var parts = hash.split('/');
    var route = parts[0] || 'dashboard';
    // find module for route
    var module = Object.keys(ROUTES).filter(function (k) { return ROUTES[k] === route; })[0];
    if (!module) { location.hash = '#/dashboard'; return; }
    if (!App.can(module)) { U.toast('No access to ' + module, 'warn'); location.hash = '#/dashboard'; return; }
    setActive(route);
    var view = global.Views[route];
    var container = U.clear(U.$('#view'));
    if (!view) { container.appendChild(U.el('div', { class: 'placeholder-page', text: 'Module not found.' })); return; }
    container.appendChild(U.el('div', { class: 'loader', text: 'Loading…' }));
    Promise.resolve(view.render(container, parts.slice(1))).catch(function (e) {
      console.error(e);
      U.clear(container).appendChild(U.el('div', { class: 'card', html: '<h3>Something went wrong</h3><pre style="white-space:pre-wrap">' + U.esc(e.message || e) + '</pre>' }));
    });
  }

  function boot() {
    App.refresh().then(function () {
      return (global.License ? global.License.resolve() : Promise.resolve(null));
    }).then(function (lic) {
      App.license = lic;
      renderShell();
      // One-shot: land on the URL's intended section (e.g. /school/x/students),
      // then clear it so ordinary in-app navigation is unaffected afterwards.
      if (App.pendingHash) { location.hash = App.pendingHash; App.pendingHash = null; }
      router();
      // Automation "night clerk": routine admin done automatically (Settings → Automation).
      if (global.Automation) {
        global.Automation.runAll().then(function (acts) {
          if (acts && acts.length) router(); // re-render current view with fresh data
        }).catch(function (e) { console.error('Automation error:', e); });
      }
    }).catch(function (e) {
      // In API mode, a 401 on the very first authenticated call (expired/invalid
      // saved token) already triggered onUnauthorized above — this just stops it
      // from surfacing as a noisy unhandled promise rejection.
      console.error('Boot error:', e);
    });
  }

  // ---- API-mode login screen: School ID + Username + Password ----
  // Distinct from chooseRole() (local mode) because the two modes have genuinely
  // different trust models: local mode's browser already holds every account's
  // data, so guessing a role and trying its password client-side costs nothing.
  // API mode must not fetch other users' password hashes to the client just to
  // guess among them — it needs a real username, verified server-side.
  function chooseRoleApi() {
    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card' });
    var label = App.schoolSlugLabel || 'Zetclass';
    card.appendChild(U.el('div', { class: 'login-badge', text: initials(label) }));
    card.appendChild(U.el('h1', { text: label }));
    card.appendChild(U.el('p', { class: 'muted', text: 'Sign in to your school portal.' }));

    var errBox = U.el('div', { class: 'login-error', style: 'display:none;color:#b3261e;font-size:.85rem;margin:.4rem 0' });
    function field(labelText, inputEl) { return U.el('div', { class: 'field' }, [U.el('label', { text: labelText }), inputEl]); }

    // school_id is only ever a LOOKUP HINT for the login call (pre-filled by a
    // URL-slug router when present) — the server never trusts it for anything
    // beyond finding this school's user by username; every route after login
    // is scoped purely by the signed token, never by anything the client sends.
    var schoolInput = U.el('input', { type: 'text', value: App.schoolIdHint || '', placeholder: 'e.g. st-marys-school', autocapitalize: 'none', spellcheck: 'false' });
    var userInput = U.el('input', { type: 'text', autocomplete: 'username', placeholder: 'Username' });
    var passInput = U.el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });

    function showError(msg) { errBox.textContent = msg; errBox.style.display = 'block'; }

    var submitBtn = U.el('button', { class: 'btn gold', type: 'submit', text: 'Sign in' });
    function doLogin(e) {
      if (e) e.preventDefault();
      errBox.style.display = 'none';
      var schoolVal = schoolInput.value.trim();
      var userVal = userInput.value.trim();
      var passVal = passInput.value;
      if (!userVal || !passVal) { showError('Please enter your username and password.'); return; }
      submitBtn.disabled = true; submitBtn.textContent = 'Signing in…';
      DB.apiLogin(userVal, passVal, schoolVal).then(function (res) {
        submitBtn.disabled = false; submitBtn.textContent = 'Sign in';
        App.user = res.user; App.schoolId = res.school_id; App.forbiddenMessage = null;
        saveApiSessionMeta({ user: res.user, school_id: res.school_id, role: res.role });
        boot();
      }).catch(function (err) {
        submitBtn.disabled = false; submitBtn.textContent = 'Sign in';
        // 401 = the server could not match school + username + password. Say that
        // in everyday words, naming all three since any one of them can be the typo.
        showError(err && err.status === 401
          ? 'We could not sign you in. Please check the school address, username and password, then try again.'
          : ((err && err.message) || 'Something went wrong. Please try again.'));
      });
    }

    var form = U.el('form', { class: 'form login-form', onsubmit: doLogin });
    form.appendChild(errBox);
    var schoolField = field('School address', schoolInput);
    schoolField.appendChild(U.el('div', { class: 'help', text: 'The last part of your school’s web address, e.g. st-marys-school' }));
    form.appendChild(schoolField);
    form.appendChild(field('Username', userInput));
    // Show/Hide on the password, so people on a phone can check what they typed.
    var showBtn = U.el('button', { type: 'button', class: 'pw-toggle', text: 'Show', 'aria-label': 'Show password', onclick: function () {
      var show = passInput.type === 'password';
      passInput.type = show ? 'text' : 'password';
      showBtn.textContent = show ? 'Hide' : 'Show';
      showBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } });
    form.appendChild(U.el('div', { class: 'field' }, [U.el('label', { text: 'Password' }), U.el('div', { class: 'pw-wrap' }, [passInput, showBtn])]));
    form.appendChild(U.el('div', { style: 'text-align:right;margin:-.4rem 0 .6rem' }, [
      U.el('a', { href: '/forgot-password' + (App.schoolIdHint ? '?school=' + encodeURIComponent(App.schoolIdHint) : ''), class: 'forgot-link', text: 'Forgot password?' })
    ]));
    form.appendChild(submitBtn);

    card.appendChild(form);
    // New schools: a clear, friendly way in — this is the front door of the product.
    var trialDays = (global.License && global.License.TRIAL_DAYS) || 30;
    card.appendChild(U.el('div', { class: 'login-alt' }, [
      U.el('span', { text: 'New to Zetclass? ' }),
      U.el('a', { href: '/signup', text: 'Sign up and start your free ' + trialDays + '-day trial' })
    ]));
    var support = supportLine();
    card.appendChild(U.el('p', { class: 'help login-alt', text: 'Teachers, staff and parents who forgot their password: ask your school’s administrator to reset it' + (support ? '. Need help? ' + support : '.') }));
    card.appendChild(U.el('p', { class: 'help login-alt' }, [U.el('a', { href: '/terms.html', text: 'Terms of Service' }), document.createTextNode(' · '), U.el('a', { href: '/privacy.html', text: 'Privacy Notice' })]));
    wrap.appendChild(brandPanel('Sign up','/signup')); wrap.appendChild(card);
    root.appendChild(wrap);
    // Land on the first EMPTY box so a returning visitor can just start typing.
    (schoolInput.value ? userInput : schoolInput).focus();
  }

  // ============================================================
  // Self-service signup  (zetclass.com/signup)
  //
  // Deliberately plain: one short form, five answers, nothing optional.
  //   - Labels sit ABOVE each box, with an example inside it.
  //   - Mistakes are explained under the box in plain words, as you leave it,
  //     not in one scary list after pressing the button.
  //   - Phones get the number keyboard, the password has a Show button.
  //   - The server re-checks everything (api/index.php ?r=register); this
  //     screen's checks are only there to save the person a round trip.
  // ============================================================
  function supportLine() {
    var c = global.ZETCLASS_CONTACT || {}, bits = [];
    if (c.whatsapp) bits.push('WhatsApp ' + c.whatsapp);
    if (c.phone) bits.push('Call ' + c.phone);
    if (c.email) bits.push(c.email);
    return bits.join(' · ');
  }
  App.supportLine = supportLine;

  // Small inline icons (no image files to download).
  var ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>',
    warn:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    lock:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>'
  };
  function icon(name, tag, cls) { var n = U.el(tag || 'span', cls ? { class: cls } : {}); n.innerHTML = ICON[name]; return n; }

  // The left-hand brand panel on desktop, a slim brand bar on phones. Shared by every sign-in /
  // register / password screen so they all feel like one product. (linkText/linkHref: the small
  // link in the phone bar, e.g. "Sign in".)
  function brandPanel(linkText, linkHref) {
    var trialDays = (global.License && global.License.TRIAL_DAYS) || 30;
    var panel = U.el('aside', { class: 'auth-brand' });
    panel.appendChild(U.el('div', { class: 'brand-top' }, [U.el('a', { class: 'auth-wordmark', href: '/', text: 'Zetclass' })]));
    if (linkText) panel.appendChild(U.el('a', { class: 'brand-mobile-link', href: linkHref, text: linkText }));
    var points = U.el('ul', { class: 'brand-points' });
    [trialDays + '-day free trial. No card or payment details needed.',
     'Every school’s records are private and kept separate.',
     'Ready in about two minutes. Sample data helps you explore.'].forEach(function (t) {
      var li = U.el('li'); li.appendChild(icon('check')); li.appendChild(U.el('span', { text: t })); points.appendChild(li);
    });
    panel.appendChild(U.el('div', { class: 'brand-body' }, [
      U.el('h2', { text: 'Run your whole school from one place.' }),
      U.el('p', { text: 'Pupils, attendance, report cards, fees, stock and accounts — on any phone or computer.' }),
      points
    ]));
    panel.appendChild(U.el('div', { class: 'brand-foot' }, [document.createTextNode('© Zetranova Limited, Ghana · '),
      U.el('a', { href: '/terms.html', text: 'Terms' }), document.createTextNode(' · '), U.el('a', { href: '/privacy.html', text: 'Privacy' })]));
    return panel;
  }

  // Mirror of the server's rules (valid_* functions in api/index.php).
  function signupChecks(v) {
    return {
      school_name: function () {
        var s = v.school_name().replace(/\s+/g, ' ').trim();
        if (s.length < 3) return 'Please enter your school’s full name.';
        if (!/[A-Za-zÀ-ɏ]/.test(s)) return 'The school name must contain letters.';
        if (/[<>]/.test(s)) return 'The school name cannot contain < or >.';
        return '';
      },
      email: function () {
        var s = v.email().trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? '' : 'Please enter a valid email address, like name@example.com.';
      },
      phone: function () {
        var p = v.phone();
        if (!p) return 'Please enter your phone number.';
        if (p.charAt(0) !== '+') return 'Please include your country code, for example +233 24 123 4567.';
        var d = p.replace(/\D+/g, '');
        return (d.length >= 9 && d.length <= 15 && d.charAt(0) !== '0') ? '' : 'Please enter a valid phone number with its country code, for example +233 24 123 4567.';
      },
      // Optional: empty is fine; if something is typed it must be a full international number.
      whatsapp: function () {
        var p = v.whatsapp ? v.whatsapp() : '';
        if (!p) return '';
        var d = p.replace(/\D+/g, '');
        return (p.charAt(0) === '+' && d.length >= 9 && d.length <= 15 && d.charAt(0) !== '0') ? '' : 'Please check the WhatsApp number, or leave it empty.';
      },
      password: function () {
        var p = v.password();
        if (p.length < 8) return 'Your password needs at least 8 characters.';
        return '';
      }
    };
  }

  function startSignup() {
    // Someone already signed in to a school who opens /signup: take them to
    // their school instead of showing a form they do not need.
    var meta = loadApiSessionMeta();
    if (DB.isApi && meta && DB.hasApiToken() && meta.role !== 'Platform') { startApi(); return; }
    chooseSignup();
  }

  // A plain-English password hint. It NEVER stops anyone from registering (only a 6-character
  // minimum does): it just tells the person how to make the password stronger.
  function passwordTip(p) {
    var common = /^(password|passw0rd|123456|12345678|qwerty|abc123|letmein|welcome|iloveyou|admin|school|zetclass)/i.test(p);
    var score = (p.length >= 8 ? 1 : 0) + (p.length >= 12 ? 1 : 0) + (/[a-z]/.test(p) && /[A-Z]/.test(p) ? 1 : 0) + (/\d/.test(p) ? 1 : 0) + (/[^A-Za-z0-9]/.test(p) ? 1 : 0);
    if (common) score = Math.min(score, 1);
    if (!p) return { level: 'none', text: 'Tip: 10 or more characters with capital letters, numbers and a symbol (like ! or #) is strongest.' };
    if (score <= 2) return { level: 'weak', text: 'Weak password. You can still register, but add a number, a capital letter and a symbol (like ! or #), and use 10 or more characters to protect your school.' };
    if (score === 3) return { level: 'ok', text: 'Fair. Add a symbol (like ! or #) or a few more characters to make it strong.' };
    return { level: 'strong', text: 'Strong password.' };
  }
  function bindPasswordTip(input, el, meter) {
    var colours = { none: '', weak: '#b3261e', ok: '#8a6410', strong: '#1b6b3a' };
    function paint() { var t = passwordTip(input.value); el.textContent = t.text; el.style.color = colours[t.level]; el.style.fontWeight = t.level === 'none' ? '' : '600'; if (meter) meter.setAttribute('data-level', t.level); }
    input.addEventListener('input', paint); paint();
  }

  function chooseSignup() {
    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card wide' });
    var trialDays = (global.License && global.License.TRIAL_DAYS) || 30;
    card.appendChild(U.el('h1', { text: 'Register' }));
    card.appendChild(U.el('h2', { text: 'Start your free trial' }));
    card.appendChild(U.el('p', { class: 'muted', text: 'Set up your school in about 2 minutes. Free for ' + trialDays + ' days — no payment details needed.' }));
    card.appendChild(U.el('p', { class: 'help', style: 'margin-top:-.3rem' }, [U.el('span', { text: '*', style: 'color:#c0261b;font-weight:700' }), document.createTextNode(' marks a required field. Everything else is optional.')]));

    // The message box sits just ABOVE the Create button (added below), so whatever goes
    // wrong appears exactly where the person just clicked, never off-screen at the top.
    var alertBox = U.el('div', { class: 'login-error', role: 'alert', style: 'display:none;color:#8a1c14;background:#fdecea;border:1px solid #e8a49d;border-radius:8px;padding:.7rem .85rem;font-size:.95rem;font-weight:600;margin:.6rem 0 .8rem' });
    var form = U.el('form', { class: 'form login-form', novalidate: true });

    var inputs = {}, errEls = {};
    // `control` is what goes on screen (the input itself, or the input plus a
    // Show/Hide button); `input` is the box whose value/errors we track.
    // `req`: true = required (red * and “Required” underneath), false = “Optional” underneath.
    function reqNote(req) { return U.el('div', { class: 'field-req', text: req ? 'Required' : 'Optional', style: 'font-size:.75rem;margin-top:.15rem;color:' + (req ? '#c0261b' : 'var(--muted,#6b7a78)') }); }
    function reqStar() { return U.el('span', { text: ' *', style: 'color:#c0261b;font-weight:700', 'aria-hidden': 'true' }); }
    // Fields are grouped under small headings; `grid` is the group being filled (null = straight into the form).
    var grid = null;
    function section(title, twoCols) {
      form.appendChild(U.el('div', { class: 'auth-sec', text: title }));
      grid = U.el('div', { class: 'auth-grid' + (twoCols ? ' two' : '') });
      form.appendChild(grid);
    }
    function addField(key, label, input, help, control, req) {
      input.id = 'f-' + key; input.name = key;
      var err = U.el('div', { class: 'field-error', id: 'err-' + key, 'aria-live': 'polite' });
      input.setAttribute('aria-describedby', 'err-' + key);
      inputs[key] = input; errEls[key] = err;
      var lab = U.el('label', { for: 'f-' + key, text: label });
      if (req === true) { lab.appendChild(reqStar()); input.setAttribute('aria-required', 'true'); }
      var kids = [lab, control || input, err];
      if (req !== undefined) kids.push(reqNote(req));
      if (help) kids.push(U.el('div', { class: 'help', text: help }));
      var box = U.el('div', { class: 'field' }, kids);
      (grid || form).appendChild(box);
      return box;
    }
    function setError(key, msg) {
      errEls[key].textContent = msg || '';
      inputs[key].classList.toggle('input-error', !!msg);
      if (msg) inputs[key].setAttribute('aria-invalid', 'true'); else inputs[key].removeAttribute('aria-invalid');
    }

    var schoolIn = U.el('input', { type: 'text', autocomplete: 'organization', placeholder: 'e.g. St. Mary’s Basic School', maxlength: '120' });
    var emailIn  = U.el('input', { type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'school@example.com', maxlength: '160', autocapitalize: 'none', spellcheck: 'false' });

    // COUNTRY: one dropdown. Choosing it fills in the dialling code on both phone boxes, so the person only
    // types the main number. Ghana is pre-selected. The number is saved in full international form (+233…).
    var COUNTRIES = (App.COUNTRIES = ('Ghana|+233;Nigeria|+234;Togo|+228;Côte d’Ivoire|+225;Burkina Faso|+226;Benin|+229;Sierra Leone|+232;Liberia|+231;Gambia|+220;Senegal|+221;' +
      'Kenya|+254;Uganda|+256;Tanzania|+255;Rwanda|+250;Ethiopia|+251;Zambia|+260;Zimbabwe|+263;Malawi|+265;Mozambique|+258;Botswana|+267;Namibia|+264;South Africa|+27;' +
      'Cameroon|+237;Gabon|+241;Congo|+242;DR Congo|+243;Angola|+244;Guinea|+224;Mali|+223;Niger|+227;Mauritania|+222;Cape Verde|+238;Egypt|+20;Morocco|+212;Tunisia|+216;Algeria|+213;Sudan|+249;South Sudan|+211;' +
      'United Kingdom|+44;United States|+1;Canada|+1;Ireland|+353;France|+33;Germany|+49;Netherlands|+31;Belgium|+32;Spain|+34;Italy|+39;Portugal|+351;Switzerland|+41;Sweden|+46;Norway|+47;Denmark|+45;' +
      'United Arab Emirates|+971;Saudi Arabia|+966;Qatar|+974;Turkey|+90;India|+91;Pakistan|+92;Bangladesh|+880;Sri Lanka|+94;China|+86;Japan|+81;South Korea|+82;Singapore|+65;Malaysia|+60;Philippines|+63;Indonesia|+62;' +
      'Australia|+61;New Zealand|+64;Brazil|+55;Jamaica|+1876;Trinidad and Tobago|+1868;Barbados|+1246').split(';').map(function (s) { var p = s.split('|'); return { name: p[0], code: p[1] }; }));
    var REGIONS_GH = ['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East', 'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'];
    var countrySel = U.el('select', { autocomplete: 'country-name' });
    COUNTRIES.forEach(function (c) { countrySel.appendChild(U.el('option', { value: c.name, text: c.name })); });
    function dialCode() { var c = COUNTRIES.filter(function (x) { return x.name === countrySel.value; })[0]; return c ? c.code : ''; }

    // A phone box with a fixed, read-only "+233" in front. With a country chosen, the box takes ONLY the main
    // number: digits only, no "+", no country code (typed or pasted ones are removed), no leading 0.
    // 024 350 6373 -> 243506373.
    function makePhone(placeholder) {
      var input = U.el('input', { type: 'tel', autocomplete: 'tel-national', inputmode: 'numeric', placeholder: placeholder, maxlength: '20', style: 'flex:1;min-width:0' });
      var prefix = U.el('span', { class: 'phone-prefix', 'aria-hidden': 'true', style: 'flex:none;display:flex;align-items:center;padding:0 .7rem;border:1px solid var(--line,#cfd8d6);border-radius:8px;background:#eef3f2;font-weight:600;white-space:nowrap' });
      function tidy() {
        var raw = input.value, d = raw.replace(/\D+/g, ''), code = dialCode().replace(/\D+/g, '');
        var hadPlus = raw.trim().charAt(0) === '+';
        if (code && d.indexOf(code) === 0 && (hadPlus || d.length >= code.length + 9)) d = d.slice(code.length);
        input.value = d.replace(/^0+/, '');
      }
      function composed() { tidy(); return input.value ? dialCode() + input.value : ''; }
      function refresh() { prefix.textContent = dialCode(); tidy(); }
      input.addEventListener('input', tidy);
      refresh();
      return { input: input, prefix: prefix, composed: composed, refresh: refresh, box: U.el('div', { style: 'display:flex;gap:.4rem' }, [prefix, input]) };
    }
    var phoneBox = makePhone('e.g. 24 123 4567');
    var waBox = makePhone('e.g. 24 123 4567');
    var phoneIn = phoneBox.input, waIn = waBox.input;
    var composedPhone = phoneBox.composed;
    var passIn   = U.el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Choose a password', maxlength: '128' });

    section('Your school');
    addField('school_name', 'School name', schoolIn, '', null, true);
    addField('country', 'Country', countrySel, 'Choosing your country adds its dialling code to the phone numbers below.', null, true);
    section('How we can reach you', true);
    addField('email', 'School email address', emailIn, 'Your password-reset link is sent here.', null, true).classList.add('span2');
    addField('phone', 'School phone number (for calls)', phoneIn, 'Type only the main number, e.g. 24 123 4567. The code is added for you.', phoneBox.box, true);
    addField('whatsapp', 'WhatsApp number (optional)', waIn, 'Only if it differs from the phone. Leave empty if none.', waBox.box, false);
    countrySel.value = 'Ghana';
    countrySel.addEventListener('change', function () {
      phoneBox.refresh(); waBox.refresh(); paintRegion();
      if (errEls.phone.textContent) setError('phone', checks.phone());
      if (errEls.whatsapp.textContent) setError('whatsapp', checks.whatsapp());
    });

    // OPTIONAL location details, tucked away so the form stays short: region, district, area, postal address.
    // Ghana gets the list of its 16 regions; other countries type the region / state / province.
    var regionHost = U.el('div');
    var regionIn;
    function paintRegion() {
      U.clear(regionHost);
      if (countrySel.value === 'Ghana') {
        regionIn = U.el('select', { id: 'f-region', name: 'region' }, [U.el('option', { value: '', text: 'Select region…' })].concat(REGIONS_GH.map(function (r) { return U.el('option', { value: r, text: r }); })));
      } else {
        regionIn = U.el('input', { type: 'text', id: 'f-region', name: 'region', maxlength: '80', placeholder: 'Region / state / province', autocomplete: 'address-level1' });
      }
      regionHost.appendChild(regionIn);
    }
    paintRegion();
    var districtIn = U.el('input', { type: 'text', id: 'f-district', name: 'district', maxlength: '80', placeholder: 'e.g. Ayawaso West', autocomplete: 'address-level2' });
    var localityIn = U.el('input', { type: 'text', id: 'f-locality', name: 'locality', maxlength: '120', placeholder: 'Town, suburb or area, e.g. East Legon' });
    var postalIn   = U.el('textarea', { id: 'f-postal_address', name: 'postal_address', rows: '2', maxlength: '200', placeholder: 'e.g. P. O. Box 123, Accra, or street address / digital address (GA-123-4567)', autocomplete: 'street-address' });
    var websiteIn  = U.el('input', { type: 'text', id: 'f-website', name: 'website', maxlength: '200', placeholder: 'e.g. www.myschool.edu.gh', autocomplete: 'url', autocapitalize: 'none', spellcheck: 'false', inputmode: 'url' });
    function optField(label, node) { return U.el('div', { class: 'field' }, [U.el('label', { text: label }), node, reqNote(false)]); }
    var locationDetails = (U.el('details', { class: 'optional-details', style: 'margin:.2rem 0 .8rem' }, [
      U.el('summary', { text: 'Add website, region and postal address', style: 'cursor:pointer;font-weight:600;color:var(--teal-dark,#0f5e5e)' }),
      U.el('div', { class: 'help', text: 'Helps us find and serve you, and prints on report cards. You can add or change these later in Settings.', style: 'margin:.4rem 0' }),
      optField('Website', websiteIn), optField('Region', regionHost), optField('District', districtIn), optField('Locality / area', localityIn), optField('Postal address', postalIn)
    ]));
    // The password box gets a Show/Hide button instead of a "type it twice" box:
    // fewer fields, and people can simply see what they typed.
    var toggle = U.el('button', { type: 'button', class: 'pw-toggle', text: 'Show', 'aria-label': 'Show password', onclick: function () {
      var show = passIn.type === 'password';
      passIn.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } });
    section('Secure your account');
    addField('password', 'Create a password', passIn, '',
      U.el('div', { class: 'pw-wrap' }, [passIn, toggle]), true);
    // Live strength tip (advice only: it never blocks the signup).
    var pwHelp = U.el('div', { class: 'help' });
    inputs.password.closest('.field').appendChild(pwHelp);
    var pwMeter = U.el('div', { class: 'pw-meter', 'aria-hidden': 'true' }, [U.el('i'), U.el('i'), U.el('i'), U.el('i')]);
    inputs.password.closest('.field').insertBefore(pwMeter, pwHelp);
    bindPasswordTip(passIn, pwHelp, pwMeter);
    grid = null;
    form.appendChild(U.el('div', { class: 'auth-sec', text: 'Optional details' }));
    form.appendChild(locationDetails);

    // Honeypot: invisible to people, tempting to bots. Server rejects it if filled.
    // (Named so browser autofill does not recognise it as a form field to fill in.)
    var hp = U.el('input', { type: 'text', name: 'zc_extra_note', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    form.appendChild(U.el('div', { class: 'hp-field', 'aria-hidden': 'true' }, [U.el('label', { text: 'Leave this empty' }), hp]));

    var checks = signupChecks({
      school_name: function () { return schoolIn.value; },
      email: function () { return emailIn.value; }, phone: composedPhone, whatsapp: waBox.composed, password: function () { return passIn.value; }
    });
    var order = ['school_name', 'email', 'phone', 'whatsapp', 'password'];
    order.forEach(function (k) {
      inputs[k].addEventListener('blur', function () { if (inputs[k].value) setError(k, checks[k]()); });
      // Clear a shown error as soon as the person starts fixing it.
      inputs[k].addEventListener('input', function () { if (errEls[k].textContent) setError(k, checks[k]()); });
    });

    // "Before you start": three tick boxes, each a tappable card.
    form.appendChild(U.el('div', { class: 'auth-sec', text: 'Before you start' }));

    // Optional: start with pretend pupils/parents/staff/stock to explore. Ticked by
    // default because an empty school is hard to judge; removing it is one click.
    var sampleBox = U.el('input', { type: 'checkbox', id: 'f-sample', checked: true });
    form.appendChild(U.el('div', { class: 'field' }, [
      U.el('label', { for: 'f-sample', class: 'check-card' }, [sampleBox, U.el('span', { text: 'Start with sample data so I can explore' })]),
      U.el('div', { class: 'help', text: 'Adds a few pretend pupils, fees, attendance, scores, stock and accounts so you can try every screen. Remove it in one click from your dashboard or Settings.' }),
      reqNote(false)
    ]));

    // Required: the person confirms they may register this school (the server checks this too),
    // with a short warning about false claims. Shown BEFORE the Terms box.
    var authBox = U.el('input', { type: 'checkbox', id: 'f-authority' });
    var authErr = U.el('div', { class: 'field-error', id: 'err-authority', 'aria-live': 'polite' });
    var warn = U.el('div', { class: 'notice-warn', role: 'note' }, [icon('warn'), U.el('span', { text: 'Registering a school you are not authorised to represent, or pretending to be someone you are not, is a false claim. You can be held personally liable for any loss, your account may be closed, and it may be reported to the authorities under Ghana law.' })]);
    form.appendChild(U.el('div', { class: 'field' }, [
      U.el('label', { for: 'f-authority', class: 'check-card' }, [
        authBox,
        U.el('span', {}, [document.createTextNode('I am the owner or an authorised representative of this school, and I am allowed to register it.'), reqStar()])
      ]),
      reqNote(true),
      authErr,
      warn
    ]));
    authBox.addEventListener('change', function () { if (authBox.checked) authErr.textContent = ''; });

    // Required: accept the Terms of Service and Privacy Notice (the server checks this too).
    var termsBox = U.el('input', { type: 'checkbox', id: 'f-terms' });
    var termsErr = U.el('div', { class: 'field-error', id: 'err-terms', 'aria-live': 'polite' });
    form.appendChild(U.el('div', { class: 'field' }, [
      U.el('label', { for: 'f-terms', class: 'check-card' }, [
        termsBox,
        U.el('span', {}, [document.createTextNode('I agree to the '), U.el('a', { href: '/terms.html', target: '_blank', rel: 'noopener', text: 'Terms of Service' }), document.createTextNode(' and '), U.el('a', { href: '/privacy.html', target: '_blank', rel: 'noopener', text: 'Privacy Notice' }), reqStar()])
      ]),
      reqNote(true),
      termsErr
    ]));
    termsBox.addEventListener('change', function () { if (termsBox.checked) termsErr.textContent = ''; });

    var btn = U.el('button', { class: 'btn gold', type: 'submit', text: 'Create my school' });
    form.appendChild(alertBox);
    form.appendChild(btn);
    form.appendChild(U.el('div', { class: 'secure-line' }, [icon('lock'), U.el('span', { text: 'Your school’s records stay private to your school.' })]));

    // Show a message next to the button and bring it into view.
    function showAlert(msg, stayPut) {
      alertBox.textContent = msg; alertBox.style.display = 'block';
      if (stayPut) return;
      try { alertBox.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* older browser: message is still shown */ }
    }
    // Bring a box that needs fixing into view, so the red border can actually be seen.
    function goTo(input) {
      try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
      input.focus({ preventScroll: true });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      alertBox.style.display = 'none';
      var firstBad = null;
      order.forEach(function (k) { var m = checks[k](); setError(k, m); if (m && !firstBad) firstBad = k; });
      if (!authBox.checked) { authErr.textContent = 'Please confirm that you are the owner or an authorised representative of this school.'; }
      if (!termsBox.checked) { termsErr.textContent = 'Please tick the box to accept the Terms of Service and Privacy Notice.'; if (!firstBad) termsBox.focus(); }
      if (firstBad) { showAlert(checks[firstBad](), true); goTo(inputs[firstBad]); return; }
      if (!authBox.checked) { showAlert('Please confirm that you are the owner or an authorised representative of this school.'); return; }
      if (!termsBox.checked) { showAlert('Please tick the box to accept the Terms of Service and Privacy Notice.'); return; }
      var payload = {
        confirm_authority: true,
        accept_terms: true,
        school_name: schoolIn.value.replace(/\s+/g, ' ').trim(),
        email: emailIn.value.trim(), phone: composedPhone(), whatsapp: waBox.composed(), country: countrySel.value, website: websiteIn.value.trim(),
        region: (regionIn.value || '').trim(), district: districtIn.value.trim(), locality: localityIn.value.trim(), postal_address: postalIn.value.trim(),
        password: passIn.value, company_website: hp.value
      };
      btn.disabled = true; btn.textContent = 'Creating your school…';
      DB.apiRegister(payload).then(function (res) {
        if (!sampleBox.checked || !global.SampleData) return res;
        btn.textContent = 'Adding sample data…';
        // A failure here must never undo the signup: the school exists either way,
        // and sample data can be added later from Settings → Sample Data.
        return global.SampleData.load().then(function () { res.sample_data = true; return res; }, function () { return res; });
      }).then(function (res) {
        showSignupWelcome(res);
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'Create my school';
        var f = err && err.body && err.body.fields, firstField = null;
        if (f) order.forEach(function (k) { if (f[k]) { setError(k, f[k]); if (!firstField) firstField = k; } });
        // ALWAYS say something beside the button, with the technical code so it can be reported.
        var msg = (err && err.message) || 'Something went wrong. Please try again.';
        if (f) {
          var other = Object.keys(f).filter(function (k) { return order.indexOf(k) < 0; }).map(function (k) { return f[k]; });
          if (other.length) msg = other.join(' ');
          else if (firstField) msg = f[firstField];
        }
        showAlert(msg + (err && err.status ? '  (code ' + err.status + ')' : ''));
        if (firstField) inputs[firstField].focus();
      });
    });

    card.appendChild(form);
    var support = supportLine();
    card.appendChild(U.el('div', { class: 'login-alt' }, [
      U.el('span', { text: 'Already have a school? ' }),
      U.el('a', { href: '/', text: 'Sign in' })
    ]));
    if (support) card.appendChild(U.el('p', { class: 'help login-alt', text: 'Need help? ' + support }));
    wrap.appendChild(brandPanel('Sign in','/')); wrap.appendChild(card);
    root.appendChild(wrap);
    schoolIn.focus({ preventScroll: true });   // put the cursor in the first box WITHOUT scrolling the page to it
  }

  // The moment after signup: tell them exactly what they now have and where to
  // find it again (the #1 thing new users lose is their school's address).
  function showSignupWelcome(res) {
    App.user = res.user; App.schoolId = res.school_id; App.forbiddenMessage = null;
    App.schoolIdHint = res.school_id; App.schoolSlugLabel = res.school_name;
    saveApiSessionMeta({ user: res.user, school_id: res.school_id, role: res.role });

    var address = global.location.origin + '/' + res.school_id;
    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card' });
    card.appendChild(U.el('div', { class: 'login-badge', text: '✓' }));
    card.appendChild(U.el('h1', { text: 'Your school is ready' }));
    card.appendChild(U.el('p', { class: 'muted', text: res.school_name + ' is set up with a ' + res.trial_days + '-day free trial.' }));

    function row(label, value) {
      return U.el('div', { class: 'welcome-row' }, [U.el('div', { class: 'welcome-label', text: label }), U.el('div', { class: 'welcome-value', text: value })]);
    }
    var box = U.el('div', { class: 'welcome-box' }, [
      row('Your school’s web address', address),
      row('Your username', 'admin'),
      row('Your password', 'the one you just chose'),
      row('Free trial ends', U.fmtDate(res.trial_ends_at))
    ]);
    card.appendChild(box);
    card.appendChild(U.el('p', { class: 'help', text: 'Save these details. Next time, go to your web address and sign in with the username and password above.' }));
    if (res.sample_data) card.appendChild(U.el('p', { class: 'help', text: 'We added a few sample records in every area so you can explore. Remove them any time with the “Remove sample data” button on your dashboard.' }));

    var copyText = 'Zetclass — ' + res.school_name + '\nWeb address: ' + address + '\nUsername: admin\nFree trial ends: ' + res.trial_ends_at;
    var copyBtn = U.el('button', { class: 'btn ghost', type: 'button', text: 'Copy these details', onclick: function () {
      var done = function () { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy these details'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copyText).then(done, function () { U.toast('Could not copy — please write the address down.', 'warn'); });
      else U.toast('Could not copy — please write the address down.', 'warn');
    } });
    var openBtn = U.el('button', { class: 'btn gold', type: 'button', text: 'Open my school', onclick: function () {
      try { global.history.replaceState(null, '', '/' + res.school_id); } catch (e) { /* address bar stays; app still works */ }
      App.isSignupArea = false;
      boot();
    } });
    card.appendChild(U.el('div', { class: 'welcome-actions' }, [openBtn, copyBtn]));
    wrap.appendChild(brandPanel()); wrap.appendChild(card);
    root.appendChild(wrap);
    openBtn.focus();
  }

  // ============================================================
  // Forgot password  (zetclass.com/forgot-password) and
  // Choose a new password  (zetclass.com/reset-password?school=...&token=...)
  //
  // School Administrators get a one-hour, single-use link by email (sent to the
  // address the school signed up with). Everyone else — teachers, staff, parents —
  // asks their own school Administrator, who can reset them in Settings > Access
  // Control. The server answers "forgot" the same way whether or not the account
  // exists, so these screens cannot be used to find out who has an account.
  // ============================================================
  function queryParam(name) {
    try { return new URLSearchParams(global.location.search).get(name) || ''; } catch (e) { return ''; }
  }

  function chooseForgot() {
    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card' });
    card.appendChild(U.el('div', { class: 'login-badge', text: '?' }));
    card.appendChild(U.el('h1', { text: 'Forgot your password?' }));
    card.appendChild(U.el('p', { class: 'muted', text: 'School administrators: we will email a reset link to the address your school signed up with.' }));

    var alertBox = U.el('div', { class: 'login-error', role: 'alert', style: 'display:none;color:#b3261e;font-size:.85rem;margin:.4rem 0 .8rem' });
    var schoolIn = U.el('input', { type: 'text', id: 'f-school', value: queryParam('school') || App.schoolIdHint || '', placeholder: 'e.g. st-marys-school', autocapitalize: 'none', spellcheck: 'false' });
    var userIn = U.el('input', { type: 'text', id: 'f-user', value: queryParam('school') || App.schoolIdHint ? 'admin' : '', placeholder: 'admin', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'username' });
    var btn = U.el('button', { class: 'btn gold', type: 'submit', text: 'Send me a reset link' });
    var form = U.el('form', { class: 'form login-form', novalidate: true });
    form.appendChild(alertBox);
    form.appendChild(U.el('div', { class: 'field' }, [U.el('label', { for: 'f-school', text: 'School address' }), schoolIn,
      U.el('div', { class: 'help', text: 'The last part of your school’s web address, e.g. st-marys-school' })]));
    form.appendChild(U.el('div', { class: 'field' }, [U.el('label', { for: 'f-user', text: 'Username' }), userIn,
      U.el('div', { class: 'help', text: 'Administrators usually use “admin”.' })]));
    form.appendChild(btn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      alertBox.style.display = 'none';
      var school = schoolIn.value.trim().toLowerCase(), user = userIn.value.trim();
      if (!school || !user) { alertBox.textContent = 'Please enter your school address and username.'; alertBox.style.display = 'block'; (school ? userIn : schoolIn).focus(); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      DB.apiForgotPassword(school, user).then(function (res) {
        showForgotSent(school, res && res.message);
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'Send me a reset link';
        alertBox.textContent = (err && err.message) || 'Something went wrong. Please try again.'; alertBox.style.display = 'block';
      });
    });

    card.appendChild(form);
    card.appendChild(U.el('div', { class: 'login-alt' }, [U.el('a', { href: schoolIn.value ? '/' + encodeURIComponent(schoolIn.value) : '/', text: '← Back to sign in' })]));
    card.appendChild(U.el('p', { class: 'help login-alt', text: 'Teachers, staff and parents: ask your school’s administrator to reset your password (Settings → Access Control).' }));
    wrap.appendChild(brandPanel('Sign in','/')); wrap.appendChild(card);
    root.appendChild(wrap);
    (schoolIn.value ? userIn : schoolIn).focus();
  }

  function showForgotSent(school, message) {
    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card' });
    var support = supportLine();
    card.appendChild(U.el('div', { class: 'login-badge', text: '✉' }));
    card.appendChild(U.el('h1', { text: 'Check your email' }));
    card.appendChild(U.el('p', { class: 'muted', text: message || 'If that is a school Administrator account, a reset link has been sent to the school’s registered email address.' }));
    card.appendChild(U.el('ul', { class: 'start-steps', style: 'list-style:disc;text-align:left' }, [
      U.el('li', { text: 'The link works once and lasts one hour.' }),
      U.el('li', { text: 'Not there after a few minutes? Look in Spam or Junk.' }),
      U.el('li', { text: 'No email at all? ' + (support ? 'Contact us — ' + support + ' — and we will verify your school and help you in.' : 'Contact Zetranova support and we will verify your school and help you in.') })
    ]));
    card.appendChild(U.el('div', { class: 'welcome-actions' }, [U.el('a', { class: 'btn gold', href: '/' + encodeURIComponent(school), text: 'Back to sign in' })]));
    wrap.appendChild(brandPanel('Sign in','/')); wrap.appendChild(card);
    root.appendChild(wrap);
  }

  function chooseReset() {
    var school = queryParam('school').trim().toLowerCase();
    var token = queryParam('token').trim();
    // Take the one-time token out of the address bar (and browser history) right away.
    try { global.history.replaceState(null, '', '/reset-password'); } catch (e) { /* not critical */ }

    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card' });
    card.appendChild(U.el('div', { class: 'login-badge', text: '🔑' }));
    card.appendChild(U.el('h1', { text: 'Choose a new password' }));
    if (!school || !/^[0-9a-f]{64}$/.test(token)) {
      card.appendChild(U.el('p', { class: 'muted', text: 'This link is incomplete. Please open the link in your email again, or ask for a new one.' }));
      card.appendChild(U.el('div', { class: 'welcome-actions' }, [U.el('a', { class: 'btn gold', href: '/forgot-password', text: 'Ask for a new link' })]));
      wrap.appendChild(brandPanel('Sign in','/')); wrap.appendChild(card); root.appendChild(wrap); return;
    }
    card.appendChild(U.el('p', { class: 'muted', text: 'For the school “' + school + '”. Pick something you will remember.' }));

    var alertBox = U.el('div', { class: 'login-error', role: 'alert', style: 'display:none;color:#b3261e;font-size:.85rem;margin:.4rem 0 .8rem' });
    var passIn = U.el('input', { type: 'password', id: 'f-newpass', autocomplete: 'new-password', placeholder: 'Choose a new password', maxlength: '128' });
    var pwHelp2 = U.el('div', { class: 'help' });
    bindPasswordTip(passIn, pwHelp2);
    var err = U.el('div', { class: 'field-error', 'aria-live': 'polite' });
    var toggle = U.el('button', { type: 'button', class: 'pw-toggle', text: 'Show', 'aria-label': 'Show password', onclick: function () {
      var show = passIn.type === 'password'; passIn.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show'; toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } });
    var btn = U.el('button', { class: 'btn gold', type: 'submit', text: 'Save new password' });
    var form = U.el('form', { class: 'form login-form', novalidate: true });
    form.appendChild(alertBox);
    form.appendChild(U.el('div', { class: 'field' }, [U.el('label', { for: 'f-newpass', text: 'New password' }), U.el('div', { class: 'pw-wrap' }, [passIn, toggle]), err,
      pwHelp2]));
    form.appendChild(btn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      alertBox.style.display = 'none'; err.textContent = ''; passIn.classList.remove('input-error');
      if (passIn.value.length < 8) { err.textContent = 'Your password needs at least 8 characters.'; passIn.classList.add('input-error'); passIn.focus(); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      DB.apiResetPassword(school, token, passIn.value).then(function () {
        U.clear(card);
        card.appendChild(U.el('div', { class: 'login-badge', text: '✓' }));
        card.appendChild(U.el('h1', { text: 'Password changed' }));
        card.appendChild(U.el('p', { class: 'muted', text: 'You can sign in with your new password now.' }));
        card.appendChild(U.el('div', { class: 'welcome-actions' }, [U.el('a', { class: 'btn gold', href: '/' + encodeURIComponent(school), text: 'Go to sign in' })]));
      }).catch(function (e2) {
        btn.disabled = false; btn.textContent = 'Save new password';
        var f = e2 && e2.body && e2.body.fields;
        if (f && f.password) { err.textContent = f.password; passIn.classList.add('input-error'); passIn.focus(); return; }
        alertBox.textContent = (e2 && e2.message) || 'Something went wrong. Please try again.'; alertBox.style.display = 'block';
        if (e2 && e2.status === 400) alertBox.appendChild(U.el('div', {}, [U.el('a', { href: '/forgot-password?school=' + encodeURIComponent(school), text: 'Ask for a new link' })]));
      });
    });
    card.appendChild(form);
    wrap.appendChild(brandPanel('Sign in','/')); wrap.appendChild(card);
    root.appendChild(wrap);
    passIn.focus();
  }

  // ---- Platform super-admin area (/admin/...) ----
  // Deliberately rendered OUTSIDE renderShell()/router(): a platform account
  // has no school context (App.ctx, permissions, the 12-module sidebar all
  // assume a school), so trying to force it through the existing shell would
  // be more awkward than just giving it its own small entry point.
  function startAdmin() {
    var meta = loadApiSessionMeta();
    if (meta && meta.role === 'Platform' && DB.hasApiToken()) {
      App.user = meta.user || { name: 'Platform', role: 'Platform' };
      renderAdminDashboard();
    } else {
      chooseRoleAdmin();
    }
  }
  function chooseRoleAdmin() {
    var root = U.clear(U.$('#root'));
    var wrap = U.el('div', { class: 'login-wrap' });
    var card = U.el('div', { class: 'card' });
    card.appendChild(U.el('div', { class: 'login-badge', text: 'ZP' }));
    card.appendChild(U.el('h1', { text: 'Zetranova Platform' }));
    card.appendChild(U.el('p', { class: 'muted', text: 'Owner / developer sign-in.' }));
    var errBox = U.el('div', { class: 'login-error', style: 'display:none;color:#b3261e;font-size:.85rem;margin:.4rem 0' });
    function field(l, i) { return U.el('div', { class: 'field' }, [U.el('label', { text: l }), i]); }
    var userInput = U.el('input', { type: 'text', autocomplete: 'username', placeholder: 'Platform username' });
    var passInput = U.el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
    function showError(msg) { errBox.textContent = msg; errBox.style.display = 'block'; }
    var submitBtn = U.el('button', { class: 'btn gold', type: 'submit', text: 'Sign in' });
    function doLogin(e) {
      if (e) e.preventDefault();
      errBox.style.display = 'none';
      var u = userInput.value.trim(), p = passInput.value;
      if (!u || !p) { showError('Please enter your username and password.'); return; }
      submitBtn.disabled = true; submitBtn.textContent = 'Signing in…';
      DB.apiLogin(u, p, null).then(function (res) {
        submitBtn.disabled = false; submitBtn.textContent = 'Sign in';
        if (res.role !== 'Platform') { showError('This account is not a platform account.'); return; }
        // The platform login response has no `user` object (see index.php) —
        // it's a cross-school account, not a school user record.
        App.user = res.user || { name: 'Platform', role: 'Platform' };
        saveApiSessionMeta({ user: App.user, school_id: null, role: 'Platform' });
        renderAdminDashboard();
      }).catch(function (err) {
        submitBtn.disabled = false; submitBtn.textContent = 'Sign in';
        showError((err && err.message) || 'Incorrect username or password.');
      });
    }
    var form = U.el('form', { class: 'form login-form', onsubmit: doLogin });
    form.appendChild(errBox);
    form.appendChild(field('Username', userInput));
    form.appendChild(field('Password', passInput));
    form.appendChild(submitBtn);
    card.appendChild(form);
    wrap.appendChild(brandPanel()); wrap.appendChild(card);
    root.appendChild(wrap);
    userInput.focus();
  }
  // ---- Platform dashboard ----
  // The owner console itself now lives in js/platform.js — its own file,
  // because it has no school context and is growing its own screens
  // (subscription, per-user accounts, activity log). app.js keeps only the
  // platform LOGIN above, then hands over, passing the three things
  // platform.js cannot reach from outside this closure: who is signed in,
  // how to log out, and how to switch this browser into an impersonated
  // school session.
  function renderAdminDashboard() {
    if (!global.Platform || !global.Platform.render) {
      var root = U.clear(U.$('#root'));
      root.appendChild(U.el('div', { class: 'login-wrap' }, [
        U.el('div', { class: 'card' }, [
          U.el('h1', { text: 'Platform console unavailable' }),
          U.el('p', { class: 'muted', text: 'js/platform.js did not load — check its <script> tag in index.html.' })
        ])
      ]));
      return;
    }
    global.Platform.render({
      user: App.user,
      onLogout: function () {
        DB.apiLogout().then(function () { App.user = null; clearApiSessionMeta(); chooseRoleAdmin(); });
      },
      onImpersonate: function (res) {
        App.user = res.user; App.schoolId = res.school_id; App.forbiddenMessage = null;
        App.impersonating = true; App.impExpiresAt = res.expires_at;
        saveApiSessionMeta({ user: res.user, school_id: res.school_id, role: res.role, imp: true, imp_expires_at: res.expires_at });
        App.isAdminArea = false;
        boot();
      }
    });
  }

  global.App = App;
  global.Views = global.Views || {};

  window.addEventListener('hashchange', function () { if (App.user) router(); });
  window.addEventListener('DOMContentLoaded', start);
  applyPathRoute(); // must run before start()/startApi()/startAdmin() below
  function start() {
    if (App.isAdminArea) { startAdmin(); return; }
    if (App.isSignupArea) { startSignup(); return; }
    if (App.isForgotArea) { chooseForgot(); return; }
    if (App.isResetArea) { chooseReset(); return; }
    if (DB.isApi) { startApi(); return; }
    App.refresh().then(function () {
      var s = loadSession();
      if (s) {
        // re-fetch fresh user record
        DB.all('users').then(function (users) {
          var u = users.filter(function (x) { return x.id === s.id; })[0] || s;
          App.user = u; boot();
        });
      } else chooseRole();
    });
  }

  // API mode: NEVER call App.refresh() before a token exists — every route it
  // touches (school/academic/etc.) requires Authorization, and there is no
  // token yet on a fresh visit. Restore a saved session's metadata (if any)
  // and let boot() -> App.refresh() be the first authenticated call; a stale
  // token surfaces there as a 401 and onUnauthorized routes back to login.
  function startApi() {
    var meta = loadApiSessionMeta();
    // The address bar names a school (zetclass.com/<school>) but the saved sign-in
    // belongs to a different school (or to the developer console): never show
    // school A's data under school B's address. Drop that sign-in and ask for the
    // login of the school in the address. (Only the pre-selected address counts;
    // the plain home page keeps whatever session the browser already has.)
    if (meta && DB.hasApiToken() && App.schoolIdHint && meta.school_id !== App.schoolIdHint) {
      meta = null;
      clearApiSessionMeta();
      DB.apiLogout();
    }
    if (meta && DB.hasApiToken()) {
      App.user = meta.user; App.schoolId = meta.school_id;
      App.impersonating = !!meta.imp; App.impExpiresAt = meta.imp_expires_at || null;
      boot();
    } else {
      chooseRoleApi();
    }
  }
  // In case DOMContentLoaded already fired
  if (document.readyState !== 'loading') start();
})(window);
