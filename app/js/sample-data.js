/* ============================================================
 * sample-data.js — a few pretend records in every area, so a new school can try
 * every screen, and can remove or restore each group separately.
 *
 * Every sample record carries is_demo:true. Removing a group deletes ONLY those
 * records (plus anything recorded against sample pupils / staff / stock items,
 * which would otherwise be left pointing at nothing). Records the school typed in
 * itself are never touched. Sample data never includes login accounts, so it
 * cannot open a way in for a stranger.
 * ============================================================ */
(function (global) {
  'use strict';
  var DB = global.DB, U = global.U;
  var PER_CLASS = 2;          // sample pupils kept per class (the full demo roster has 7)
  var DAYS = 3;               // days of attendance to fill in

  // The groups, in the order they are created. `needs` = groups that must be present first.
  var PACKS = [
    { id: 'pupils',     label: 'Pupils & parents',            colls: ['students', 'parents'], needs: [],
      desc: 'About 28 pupils across the classes, with their parents.' },
    { id: 'staff',      label: 'Staff',                       colls: ['staff'], needs: [],
      desc: 'A few teachers and support staff with salaries (so you can try Payroll).' },
    { id: 'fees',       label: 'Fee bills & payments',        colls: ['invoices', 'payments'], needs: ['pupils'],
      desc: 'This term’s bills for the sample pupils; some paid in full, some part-paid, some unpaid.' },
    { id: 'attendance', label: 'Pupil attendance',            colls: ['attendance'], needs: ['pupils'],
      desc: 'The last ' + DAYS + ' days, with a few absences and late arrivals.' },
    { id: 'scores',     label: 'Exam scores',                 colls: ['scores'], needs: ['pupils'],
      desc: 'Class and exam scores in two subjects, so report cards have marks.' },
    { id: 'remarks',    label: 'Report remarks & conduct notes', colls: ['studentRemarks', 'conduct'], needs: ['pupils'],
      desc: 'Teacher remarks and a few conduct notes.' },
    { id: 'stock',      label: 'Stock & inventory',           colls: ['inventoryItems', 'inventoryStock', 'inventoryTransactions'], needs: [],
      desc: 'Three items (uniform, textbook, laptop) with stock levels and a restock and a sale.' },
    { id: 'accounts',   label: 'Accounting (expenses & other income)', colls: ['expenses', 'otherIncome'], needs: [],
      desc: 'A few expenses and other-income entries.' },
    { id: 'staffatt',   label: 'Staff attendance',            colls: ['staffAttendance'], needs: ['staff'],
      desc: 'The last ' + DAYS + ' days for the sample staff.' },
    { id: 'notices',    label: 'Announcements & messages',    colls: ['announcements', 'messages'], needs: [],
      desc: 'Two announcements and two sample messages.' }
  ];
  function packById(id) { return PACKS.filter(function (p) { return p.id === id; })[0]; }

  var seqNo = 0;
  function newId(prefix) { return 'smp-' + prefix + '-' + Date.now().toString(36) + (++seqNo); }
  function codeNum(v) { var n = parseInt(String(v || '').replace(/\D/g, ''), 10); return isNaN(n) ? 0 : n; }
  function daysAgo(n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function mark(rec) { rec.is_demo = true; return rec; }
  function appendAll(coll, recs) {
    if (!recs.length) return Promise.resolve();
    return DB.all(coll).then(function (arr) { return DB.replaceAll(coll, arr.concat(recs)); });
  }
  function demoOnly(arr) { return arr.filter(function (x) { return x.is_demo; }); }
  function term() { return (global.App && global.App.ctx && global.App.ctx.academic && global.App.ctx.academic.current_term) || 1; }

  /* ---------------- building each group ---------------- */
  // Each builder returns a Promise; it writes its records and any counters it must advance.
  var BUILD = {
    pupils: function () {
      var G = global.SMS_DEMO_GENERATORS;
      return DB.all('students').then(function (cur) {
        var maxStu = cur.reduce(function (m, s) { return Math.max(m, codeNum(s.student_id)); }, 0);
        var roster = G.buildRoster(maxStu), perClass = {}, kept = [], codes = {};
        roster.students.forEach(function (s) {
          perClass[s.class_id] = perClass[s.class_id] || 0;
          if (perClass[s.class_id] < PER_CLASS) { perClass[s.class_id]++; kept.push(s); codes[s.student_id] = 1; }
        });
        var parents = roster.parents.map(function (p) {
          return Object.assign({}, p, { student_ids: p.student_ids.filter(function (c) { return codes[c]; }) });
        }).filter(function (p) { return p.student_ids.length; });
        var parentIds = {}; parents.forEach(function (p) { parentIds[p.id] = 1; });
        kept.forEach(function (s) { if (!parentIds[s.parent_id]) s.parent_id = ''; });
        var top = kept.reduce(function (m, s) { return Math.max(m, codeNum(s.student_id)); }, maxStu);
        return Promise.all([appendAll('students', kept), appendAll('parents', parents)])
          .then(function () { return DB.bumpSeq('student', top); });   // the next REAL pupil gets a fresh number
      });
    },
    staff: function () {
      return DB.all('staff').then(function (cur) {
        var have = {}; cur.forEach(function (s) { have[s.id] = 1; });
        var extra = global.SMS_DEMO_GENERATORS.buildStaffExtra().slice(0, 6).filter(function (s) { return !have[s.id]; });
        var top = extra.reduce(function (m, s) { return Math.max(m, codeNum(s.staff_id)); }, 0);
        return appendAll('staff', extra).then(function () { return DB.bumpSeq('staff', top); });
      });
    },
    stock: function () {
      var inv = global.SMS_DEMO_GENERATORS.buildInventory(), today = daysAgo(0);
      // History that adds up to the stock levels shown: 45 bought − 5 sold = 40, and so on.
      function txn(n, type, item, qty, amount) {
        return mark({ id: newId('tx'), txn_id: 'TXN-S' + n, type: type, item_id: item.id, item_name: item.name, qty: qty,
          recipient_id: '', payment_status: 'paid', amount: amount || 0, branch_route: '', date: daysAgo(5 - n), by: 'Sample', archived: false });
      }
      var it = inv.items;
      var txns = [txn(1, 'restock', it[0], 45), txn(2, 'sale', it[0], 5, 5 * it[0].selling_price),
                  txn(3, 'restock', it[1], 65), txn(4, 'sale', it[1], 5, 5 * it[1].selling_price), txn(5, 'restock', it[2], 12)];
      return Promise.all([appendAll('inventoryItems', inv.items), appendAll('inventoryStock', inv.stock), appendAll('inventoryTransactions', txns)]);
    },
    fees: function () {
      return Promise.all([DB.all('students'), DB.all('feeTypes')]).then(function (r) {
        var pupils = demoOnly(r[0]), t = term(), types = r[1].filter(function (f) { return f.required; });
        if (!types.length) types = r[1];
        types = types.slice(0, 3);
        var invoices = [], payments = [], rct = 0;
        pupils.forEach(function (s, i) {
          var billed = 0;
          types.forEach(function (f) {
            billed += Number(f.amount) || 0;
            invoices.push(mark({ id: newId('inv'), student_id: s.student_id, class_id: s.class_id, term: t, fee_type_id: f.id, fee_name: f.name, amount: f.amount, created_on: daysAgo(10) }));
          });
          var pay = i % 4 === 3 ? 0 : (i % 4 === 1 ? Math.round(billed / 2) : billed);   // unpaid / half / full
          if (pay > 0) {
            rct++;
            payments.push(mark({ id: newId('pay'), student_id: s.student_id, term: t, amount: pay, method: i % 2 ? 'mobile_money' : 'cash',
              reference: 'RCT-S' + rct, receipt_no: 'RCT-S' + rct, created_on: daysAgo(i % 5), by: 'Sample' }));
          }
        });
        return Promise.all([appendAll('invoices', invoices), appendAll('payments', payments)]);
      });
    },
    attendance: function () {
      return DB.all('students').then(function (all) {
        var recs = [];
        demoOnly(all).forEach(function (s, i) {
          for (var d = 0; d < DAYS; d++) {
            var status = (i + d) % 9 === 0 ? 'absent' : ((i * 3 + d) % 7 === 0 ? 'late' : 'present');
            recs.push(mark({ id: newId('att'), student_id: s.student_id, class_id: s.class_id, date: daysAgo(d), status: status }));
          }
        });
        return appendAll('attendance', recs);
      });
    },
    scores: function () {
      return Promise.all([DB.all('students'), DB.all('classes')]).then(function (r) {
        var classes = {}; r[1].forEach(function (c) { classes[c.id] = c; });
        var recs = [], t = term();
        demoOnly(r[0]).forEach(function (s, i) {
          var subjects = ((classes[s.class_id] || {}).subjects || []).slice(0, 2);
          subjects.forEach(function (subject, j) {
            recs.push(mark({ id: newId('sc'), student_id: s.student_id, class_id: s.class_id, subject: subject, term: t,
              class_score: 28 + ((i * 7 + j * 3) % 20), exam_score: 25 + ((i * 5 + j * 11) % 24) }));
          });
        });
        return appendAll('scores', recs);
      });
    },
    remarks: function () {
      return DB.all('students').then(function (all) {
        var pupils = demoOnly(all), t = term(), remarks = [], notes = [];
        var texts = ['A hard-working pupil. Keep it up.', 'Participates well in class.', 'Can improve with more reading at home.'];
        pupils.slice(0, 6).forEach(function (s, i) {
          remarks.push(mark({ id: newId('rm'), student_id: s.student_id, class_id: s.class_id, term: t,
            conduct: 'Good', attitude: 'Positive', interest: 'Reading', overall: 'Very good', teacher_remark: texts[i % texts.length] }));
        });
        pupils.slice(0, 4).forEach(function (s, i) {
          notes.push(mark({ id: newId('cn'), student_id: s.student_id, class_id: s.class_id, date: daysAgo(i + 1),
            note: i % 2 ? 'Helped tidy the classroom without being asked.' : 'Arrived late twice this week.', by: 'Sample' }));
        });
        return Promise.all([appendAll('studentRemarks', remarks), appendAll('conduct', notes)]);
      });
    },
    accounts: function () {
      return Promise.all([DB.all('expenseCategories'), DB.all('incomeCategories')]).then(function (r) {
        function cat(list, i, fallback) { return list.length ? list[i % list.length].name : fallback; }
        var exp = [[480, 'Electricity bill', 1, 'bank'], [150, 'Chalk, markers and exercise books', 3, 'cash'], [220, 'Generator fuel', 5, 'cash'], [90, 'Printing of exam papers', 7, 'mobile_money']]
          .map(function (e, i) { return mark({ id: newId('ex'), date: daysAgo(i * 2 + 1), category: cat(r[0], e[2], 'Miscellaneous'), description: e[1], amount: e[0], method: e[3], by: 'Sample', source: 'manual' }); });
        var inc = [[300, 'Donation from an old pupil', 0, 'cash'], [180, 'Uniform sales this week', 1, 'mobile_money'], [120, 'Canteen sales', 2, 'cash']]
          .map(function (e, i) { return mark({ id: newId('in'), date: daysAgo(i + 1), category: cat(r[1], e[2], 'Miscellaneous'), description: e[1], amount: e[0], method: e[3], by: 'Sample', source: 'manual' }); });
        return Promise.all([appendAll('expenses', exp), appendAll('otherIncome', inc)]);
      });
    },
    staffatt: function () {
      return DB.all('staff').then(function (all) {
        var recs = [];
        demoOnly(all).forEach(function (s, i) {
          for (var d = 0; d < DAYS; d++) {
            recs.push(mark({ id: newId('sa'), staff_id: s.staff_id, date: daysAgo(d), status: (i + d) % 8 === 0 ? 'absent' : ((i + 2 * d) % 6 === 0 ? 'late' : 'present') }));
          }
        });
        return appendAll('staffAttendance', recs);
      });
    },
    notices: function () {
      var now = new Date().toISOString();
      var ann = [['Welcome to the new term', 'Classes start at 7:30 am. Please make sure every pupil is in full uniform.'], ['PTA meeting', 'The PTA meeting is on Friday at 3 pm in the school hall. All parents are invited.']]
        .map(function (a, i) { return mark({ id: newId('an'), title: a[0], body: a[1], at: now, by: 'Sample' }); });
      var msg = [['+233 24 000 1001', 'Reminder: school fees for this term are due this month.'], ['+233 24 000 1002', 'Your child was absent today. Please let the class teacher know.']]
        .map(function (m) { return mark({ id: newId('ms'), to: m[0], body: m[1], channel: 'sms', status: 'sent (test)', at: now, by: 'Sample' }); });
      return Promise.all([appendAll('announcements', ann), appendAll('messages', msg)]);
    }
  };

  /* ---------------- reading what is there ---------------- */
  function allColls() {
    var seen = {}, out = [];
    PACKS.forEach(function (p) { p.colls.forEach(function (c) { if (!seen[c]) { seen[c] = 1; out.push(c); } }); });
    return out;
  }
  // { byPack: { id: sampleRecordCount }, parts: { collection: sampleRecordCount }, total, realPupils }
  function counts() {
    var colls = allColls();
    return Promise.all(colls.map(function (c) { return DB.all(c); })).then(function (all) {
      var parts = {}, byPack = {}, total = 0, realPupils = 0;
      colls.forEach(function (c, i) {
        parts[c] = demoOnly(all[i]).length;
        if (c === 'students') realPupils = all[i].length - parts[c];
      });
      PACKS.forEach(function (p) {
        byPack[p.id] = p.colls.reduce(function (n, c) { return n + parts[c]; }, 0);
        total += byPack[p.id];
      });
      return { byPack: byPack, parts: parts, total: total, realPupils: realPupils };
    });
  }

  /* ---------------- adding ---------------- */
  // Add the chosen groups (default: all). Groups already present, or whose pupils / staff
  // are missing, are skipped and reported back. Resolves { added: [ids], skipped: [{id, reason}] }.
  function load(ids) {
    if (!global.SMS_DEMO_GENERATORS) return Promise.reject(new Error('Sample data is not available in this version.'));
    var want = ids || PACKS.map(function (p) { return p.id; });
    return counts().then(function (c) {
      var present = {}; PACKS.forEach(function (p) { present[p.id] = c.byPack[p.id] > 0; });
      var added = [], skipped = [], chain = Promise.resolve();
      PACKS.forEach(function (p) {
        if (want.indexOf(p.id) < 0) return;
        chain = chain.then(function () {
          if (present[p.id]) { skipped.push({ id: p.id, reason: 'already added' }); return; }
          var missing = p.needs.filter(function (n) { return !present[n]; });
          if (missing.length) { skipped.push({ id: p.id, reason: 'needs the sample ' + packById(missing[0]).label.toLowerCase() }); return; }
          return BUILD[p.id]().then(function () { present[p.id] = true; added.push(p.id); });
        });
      });
      return chain.then(function () { return { added: added, skipped: skipped }; });
    });
  }

  /* ---------------- removing ---------------- */
  // Remove the chosen groups (default: all). Removing sample pupils / staff / stock items
  // also removes anything recorded against them (attendance, scores, fees, movements …).
  function remove(ids) {
    var want = ids || PACKS.map(function (p) { return p.id; });
    var colls = allColls().concat(['scores', 'attendance', 'studentRemarks', 'conduct', 'invoices', 'payments', 'staffAttendance', 'inventoryTransactions', 'stockMovements', 'inventoryAudit'])
      .filter(function (c, i, a) { return a.indexOf(c) === i; });
    return Promise.all(colls.map(function (c) { return DB.all(c); })).then(function (all) {
      var data = {}; colls.forEach(function (c, i) { data[c] = all[i]; });
      var rules = {};   // collection -> [function(record) -> true to delete]
      function rule(c, fn) { (rules[c] = rules[c] || []).push(fn); }
      function pointsAt(field, set) { return function (r) { return r[field] && set[r[field]]; }; }
      function keys(coll, fields) {
        var set = {};
        demoOnly(data[coll]).forEach(function (r) { fields.forEach(function (f) { if (r[f]) set[r[f]] = 1; }); });
        return set;
      }
      want.forEach(function (id) {
        var p = packById(id); if (!p) return;
        p.colls.forEach(function (c) { rule(c, function (r) { return r.is_demo; }); });
      });
      if (want.indexOf('pupils') >= 0) {
        var pupils = keys('students', ['id', 'student_id']);
        ['scores', 'attendance', 'studentRemarks', 'conduct', 'invoices', 'payments'].forEach(function (c) { rule(c, pointsAt('student_id', pupils)); });
      }
      if (want.indexOf('staff') >= 0) rule('staffAttendance', pointsAt('staff_id', keys('staff', ['id', 'staff_id'])));
      if (want.indexOf('stock') >= 0) {
        var items = keys('inventoryItems', ['id', 'sku']);
        ['inventoryTransactions', 'stockMovements', 'inventoryAudit'].forEach(function (c) { rule(c, pointsAt('item_id', items)); });
      }
      var ops = Object.keys(rules).map(function (c) {
        var keep = data[c].filter(function (r) { return !rules[c].some(function (fn) { return fn(r); }); });
        return keep.length === data[c].length ? null : DB.replaceAll(c, keep);
      }).filter(Boolean);
      return Promise.all(ops);
    });
  }

  global.SampleData = { PACKS: PACKS, packById: packById, counts: counts, load: load, remove: remove };
})(window);
