/* ============================================================
 * assessment.js — score entry, grading, positions,
 * Creche checklist entry, report cards (A & B), PDF output,
 * bulk score upload.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB, App = global.App, G = global.Grading,
    Bulk = global.Bulk, RC = global.ReportCard, FL = global.FinanceLib;
  var el = U.el;

  /* ---- shared results engine (also used by reports) ---- */
  function computeResults(klass, term) {
    return Promise.all([DB.all('students'), DB.all('scores'), DB.all('gradeBands')]).then(function (r) {
      var students = r[0].filter(function (s) { return s.class_id === klass.id && s.status === 'active'; });
      var scores = r[1].filter(function (s) { return s.class_id === klass.id && s.term === term; });
      var bands = r[2].sort(function (a, b) { return b.min - a.min; });
      var w = App.ctx.weighting || { class_pct: 50, exam_pct: 50 };
      var subjects = klass.subjects;
      var map = {}; // code -> subject -> computed
      students.forEach(function (s) { map[s.student_id] = {}; });
      scores.forEach(function (sc) {
        if (!map[sc.student_id]) map[sc.student_id] = {};
        var total = G.computeTotal(sc.class_score, sc.exam_score, w);
        var band = G.gradeFor(total, bands);
        map[sc.student_id][sc.subject] = {
          class_score: sc.class_score, exam_score: sc.exam_score,
          total: total, grade: band.grade, remark: band.remark
        };
      });
      // subject positions
      var subjPos = {};
      subjects.forEach(function (subj) {
        var items = students.filter(function (s) { return map[s.student_id][subj]; })
          .map(function (s) { return { key: s.student_id, total: map[s.student_id][subj].total }; });
        subjPos[subj] = G.positions(items);
      });
      // overall (sum of totals across subjects entered)
      var overallItems = students.map(function (s) {
        var subs = Object.keys(map[s.student_id]);
        var sum = subs.reduce(function (a, k) { return a + map[s.student_id][k].total; }, 0);
        return { key: s.student_id, total: sum, count: subs.length };
      });
      var overallPos = G.positions(overallItems.filter(function (i) { return i.count > 0; }));
      return { students: students, subjects: subjects, map: map, subjPos: subjPos, overallPos: overallPos,
        overallItems: overallItems, bands: bands };
    });
  }
  global.Academics = { computeResults: computeResults };

  function render(container) {
    U.clear(container);
    container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'Assessment & Examinations' })]));
    container.appendChild(el('div', { class: 'note', text: 'Term: ' + App.termName() + ' · ' + App.ctx.academic.year + '. Class score is entered out of ' + App.ctx.weighting.class_pct + ' and exam score out of ' + App.ctx.weighting.exam_pct + ' (Settings → Grading) — total is the direct sum of the two, out of 100.' }));
    var bar = el('div', { class: 'tabs' });
    var panel = el('div'); var active = 'Score Entry';
    ['Score Entry', 'Report Cards'].forEach(function (t) { var b = el('button', { text: t, onclick: function () { active = t; draw(); } }); b._t = t; bar.appendChild(b); });
    container.appendChild(bar); container.appendChild(panel);
    function draw() {
      U.$all('button', bar).forEach(function (b) { b.classList.toggle('active', b._t === active); });
      U.clear(panel);
      if (active === 'Score Entry') tabScores(panel); else tabReports(panel);
    }
    draw();
  }

  /* ---------------- Score Entry ---------------- */
  function tabScores(panel) {
    var classes = teacherClasses();
    var term = App.ctx.academic.current_term;
    var tools = el('div', { class: 'toolbar' });
    var clsSel = el('select');
    classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
    var subjSel = el('select');
    tools.appendChild(el('span', { class: 'muted', text: 'Class:' })); tools.appendChild(clsSel);
    tools.appendChild(el('span', { class: 'muted', text: 'Subject:' })); tools.appendChild(subjSel);
    panel.appendChild(tools);
    var area = el('div'); panel.appendChild(area);

    function fillSubjects() {
      var c = classes.filter(function (x) { return x.id === clsSel.value; })[0];
      U.clear(subjSel);
      if (c && c.template === 'A') {
        subjSel.appendChild(el('option', { value: '__checklist', text: 'Competency checklist' }));
      }
      var subjectList = c ? c.subjects : [];
      if (c && App.user.role === 'Teacher') {
        var restricted = App.teacherSubjectsFor(c.id);
        if (restricted) subjectList = subjectList.filter(function (s) { return restricted.indexOf(s) !== -1; });
      }
      subjectList.forEach(function (s) { subjSel.appendChild(el('option', { value: s, text: s })); });
      loadEntry();
    }
    function loadEntry() {
      var c = classes.filter(function (x) { return x.id === clsSel.value; })[0];
      U.clear(area);
      if (!c) { area.appendChild(el('div', { class: 'empty', text: 'No class.' })); return; }
      if (subjSel.value === '__checklist') return checklistEntry(area, c, term);
      scoreEntry(area, c, subjSel.value, term);
    }
    clsSel.addEventListener('change', fillSubjects);
    subjSel.addEventListener('change', loadEntry);
    if (classes.length) { clsSel.value = classes[0].id; fillSubjects(); }
    else area.appendChild(el('div', { class: 'empty', text: 'You have no assigned classes.' }));
  }

  function scoreEntry(area, klass, subject, term) {
    Promise.all([DB.all('students'), DB.all('scores')]).then(function (r) {
      var students = r[0].filter(function (s) { return s.class_id === klass.id && s.status === 'active'; });
      var scores = r[1];
      var ro = App.readOnly;
      var card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:.5rem' }, [
        el('h3', { text: klass.name + ' · ' + subject }),
        el('div', { class: 'btn-row' }, ro ? [] : [
          el('button', { class: 'btn ghost sm', text: '⤓ Template', onclick: function () { scoreTemplate(klass, subject, students, scores, term); } }),
          el('button', { class: 'btn gold sm', text: '⤒ Upload', onclick: function () { scoreUpload(klass, subject, students, term, function () { scoreEntry(U.clear(area), klass, subject, term); }); } })
        ])
      ]));
      if (!students.length) { card.appendChild(el('div', { class: 'empty', text: 'No pupils in this class.' })); area.appendChild(card); return; }
      var classMax = App.ctx.weighting.class_pct, examMax = App.ctx.weighting.exam_pct;
      var t = el('table', { class: 'data' });
      t.appendChild(el('thead', {}, [el('tr', {}, ['Pupil', 'Class (max ' + classMax + ')', 'Exam (max ' + examMax + ')', 'Total', 'Grade'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      var inputs = {};
      students.forEach(function (s) {
        var existing = scores.filter(function (x) { return x.student_id === s.student_id && x.subject === subject && x.term === term && x.class_id === klass.id; })[0] || {};
        var ci = el('input', { type: 'number', min: 0, max: classMax, value: existing.class_score != null ? existing.class_score : '', style: 'width:70px' });
        var ei = el('input', { type: 'number', min: 0, max: examMax, value: existing.exam_score != null ? existing.exam_score : '', style: 'width:70px' });
        if (ro) { ci.disabled = true; ei.disabled = true; }
        var totalCell = el('td', { class: 'right' });
        var gradeCell = el('td');
        function recompute() {
          var tot = G.computeTotal(ci.value || 0, ei.value || 0);
          var band = G.gradeFor(tot, App.ctx.gradeBands.slice().sort(function (a, b) { return b.min - a.min; }));
          totalCell.textContent = (ci.value === '' && ei.value === '') ? '' : tot;
          gradeCell.textContent = (ci.value === '' && ei.value === '') ? '' : (band.grade + ' · ' + band.remark);
        }
        ci.addEventListener('input', recompute); ei.addEventListener('input', recompute); recompute();
        inputs[s.student_id] = { ci: ci, ei: ei, existingId: existing.id };
        tb.appendChild(el('tr', {}, [el('td', { text: s.first_name + ' ' + s.last_name }), el('td', {}, [ci]), el('td', {}, [ei]), totalCell, gradeCell]));
      });
      t.appendChild(tb);
      card.appendChild(el('div', { class: 'table-wrap' }, [t]));
      if (!ro) card.appendChild(el('button', { class: 'btn gold', style: 'margin-top:.7rem', text: 'Save scores', onclick: function () {
        var ops = students.map(function (s) {
          var io = inputs[s.student_id];
          var cs = io.ci.value === '' ? null : Number(io.ci.value);
          var es = io.ei.value === '' ? null : Number(io.ei.value);
          if (cs == null && es == null) { return io.existingId ? DB.remove('scores', io.existingId) : null; }
          var rec = { student_id: s.student_id, class_id: klass.id, subject: subject, term: term, class_score: cs, exam_score: es };
          return io.existingId ? DB.update('scores', io.existingId, rec) : DB.insert('scores', rec);
        }).filter(Boolean);
        Promise.all(ops).then(function () { U.toast('Scores saved.'); scoreEntry(U.clear(area), klass, subject, term); });
      } }));
      area.appendChild(card);
    });
  }

  function checklistEntry(area, klass, term) {
    var tmpl = global.ReportCard.normalizeTemplateA(App.ctx.reportTemplates.filter(function (t) { return t.id === 'A'; })[0]);
    var fmt = tmpl.checklistFormats[tmpl.checklistFormat] || tmpl.checklistFormats.checklist;
    Promise.all([DB.all('students'), DB.all('checklists')]).then(function (r) {
      var students = r[0].filter(function (s) { return s.class_id === klass.id && s.status === 'active'; });
      var lists = r[1] || [];
      var card = el('div', { class: 'card' });
      card.appendChild(el('h3', { text: klass.name + ' · ' + (fmt.label || 'Competency checklist') }));
      if (!students.length) { card.appendChild(el('div', { class: 'empty', text: 'No pupils.' })); area.appendChild(card); return; }
      var pupilSel = el('select');
      students.forEach(function (s) { pupilSel.appendChild(el('option', { value: s.student_id, text: s.first_name + ' ' + s.last_name })); });
      card.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Pupil:' }), pupilSel]));
      var box = el('div'); card.appendChild(box);
      function drawPupil() {
        U.clear(box);
        var code = pupilSel.value;
        var existing = lists.filter(function (l) { return l.student_id === code && l.term === term; })[0];
        var marks = existing ? Object.assign({}, existing.marks) : {};
        (fmt.domains || []).forEach(function (d) {
          box.appendChild(el('h4', { text: d.name }));
          d.indicators.forEach(function (ind) {
            var grp = el('div', { class: 'flex', style: 'gap:.4rem;flex-wrap:wrap;margin-bottom:.3rem' }, [el('span', { style: 'flex:1;min-width:160px', text: ind })]);
            fmt.marks.forEach(function (k) {
              var b = el('button', { class: 'btn sm ' + (marks[ind] === k ? 'gold' : 'ghost'), text: k, onclick: function () { marks[ind] = k; drawMarks(); } });
              b._k = k; b._ind = ind; grp.appendChild(b);
            });
            box.appendChild(grp);
          });
        });
        function drawMarks() { U.$all('button', box).forEach(function (b) { if (b._ind) b.className = 'btn sm ' + (marks[b._ind] === b._k ? 'gold' : 'ghost'); }); }
        if (!App.readOnly) box.appendChild(el('button', { class: 'btn gold', style: 'margin-top:.5rem', text: 'Save checklist', onclick: function () {
          var rec = { student_id: code, class_id: klass.id, term: term, marks: marks };
          var go = existing ? DB.update('checklists', existing.id, rec) : DB.insert('checklists', rec);
          go.then(function () { U.toast('Checklist saved.'); DB.all('checklists').then(function (x) { lists = x; }); });
        } }));
      }
      pupilSel.addEventListener('change', drawPupil); drawPupil();
      area.appendChild(card);
    });
  }

  /* ---------------- Report Cards ---------------- */
  function tabReports(panel) {
    var classes = teacherClasses();
    var term = App.ctx.academic.current_term;
    var tools = el('div', { class: 'toolbar' });
    var clsSel = el('select');
    classes.forEach(function (c) { clsSel.appendChild(el('option', { value: c.id, text: c.name })); });
    tools.appendChild(el('span', { class: 'muted', text: 'Class:' })); tools.appendChild(clsSel);
    var genBtn = el('button', { class: 'btn', text: 'Build class reports' });
    var area = el('div');
    tools.appendChild(genBtn);
    panel.appendChild(tools); panel.appendChild(area);
    genBtn.addEventListener('click', function () { buildReports(area, clsSel.value, term); });
    clsSel.addEventListener('change', function () { buildReports(area, clsSel.value, term); });
    if (classes.length) { clsSel.value = classes[0].id; buildReports(area, classes[0].id, term); }
  }

  function buildReports(area, classId, term) {
    U.clear(area);
    var klass = App.ctx.classes.filter(function (c) { return c.id === classId; })[0];
    if (!klass) return;
    var tmpl = App.ctx.reportTemplates.filter(function (t) { return t.id === klass.template; })[0] || App.ctx.reportTemplates[0];
    Promise.all([
      computeResults(klass, term), DB.all('students'), DB.all('attendance'),
      DB.all('invoices'), DB.all('payments'), DB.all('checklists'), DB.all('studentRemarks')
    ]).then(function (r) {
      var res = r[0], allStudents = r[1], attendance = r[2], invoices = r[3], payments = r[4], checklists = r[5] || [], studentRemarks = r[6] || [];
      function remarkFor(code) { return studentRemarks.filter(function (x) { return x.student_id === code && x.term === term; })[0] || {}; }
      var roster = res.students;
      if (App.readOnly && App.user.linked_student_ids) roster = roster.filter(function (s) { return App.user.linked_student_ids.indexOf(s.student_id) !== -1; });
      if (!roster.length) { area.appendChild(el('div', { class: 'empty', text: 'No pupils to report.' })); return; }

      // selection controls
      var sel = {}; roster.forEach(function (s) { sel[s.student_id] = true; });
      var ctrl = el('div', { class: 'card' });
      ctrl.appendChild(el('h3', { text: klass.name + ' — ' + tmpl.name }));
      var pickWrap = el('div', { style: 'columns:2;max-width:520px' });
      roster.forEach(function (s) {
        var cb = el('input', { type: 'checkbox' }); cb.checked = true; cb.addEventListener('change', function () { sel[s.student_id] = cb.checked; });
        var rowChildren = [cb, document.createTextNode(' ' + s.first_name + ' ' + s.last_name)];
        var lbl = el('label', { class: 'check-label', style: 'display:inline-flex' }, rowChildren);
        var line = el('div', { style: 'display:flex;align-items:center;gap:.5rem;break-inside:avoid' }, [lbl]);
        if (tmpl.kind === 'B' && tmpl.blocks.conduct && !App.readOnly) {
          line.appendChild(el('button', { class: 'btn sm ghost', text: 'Remarks', onclick: function () { editStudentRemarks(s, tmpl, term, studentRemarks, function () { DB.all('studentRemarks').then(function (x) { studentRemarks = x; renderCards(false); }); }); } }));
        }
        pickWrap.appendChild(line);
      });
      ctrl.appendChild(pickWrap);
      ctrl.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.6rem' }, [
        el('button', { class: 'btn', text: 'Preview selected', onclick: function () { renderCards(false); } }),
        el('button', { class: 'btn gold', text: '🖨 Print / Save PDF', onclick: function () { renderCards(true); } })
      ]));
      area.appendChild(ctrl);
      var preview = el('div', { id: 'print-area' });
      area.appendChild(preview);

      function dataFor(s) {
        var subjRows = res.subjects.map(function (subj) {
          var c = res.map[s.student_id][subj] || {};
          return { subject: subj, class_score: c.class_score, exam_score: c.exam_score, total: c.total,
            grade: c.grade, remark: c.remark, subjectPos: (res.subjPos[subj] || {})[s.student_id] };
        });
        var att = attSummary(attendance, s.student_id, klass.id);
        var fees = FL.studentFeePosition(s.student_id, klass, invoices, payments, App.ctx.feeTypes);
        var cl = checklists.filter(function (l) { return l.student_id === s.student_id && l.term === term; })[0];
        var promotedTo = null;
        if (App.ctx.academic.current_term === App.ctx.academic.promotional_term) {
          var idx = App.ctx.classes.sort(function (a, b) { return a.sort - b.sort; }).findIndex(function (c) { return c.id === klass.id; });
          var nx = App.ctx.classes[idx + 1];
          promotedTo = s.promoted_to || (nx ? nx.name : 'Completed (BECE / Alumni)');
        }
        var rm = remarkFor(s.student_id);
        return {
          ctx: App.ctx, student: s, klass: klass, template: tmpl,
          scores: subjRows, attendance: att, roll: roster.length,
          position: res.overallPos[s.student_id],
          fees: { arrears: fees.arrears, next: fees.next, payable: fees.payable },
          checklist: cl ? cl.marks : {},
          remarks: { conduct: rm.conduct, attitude: rm.attitude, interest: rm.interest, overall: rm.overall, teacher_remark: rm.teacher_remark },
          promotedTo: promotedTo
        };
      }
      function renderCards(doPrint) {
        U.clear(preview);
        var cards = roster.filter(function (s) { return sel[s.student_id]; }).map(function (s) { return RC.build(dataFor(s)); });
        if (!cards.length) return U.toast('Select at least one pupil.', 'warn');
        cards.forEach(function (c) { preview.appendChild(c); });
        if (doPrint) RC.printCards(cards.map(function (c) { return c.cloneNode(true); }));
      }
      renderCards(false);
    });
  }

  // Fallback suggestions if none configured in Settings → Report Templates → Template B.
  var DEFAULT_TEACHER_REMARKS = [
    'An excellent result. Keep it up!',
    'A very good performance this term.',
    'A good result; keep working hard.',
    'A satisfactory result; more effort will bring improvement.',
    'Fair; needs to be more focused and consistent next term.',
    'Can do much better with more effort and concentration.'
  ];
  function editStudentRemarks(s, tmpl, term, studentRemarks, done) {
    var existing = studentRemarks.filter(function (x) { return x.student_id === s.student_id && x.term === term; })[0] || {};
    var rf = tmpl.remarkFields || {};
    var fields = [];
    ['conduct', 'attitude', 'interest', 'overall'].forEach(function (k) {
      var f = rf[k]; if (!f || f.show === false) return;
      fields.push({ name: k, label: f.label, type: 'select', options: [''].concat(f.options || []), value: existing[k] || '' });
    });
    var form = U.form(fields, {});

    // ---- Class Teacher's Remark: pick a suggestion OR type your own ----
    var tr = (tmpl.freeRemarks && tmpl.freeRemarks.teacher) || {};
    var trLabel = tr.label || "Class Teacher's Remark";
    var suggestions = (Array.isArray(tr.suggestions) && tr.suggestions.length) ? tr.suggestions : DEFAULT_TEACHER_REMARKS;
    var ta = el('textarea', { rows: 2, style: 'width:100%' }); ta.value = existing.teacher_remark || '';
    var sugSel = el('select');
    sugSel.appendChild(el('option', { value: '', text: '— pick a suggested remark —' }));
    suggestions.forEach(function (r) { sugSel.appendChild(el('option', { value: r, text: r })); });
    sugSel.addEventListener('change', function () { if (sugSel.value) { ta.value = sugSel.value; sugSel.value = ''; } });
    var trBlock = el('div', { class: 'field' }, [
      el('label', { text: trLabel }),
      sugSel,
      el('div', { class: 'help', text: 'Choose a suggestion to fill the box, then edit it — or just type your own.' }),
      ta
    ]);
    var body = el('div', {}, [form, trBlock]);

    U.modal({ title: 'Report remarks · ' + s.first_name + ' ' + s.last_name, wide: true, body: body, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = form.readValues();
        var rec = { student_id: s.student_id, class_id: s.class_id, term: term,
          conduct: v.conduct, attitude: v.attitude, interest: v.interest, overall: v.overall, teacher_remark: ta.value };
        var go = existing.id ? DB.update('studentRemarks', existing.id, rec) : DB.insert('studentRemarks', rec);
        go.then(function () { x(); U.toast('Remarks saved.'); done(); });
      } }
    ] });
  }

  function attSummary(attendance, code, classId) {
    var recs = attendance.filter(function (a) { return a.class_id === classId; });
    var days = {}; recs.forEach(function (a) { days[a.date] = true; });
    var present = attendance.filter(function (a) { return a.student_id === code && a.status === 'present'; }).length;
    return { present: present, total: Object.keys(days).length };
  }

  /* ---------------- bulk scores ---------------- */
  function scoreTemplate(klass, subject, students, scores, term) {
    var rows = [['student_id', 'name', 'class_score', 'exam_score']];
    students.forEach(function (s) {
      var ex = scores.filter(function (x) { return x.student_id === s.student_id && x.subject === subject && x.term === term; })[0] || {};
      rows.push([s.student_id, s.first_name + ' ' + s.last_name, ex.class_score != null ? ex.class_score : '', ex.exam_score != null ? ex.exam_score : '']);
    });
    Bulk.download('scores-' + klass.name.replace(/\s+/g, '') + '-' + subject.replace(/\s+/g, '') + '.csv', rows);
    U.toast('Template downloaded. class_score max ' + App.ctx.weighting.class_pct + ', exam_score max ' + App.ctx.weighting.exam_pct + '.');
  }
  function scoreUpload(klass, subject, students, term, done) {
    var byCode = {}; students.forEach(function (s) { byCode[s.student_id] = s; });
    var classMax = App.ctx.weighting.class_pct, examMax = App.ctx.weighting.exam_pct;
    Bulk.pickFile().then(function (file) {
      var res = Bulk.processUpload(file.rows, ['student_id', 'class_score', 'exam_score'], function (row) {
        var errs = [];
        if (!byCode[row.student_id]) errs.push('unknown student_id ' + row.student_id);
        var cs = row.class_score === '' ? null : Number(row.class_score);
        var es = row.exam_score === '' ? null : Number(row.exam_score);
        if (cs != null && (isNaN(cs) || cs < 0 || cs > classMax)) errs.push('class_score 0–' + classMax);
        if (es != null && (isNaN(es) || es < 0 || es > examMax)) errs.push('exam_score 0–' + examMax);
        if (errs.length) return { ok: false, errors: errs };
        return { ok: true, value: { student_id: row.student_id, class_id: klass.id, subject: subject, term: term, class_score: cs, exam_score: es } };
      });
      Bulk.summaryModal('Import scores · ' + subject, res, function (valid) {
        DB.all('scores').then(function (all) {
          var ops = valid.map(function (v) {
            var ex = all.filter(function (x) { return x.student_id === v.student_id && x.subject === subject && x.term === term && x.class_id === klass.id; })[0];
            return ex ? DB.update('scores', ex.id, v) : DB.insert('scores', v);
          });
          Promise.all(ops).then(function () { U.toast('Imported ' + valid.length + ' score row(s).'); done(); });
        });
      });
    }).catch(function () {});
  }

  function teacherClasses() {
    var all = App.ctx.classes.slice().sort(function (a, b) { return a.sort - b.sort; });
    if (App.user.role === 'Teacher') {
      var ids = App.teacherClassIds();
      if (ids.length) return all.filter(function (c) { return ids.indexOf(c.id) !== -1; });
    }
    if (App.readOnly && App.user.linked_student_ids) {
      // parent: classes of their children — resolved lazily; fall back to all
      return all;
    }
    return all;
  }

  global.Views = global.Views || {};
  global.Views.assessment = { title: 'Assessment', render: render };
})(window);
