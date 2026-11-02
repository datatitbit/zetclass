/* ============================================================
 * settings.js — Settings & Customization (the backbone).
 * Tabs: Profile · Academic · Classes & Subjects · Grading ·
 *       Fees · Inventory · Report Templates · Identity ·
 *       Roles · Messages & Labels · Data
 * Everything seeded with Ghana defaults and fully editable.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB, App = global.App;
  var el = U.el;

  var TABS = ['Profile', 'Academic', 'Classes & Subjects', 'Grading', 'Fees',
    'Inventory', 'Report Templates', 'Identity', 'Admission Form', 'Roles', 'Access Control', 'Messages & Labels', 'Data', 'Sample Data'];

  function render(container) {
    U.clear(container);
    container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'Settings & Customization' })]));
    container.appendChild(el('div', { class: 'note', text: 'Anything that differs between schools lives here — never hard-coded. Change a value, press Save, and every screen and report updates.' }));

    var tabsBar = el('div', { class: 'tabs' });
    var panel = el('div', { id: 'settings-panel' });
    var active = 'Profile';
    try { var want = global.sessionStorage.getItem('zc-settings-tab'); if (want && TABS.indexOf(want) >= 0) { active = want; global.sessionStorage.removeItem('zc-settings-tab'); } } catch (e) { /* opens on Profile */ }
    TABS.forEach(function (t) {
      var b = el('button', { text: t, onclick: function () { active = t; draw(); } });
      b._tab = t; tabsBar.appendChild(b);
    });
    container.appendChild(tabsBar);
    container.appendChild(panel);

    function draw() {
      U.$all('button', tabsBar).forEach(function (b) { b.classList.toggle('active', b._tab === active); });
      U.clear(panel);
      ({
        'Profile': tabProfile, 'Academic': tabAcademic, 'Classes & Subjects': tabClasses,
        'Grading': tabGrading, 'Fees': tabFees, 'Inventory': tabInventory,
        'Report Templates': tabTemplates, 'Identity': tabIdentity, 'Admission Form': tabAdmission,
        'Roles': tabRoles, 'Access Control': tabAccess,
        'Messages & Labels': tabMessages, 'Data': tabData, 'Sample Data': tabDemoData
      }[active])(panel);
    }
    draw();
  }

  function card(title, body) {
    return el('div', { class: 'card' }, [title ? el('h2', { text: title }) : null, body]);
  }
  function saveBtn(fn) { return el('div', { class: 'btn-row', style: 'margin-top:.8rem' }, [el('button', { class: 'btn gold', text: 'Save changes', onclick: fn })]); }

  /* ---------------- Profile ---------------- */
  function tabProfile(panel) {
    DB.singleton('school').then(function (s) {
      var f = U.form([
        { name: 'name', label: 'School name', required: true },
        { name: 'motto', label: 'Motto / slogan' },
        { name: 'address', label: 'Address' },
        { name: 'location', label: 'Location / area' },
        { name: 'phone', label: 'Phone' },
        { name: 'whatsapp', label: 'WhatsApp' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'website', label: 'Website' },
        { name: 'currency', label: 'Currency', value: 'GHS' }
      ], s);
      f.classList.add('form-grid');
      panel.appendChild(card('School Profile', f));

      // images held locally, merged on save
      var imgs = { logo: s.logo || '', signature: s.signature || '', stamp: s.stamp || '' };
      var imgCard = el('div', { class: 'card' }, [
        el('h2', { text: 'Logo, Signature & Stamp' }),
        el('div', { class: 'help', text: 'Upload images (PNG/JPG, ideally under ~300 KB). The logo prints in the report header; the signature and stamp print in the report signature area.' }),
        el('div', { class: 'grid cols-3' }, [
          imageUploader('School logo', 'logo', imgs),
          imageUploader('Head signature', 'signature', imgs),
          imageUploader('School stamp', 'stamp', imgs)
        ])
      ]);
      panel.appendChild(imgCard);

      panel.appendChild(saveBtn(function () {
        var errs = f.validate(); if (errs.length) return U.toast(errs[0], 'err');
        var v = f.readValues();
        DB.setSingleton('school', Object.assign({}, s, v, imgs)).then(function () {
          App.refresh().then(function () { U.toast('School profile saved.'); });
        });
      }));

      panel.appendChild(themeCard(s));
    });
  }

  function themeCard(s) {
    var def = { primary: '#0f5e5e', secondary1: '#e0ab2b', secondary2: '#1c6b6b' };
    var primary = U.isHexColor(s.theme_primary) ? s.theme_primary : def.primary;
    var sec1 = U.isHexColor(s.theme_secondary1) ? s.theme_secondary1 : def.secondary1;
    var sec2 = U.isHexColor(s.theme_secondary2) ? s.theme_secondary2 : def.secondary2;
    var enableCb = el('input', { type: 'checkbox' }); enableCb.checked = !!s.theme_enabled;
    var pInp = el('input', { type: 'color', value: primary });
    var s1Inp = el('input', { type: 'color', value: sec1 });
    var s2Inp = el('input', { type: 'color', value: sec2 });
    var c = el('div', { class: 'card' }, [
      el('h2', { text: 'Branding — School colours' }),
      el('div', { class: 'help', text: 'One dominant/primary colour plus two secondary colours. While "Use these colours" is off, the app, admission forms and printed reports keep the standard Zetranova look — turn it on to apply your school\'s colours everywhere instead.' }),
      el('label', { class: 'check-label', style: 'display:block;margin:.4rem 0;font-weight:600' }, [enableCb, document.createTextNode(' Use these colours across the app')]),
      el('div', { class: 'grid cols-3' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Primary / dominant colour' }), pInp]),
        el('div', { class: 'field' }, [el('label', { text: 'Secondary colour 1' }), s1Inp]),
        el('div', { class: 'field' }, [el('label', { text: 'Secondary colour 2' }), s2Inp])
      ])
    ]);
    c.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.8rem' }, [
      el('button', { class: 'btn gold', text: 'Save colours', onclick: function () {
        DB.singleton('school').then(function (cur) {
          return DB.setSingleton('school', Object.assign({}, cur, { theme_enabled: enableCb.checked, theme_primary: pInp.value, theme_secondary1: s1Inp.value, theme_secondary2: s2Inp.value }));
        }).then(function () { App.refresh().then(function () { U.toast(enableCb.checked ? 'Custom colours saved and applied.' : 'Colours saved (not applied — enable the checkbox above to use them).'); }); });
      } }),
      el('button', { class: 'btn ghost', text: 'Reset to default (and turn off)', onclick: function () {
        DB.singleton('school').then(function (cur) {
          return DB.setSingleton('school', Object.assign({}, cur, { theme_enabled: false, theme_primary: '', theme_secondary1: '', theme_secondary2: '' }));
        }).then(function () {
          App.refresh().then(function () {
            U.toast('Reset to the standard Zetranova look.');
            var panel = U.$('#settings-panel');
            if (panel) { U.clear(panel); tabProfile(panel); }
          });
        });
      } })
    ]));
    return c;
  }

  function imageUploader(label, key, imgs) {
    var box = el('div', { style: 'border:1px solid var(--line);border-radius:8px;padding:.6rem;text-align:center' });
    box.appendChild(el('div', { class: 'help', style: 'font-weight:600;color:var(--ink)', text: label }));
    var preview = el('div', { style: 'height:90px;display:flex;align-items:center;justify-content:center;margin:.4rem 0;background:#faf8f3;border-radius:6px;overflow:hidden' });
    function draw() {
      U.clear(preview);
      if (imgs[key]) { var img = el('img'); img.src = imgs[key]; img.alt = label + ' preview'; img.style.maxHeight = '88px'; img.style.maxWidth = '100%'; preview.appendChild(img); }
      else preview.appendChild(el('span', { class: 'muted', text: 'No image' }));
    }
    draw();
    box.appendChild(preview);
    var picker = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    picker.addEventListener('change', function () {
      var file = picker.files[0]; if (!file) return;
      if (!/^image\//.test(file.type)) return U.toast('Please choose an image file.', 'err');
      if (file.size > 800 * 1024) U.toast('Large image (' + Math.round(file.size / 1024) + ' KB) — consider a smaller one.', 'warn');
      var rd = new FileReader();
      rd.onload = function () { imgs[key] = rd.result; draw(); U.toast(label + ' loaded — remember to Save.'); };
      rd.readAsDataURL(file);
    });
    box.appendChild(picker);
    box.appendChild(el('div', { class: 'btn-row', style: 'justify-content:center' }, [
      el('button', { class: 'btn sm', text: 'Upload', onclick: function () { picker.click(); } }),
      el('button', { class: 'btn sm danger', text: 'Clear', onclick: function () { imgs[key] = ''; draw(); } })
    ]));
    return box;
  }

  /* ---------------- Academic ---------------- */
  function tabAcademic(panel) {
    DB.singleton('academic').then(function (a) {
      var top = U.form([
        { name: 'year', label: 'Academic year', value: a.year, help: 'e.g. 2025/2026' },
        { name: 'current_term', label: 'Current term', type: 'select', value: a.current_term, options: termOpts(a) },
        { name: 'promotional_term', label: 'Promotional term', type: 'select', value: a.promotional_term, options: termOpts(a), help: 'The term at which promotion runs (default Term 3).' }
      ], {});
      top.classList.add('form-grid');
      panel.appendChild(card('Academic Year', top));

      var termsBox = el('div');
      a.terms.forEach(function (t) {
        var tf = U.form([
          { name: 'name', label: 'Term ' + t.n + ' name', value: t.name },
          { name: 'vacation', label: 'Vacation date (term ends)', type: 'date', value: t.vacation },
          { name: 'reopening', label: 'Reopening date (next term begins)', type: 'date', value: t.reopening }
        ], {});
        tf.classList.add('form-grid'); tf._n = t.n;
        termsBox.appendChild(card('Term ' + t.n, tf));
        termsBox.lastChild._form = tf;
      });
      panel.appendChild(termsBox);

      panel.appendChild(saveBtn(function () {
        var tv = top.readValues();
        var terms = U.$all('.card', termsBox).map(function (c, i) {
          var v = c._form.readValues();
          return { n: a.terms[i].n, name: v.name, vacation: v.vacation, reopening: v.reopening };
        });
        var next = Object.assign({}, a, { year: tv.year, current_term: Number(tv.current_term),
          promotional_term: Number(tv.promotional_term), terms: terms });
        DB.setSingleton('academic', next).then(function () {
          App.refresh().then(function () { U.toast('Academic settings saved.'); });
        });
      }));
    });
    function termOpts(a) { return a.terms.map(function (t) { return { value: t.n, label: 'Term ' + t.n }; }); }
  }

  /* ---------------- Classes & Subjects ---------------- */
  function tabClasses(panel) {
    Promise.all([DB.all('categories'), DB.all('classes')]).then(function (r) {
      var cats = r[0].sort(bySort), classes = r[1].sort(bySort);

      // Categories
      var catBody = el('div');
      var ct = listTable(['Category', ''], cats.map(function (c) {
        return [c.name, rowBtns(
          function () { editCategory(c, refresh); },
          function () { delCategory(c, refresh); })];
      }));
      catBody.appendChild(ct);
      catBody.appendChild(el('button', { class: 'btn sm', text: '+ Add category', onclick: function () { editCategory(null, refresh); } }));
      panel.appendChild(card('Class Categories', catBody));

      // Classes
      var clsBody = el('div');
      var rows = classes.map(function (c) {
        var cat = cats.filter(function (x) { return x.id === c.category_id; })[0];
        return [c.name, cat ? cat.name : '—',
          el('span', { class: 'tag', text: 'Template ' + c.template }),
          c.subjects.length + ' subjects',
          el('div', { class: 'wrap-actions' }, [
            el('button', { class: 'btn sm ghost', text: 'Subjects', onclick: function () { editSubjects(c, refresh); } }),
            el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editClass(c, cats, refresh); } }),
            el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { delClass(c, refresh); } })
          ])];
      });
      clsBody.appendChild(listTable(['Class', 'Category', 'Template', 'Subjects', ''], rows));
      clsBody.appendChild(el('button', { class: 'btn sm', text: '+ Add class', onclick: function () { editClass(null, cats, refresh); } }));
      panel.appendChild(card('Classes', clsBody));
    });
    function refresh() { U.clear(panel); tabClasses(panel); }
  }

  function editCategory(c, done) {
    var f = U.form([{ name: 'name', label: 'Category name', required: true }], c || {});
    U.modal({ title: c ? 'Edit category' : 'Add category', body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues(); if (!v.name.trim()) return U.toast('Name required', 'err');
        var p = c ? DB.update('categories', c.id, { name: v.name })
          : DB.insert('categories', { name: v.name, sort: 99 });
        p.then(function () { x(); App.refresh(); U.toast('Saved.'); done(); });
      } }
    ] });
  }
  function delCategory(c, done) {
    DB.all('classes').then(function (cl) {
      if (cl.some(function (x) { return x.category_id === c.id; })) return U.toast('Remove its classes first.', 'err');
      U.confirm('Delete category "' + c.name + '"?', function () { DB.remove('categories', c.id).then(function () { U.toast('Deleted.'); done(); }); });
    });
  }
  function editClass(c, cats, done) {
    var f = U.form([
      { name: 'name', label: 'Class name', required: true },
      { name: 'category_id', label: 'Category', type: 'select', options: cats.map(function (x) { return { value: x.id, label: x.name }; }) },
      { name: 'template', label: 'Report template', type: 'select', options: [{ value: 'A', label: 'Template A (Creche)' }, { value: 'B', label: 'Template B (Standard)' }] },
      { name: 'sort', label: 'Sort order', type: 'number' }
    ], c || { template: 'B', sort: 50 });
    if (!c) f.appendChild(el('div', { class: 'help', text: 'If you enter the name of a class that already exists (e.g. "Basic 1"), it will be split into streams instead — the existing class becomes "Basic 1A" and this one becomes "Basic 1B" (next stream gets "1C", and so on).' }));
    U.modal({ title: c ? 'Edit class' : 'Add class', body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues(); if (!v.name.trim()) return U.toast('Name required', 'err');
        v.name = v.name.trim();
        if (c) { DB.update('classes', c.id, v).then(function () { x(); App.refresh(); U.toast('Saved.'); done(); }); return; }
        DB.all('classes').then(function (allClasses) { streamAwareAdd(v, allClasses, x, done); });
      } }
    ] });
  }
  // Adding a class whose name matches an existing class (or an existing
  // stream base) splits into lettered streams instead of colliding:
  //   "Basic 1" + "Basic 1" → "Basic 1A" (renamed) + "Basic 1B" (new)
  //   "Basic 1" again       → "Basic 1C" (next free letter)
  function streamAwareAdd(v, allClasses, closeModal, done) {
    var name = v.name;
    var exact = allClasses.filter(function (c2) { return c2.name.toLowerCase() === name.toLowerCase(); })[0];
    var streamRe = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([A-Z])$', 'i');
    var siblingLetters = allClasses.map(function (c2) { var m = c2.name.match(streamRe); return m ? m[1].toUpperCase() : null; }).filter(Boolean);
    function nextLetter(used) { for (var i = 0; i < 26; i++) { var L = String.fromCharCode(65 + i); if (used.indexOf(L) === -1) return L; } return 'Z'; }
    if (exact) {
      var newName = name + 'A', newName2 = name + 'B';
      DB.update('classes', exact.id, { name: newName }).then(function () {
        DB.insert('classes', Object.assign({ subjects: exact.subjects.slice() }, v, { name: newName2 })).then(function () {
          closeModal(); App.refresh(); U.toast('"' + name + '" already existed — split into "' + newName + '" and "' + newName2 + '".'); done();
        });
      });
      return;
    }
    if (siblingLetters.length) {
      var L2 = nextLetter(siblingLetters);
      DB.insert('classes', Object.assign({ subjects: [] }, v, { name: name + L2 })).then(function () {
        closeModal(); App.refresh(); U.toast('Added new stream "' + name + L2 + '".'); done();
      });
      return;
    }
    DB.insert('classes', Object.assign({ subjects: [] }, v)).then(function () { closeModal(); App.refresh(); U.toast('Saved.'); done(); });
  }
  function delClass(c, done) {
    DB.all('students').then(function (st) {
      if (st.some(function (x) { return x.class_id === c.id; })) return U.toast('Class has students; reassign them first.', 'err');
      U.confirm('Delete class "' + c.name + '"?', function () { DB.remove('classes', c.id).then(function () { U.toast('Deleted.'); done(); }); });
    });
  }
  function editSubjects(c, done) {
    var subs = c.subjects.slice();
    var listBox = el('div');
    function redraw() {
      U.clear(listBox);
      subs.forEach(function (s, i) {
        listBox.appendChild(el('div', { class: 'flex', style: 'margin-bottom:.3rem' }, [
          el('input', { type: 'text', value: s, style: 'flex:1', oninput: function (e) { subs[i] = e.target.value; } }),
          el('button', { class: 'btn sm danger', text: '✕', onclick: function () { subs.splice(i, 1); redraw(); } })
        ]));
      });
      listBox.appendChild(el('button', { class: 'btn sm ghost', text: '+ Add subject', onclick: function () { subs.push(''); redraw(); } }));
    }
    redraw();
    U.modal({ title: 'Subjects · ' + c.name, wide: true, body: listBox, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var clean = subs.map(function (s) { return s.trim(); }).filter(Boolean);
        DB.update('classes', c.id, { subjects: clean }).then(function () { x(); App.refresh(); U.toast('Subjects saved.'); done(); });
      } }
    ] });
  }

  /* ---------------- Grading ---------------- */
  function tabGrading(panel) {
    Promise.all([DB.all('gradeBands'), DB.singleton('weighting')]).then(function (r) {
      var bands = r[0], w = r[1];
      var wf = U.form([
        { name: 'class_pct', label: 'Class Score — max points', type: 'number', value: w.class_pct, min: 0, max: 100 },
        { name: 'exam_pct', label: 'Exam Score — max points', type: 'number', value: w.exam_pct, min: 0, max: 100 }
      ], {});
      wf.classList.add('form-grid');
      var wcard = card('Score Weighting (SBA split)', wf);
      wcard.appendChild(el('div', { class: 'help', text: 'Teachers enter class score and exam score already scaled to these maximums (e.g. class out of 40, exam out of 60) — the total is the direct sum of the two, so the two numbers here must add up to 100. Default 50 / 50.' }));
      wcard.appendChild(saveBtn(function () {
        var v = wf.readValues();
        if (Number(v.class_pct) + Number(v.exam_pct) !== 100) return U.toast('Class % + Exam % must equal 100.', 'err');
        DB.setSingleton('weighting', Object.assign({}, w, v)).then(function () { App.refresh(); U.toast('Weighting saved.'); });
      }));
      panel.appendChild(wcard);

      var body = el('div');
      bands = bands.slice().sort(function (a, b) { return b.min - a.min; });
      var rows = bands.map(function (b) {
        return [b.level != null ? b.level : '—', b.grade, b.min + '% – ' + b.max + '%', b.remark, el('div', { class: 'wrap-actions' }, [
          el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editBand(b, bands, refresh); } }),
          el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { U.confirm('Delete grade ' + b.grade + '?', function () { DB.remove('gradeBands', b.id).then(function () { App.refresh(); refresh(); }); }); } })
        ])];
      });
      body.appendChild(listTable(['Level', 'Grade', 'Range', 'Meaning', ''], rows));
      body.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.5rem' }, [
        el('button', { class: 'btn sm', text: '+ Add grade band', onclick: function () { editBand(null, bands, refresh); } }),
        el('button', { class: 'btn sm ghost', text: 'Reset to Option A default', onclick: function () {
          U.confirm('Replace all grade bands with the Option A default?', function () {
            DB.replaceAll('gradeBands', JSON.parse(JSON.stringify(global.SMS_SEED.gradeBands))).then(function () { App.refresh(); U.toast('Grading reset to Option A.'); refresh(); });
          });
        } })
      ]));
      panel.appendChild(card('Grade Bands — Option A (editable)', body));
    });
    function refresh() { U.clear(panel); tabGrading(panel); }
  }
  function editBand(b, allBands, done) {
    var f = U.form([
      { name: 'level', label: 'Proficiency level', type: 'number', min: 1, max: 99 },
      { name: 'grade', label: 'Grade code (e.g. A1)', required: true },
      { name: 'min', label: 'Min %', type: 'number', min: 0, max: 100 },
      { name: 'max', label: 'Max %', type: 'number', min: 0, max: 100 },
      { name: 'remark', label: 'Meaning / remark' }
    ], b || {});
    f.classList.add('form-grid');
    U.modal({ title: b ? 'Edit grade band' : 'Add grade band', body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues();
        var min = Number(v.min), max = Number(v.max);
        if (!v.grade.trim()) return U.toast('Grade code is required.', 'err');
        if (isNaN(min) || isNaN(max) || min > max) return U.toast('Min % cannot be greater than Max %.', 'err');
        var others = (allBands || []).filter(function (x2) { return !b || x2.id !== b.id; });
        var overlaps = others.some(function (x2) { return min <= Number(x2.max) && max >= Number(x2.min); });
        var proceed = function () {
          var p = b ? DB.update('gradeBands', b.id, v) : DB.insert('gradeBands', v);
          p.then(function () { x(); App.refresh(); U.toast('Saved.'); done(); });
        };
        if (overlaps) U.confirm('This range overlaps another grade band — scores in the overlap could be graded inconsistently. Save anyway?', proceed);
        else proceed();
      } }
    ] });
  }

  /* ---------------- Fees ---------------- */
  function tabFees(panel) {
    Promise.all([DB.all('feeTypes'), DB.all('categories')]).then(function (r) {
      var fees = r[0], cats = r[1];
      var body = el('div');
      var rows = fees.map(function (f) {
        var appliesLabel = f.applies_to === 'all' ? 'All classes' : (cats.filter(function (c) { return c.id === f.applies_to; })[0] || {}).name || f.applies_to;
        return [f.name, U.money(f.amount, App.ctx.school.currency), appliesLabel,
          f.frequency === 'one_time' ? 'One-time' : 'Per term',
          el('span', { class: 'tag ' + (f.required ? 'req' : 'muted'), text: f.required ? 'Required' : 'Optional' }),
          el('div', { class: 'wrap-actions' }, [
            el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editFee(f, cats, refresh); } }),
            el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { U.confirm('Delete "' + f.name + '"?', function () { DB.remove('feeTypes', f.id).then(function () { App.refresh(); refresh(); }); }); } })
          ])];
      });
      body.appendChild(listTable(['Fee type', 'Amount', 'Applies to', 'Frequency', 'Required', ''], rows));
      body.appendChild(el('button', { class: 'btn sm', text: '+ Add fee type', onclick: function () { editFee(null, cats, refresh); } }));
      panel.appendChild(card('Fee Types', body));
    });
    function refresh() { U.clear(panel); tabFees(panel); }
  }
  function editFee(f, cats, done) {
    var opts = [{ value: 'all', label: 'All classes' }].concat(cats.map(function (c) { return { value: c.id, label: c.name }; }));
    var form = U.form([
      { name: 'name', label: 'Fee name', required: true },
      { name: 'amount', label: 'Amount', type: 'number', min: 0 },
      { name: 'applies_to', label: 'Applies to', type: 'select', options: opts },
      { name: 'frequency', label: 'Frequency', type: 'select', options: [{ value: 'per_term', label: 'Per term' }, { value: 'one_time', label: 'One-time' }] },
      { name: 'required', label: 'Required', type: 'checkbox' }
    ], f || { frequency: 'per_term', applies_to: 'all', required: true });
    U.modal({ title: f ? 'Edit fee type' : 'Add fee type', body: form, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = form.readValues(); if (!v.name.trim()) return U.toast('Name required', 'err');
        var amt = Number(v.amount);
        if (isNaN(amt) || amt < 0) return U.toast('Amount must be a number of 0 or more.', 'err');
        v.amount = amt;
        var p = f ? DB.update('feeTypes', f.id, v) : DB.insert('feeTypes', v);
        p.then(function () { x(); App.refresh(); U.toast('Saved.'); done(); });
      } }
    ] });
  }

  /* ---------------- Inventory categories ---------------- */
  function tabInventory(panel) {
    DB.all('inventoryCategories').then(function (cats) {
      var body = el('div');
      var rows = cats.map(function (c) {
        return [c.name, el('div', { class: 'wrap-actions' }, [
          el('button', { class: 'btn sm', text: 'Edit', onclick: function () { editInvCat(c, refresh); } }),
          el('button', { class: 'btn sm danger', text: 'Del', onclick: function () { U.confirm('Delete "' + c.name + '"?', function () { DB.remove('inventoryCategories', c.id).then(refresh); }); } })
        ])];
      });
      body.appendChild(listTable(['Inventory category', ''], rows));
      body.appendChild(el('button', { class: 'btn sm', text: '+ Add category', onclick: function () { editInvCat(null, refresh); } }));
      panel.appendChild(card('Inventory Categories', body));
    });
    function refresh() { U.clear(panel); tabInventory(panel); }
  }
  function editInvCat(c, done) {
    var f = U.form([{ name: 'name', label: 'Category name', required: true }], c || {});
    U.modal({ title: c ? 'Edit category' : 'Add inventory category', body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues(); if (!v.name.trim()) return U.toast('Name required', 'err');
        var p = c ? DB.update('inventoryCategories', c.id, v) : DB.insert('inventoryCategories', v);
        p.then(function () { x(); U.toast('Saved.'); done(); });
      } }
    ] });
  }

  /* ---------------- Report Templates ---------------- */
  function tabTemplates(panel) {
    DB.all('reportTemplates').then(function (tmpls) {
      panel.appendChild(el('div', { class: 'note', text: 'Toggle and rename blocks/fields here. Creche → Template A; all other classes → Template B (assignment is set per class in “Classes & Subjects”).' }));
      tmpls.forEach(function (t) {
        if (t.kind === 'A') panel.appendChild(templateA(t, refresh));
        else panel.appendChild(templateB(t, refresh));
      });
    });
    function refresh() { U.clear(panel); tabTemplates(panel); }
  }
  function templateA(t, done) {
    global.ReportCard.normalizeTemplateA(t);
    var body = el('div');
    body.appendChild(toggle('Competency checklist block', t.blocks.checklist, function (v) { t.blocks.checklist = v; }));
    body.appendChild(toggle('Scores table block', t.blocks.scoresTable, function (v) { t.blocks.scoresTable = v; }));
    body.appendChild(toggle('Fees block', t.blocks.feesBlock, function (v) { t.blocks.feesBlock = v; }));
    body.appendChild(el('div', { class: 'help', text: 'Checklist and scores are independently switchable: run checklist-only, scores-only, or both.' }));
    body.appendChild(el('div', { class: 'divider' }));

    // ---- Format selector (3 options) ----
    var fmtField = el('div', { class: 'field' }, [el('label', { text: 'Checklist format' })]);
    var fmtSel = el('select');
    Object.keys(t.checklistFormats).forEach(function (key) {
      var opt = el('option', { value: key, text: t.checklistFormats[key].label });
      if (key === t.checklistFormat) opt.selected = true;
      fmtSel.appendChild(opt);
    });
    fmtSel.addEventListener('change', function () { t.checklistFormat = fmtSel.value; });
    fmtField.appendChild(fmtSel);
    body.appendChild(fmtField);
    body.appendChild(el('div', { class: 'help', text: '"Checklist & Scores" is our original default, based on the sample report you provided. The other two are alternative Ghanaian preschool formats — NaCCA/GES\'s official Kindergarten proficiency-level assessment, and an EYFS-style Areas-of-Learning format used by many private/international-curriculum preschools — each independently editable and preserved when you switch back and forth.' }));
    body.appendChild(el('div', { class: 'divider' }));

    body.appendChild(labelEditor('Scores columns', t.labels, ['classScore', 'examScore', 'total', 'remarks']));
    body.appendChild(el('button', { class: 'btn sm ghost', text: 'Restore / reset score columns to default', onclick: function () {
      U.confirm('Reset the score-column labels (Class Score %, Exam Score %, Total %, Remarks) to default?', function () {
        var def = seedTemplateA();
        if (def.labels) { t.labels = JSON.parse(JSON.stringify(def.labels)); }
        DB.update('reportTemplates', t.id, t).then(function () { App.refresh(); U.toast('Score columns reset to default.'); done(); });
      });
    } }));
    body.appendChild(textField('KEYS legend', t, 'keysLegend'));
    body.appendChild(textField('Footer note', t, 'footer'));
    body.appendChild(el('p', { class: 'help', text: 'Domains/areas and indicators for the currently-selected format — edit below.' }));
    body.appendChild(el('button', { class: 'btn sm ghost', text: 'Edit domains for this format', onclick: function () { editChecklist(t, fmtSel, done); } }));
    body.appendChild(saveBtn(function () { DB.update('reportTemplates', t.id, t).then(function () { App.refresh(); U.toast('Template A saved.'); }); }));
    return card(t.name, body);
  }
  function templateB(t, done) {
    var body = el('div');
    body.appendChild(toggle('Scores table block', t.blocks.scoresTable, function (v) { t.blocks.scoresTable = v; }));
    body.appendChild(toggle('Conduct / attitude / interest lines', t.blocks.conduct, function (v) { t.blocks.conduct = v; }));
    body.appendChild(toggle('Fees block', t.blocks.feesBlock, function (v) { t.blocks.feesBlock = v; }));
    body.appendChild(el('div', { class: 'divider' }));
    body.appendChild(el('h3', { text: 'Toggleable / renamable fields' }));
    ['grade', 'positionInSubject', 'overallPosition', 'remarks'].forEach(function (k) {
      var fld = t.fields[k];
      var rowEl = el('div', { class: 'flex', style: 'margin-bottom:.4rem; gap:.5rem; flex-wrap:wrap' }, [
        el('label', { class: 'check-label' }, [
          (function () { var c = el('input', { type: 'checkbox' }); c.checked = fld.show; c.addEventListener('change', function () { fld.show = c.checked; }); return c; })(),
          document.createTextNode(' show')
        ]),
        (function () { var i = el('input', { type: 'text', value: fld.label, style: 'flex:1; min-width:160px' }); i.addEventListener('input', function () { fld.label = i.value; }); return i; })()
      ]);
      body.appendChild(rowEl);
    });
    // ---- Editable remark option sets ----
    if (!t.remarkFields) t.remarkFields = JSON.parse(JSON.stringify(seedTemplateB().remarkFields));
    if (!t.freeRemarks) t.freeRemarks = JSON.parse(JSON.stringify(seedTemplateB().freeRemarks));
    body.appendChild(el('div', { class: 'divider' }));
    body.appendChild(el('h3', { text: 'Remarks (Conduct / Attitude / Interest / Overall)' }));
    body.appendChild(el('div', { class: 'help', text: 'Rename a category, edit/add/remove its options, or reset it. These appear as dropdowns when you set a pupil’s remarks in Assessment → Report Cards.' }));
    ['conduct', 'attitude', 'interest', 'overall'].forEach(function (k) {
      body.appendChild(remarkSetEditor(t, k));
    });
    body.appendChild(el('h3', { text: 'Free-text remark lines' }));
    ['teacher', 'head'].forEach(function (k) {
      var fr = t.freeRemarks[k];
      var cb = el('input', { type: 'checkbox' }); cb.checked = fr.show !== false; cb.addEventListener('change', function () { fr.show = cb.checked; });
      var inp = el('input', { type: 'text', value: fr.label, style: 'flex:1;min-width:160px' }); inp.addEventListener('input', function () { fr.label = inp.value; });
      body.appendChild(el('div', { class: 'flex', style: 'margin-bottom:.4rem;gap:.5rem;flex-wrap:wrap' }, [el('label', { class: 'check-label' }, [cb, document.createTextNode(' show')]), inp]));
    });
    // Suggested Class-Teacher remarks — shown as a pick-list when a teacher enters a pupil's remark.
    if (!Array.isArray(t.freeRemarks.teacher.suggestions)) t.freeRemarks.teacher.suggestions = DEFAULT_TEACHER_REMARKS.slice();
    body.appendChild(el('h4', { text: 'Suggested Class-Teacher remarks (pick-list)', style: 'margin:.6rem 0 .2rem' }));
    body.appendChild(el('div', { class: 'help', text: 'These appear as a dropdown when a teacher enters a pupil’s remark — they can pick one or type their own.' }));
    (function () {
      var sugBox = el('div');
      function renderSug() {
        U.clear(sugBox);
        t.freeRemarks.teacher.suggestions.forEach(function (r, i) {
          sugBox.appendChild(el('div', { class: 'flex', style: 'margin-bottom:.25rem;gap:.4rem' }, [
            (function () { var inp = el('input', { type: 'text', value: r, style: 'flex:1' }); inp.addEventListener('input', function () { t.freeRemarks.teacher.suggestions[i] = inp.value; }); return inp; })(),
            el('button', { class: 'btn sm danger', text: '✕', onclick: function () { t.freeRemarks.teacher.suggestions.splice(i, 1); renderSug(); } })
          ]));
        });
        sugBox.appendChild(el('button', { class: 'btn sm ghost', text: '+ suggestion', onclick: function () { t.freeRemarks.teacher.suggestions.push(''); renderSug(); } }));
      }
      renderSug();
      body.appendChild(sugBox);
    })();

    body.appendChild(el('div', { class: 'divider' }));
    body.appendChild(textField('Footer note', t, 'footer'));
    body.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.8rem' }, [
      el('button', { class: 'btn gold', text: 'Save changes', onclick: function () { DB.update('reportTemplates', t.id, t).then(function () { App.refresh(); U.toast('Template B saved.'); }); } }),
      el('button', { class: 'btn ghost', text: 'Reset fields & remarks to default', onclick: function () {
        U.confirm('Reset Template B columns, remark options and labels to default?', function () {
          var def = seedTemplateB();
          t.fields = JSON.parse(JSON.stringify(def.fields));
          t.remarkFields = JSON.parse(JSON.stringify(def.remarkFields));
          t.freeRemarks = JSON.parse(JSON.stringify(def.freeRemarks));
          DB.update('reportTemplates', t.id, t).then(function () { App.refresh(); U.toast('Template B reset to default.'); refreshTemplates(); });
        });
      } })
    ]));
    return card(t.name, body);

    function refreshTemplates() { var panel = U.$('#settings-panel'); if (panel) { U.clear(panel); tabTemplates(panel); } }
  }

  function seedTemplateB() {
    return (global.SMS_SEED.reportTemplates || []).filter(function (x) { return x.id === 'B'; })[0] || {};
  }
  function seedTemplateA() {
    return (global.SMS_SEED.reportTemplates || []).filter(function (x) { return x.id === 'A'; })[0] || {};
  }
  // Default suggested Class-Teacher remarks (kept in sync with assessment.js).
  var DEFAULT_TEACHER_REMARKS = [
    'An excellent result. Keep it up!',
    'A very good performance this term.',
    'A good result; keep working hard.',
    'A satisfactory result; more effort will bring improvement.',
    'Fair; needs to be more focused and consistent next term.',
    'Can do much better with more effort and concentration.'
  ];

  function remarkSetEditor(t, key) {
    var set = t.remarkFields[key];
    var box = el('div', { class: 'card', style: 'padding:.7rem' });
    var head = el('div', { class: 'flex', style: 'gap:.5rem;flex-wrap:wrap;margin-bottom:.4rem' });
    var cb = el('input', { type: 'checkbox' }); cb.checked = set.show !== false; cb.addEventListener('change', function () { set.show = cb.checked; });
    var nameInp = el('input', { type: 'text', value: set.label, style: 'flex:1;min-width:140px;font-weight:600' }); nameInp.addEventListener('input', function () { set.label = nameInp.value; });
    head.appendChild(el('label', { class: 'check-label' }, [cb, document.createTextNode(' show')]));
    head.appendChild(nameInp);
    box.appendChild(head);
    var optBox = el('div');
    function redraw() {
      U.clear(optBox);
      set.options.forEach(function (o, i) {
        optBox.appendChild(el('div', { class: 'flex', style: 'margin-bottom:.25rem' }, [
          (function () { var inp = el('input', { type: 'text', value: o, style: 'flex:1' }); inp.addEventListener('input', function () { set.options[i] = inp.value; }); return inp; })(),
          el('button', { class: 'btn sm danger', text: '✕', onclick: function () { set.options.splice(i, 1); redraw(); } })
        ]));
      });
      optBox.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn sm ghost', text: '+ option', onclick: function () { set.options.push(''); redraw(); } }),
        el('button', { class: 'btn sm ghost', text: 'Restore / reset to default', onclick: function () {
          var def = seedTemplateB().remarkFields[key];
          set.label = def.label; set.show = true; set.options = def.options.slice(); redraw(); nameInp.value = set.label; cb.checked = true;
        } })
      ]));
    }
    redraw();
    box.appendChild(optBox);
    return box;
  }
  function editChecklist(t, fmtSel, done) {
    var fmtKey = fmtSel.value;
    var fmt = t.checklistFormats[fmtKey];
    var domains = JSON.parse(JSON.stringify(fmt.domains || []));
    var marks = fmt.marks.slice();
    var box = el('div');
    var marksBox = el('div', { class: 'field' }, [el('label', { text: 'Mark scale (columns, in order)' })]);
    var marksList = el('div'); marksBox.appendChild(marksList);
    function redrawMarks() {
      U.clear(marksList);
      marks.forEach(function (m, mi) {
        marksList.appendChild(el('div', { class: 'flex', style: 'margin-bottom:.25rem' }, [
          el('input', { type: 'text', value: m, style: 'flex:1', oninput: function (e) { marks[mi] = e.target.value; } }),
          el('button', { class: 'btn sm danger', text: '✕', onclick: function () { marks.splice(mi, 1); redrawMarks(); } })
        ]));
      });
      marksList.appendChild(el('button', { class: 'btn sm ghost', text: '+ mark', onclick: function () { marks.push('New'); redrawMarks(); } }));
    }
    redrawMarks();
    box.appendChild(marksBox);
    box.appendChild(el('div', { class: 'divider' }));
    var domBox = el('div');
    function redraw() {
      U.clear(domBox);
      domains.forEach(function (d, di) {
        var dc = el('div', { class: 'card' });
        dc.appendChild(el('input', { type: 'text', value: d.name, style: 'font-weight:600; width:100%; margin-bottom:.4rem', oninput: function (e) { d.name = e.target.value; } }));
        d.indicators.forEach(function (ind, ii) {
          dc.appendChild(el('div', { class: 'flex', style: 'margin-bottom:.3rem' }, [
            el('input', { type: 'text', value: ind, style: 'flex:1', oninput: function (e) { d.indicators[ii] = e.target.value; } }),
            el('button', { class: 'btn sm danger', text: '✕', onclick: function () { d.indicators.splice(ii, 1); redraw(); } })
          ]));
        });
        dc.appendChild(el('button', { class: 'btn sm ghost', text: '+ indicator', onclick: function () { d.indicators.push(''); redraw(); } }));
        dc.appendChild(el('button', { class: 'btn sm danger', text: 'Remove domain', style: 'margin-left:.4rem', onclick: function () { domains.splice(di, 1); redraw(); } }));
        domBox.appendChild(dc);
      });
      domBox.appendChild(el('button', { class: 'btn sm', text: '+ Add domain', onclick: function () { domains.push({ name: 'New domain', indicators: [''] }); redraw(); } }));
    }
    redraw();
    box.appendChild(domBox);
    U.modal({ title: fmt.label + ' — domains & marks', wide: true, body: box, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        fmt.marks = marks.filter(Boolean);
        fmt.domains = domains.map(function (d) { return { name: d.name, indicators: d.indicators.filter(Boolean) }; });
        DB.update('reportTemplates', t.id, t).then(function () { x(); App.refresh(); U.toast('Saved.'); done(); });
      } }
    ] });
  }

  /* ---------------- Identity ---------------- */
  function tabIdentity(panel) {
    DB.singleton('idRules').then(function (r) {
      var f = U.form([
        { name: 'student_prefix', label: 'Student ID prefix', value: r.student_prefix },
        { name: 'staff_prefix', label: 'Staff ID prefix', value: r.staff_prefix },
        { name: 'digits', label: 'Digits', type: 'number', value: r.digits, min: 2, max: 6 },
        { name: 'auto_generate', label: 'Auto-generate IDs', type: 'checkbox', value: r.auto_generate, help: 'On = next available number assigned automatically.' },
        { name: 'allow_manual', label: 'Allow manual entry', type: 'checkbox', value: r.allow_manual, help: 'On = staff may type an ID instead of auto-generating.' }
      ], {});
      f.classList.add('form-grid');
      var c = card('Identity & Numbering', f);
      c.appendChild(el('div', { class: 'help', text: 'Example: ' + r.student_prefix + '0001 · ' + r.staff_prefix + '0001. ' + r.digits + ' digits allow up to ' + (Math.pow(10, r.digits) - 1) + ' of each.' }));
      c.appendChild(saveBtn(function () {
        var v = f.readValues();
        DB.setSingleton('idRules', Object.assign({}, r, v)).then(function () { App.refresh(); U.toast('Identity rules saved.'); U.clear(panel); tabIdentity(panel); });
      }));
      panel.appendChild(c);
    });
  }

  /* ---------------- Admission Form ---------------- */
  var ADMISSION_SECTION_TITLES = { personal: 'Personal Details', health: 'Health Needs', guardian: 'Parent / Guardian Details', declaration: 'Declaration', office: 'For Office Use Only' };
  var ADMISSION_SECTION_OPTS = Object.keys(ADMISSION_SECTION_TITLES).map(function (k) { return { value: k, label: ADMISSION_SECTION_TITLES[k] }; });
  var ADMISSION_TYPE_OPTS = [
    { value: 'text', label: 'Short text' }, { value: 'textarea', label: 'Long text' },
    { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' },
    { value: 'select', label: 'Dropdown (choices)' }, { value: 'checkbox', label: 'Yes/No checkbox' },
    { value: 'siblings', label: 'Siblings list (name + class)' }
  ];

  function tabAdmission(panel) {
    DB.singleton('admissionFields').then(function (raw) {
      var cfg = (Array.isArray(raw) && raw.length) ? raw : JSON.parse(JSON.stringify(global.SMS_SEED.admissionFields || []));

      panel.appendChild(el('div', { class: 'note', text: 'Controls what appears on Students → "Admit student", beyond the ID-numbering rules on the Identity tab. Core fields (used elsewhere in the app — the student list, bulk upload, promotion, reports) can be renamed and marked required/optional but not removed. Add your own fields below for anything else — like siblings already at the school, health needs, or admission assessment scores. The "Profile" column controls whether a field appears on the printable "Download student profile" sheet (Students tab).' }));

      var systemDefs = cfg.filter(function (d) { return d.system; });
      var sysBody = el('div');
      var sysRows = systemDefs.map(function (d) {
        var labelInp = el('input', { type: 'text', value: d.label, style: 'min-width:160px' });
        labelInp.addEventListener('input', function () { d.label = labelInp.value; });
        var reqCb = el('input', { type: 'checkbox' }); reqCb.checked = !!d.required;
        reqCb.addEventListener('change', function () { d.required = reqCb.checked; });
        var profCb = el('input', { type: 'checkbox' }); profCb.checked = d.inProfile !== false;
        profCb.addEventListener('change', function () { d.inProfile = profCb.checked; });
        return [d.key, labelInp, el('label', { class: 'check-label' }, [reqCb, document.createTextNode(' required')]), el('label', { class: 'check-label' }, [profCb, document.createTextNode(' profile')])];
      });
      sysBody.appendChild(listTable(['Field (internal)', 'Field name shown on the form', 'Required', 'Profile'], sysRows));
      sysBody.appendChild(saveBtn(function () { persist(cfg); }));
      panel.appendChild(card('Core fields (always present)', sysBody));

      var customDefs = cfg.filter(function (d) { return !d.system; });
      var custBody = el('div');
      var custRows = customDefs.map(function (d) {
        return [ADMISSION_SECTION_TITLES[d.section] || d.section, d.label,
          ADMISSION_TYPE_OPTS.filter(function (t) { return t.value === d.type; })[0] ? ADMISSION_TYPE_OPTS.filter(function (t) { return t.value === d.type; })[0].label : d.type,
          d.required ? 'Required' : 'Optional',
          d.inProfile !== false ? 'Yes' : 'No',
          el('div', { class: 'wrap-actions' }, [
            el('button', { class: 'btn sm', text: 'Edit', onclick: function () {
              editAdmissionField(d, function (nd) { cfg = cfg.map(function (x) { return x === d ? nd : x; }); persist(cfg); });
            } }),
            el('button', { class: 'btn sm danger', text: 'Del', onclick: function () {
              U.confirm('Remove field "' + d.label + '"? It will no longer appear on the admission form. Any values already saved on existing students are kept but hidden.', function () {
                cfg = cfg.filter(function (x) { return x !== d; }); persist(cfg);
              });
            } })
          ])];
      });
      custBody.appendChild(listTable(['Section', 'Field name', 'Type', 'Required', 'Profile', ''], custRows));
      custBody.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.6rem' }, [
        el('button', { class: 'btn sm', text: '+ Add custom field', onclick: function () {
          editAdmissionField(null, function (nd) { cfg.push(nd); persist(cfg); });
        } }),
        el('button', { class: 'btn sm ghost', text: 'Reset to sample-form defaults', onclick: function () {
          U.confirm('Replace ALL admission form fields (core field names/required flags + every custom field) with the default set?', function () {
            persist(JSON.parse(JSON.stringify(global.SMS_SEED.admissionFields || [])));
          });
        } })
      ]));
      panel.appendChild(card('Custom fields', custBody));
    });

    function persist(cfg) {
      DB.setSingleton('admissionFields', cfg).then(function () {
        App.refresh().then(function () { U.toast('Admission form saved.'); U.clear(panel); tabAdmission(panel); });
      });
    }
  }

  function editAdmissionField(def, onSave) {
    var isNew = !def;
    var d = def || { key: null, label: '', type: 'text', required: false, section: 'personal', system: false, options: [], help: '', inProfile: true };
    var f = U.form([
      { name: 'label', label: 'Field name (label)', required: true, value: d.label },
      { name: 'section', label: 'Section', type: 'select', value: d.section, options: ADMISSION_SECTION_OPTS },
      { name: 'type', label: 'Field type', type: 'select', value: d.type, options: ADMISSION_TYPE_OPTS },
      { name: 'options', label: 'Dropdown choices (comma-separated — only used for Dropdown type)', value: (d.options || []).join(', ') },
      { name: 'help', label: 'Helper text shown under the field (optional)', value: d.help || '' },
      { name: 'required', label: 'Required', type: 'checkbox', value: d.required },
      { name: 'inProfile', label: 'Include in "Download student profile"', type: 'checkbox', value: d.inProfile !== false }
    ], {});
    f.classList.add('form-grid');
    U.modal({ title: isNew ? 'Add custom field' : 'Edit custom field', wide: true, body: f, actions: [
      { label: 'Cancel', onClick: function (x) { x(); } },
      { label: 'Save', kind: 'gold', onClick: function (x) {
        var v = f.readValues();
        if (!v.label.trim()) return U.toast('Field name is required.', 'err');
        var out = {
          key: d.key || ('cf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
          label: v.label.trim(), section: v.section, type: v.type, required: !!v.required,
          options: v.options ? v.options.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
          help: v.help.trim(), system: false, inProfile: !!v.inProfile
        };
        x(); onSave(out);
      } }
    ] });
  }

  /* ---------------- Roles / permission matrix ---------------- */
  function tabRoles(panel) {
    DB.all('permissions').then(function (permArr) {
      var perms = {};
      if (Array.isArray(permArr) && permArr.length) permArr.forEach(function (r) { perms[r.role] = r.perms; });
      else perms = JSON.parse(JSON.stringify(global.SMS_SEED.permissions));
      var MODULES = global.SMS_SEED.constants.MODULES, ROLES = global.SMS_SEED.constants.ROLES;

      var t = el('table', { class: 'data' });
      var thead = el('thead'); var htr = el('tr', {}, [el('th', { text: 'Module' })]);
      ROLES.forEach(function (role) { htr.appendChild(el('th', { class: 'center', text: role })); });
      thead.appendChild(htr); t.appendChild(thead);
      var tb = el('tbody');
      MODULES.forEach(function (m) {
        var tr = el('tr', {}, [el('td', { text: m })]);
        ROLES.forEach(function (role) {
          var td = el('td', { class: 'center' });
          var cb = el('input', { type: 'checkbox' });
          var val = role === 'Admin' ? true : !!(perms[role] && perms[role][m]);
          cb.checked = val;
          if (role === 'Admin') { cb.disabled = true; } // Admin always full
          cb.addEventListener('change', function () { perms[role] = perms[role] || {}; perms[role][m] = cb.checked; });
          td.appendChild(cb); tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      var body = el('div', { class: 'table-wrap' }, [t]);
      var c = card('Roles & Permission Matrix', body);
      c.appendChild(el('div', { class: 'help', text: 'Admin is always full access. These toggles control which modules each role can OPEN AND VIEW. What a role can edit inside a module it can see follows its fixed job function and does not change here: Director and Parent are always view/download-only; Teacher can only edit Assessment and Attendance; Other staff (Account/Finance office) can only edit Finance, Accounting, Payroll, Inventory, Students and Administration.' }));
      c.appendChild(saveBtn(function () {
        // ensure Admin full
        perms['Admin'] = {}; MODULES.forEach(function (m) { perms['Admin'][m] = true; });
        var arr = ROLES.map(function (role) { return { id: 'perm-' + role, role: role, perms: perms[role] }; });
        DB.replaceAll('permissions', arr).then(function () { App.refresh(); U.toast('Permissions saved.'); });
      }));
      panel.appendChild(c);
    });
  }

  /* ---------------- Messages & Labels ---------------- */
  function tabMessages(panel) {
    Promise.all([DB.all('messageTemplates'), DB.singleton('labels')]).then(function (r) {
      var msgs = r[0], labels = r[1];
      var mbody = el('div');
      msgs.forEach(function (m) {
        var tf = U.form([
          { name: 'name', label: 'Template name', value: m.name },
          { name: 'body', label: 'Message body', type: 'textarea', rows: 3, value: m.body }
        ], {});
        var c = el('div', { class: 'card' }, [tf,
          el('div', { class: 'help', text: 'Placeholders: {parent} {student} {term} {balance} {currency} {school} {message}' }),
          el('div', { class: 'btn-row' }, [
            el('button', { class: 'btn sm gold', text: 'Save', onclick: function () {
              var v = tf.readValues(); DB.update('messageTemplates', m.id, v).then(function () { U.toast('Template saved.'); });
            } }),
            el('button', { class: 'btn sm danger', text: 'Delete', onclick: function () { U.confirm('Delete template?', function () { DB.remove('messageTemplates', m.id).then(function () { U.clear(panel); tabMessages(panel); }); }); } })
          ])]);
        mbody.appendChild(c);
      });
      mbody.appendChild(el('button', { class: 'btn sm', text: '+ Add template', onclick: function () {
        DB.insert('messageTemplates', { name: 'New template', body: 'Dear {parent}, {message} - {school}' }).then(function () { U.clear(panel); tabMessages(panel); });
      } }));
      panel.appendChild(card('Message Templates (SMS / Announcements)', mbody));

      var lf = U.form([
        { name: 'fees_arrears', label: 'Report label — Arrears', value: labels.fees_arrears },
        { name: 'fees_next', label: "Report label — Next term's fees", value: labels.fees_next },
        { name: 'fees_payable', label: 'Report label — Total payable', value: labels.fees_payable },
        { name: 'roll', label: 'Report label — Number on roll', value: labels.roll },
        { name: 'attendance', label: 'Report label — Attendance', value: labels.attendance },
        { name: 'out_of', label: 'Report label — Out of', value: labels.out_of }
      ], {});
      lf.classList.add('form-grid');
      var lc = card('Editable Report Labels', lf);
      lc.appendChild(saveBtn(function () {
        DB.setSingleton('labels', Object.assign({}, labels, lf.readValues())).then(function () { App.refresh(); U.toast('Labels saved.'); });
      }));
      panel.appendChild(lc);
    });
  }

  /* ---------------- Data (reset / export / import) ---------------- */
  function tabData(panel) {
    var body = el('div');
    body.appendChild(el('p', { class: 'muted', text: 'Backup or restore the whole dataset, or reset to Ghana defaults. In API mode this calls the PHP backend.' }));
    body.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: 'Export data (JSON)', onclick: function () {
        DB.exportAll().then(function (d) {
          var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sms-backup.json'; a.click();
          U.toast('Exported.');
        });
      } }),
      el('button', { class: 'btn ghost', text: 'Import data (JSON)', onclick: function () {
        var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.onchange = function () { var f = inp.files[0]; var rd = new FileReader(); rd.onload = function () { try { DB.importAll(JSON.parse(rd.result)).then(function () { App.refresh(); U.toast('Imported. Reloading…'); setTimeout(function () { location.reload(); }, 800); }); } catch (e) { U.toast('Invalid file', 'err'); } }; rd.readAsText(f); };
        inp.click();
      } }),
      el('button', { class: 'btn danger', text: 'Reset to Ghana defaults', onclick: function () {
        U.confirm('This erases all data and restores seed defaults. Continue?', function () {
          DB.reset().then(function () { U.toast('Reset done. Reloading…'); setTimeout(function () { location.reload(); }, 800); });
        });
      } })
    ]));
    panel.appendChild(card('Data Management', body));
  }

  /* ---------------- Sample Data (explore with pretend records; choose what to remove or add back) ---------------- */
  // The records and the add/remove rules live in js/sample-data.js (global.SampleData).
  function tabDemoData(panel) {
    DB.all('users').then(function (users) {
      panel.appendChild(card('Sample data', sampleDataBody()));
      // The five shared demo logins only exist in training/demo copies of the app.
      if (users.some(function (u) { return u.is_demo; })) panel.appendChild(card('Demo login accounts', demoLoginBody()));
    });
  }

  function demoLoginBody() {
    var wrap = el('div');
    wrap.appendChild(el('p', { class: 'muted', text: 'Five seeded accounts (Admin, Director, Teacher, Other staff, Parent — password "123") let anyone explore every role. Training copies only: turn these off before real staff use the app.' }));
    var status = el('div', { class: 'help', style: 'margin-bottom:.5rem' });
    var btnRow = el('div', { class: 'btn-row' });
    wrap.appendChild(status); wrap.appendChild(btnRow);
    refresh();

    function refresh() {
      DB.singleton('demoSettings').then(function (ds) {
        ds = ds || { demo_login_enabled: true };
        var on = ds.demo_login_enabled !== false;
        status.textContent = on
          ? 'Demo login is ON — Director, Teacher, Other staff and Parent demo accounts can sign in with "123".'
          : 'Demo login is OFF — those 4 demo accounts are disabled and cannot sign in. (The Admin demo account always stays enabled so this screen is never locked out.)';
        U.clear(btnRow);
        btnRow.appendChild(el('button', { class: 'btn ' + (on ? 'danger' : 'gold'), text: on ? 'Turn off demo login' : 'Turn on demo login', onclick: function () {
          var next = !on;
          DB.all('users').then(function (users) {
            var targets = users.filter(function (u) { return u.is_demo && u.role !== 'Admin'; });
            return Promise.all(targets.map(function (u) { return DB.update('users', u.id, { disabled: !next }); }));
          }).then(function () {
            return DB.setSingleton('demoSettings', Object.assign({}, ds, { demo_login_enabled: next }));
          }).then(function () {
            U.toast(next ? 'Demo login accounts enabled.' : 'Demo login accounts disabled.');
            refresh();
          });
        } }));
      });
    }
    return wrap;
  }

  function sampleDataBody() {
    var SD = global.SampleData;
    var wrap = el('div');
    wrap.appendChild(el('p', { text: 'Sample data is a few pretend records in every area — pupils, fees, attendance, scores, stock, accounts and more — so you can try every screen while you learn Zetclass.' }));
    wrap.appendChild(el('p', { class: 'muted', text: 'Tick the groups you want, then press Remove or Add. Only sample records are removed — anything you typed in yourself stays.' }));
    var list = el('div', { style: 'margin:.6rem 0' });
    var status = el('div', { style: 'font-weight:600;margin:.4rem 0' });
    var btnRow = el('div', { class: 'btn-row' });
    wrap.appendChild(list); wrap.appendChild(status); wrap.appendChild(btnRow);
    var boxes = {};
    refresh();

    function chosen() { return SD.PACKS.filter(function (p) { return boxes[p.id] && boxes[p.id].checked; }).map(function (p) { return p.id; }); }
    function refresh() {
      SD.counts().then(function (c) {
        var keep = {}; Object.keys(boxes).forEach(function (id) { keep[id] = boxes[id].checked; });
        U.clear(list); boxes = {};
        SD.PACKS.forEach(function (p) {
          var n = c.byPack[p.id], on = n > 0;
          var box = el('input', { type: 'checkbox', id: 'sd-' + p.id, style: 'width:auto;flex:none;margin:.25rem 0 0' });
          box.checked = !!keep[p.id]; boxes[p.id] = box;
          list.appendChild(el('label', { for: 'sd-' + p.id, style: 'display:flex;gap:.6rem;align-items:flex-start;padding:.45rem 0;border-bottom:1px solid var(--line);cursor:pointer' }, [
            box,
            el('span', { style: 'flex:1' }, [el('span', { style: 'font-weight:600', text: p.label }), el('div', { class: 'help', text: p.desc })]),
            el('span', { class: 'tag', style: 'background:' + (on ? '#0f5e5e' : '#6b7280') + ';color:#fff;white-space:nowrap', text: on ? 'On · ' + n + ' records' : 'Not added' })
          ]));
        });
        status.textContent = c.total > 0 ? 'Sample data is on in ' + SD.PACKS.filter(function (p) { return c.byPack[p.id] > 0; }).length + ' of ' + SD.PACKS.length + ' groups.' : 'No sample data in your school. Everything you see is yours.';
        U.clear(btnRow);
        btnRow.appendChild(el('button', { class: 'btn ghost', text: 'Select all', onclick: function () { Object.keys(boxes).forEach(function (id) { boxes[id].checked = true; }); } }));
        btnRow.appendChild(el('button', { class: 'btn ghost', text: 'Select none', onclick: function () { Object.keys(boxes).forEach(function (id) { boxes[id].checked = false; }); } }));
        btnRow.appendChild(el('button', { class: 'btn danger', text: 'Remove selected', onclick: function () { removeSelected(c); } }));
        btnRow.appendChild(el('button', { class: 'btn gold', text: 'Add selected', onclick: addSelected }));
      });
    }
    function removeSelected(c) {
      var ids = chosen().filter(function (id) { return c.byPack[id] > 0; });
      if (!ids.length) { U.toast('Tick at least one group that is currently on.', 'warn'); return; }
      var names = ids.map(function (id) { return '• ' + SD.packById(id).label; }).join('\n');
      var extra = ids.indexOf('pupils') >= 0 ? '\n\nRemoving the sample pupils also removes anything recorded against them (attendance, scores, fees, payments).' : '';
      U.confirm('Remove these sample groups?\n\n' + names + extra + '\n\nRecords you added yourself are NOT touched.', function () {
        SD.remove(ids).then(function () { return App.refresh(); }).then(function () { U.toast('Sample data removed.'); refresh(); })
          .catch(function () { U.toast('Could not remove the sample data. Please try again.', 'err'); });
      });
    }
    function addSelected() {
      var ids = chosen();
      if (!ids.length) { U.toast('Tick at least one group to add.', 'warn'); return; }
      SD.load(ids).then(function (res) {
        return App.refresh().then(function () {
          var msg = res.added.length ? 'Added: ' + res.added.map(function (id) { return SD.packById(id).label; }).join(', ') + '.' : 'Nothing new was added.';
          if (res.skipped.length) msg += ' Skipped: ' + res.skipped.map(function (s) { return SD.packById(s.id).label + ' (' + s.reason + ')'; }).join('; ') + '.';
          U.toast(msg, res.added.length ? undefined : 'warn'); refresh();
        });
      }).catch(function () { U.toast('Could not add the sample data. Please try again.', 'err'); });
    }
    return wrap;
  }

  /* ---------------- small shared helpers ---------------- */
  function bySort(a, b) { return (a.sort || 0) - (b.sort || 0); }
  function listTable(headers, rows) {
    var t = el('table', { class: 'data' });
    var thead = el('thead'); var htr = el('tr');
    headers.forEach(function (h) { htr.appendChild(el('th', { text: h })); });
    thead.appendChild(htr); t.appendChild(thead);
    var tb = el('tbody');
    if (!rows.length) { tb.appendChild(el('tr', {}, [el('td', { html: '<span class="muted">None yet.</span>', colspan: headers.length })])); }
    rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (c) {
        var td = el('td');
        if (typeof c === 'string' || typeof c === 'number') td.textContent = c;
        else td.appendChild(c);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return el('div', { class: 'table-wrap' }, [t]);
  }
  function rowBtns(onEdit, onDel) {
    return el('div', { class: 'wrap-actions' }, [
      el('button', { class: 'btn sm', text: 'Edit', onclick: onEdit }),
      el('button', { class: 'btn sm danger', text: 'Del', onclick: onDel })
    ]);
  }
  function toggle(label, val, onChange) {
    var c = el('input', { type: 'checkbox' }); c.checked = val;
    c.addEventListener('change', function () { onChange(c.checked); });
    return el('label', { class: 'check-label', style: 'margin-bottom:.5rem' }, [c, document.createTextNode(' ' + label)]);
  }
  function textField(label, obj, key) {
    var i = el('input', { type: 'text', value: obj[key] || '' });
    i.addEventListener('input', function () { obj[key] = i.value; });
    return el('div', { class: 'field' }, [el('label', { text: label }), i]);
  }
  function labelEditor(title, obj, keys) {
    var box = el('div', {}, [el('h3', { text: title })]);
    keys.forEach(function (k) {
      var i = el('input', { type: 'text', value: obj[k] || '' });
      i.addEventListener('input', function () { obj[k] = i.value; });
      box.appendChild(el('div', { class: 'field' }, [el('label', { text: k }), i]));
    });
    return box;
  }


  /* ---------------- Login accounts (password management, Admin only) ---------------- */
  function resetPasswordModal(u, onDone) {
    var body = el('div');
    var next = el('input', { type: 'password', placeholder: 'New password (min 6 characters)' });
    var next2 = el('input', { type: 'password', placeholder: 'Confirm new password' });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'New password for ' + u.name }), next]));
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Confirm' }), next2]));
    var errBox = el('div', { style: 'color:#b3261e;font-size:.85rem;display:none' });
    body.appendChild(errBox);
    U.modal({
      title: 'Reset password', body: body,
      actions: [
        { label: 'Cancel', onClick: function (c) { c(); } },
        { label: 'Save', kind: 'gold', onClick: function (c) {
          errBox.style.display = 'none';
          if (next.value.length < 6) { errBox.textContent = 'Password must be at least 6 characters.'; errBox.style.display = 'block'; return; }
          if (next.value !== next2.value) { errBox.textContent = 'Passwords do not match.'; errBox.style.display = 'block'; return; }
          global.Auth.hashPassword(next.value).then(function (r) {
            return DB.update('users', u.id, { password_salt: r.salt, password_hash: r.hash, must_change_password: true });
          }).then(function () { U.toast('Password reset for ' + u.name + '.'); c(); if (onDone) onDone(); });
        } }
      ]
    });
  }

  function addAccountModal(staffList, parentsList, onDone) {
    var roleSel = el('select');
    ['Admin', 'Director', 'Teacher', 'Other staff', 'Parent'].forEach(function (r) { roleSel.appendChild(el('option', { value: r, text: r })); });
    var linkSel = el('select');
    function refreshLink() {
      U.clear(linkSel);
      linkSel.appendChild(el('option', { value: '', text: '(none)' }));
      var list = roleSel.value === 'Parent' ? parentsList : staffList.filter(function (s) { return s.role === roleSel.value; });
      list.forEach(function (x) { linkSel.appendChild(el('option', { value: x.id, text: x.name })); });
    }
    roleSel.addEventListener('change', refreshLink); refreshLink();
    var nameInput = el('input', { type: 'text', placeholder: 'Full name' });
    var userInput = el('input', { type: 'text', placeholder: 'Username (e.g. first initial + last name)' });
    var passInput = el('input', { type: 'password', placeholder: 'Initial password (min 6 characters)' });
    var body = el('div');
    [['Full name', nameInput], ['User type', roleSel], ['Link to staff/parent record', linkSel],
      ['Username', userInput], ['Initial password', passInput]].forEach(function (f) {
      body.appendChild(el('div', { class: 'field' }, [el('label', { text: f[0] }), f[1]]));
    });
    var errBox = el('div', { style: 'color:#b3261e;font-size:.85rem;display:none' });
    body.appendChild(errBox);
    U.modal({
      title: 'Add login account', body: body,
      actions: [
        { label: 'Cancel', onClick: function (c) { c(); } },
        { label: 'Create', kind: 'gold', onClick: function (c) {
          errBox.style.display = 'none';
          if (!nameInput.value.trim() || !userInput.value.trim()) { errBox.textContent = 'Name and username are required.'; errBox.style.display = 'block'; return; }
          if (passInput.value.length < 6) { errBox.textContent = 'Password must be at least 6 characters.'; errBox.style.display = 'block'; return; }
          global.Auth.hashPassword(passInput.value).then(function (r) {
            var rec = { name: nameInput.value.trim(), username: userInput.value.trim(), role: roleSel.value,
              password_salt: r.salt, password_hash: r.hash, must_change_password: true, linked_student_ids: [] };
            if (roleSel.value === 'Parent') { if (linkSel.value) rec.linked_student_ids = (parentsList.filter(function (p) { return p.id === linkSel.value; })[0] || {}).student_ids || []; }
            else if (linkSel.value) rec.staff_id = (staffList.filter(function (s) { return s.id === linkSel.value; })[0] || {}).staff_id;
            return DB.insert('users', rec);
          }).then(function () { U.toast('Login account created.'); c(); if (onDone) onDone(); });
        } }
      ]
    });
  }

  /* ---------------- Access Control (Admin only) ---------------- */
  function tabAccess(panel) {
    if (App.user.role !== 'Admin') { panel.appendChild(el('div', { class: 'empty', text: 'Access Control is available to the Administrator only.' })); return; }
    Promise.all([DB.all('parents'), DB.all('classes'), DB.singleton('access'), DB.all('users'), DB.all('staff')]).then(function (r) {
      var parents = r[0], classes = r[1].slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
      var access = r[2] || {}; var byClass = access.report_download_by_class || {};
      var users = r[3], staffList = r[4];

      // ---- Parent report download control (whole-school / by class / per parent) ----
      var dcard = el('div', { class: 'card' }, [el('h2', { text: 'Parent report download' })]);
      dcard.appendChild(el('div', { class: 'help', text: 'Control whether parents can download the terminal report. Set a school-wide default, override by class, or per parent below. When off, the download button is simply hidden from that parent.' }));
      var globalCb = el('input', { type: 'checkbox' }); globalCb.checked = access.report_download_default !== false;
      dcard.appendChild(el('label', { class: 'check-label', style: 'display:block;margin:.4rem 0;font-weight:600' }, [globalCb, document.createTextNode(' Allow report download school-wide (default)')]));
      dcard.appendChild(el('div', { class: 'help', text: 'Override by class (Inherit = use the default above):' }));
      var clsList = el('div');
      classes.forEach(function (c) {
        var cur = byClass[c.id]; var selv = cur === true ? 'allow' : cur === false ? 'block' : 'inherit';
        var sSel = el('select', { style: 'min-width:120px' });
        [['inherit', 'Inherit'], ['allow', 'Allow'], ['block', 'Block']].forEach(function (o) { var op = el('option', { value: o[0], text: o[1] }); if (o[0] === selv) op.selected = true; sSel.appendChild(op); });
        sSel._cid = c.id;
        clsList.appendChild(el('div', { class: 'flex', style: 'justify-content:space-between;margin:.2rem 0' }, [el('span', { text: c.name }), sSel]));
      });
      dcard.appendChild(clsList);
      dcard.appendChild(saveBtn(function () {
        var bc = {};
        U.$all('select', clsList).forEach(function (sSel) { if (sSel.value === 'allow') bc[sSel._cid] = true; else if (sSel.value === 'block') bc[sSel._cid] = false; });
        DB.setSingleton('access', { id: 'access-1', report_download_default: globalCb.checked, report_download_by_class: bc }).then(function () { App.refresh(); U.toast('Report download settings saved.'); });
      }));
      panel.appendChild(dcard);

      // ---- Parent accounts: per-parent login + report override ----
      var pcard = el('div', { class: 'card' }, [el('h2', { text: 'Parent accounts' })]);
      pcard.appendChild(el('div', { class: 'help', text: 'Enable or disable an individual parent login. A disabled parent cannot sign in or view any student data. You can also override report download per parent.' }));
      var t = el('table', { class: 'data' });
      t.appendChild(el('thead', {}, [el('tr', {}, ['Parent', 'Portal login', 'Report download', ''].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      if (!parents.length) tb.appendChild(el('tr', {}, [el('td', { colspan: 4, html: '<span class=muted>No parents recorded yet.</span>' })]));
      parents.forEach(function (p) {
        var enabled = p.portal_enabled !== false;
        var rdSel = el('select', { style: 'min-width:120px' });
        [['inherit', 'Inherit'], ['allow', 'Allow'], ['block', 'Block']].forEach(function (o) { var op = el('option', { value: o[0], text: o[1] }); var cur = p.report_download; if ((cur === 'allow' && o[0] === 'allow') || (cur === 'block' && o[0] === 'block') || (cur == null && o[0] === 'inherit')) op.selected = true; rdSel.appendChild(op); });
        rdSel.addEventListener('change', function () { DB.update('parents', p.id, { report_download: rdSel.value === 'inherit' ? null : rdSel.value }).then(function () { App.refresh(); U.toast('Updated ' + p.name + '.'); }); });
        tb.appendChild(el('tr', {}, [
          el('td', { text: p.name }),
          el('td', {}, [el('span', { class: 'tag ' + (enabled ? '' : 'muted'), text: enabled ? 'Enabled' : 'Disabled' })]),
          el('td', {}, [rdSel]),
          el('td', {}, [el('button', { class: 'btn sm ' + (enabled ? 'ghost' : 'gold'), text: enabled ? 'Disable login' : 'Enable login', onclick: function () { DB.update('parents', p.id, { portal_enabled: !enabled }).then(function () { App.refresh(); U.toast('Portal ' + (enabled ? 'disabled' : 'enabled') + ' for ' + p.name + '.'); U.clear(panel); tabAccess(panel); }); } })])
        ]));
      });
      t.appendChild(tb);
      pcard.appendChild(el('div', { class: 'table-wrap' }, [t]));
      panel.appendChild(pcard);

      // ---- Login accounts: password reset + create new accounts ----
      var ucard = el('div', { class: 'card' }, [el('h2', { text: 'Login accounts' })]);
      ucard.appendChild(el('div', { class: 'help', text: 'Everyone signs in with the school name, their user type, and their own password. Reset a password if someone forgets it, or add a login for a new staff member or parent.' }));
      var ut = el('table', { class: 'data' });
      ut.appendChild(el('thead', {}, [el('tr', {}, ['Name', 'User type', 'Username', ''].map(function (h) { return el('th', { text: h }); }))]));
      var utb = el('tbody');
      users.forEach(function (u) {
        utb.appendChild(el('tr', {}, [
          el('td', { text: u.name }),
          el('td', {}, [el('span', { class: 'tag', text: u.role })]),
          el('td', { text: u.username || '—' }),
          el('td', {}, [el('button', { class: 'btn sm ghost', text: 'Reset password', onclick: function () { resetPasswordModal(u, function () { U.clear(panel); tabAccess(panel); }); } })])
        ]));
      });
      ut.appendChild(utb);
      ucard.appendChild(el('div', { class: 'table-wrap' }, [ut]));
      ucard.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.8rem' }, [
        el('button', { class: 'btn', text: '+ Add login account', onclick: function () { addAccountModal(staffList, parents, function () { U.clear(panel); tabAccess(panel); }); } })
      ]));
      panel.appendChild(ucard);

      panel.appendChild(el('div', { class: 'note', html: 'Which modules each role can open is managed on the <b>Roles</b> tab. This Access Control area is visible to the Administrator only.' }));
    });
  }

  global.Views = global.Views || {};
  global.Views.settings = { title: 'Settings', render: render };
})(window);
