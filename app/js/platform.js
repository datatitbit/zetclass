/* ============================================================
 * platform.js — Zetranova owner / developer console (the "/admin" area).
 *
 * This is the OWNER plane, not a school's plane. It is deliberately kept in
 * its own file and rendered outside the normal app shell (renderShell/router
 * in app.js), because a platform account has no school context at all: no
 * App.ctx, no role permissions, no 12-module sidebar. app.js owns the
 * platform LOGIN and hands control here afterwards via Platform.render().
 *
 * Everything here calls DB.platform* (see store.js). The server re-checks the
 * caller's platform claim on every one of those routes — nothing on this
 * screen is a security boundary, it is only the operator's control surface.
 * Every action taken here is written to the server's platform_audit log.
 *
 * Layout: a short overview (counts), a searchable list of schools, and ONE
 * "Manage" screen per school that holds everything you can do to it:
 *   Subscription (extend trial, record payment, plan) · Contact & notes ·
 *   Login accounts (enable/disable, reset password) · Support tools
 *   (log in as the school, suspend, reset data).
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB;
  var el = U.el;

  // Callbacks supplied by app.js: { user, onLogout, onImpersonate }.
  var HOOKS = {};

  var PLANS = ['basic', 'growth', 'premium'];
  var PLAN_LABEL = { basic: 'Basic', growth: 'Growth', premium: 'Premium' };
  var STATE_LABEL = { active: 'Active (paid)', trialing: 'Free trial', expired: 'Ended', suspended: 'Suspended' };
  var STATE_COLOR = { active: '#0f5e5e', trialing: '#8a6410', expired: '#b91c1c', suspended: '#b91c1c' };
  // Numbers typed without a "+" (e.g. 024 123 4567) are treated as Ghana numbers
  // when building WhatsApp links, because that is where schools are.
  var DEFAULT_COUNTRY_CODE = '233';
  // One school term, for the payment shortcuts. Ghana terms run about 3 months;
  // 120 days leaves a little margin so a school is not locked out on the last day.
  var TERM_DAYS = 120;

  var schools = [];                 // last list from the server
  var view = { q: '', filter: 'all' };

  function field(label, input, help) {
    var kids = [el('label', { text: label }), input];
    if (help) kids.push(el('div', { class: 'help', text: help }));
    return el('div', { class: 'field' }, kids);
  }
  function errBox() { return el('div', { style: 'color:#b3261e;font-size:.85rem;display:none;margin:.3rem 0' }); }
  function showErr(box, msg) { box.textContent = msg; box.style.display = 'block'; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function addDays(ymd, n) { return new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function fmt(ymd) { return ymd ? U.fmtDate(ymd) : '—'; }
  function msgOf(err, fallback) { return (err && err.message) || fallback; }

  // School name -> URL slug: lowercase, hyphens between words, letters/numbers
  // only, truncated at a whole word (never mid-word) so long names still read
  // cleanly. Mirrors slugify_school_name() in api/index.php, which is the real
  // safety backstop (reserved-word + format check) if this suggestion is
  // edited or bypassed.
  function slugify(name, maxLen) {
    maxLen = maxLen || 40;
    var s = String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length > maxLen) { s = s.slice(0, maxLen).replace(/-[^-]*$/, '').replace(/-+$/, ''); }
    return s;
  }

  // wa.me wants digits only, with the country code and no leading 0 or "+".
  function waLink(phone, text) {
    var raw = String(phone || '').trim();
    var digits = raw.replace(/\D+/g, '');
    if (!digits) return null;
    if (raw.charAt(0) !== '+') {
      if (digits.charAt(0) === '0') digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
    }
    return 'https://wa.me/' + digits + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  function stateChip(row) {
    var label = STATE_LABEL[row.state] || row.state || '—';
    return el('span', { class: 'tag', style: 'background:' + (STATE_COLOR[row.state] || '#666') + ';color:#fff', text: label });
  }

  // One human-readable line about where a school stands. A past end date is
  // reported as "ended on ..." rather than a negative countdown ("-33d left"),
  // which reads as a bug.
  function subLine(row, longForm) {
    if (row.state === 'suspended') return longForm ? 'Suspended by you — nobody at this school can sign in.' : 'suspended';
    var d = row.days_left;
    if (row.paid_until) {
      if (d !== null && d !== undefined && d < 0) return (longForm ? 'Paid period ended on ' : 'ended ') + row.paid_until;
      return (longForm ? 'Paid until ' : 'paid until ') + row.paid_until + (d !== null && d !== undefined ? ' — ' + d + ' day' + (d === 1 ? '' : 's') + ' left' : '');
    }
    if (row.trial_ends_at) {
      if (d === null || d === undefined) return (longForm ? 'Free trial ends ' : 'ends ') + row.trial_ends_at;
      if (d < 0) return (longForm ? 'Free trial ended on ' : 'ended ') + row.trial_ends_at;
      return longForm
        ? ('Free trial ends ' + row.trial_ends_at + ' — ' + d + ' day' + (d === 1 ? '' : 's') + ' left')
        : ('ends ' + row.trial_ends_at + ' · ' + d + 'd left');
    }
    return longForm ? 'No end date set (treated as fully active).' : 'no end date';
  }

  /* ---------------- Shell ---------------- */

  function render(hooks) {
    HOOKS = hooks || {};
    var root = U.clear(U.$('#root'));

    root.appendChild(el('div', { class: 'topbar' }, [
      el('div', { class: 'school-name' }, [document.createTextNode('Zetranova Platform')]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'role-pill', text: ((HOOKS.user && HOOKS.user.name) || 'Platform') + ' ▾', onclick: accountMenu })
    ]));

    var wrap = el('div', { style: 'padding:1.2rem;max-width:1150px;margin:0 auto' });
    var head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.8rem' });
    head.appendChild(el('h1', { text: 'Schools', style: 'margin:0' }));
    head.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Activity log', onclick: function () { openAuditModal(null); } }),
      el('button', { class: 'btn gold', text: '+ Add school', onclick: openProvisionModal })
    ]));
    wrap.appendChild(head);
    wrap.appendChild(el('div', { id: 'plat-requests' }));
    wrap.appendChild(el('div', { id: 'plat-tiles' }));
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { id: 'plat-toolbar' }));
    card.appendChild(el('div', { id: 'plat-schools' }, [el('div', { class: 'loader', text: 'Loading…' })]));
    wrap.appendChild(card);
    root.appendChild(wrap);

    loadSchools();
  }

  function accountMenu() {
    var body = el('div', { class: 'role-grid' });
    body.appendChild(el('button', { text: 'Log out', onclick: function () { m.close(); if (HOOKS.onLogout) HOOKS.onLogout(); } }));
    var m = U.modal({ title: 'Platform account', body: body, actions: [{ label: 'Close', onClick: function (c) { c(); } }] });
  }

  /* ---------------- Overview + list ---------------- */

  function isNew(s) { return s.created_at && (Date.now() - Date.parse(s.created_at)) < 7 * 86400000; }
  function endingSoon(s) {
    var running = s.state === 'trialing' || (s.state === 'active' && s.paid_until);
    return running && s.days_left !== null && s.days_left !== undefined && s.days_left >= 0 && s.days_left <= 7;
  }
  var FILTERS = [
    ['all', 'All schools', function () { return true; }],
    ['trial', 'Free trial', function (s) { return s.state === 'trialing'; }],
    ['paid', 'Paid', function (s) { return s.state === 'active'; }],
    ['ending', 'Ending within 7 days', endingSoon],
    ['ended', 'Ended', function (s) { return s.state === 'expired'; }],
    ['suspended', 'Suspended', function (s) { return s.state === 'suspended'; }],
    ['new', 'New this week', isNew]
  ];
  function filterFn(key) { return (FILTERS.filter(function (f) { return f[0] === key; })[0] || FILTERS[0])[2]; }

  function loadSchools() {
    var host = U.$('#plat-schools');
    if (!host) return Promise.resolve();
    return DB.platformSchoolsList().then(function (rows) {
      schools = rows || [];
      paintTiles(); paintToolbar(); paintTable(); loadRequests();
    }).catch(function (err) {
      var h = U.$('#plat-schools');
      if (h) U.clear(h).appendChild(el('p', { style: 'color:#b3261e', text: 'Could not load schools: ' + msgOf(err, 'error') }));
    });
  }

  // Administrators who pressed "Forgot password". The emailed link is the normal route;
  // this list is the safety net - a school whose email never arrives (or has none on
  // file) can still be helped after you verify them by phone or WhatsApp.
  function loadRequests() {
    var host = U.$('#plat-requests'); if (!host) return;
    DB.platformRequests().then(function (rows) {
      var h = U.$('#plat-requests'); if (!h) return;
      U.clear(h);
      if (!rows || !rows.length) return;
      var card = el('div', { class: 'card', style: 'margin-bottom:1rem;border-left:4px solid #8a6410' }, [
        el('h3', { text: 'Password help requests (' + rows.length + ')' }),
        el('div', { class: 'help', text: 'These administrators pressed “Forgot password”. If their email does not arrive, confirm it really is the school (call or WhatsApp the number on file), then issue a temporary password.' })
      ]);
      rows.forEach(function (r) {
        var emailNote = r.email_sent ? 'email sent' : (r.email ? 'email NOT delivered' : 'no email on file');
        var wa = r.phone ? waLink(r.phone, 'Hello' + (r.contact_name ? ' ' + r.contact_name : '') + ', this is Zetranova. We received a request to reset the Zetclass password for ' + (r.school_name || 'your school') + '. Was this you?') : null;
        var actions = el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn sm gold', text: 'Issue temporary password', onclick: function () {
            if (!global.confirm('Issue a temporary password for ' + (r.school_name || r.school_id) + ' (' + r.username + ')?\n\nOnly do this once you are sure the request is genuine - for example by calling the number on file.')) return;
            DB.platformResetPassword(r.school_id, r.user_id).then(function (res) {
              showCredentials('Temporary password', { name: r.school_name, phone: r.phone }, Object.assign({ school_id: r.school_id }, res));
              loadRequests();
            }).catch(function (err) { U.toast(msgOf(err, 'Could not reset the password.'), 'err'); });
          } }),
          wa ? el('a', { class: 'btn sm ghost', href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp them' }) : null,
          el('button', { class: 'btn sm ghost', text: 'Dismiss', onclick: function () {
            DB.platformDismissRequest(r.id).then(function () { loadRequests(); }).catch(function (err) { U.toast(msgOf(err, 'Could not dismiss.'), 'err'); });
          } })
        ]);
        card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.55rem 0;border-top:1px solid var(--line)' }, [
          el('div', {}, [
            el('div', { style: 'font-weight:700', text: (r.school_name || r.school_id) + ' — ' + r.username }),
            el('div', { class: 'muted', style: 'font-size:.78rem', text: 'asked ' + (r.requested_at || '').slice(0, 16).replace('T', ' ') + ' UTC · ' + emailNote + (r.phone ? ' · ' + r.phone : '') })
          ]),
          actions
        ]));
      });
      h.appendChild(card);
    }).catch(function () { /* older server without this route: stay quiet */ });
  }

  // Counts at a glance; click one to filter the list to it.
  function paintTiles() {
    var host = U.$('#plat-tiles'); if (!host) return;
    U.clear(host);
    // auto-fit keeps all six counts on one row when there is room, and wraps tidily on a phone.
    var grid = el('div', { class: 'grid', style: 'margin-bottom:1rem;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))' });
    [['all', 'Schools'], ['trial', 'On free trial'], ['paid', 'Paid'], ['ending', 'Ending ≤ 7 days'], ['ended', 'Ended'], ['suspended', 'Suspended']].forEach(function (t) {
      var n = schools.filter(filterFn(t[0])).length;
      var tile = el('div', { class: 'stat kpi-link' + (view.filter === t[0] ? ' accent' : ''), role: 'button', tabindex: '0' }, [
        el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: t[1] })]);
      function pick() { view.filter = t[0]; paintTiles(); paintToolbar(); paintTable(); }
      tile.addEventListener('click', pick);
      tile.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      grid.appendChild(tile);
    });
    host.appendChild(grid);
  }

  function paintToolbar() {
    var host = U.$('#plat-toolbar'); if (!host) return;
    U.clear(host);
    var search = el('input', { type: 'search', class: 'search', placeholder: 'Search name, email, phone or address…', value: view.q, 'aria-label': 'Search schools' });
    search.addEventListener('input', function () { view.q = search.value; paintTable(); });
    var sel = el('select', { 'aria-label': 'Show' });
    FILTERS.forEach(function (f) { var o = el('option', { value: f[0], text: f[1] }); if (f[0] === view.filter) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { view.filter = sel.value; paintTiles(); paintTable(); });
    host.appendChild(el('div', { class: 'toolbar' }, [search, sel]));
  }

  function matches(s, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return [s.name, s.id, s.email, s.phone, s.contact_name].some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
  }

  function paintTable() {
    var h = U.$('#plat-schools'); if (!h) return;
    U.clear(h);
    if (!schools.length) {
      h.appendChild(el('p', { class: 'muted', text: 'No schools yet. Schools appear here as soon as they sign up at zetclass.com/signup, or you can add one with “+ Add school”.' }));
      return;
    }
    var fn = filterFn(view.filter);
    var rows = schools.filter(function (s) { return fn(s) && matches(s, view.q); });
    if (!rows.length) { h.appendChild(el('p', { class: 'muted', text: 'No schools match.' })); return; }

    var table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, [el('tr', {}, ['School', 'Contact', 'Subscription', 'Plan', ''].map(function (t) { return el('th', { text: t }); }))]));
    var tb = el('tbody');
    rows.forEach(function (s) { tb.appendChild(schoolRow(s)); });
    table.appendChild(tb);
    h.appendChild(el('div', { class: 'table-wrap' }, [table]));
    h.appendChild(el('div', { class: 'help', text: rows.length + ' of ' + schools.length + ' school' + (schools.length === 1 ? '' : 's') }));
  }

  function schoolRow(s) {
    var nameCell = el('td', {}, [
      el('div', { style: 'font-weight:700', text: s.name || '—' }),
      el('div', { class: 'muted', style: 'font-size:.75rem' }, [document.createTextNode('/' + s.id + ' · joined ' + fmt((s.created_at || '').slice(0, 10)) + (s.created_via === 'self-signup' ? ' · signed up' : '') + ' ')].concat(isNew(s) ? [el('span', { class: 'tag req', text: 'New' })] : []).concat(s.verified_at ? [document.createTextNode(' '), el('span', { class: 'tag', style: 'background:#0f5e5e;color:#fff', text: 'Verified' })] : (s.created_via === 'self-signup' ? [document.createTextNode(' '), el('span', { class: 'tag', style: 'background:#fdecc8;color:#8a6410', text: s.licence_no ? 'Check licence' : 'Not verified' })] : [])))
    ]);

    var contact = el('td', { style: 'font-size:.82rem' });
    if (s.contact_name) contact.appendChild(el('div', { text: s.contact_name }));
    if (s.email) contact.appendChild(el('div', {}, [el('a', { href: 'mailto:' + s.email, text: s.email })]));
    if (s.phone) {
      var wa = waLink(s.phone);
      contact.appendChild(el('div', {}, [el('a', { href: 'tel:' + s.phone, text: s.phone }), wa ? document.createTextNode(' · ') : null, wa ? el('a', { href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp' }) : null]));
    }
    if (!s.contact_name && !s.email && !s.phone) contact.appendChild(el('span', { class: 'muted', text: '—' }));

    var subCell = el('td', {}, [stateChip(s), el('div', { class: 'muted', style: 'font-size:.72rem;margin-top:.2rem', text: subLine(s, false) })]);

    return el('tr', {}, [
      nameCell, contact, subCell,
      el('td', { text: PLAN_LABEL[s.plan] || s.plan || '—' }),
      el('td', { class: 'actions' }, [el('button', { class: 'btn sm gold', text: 'Manage', onclick: function () { openManageModal(s.id); } })])
    ]);
  }

  /* ---------------- Credentials hand-over (shown ONCE) ---------------- */

  function copyToClipboard(text, btn, label) {
    var done = function () { btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = label; }, 2000); };
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) global.navigator.clipboard.writeText(text).then(done, function () { U.toast('Could not copy — select and copy it by hand.', 'warn'); });
    else U.toast('Could not copy — select and copy it by hand.', 'warn');
  }

  // Shows a one-time temporary password. It is never stored in readable form
  // and never written to the activity log, so this is the only time it exists.
  function showCredentials(title, schoolRow, res) {
    var address = global.location.origin + '/' + res.school_id;
    var body = el('div');
    body.appendChild(el('p', { class: 'note', text: 'Give these to the school now. The temporary password is shown only once — after you close this, it cannot be looked up again (you can always issue a new one). The school must change it when they first sign in.' }));
    function row(l, v, mono) {
      return el('div', { style: 'margin:.45rem 0' }, [el('div', { class: 'muted', style: 'font-size:.75rem', text: l }), el('div', { style: 'font-weight:700;word-break:break-all;' + (mono ? 'font-family:monospace;font-size:1.15rem;letter-spacing:.04em' : ''), text: v })]);
    }
    body.appendChild(row('Portal address', address));
    body.appendChild(row('Username', res.username || 'admin'));
    body.appendChild(row('Temporary password', res.temp_password, true));
    var text = 'Zetclass sign-in details' + (schoolRow && schoolRow.name ? ' for ' + schoolRow.name : '') + '\nPortal address: ' + address + '\nUsername: ' + (res.username || 'admin') + '\nTemporary password: ' + res.temp_password + '\n(You will be asked to choose your own password when you sign in.)';
    var actions = el('div', { class: 'btn-row', style: 'margin-top:.8rem' });
    var copyBtn = el('button', { class: 'btn', type: 'button', text: 'Copy details', onclick: function () { copyToClipboard(text, copyBtn, 'Copy details'); } });
    actions.appendChild(copyBtn);
    var wa = schoolRow && schoolRow.phone ? waLink(schoolRow.phone, text) : null;
    if (wa) actions.appendChild(el('a', { class: 'btn ghost', href: wa, target: '_blank', rel: 'noopener', text: 'Send on WhatsApp' }));
    body.appendChild(actions);
    U.modal({ title: title, body: body, actions: [{ label: 'Done', kind: 'gold', onClick: function (c) { c(); } }] });
  }

  /* ---------------- Add school ---------------- */

  function openProvisionModal() {
    var body = el('div', { class: 'form' });
    var nameInput = el('input', { type: 'text', placeholder: 'e.g. St Mary’s Basic School' });
    var contactInput = el('input', { type: 'text', placeholder: 'e.g. Ama Mensah' });
    var emailInput = el('input', { type: 'email', placeholder: 'optional' });
    var phoneInput = el('input', { type: 'tel', placeholder: 'optional, e.g. 024 123 4567' });
    var idInput = el('input', { type: 'text', placeholder: 'auto-filled from the school name' });
    var demoBox = el('input', { type: 'checkbox' });
    var preview = el('div', { class: 'help', style: 'font-family:monospace' });
    // Auto-suggest the web-address slug from the name as the operator types,
    // but stop the moment they touch the ID field themselves — their edit
    // always wins over the suggestion.
    var idTouched = false;
    function updatePreview() { preview.textContent = 'Portal address: ' + global.location.origin + '/' + (idInput.value || '…'); }
    idInput.addEventListener('input', function () { idTouched = true; updatePreview(); });
    nameInput.addEventListener('input', function () { if (!idTouched) idInput.value = slugify(nameInput.value); updatePreview(); });
    updatePreview();
    body.appendChild(field('School name', nameInput));
    body.appendChild(field('Contact person', contactInput, 'Becomes the school’s first Administrator.'));
    body.appendChild(field('Email', emailInput));
    body.appendChild(field('Phone / WhatsApp', phoneInput));
    body.appendChild(field('Portal address', idInput, 'Lowercase letters, numbers and hyphens only. A few words (admin, pricing, api…) are reserved.'));
    body.appendChild(preview);
    body.appendChild(el('label', { class: 'check-label', style: 'display:flex;gap:.45rem;align-items:center;margin-top:.6rem' }, [demoBox, document.createTextNode('Fill with sample demo pupils and demo logins (for training only)')]));
    body.appendChild(el('div', { class: 'help', text: 'A normal school starts empty with one Administrator login and a 30-day free trial. You get a one-time temporary password to hand over.' }));
    var e = errBox(); body.appendChild(e);

    U.modal({
      title: 'Add a school', body: body,
      actions: [
        { label: 'Cancel', onClick: function (c) { c(); } },
        { label: 'Create', kind: 'gold', onClick: function (c) {
          e.style.display = 'none';
          if (!nameInput.value.trim()) { showErr(e, 'School name is required.'); return; }
          DB.platformProvision({
            name: nameInput.value.trim(), school_id: idInput.value.trim() || undefined,
            contact_name: contactInput.value.trim() || undefined, email: emailInput.value.trim() || undefined,
            phone: phoneInput.value.trim() || undefined, demo: demoBox.checked
          }).then(function (res) {
            c(); loadSchools();
            U.toast('School created: ' + (res.school_id || ''));
            if (res.temp_password) showCredentials('School created — hand these over', { name: nameInput.value.trim(), phone: phoneInput.value.trim() }, res);
          }).catch(function (err) { showErr(e, msgOf(err, 'Could not create school.')); });
        } }
      ]
    });
  }

  /* ---------------- Manage one school ---------------- */

  function section(title, nodes) {
    return el('div', { class: 'card', style: 'margin-bottom:.7rem' }, [el('h3', { text: title })].concat(nodes));
  }

  function openManageModal(schoolId) {
    var row = schools.filter(function (s) { return s.id === schoolId; })[0];
    if (!row) return;
    var body = el('div');
    var modal;

    // Replace our copy of the school with the server's fresh answer, then redraw.
    function applyServer(res) {
      var sub = res && res.subscription;
      if (sub) { ['trial_ends_at', 'paid_until', 'state', 'days_left', 'status', 'plan'].forEach(function (k) { row[k] = sub[k]; }); }
      paint(); loadSchools();
    }
    function refreshRow() { return loadSchools().then(function () { row = schools.filter(function (s) { return s.id === schoolId; })[0] || row; paint(); }); }

    function paint() {
      U.clear(body);
      body.appendChild(el('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.8rem' }, [
        stateChip(row), el('span', { class: 'muted', style: 'font-size:.82rem', text: subLine(row, true) })
      ]));
      body.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin:-.4rem 0 .8rem;word-break:break-all', text: global.location.origin + '/' + row.id }));
      body.appendChild(ownershipSection());
      body.appendChild(subscriptionSection());
      body.appendChild(contactSection());
      body.appendChild(accountsSection());
      body.appendChild(supportSection());
    }

    /* --- Ownership: is the person who registered really the owner / authorised rep? --- */
    function ownershipSection() {
      var kids = [];
      var verErr = errBox();
      if (row.verified_at) {
        kids.push(el('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap' }, [
          el('span', { class: 'tag', style: 'background:#0f5e5e;color:#fff', text: 'Verified' }),
          el('span', { class: 'muted', style: 'font-size:.85rem', text: 'on ' + String(row.verified_at).slice(0, 10) + (row.verify_note ? ' — ' + row.verify_note : '') })
        ]));
        kids.push(el('div', { style: 'margin:.3rem 0;font-size:.9rem' }, [el('span', { class: 'muted', text: 'Licence / registration number: ' }), document.createTextNode(row.licence_no || '—')]));
        kids.push(el('div', { class: 'btn-row', style: 'margin-top:.4rem' }, [el('button', { class: 'btn sm ghost', text: 'Remove Verified mark', onclick: function () {
          var n = global.prompt('Why are you removing the Verified mark? (kept in the activity log)', ''); if (n === null) return;
          DB.platformVerify(row.id, false, n).then(function () { U.toast('Verified mark removed.'); refreshRow(); }).catch(function (err) { showErr(verErr, msgOf(err, 'Could not update.')); });
        } })]));
      } else {
        kids.push(el('div', { class: 'help', text: 'Not verified yet. Before you take payment: (1) look up the licence / registration number below with the issuing body (e.g. NaSIA for private schools, GES for public ones); (2) call or WhatsApp the contact number on file and confirm the person really is the owner or an authorised representative. Then mark the school Verified.' }));
        kids.push(el('div', { style: 'margin:.3rem 0;font-size:.9rem' }, [el('span', { class: 'muted', text: 'Licence / registration number given by the school: ' }), document.createTextNode(row.licence_no || 'not given yet')]));
        var noteI = el('input', { type: 'text', maxlength: '300', placeholder: 'How you checked, e.g. “NaSIA no. confirmed; called owner 5 Nov”', style: 'width:100%', 'aria-label': 'How you checked' });
        kids.push(el('div', { class: 'field' }, [noteI]));
        kids.push(el('div', { class: 'btn-row' }, [el('button', { class: 'btn sm gold', text: 'Mark as Verified', onclick: function () {
          verErr.style.display = 'none';
          if (!noteI.value.trim()) { showErr(verErr, 'Please write briefly how you checked, so the record is useful later.'); return; }
          DB.platformVerify(row.id, true, noteI.value.trim()).then(function () { U.toast('School marked Verified.'); refreshRow(); }).catch(function (err) { showErr(verErr, msgOf(err, 'Could not update.')); });
        } })]));
      }
      kids.push(verErr);
      return section('Ownership check', kids);
    }

    /* --- Subscription: extend trial, record payment, plan --- */
    function subscriptionSection() {
      var kids = [];

      // Free trial: one-tap extensions, plus an exact date.
      var trialErr = errBox();
      function extend(days) {
        trialErr.style.display = 'none';
        if (row.paid_until && !global.confirm('This school has PAID until ' + row.paid_until + '.\n\nExtending a free trial puts it back on a free trial and replaces that paid date. To add paid time instead, use “Record a payment” below.\n\nContinue?')) return;
        DB.platformExtendTrial(row.id, days).then(function (res) { applyServer(res); U.toast('Free trial extended by ' + days + ' days.'); })
          .catch(function (err) { showErr(trialErr, msgOf(err, 'Could not extend the trial.')); });
      }
      var customDays = el('input', { type: 'number', min: '1', max: '3650', value: '14', style: 'width:90px', 'aria-label': 'Days to add' });
      var dateInput = el('input', { type: 'date', value: row.trial_ends_at || addDays(today(), 30), style: 'width:170px', 'aria-label': 'Exact trial end date' });
      kids.push(el('h4', { text: 'Free trial', style: 'margin:.2rem 0 .1rem' }));
      kids.push(el('div', { class: 'help', text: 'Stored on our server, so a school cannot give itself extra time. “+1 month” adds 30 days to the current end date (or to today if the trial has already ended).' }));
      kids.push(el('div', { class: 'btn-row', style: 'margin:.5rem 0' }, [
        el('button', { class: 'btn gold', text: '+ 1 month', onclick: function () { extend(30); } }),
        el('button', { class: 'btn ghost', text: '+ 2 weeks', onclick: function () { extend(14); } }),
        el('button', { class: 'btn ghost', text: '+ 3 months', onclick: function () { extend(90); } })
      ]));
      kids.push(el('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem' }, [
        el('span', { class: 'muted', text: 'Add' }), customDays, el('span', { class: 'muted', text: 'days' }),
        el('button', { class: 'btn sm', text: 'Add days', onclick: function () {
          var n = Number(customDays.value);
          if (!isFinite(n) || n < 1 || n > 3650) { showErr(trialErr, 'Enter a whole number of days between 1 and 3650.'); return; }
          extend(Math.floor(n));
        } })
      ]));
      kids.push(el('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap' }, [
        el('span', { class: 'muted', text: 'Or end on' }), dateInput,
        el('button', { class: 'btn sm', text: 'Set date', onclick: function () {
          trialErr.style.display = 'none';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value || '')) { showErr(trialErr, 'Pick a valid date.'); return; }
          DB.platformSetTrial(row.id, dateInput.value).then(function (res) { applySub(res, 'Free trial end date set.'); })
            .catch(function (err) { showErr(trialErr, msgOf(err, 'Could not set the date.')); });
        } })
      ]));
      function applySub(res, msg) { applyServer(res); U.toast(msg); }
      kids.push(trialErr);

      // Payment: moves a school from trial to paid.
      var payErr = errBox();
      var planSel = el('select', { 'aria-label': 'Plan' });
      PLANS.forEach(function (p) { var o = el('option', { value: p, text: PLAN_LABEL[p] }); if ((row.plan || 'basic') === p) o.selected = true; planSel.appendChild(o); });
      var periodSel = el('select', { 'aria-label': 'Period paid for' });
      [[String(TERM_DAYS), '1 term (' + TERM_DAYS + ' days)'], [String(TERM_DAYS * 2), '2 terms (' + TERM_DAYS * 2 + ' days)'], ['365', 'Full year (365 days)'], ['custom', 'Pick an end date…']]
        .forEach(function (o) { periodSel.appendChild(el('option', { value: o[0], text: o[1] })); });
      var endInput = el('input', { type: 'date', value: addDays(today(), TERM_DAYS), style: 'width:170px;display:none', 'aria-label': 'Paid until' });
      var amountInput = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'GHS (optional)', style: 'width:130px', 'aria-label': 'Amount received' });
      var noteInput = el('input', { type: 'text', maxlength: '200', placeholder: 'Reference, e.g. MoMo 0245… (optional)', style: 'flex:1;min-width:180px', 'aria-label': 'Payment note' });
      var previewLine = el('div', { class: 'help', style: 'font-weight:600' });
      function computeEnd() {
        if (periodSel.value === 'custom') return endInput.value;
        var base = (row.paid_until && row.paid_until > today()) ? row.paid_until : today();   // same rule as the server: renewals stack
        return addDays(base, Number(periodSel.value));
      }
      function updatePreview() {
        endInput.style.display = periodSel.value === 'custom' ? '' : 'none';
        var end = computeEnd();
        previewLine.textContent = end ? 'School will be paid until ' + end + (periodSel.value !== 'custom' && row.paid_until && row.paid_until > today() ? ' (added to their current paid time)' : '') + '.' : '';
      }
      periodSel.addEventListener('change', updatePreview); endInput.addEventListener('input', updatePreview); updatePreview();

      kids.push(el('hr', { style: 'border:0;border-top:1px solid var(--line);margin:1rem 0' }));
      kids.push(el('h4', { text: 'Record a payment', style: 'margin:.2rem 0 .1rem' }));
      if (!row.verified_at) kids.push(el('div', { class: 'help', style: 'color:#8a6410;font-weight:600', text: 'Warning: this school is not Verified yet. Check the owner first (see “Ownership check” above) before confirming payment.' }));
      kids.push(el('div', { class: 'help', text: 'Use this when a school has paid. It ends the free trial, sets the plan, and unlocks editing until the date below. When that date passes the school becomes view-only automatically.' }));
      kids.push(el('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.5rem 0' }, [planSel, periodSel, endInput]));
      kids.push(el('div', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem' }, [amountInput, noteInput]));
      kids.push(previewLine);
      kids.push(el('div', { class: 'btn-row', style: 'margin-top:.5rem' }, [
        el('button', { class: 'btn', text: 'Record payment', onclick: function () {
          payErr.style.display = 'none';
          var p = { school_id: row.id, plan: planSel.value };
          if (periodSel.value === 'custom') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(endInput.value || '')) { showErr(payErr, 'Pick the date they have paid until.'); return; }
            p.paid_until = endInput.value;
          } else { p.days = Number(periodSel.value); }
          if (amountInput.value !== '') p.amount = Number(amountInput.value);
          if (noteInput.value.trim()) p.note = noteInput.value.trim();
          DB.platformPayment(p).then(function (res) { applyServer(res); U.toast('Payment recorded.'); })
            .catch(function (err) { showErr(payErr, msgOf(err, 'Could not record the payment.')); });
        } })
      ]));
      kids.push(payErr);
      return section('Subscription', kids);
    }

    /* --- Contact & private notes --- */
    function contactSection() {
      var kids = [];
      function line(label, node) { return el('div', { style: 'margin:.2rem 0;font-size:.9rem' }, [el('span', { class: 'muted', text: label + ': ' }), node]); }
      kids.push(line('Contact person', document.createTextNode(row.contact_name || '—')));
      kids.push(line('Email', row.email ? el('a', { href: 'mailto:' + row.email, text: row.email }) : document.createTextNode('—')));
      var wa = waLink(row.phone, 'Hello ' + (row.contact_name || '') + ', this is Zetranova about ' + (row.name || 'your school') + ' on Zetclass. ');
      kids.push(line('Phone', row.phone
        ? el('span', {}, [el('a', { href: 'tel:' + row.phone, text: row.phone }), wa ? document.createTextNode(' · ') : null, wa ? el('a', { href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp' }) : null])
        : document.createTextNode('—')));
      if (row.whatsapp) {
        var wa2 = waLink(row.whatsapp, 'Hello ' + (row.contact_name || '') + ', this is Zetranova about ' + (row.name || 'your school') + ' on Zetclass. ');
        kids.push(line('WhatsApp', wa2 ? el('a', { href: wa2, target: '_blank', rel: 'noopener', text: row.whatsapp }) : document.createTextNode(row.whatsapp)));
      }
      var place = [row.locality, row.district, row.region, row.country].filter(Boolean).join(', ');
      kids.push(line('Location', document.createTextNode(place || '—')));
      if (row.website) kids.push(line('Website', /^https?:\/\//i.test(row.website) ? el('a', { href: row.website, target: '_blank', rel: 'noopener', text: row.website }) : document.createTextNode(row.website)));
      if (row.postal_address) kids.push(line('Postal address', document.createTextNode(row.postal_address)));
      kids.push(el('div', { class: 'btn-row', style: 'margin:.5rem 0' }, [el('button', { class: 'btn sm', text: 'Edit school details…', onclick: openEditDetails })]));
      var noteErr = errBox();
      var note = el('textarea', { rows: '3', maxlength: '500', placeholder: 'Private notes — only you can see these (e.g. “Called 3 Oct, wants Growth plan after the trial”).', style: 'width:100%', 'aria-label': 'Private notes' });
      note.value = row.notes || '';
      kids.push(el('div', { class: 'field', style: 'margin-top:.6rem' }, [el('label', { text: 'Private notes' }), note]));
      kids.push(el('div', { class: 'btn-row' }, [el('button', { class: 'btn sm', text: 'Save note', onclick: function () {
        noteErr.style.display = 'none';
        DB.platformNote(row.id, note.value).then(function (res) { row.notes = res.notes; U.toast('Note saved.'); loadSchools(); })
          .catch(function (err) { showErr(noteErr, msgOf(err, 'Could not save the note.')); });
      } })]));
      kids.push(noteErr);
      return section('Contact & notes', kids);
    }

    /* --- Edit name / contact person / email / phone (the portal address cannot change) --- */
    function openEditDetails() {
      var form = el('div', { class: 'form' });
      var nameI = el('input', { type: 'text', maxlength: '120', value: row.name || '' });
      var contactI = el('input', { type: 'text', maxlength: '80', value: row.contact_name || '' });
      var emailI = el('input', { type: 'email', maxlength: '160', value: row.email || '' });
      var phoneI = el('input', { type: 'tel', maxlength: '30', value: row.phone || '' });
      form.appendChild(field('School name', nameI));
      form.appendChild(field('Contact person', contactI));
      form.appendChild(field('Email', emailI, 'Password-reset emails go here. Each school needs its own email and phone number.'));
      form.appendChild(field('School phone (calls)', phoneI, 'With country code, e.g. +233241234567.'));
      var waI = el('input', { type: 'tel', maxlength: '30', value: row.whatsapp || '' });
      var countryI = el('input', { type: 'text', maxlength: '60', value: row.country || '' });
      var regionI = el('input', { type: 'text', maxlength: '80', value: row.region || '' });
      var districtI = el('input', { type: 'text', maxlength: '80', value: row.district || '' });
      var localityI = el('input', { type: 'text', maxlength: '120', value: row.locality || '' });
      var postalI = el('input', { type: 'text', maxlength: '200', value: row.postal_address || '' });
      var websiteI = el('input', { type: 'text', maxlength: '200', value: row.website || '' });
      form.appendChild(field('Website (optional)', websiteI));
      form.appendChild(field('WhatsApp (optional)', waI, 'With country code. Leave empty to clear.'));
      form.appendChild(field('Country', countryI));
      form.appendChild(field('Region', regionI));
      form.appendChild(field('District', districtI));
      form.appendChild(field('Locality / area', localityI));
      form.appendChild(field('Postal address', postalI));
      form.appendChild(el('div', { class: 'help', text: 'The portal address ' + global.location.origin + '/' + row.id + ' cannot be changed (all records and logins are tied to it). To use a different address, add a new school and delete this one.' }));
      var e = errBox(); form.appendChild(e);
      U.modal({
        title: 'Edit school details', body: form,
        actions: [
          { label: 'Cancel', onClick: function (c) { c(); } },
          { label: 'Save', kind: 'gold', onClick: function (c) {
            e.style.display = 'none';
            if (!nameI.value.trim()) { showErr(e, 'School name is required.'); return; }
            DB.platformDetails(row.id, { name: nameI.value, contact_name: contactI.value, email: emailI.value, phone: phoneI.value,
              whatsapp: waI.value, country: countryI.value, region: regionI.value, district: districtI.value, locality: localityI.value, postal_address: postalI.value, website: websiteI.value })
              .then(function (res) {
                c(); U.toast(res.unchanged ? 'Nothing changed.' : 'School details saved.');
                refreshRow();
              })
              .catch(function (err) { showErr(e, msgOf(err, 'Could not save the details.')); });
          } }
        ]
      });
    }

    /* --- Login accounts: enable/disable, reset password --- */
    function accountsSection() {
      var host = el('div', {}, [el('div', { class: 'loader', text: 'Loading accounts…' })]);
      function paintUsers(users) {
        U.clear(host);
        host.appendChild(el('div', { class: 'help', text: 'Disabling an account blocks that person from signing in; their records are untouched. “Reset password” gives you a one-time temporary password to pass on (this is the “forgot password” help).' }));
        if (!users.length) { host.appendChild(el('p', { class: 'muted', text: 'This school has no login accounts.' })); return; }
        var errB = errBox(); host.appendChild(errB);
        var table = el('table', { class: 'data' });
        table.appendChild(el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Status', ''].map(function (t) { return el('th', { text: t }); }))]));
        var tb = el('tbody');
        users.forEach(function (u) {
          var toggle = el('button', { class: 'btn sm ghost', text: u.disabled ? 'Enable' : 'Disable', onclick: function () {
            errB.style.display = 'none'; toggle.disabled = true;
            DB.platformUserStatus(row.id, u.id, !u.disabled).then(function (res) { U.toast(res.disabled ? 'Account disabled.' : 'Account enabled.'); reloadUsers(); })
              .catch(function (err) { toggle.disabled = false; showErr(errB, msgOf(err, 'Could not change this account.')); });
          } });
          var reset = el('button', { class: 'btn sm', text: 'Reset password', onclick: function () {
            if (!global.confirm('Issue a new temporary password for ' + (u.name || u.username) + '?\n\nTheir current password stops working immediately.')) return;
            DB.platformResetPassword(row.id, u.id).then(function (res) { showCredentials('New temporary password', row, Object.assign({ school_id: row.id }, res)); })
              .catch(function (err) { showErr(errB, msgOf(err, 'Could not reset the password.')); });
          } });
          tb.appendChild(el('tr', {}, [
            el('td', { text: u.name || '—' }),
            el('td', {}, [el('code', { style: 'font-size:.75rem', text: u.username || '—' })]),
            el('td', { text: u.role || '—' }),
            el('td', {}, [el('span', { class: 'tag', style: 'background:' + (u.disabled ? '#b91c1c' : '#0f5e5e') + ';color:#fff', text: u.disabled ? 'Disabled' : 'Active' })]),
            el('td', { class: 'actions', style: 'display:flex;gap:.3rem;flex-wrap:wrap' }, [reset, toggle])
          ]));
        });
        table.appendChild(tb);
        host.appendChild(el('div', { class: 'table-wrap' }, [table]));
      }
      function reloadUsers() {
        DB.platformUsers(row.id).then(paintUsers).catch(function (err) {
          U.clear(host).appendChild(el('p', { style: 'color:#b3261e', text: 'Could not load accounts: ' + msgOf(err, 'error') }));
        });
      }
      reloadUsers();
      return section('Login accounts', [host]);
    }

    /* --- Support tools: log in as them, suspend, reset data, history --- */
    function supportSection() {
      var live = row.status === 'active' || row.status === 'trial' || row.status === 'grace';
      var errS = errBox();
      var kids = [];
      kids.push(el('div', { class: 'help', text: 'Everything you do here is recorded in the activity log.' }));
      kids.push(el('div', { class: 'btn-row', style: 'margin:.5rem 0' }, [
        el('button', { class: 'btn', text: 'Log in as this school', onclick: function () {
          DB.platformImpersonate(row.id).then(function (res) { modal.close(); if (HOOKS.onImpersonate) HOOKS.onImpersonate(res); })
            .catch(function (err) { showErr(errS, msgOf(err, 'Could not log in as this school.')); });
        } }),
        el('button', { class: 'btn ghost', text: 'Activity for this school', onclick: function () { openAuditModal(row.id); } }),
        el('button', { class: 'btn ghost', text: live ? 'Suspend school' : 'Reactivate school', onclick: function () {
          var next = live ? 'suspended' : 'active';
          if (live && !global.confirm('Suspend ' + (row.name || row.id) + '?\n\nNobody at this school (staff or parents) will be able to sign in until you reactivate. No data is deleted.')) return;
          DB.platformSuspend(row.id, next).then(function () { U.toast(live ? 'School suspended.' : 'School reactivated.'); refreshRow(); })
            .catch(function (err) { showErr(errS, msgOf(err, 'Could not change the status.')); });
        } })
      ]));
      kids.push(el('div', { style: 'border-top:1px solid var(--line);margin-top:.8rem;padding-top:.8rem' }, [
        el('div', { style: 'font-weight:700;color:#b91c1c', text: 'Danger zone' }),
        el('div', { class: 'help', text: 'Reset wipes every pupil, staff member, payment and record for this school and starts it again empty. Subscription and contact details are kept. You get a new temporary password for its Administrator.' }),
        el('div', { class: 'btn-row', style: 'margin-top:.4rem' }, [el('button', { class: 'btn sm danger', text: 'Reset school data…', onclick: confirmReset }), el('button', { class: 'btn sm danger', text: 'Delete school permanently…', onclick: confirmDelete })]),
        el('div', { class: 'help', text: 'Delete removes the school AND its data completely (use for test signups, or when a school asks for its information to be erased). It cannot be undone.' })
      ]));
      kids.push(errS);

      function confirmReset() {
        var box = el('div', { class: 'form' });
        var input = el('input', { type: 'text', placeholder: row.id, autocomplete: 'off', 'aria-label': 'Type the school address to confirm' });
        box.appendChild(el('p', { text: 'This permanently deletes all of ' + (row.name || row.id) + '’s data and cannot be undone.' }));
        box.appendChild(field('Type  ' + row.id + '  to confirm', input));
        var e = errBox(); box.appendChild(e);
        U.modal({ title: 'Reset school data', body: box, actions: [
          { label: 'Cancel', onClick: function (c) { c(); } },
          { label: 'Reset everything', kind: 'danger', onClick: function (c) {
            if (input.value.trim() !== row.id) { showErr(e, 'That does not match the school address.'); return; }
            DB.platformReset(row.id).then(function (res) { c(); U.toast('School reset.'); refreshRow(); if (res.temp_password) showCredentials('School reset — new Administrator password', row, res); })
              .catch(function (err) { showErr(e, msgOf(err, 'Could not reset the school.')); });
          } }
        ] });
      }
      function confirmDelete() {
        var box = el('div', { class: 'form' });
        var input = el('input', { type: 'text', placeholder: row.id, autocomplete: 'off', 'aria-label': 'Type the school address to confirm' });
        box.appendChild(el('p', { text: 'This permanently deletes ' + (row.name || row.id) + ' — its pupils, staff, payments, settings and logins — and removes it from your list. This cannot be undone.' }));
        box.appendChild(field('Type  ' + row.id + '  to confirm', input));
        var e = errBox(); box.appendChild(e);
        U.modal({ title: 'Delete school permanently', body: box, actions: [
          { label: 'Cancel', onClick: function (c) { c(); } },
          { label: 'Delete forever', kind: 'danger', onClick: function (c) {
            if (input.value.trim() !== row.id) { showErr(e, 'That does not match the school address.'); return; }
            DB.platformDelete(row.id, input.value.trim()).then(function () { c(); modal.close(); U.toast('School deleted.'); loadSchools(); })
              .catch(function (err) { showErr(e, msgOf(err, 'Could not delete the school.')); });
          } }
        ] });
      }
      return section('Support tools', kids);
    }

    paint();
    modal = U.modal({
      title: row.name || row.id, wide: true, body: body,
      actions: [{ label: 'Done', onClick: function (c) { c(); } }]
    });
  }

  /* ---------------- Audit / activity log ---------------- */

  var ACTION_LABEL = {
    provision: 'Created school', signup: 'School signed up', status: 'Changed status', trial: 'Changed free trial',
    plan: 'Changed plan', password_request: 'Asked to reset password (forgot password)', password_reset_self: 'Reset own password by email link', payment: 'Recorded payment', note: 'Edited note', details: 'Edited school details', password_reset: 'Issued temporary password',
    reset: 'Reset school data', delete: 'Deleted school', user_disable: 'Disabled an account', user_enable: 'Enabled an account',
    impersonate: 'Logged in as school', verify: 'Marked school as Verified', unverify: 'Removed Verified mark', verify_request: 'School submitted licence number'
  };

  function describe(r) {
    var d = r.detail || {};
    if (r.action === 'trial')  return (d.from || 'no trial') + ' → ' + (d.to || 'no trial');
    if (r.action === 'plan')   return (d.from || '—') + ' → ' + (d.to || '—');
    if (r.action === 'status') return (d.from || '—') + ' → ' + (d.to || '—');
    if (r.action === 'payment') return (PLAN_LABEL[d.plan] || d.plan || '') + ' · paid until ' + (d.to || '—') + (d.amount != null ? ' · GHS ' + d.amount : '') + (d.note ? ' · ' + d.note : '');
    if (r.action === 'signup') return (d.name || '') + (d.authority_declared ? ' · confirmed they are the owner/authorised representative' : '') + (d.ip ? ' · from ' + d.ip : '');
    if (r.action === 'provision' || r.action === 'delete') return d.name || '';
    if (r.action === 'verify' || r.action === 'unverify') return d.note || '';
    if (r.action === 'verify_request') return d.licence_no || '';
    if (r.action === 'details') return Object.keys(d).map(function (k) { return k.replace('_', ' ') + ' changed'; }).join(', ');
    if (r.action === 'impersonate') return 'expired ' + (d.expires_at || '').slice(0, 19).replace('T', ' ');
    if (r.action === 'password_request') return (d.username || '') + (d.email_sent ? ' · email sent' : ' · email not sent');
    if (r.action === 'user_disable' || r.action === 'user_enable' || r.action === 'password_reset' || r.action === 'password_reset_self') return d.username || r.target_id || '';
    return '';
  }

  function openAuditModal(schoolId) {
    var body = el('div', {}, [el('div', { class: 'loader', text: 'Loading activity…' })]);

    DB.platformAudit(schoolId, 200).then(function (rows) {
      U.clear(body);
      body.appendChild(el('div', { class: 'help', text: 'Every owner action is recorded here permanently. Entries can never be edited or deleted from the app — this is the accountability record for the platform account.' }));
      if (!rows || !rows.length) { body.appendChild(el('p', { class: 'muted', text: 'No activity recorded yet.' })); return; }
      var table = el('table', { class: 'data' });
      table.appendChild(el('thead', {}, [el('tr', {}, ['When (UTC)', 'Action', 'School', 'Details', 'By'].map(function (t) { return el('th', { text: t }); }))]));
      var tb = el('tbody');
      rows.forEach(function (r) {
        tb.appendChild(el('tr', {}, [
          el('td', { text: (r.created_at || '').slice(0, 19).replace('T', ' ') }),
          el('td', { text: ACTION_LABEL[r.action] || r.action }),
          el('td', {}, [el('code', { style: 'font-size:.72rem', text: r.school_id || '—' })]),
          el('td', { class: 'muted', style: 'font-size:.78rem', text: describe(r) }),
          el('td', { text: r.platform_uid || '—' })
        ]));
      });
      table.appendChild(tb);
      body.appendChild(el('div', { class: 'table-wrap' }, [table]));
    }).catch(function (err) {
      U.clear(body).appendChild(el('p', { style: 'color:#b3261e', text: 'Could not load the activity log: ' + msgOf(err, 'error') }));
    });

    U.modal({
      title: schoolId ? 'Activity log — ' + schoolId : 'Activity log',
      body: body, wide: true,
      actions: [{ label: 'Close', onClick: function (c) { c(); } }]
    });
  }

  global.Platform = { render: render, reload: loadSchools };
})(window);
