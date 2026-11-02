/* ============================================================
 * dashboard.js — role-aware key figures, finance KPIs, key dates.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB, App = global.App, FL = global.FinanceLib;
  var el = U.el;

  function render(container) {
    U.clear(container);
    container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'Dashboard' }),
      el('div', { class: 'spacer' }), el('span', { class: 'muted', text: App.user.role + ' · ' + App.user.name })]));

    // Parents get a compact ward summary; everyone else (incl. view-only Director) gets the full board.
    if (App.user.role === 'Parent') return parentDash(container);

    var term = App.ctx.academic.current_term;
    var fullBoard = App.canFullDashboard();
    Promise.all([DB.all('students'), DB.all('invoices'), DB.all('payments'), DB.all('attendance'), DB.all('staff'), DB.all('inventoryItems'), DB.all('otherIncome'), DB.all('expenses')])
      .then(function (r) {
        var allStudents = r[0], students = allStudents.filter(function (s) { return s.status === 'active'; });
        var allPayments = r[2];
        var invoices = r[1].filter(function (i) { return i.term === term; });
        var payments = allPayments.filter(function (p) { return p.term === term; });
        var attendance = r[3], staff = r[4], items = r[5], otherIncome = r[6], expenses = r[7];
        var cur = App.ctx.school.currency;

        var billed = 0, paid = 0;
        students.forEach(function (s) {
          var klass = App.ctx.classes.filter(function (c) { return c.id === s.class_id; })[0];
          var pos = FL.studentFeePosition(s.student_id, klass, invoices, payments, App.ctx.feeTypes);
          billed += pos.billed; paid += pos.paid;
        });
        var low = items.filter(function (i) { return Number(i.qty) <= Number(i.low_threshold || 0); });

        // ---- Quick nav (kept small & separate from the two core sections below) ----
        var stats = el('div', { class: 'grid cols-4' });
        function s(n, l, route, accent) {
          var d = el('div', { class: 'stat' + (accent ? ' accent' : '') + (route ? ' kpi-link' : '') }, [el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l })]);
          if (route) d.addEventListener('click', function () { location.hash = '#/' + route; });
          return d;
        }
        stats.appendChild(s(students.length, 'Enrolment', 'students', true));
        if (App.can('Administration')) stats.appendChild(s(staff.length, 'Staff', 'administration'));
        if (App.can('Inventory')) stats.appendChild(s(low.length, 'Low-stock items', 'inventory', low.length > 0));
        container.appendChild(stats);

        // A brand-new school opens onto a screen of zeros — tell the Admin what to do first.
        if (allStudents.length === 0) gettingStarted(container);
        sampleDataBanner(container);

        // ---- Part 1: Enrolment & Attendance (all staff) ----
        enrolAttendanceCard(container, allStudents, attendance);

        // ---- Part 2: Finance (Admin / Director / staff individually granted access) ----
        if (fullBoard) financeKpiCard(container, { billed: billed, paid: paid, otherIncome: otherIncome, expenses: expenses, cur: cur, term: term });

        trendsSection(container, { students: allStudents, attendance: attendance, payments: allPayments, otherIncome: otherIncome, expenses: expenses, cur: cur });

        upcoming(container);
        announcements(container);
      });
  }

  /* ---------------- Sample-data reminder (Admin only) ---------------- */
  // While pretend pupils/parents/staff/stock are in the school, say so plainly and
  // offer the one-click way out, so nobody mistakes them for real records.
  function sampleDataBanner(container) {
    if (App.user.role !== 'Admin' || !global.SampleData) return;
    var slot = el('div'); container.appendChild(slot);
    global.SampleData.counts().then(function (c) {
      if (!c.total) return;
      slot.appendChild(el('div', { class: 'card', style: 'border:1px solid #e6c36a;background:#fff8e6' }, [
        el('h3', { text: 'You are looking at sample data' }),
        el('p', { text: 'Some of the pupils, fees, stock and other records you see are pretend ones so you can try every screen. When you are ready to use Zetclass for real, remove them. Anything you add yourself stays.' }),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn danger', text: 'Remove all sample data…', onclick: function () {
            U.confirm('Remove ALL sample data?\n\nThis deletes the sample pupils, parents, staff, fees, attendance, scores, stock, accounts and messages, and anything recorded against them.\n\nRecords you added yourself are NOT touched.\n\n(To remove only some groups, use Settings → Sample Data instead.)', function () {
              global.SampleData.remove().then(function () { return App.refresh(); }).then(function () { U.toast('Sample data removed.'); render(container); })
                .catch(function () { U.toast('Could not remove the sample data. Please try again.', 'err'); });
            });
          } }),
          el('a', { class: 'btn ghost', href: '#/settings', text: 'Choose what to remove…', onclick: function () { try { global.sessionStorage.setItem('zc-settings-tab', 'Sample Data'); } catch (e) { /* tab simply opens on Profile */ } } })
        ])
      ]));
    });
  }

  /* ---------------- First-run guide (Admin only, empty school) ---------------- */
  // Disappears by itself the moment the first student is added, so there is
  // nothing to dismiss or remember.
  function gettingStarted(container) {
    if (App.user.role !== 'Admin') return;
    var steps = [
      ['Add your school’s details and logo', 'settings', 'Settings → Profile'],
      ['Check your classes, subjects and fees', 'settings', 'Settings → Classes & Subjects, and Fees'],
      ['Add your first students', 'students', 'Students → add one by one, or upload a spreadsheet'],
      ['Add your teachers and staff', 'administration', 'Administration → Staff']
    ];
    var list = el('ol', { class: 'start-steps' });
    steps.forEach(function (st) {
      list.appendChild(el('li', {}, [el('a', { href: '#/' + st[1], text: st[0] }), el('div', { class: 'help', text: st[2] })]));
    });
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', { text: 'Welcome — let’s set up your school' }),
      el('p', { class: 'muted', text: 'Four quick steps. Each one opens the right page for you.' }),
      list
    ]));
  }

  /* ---------------- Part 1: Enrolment & Attendance ---------------- */
  function enrolAttendanceCard(container, allStudents, attendance) {
    var period = 'today';
    var head = el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:center' }, [el('h3', { text: 'Enrolment & Attendance' })]);
    var bar = el('div', { class: 'btn-row' });
    [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['term', 'This term']].forEach(function (pp) {
      var b = el('button', { class: 'btn sm' + (pp[0] === period ? ' gold' : ''), text: pp[1], onclick: function () { period = pp[0]; U.$all('button', bar).forEach(function (x2) { x2.classList.remove('gold'); }); b.classList.add('gold'); draw(); } });
      bar.appendChild(b);
    });
    head.appendChild(bar);
    var card = el('div', { class: 'card' }, [head]);
    var grid = el('div', { class: 'grid cols-5', style: 'margin-top:.5rem' });
    card.appendChild(grid);
    container.appendChild(card);
    draw();

    function draw() {
      U.clear(grid);
      var r = rangeFor(period), startISO = iso(r.start), endISO = iso(r.end);
      function inRange(d) { return d && d >= startISO && d <= endISO; }
      var totalEnrolled = allStudents.filter(function (s2) { return s2.status !== 'withdrawn'; }).length;
      var present = attendance.filter(function (a) { return a.status === 'present' && inRange(a.date); }).length;
      var absent = attendance.filter(function (a) { return a.status === 'absent' && inRange(a.date); }).length;
      var admissions = allStudents.filter(function (s2) { return inRange(s2.admitted_on); }).length;
      var dropouts = allStudents.filter(function (s2) { return s2.status === 'withdrawn' && inRange(s2.withdrawn_on); }).length;
      grid.appendChild(stat(totalEnrolled, 'Total enrolment'));
      grid.appendChild(stat(present, 'Present'));
      grid.appendChild(stat(absent, 'Absent'));
      grid.appendChild(stat(admissions, 'Admissions'));
      grid.appendChild(stat(dropouts, 'Dropouts'));
    }
  }

  /* ---------------- Part 2: Finance KPIs (top 4 of 7, admin-configurable) ---------------- */
  var FINANCE_KPIS = {
    feesCollected: { label: 'Fees Collected', compute: function (d) { return U.money(d.paid, d.cur); } },
    feesExpected:  { label: 'Total Fees Expected', compute: function (d) { return U.money(d.billed, d.cur); } },
    arrears:       { label: 'Arrears / Outstanding', compute: function (d) { return U.money(d.billed - d.paid, d.cur); } },
    collectionRate:{ label: 'Collection Rate', compute: function (d) { return (d.billed ? Math.round(d.paid / d.billed * 100) : 0) + '%'; } },
    otherIncome:   { label: 'Other Income', compute: function (d) { return U.money(d.otherIncomeSum, d.cur); } },
    totalExpenses: { label: 'Total Expenses', compute: function (d) { return U.money(d.expensesSum, d.cur); } },
    netPosition:   { label: 'Net Position (Income − Expenses)', compute: function (d) { return U.money(d.paid + d.otherIncomeSum - d.expensesSum, d.cur); } }
  };
  var FINANCE_KPI_DEFAULT = ['feesCollected', 'arrears', 'collectionRate', 'netPosition'];

  function financeKpiCard(container, D) {
    var termInvoiceScope = App.ctx.academic.current_term;
    var otherIncomeSum = D.otherIncome.filter(function (o) { return o.term === termInvoiceScope || !o.term; }).reduce(function (a, o) { return a + Number(o.amount || 0); }, 0);
    var expensesSum = D.expenses.filter(function (e) { return e.term === termInvoiceScope || !e.term; }).reduce(function (a, e) { return a + Number(e.amount || 0); }, 0);
    var data = { billed: D.billed, paid: D.paid, otherIncomeSum: otherIncomeSum, expensesSum: expensesSum, cur: D.cur };

    var head = el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:center' }, [el('h3', { text: 'Finance (' + App.termName() + ')' })]);
    if (App.user.role === 'Admin') head.appendChild(el('button', { class: 'btn sm ghost', text: 'Customize KPIs', onclick: function () { customizeFinanceKpis(function () { U.clear(card); buildBody(); }); } }));
    var card = el('div', { class: 'card' }, [head]);
    container.appendChild(card);
    buildBody();

    function buildBody() {
      var selected = (App.ctx.dashboardSettings && App.ctx.dashboardSettings.financeKpis && App.ctx.dashboardSettings.financeKpis.length) ? App.ctx.dashboardSettings.financeKpis : FINANCE_KPI_DEFAULT;
      var grid = el('div', { class: 'grid cols-4' });
      selected.slice(0, 4).forEach(function (key) {
        var k = FINANCE_KPIS[key]; if (!k) return;
        grid.appendChild(stat(k.compute(data), k.label));
      });
      card.appendChild(grid);
    }
  }

  function customizeFinanceKpis(done) {
    var current = (App.ctx.dashboardSettings && App.ctx.dashboardSettings.financeKpis) || FINANCE_KPI_DEFAULT.slice();
    var chosen = current.slice();
    var box = el('div');
    var countLine = el('div', { class: 'help' });
    function updateCount() { countLine.textContent = chosen.length + ' of 4 selected.'; }
    Object.keys(FINANCE_KPIS).forEach(function (key) {
      var cb = el('input', { type: 'checkbox' }); cb.checked = chosen.indexOf(key) !== -1;
      cb.addEventListener('change', function () {
        if (cb.checked) { if (chosen.length >= 4) { cb.checked = false; U.toast('You can pick at most 4.', 'err'); return; } chosen.push(key); }
        else chosen.splice(chosen.indexOf(key), 1);
        updateCount();
      });
      box.appendChild(el('label', { class: 'check-label', style: 'display:block;margin-bottom:.3rem' }, [cb, document.createTextNode(' ' + FINANCE_KPIS[key].label)]));
    });
    updateCount();
    box.appendChild(countLine);
    U.modal({ title: 'Customize Finance KPIs (pick up to 4 of 7)', body: box, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        if (!chosen.length) return U.toast('Pick at least 1 KPI.', 'err');
        DB.setSingleton('dashboardSettings', Object.assign({}, App.ctx.dashboardSettings, { financeKpis: chosen })).then(function () {
          App.refresh().then(function () { x(); U.toast('Dashboard KPIs saved.'); done(); });
        });
      } }
    ] });
  }


  /* ---------------- Trends (inline SVG, dependency-free) ---------------- */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) { var e = document.createElementNS(SVGNS, tag); if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
  function svgText(x, y, str, anchor, size) { var t = svg('text', { x: x, y: y, 'text-anchor': anchor || 'start', 'font-size': size || 10, fill: '#6b7280' }); t.textContent = str; return t; }
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function shortDay(isoStr) { var p = isoStr.split('-'); return p[2] + '/' + p[1]; }
  function shortMon(isoStr) { var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; var p = isoStr.split('-'); return m[Number(p[1]) - 1] + ' ' + p[0].slice(2); }

  function rangeFor(period) {
    var end = new Date(U.todayISO() + 'T00:00:00'); var start = new Date(end);
    if (period === 'today') { return { start: start, end: end, unit: 'day' }; }
    if (period === 'week') { start.setDate(end.getDate() - 6); return { start: start, end: end, unit: 'day' }; }
    if (period === 'month') { start.setDate(end.getDate() - 29); return { start: start, end: end, unit: 'day' }; }
    if (period === 'term') { start.setDate(end.getDate() - 119); return { start: start, end: end, unit: 'week' }; }
    start.setMonth(end.getMonth() - 11); start.setDate(1); return { start: start, end: end, unit: 'month' };
  }
  function makeBuckets(range) {
    var b = [], d = new Date(range.start);
    while (d <= range.end) {
      var st = new Date(d), en, label;
      if (range.unit === 'day') { en = new Date(d); label = shortDay(iso(st)); d.setDate(d.getDate() + 1); }
      else if (range.unit === 'week') { en = new Date(d); en.setDate(en.getDate() + 6); label = shortDay(iso(st)); d.setDate(d.getDate() + 7); }
      else { en = new Date(d.getFullYear(), d.getMonth() + 1, 0); label = shortMon(iso(st)); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
      b.push({ start: iso(st), end: iso(en), label: label });
    }
    return b;
  }
  function bucketIndex(buckets, dateStr) { if (!dateStr) return -1; for (var i = 0; i < buckets.length; i++) { if (dateStr >= buckets[i].start && dateStr <= buckets[i].end) return i; } return -1; }

  function lineChart(series, o) {
    o = o || {}; var W = 520, H = 158, pad = { l: 40, r: 10, t: 12, b: 22 };
    var vals = series.map(function (p) { return p.value; });
    var maxV = Math.max.apply(null, vals.concat([0])); var minV = o.zero ? 0 : Math.min.apply(null, vals.concat([0]));
    if (maxV === minV) maxV = minV + 1;
    var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, n = series.length;
    function x(i) { return pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function y(v) { return pad.t + ih - ((v - minV) / (maxV - minV)) * ih; }
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H });
    s.appendChild(svg('line', { x1: pad.l, y1: pad.t + ih, x2: pad.l + iw, y2: pad.t + ih, stroke: '#e5e7eb' }));
    s.appendChild(svgText(pad.l - 6, pad.t + 9, o.fmt ? o.fmt(maxV) : Math.round(maxV), 'end'));
    s.appendChild(svgText(pad.l - 6, pad.t + ih, o.fmt ? o.fmt(minV) : Math.round(minV), 'end'));
    var pts = series.map(function (p, i) { return x(i) + ',' + y(p.value); }).join(' ');
    s.appendChild(svg('polyline', { points: pts, fill: 'none', stroke: o.color || '#0f5e5e', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    var step = Math.max(1, Math.ceil(n / 6));
    series.forEach(function (p, i) {
      s.appendChild(svg('circle', { cx: x(i), cy: y(p.value), r: 2.4, fill: o.color || '#0f5e5e' }));
      if (n <= 8 || i % step === 0 || i === n - 1) s.appendChild(svgText(x(i), pad.t + ih + 14, p.label, 'middle', 9));
    });
    return s;
  }
  function barsChart(buckets, income, expense, o) {
    o = o || {}; var W = 520, H = 168, pad = { l: 46, r: 10, t: 12, b: 26 };
    var maxV = Math.max(1, Math.max.apply(null, income.concat(expense)));
    var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, n = buckets.length;
    var groupW = iw / n, bw = Math.max(3, Math.min(14, groupW / 3));
    function y(v) { return pad.t + ih - (v / maxV) * ih; }
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H });
    s.appendChild(svg('line', { x1: pad.l, y1: pad.t + ih, x2: pad.l + iw, y2: pad.t + ih, stroke: '#e5e7eb' }));
    s.appendChild(svgText(pad.l - 6, pad.t + 9, o.fmt ? o.fmt(maxV) : Math.round(maxV), 'end'));
    var step = Math.max(1, Math.ceil(n / 6));
    buckets.forEach(function (b, i) {
      var cx = pad.l + groupW * i + groupW / 2, inc = income[i] || 0, exp = expense[i] || 0;
      s.appendChild(svg('rect', { x: cx - bw - 1, y: y(inc), width: bw, height: (pad.t + ih) - y(inc), fill: '#0f5e5e', rx: 2 }));
      s.appendChild(svg('rect', { x: cx + 1, y: y(exp), width: bw, height: (pad.t + ih) - y(exp), fill: '#c99a2e', rx: 2 }));
      if (n <= 8 || i % step === 0 || i === n - 1) s.appendChild(svgText(cx, pad.t + ih + 14, b.label, 'middle', 9));
    });
    return s;
  }
  function chartBlock(title, node) { return el('div', { style: 'margin-top:.6rem' }, [el('div', { class: 'help', style: 'font-weight:600;color:var(--ink)', text: title }), node]); }
  function legend(items) { var w = el('div', { class: 'flex', style: 'gap:1rem;flex-wrap:wrap;margin:.2rem 0 .1rem' }); items.forEach(function (it) { w.appendChild(el('span', { class: 'flex', style: 'align-items:center;gap:.3rem;font-size:.75rem;color:var(--muted,#6b7280)' }, [el('span', { style: 'width:10px;height:10px;border-radius:2px;display:inline-block;background:' + it[1] }), document.createTextNode(it[0])])); }); return w; }

  function trendsSection(container, D) {
    var showFinance = App.canFullDashboard();
    var period = 'week';
    var head = el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:center' }, [el('h3', { text: 'Trends' })]);
    var bar = el('div', { class: 'btn-row' });
    [['week', 'Week'], ['month', 'Month'], ['term', 'Term'], ['year', 'Year']].forEach(function (pp) {
      var b = el('button', { class: 'btn sm' + (pp[0] === period ? ' gold' : ''), text: pp[1], onclick: function () { period = pp[0]; U.$all('button', bar).forEach(function (x) { x.classList.remove('gold'); }); b.classList.add('gold'); draw(); } });
      bar.appendChild(b);
    });
    head.appendChild(bar);
    var card = el('div', { class: 'card' }, [head]);
    var area = el('div'); card.appendChild(area);
    container.appendChild(card);
    draw();

    function draw() {
      U.clear(area);
      var buckets = makeBuckets(rangeFor(period));
      // Attendance rate per bucket
      var present = buckets.map(function () { return 0; }), tot = buckets.map(function () { return 0; });
      D.attendance.forEach(function (a) { var i = bucketIndex(buckets, a.date); if (i < 0) return; tot[i]++; if (a.status === 'present') present[i]++; });
      var attSeries = buckets.map(function (b, i) { return { label: b.label, value: tot[i] ? Math.round(present[i] / tot[i] * 100) : 0 }; });
      // Enrolment cumulative to bucket end
      var enrSeries = buckets.map(function (b) { return { label: b.label, value: D.students.filter(function (s) { return (s.admitted_on || '0000-00-00') <= b.end && s.status !== 'withdrawn'; }).length }; });
      // Finance income/expense per bucket
      var income = buckets.map(function () { return 0; }), expense = buckets.map(function () { return 0; });
      D.payments.forEach(function (p) { var i = bucketIndex(buckets, p.created_on); if (i >= 0) income[i] += Number(p.amount || 0); });
      (D.otherIncome || []).forEach(function (o) { var i = bucketIndex(buckets, o.date); if (i >= 0) income[i] += Number(o.amount || 0); });
      (D.expenses || []).forEach(function (e) { var i = bucketIndex(buckets, e.date); if (i >= 0) expense[i] += Number(e.amount || 0); });

      var hasAtt = tot.some(function (v) { return v > 0; });
      var PANEL = 'border:1px solid var(--line);border-radius:12px;padding:.75rem';
      var TITLE = 'font-weight:700;color:var(--brand,#0f5e5e);margin-bottom:.15rem';

      // Side 1 — Attendance & Enrolment
      var left = el('div', { style: PANEL }, [el('div', { style: TITLE, text: 'Attendance & Enrolment' })]);
      left.appendChild(chartBlock('Attendance rate (%)', hasAtt ? lineChart(attSeries, { color: '#0f5e5e', zero: true, fmt: function (v) { return Math.round(v) + '%'; } }) : el('div', { class: 'empty', text: 'No attendance recorded in this period yet.' })));
      left.appendChild(chartBlock('Enrolment (cumulative)', lineChart(enrSeries, { color: '#2563eb', zero: true })));

      if (!showFinance) { area.appendChild(left); return; }

      // Side 2 — Finance
      var hasFin = income.some(function (v) { return v > 0; }) || expense.some(function (v) { return v > 0; });
      var right = el('div', { style: PANEL }, [el('div', { style: TITLE, text: 'Finance' })]);
      if (hasFin) {
        right.appendChild(chartBlock('Income vs expenses (' + D.cur + ')', barsChart(buckets, income, expense, { fmt: function (v) { return U.money(v, D.cur); } })));
        right.appendChild(legend([['Income', '#0f5e5e'], ['Expenses', '#c99a2e']]));
      } else {
        right.appendChild(chartBlock('Income vs expenses (' + D.cur + ')', el('div', { class: 'empty', text: 'No finance activity recorded in this period yet.' })));
      }
      area.appendChild(el('div', { class: 'grid cols-2' }, [left, right]));
    }
  }

  function upcoming(container) {
    var ac = App.ctx.academic;
    var c = el('div', { class: 'card' }, [el('h3', { text: 'Key dates' })]);
    ac.terms.forEach(function (t) {
      c.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between;border-bottom:1px solid var(--line);padding:.25rem 0' }, [
        el('span', { text: t.name + (t.n === ac.current_term ? ' (current)' : '') }),
        el('span', { class: 'muted', text: 'Vacation ' + U.fmtDate(t.vacation) + ' · Reopen ' + U.fmtDate(t.reopening) })
      ]));
    });
    container.appendChild(c);
  }

  function announcements(container) {
    DB.all('announcements').then(function (anns) {
      if (!anns.length) return;
      var c = el('div', { class: 'card' }, [el('h3', { text: 'Latest announcements' })]);
      anns.slice(-3).reverse().forEach(function (a) { c.appendChild(el('div', { style: 'border-bottom:1px solid var(--line);padding:.3rem 0' }, [el('b', { text: a.title }), el('div', { class: 'help', text: a.body })])); });
      container.appendChild(c);
    });
  }

  function parentDash(container) {
    var codes = App.user.linked_student_ids || [];
    var term = App.ctx.academic.current_term;
    Promise.all([DB.all('students'), DB.all('invoices'), DB.all('payments'), DB.all('attendance'), DB.all('announcements')]).then(function (r) {
      var mine = r[0].filter(function (s) { return codes.indexOf(s.student_id) !== -1; });
      container.appendChild(el('div', { class: 'note', text: 'Welcome, ' + App.user.name + '. A quick summary of your ward(s) — open “My Ward” (Students) for the full report.' }));
      mine.forEach(function (s) {
        var klass = App.ctx.classes.filter(function (c) { return c.id === s.class_id; })[0];
        var pos = FL.studentFeePosition(s.student_id, klass, r[1].filter(function (i) { return i.term === term; }), r[2].filter(function (p) { return p.term === term; }), App.ctx.feeTypes);
        var present = r[3].filter(function (a) { return a.student_id === s.student_id && a.status === 'present'; }).length;
        var c = el('div', { class: 'card' }, [
          el('h3', { text: s.first_name + ' ' + s.last_name + ' · ' + (klass ? klass.name : '') }),
          el('div', { class: 'grid cols-3' }, [
            stat(U.money(pos.arrears, App.ctx.school.currency), 'Fees balance'),
            stat(present, 'Days present'),
            stat(s.student_id, 'Student ID')
          ]),
          el('div', { class: 'btn-row', style: 'margin-top:.5rem' }, [
            el('button', { class: 'btn sm ghost', text: 'View report / attendance', onclick: function () { location.hash = '#/students'; } })
          ])
        ]);
        container.appendChild(c);
      });
      if (!mine.length) container.appendChild(el('div', { class: 'empty', text: 'No ward linked to this account. Please contact the school office.' }));
      announcements(container);
    });
  }

  function stat(n, l) { return el('div', { class: 'stat accent' }, [el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l })]); }
  global.Views = global.Views || {};
  global.Views.dashboard = { title: 'Dashboard', render: render };
})(window);
