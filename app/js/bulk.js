/* ============================================================
 * bulk.js — Download template / Upload filled (CSV).
 * CSV works fully offline with no library. Every upload is
 * validated row-by-row; only valid rows import. No silent overwrite.
 * ============================================================ */
(function (global) {
  'use strict';

  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = (c == null) ? '' : String(c);
        if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(',');
    }).join('\r\n');
  }

  function parseCSV(text) {
    var rows = [], row = [], cur = '', i = 0, q = false;
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    while (i < text.length) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else cur += ch;
      }
      i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function download(filename, rows) {
    var csv = toCSV(rows);
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 100);
  }

  // Prompt user to pick a CSV, return parsed rows.
  function pickFile() {
    return new Promise(function (resolve, reject) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.csv,text/csv';
      inp.onchange = function () {
        var f = inp.files[0]; if (!f) return reject(new Error('No file'));
        var rd = new FileReader();
        rd.onload = function () { resolve({ name: f.name, rows: parseCSV(rd.result) }); };
        rd.onerror = function () { reject(new Error('Read failed')); };
        rd.readAsText(f);
      };
      inp.click();
    });
  }

  // headers: [..], parsed rows incl header. validateRow(obj, index) -> {ok, errors[], value}
  function processUpload(rows, headers, validateRow) {
    if (!rows.length) return { valid: [], rejected: [{ line: 0, why: 'Empty file' }] };
    var head = rows[0].map(function (h) { return String(h).trim(); });
    // verify required headers present
    var missing = headers.filter(function (h) { return head.indexOf(h) === -1; });
    if (missing.length) return { valid: [], rejected: [{ line: 1, why: 'Missing columns: ' + missing.join(', ') }] };
    var valid = [], rejected = [];
    for (var r = 1; r < rows.length; r++) {
      var obj = {};
      head.forEach(function (h, c) { obj[h] = (rows[r][c] || '').trim(); });
      var res = validateRow(obj, r);
      if (res.ok) valid.push(res.value);
      else rejected.push({ line: r + 1, why: res.errors.join('; '), data: obj });
    }
    return { valid: valid, rejected: rejected };
  }

  // Render a summary modal of what will import vs rejected; confirm to commit.
  function summaryModal(title, result, onCommit) {
    var U = global.U;
    var body = U.el('div');
    body.appendChild(U.el('p', { html: '<b>' + result.valid.length + '</b> valid row(s) ready to import. <b>' +
      result.rejected.length + '</b> rejected.' }));
    if (result.notes && result.notes.length) {
      var nb = U.el('div', { class: 'note' });
      result.notes.forEach(function (t2) { nb.appendChild(U.el('div', { text: t2 })); });
      body.appendChild(nb);
    }
    if (result.rejected.length) {
      var t = U.el('table', { class: 'data' });
      t.appendChild(U.el('thead', {}, [U.el('tr', {}, [U.el('th', { text: 'Line' }), U.el('th', { text: 'Reason' })])]));
      var tb = U.el('tbody');
      result.rejected.forEach(function (rj) {
        tb.appendChild(U.el('tr', {}, [U.el('td', { text: rj.line }), U.el('td', { text: rj.why })]));
      });
      t.appendChild(tb);
      body.appendChild(U.el('div', { class: 'table-wrap' }, [t]));
      body.appendChild(U.el('p', { class: 'help', text: 'Rejected rows are NOT imported. Fix them and re-upload.' }));
    }
    U.modal({
      title: title, wide: true, body: body,
      actions: [
        { label: 'Cancel', onClick: function (c) { c(); } },
        { label: 'Import ' + result.valid.length + ' valid', kind: 'gold',
          onClick: function (c) { c(); onCommit(result.valid); } }
      ]
    });
  }

  global.Bulk = {
    toCSV: toCSV, parseCSV: parseCSV, download: download, pickFile: pickFile,
    processUpload: processUpload, summaryModal: summaryModal
  };
})(window);
