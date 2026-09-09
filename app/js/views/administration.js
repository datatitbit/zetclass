/* ============================================================
 * administration.js — Staff records + cross-cutting reports
 * (exam, finance, attendance) with time filters and exports.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB, App = global.App, Bulk = global.Bulk,
    Reports = global.Reports, FL = global.FinanceLib, Academics = global.Academics, G = global.Grading;
  var el = U.el;

  function render(container) {
    U.clear(container);
    container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'Administration & Reporting' })]));
    var bar = el('div', { class: 'tabs' }); var panel = el('div'); var active = 'Reports';
    ['Reports', 'Staff', 'Permissions'].forEach(function (t) { var b = el('button', { text: t, onclick: function () { active = t; draw(); } }); b._t = t; bar.appendChild(b); });
    container.appendChild(bar); container.appendChild(panel);
    function draw() { U.$all('button', bar).forEach(function (b) { b.classList.toggle('active', b._t === active); }); U.clear(panel);
      if (active === 'Staff') tabStaff(panel); else if (active === 'Permissions') tabPerms(panel); else tabReports(panel); }
    draw();
  }

  /* ---------------- Reports ---------------- */
  // Every report below follows the same shape: an optional Reports.timeFilter
  // (Today/Week/Month/Term/Year/All — reused as-is, not reinvented) where a
  // date range is meaningful, a table, and a "⤓ Export CSV" button using
  // Bulk.download — the same pattern already proven by examReport/
  // financeReport/attendanceReport below. This is the one screen where
  // Admin/Director (and Other staff, per the existing permission matrix) can
  // download whole-school data instead of item-by-item exports scattered
  // across other screens.
  function tabReports(panel) {
    var sub = el('div', { class: 'tabs' }); var area = el('div'); var which = 'exam';
    [['enrolment', 'Enrolment'], ['attendance', 'Attendance'], ['staffAttendance', 'Staff Attendance'],
      ['exam', 'Academic Report'], ['finance', 'Finance'], ['fees', 'Bills']].forEach(function (o) {
      var b = el('button', { text: o[1], onclick: function () { which = o[0]; redraw(); } }); b._w = o[0]; sub.appendChild(b);
    });
    panel.appendChild(sub); panel.appendChild(area);
    function redraw() {
      U.$all('button', sub).forEach(function (b) { b.classList.toggle('active', b._w === which); }); U.clear(area);
      ({ exam: examReport, finance: financeReport, attendance: attendanceReport,
        enrolment: enrolmentReport, staffAttendance: staffAttendanceReport, fees: feesReport })[which](area);
    }
    redraw();
  }

  function examReport(area) {
    var term = App.ctx.academic.current_term;
    var classes = App.ctx.classes.slice().sort(function (a, b) { return a.sort - b.sort; });
    var clsSel = el('select'); classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
    area.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Class:' }), clsSel]));
    var box = el('div'); area.appendChild(box);
    clsSel.addEventListener('change', load); load();
    function load() {
      U.clear(box);
      var klass = classes.filter(function (c) { return c.id === clsSel.value; })[0];
      Academics.computeResults(klass, term).then(function (res) {
        var rows = res.students.map(function (s) {
          var subs = Object.keys(res.map[s.student_id]);
          var sum = subs.reduce(function (a, k) { return a + res.map[s.student_id][k].total; }, 0);
          var avg = subs.length ? Math.round(sum / subs.length * 10) / 10 : 0;
          return { name: s.first_name + ' ' + s.last_name, id: s.student_id, subjects: subs.length, avg: avg, pos: res.overallPos[s.student_id] };
        }).sort(function (a, b) { return (a.pos || 99) - (b.pos || 99); });
        var c = el('div', { class: 'card' });
        c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between' }, [
          el('h3', { text: 'Exam summary · ' + klass.name + ' · ' + App.termName() }),
          el('button', { class: 'btn ghost sm', text: '⤓ Export CSV', onclick: function () { Bulk.download('exam-summary-' + klass.name.replace(/\s+/g, '') + '.csv', [['Position', 'ID', 'Name', 'Subjects', 'Average %']].concat(rows.map(function (x) { return [x.pos || '', x.id, x.name, x.subjects, x.avg]; }))); } })
        ]));
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['Pos', 'Name', 'Subjects scored', 'Average %'].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody');
        rows.forEach(function (x) { tb.appendChild(el('tr', {}, [el('td', { text: x.pos ? G.ordinal(x.pos) : '—' }), el('td', { text: x.name }), el('td', { text: x.subjects }), el('td', { text: x.avg })])); });
        if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: 4, html: '<span class=empty>No pupils.</span>' })]));
        t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t]));
        c.appendChild(el('div', { class: 'help', text: 'Full printable report cards are produced in Assessment → Report Cards.' }));
        box.appendChild(c);
      });
    }
  }

  function financeReport(area) {
    var filter = Reports.timeFilter(function () { load(); });
    area.appendChild(filter.node);
    var box = el('div'); area.appendChild(box);
    load();
    function load() {
      U.clear(box);
      var range = filter.current();
      Promise.all([DB.all('payments'), DB.all('students')]).then(function (r) {
        var pays = r[0].filter(function (p) { return Reports.inRange(p.created_on, range); });
        var byMethod = {}; var total = 0;
        pays.forEach(function (p) { byMethod[p.method] = (byMethod[p.method] || 0) + Number(p.amount); total += Number(p.amount); });
        var c = el('div', { class: 'card' });
        c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between' }, [
          el('h3', { text: 'Collections · ' + range.label }),
          el('button', { class: 'btn ghost sm', text: '⤓ Export CSV', onclick: function () { Bulk.download('collections.csv', [['Receipt', 'Student', 'Amount', 'Method', 'Date']].concat(pays.map(function (p) { return [p.receipt_no, p.student_id, p.amount, p.method, p.created_on]; }))); } })
        ]));
        c.appendChild(el('div', { class: 'grid cols-3', style: 'margin:.5rem 0' }, [stat(U.money(total, App.ctx.school.currency), 'Total collected'), stat(pays.length, 'Payments'), stat(Object.keys(byMethod).length, 'Methods used')]));
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['Receipt', 'Student', 'Amount', 'Method', 'Date'].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody'); pays.slice().reverse().forEach(function (p) { tb.appendChild(el('tr', {}, [el('td', { text: p.receipt_no }), el('td', { text: p.student_id }), el('td', { text: U.money(p.amount, App.ctx.school.currency) }), el('td', { text: p.method }), el('td', { text: U.fmtDate(p.created_on) })])); });
        if (!pays.length) tb.appendChild(el('tr', {}, [el('td', { colspan: 5, html: '<span class=empty>No payments in this period.</span>' })]));
        t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t])); box.appendChild(c);
      });
    }
  }

  function attendanceReport(area) {
    var filter = Reports.timeFilter(function () { load(); });
    area.appendChild(filter.node);
    var box = el('div'); area.appendChild(box);
    load();
    function load() {
      U.clear(box);
      var range = filter.current();
      DB.all('attendance').then(function (att) {
        var rows = att.filter(function (a) { return Reports.inRange(a.date, range); });
        var byClass = {};
        rows.forEach(function (a) { byClass[a.class_id] = byClass[a.class_id] || { p: 0, t: 0 }; byClass[a.class_id].t++; if (a.status === 'present') byClass[a.class_id].p++; });
        var c = el('div', { class: 'card' });
        c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between' }, [
          el('h3', { text: 'Attendance · ' + range.label }),
          el('button', { class: 'btn ghost sm', text: '⤓ Export CSV', onclick: function () { Bulk.download('attendance-report.csv', [['Class', 'Present', 'Records', 'Rate %']].concat(Object.keys(byClass).map(function (cid) { var b = byClass[cid]; return [App.className(cid), b.p, b.t, Math.round(b.p / b.t * 100)]; }))); } })
        ]));
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['Class', 'Present', 'Records', 'Rate'].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody');
        Object.keys(byClass).forEach(function (cid) { var b = byClass[cid]; tb.appendChild(el('tr', {}, [el('td', { text: App.className(cid) }), el('td', { text: b.p }), el('td', { text: b.t }), el('td', { text: Math.round(b.p / b.t * 100) + '%' })])); });
        if (!Object.keys(byClass).length) tb.appendChild(el('tr', {}, [el('td', { colspan: 4, html: '<span class=empty>No attendance in this period.</span>' })]));
        t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t])); box.appendChild(c);
      });
    }
  }

  // Whole-school enrolment register. "All time" (the filter's default) shows
  // the full current roster; picking Today/Week/Month/Term/Year narrows to
  // students admitted within that period (new admissions), reusing the exact
  // same Reports.timeFilter control as every other report on this screen.
  function enrolmentReport(area) {
    var filter = Reports.timeFilter(function () { load(); });
    var classes = App.ctx.classes.slice().sort(function (a, b) { return a.sort - b.sort; });
    var clsSel = el('select'); clsSel.appendChild(el('option', { value: '', text: 'All classes' }));
    classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
    clsSel.addEventListener('change', load);
    var statusSel = el('select');
    [['', 'All statuses'], ['active', 'Active'], ['withdrawn', 'Withdrawn'], ['completed', 'Completed']].forEach(function (o) { statusSel.appendChild(el('option', { value: o[0], text: o[1] })); });
    statusSel.addEventListener('change', load);
    // Appended onto the filter's own toolbar node (one bar), not a second
    // .toolbar — two stacked toolbars would each carry their own margin and
    // read as disconnected control rows instead of one filter line.
    filter.node.appendChild(el('span', { class: 'muted', text: 'Class:' }));
    filter.node.appendChild(clsSel);
    filter.node.appendChild(el('span', { class: 'muted', text: 'Status:' }));
    filter.node.appendChild(statusSel);
    area.appendChild(filter.node);
    var box = el('div'); area.appendChild(box);
    load();
    function load() {
      U.clear(box);
      var range = filter.current();
      var narrowByDate = range.label !== 'All time';
      DB.all('students').then(function (all) {
        var rows = all.filter(function (s) {
          if (clsSel.value && s.class_id !== clsSel.value) return false;
          if (statusSel.value && (s.status || 'active') !== statusSel.value) return false;
          if (narrowByDate && !Reports.inRange(s.admitted_on, range)) return false;
          return true;
        });
        var c = el('div', { class: 'card' });
        c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between' }, [
          el('h3', { text: 'Enrolment · ' + (narrowByDate ? 'Admitted ' + range.label : 'Full roster') }),
          el('button', { class: 'btn ghost sm', text: '⤓ Export CSV', onclick: function () {
            Bulk.download('enrolment-register.csv', [['Student ID', 'Name', 'Class', 'Gender', 'Status', 'Admitted on', 'Parent/Guardian']].concat(rows.map(function (s) {
              var parent = (App.ctx.parents || []).filter(function (p) { return p.id === s.parent_id; })[0];
              return [s.student_id, s.first_name + ' ' + s.last_name, App.className(s.class_id), s.gender || '', s.status || 'active', s.admitted_on || '', parent ? parent.name : ''];
            })));
          } })
        ]));
        var activeN = rows.filter(function (s) { return (s.status || 'active') === 'active'; }).length;
        var withdrawnN = rows.filter(function (s) { return s.status === 'withdrawn'; }).length;
        c.appendChild(el('div', { class: 'grid cols-3', style: 'margin:.5rem 0' }, [stat(rows.length, 'In this view'), stat(activeN, 'Active'), stat(withdrawnN, 'Withdrawn')]));
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['Student ID', 'Name', 'Class', 'Gender', 'Status', 'Admitted on'].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody');
        rows.forEach(function (s) { tb.appendChild(el('tr', {}, [el('td', { text: s.student_id }), el('td', { text: s.first_name + ' ' + s.last_name }), el('td', { text: App.className(s.class_id) }), el('td', { text: s.gender || '—' }), el('td', {}, [el('span', { class: 'tag ' + (s.status === 'active' ? '' : 'muted'), text: s.status || 'active' })]), el('td', { text: s.admitted_on ? U.fmtDate(s.admitted_on) : '—' })])); });
        if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: 6, html: '<span class=empty>No students match this filter.</span>' })]));
        t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t])); box.appendChild(c);
      });
    }
  }

  // Mirrors attendanceReport() exactly, one row per staff member instead of
  // per class (staff aren't grouped into classes the way students are).
  function staffAttendanceReport(area) {
    var filter = Reports.timeFilter(function () { load(); });
    area.appendChild(filter.node);
    var box = el('div'); area.appendChild(box);
    load();
    function load() {
      U.clear(box);
      var range = filter.current();
      Promise.all([DB.all('staffAttendance'), DB.all('staff')]).then(function (r) {
        var att = r[0].filter(function (a) { return Reports.inRange(a.date, range); });
        var staffByCode = {}; r[1].forEach(function (s) { staffByCode[s.staff_id] = s; });
        var byStaff = {};
        att.forEach(function (a) {
          byStaff[a.staff_id] = byStaff[a.staff_id] || { p: 0, t: 0 };
          byStaff[a.staff_id].t++; if (a.status === 'present') byStaff[a.staff_id].p++;
        });
        var codes = Object.keys(byStaff);
        var c = el('div', { class: 'card' });
        c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between' }, [
          el('h3', { text: 'Staff attendance · ' + range.label }),
          el('button', { class: 'btn ghost sm', text: '⤓ Export CSV', onclick: function () {
            Bulk.download('staff-attendance-report.csv', [['Staff ID', 'Name', 'Role', 'Present', 'Records', 'Rate %']].concat(codes.map(function (code) {
              var b = byStaff[code], s = staffByCode[code];
              return [code, s ? s.name : code, s ? s.role : '', b.p, b.t, Math.round(b.p / b.t * 100)];
            })));
          } })
        ]));
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['Staff ID', 'Name', 'Role', 'Present', 'Records', 'Rate'].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody');
        codes.forEach(function (code) { var b = byStaff[code], s = staffByCode[code]; tb.appendChild(el('tr', {}, [el('td', { text: code }), el('td', { text: s ? s.name : code }), el('td', { text: s ? s.role : '—' }), el('td', { text: b.p }), el('td', { text: b.t }), el('td', { text: Math.round(b.p / b.t * 100) + '%' })])); });
        if (!codes.length) tb.appendChild(el('tr', {}, [el('td', { colspan: 6, html: '<span class=empty>No staff attendance recorded in this period.</span>' })]));
        t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t])); box.appendChild(c);
      });
    }
  }

  // Per-student bill: billed / paid / arrears / next term's fees / total
  // payable, plus a Paid-Unpaid status at a glance — the counterpart to
  // Academic Report (exam summary) below. Term-scoped rather than
  // day/week/month, since fee types and invoices are inherently billed per
  // term in this app (see finance-lib.js), not by calendar date, so a term
  // picker is the filter that's actually meaningful here. "Next term's fees"
  // reuses FinanceLib.studentFeePosition's own convention (relative to the
  // school's actual current term, same as the Parent dashboard/portal) —
  // it does not shift if you pick a past term above, since a past term's
  // "next term" bill isn't a real quantity a school bills against.
  function feesReport(area) {
    var terms = App.ctx.academic.terms.slice().sort(function (a, b) { return a.n - b.n; });
    var termSel = el('select');
    terms.forEach(function (t) { var o = el('option', { value: t.n, text: t.name }); if (t.n === App.ctx.academic.current_term) o.selected = true; termSel.appendChild(o); });
    termSel.addEventListener('change', load);
    area.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Term:' }), termSel]));
    var box = el('div'); area.appendChild(box);
    load();
    function load() {
      U.clear(box);
      var term = Number(termSel.value);
      Promise.all([DB.all('students'), DB.all('invoices'), DB.all('payments')]).then(function (r) {
        var students = r[0].filter(function (s) { return s.status === 'active'; });
        var invoices = r[1].filter(function (i) { return i.term === term; });
        var payments = r[2].filter(function (p) { return p.term === term; });
        var cur = App.ctx.school.currency;
        var rows = students.map(function (s) {
          var klass = App.ctx.classes.filter(function (c) { return c.id === s.class_id; })[0];
          var pos = FL.studentFeePosition(s.student_id, klass, invoices, payments, App.ctx.feeTypes);
          return { code: s.student_id, name: s.first_name + ' ' + s.last_name, cls: klass ? klass.name : '',
            billed: pos.billed, paid: pos.paid, arrears: pos.arrears, next: pos.next, payable: pos.payable,
            status: pos.arrears > 0 ? 'Unpaid' : 'Paid' };
        }).sort(function (a, b) { return b.arrears - a.arrears; });
        var totalBilled = rows.reduce(function (a, r2) { return a + r2.billed; }, 0);
        var totalPaid = rows.reduce(function (a, r2) { return a + r2.paid; }, 0);
        var totalArrears = rows.reduce(function (a, r2) { return a + r2.arrears; }, 0);
        var totalNext = rows.reduce(function (a, r2) { return a + r2.next; }, 0);
        var unpaidN = rows.filter(function (r2) { return r2.status === 'Unpaid'; }).length;
        var termName = (terms.filter(function (t) { return t.n === term; })[0] || {}).name || ('Term ' + term);
        var c = el('div', { class: 'card' });
        c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between' }, [
          el('h3', { text: 'Bills · ' + termName }),
          el('button', { class: 'btn ghost sm', text: '⤓ Export CSV', onclick: function () {
            Bulk.download('bills-' + termName.replace(/\s+/g, '') + '.csv', [['Student ID', 'Name', 'Class', 'Billed', 'Paid', 'Arrears', 'Next term fees', 'Total payable', 'Status']].concat(rows.map(function (r2) { return [r2.code, r2.name, r2.cls, r2.billed, r2.paid, r2.arrears, r2.next, r2.payable, r2.status]; })));
          } })
        ]));
        c.appendChild(el('div', { class: 'grid cols-4', style: 'margin:.5rem 0' }, [stat(U.money(totalBilled, cur), 'Total billed'), stat(U.money(totalPaid, cur), 'Total paid'), stat(U.money(totalArrears, cur), 'Total arrears'), stat(unpaidN, 'Students unpaid')]));
        c.appendChild(el('div', { class: 'help', text: 'Next term\'s fees (' + U.money(totalNext, cur) + ' school-wide) reflect the upcoming term regardless of which term is selected above.' }));
        var t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, ['Student ID', 'Name', 'Class', 'Billed', 'Paid', 'Arrears', 'Next term fees', 'Total payable', 'Status'].map(function (h) { return el('th', { text: h }); }))]));
        var tb = el('tbody');
        rows.forEach(function (r2) { tb.appendChild(el('tr', {}, [el('td', { text: r2.code }), el('td', { text: r2.name }), el('td', { text: r2.cls }), el('td', { text: U.money(r2.billed, cur) }), el('td', { text: U.money(r2.paid, cur) }), el('td', { text: U.money(r2.arrears, cur) }), el('td', { text: U.money(r2.next, cur) }), el('td', { text: U.money(r2.payable, cur) }), el('td', {}, [el('span', { class: 'tag ' + (r2.status === 'Paid' ? '' : 'req'), text: r2.status })])])); });
        if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: 9, html: '<span class=empty>No active students.</span>' })]));
        t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t])); box.appendChild(c);
      });
    }
  }

  /* ---------------- Staff ---------------- */
  function tabStaff(panel) {
    var canEdit = App.canEdit('Administration');
    Promise.all([DB.all('staff'), DB.all('classes')]).then(function (r) {
      var staff = r[0], classes = r[1].sort(function (a, b) { return a.sort - b.sort; });
      if (canEdit) {
        var tools = el('div', { class: 'toolbar' });
        tools.appendChild(el('button', { class: 'btn', text: '+ Add staff', onclick: function () { editStaff(null, classes, refresh); } }));
        tools.appendChild(el('button', { class: 'btn ghost sm', text: '⤓ New-staff template', onclick: function () { downloadStaffTemplate(classes); } }));
        tools.appendChild(el('button', { class: 'btn ghost sm', text: '⤒ Upload new staff', onclick: function () { uploadStaff(classes, refresh); } }));
        tools.appendChild(el('button', { class: 'btn gold sm', text: '⤒ Upload staff update', onclick: function () { uploadStaffUpdate(classes, refresh); } }));
        panel.appendChild(tools);
        panel.appendChild(el('div', { class: 'help', text: 'To update one staff member: click "Update template" on their row below, edit the downloaded file, then use "Upload staff update" above — matching rows update the existing record (staff_id is the match key and must not change).' }));
      }
      var c = el('div', { class: 'card' });
      var t = el('table', { class: 'data' });
      t.appendChild(el('thead', {}, [el('tr', {}, ['Staff ID', 'Name', 'Role', 'Phone', 'Classes', ''].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      staff.forEach(function (s) {
        var cnames = (s.class_ids || []).map(function (id) { return App.className(id); }).join(', ') || '—';
        tb.appendChild(el('tr', {}, [el('td', { text: s.staff_id }), el('td', { text: s.name }), el('td', {}, [el('span', { class: 'tag', text: s.role })]), el('td', { text: s.phone || '—' }), el('td', { text: cnames }), el('td', {}, [canEdit ? el('div', { class: 'wrap-actions' }, [
          el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editStaff(s, classes, refresh); } }),
          el('button', { class: 'btn sm ghost', text: '⤓ Update template', onclick: function () { downloadStaffUpdateTemplate(s, classes); } }),
          el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { U.confirm('Delete ' + s.name + '?', function () { DB.remove('staff', s.id).then(refresh); }); } })
        ]) : null])]));
      });
      t.appendChild(tb); c.appendChild(el('div', { class: 'table-wrap' }, [t])); panel.appendChild(c);
    });
    function refresh() { U.clear(panel); tabStaff(panel); }
  }
  function editStaff(s, classes, done) {
    if (!App.canEdit('Administration')) return;
    var rules = App.ctx.idRules;
    var fields = [
      { name: 'name', label: 'Full name', required: true },
      { name: 'role', label: 'Role', type: 'select', options: global.SMS_SEED.constants.ROLES.filter(function (r) { return r !== 'Parent'; }) },
      { name: 'phone', label: 'Phone' }
    ];
    if (rules.allow_manual && !s) fields.unshift({ name: 'staff_id', label: 'Staff ID (blank = auto)', placeholder: rules.staff_prefix + '____' });
    var f = U.form(fields, s || { role: 'Teacher' });

    // ---- Class teacher of (entire class, all subjects) ----
    var clsBox = el('div', { class: 'field' }, [el('label', { text: 'Class teacher of (entire class, all subjects)' })]);
    var sel = el('div'); var cur = (s && s.class_ids) || [];
    classes.forEach(function (c) { var cb = el('input', { type: 'checkbox', value: c.id }); if (cur.indexOf(c.id) !== -1) cb.checked = true; sel.appendChild(el('label', { class: 'check-label', style: 'display:block' }, [cb, document.createTextNode(' ' + c.name)])); });
    clsBox.appendChild(sel); f.appendChild(clsBox);

    // ---- Subject teacher of (one subject, one or more classes) ----
    var allSubjects = []; classes.forEach(function (c) { (c.subjects || []).forEach(function (sub) { if (allSubjects.indexOf(sub) === -1) allSubjects.push(sub); }); });
    var subjBox = el('div', { class: 'field' }, [el('label', { text: 'Subject teacher of (one subject, across one or more classes)' })]);
    var subjRows = el('div');
    var assignments = JSON.parse(JSON.stringify((s && s.subject_teacher_of) || []));
    function redrawSubj() {
      U.clear(subjRows);
      assignments.forEach(function (a, i) {
        var subjSel = el('select'); allSubjects.forEach(function (sub) { var opt = el('option', { value: sub, text: sub }); if (sub === a.subject) opt.selected = true; subjSel.appendChild(opt); });
        subjSel.addEventListener('change', function (e) { assignments[i].subject = e.target.value; });
        var clsWrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:.5rem;margin:.25rem 0' });
        classes.forEach(function (c) {
          var cb = el('input', { type: 'checkbox', value: c.id }); if ((a.class_ids || []).indexOf(c.id) !== -1) cb.checked = true;
          cb.addEventListener('change', function () {
            var ids = assignments[i].class_ids || (assignments[i].class_ids = []);
            var pos = ids.indexOf(c.id);
            if (cb.checked && pos === -1) ids.push(c.id); else if (!cb.checked && pos !== -1) ids.splice(pos, 1);
          });
          clsWrap.appendChild(el('label', { class: 'check-label' }, [cb, document.createTextNode(' ' + c.name)]));
        });
        subjRows.appendChild(el('div', { style: 'border:1px solid var(--line);border-radius:8px;padding:.5rem;margin-bottom:.5rem' }, [
          el('div', { class: 'flex', style: 'justify-content:space-between;align-items:center' }, [subjSel, el('button', { class: 'btn sm danger', text: '✕', onclick: function () { assignments.splice(i, 1); redrawSubj(); } })]),
          clsWrap
        ]));
      });
      subjRows.appendChild(el('button', { class: 'btn sm ghost', text: '+ Add subject assignment', onclick: function () {
        if (!allSubjects.length) return U.toast('No subjects defined yet — add subjects to classes first (Settings → Classes & Subjects).', 'err');
        assignments.push({ subject: allSubjects[0], class_ids: [] }); redrawSubj();
      } }));
    }
    redrawSubj();
    subjBox.appendChild(subjRows); f.appendChild(subjBox);

    // ---- Full dashboard access ----
    var dashCb = el('input', { type: 'checkbox' }); if (s && s.dashboard_full_access) dashCb.checked = true;
    f.appendChild(el('div', { class: 'field' }, [el('label', { class: 'check-label' }, [dashCb, document.createTextNode(' Full dashboard access (Finance KPIs, not just Enrolment/Attendance) — Admin and Director already have this by default; tick this for anyone else (e.g. whoever actually handles fees/accounts) who should see it too.')])]));

    // ---- Per-person module restriction (Other staff only) ----
    // "Other staff" is one shared role for very different jobs — cooks,
    // security, front desk, accounts. By default everyone in it gets the
    // same modules. This lets an Admin narrow one individual person down to
    // only the modules they actually need, without changing the role-wide
    // default for everyone else tagged "Other staff". Leave everything
    // unticked (or tick them all) for "no restriction" — the normal role
    // default applies.
    var restrictModules = global.SMS_SEED.constants.MODULES.filter(function (m) { return ['Finance', 'Accounting', 'Payroll', 'Inventory', 'Students', 'Administration', 'Dashboard', 'Communication'].indexOf(m) !== -1; });
    var restrictBox = el('div', { class: 'field' }, [
      el('label', { text: 'Restrict this person to specific modules (optional)' }),
      el('div', { class: 'help', text: 'Only applies to the "Other staff" role. Leave all unticked for no restriction (this person gets the normal "Other staff" access). Tick specific modules to limit them to just those — e.g. a cook or security account might only need Dashboard.' })
    ]);
    var restrictWrap = el('div');
    var curRestrict = (s && s.module_restrict) || [];
    restrictModules.forEach(function (m) {
      var cb = el('input', { type: 'checkbox', value: m }); if (curRestrict.indexOf(m) !== -1) cb.checked = true;
      restrictWrap.appendChild(el('label', { class: 'check-label', style: 'display:block' }, [cb, document.createTextNode(' ' + m)]));
    });
    restrictBox.appendChild(restrictWrap);
    f.appendChild(restrictBox);
    function syncRestrictVisibility() {
      var roleSel = document.getElementById('f_role');
      restrictBox.style.display = (roleSel && roleSel.value === 'Other staff') ? '' : 'none';
    }
    var roleSelEl = document.getElementById('f_role');
    if (roleSelEl) roleSelEl.addEventListener('change', syncRestrictVisibility);
    syncRestrictVisibility();

    U.modal({ title: s ? 'Edit staff' : 'Add staff', wide: true, body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues(); if (!v.name.trim()) return U.toast('Name required', 'err');
        v.class_ids = U.$all('input[type=checkbox]', sel).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        v.subject_teacher_of = assignments.filter(function (a) { return a.subject && (a.class_ids || []).length; });
        v.dashboard_full_access = dashCb.checked;
        // Only meaningful for "Other staff" — cleared for every other role so a
        // stale restriction never lingers if someone's role is later changed
        // away from "Other staff" and back.
        v.module_restrict = (v.role === 'Other staff')
          ? U.$all('input[type=checkbox]', restrictWrap).filter(function (c) { return c.checked; }).map(function (c) { return c.value; })
          : [];
        if (s) DB.update('staff', s.id, v).then(function () { x(); U.toast('Saved.'); done(); });
        else {
          var manualCode = v.staff_id && v.staff_id.trim();
          var go = manualCode ? Promise.resolve(manualCode) : DB.nextCode('staff', rules.staff_prefix, rules.digits);
          go.then(function (code) {
            if (!manualCode) { proceed(code); return; }
            DB.all('staff').then(function (all) {
              if (all.some(function (x2) { return x2.staff_id === code; })) return U.toast('Staff ID "' + code + '" is already in use — choose a different ID.', 'err');
              proceed(code);
            });
          });
          function proceed(code) { v.staff_id = code; DB.insert('staff', v).then(function () { x(); U.toast('Added ' + code); done(); }); }
        }
      } }
    ] });
  }

  /* ---------- Bulk staff upload ---------- */
  function downloadStaffTemplate(classes) {
    var roles = global.SMS_SEED.constants.ROLES.filter(function (r) { return r !== 'Parent'; });
    var rows = [['name', 'role', 'phone', 'class_names']];
    rows.push(['Sample Teacher', 'Teacher', '+233...', classes[0] ? classes[0].name : '']);
    Bulk.download('staff-template.csv', rows);
    U.toast('Template downloaded. Role must be one of: ' + roles.join(', ') + '. class_names is only used for Teachers — separate multiple classes with a semicolon.');
  }
  function uploadStaff(classes, done) {
    var rules = App.ctx.idRules;
    var roles = global.SMS_SEED.constants.ROLES.filter(function (r) { return r !== 'Parent'; });
    Bulk.pickFile().then(function (file) {
      var res = Bulk.processUpload(file.rows, ['name', 'role'], function (row) {
        var errs = [];
        if (!row.name) errs.push('name missing');
        if (roles.indexOf(row.role) === -1) errs.push('role must be one of: ' + roles.join(', '));
        var classIds = [];
        if (row.class_names) {
          row.class_names.split(';').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (cn) {
            var m = classes.filter(function (c) { return c.name.toLowerCase() === cn.toLowerCase(); })[0];
            if (!m) errs.push('unknown class "' + cn + '"'); else classIds.push(m.id);
          });
        }
        if (errs.length) return { ok: false, errors: errs };
        return { ok: true, value: { name: row.name, role: row.role, phone: row.phone || '', class_ids: classIds } };
      });
      Bulk.summaryModal('Import staff', res, function (valid) {
        DB.all('staff').then(function (existing) {
          var used = {}; existing.forEach(function (s) { used[s.staff_id] = true; });
          var i = 0;
          function step() {
            if (i >= valid.length) { U.toast('Imported ' + valid.length + ' staff record(s).'); done(); return; }
            var v = valid[i++];
            DB.nextCode('staff', rules.staff_prefix, rules.digits).then(function (code) {
              while (used[code]) code = rules.staff_prefix + (parseInt(code.replace(rules.staff_prefix, ''), 10) + 1);
              used[code] = true; v.staff_id = code;
              DB.insert('staff', v).then(step);
            });
          }
          step();
        });
      });
    }).catch(function () { /* user cancelled file picker */ });
  }

  /* ---- Update one staff member (download current data → fill → upload to update) ---- */
  function downloadStaffUpdateTemplate(s, classes) {
    var cnames = (s.class_ids || []).map(function (id) { var c = classes.filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; }).filter(Boolean).join(';');
    var rows = [['staff_id', 'name', 'role', 'phone', 'class_names'], [s.staff_id, s.name, s.role, s.phone || '', cnames]];
    Bulk.download('update-staff-' + s.staff_id + '.csv', rows);
    U.toast('Template downloaded — keep staff_id unchanged, edit the rest, then use "Upload staff update".');
  }
  function uploadStaffUpdate(classes, done) {
    var roles = global.SMS_SEED.constants.ROLES.filter(function (r) { return r !== 'Parent'; });
    Bulk.pickFile().then(function (file) {
      DB.all('staff').then(function (existing) {
        var byCode = {}; existing.forEach(function (s) { byCode[s.staff_id] = s; });
        var res = Bulk.processUpload(file.rows, ['staff_id', 'name', 'role'], function (row) {
          var errs = [];
          var current = byCode[row.staff_id];
          if (!current) errs.push('unknown staff_id ' + row.staff_id);
          if (!row.name) errs.push('name missing');
          if (roles.indexOf(row.role) === -1) errs.push('role must be one of: ' + roles.join(', '));
          var classIds = [];
          if (row.class_names) {
            row.class_names.split(';').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (cn) {
              var m = classes.filter(function (c) { return c.name.toLowerCase() === cn.toLowerCase(); })[0];
              if (!m) errs.push('unknown class "' + cn + '"'); else classIds.push(m.id);
            });
          }
          if (errs.length) return { ok: false, errors: errs };
          return { ok: true, value: { id: current.id, name: row.name, role: row.role, phone: row.phone || '', class_ids: classIds } };
        });
        Bulk.summaryModal('Update staff', res, function (valid) {
          var ops = valid.map(function (v) { var id = v.id; var patch = Object.assign({}, v); delete patch.id; return DB.update('staff', id, patch); });
          Promise.all(ops).then(function () { U.toast('Updated ' + valid.length + ' staff record(s).'); done(); });
        });
      });
    }).catch(function () { /* user cancelled file picker */ });
  }

  function tabPerms(panel) {
    panel.appendChild(el('div', { class: 'note', text: 'The full permission matrix is edited in Settings → Roles. Admin is always full access.' }));
    panel.appendChild(el('button', { class: 'btn', text: 'Open Settings → Roles', onclick: function () { location.hash = '#/settings'; } }));
  }

  function stat(n, l) { return el('div', { class: 'stat accent' }, [el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l })]); }
  global.Views = global.Views || {};
  global.Views.administration = { title: 'Administration', render: render };
})(window);
