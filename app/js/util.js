/* ============================================================
 * util.js — DOM helpers, toast, modal, validation, formatting.
 * ============================================================ */
(function (global) {
  'use strict';

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'value') n.value = attrs[k];
      else if (attrs[k] === true) n.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Toast / save confirmations ----
  function toast(msg, kind) {
    var host = $('#toast-host') || document.body.appendChild(el('div', { id: 'toast-host', 'aria-live': 'polite', role: 'status' }));
    var t = el('div', { class: 'toast ' + (kind || 'ok'), text: msg });
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2800);
  }

  // ---- Modal ----
  function modal(opts) {
    // opts: { title, body(node|string), actions:[{label,kind,onClick(close)}], wide }
    var overlay = el('div', { class: 'modal-overlay' });
    var box = el('div', { class: 'modal' + (opts.wide ? ' modal-wide' : '') });
    var head = el('div', { class: 'modal-head' }, [
      el('h3', { text: opts.title || '' }),
      el('button', { class: 'icon-btn', html: '&times;', onclick: close, 'aria-label': 'Close' })
    ]);
    var bodyNode = el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') bodyNode.innerHTML = opts.body;
    else if (opts.body) bodyNode.appendChild(opts.body);
    var foot = el('div', { class: 'modal-foot' });
    (opts.actions || [{ label: 'Close', kind: '', onClick: function (c) { c(); } }]).forEach(function (a) {
      foot.appendChild(el('button', {
        class: 'btn ' + (a.kind || ''),
        text: a.label,
        onclick: function () { a.onClick ? a.onClick(close) : close(); }
      }));
    });
    box.appendChild(head); box.appendChild(bodyNode); box.appendChild(foot);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    return { close: close, body: bodyNode };
  }

  function confirmDialog(message, onYes) {
    modal({
      title: 'Please confirm', body: el('p', { text: message, style: 'white-space:pre-line' }),
      actions: [
        { label: 'Cancel', kind: '', onClick: function (c) { c(); } },
        { label: 'Yes', kind: 'danger', onClick: function (c) { c(); onYes(); } }
      ]
    });
  }

  // ---- Form builder ----
  // fields: [{ name, label, type, value, options, required, placeholder, help, min, max }]
  function form(fields, values) {
    values = values || {};
    var wrap = el('form', { class: 'form', onsubmit: function (e) { e.preventDefault(); } });
    fields.forEach(function (f) {
      if (f.type === 'hidden') return;
      var row = el('div', { class: 'field' });
      if (f.type !== 'checkbox') {
        row.appendChild(el('label', { text: f.label + (f.required ? ' *' : ''), for: 'f_' + f.name }));
      }
      var input;
      var v = values[f.name] != null ? values[f.name] : (f.value != null ? f.value : '');
      if (f.type === 'select') {
        input = el('select', { id: 'f_' + f.name, name: f.name });
        (f.options || []).forEach(function (o) {
          var val = (typeof o === 'object') ? o.value : o;
          var lab = (typeof o === 'object') ? o.label : o;
          var opt = el('option', { value: val, text: lab });
          if (String(val) === String(v)) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (f.type === 'textarea') {
        input = el('textarea', { id: 'f_' + f.name, name: f.name, rows: f.rows || 3, placeholder: f.placeholder || '' });
        input.value = v;
      } else if (f.type === 'checkbox') {
        input = el('input', { id: 'f_' + f.name, name: f.name, type: 'checkbox' });
        if (v) input.checked = true;
        row.appendChild(el('label', { class: 'check-label' }, [input, document.createTextNode(' ' + f.label)]));
        if (f.help) row.appendChild(el('div', { class: 'help', text: f.help }));
        wrap.appendChild(row); return;
      } else {
        input = el('input', { id: 'f_' + f.name, name: f.name, type: f.type || 'text',
          placeholder: f.placeholder || '', value: v });
        if (f.min != null) input.min = f.min;
        if (f.max != null) input.max = f.max;
        if (f.step != null) input.step = f.step;
      }
      if (f.required) input.required = true;
      row.appendChild(input);
      if (f.help) row.appendChild(el('div', { class: 'help', text: f.help }));
      wrap.appendChild(row);
    });
    wrap.readValues = function () {
      var out = {};
      fields.forEach(function (f) {
        var node = wrap.querySelector('[name="' + f.name + '"]');
        if (!node) { if (values[f.name] !== undefined) out[f.name] = values[f.name]; return; }
        if (f.type === 'checkbox') out[f.name] = node.checked;
        else if (f.type === 'number') out[f.name] = node.value === '' ? null : Number(node.value);
        else out[f.name] = node.value;
      });
      return out;
    };
    wrap.validate = function () {
      var errs = [];
      fields.forEach(function (f) {
        if (!f.required) return;
        var node = wrap.querySelector('[name="' + f.name + '"]');
        if (node && f.type !== 'checkbox' && String(node.value).trim() === '') errs.push(f.label + ' is required.');
      });
      return errs;
    };
    return wrap;
  }

  function money(n, cur) {
    var x = Number(n || 0);
    return (cur || 'GHS') + ' ' + x.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // shade('#0f5e5e', -0.25) darkens 25% toward black; shade(c, 0.9) lightens 90% toward white.
  function shade(hex, pct) {
    hex = String(hex || '').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#000000';
    var n = parseInt(hex, 16);
    var r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    var t = pct < 0 ? 0 : 255, p = Math.abs(pct);
    r = Math.round((t - r) * p) + r; g = Math.round((t - g) * p) + g; b = Math.round((t - b) * p) + b;
    function h2(x) { var s = x.toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h2(r) + h2(g) + h2(b);
  }
  function isHexColor(s) { return /^#[0-9a-fA-F]{6}$/.test(String(s || '')); }

  function debounce(fn, ms) {
    var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms || 250); };
  }

  global.U = {
    el: el, $: $, $all: $all, clear: clear, esc: esc,
    toast: toast, modal: modal, confirm: confirmDialog, form: form,
    money: money, todayISO: todayISO, fmtDate: fmtDate, debounce: debounce,
    shade: shade, isHexColor: isHexColor
  };
})(window);
