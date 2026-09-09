/* ============================================================
 * report.js — builds a printable report card (Template A & B).
 * Reads the per-class template config from Settings; all blocks
 * and fields honour their show/label toggles. One page per pupil.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, G = global.Grading;

  function elx(tag, cls, txt) { var n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; }

  // Header placeholder icons — stroke uses currentColor so they inherit
  // .rc-logo's existing color (#333) without any extra CSS. Left box: shown
  // only until a school logo is uploaded (Settings → Profile → School logo).
  // Right box: was an empty spacer only used to balance the header layout;
  // now doubles as a visual placeholder for a future per-student photo field.
  var SCHOOL_ICON_SVG = '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01"/></svg>';
  var STUDENT_ICON_SVG = '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';

  // Ensures a Template A record has the multi-format shape (checklistFormat +
  // checklistFormats), synthesising it from the legacy single-format
  // `checklistDomains` field for installs saved before formats existed.
  function normalizeTemplateA(t) {
    if (t.checklistFormats && t.checklistFormat) return t;
    var legacyDomains = t.checklistDomains || [];
    t.checklistFormat = t.checklistFormat || 'checklist';
    t.checklistFormats = t.checklistFormats || {
      checklist: { label: 'Checklist & Scores (default)', columnHeader: 'THE CHILD CAN…', marks: ['YES', 'PAR', 'NES'], domains: legacyDomains },
      nacca: { label: 'NaCCA/GES Learning Areas — Proficiency Levels', columnHeader: 'LEARNING AREA', marks: ['Beginning', 'Developing', 'Proficient', 'Highly Proficient'],
        domains: [{ name: 'Learning Areas', indicators: ['Language & Literacy', 'Numeracy', 'Creative Arts', 'Our World, Our People', 'Physical & Health Development'] }] },
      eyfs: { label: 'EYFS-style Areas of Learning', columnHeader: 'AREA OF LEARNING', marks: ['Emerging', 'Developing', 'Secure'],
        domains: [{ name: 'Areas of Learning', indicators: ['Communication & Language', 'Physical Development', 'Personal, Social & Emotional Development', 'Literacy', 'Mathematics', 'Understanding the World', 'Expressive Arts & Design'] }] }
    };
    return t;
  }

  // data: { student, klass, template, ctx, scores[], attendance, fees, position, promotedTo, checklist }
  function build(data) {
    var ctx = data.ctx, school = ctx.school, ac = ctx.academic, labels = ctx.labels;
    var t = data.template;
    if (t.kind === 'A') normalizeTemplateA(t);
    var card = elx('div', 'report-card');

    // ---- Header ----
    var head = elx('div', 'rc-head');
    var logo = elx('div', 'rc-logo');
    if (school.logo) { var img = document.createElement('img'); img.src = school.logo; img.className = 'rc-logo'; img.alt = school.name + ' logo'; logo = img; }
    else { logo.title = 'No school logo uploaded yet — add one in Settings → Profile → School logo.'; logo.innerHTML = SCHOOL_ICON_SVG; }
    var titles = elx('div', 'rc-titles');
    titles.appendChild(elx('div', 'rc-school', (school.name || 'School').toUpperCase()));
    if (school.motto) titles.appendChild(elx('div', 'rc-contact', school.motto));
    titles.appendChild(elx('div', 'rc-contact', [school.address, school.location].filter(Boolean).join('   ·   ')));
    titles.appendChild(elx('div', 'rc-contact',
      [school.phone && ('Phone: ' + school.phone), school.whatsapp && ('WhatsApp: ' + school.whatsapp)].filter(Boolean).join('   ')));
    titles.appendChild(elx('div', 'rc-contact',
      [school.email && ('Email: ' + school.email), school.website].filter(Boolean).join('   ')));
    head.appendChild(logo); head.appendChild(titles);
    var photoBox = elx('div', 'rc-logo'); // balances header spacing; reserved for a future per-student photo
    photoBox.title = 'Student photo (not yet available) — placeholder for balance.';
    photoBox.innerHTML = STUDENT_ICON_SVG;
    head.appendChild(photoBox);
    card.appendChild(head);

    var termObj = (ac.terms || []).filter(function (x) { return x.n === ac.current_term; })[0] || {};
    card.appendChild(elx('div', 'rc-term', (termObj.name || ('Term ' + ac.current_term)) + ' REPORT — ' + ac.year));

    // ---- Meta (student/class/attendance/roll/position) ----
    var meta = elx('table', 'rc-meta');
    function mrow(cells) {
      var tr = document.createElement('tr');
      cells.forEach(function (c) {
        var td = document.createElement('td');
        if (c.lbl) { var b = elx('span', 'lbl', c.lbl + ' '); td.appendChild(b); }
        td.appendChild(document.createTextNode(c.val == null ? '' : c.val));
        if (c.span) td.colSpan = c.span;
        tr.appendChild(td);
      });
      meta.appendChild(tr);
    }
    var fullName = (data.student.first_name + ' ' + data.student.last_name).trim();
    mrow([{ lbl: "STUDENT’S NAME:", val: fullName.toUpperCase(), span: 2 }, { lbl: 'STUDENT ID:', val: data.student.student_id }]);
    var row2 = [{ lbl: 'CLASS:', val: data.klass.name.toUpperCase() },
      { lbl: labels.roll + ':', val: data.roll || '' }];
    if (t.kind === 'B' && (!t.fields || t.fields.overallPosition.show)) {
      var posLabel = (t.fields && t.fields.overallPosition.label) || 'Position';
      row2.push({ lbl: posLabel + ':', val: data.position ? G.ordinal(data.position) : '' });
    }
    mrow(row2);
    mrow([{ lbl: labels.attendance + ':', val: (data.attendance && data.attendance.present) || '' },
      { lbl: labels.out_of + ':', val: (data.attendance && data.attendance.total) || '' },
      { lbl: '', val: '' }]);
    mrow([{ lbl: 'TERM CLOSED ON:', val: U.fmtDate(termObj.vacation), span: 1 },
      { lbl: 'NEXT TERM BEGINS ON:', val: U.fmtDate(termObj.reopening), span: 2 }]);
    card.appendChild(meta);

    // ---- Template A: checklist ----
    if (t.kind === 'A' && t.blocks.checklist) {
      card.appendChild(buildChecklist(t, data));
    }

    // ---- Scores table ----
    if ((t.kind === 'A' && t.blocks.scoresTable) || t.kind === 'B') {
      card.appendChild(buildScores(t, data));
    }

    // ---- Promotion line (Template B, promotional term) ----
    if (t.kind === 'B' && data.promotedTo) {
      card.appendChild(elx('div', 'rc-promote', 'Promoted to: ' + data.promotedTo));
    }

    // ---- Conduct / Attitude / Interest / Overall + free remarks (Template B) ----
    if (t.kind === 'B' && t.blocks.conduct) {
      var lines = elx('div', 'rc-lines');
      var sel = data.remarks || {};
      var rf = t.remarkFields || {};
      ['conduct', 'attitude', 'interest', 'overall'].forEach(function (k) {
        var f = rf[k]; if (!f || f.show === false) return;
        var val = sel[k] || '……………………………………………………';
        lines.appendChild(elx('div', '', f.label + ': ' + val));
      });
      var fr = t.freeRemarks || {};
      if (fr.teacher && fr.teacher.show !== false) {
        lines.appendChild(elx('div', '', fr.teacher.label + ': ' + (sel.teacher_remark || '………………………………………………………………')));
      }
      if (fr.head && fr.head.show !== false) {
        lines.appendChild(elx('div', '', fr.head.label + ': ' + '……………………………………………………'));
      }
      card.appendChild(lines);
    }

    // ---- Fees block ----
    if (t.blocks.feesBlock && data.fees) {
      var ft = elx('table', 'rc-fees');
      var trf = document.createElement('tr');
      [[labels.fees_arrears, data.fees.arrears], [labels.fees_next, data.fees.next], [labels.fees_payable, data.fees.payable]]
        .forEach(function (pair) {
          var l = document.createElement('td'); l.className = 'lbl'; l.textContent = pair[0];
          var v = document.createElement('td'); v.textContent = U.money(pair[1], school.currency);
          trf.appendChild(l); trf.appendChild(v);
        });
      ft.appendChild(trf); card.appendChild(ft);
    }

    // ---- Overall remarks / signature ----
    if (t.kind === 'A') {
      card.appendChild(elx('div', 'rc-lines', '').appendChild(elx('div', '', 'REMARKS: …………………………………………………………………')).parentNode);
    }
    // Signature area — skipped for Template B when the conduct block already
    // renders the teacher remark + head signature lines.
    if (!(t.kind === 'B' && t.blocks.conduct)) {
      var sign = elx('div', 'rc-sign');
      sign.appendChild(elx('div', '', 'Class Teacher: ____________________'));
      sign.appendChild(elx('div', '', "Head Teacher’s Signature / Stamp: ____________________"));
      card.appendChild(sign);
    }

    // ---- Signature + stamp images (if uploaded in Settings) ----
    if (school.signature || school.stamp) {
      var imgRow = elx('div', 'rc-sign');
      if (school.signature) {
        var sigWrap = document.createElement('div');
        var sig = document.createElement('img'); sig.src = school.signature; sig.style.maxHeight = '46px'; sig.alt = "Head Teacher's signature"; sigWrap.appendChild(sig);
        sigWrap.appendChild(elx('div', '', "Head Teacher's Signature"));
        imgRow.appendChild(sigWrap);
      }
      if (school.stamp) {
        var stWrap = document.createElement('div');
        var st = document.createElement('img'); st.src = school.stamp; st.style.maxHeight = '60px'; st.alt = 'School stamp'; stWrap.appendChild(st);
        stWrap.appendChild(elx('div', '', 'School Stamp'));
        imgRow.appendChild(stWrap);
      }
      card.appendChild(imgRow);
    }

    // ---- KEYS + footer ----
    if (t.keysLegend) card.appendChild(elx('div', 'rc-keys', t.keysLegend));
    if (t.footer) card.appendChild(elx('div', 'rc-foot', t.footer));

    return card;
  }

  function buildChecklist(t, data) {
    var fmt = t.checklistFormats[t.checklistFormat] || t.checklistFormats.checklist;
    var marks = fmt.marks, domains = fmt.domains || [];
    var wrap = document.createElement('div');
    var tbl = elx('table', 'rc-table');
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    [fmt.columnHeader || 'ITEM'].concat(marks).forEach(function (h, i) {
      var th = document.createElement('th'); th.textContent = h; if (i === 0) th.style.textAlign = 'left'; htr.appendChild(th);
    });
    thead.appendChild(htr); tbl.appendChild(thead);
    var tb = document.createElement('tbody');
    var colSpan = marks.length + 1;
    domains.forEach(function (d) {
      var dtr = document.createElement('tr');
      var dtd = document.createElement('td'); dtd.colSpan = colSpan; dtd.className = 'rc-domain'; dtd.textContent = d.name.toUpperCase();
      dtr.appendChild(dtd); tb.appendChild(dtr);
      d.indicators.forEach(function (ind) {
        var tr = document.createElement('tr');
        var s = document.createElement('td'); s.className = 'subj'; s.textContent = ind; tr.appendChild(s);
        var mark = (data.checklist && data.checklist[ind]) || '';
        marks.forEach(function (k) {
          var td = document.createElement('td'); td.className = 'num'; td.textContent = (mark === k) ? '✓' : ''; tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  function buildScores(t, data) {
    var tbl = elx('table', 'rc-table');
    var fields = t.fields || {};
    var L = t.labels || {};
    var cols = ['SUBJECT', (L.classScore || 'Class %'), (L.examScore || 'Exam %'), (L.total || 'Total %')];
    if (t.kind === 'B') {
      if (fields.grade && fields.grade.show) cols.push(fields.grade.label);
      if (fields.positionInSubject && fields.positionInSubject.show) cols.push(fields.positionInSubject.label);
      if (fields.remarks && fields.remarks.show) cols.push(fields.remarks.label);
    } else {
      cols.push(L.remarks || 'Remarks');
    }
    var thead = document.createElement('thead'); var htr = document.createElement('tr');
    cols.forEach(function (c, i) { var th = document.createElement('th'); th.textContent = c; if (i === 0) th.style.textAlign = 'left'; htr.appendChild(th); });
    thead.appendChild(htr); tbl.appendChild(thead);
    var tb = document.createElement('tbody');
    (data.scores || []).forEach(function (s) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(s.subject, 'subj'));
      tr.appendChild(cell(num(s.class_score), 'num'));
      tr.appendChild(cell(num(s.exam_score), 'num'));
      tr.appendChild(cell(num(s.total), 'num'));
      if (t.kind === 'B') {
        if (fields.grade && fields.grade.show) tr.appendChild(cell(s.grade, 'num'));
        if (fields.positionInSubject && fields.positionInSubject.show) tr.appendChild(cell(s.subjectPos ? G.ordinal(s.subjectPos) : '', 'num'));
        if (fields.remarks && fields.remarks.show) tr.appendChild(cell(s.remark, 'subj'));
      } else {
        tr.appendChild(cell(s.remark, 'subj'));
      }
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); return tbl;
    function cell(v, c) { var td = document.createElement('td'); td.className = c; td.textContent = (v == null || v === '') ? '' : v; return td; }
    function num(v) { return (v == null || v === '') ? '' : v; }
  }

  function initials(name) {
    return (name || 'S').split(/\s+/).slice(0, 3).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  // Print one or many cards.
  function printCards(cards) {
    var area = U.$('#print-area') || document.body.appendChild(U.el('div', { id: 'print-area' }));
    U.clear(area);
    cards.forEach(function (c) { area.appendChild(c); });
    window.print();
  }

  global.ReportCard = { build: build, printCards: printCards, initials: initials, normalizeTemplateA: normalizeTemplateA };
})(window);
