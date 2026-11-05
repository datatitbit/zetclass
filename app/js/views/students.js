/* ============================================================
 * students.js — Student & Academic: admissions, records,
 * parents (multi-child), class assignment, promotion, bulk admit.
 * Parents get a read-only ward portal (select ward, view report + attendance).
 * Admin manages each parent's portal access under Settings → Access Control.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB, App = global.App, Bulk = global.Bulk;
  var el = U.el;

  function render(container) {
    U.clear(container);
    if (App.user.role === 'Parent') {
      container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'My Ward' })]));
      var p = el('div'); container.appendChild(p); parentWard(p); return;
    }
    container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'Students & Academic' })]));
    var tabs = ['Students', 'Parents / Guardians'];
    if (App.ctx.academic.current_term === App.ctx.academic.promotional_term) tabs.push('Promotion');
    var bar = el('div', { class: 'tabs' });
    var panel = el('div');
    var active = 'Students';
    tabs.forEach(function (t) { var b = el('button', { text: t, onclick: function () { active = t; draw(); } }); b._t = t; bar.appendChild(b); });
    container.appendChild(bar); container.appendChild(panel);
    function draw() {
      U.$all('button', bar).forEach(function (b) { b.classList.toggle('active', b._t === active); });
      U.clear(panel);
      if (active === 'Students') tabStudents(panel);
      else if (active === 'Parents / Guardians') tabParents(panel);
      else tabPromotion(panel);
    }
    draw();
  }

  /* ---------- Parent ward portal ---------- */
  function parentWard(panel) {
    Promise.all([DB.all('students'), DB.all('classes'), DB.all('scores'), DB.all('attendance'), DB.all('invoices'), DB.all('payments'), DB.all('parents'), DB.singleton('access')]).then(function (r) {
      var all = r[0], classes = r[1], scores = r[2], attendance = r[3], invoices = r[4], payments = r[5];
      var access = r[7] || {};
      var myParent = (r[6] || []).filter(function (pp) { var sids = pp.student_ids || []; return (App.user.linked_student_ids || []).some(function (id) { return sids.indexOf(id) !== -1; }); })[0] || {};
      function canDL(classId) {
        if (myParent.report_download === 'block') return false;
        if (myParent.report_download === 'allow') return true;
        var bc = access.report_download_by_class || {};
        if (bc[classId] === false) return false;
        if (bc[classId] === true) return true;
        return access.report_download_default !== false;
      }
      var ids = App.user.linked_student_ids || [];
      var wards = all.filter(function (s) { return ids.indexOf(s.student_id) !== -1; });
      if (!wards.length) { panel.appendChild(el('div', { class: 'empty', text: 'No ward is linked to your account yet. Please contact the school office.' })); return; }

      var sel = el('select');
      wards.forEach(function (s) { sel.appendChild(el('option', { value: s.student_id, text: (s.first_name + ' ' + s.last_name) + ' (' + s.student_id + ')' })); });
      if (wards.length > 1) panel.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Select ward:' }), sel]));
      var area = el('div'); panel.appendChild(area);
      sel.addEventListener('change', draw);
      draw();

      function draw() {
        U.clear(area);
        var s = wards.filter(function (w) { return w.student_id === sel.value; })[0] || wards[0];
        var cls = classes.filter(function (c) { return c.id === s.class_id; })[0];
        var term = App.ctx.academic.current_term; var cur = App.ctx.school.currency;

        var prof = el('div', { class: 'card' });
        prof.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:.5rem' }, [
          el('h3', { text: (s.first_name + ' ' + s.last_name) }),
          canDL(s.class_id) ? el('button', { class: 'btn sm', text: '⤓ Print / PDF report', onclick: function () { printWard(s, cls, term); } }) : el('span', { class: 'muted', style: 'font-size:.8rem', text: 'Report download is turned off by the school.' })
        ]));
        prof.appendChild(el('div', { class: 'grid cols-3' }, [
          info('Student ID', s.student_id), info('Class', cls ? cls.name : '—'), info('Gender', s.gender || '—'),
          info('Status', s.status || 'active'), info('Date of birth', s.dob ? U.fmtDate(s.dob) : '—'), info('Admitted', s.admitted_on ? U.fmtDate(s.admitted_on) : '—')
        ]));
        area.appendChild(prof);

        var a = attStats(attendance, s.student_id);
        area.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Attendance so far' }),
          el('div', { class: 'grid cols-4' }, [stat(a.rate + '%', 'Attendance rate'), stat(a.present, 'Present'), stat(a.late, 'Late'), stat(a.absent, 'Absent')]),
          el('div', { class: 'muted', style: 'margin-top:.4rem', text: a.total + ' school day(s) recorded this term.' })
        ]));

        var billed = sumFor(invoices, s.student_id, term, 'amount');
        var paid = sumFor(payments, s.student_id, term, 'amount');
        area.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Fees (' + App.termName() + ')' }),
          el('div', { class: 'grid cols-3' }, [stat(U.money(billed, cur), 'Billed'), stat(U.money(paid, cur), 'Paid'), stat(U.money(billed - paid, cur), (billed - paid) > 0 ? 'Balance due' : 'Cleared')])
        ]));

        area.appendChild(scoresCard(scores, s.student_id, term));
      }

      function printWard(s, cls, term) {
        var sch = App.ctx.school; var cur = sch.currency;
        var a = attStats(attendance, s.student_id);
        var billed = sumFor(invoices, s.student_id, term, 'amount'), paid = sumFor(payments, s.student_id, term, 'amount');
        var sc = scores.filter(function (x) { return x.student_id === s.student_id && x.term === term; });
        var G = global.Grading, w = App.ctx.weighting, bands = (App.ctx.gradeBands || []).slice().sort(function (x, y) { return y.min - x.min; });
        var rows = sc.map(function (x) {
          var total = G ? G.computeTotal(x.class_score || 0, x.exam_score || 0, w) : (Number(x.class_score || 0) + Number(x.exam_score || 0));
          var band = G ? G.gradeFor(total, bands) : { grade: '', remark: '' };
          return '<tr><td>' + U.esc(x.subject) + '</td><td>' + (x.class_score == null ? '' : x.class_score) + '</td><td>' + (x.exam_score == null ? '' : x.exam_score) + '</td><td>' + total + '</td><td>' + U.esc(band.grade + (band.remark ? ' · ' + band.remark : '')) + '</td></tr>';
        }).join('');
        var html = '<h1>' + U.esc(sch.name) + '</h1><h3>' + U.esc(App.termName()) + ' Report — ' + U.esc(App.ctx.academic.year) + '</h3>' +
          '<p><b>Name:</b> ' + U.esc(s.first_name + ' ' + s.last_name) + ' &nbsp; <b>ID:</b> ' + U.esc(s.student_id) + ' &nbsp; <b>Class:</b> ' + U.esc(cls ? cls.name : '') + '</p>' +
          '<h2>Scores</h2><table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%"><thead><tr><th>Subject</th><th>Class %</th><th>Exam %</th><th>Total %</th><th>Grade</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5">No scores published yet.</td></tr>') + '</tbody></table>' +
          '<h2>Attendance so far</h2><p>Rate: <b>' + a.rate + '%</b> &nbsp; Present: ' + a.present + ' &nbsp; Late: ' + a.late + ' &nbsp; Absent: ' + a.absent + ' &nbsp; (of ' + a.total + ' days)</p>' +
          '<h2>Fees (' + U.esc(App.termName()) + ')</h2><p>Billed: ' + U.money(billed, cur) + ' &nbsp; Paid: ' + U.money(paid, cur) + ' &nbsp; <b>Balance: ' + U.money(billed - paid, cur) + '</b></p>';
        printReport(sch.name + ' report', html);
      }
    });
  }
  function attStats(attendance, sid) {
    var att = attendance.filter(function (x) { return x.student_id === sid; });
    var present = att.filter(function (x) { return x.status === 'present'; }).length;
    var late = att.filter(function (x) { return x.status === 'late'; }).length;
    var absent = att.filter(function (x) { return x.status === 'absent'; }).length;
    var total = att.length;
    return { present: present, late: late, absent: absent, total: total, rate: total ? Math.round(present / total * 100) : 0 };
  }
  function sumFor(arr, sid, term, key) { return arr.filter(function (x) { return x.student_id === sid && x.term === term; }).reduce(function (a, x) { return a + Number(x[key] || 0); }, 0); }
  function scoresCard(scores, sid, term) {
    var sc = scores.filter(function (x) { return x.student_id === sid && x.term === term; });
    var card = el('div', { class: 'card' }, [el('h3', { text: App.termName() + ' scores' })]);
    if (!sc.length) { card.appendChild(el('div', { class: 'empty', text: 'No scores published yet.' })); return card; }
    var G = global.Grading, w = App.ctx.weighting, bands = (App.ctx.gradeBands || []).slice().sort(function (a, b) { return b.min - a.min; });
    var t = el('table', { class: 'data' });
    t.appendChild(el('thead', {}, [el('tr', {}, ['Subject', 'Class %', 'Exam %', 'Total %', 'Grade'].map(function (h) { return el('th', { text: h }); }))]));
    var tb = el('tbody');
    sc.forEach(function (x) {
      var total = G ? G.computeTotal(x.class_score || 0, x.exam_score || 0, w) : (Number(x.class_score || 0) + Number(x.exam_score || 0));
      var band = G ? G.gradeFor(total, bands) : { grade: '', remark: '' };
      tb.appendChild(el('tr', {}, [el('td', { text: x.subject }), el('td', { text: x.class_score == null ? '—' : x.class_score }), el('td', { text: x.exam_score == null ? '—' : x.exam_score }), el('td', { text: total }), el('td', { text: band.grade + (band.remark ? ' · ' + band.remark : '') })]));
    });
    t.appendChild(tb); card.appendChild(el('div', { class: 'table-wrap' }, [t]));
    return card;
  }
  function info(l, v) { return el('div', {}, [el('div', { class: 'muted', style: 'font-size:.75rem', text: l }), el('div', { style: 'font-weight:600', text: v })]); }
  function stat(n, l) { return el('div', { class: 'stat' }, [el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l })]); }
  function printReport(title, html) {
    var wn = window.open('', '_blank');
    var brand = (App.themeHex ? App.themeHex().primary : '#0f5e5e');
    wn.document.write('<html><head><title>' + U.esc(title) + '</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:22px;color:#1c2726}table{border-collapse:collapse;width:100%;margin-bottom:14px}th,td{border:1px solid #999;padding:5px;text-align:left;font-size:12px}th{background:' + brand + ';color:#fff}h1,h2,h3{color:' + brand + ';margin:.3rem 0}</style></head><body>' + html + '</body></html>');
    wn.document.close(); wn.focus(); setTimeout(function () { wn.print(); }, 300);
  }

  /* ---------- Students ---------- */
  function tabStudents(panel) {
    Promise.all([DB.all('students'), DB.all('classes'), DB.all('parents')]).then(function (r) {
      var students = r[0], classes = r[1].sort(bySort), parents = r[2];
      var filterClass = '', q = '';
      var canEdit = App.canEdit('Students');

      var tools = el('div', { class: 'toolbar' });
      var search = el('input', { type: 'text', class: 'search', placeholder: 'Search name or ID…' });
      search.addEventListener('input', U.debounce(function () { q = search.value.toLowerCase(); drawTable(); }, 200));
      var clsSel = el('select');
      clsSel.appendChild(el('option', { value: '', text: 'All classes' }));
      classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
      clsSel.addEventListener('change', function () { filterClass = clsSel.value; drawTable(); });
      tools.appendChild(search); tools.appendChild(clsSel);
      tools.appendChild(el('div', { style: 'flex:1' }));
      if (canEdit) {
        tools.appendChild(el('button', { class: 'btn', text: '+ Admit student', onclick: function () { editStudent(null, classes, parents, students, refresh); } }));
        tools.appendChild(el('button', { class: 'btn ghost', text: '⤓ New-admissions template', onclick: function () { downloadTemplate(classes); } }));
        tools.appendChild(el('button', { class: 'btn gold', text: '⤒ Upload new admissions', onclick: function () { uploadAdmissions(classes, refresh); } }));
      }
      panel.appendChild(tools);
      if (canEdit) panel.appendChild(el('div', { class: 'help', style: 'margin:-.3rem 0 .8rem', text: 'The templates always match your Admission Form (Settings → Admission Form). If you add, rename or remove a field there, download a fresh template.' }));

      if (canEdit) panel.appendChild(updateExistingCard(students, classes, refresh));
      panel.appendChild(profileDownloadCard(students, classes));

      var tableCard = el('div', { class: 'card' });
      panel.appendChild(tableCard);
      drawTable();

      function drawTable() {
        U.clear(tableCard);
        var rows = students.filter(function (s) {
          if (filterClass && s.class_id !== filterClass) return false;
          if (q) { var hay = (s.first_name + ' ' + s.last_name + ' ' + s.student_id).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
          return true;
        });
        tableCard.appendChild(el('div', { class: 'muted', style: 'margin-bottom:.5rem', text: rows.length + ' student(s)' }));
        if (!rows.length) { tableCard.appendChild(el('div', { class: 'empty', text: 'No students match.' })); return; }
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['ID', 'Name', 'Class', 'Gender', 'Parent', 'Status', ''].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody');
        rows.forEach(function (s) {
          var cls = classes.filter(function (c) { return c.id === s.class_id; })[0];
          var par = parents.filter(function (p) { return p.id === s.parent_id; })[0];
          var actions = el('div', { class: 'wrap-actions' });
          if (canEdit) {
            actions.appendChild(el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editStudent(s, classes, parents, students, refresh); } }));
            actions.appendChild(el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { U.confirm('Withdraw/delete ' + s.first_name + '?', function () { DB.remove('students', s.id).then(refresh); }); } }));
          } else actions.appendChild(el('span', { class: 'muted', text: 'view only' }));
          tb.appendChild(el('tr', {}, [
            el('td', { text: s.student_id }),
            el('td', { text: (s.first_name + ' ' + s.last_name) }),
            el('td', { text: cls ? cls.name : '—' }),
            el('td', { text: s.gender || '—' }),
            el('td', { text: par ? par.name : '—' }),
            el('td', {}, [el('span', { class: 'tag ' + (s.status === 'active' ? '' : 'muted'), text: s.status || 'active' })]),
            el('td', {}, [actions])
          ]));
        });
        t.appendChild(tb);
        tableCard.appendChild(el('div', { class: 'table-wrap' }, [t]));
      }
    });
    function refresh() { U.clear(panel); tabStudents(panel); }
  }

  // Sections for admin-defined custom admission fields, in display order.
  var ADMISSION_SECTIONS = [
    { key: 'personal', title: 'Additional Personal Details' },
    { key: 'health', title: 'Health Needs' },
    { key: 'guardian', title: 'Parent / Guardian Details' },
    { key: 'declaration', title: 'Declaration' },
    { key: 'office', title: 'For Office Use Only' }
  ];

  function admissionCfg() {
    var raw = App.ctx.admissionFields;
    return (Array.isArray(raw) && raw.length) ? raw : (global.SMS_SEED.admissionFields || []);
  }
  // Core-field label/required lookup (system fields can be renamed/required-toggled
  // in Settings → Admission Form, but never removed or retyped — the rest of the
  // app depends on their key/type staying exactly as seeded).
  function coreField(key, fallbackLabel, fallbackRequired) {
    var f = admissionCfg().filter(function (x) { return x.system && x.key === key; })[0];
    return { label: (f && f.label) || fallbackLabel, required: f ? !!f.required : !!fallbackRequired };
  }

  function siblingsField(def, initial) {
    var rows = (initial || []).map(function (r) { return { name: r.name || '', cls: r.cls || '' }; });
    var wrap = el('div', { class: 'field', style: 'grid-column:1/-1' }, [el('label', { text: def.label + (def.required ? ' *' : '') })]);
    var list = el('div');
    function redraw() {
      U.clear(list);
      rows.forEach(function (r, i) {
        var nameInp = el('input', { type: 'text', placeholder: 'Sibling name', value: r.name, style: 'flex:1' });
        nameInp.addEventListener('input', function () { r.name = nameInp.value; });
        var clsInp = el('input', { type: 'text', placeholder: 'Class', value: r.cls, style: 'width:160px' });
        clsInp.addEventListener('input', function () { r.cls = clsInp.value; });
        list.appendChild(el('div', { class: 'flex', style: 'gap:.4rem;margin-bottom:.3rem' }, [nameInp, clsInp,
          el('button', { class: 'btn sm danger', text: '✕', onclick: function () { rows.splice(i, 1); redraw(); } })]));
      });
    }
    redraw();
    wrap.appendChild(list);
    wrap.appendChild(el('button', { class: 'btn sm ghost', text: '+ Add sibling', onclick: function () { rows.push({ name: '', cls: '' }); redraw(); } }));
    if (def.help) wrap.appendChild(el('div', { class: 'help', text: def.help }));
    wrap._getValue = function () { return rows.filter(function (r) { return r.name.trim(); }).map(function (r) { return { name: r.name.trim(), cls: r.cls.trim() }; }); };
    wrap._required = def.required; wrap._label = def.label;
    return wrap;
  }

  function editStudent(s, classes, parents, students, done) {
    var rules = App.ctx.idRules;
    var cf = {
      first_name: coreField('first_name', 'First name', true),
      last_name: coreField('last_name', 'Last name', true),
      gender: coreField('gender', 'Gender', false),
      dob: coreField('dob', 'Date of birth', false),
      class_id: coreField('class_id', 'Class', false),
      status: coreField('status', 'Status', false),
      admitted_on: coreField('admitted_on', 'Admitted on', false)
    };
    var fields = [
      { name: 'first_name', label: cf.first_name.label, required: cf.first_name.required },
      { name: 'last_name', label: cf.last_name.label, required: cf.last_name.required },
      { name: 'gender', label: cf.gender.label, type: 'select', options: ['', 'M', 'F'], required: cf.gender.required },
      { name: 'dob', label: cf.dob.label, type: 'date', required: cf.dob.required },
      { name: 'class_id', label: cf.class_id.label, type: 'select', options: classes.map(function (c) { return { value: c.id, label: c.name }; }), required: cf.class_id.required },
      { name: 'status', label: cf.status.label, type: 'select', options: ['active', 'withdrawn', 'completed'], required: cf.status.required },
      { name: 'admitted_on', label: cf.admitted_on.label, type: 'date', required: cf.admitted_on.required }
    ];

    // Student ID is shown as soon as admission starts (auto-generated).
    function nextStudentPreview() {
      var pre = rules.student_prefix, digits = rules.digits, max = 0;
      students.forEach(function (st) {
        var m = new RegExp('^' + pre + '(\\d+)$').exec(st.student_id || '');
        if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
      });
      var t = '' + (max + 1); while (t.length < digits) t = '0' + t; return pre + t;
    }
    var preview = s ? '' : nextStudentPreview();
    var initial = s || { status: 'active', admitted_on: U.todayISO() };
    if (!s && rules.allow_manual) { fields.unshift({ name: 'student_id', label: 'Student ID (auto-suggested — edit to override)' }); initial = Object.assign({ student_id: preview }, initial); }

    var f = U.form(fields, initial);
    f.classList.add('form-grid');

    // Read-only ID badge for new students when IDs are auto-only.
    var idNode = (!s && !rules.allow_manual)
      ? el('div', { class: 'field', style: 'grid-column:1/-1' }, [el('label', { text: 'Student ID' }),
          el('div', {}, [el('span', { class: 'tag', text: preview }), el('span', { class: 'help', style: 'display:inline;margin-left:.5rem', text: 'auto-generated' })])])
      : null;

    // ---- Parent / Guardian + sibling linkage (replaces the separate "add parent") ----
    var parentNode = parentSiblingSection();

    // ---- Admin-defined custom fields (Settings → Admission Form), grouped by section ----
    // (The old informational "siblings" field type is superseded by the section above.)
    var plainDefs = admissionCfg().filter(function (x) { return !x.system && x.type !== 'siblings'; })
      .sort(function (a, b) { return ADMISSION_SECTIONS.findIndex(function (sec) { return sec.key === a.section; }) - ADMISSION_SECTIONS.findIndex(function (sec) { return sec.key === b.section; }); });
    var extraVals = (s && s.extra) ? JSON.parse(JSON.stringify(s.extra)) : {};
    var ef = null;
    if (plainDefs.length) {
      ef = U.form(plainDefs.map(function (d) { return { name: d.key, label: d.label, type: d.type, required: d.required, options: d.options, help: d.help, rows: d.type === 'textarea' ? 2 : undefined }; }), extraVals);
      ef.classList.add('form-grid');
      var rws = U.$all('.field', ef), idx = 0;
      ADMISSION_SECTIONS.forEach(function (sec) {
        var count = plainDefs.filter(function (d) { return d.section === sec.key; }).length;
        if (count) { ef.insertBefore(el('h4', { text: sec.title, style: 'grid-column:1/-1;margin:.6rem 0 0' }), rws[idx]); idx += count; }
      });
    }

    var body = el('div', {}, [idNode, f, parentNode, ef]);

    U.modal({ title: s ? 'Edit student' : 'Admit student', wide: true, body: body, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var errs = f.validate();
        if (ef) errs = errs.concat(ef.validate());
        if (errs.length) return U.toast(errs[0], 'err');
        var v = f.readValues();
        // Preserve any pre-existing extra keys not shown on the form (e.g. legacy siblings data).
        v.extra = Object.assign({}, (s && s.extra) || {}, ef ? ef.readValues() : {});
        if (v.status === 'withdrawn' && (!s || s.status !== 'withdrawn')) v.withdrawn_on = U.todayISO();
        var sv = parentNode._getValue();
        if (sv.hasSibling && sv.siblingId) {
          var sib0 = students.filter(function (x2) { return x2.id === sv.siblingId; })[0];
          if (sib0) v.sibling_ref = { student_id: sib0.student_id, name: sib0.first_name + ' ' + sib0.last_name, class_id: sib0.class_id };
        }
        if (s) {
          delete v.student_id; // never rewrite an existing code from the form
          DB.update('students', s.id, v).then(function () {
            resolveParentLink(s.id, s.student_id, sv, s.parent_id).then(function (pid) {
              DB.update('students', s.id, { parent_id: pid || null }).then(function () { x(); U.toast('Student updated.'); done(); });
            });
          });
        } else {
          var manualCode = rules.allow_manual && v.student_id && v.student_id.trim();
          function proceed(code) {
            v.student_id = code; v.id = 'stu-' + code; v.parent_id = null;
            DB.insert('students', v).then(function () {
              resolveParentLink(v.id, code, sv, null).then(function (pid) {
                DB.update('students', v.id, { parent_id: pid || null }).then(function () { x(); U.toast('Admitted as ' + code); done(); });
              });
            });
          }
          if (manualCode) {
            DB.all('students').then(function (all) {
              if (all.some(function (x2) { return x2.student_id === manualCode; })) return U.toast('Student ID "' + manualCode + '" is already in use — choose a different ID.', 'err');
              proceed(manualCode);
            });
          } else {
            DB.nextCode('student', rules.student_prefix, rules.digits).then(proceed);
          }
        }
      } }
    ] });

    // ---- Parent + sibling picker (creates the parent record automatically) ----
    function parentSiblingSection() {
      var curParent = (s && s.parent_id) ? parents.filter(function (p) { return p.id === s.parent_id; })[0] : null;
      var clsName = function (id) { var c = classes.filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; };
      var wrap = el('div', { style: 'grid-column:1/-1;margin-top:.4rem' });
      wrap.appendChild(el('h4', { text: 'Parent / Guardian', style: 'margin:.6rem 0 .3rem' }));
      var sibChk = el('input', { type: 'checkbox' });
      wrap.appendChild(el('label', { class: 'check-label', style: 'display:block;margin-bottom:.4rem' }, [sibChk, document.createTextNode(' This student has a sibling already enrolled here (share one parent account)')]));
      var sibWrap = el('div', { class: 'field', style: 'display:none' }, [el('label', { text: 'Select the sibling — their parent will be shared' })]);
      var sibSel = el('select');
      sibSel.appendChild(el('option', { value: '', text: '— choose sibling —' }));
      students.filter(function (x) { return !s || x.id !== s.id; }).forEach(function (x) {
        sibSel.appendChild(el('option', { value: x.id, text: x.first_name + ' ' + x.last_name + ' — ' + x.student_id + ' — ' + clsName(x.class_id) }));
      });
      sibWrap.appendChild(sibSel);
      var sibInfo = el('div', { class: 'help' });
      sibWrap.appendChild(sibInfo);
      wrap.appendChild(sibWrap);
      var pGrid = el('div', { class: 'form-grid' });
      var nameInp = el('input', { type: 'text', value: curParent ? (curParent.name || '') : '' });
      var phoneInp = el('input', { type: 'text', value: curParent ? (curParent.phone || '') : '' });
      var waInp = el('input', { type: 'text', value: curParent ? (curParent.whatsapp || '') : '' });
      var emailInp = el('input', { type: 'email', value: curParent ? (curParent.email || '') : '' });
      function fld(lbl, inp) { return el('div', { class: 'field' }, [el('label', { text: lbl }), inp]); }
      pGrid.appendChild(fld('Parent / Guardian full name', nameInp));
      pGrid.appendChild(fld('Phone', phoneInp));
      pGrid.appendChild(fld('WhatsApp', waInp));
      pGrid.appendChild(fld('Email', emailInp));
      wrap.appendChild(pGrid);
      wrap.appendChild(el('div', { class: 'help', text: 'Typing the parent here creates their record automatically — no separate step. To let one parent see all their children, tick the sibling box and pick an existing child (name, ID and class are shown) instead of re-typing the parent.' }));
      function refreshMode() {
        var on = sibChk.checked;
        sibWrap.style.display = on ? '' : 'none';
        var chosen = on && sibSel.value;
        pGrid.style.display = chosen ? 'none' : '';
        if (chosen) {
          var sib = students.filter(function (x) { return x.id === sibSel.value; })[0];
          var par = sib && parents.filter(function (p) { return p.id === sib.parent_id; })[0];
          if (par) {
            var kids = students.filter(function (x) { return (par.student_ids || []).indexOf(x.student_id) !== -1; }).map(function (x) { return x.first_name + ' ' + x.last_name; });
            sibInfo.textContent = 'Will join ' + par.name + '’s account' + (kids.length ? (' (covers: ' + kids.join(', ') + ')') : '');
          } else {
            sibInfo.textContent = 'This sibling has no parent record yet — enter the parent below instead.';
            pGrid.style.display = '';
          }
        } else if (on) { sibInfo.textContent = ''; }
      }
      sibChk.addEventListener('change', refreshMode);
      sibSel.addEventListener('change', refreshMode);
      refreshMode();
      wrap._getValue = function () {
        return { hasSibling: sibChk.checked && !!sibSel.value, siblingId: sibChk.checked ? sibSel.value : '', name: nameInp.value, phone: phoneInp.value, whatsapp: waInp.value, email: emailInp.value };
      };
      return wrap;
    }

    // Resolve the student's parent: reuse a sibling's parent, or create/update one
    // from the details typed on the form. Keeps parent.student_ids in sync.
    function resolveParentLink(studentId, studentCode, sv, oldParentId) {
      if (sv.hasSibling && sv.siblingId) {
        var sib = students.filter(function (x) { return x.id === sv.siblingId; })[0];
        var pid = sib && sib.parent_id;
        if (pid) return linkParent(studentId, pid, oldParentId).then(function () { return pid; });
      }
      var name = (sv.name || '').trim();
      if (!name) return Promise.resolve(oldParentId || null);
      var pdata = { name: name, phone: (sv.phone || '').trim(), whatsapp: (sv.whatsapp || sv.phone || '').trim(), email: (sv.email || '').trim() };
      if (oldParentId) {
        return DB.update('parents', oldParentId, pdata).then(function () { return linkParent(studentId, oldParentId, oldParentId); }).then(function () { return oldParentId; });
      }
      return DB.insert('parents', pdata).then(function (np) { return linkParent(studentId, np.id, oldParentId).then(function () { return np.id; }); });
    }
  }

  // keep parent.student_ids in sync (by student code)
  function linkParent(studentId, newParentId, oldParentId) {
    return DB.all('students').then(function (sts) {
      var st = sts.filter(function (x) { return x.id === studentId; })[0];
      var code = st ? st.student_id : studentId;
      var ops = [];
      if (oldParentId && oldParentId !== newParentId) {
        ops.push(DB.get('parents', oldParentId).then(function (p) { if (p) return DB.update('parents', p.id, { student_ids: (p.student_ids || []).filter(function (c) { return c !== code; }) }); }));
      }
      if (newParentId) {
        ops.push(DB.get('parents', newParentId).then(function (p) { if (p && (p.student_ids || []).indexOf(code) === -1) return DB.update('parents', p.id, { student_ids: (p.student_ids || []).concat([code]) }); }));
      }
      return Promise.all(ops);
    });
  }

  /* ---------- Parents ---------- */
  function tabParents(panel) {
    Promise.all([DB.all('parents'), DB.all('students')]).then(function (r) {
      var parents = r[0], students = r[1], canEdit = App.canEdit('Students');
      var tools = el('div', { class: 'toolbar' });
      if (canEdit) tools.appendChild(el('span', { class: 'muted', text: 'Parents are created automatically when you admit a student — use Edit to correct details or link another child.' }));
      panel.appendChild(tools);
      var c = el('div', { class: 'card' });
      var t = el('table', { class: 'data' });
      t.appendChild(el('thead', {}, [el('tr', {}, ['Name', 'Phone', 'WhatsApp', 'Children', ''].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      parents.forEach(function (p) {
        var kids = students.filter(function (s) { return (p.student_ids || []).indexOf(s.student_id) !== -1; })
          .map(function (s) { return s.first_name + ' ' + s.last_name; }).join(', ') || '—';
        var act = el('div', { class: 'wrap-actions' });
        if (canEdit) {
          act.appendChild(el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editParent(p, students, refresh); } }));
          act.appendChild(el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { U.confirm('Delete parent ' + p.name + '?', function () { DB.remove('parents', p.id).then(refresh); }); } }));
        }
        tb.appendChild(el('tr', {}, [
          el('td', { text: p.name }), el('td', { text: p.phone || '—' }), el('td', { text: p.whatsapp || '—' }), el('td', { text: kids }),
          el('td', {}, [act])
        ]));
      });
      t.appendChild(tb);
      c.appendChild(el('div', { class: 'table-wrap' }, [t]));
      panel.appendChild(c);
      panel.appendChild(el('div', { class: 'note', text: 'Parents are created automatically during student admission — there is no separate "add parent" step. One parent links to several children (tick "sibling" when admitting, or use Edit here to link a child) and a single login covers all of them. Parent login and report-download control live under Settings → Access Control (admin only).' }));
    });
    function refresh() { U.clear(panel); tabParents(panel); }
  }
  function editParent(p, students, done) {
    var f = U.form([
      { name: 'name', label: 'Full name', required: true },
      { name: 'phone', label: 'Phone' },
      { name: 'whatsapp', label: 'WhatsApp' },
      { name: 'email', label: 'Email', type: 'email' }
    ], p || {});
    var childBox = el('div', { class: 'field' }, [el('label', { text: 'Linked children' })]);
    var sel = el('div');
    var current = (p && p.student_ids) || [];
    students.forEach(function (s) {
      var cb = el('input', { type: 'checkbox' }); cb.value = s.student_id; if (current.indexOf(s.student_id) !== -1) cb.checked = true;
      sel.appendChild(el('label', { class: 'check-label', style: 'display:block' }, [cb, document.createTextNode(' ' + s.first_name + ' ' + s.last_name + ' (' + s.student_id + ')')]));
    });
    childBox.appendChild(sel); f.appendChild(childBox);
    U.modal({ title: p ? 'Edit parent' : 'Add parent', wide: true, body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues(); if (!v.name.trim()) return U.toast('Name required', 'err');
        v.student_ids = U.$all('input[type=checkbox]', sel).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        var go = p ? DB.update('parents', p.id, v) : DB.insert('parents', v);
        go.then(function (saved) {
          DB.all('students').then(function (sts) {
            var ops = sts.map(function (s) {
              var should = v.student_ids.indexOf(s.student_id) !== -1;
              var pid = (p ? p.id : saved.id);
              if (should && s.parent_id !== pid) return DB.update('students', s.id, { parent_id: pid });
              if (!should && s.parent_id === pid) return DB.update('students', s.id, { parent_id: null });
              return null;
            }).filter(Boolean);
            Promise.all(ops).then(function () { x(); U.toast('Saved.'); done(); });
          });
        });
      } }
    ] });
  }

  /* ---------- Promotion ---------- */
  function tabPromotion(panel) {
    Promise.all([DB.all('students'), DB.all('classes')]).then(function (r) {
      var students = r[0], classes = r[1].sort(bySort);
      panel.appendChild(el('div', { class: 'note', text: 'Promotional term (' + App.termName() + '). Each pupil defaults to promotion to the next class. Flag any who repeat. Basic 9 pupils complete (BECE / Alumni).' }));
      var decisions = {};
      classes.forEach(function (c) {
        var kids = students.filter(function (s) { return s.class_id === c.id && s.status === 'active'; });
        if (!kids.length) return;
        var nextC = nextClass(c, classes);
        var body = el('div');
        kids.forEach(function (s) {
          var def = nextC ? 'promote' : 'complete';
          decisions[s.id] = { student: s, choice: def, next: nextC };
          var sel = el('select');
          [['promote', nextC ? 'Promote → ' + nextC.name : 'Promote'], ['retain', 'Retain (repeat ' + c.name + ')'], ['complete', 'Completed / Alumni']].forEach(function (o) {
            var opt = el('option', { value: o[0], text: o[1] }); if (o[0] === def) opt.selected = true; sel.appendChild(opt);
          });
          if (!nextC) sel.value = 'complete';
          sel.addEventListener('change', function () { decisions[s.id].choice = sel.value; });
          body.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between; margin-bottom:.3rem; gap:.5rem' }, [
            el('span', { text: s.first_name + ' ' + s.last_name + ' (' + s.student_id + ')' }), sel ]));
        });
        panel.appendChild(el('div', { class: 'card' }, [el('h3', { text: c.name + (nextC ? ' → ' + nextC.name : ' (final class)') }), body]));
      });
      if (!App.canEdit('Students')) return;
      panel.appendChild(el('button', { class: 'btn gold', text: 'Apply promotions', onclick: function () {
        U.confirm('Apply all promotion decisions? This updates class assignments.', function () {
          var ops = Object.keys(decisions).map(function (id) {
            var d = decisions[id];
            if (d.choice === 'promote' && d.next) return DB.update('students', id, { class_id: d.next.id, promoted_to: d.next.name });
            if (d.choice === 'complete') return DB.update('students', id, { status: 'completed', promoted_to: 'Completed (BECE / Alumni)' });
            return DB.update('students', id, { promoted_to: 'Repeated ' + (d.student && App.className(d.student.class_id)) });
          });
          Promise.all(ops).then(function () { U.toast('Promotions applied.'); U.clear(panel); tabPromotion(panel); });
        });
      } }));
    });
  }
  function nextClass(c, classes) {
    var idx = classes.findIndex(function (x) { return x.id === c.id; });
    return classes[idx + 1] || null;
  }

  /* ---------- Bulk admissions + updates: templates follow the Admission Form ----------
   * The spreadsheet columns are built from the school's CURRENT admission form (Settings → Admission Form):
   * the core fields (with any labels the Admin has renamed) plus every custom field, in the same order as
   * the form. Add, rename or remove a field there, download a fresh template, and the columns match.
   * On upload, columns are matched by their header text (or the older technical name, so earlier templates
   * still work). The two rows that start with "#" (GUIDE and EXAMPLE) are skipped on upload. */
  function secIndex(k) {
    var i = ADMISSION_SECTIONS.findIndex(function (s) { return s.key === k; });
    return i < 0 ? 99 : i;
  }
  function customDefs() {
    return admissionCfg().filter(function (d) { return !d.system && d.type !== 'siblings'; })
      .map(function (d, i) { return { d: d, i: i }; })
      .sort(function (a, b) { return (secIndex(a.d.section) - secIndex(b.d.section)) || (a.i - b.i); })
      .map(function (x) { return x.d; });
  }
  function normHeader(h) { return String(h == null ? '' : h).replace(/^﻿/, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function hintFor(d) {
    if (d.type === 'number') return 'Number';
    if (d.type === 'date') return 'Date, e.g. 2018-05-01';
    if (d.type === 'checkbox') return 'Yes or No';
    if (d.type === 'select' && d.options && d.options.length) return 'Choose: ' + d.options.join(' | ');
    return 'Text';
  }
  function exampleFor(d) {
    if (d.type === 'number') return '10';
    if (d.type === 'date') return '2018-05-01';
    if (d.type === 'checkbox') return 'Yes';
    if (d.type === 'select' && d.options && d.options.length) return d.options[0];
    return 'Example';
  }
  // mode 'new' = new-admissions template; 'update' = update-existing template.
  function admissionColumns(classes, mode) {
    var cf = {
      first_name: coreField('first_name', 'First name', true), last_name: coreField('last_name', 'Last name', true),
      gender: coreField('gender', 'Gender', false), dob: coreField('dob', 'Date of birth', false),
      class_id: coreField('class_id', 'Class', false), status: coreField('status', 'Status', false),
      admitted_on: coreField('admitted_on', 'Admitted on', false)
    };
    var cls0 = classes[0] ? classes[0].name : 'Basic 1';
    var cols = [];
    if (mode === 'update') cols.push({ key: 'student_id', header: 'student_id', required: true, type: 'text', core: true, hint: 'Do not change', example: 'ST0001' });
    cols.push({ key: 'first_name', header: cf.first_name.label, required: true, type: 'text', core: true, hint: 'Text', example: 'Ama' });
    cols.push({ key: 'last_name', header: cf.last_name.label, required: true, type: 'text', core: true, hint: 'Text', example: 'Mensah' });
    cols.push({ key: 'gender', header: cf.gender.label, required: cf.gender.required, type: 'select', options: ['M', 'F'], core: true, hint: 'M or F', example: 'F' });
    cols.push({ key: 'dob', header: cf.dob.label, required: cf.dob.required, type: 'date', core: true, hint: 'Date, e.g. 2018-05-01', example: '2018-05-01' });
    cols.push({ key: 'class_name', header: cf.class_id.label, required: true, type: 'text', core: true, hint: 'Exact class name, e.g. ' + cls0, example: cls0 });
    if (mode === 'update') {
      cols.push({ key: 'status', header: cf.status.label, required: false, type: 'select', options: ['active', 'withdrawn', 'completed'], core: true, hint: 'active, withdrawn or completed', example: 'active' });
      cols.push({ key: 'admitted_on', header: cf.admitted_on.label, required: false, type: 'date', core: true, hint: 'Date, e.g. 2024-09-02', example: '2024-09-02' });
    } else {
      cols.push({ key: 'parent_name', header: 'Parent / Guardian name', required: false, type: 'text', core: true, hint: 'Text', example: 'Kofi Mensah' });
      cols.push({ key: 'parent_phone', header: 'Parent / Guardian phone', required: false, type: 'text', core: true, hint: 'With country code', example: '+233241234567' });
    }
    customDefs().forEach(function (d) {
      cols.push({ key: d.key, header: d.label, required: !!d.required, type: d.type, options: d.options || [], core: false, hint: hintFor(d), example: exampleFor(d) });
    });
    // Headers must be unique so each column can be told apart.
    var seen = {};
    cols.forEach(function (c) {
      var h = c.header, n = 2;
      while (seen[normHeader(h)]) { h = c.header + ' (' + (n++) + ')'; }
      seen[normHeader(h)] = true; c.header = h;
    });
    return cols;
  }
  function headerText(c) { return c.header + (c.required ? ' *' : ''); }

  // Match the file's header row to the current columns; drop the "#" helper rows.
  function prepareUpload(fileRows, cols) {
    if (!fileRows.length) return { rows: [], present: {}, notes: [], lines: [] };
    var byNorm = {};
    cols.forEach(function (c) { byNorm[normHeader(c.header)] = c.key; byNorm[normHeader(c.key)] = c.key; });
    var present = {}, unknown = [];
    var head = fileRows[0].map(function (h) {
      var k = byNorm[normHeader(h)];
      if (k) { present[k] = true; return k; }
      if (String(h).trim() !== '') unknown.push(String(h).replace(/\s*\*\s*$/, '').trim());
      return String(h).trim();
    });
    var data = [], lines = [];
    fileRows.slice(1).forEach(function (r, i) { if (String(r[0] || '').trim().charAt(0) !== '#') { data.push(r); lines.push(i + 2); } });   // lines[] = the row's real line in the file
    var notes = [];
    if (unknown.length) notes.push('Ignored column(s) that are not on your Admission Form: ' + unknown.join(', ') + '.');
    var absent = cols.filter(function (c) { return !c.core && !present[c.key]; }).map(function (c) { return c.header; });
    if (absent.length) notes.push('Your file has no column for: ' + absent.join(', ') + '. Those stay empty. Download a fresh template to include them.');
    return { rows: [head].concat(data), present: present, notes: notes, lines: lines };
  }
  // Report problem rows at their real line in the file (the # helper rows were removed before checking).
  function fixLines(res, prep) {
    (res.rejected || []).forEach(function (rj) { var k = rj.line - 2; if (rj.line > 1 && prep.lines[k]) rj.line = prep.lines[k]; });
    return res;
  }
  // The "Missing columns" message names the columns the way the template does.
  function friendlyMissing(res, cols) {
    if (res.rejected && res.rejected[0] && /^Missing columns/.test(res.rejected[0].why)) {
      res.rejected[0].why = res.rejected[0].why.replace(/[a-z_]+/g, function (k) {
        var c = cols.filter(function (x) { return x.key === k; })[0]; return c ? c.header : k;
      }).replace('columns:', 'columns (download a fresh template):');
    }
    return res;
  }

  function parseDateCell(s) {
    s = String(s || '').trim();
    if (!s) return { ok: true, value: '' };
    var y, mo, d, m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else { m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s); if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; } }   // day first, as in Ghana
    if (!m) return { ok: false };
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false };
    return { ok: true, value: y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d };
  }
  function convertCell(col, raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (col.type === 'checkbox') {
      if (/^(yes|y|true|1|x|✓)$/i.test(s)) return { ok: true, value: true };
      if (s === '' || /^(no|n|false|0)$/i.test(s)) return { ok: true, value: false };
      return { ok: false, error: col.header + ': use Yes or No' };
    }
    if (s === '') return { ok: true, value: '' };
    if (col.key === 'gender') { if (/^male$/i.test(s)) s = 'M'; else if (/^female$/i.test(s)) s = 'F'; }
    if (col.type === 'number') { var n = Number(s.replace(/,/g, '')); return isFinite(n) ? { ok: true, value: n } : { ok: false, error: col.header + ': "' + s + '" is not a number' }; }
    if (col.type === 'date') { var p = parseDateCell(s); return p.ok ? p : { ok: false, error: col.header + ': "' + s + '" is not a date (use 2018-05-01)' }; }
    if (col.type === 'select' && col.options && col.options.length) {
      var hit = col.options.filter(function (o) { return String(o).toLowerCase() === s.toLowerCase(); })[0];
      return hit != null ? { ok: true, value: hit } : { ok: false, error: col.header + ': "' + s + '" is not one of ' + col.options.join(' | ') };
    }
    return { ok: true, value: s };
  }
  // Reads one spreadsheet row using the columns that are in the file. Returns the core values, the custom-field
  // values (destined for student.extra) and any problems. keepBlank: keep empty cells (updates clear values).
  function readRow(row, cols, present, keepBlank) {
    var errs = [], out = {}, extra = {};
    cols.forEach(function (c) {
      if (!present[c.key]) return;
      var r = convertCell(c, row[c.key]);
      if (!r.ok) { errs.push(r.error); return; }
      var empty = r.value === '' || (c.type === 'checkbox' && r.value !== true);
      if (c.required && empty) { errs.push(c.header + ' is required'); return; }
      if (c.core) out[c.key] = r.value;
      else if (keepBlank || !empty) extra[c.key] = r.value;
    });
    return { errs: errs, out: out, extra: extra };
  }

  function downloadTemplate(classes) {
    var cols = admissionColumns(classes, 'new');
    var rows = [
      cols.map(headerText),
      cols.map(function (c, i) { return (i === 0 ? '#GUIDE ' : '') + c.hint; }),
      cols.map(function (c, i) { return (i === 0 ? '#EXAMPLE ' : '') + c.example; })
    ];
    Bulk.download('admissions-template.csv', rows);
    U.toast('Template downloaded. It matches your current Admission Form. Fill it (delete the two # rows), then upload.');
  }
  function uploadAdmissions(classes, done) {
    Bulk.pickFile().then(function (file) {
      var rules = App.ctx.idRules;
      var cols = admissionColumns(classes, 'new');
      var prep = prepareUpload(file.rows, cols);
      var res = Bulk.processUpload(prep.rows, ['first_name', 'last_name', 'class_name'], function (row) {
        var rr = readRow(row, cols, prep.present, false);
        var errs = rr.errs.slice();
        var cls = classes.filter(function (c) { return c.name.toLowerCase() === (row.class_name || '').toLowerCase(); })[0];
        if (!cls && String(row.class_name || '').trim()) errs.push('unknown class "' + row.class_name + '"');
        if (errs.length) return { ok: false, errors: errs };
        var v = { first_name: rr.out.first_name, last_name: rr.out.last_name, gender: rr.out.gender || '', dob: rr.out.dob || '', class_id: cls.id, parent_name: rr.out.parent_name || '', parent_phone: rr.out.parent_phone || '', status: 'active', admitted_on: U.todayISO() };
        if (Object.keys(rr.extra).length) v.extra = rr.extra;
        return { ok: true, value: v };
      });
      friendlyMissing(res, cols); fixLines(res, prep); res.notes = prep.notes;
      Bulk.summaryModal('Import admissions', res, function (valid) {
        var i = 0;
        function step() {
          if (i >= valid.length) { U.toast('Imported ' + valid.length + ' student(s).'); done(); return; }
          var v = valid[i++];
          DB.nextCode('student', rules.student_prefix, rules.digits).then(function (code) {
            v.student_id = code; v.id = 'stu-' + code;
            var pname = v.parent_name; var pphone = v.parent_phone;
            delete v.parent_name; delete v.parent_phone;
            DB.insert('students', v).then(function () {
              if (pname) {
                DB.insert('parents', { name: pname, phone: pphone, whatsapp: pphone, student_ids: [code] }).then(function (par) { DB.update('students', v.id, { parent_id: par.id }).then(step); });
              } else step();
            });
          });
        }
        step();
      });
    }).catch(function () {});
  }

  /* ---------- Update existing students (download current data → fill → upload to update) ---------- */
  function updateExistingCard(students, classes, refresh) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: 'Update existing student records' }));
    card.appendChild(el('div', { class: 'help', text: 'Download a spreadsheet pre-filled with current details for a whole class or a single student, edit the values, then upload it back — matching rows UPDATE the existing record (student_id is the match key and must not change). Use this instead of the admissions template above when correcting or bulk-editing students already on roll. The columns always match your Admission Form (Settings → Admission Form): if you add or rename a field there, download a fresh template.' }));
    var scopeSel = el('select');
    [['class', 'Whole class'], ['one', 'Single student']].forEach(function (o) { scopeSel.appendChild(el('option', { value: o[0], text: o[1] })); });
    var clsSel = el('select');
    classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
    var stuSel = el('select', { style: 'display:none' });
    students.slice().sort(function (a, b) { return (a.first_name || '').localeCompare(b.first_name || ''); }).forEach(function (s) {
      stuSel.appendChild(el('option', { value: s.student_id, text: s.first_name + ' ' + s.last_name + ' (' + s.student_id + ')' }));
    });
    function syncVisibility() {
      clsSel.style.display = scopeSel.value === 'class' ? '' : 'none';
      stuSel.style.display = scopeSel.value === 'one' ? '' : 'none';
    }
    scopeSel.addEventListener('change', syncVisibility); syncVisibility();
    card.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Scope:' }), scopeSel, clsSel, stuSel]));
    card.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.5rem' }, [
      el('button', { class: 'btn ghost', text: '⤓ Download data template', onclick: function () { downloadUpdateTemplate(students, classes, scopeSel.value, clsSel.value, stuSel.value); } }),
      el('button', { class: 'btn gold', text: '⤒ Upload filled template', onclick: function () { uploadUpdateTemplate(classes, refresh); } })
    ]));
    return card;
  }
  function downloadUpdateTemplate(students, classes, scope, classId, studentId) {
    var list = scope === 'one' ? students.filter(function (s) { return s.student_id === studentId; }) : students.filter(function (s) { return s.class_id === classId; });
    if (!list.length) return U.toast('No matching student(s) to include.', 'err');
    var cols = admissionColumns(classes, 'update');
    var rows = [cols.map(headerText), cols.map(function (c, i) { return (i === 0 ? '#GUIDE ' : '') + c.hint; })];
    list.forEach(function (s) {
      var cls = classes.filter(function (c) { return c.id === s.class_id; })[0];
      var core = { student_id: s.student_id, first_name: s.first_name, last_name: s.last_name, gender: s.gender || '', dob: s.dob || '', class_name: cls ? cls.name : '', status: s.status || 'active', admitted_on: s.admitted_on || '' };
      rows.push(cols.map(function (c) {
        if (c.core) return core[c.key] == null ? '' : core[c.key];
        var v = s.extra ? s.extra[c.key] : '';
        if (c.type === 'checkbox') return v ? 'Yes' : 'No';
        return v == null ? '' : v;
      }));
    });
    var label = scope === 'one' ? studentId : ((classes.filter(function (c) { return c.id === classId; })[0] || {}).name || 'class');
    Bulk.download('update-students-' + String(label).replace(/\s+/g, '') + '.csv', rows);
    U.toast('Template downloaded. Keep student_id unchanged, edit the rest, delete the # row, then upload.');
  }
  function uploadUpdateTemplate(classes, done) {
    Bulk.pickFile().then(function (file) {
      DB.all('students').then(function (allStudents) {
        var byCode = {}; allStudents.forEach(function (s) { byCode[s.student_id] = s; });
        var cols = admissionColumns(classes, 'update');
        var prep = prepareUpload(file.rows, cols);
        var customPresent = cols.some(function (c) { return !c.core && prep.present[c.key]; });
        var res = Bulk.processUpload(prep.rows, ['student_id', 'first_name', 'last_name', 'class_name'], function (row) {
          var rr = readRow(row, cols, prep.present, true);
          var errs = rr.errs.slice();
          var existing = byCode[row.student_id];
          if (!existing) errs.push('unknown student_id ' + row.student_id);
          var cls = classes.filter(function (c) { return c.name.toLowerCase() === (row.class_name || '').toLowerCase(); })[0];
          if (!cls && String(row.class_name || '').trim()) errs.push('unknown class "' + row.class_name + '"');
          if (errs.length) return { ok: false, errors: errs };
          // Only the columns that are in the file are changed.
          var patch = { id: existing.id, class_id: cls.id };
          ['first_name', 'last_name', 'gender', 'dob', 'status', 'admitted_on'].forEach(function (k) { if (prep.present[k]) patch[k] = rr.out[k] == null ? '' : rr.out[k]; });
          if (prep.present.status && !patch.status) patch.status = 'active';
          if (customPresent) patch.extra = Object.assign({}, existing.extra || {}, rr.extra);
          return { ok: true, value: patch };
        });
        friendlyMissing(res, cols); fixLines(res, prep); res.notes = prep.notes;
        Bulk.summaryModal('Update students', res, function (valid) {
          var ops = valid.map(function (v) { var id = v.id; var patch = Object.assign({}, v); delete patch.id; return DB.update('students', id, patch); });
          Promise.all(ops).then(function () { U.toast('Updated ' + valid.length + ' student record(s).'); done(); });
        });
      });
    }).catch(function () {});
  }

  /* ---------- Student profile download (single / selected / whole class) ---------- */
  function profileFieldDefs() {
    var raw = App.ctx.admissionFields;
    var cfg = (Array.isArray(raw) && raw.length) ? raw : (global.SMS_SEED.admissionFields || []);
    return cfg.filter(function (d) { return d.inProfile !== false; });
  }
  function profileDownloadCard(students, classes) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: 'Download student profile' }));
    card.appendChild(el('div', { class: 'help', text: 'A printable profile sheet of a student’s core details — pick a class to narrow the list below, then tick who to include (one, several, or everyone). Which fields appear is controlled in Settings → Admission Form ("Include in profile download").' }));
    var clsSel = el('select');
    clsSel.appendChild(el('option', { value: '', text: 'All classes' }));
    classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
    var checks = {};
    var listBox = el('div', { style: 'max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:.5rem;margin:.5rem 0' });
    function drawList() {
      U.clear(listBox);
      var list = students.filter(function (s) { return !clsSel.value || s.class_id === clsSel.value; })
        .sort(function (a, b) { return (a.first_name || '').localeCompare(b.first_name || ''); });
      if (!list.length) { listBox.appendChild(el('div', { class: 'muted', text: 'No students in this class.' })); return; }
      list.forEach(function (s) {
        var cb = el('input', { type: 'checkbox' }); cb.checked = !!checks[s.student_id];
        cb.addEventListener('change', function () { checks[s.student_id] = cb.checked; });
        listBox.appendChild(el('label', { class: 'check-label', style: 'display:block' }, [cb, document.createTextNode(' ' + s.first_name + ' ' + s.last_name + ' (' + s.student_id + ')')]));
      });
    }
    clsSel.addEventListener('change', drawList); drawList();
    card.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Class:' }), clsSel]));
    card.appendChild(listBox);
    card.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn sm ghost', text: 'Select all shown', onclick: function () { U.$all('input[type=checkbox]', listBox).forEach(function (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }); } }),
      el('button', { class: 'btn sm ghost', text: 'Clear', onclick: function () { U.$all('input[type=checkbox]', listBox).forEach(function (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }); } }),
      el('button', { class: 'btn gold', text: '⤓ Download / print profile(s)', onclick: function () {
        var codes = Object.keys(checks).filter(function (k) { return checks[k]; });
        if (!codes.length) return U.toast('Tick at least one student.', 'err');
        downloadProfiles(students.filter(function (s) { return codes.indexOf(s.student_id) !== -1; }), classes);
      } })
    ]));
    return card;
  }
  function downloadProfiles(list, classes) {
    var fields = profileFieldDefs();
    var sch = App.ctx.school;
    var brand = (App.themeHex ? App.themeHex().primary : '#0f5e5e');
    function fieldValue(s, def) {
      if (def.system) {
        if (def.key === 'class_id') { var c = classes.filter(function (x) { return x.id === s.class_id; })[0]; return c ? c.name : '—'; }
        if (def.key === 'parent_id') { var p = (App.ctx.parents || []).filter(function (x) { return x.id === s.parent_id; })[0]; return p ? p.name : '—'; }
        return s[def.key] || '—';
      }
      var v = s.extra ? s.extra[def.key] : null;
      if (def.type === 'siblings') return (v || []).map(function (r) { return r.name + (r.cls ? ' (' + r.cls + ')' : ''); }).join(', ') || '—';
      if (def.type === 'checkbox') return v ? 'Yes' : 'No';
      return (v == null || v === '') ? '—' : v;
    }
    var html = list.map(function (s) {
      var rows = fields.map(function (d) { return '<tr><td class="lbl">' + U.esc(d.label) + '</td><td>' + U.esc(String(fieldValue(s, d))) + '</td></tr>'; }).join('');
      return '<div class="profile-sheet"><h1>' + U.esc(sch.name) + '</h1><h3>Student Profile</h3>' +
        '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">' + rows + '</table></div>';
    }).join('<div style="page-break-after:always"></div>');
    var wn = window.open('', '_blank');
    wn.document.write('<html><head><title>Student profiles</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:22px;color:#1c2726}table{margin-bottom:14px}td{border:1px solid #999;padding:6px;font-size:13px}td.lbl{font-weight:600;background:#faf8f3;width:220px}h1,h3{color:' + brand + ';margin:.3rem 0}</style></head><body>' + html + '</body></html>');
    wn.document.close(); wn.focus(); setTimeout(function () { wn.print(); }, 300);
  }

  function bySort(a, b) { return (a.sort || 0) - (b.sort || 0); }
  global.Views = global.Views || {};
  global.Views.students = { title: 'Students', render: render };
})(window);
