/* ============================================================
 * subscription.js — Admin: subscription status, plans & licence activation.
 * Reads state from License (license-lib.js). Admin/Director view; Admin sets.
 * ============================================================ */
(function (global) {
  'use strict';
  var U = global.U, DB = global.DB, App = global.App, L = global.License;
  var el = U.el;

  function info(l, v) { return el('div', {}, [el('div', { class: 'muted', style: 'font-size:.75rem', text: l }), el('div', { style: 'font-weight:600', text: v })]); }

  function render(container) {
    U.clear(container);
    container.appendChild(el('div', { class: 'page-head' }, [el('h1', { text: 'Subscription & Licence' })]));
    var canView = App.user && (App.user.role === 'Admin' || App.user.role === 'Director');
    if (!canView) { container.appendChild(el('div', { class: 'empty', text: 'Only the Administrator or Director can view the subscription.' })); return; }
    if (!L) { container.appendChild(el('div', { class: 'empty', text: 'Licensing module not loaded.' })); return; }
    var isAdmin = App.user.role === 'Admin';
    // NOTE: there is deliberately no hidden "developer mode" here any more.
    // Trial length used to be editable from this screen behind a secret
    // localStorage flag (sms_dev) — security by obscurity, and it let the
    // school's own device change its own trial. Trial and plan are now set by
    // the owner from the platform dashboard (/admin) and stored server-side.

    L.resolve().then(function (st) {
      var badge = st.suspended ? ['Suspended', '#b91c1c'] : (st.state === 'active' ? ['Active', '#0f5e5e'] : (st.state === 'trialing' ? ['Free trial', '#8a6410'] : ['Ended', '#b91c1c']));
      var hasEnd = !!st.expires;
      var s = el('div', { class: 'card' }, [
        el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:center' }, [
          el('h3', { text: 'Status' }),
          el('span', { class: 'tag', style: 'background:' + badge[1] + ';color:#fff', text: badge[0] })
        ]),
        el('div', { class: 'grid cols-3' }, [
          info('Plan', st.planLabel || '—'),
          info(st.trial ? 'Free trial ends' : (st.paid ? 'Paid until' : 'Renews'), st.expires ? U.fmtDate(st.expires) : '—'),
          info('Days remaining', hasEnd ? ((st.daysLeft >= 0 ? st.daysLeft : 0) + '') : '—')
        ])
      ]);
      if (st.school) s.appendChild(el('div', { class: 'help', text: 'Licensed to: ' + st.school }));
      if (st.state === 'expired') s.appendChild(el('div', { class: 'note', style: 'background:#fde8e8;color:#8a1c1c', text: st.source === 'server'
        ? 'Your account is currently view-only. Your data is safe — you can still look at it and download it. Subscribe or renew below to start editing again.'
        : 'The app is currently read-only. Enter a valid licence key below to unlock editing. Your data is safe and can still be viewed and exported.' }));
      container.appendChild(s);

      var pr = el('div', { class: 'card' }, [el('h3', { text: 'Plans (' + L.CURRENCY + ')' })]);
      var t = el('table', { class: 'data' });
      t.appendChild(el('thead', {}, [el('tr', {}, ['Plan', 'Up to', 'Per term', 'Per year (3 terms)'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      Object.keys(L.PLANS).forEach(function (k) {
        var p = L.PLANS[k];
        tb.appendChild(el('tr', {}, [el('td', { text: p.label }), el('td', { text: p.max >= 100000 ? 'unlimited' : (p.max + ' students') }), el('td', { text: L.CURRENCY + ' ' + p.term }), el('td', { text: L.CURRENCY + ' ' + p.year })]));
      });
      t.appendChild(tb); pr.appendChild(el('div', { class: 'table-wrap' }, [t]));
      pr.appendChild(el('div', { class: 'help', text: 'Tiers by enrolment — Basic (up to 199 pupils), Growth (200–499), Premium (500+). Every plan includes a 30-day free trial. Add-ons: bulk SMS credits and online fee payment. Prices are a guide and can be adjusted.' }));
      container.appendChild(pr);

      // Hosted (API) mode: the plan and trial are set centrally by Zetranova and
      // read from the server, so there is nothing for the school to enter here.
      // Offline licence keys only apply to a standalone/local install.
      if (st.source === 'server') {
        if (isAdmin) container.appendChild(verifyCard(st, function () { render(container); }));
        container.appendChild(howToSubscribe(st));
        return;
      }

      var ta = el('textarea', { rows: 3, placeholder: 'Paste licence key here…', style: 'width:100%;font-family:monospace;font-size:.8rem' });
      var ac = el('div', { class: 'card' }, [el('h3', { text: 'Activate / enter licence key' })]);
      ac.appendChild(el('div', { class: 'help', text: 'Paste the licence key sent by Zetranova. To request a key or a free-trial extension, quote your school name below.' }));
      ac.appendChild(el('div', { class: 'field' }, [el('label', { text: 'School name (as registered)' }), el('input', { type: 'text', value: (App.ctx.school && App.ctx.school.name) || '', readonly: 'readonly', style: 'width:100%' })]));
      ac.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Licence key' }), ta]));
      ac.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn gold', text: 'Activate', onclick: function () {
          var key = ta.value.trim(); if (!key) return U.toast('Paste a key first.', 'err');
          L.activate(key).then(function (r) { if (!r.ok) { U.toast(r.error, 'err'); return; } U.toast('Licence activated — reloading…'); setTimeout(function () { location.reload(); }, 700); });
        } }),
        (st.source === 'key' ? el('button', { class: 'btn ghost', text: 'Remove key (revert to trial)', onclick: function () { U.confirm('Remove the current licence key?', function () { L.deactivate().then(function () { U.toast('Removed — reloading…'); setTimeout(function () { location.reload(); }, 600); }); }); } }) : null)
      ]));
      if (isAdmin) container.appendChild(ac);
      else container.appendChild(el('div', { class: 'note', text: 'To change your plan, renew, or enter a licence key, please contact your school Administrator or Zetranova.' }));
    });
  }

  // Simple, beginner-friendly "how do I pay / renew?" card for hosted schools.
  // The developer records the payment on their side (platform console), so the
  // school's job is just: tell us who you are, pay, and see the status change.
  function howToSubscribe(st) {
    var address = global.location.origin + '/' + (App.schoolId || '');
    var verb = st.state === 'trialing' ? 'subscribe' : 'renew';
    var msg = 'Hello Zetranova, I would like to ' + verb + ' to Zetclass.\n'
      + 'School: ' + (st.school || (App.ctx.school && App.ctx.school.name) || '') + '\n'
      + 'Web address: ' + address + '\n'
      + 'Plan I want (Basic / Growth / Premium): \n'
      + 'Number of pupils: ';
    var contact = global.ZETCLASS_CONTACT || {};
    var momo = contact.momo && contact.momo.number ? contact.momo : null;
    var waDigits = String(contact.whatsapp || '').replace(/\D+/g, '');
    var support = App.supportLine ? App.supportLine() : '';

    var steps = el('ol', { class: 'start-steps' }, [
      el('li', {}, [el('strong', { text: 'Pick a plan' }), el('div', { class: 'help', text: 'See the table above — Basic, Growth or Premium depends on how many pupils you have.' })]),
      el('li', {}, [el('strong', { text: 'Message us' }), el('div', { class: 'help', text: 'Tap the button below. It writes the message for you, with your school’s details.' })]),
      el('li', {}, [el('strong', { text: 'Pay by Mobile Money' }), el('div', { class: 'help', text: momo
        ? 'Pay to our MoMo Merchant: number ' + momo.number + ', Merchant ID ' + momo.merchantId + '. Then send us the transaction ID on WhatsApp and we confirm your payment.'
        : 'We reply with the payment details and confirm once we receive your payment.' })]),
      el('li', {}, [el('strong', { text: 'Done' }), el('div', { class: 'help', text: 'Your status above changes to “Active” with your new “Paid until” date. No need to do anything else.' })])
    ]);
    var actions = el('div', { class: 'btn-row' });
    if (waDigits) actions.appendChild(el('a', { class: 'btn gold', href: 'https://wa.me/' + waDigits + '?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener', text: 'Message us on WhatsApp' }));
    var copyBtn = el('button', { class: 'btn ' + (waDigits ? 'ghost' : 'gold'), type: 'button', text: 'Copy my message', onclick: function () {
      var ok = function () { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy my message'; }, 2000); };
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) global.navigator.clipboard.writeText(msg).then(ok, function () { U.toast('Could not copy.', 'warn'); });
      else U.toast('Could not copy.', 'warn');
    } });
    actions.appendChild(copyBtn);

    var card = el('div', { class: 'card' }, [el('h3', { text: 'How to ' + (verb === 'subscribe' ? 'subscribe' : 'renew') }), steps, actions]);
    if (support) card.appendChild(el('div', { class: 'help', style: 'margin-top:.6rem', text: 'Contact: ' + support }));
    else card.appendChild(el('div', { class: 'help', style: 'margin-top:.6rem', text: 'Paste the copied message into a WhatsApp or email message to Zetranova.' }));
    return card;
  }

  // "Verify your school" — the school's own proof of ownership. The Admin enters
  // the school's licence / registration number; Zetranova checks it against the
  // official record and the owner, then marks the school Verified. Payment
  // confirmation waits for this, so it protects schools from impersonators.
  function verifyCard(st, rerender) {
    var contact = global.ZETCLASS_CONTACT || {};
    var waDigits = String(contact.whatsapp || '').replace(/\D+/g, '');
    var card = el('div', { class: 'card' }, [el('h3', { text: 'Verify your school' })]);
    if (st.verified) {
      card.appendChild(el('div', { class: 'row', style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap' }, [
        el('span', { class: 'chip', style: 'background:#0f5e5e;color:#fff;padding:.15rem .6rem;border-radius:99px;font-weight:600', text: 'Verified ✓' }),
        el('span', { class: 'muted', text: st.verifiedAt ? 'Confirmed by Zetranova on ' + String(st.verifiedAt).slice(0, 10) + '.' : 'Confirmed by Zetranova.' })
      ]));
      card.appendChild(el('div', { class: 'help', style: 'margin-top:.4rem', text: 'Your licence / registration number: ' + (st.licenceNo || '—') + '. Thank you — nothing more to do here.' }));
      return card;
    }
    var pending = !!st.licenceNo;
    card.appendChild(el('div', { class: 'help', text: pending
      ? 'We have your number (' + st.licenceNo + ') and Zetranova will check it with the school’s owner. You can correct it below if it was wrong.'
      : 'To protect real schools from impersonators, Zetranova confirms that the person who registered is the owner or an authorised representative. Enter your school’s licence or registration number (for example your NaSIA or Ghana Education Service number).' }));
    var inp = el('input', { type: 'text', maxlength: '80', value: st.licenceNo || '', placeholder: 'Licence / registration number', style: 'width:100%' });
    var status = el('div', { class: 'help', style: 'margin-top:.4rem' });
    var btn = el('button', { class: 'btn gold', type: 'button', text: pending ? 'Update number' : 'Submit for checking', onclick: function () {
      var v = inp.value.trim();
      if (v.length < 3) { status.textContent = 'Please type your school’s licence or registration number.'; status.style.color = '#b91c1c'; return; }
      btn.disabled = true;
      DB.submitVerification(v).then(function () {
        U.toast('Thank you — we will check it and mark your school Verified.');
        rerender();
      }).catch(function (e) {
        btn.disabled = false; status.textContent = (e && e.message) || 'Could not save. Please try again.'; status.style.color = '#b91c1c';
      });
    } });
    card.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Licence / registration number' }), inp]));
    card.appendChild(el('div', { class: 'btn-row' }, [btn]));
    card.appendChild(status);
    if (pending && waDigits) {
      var msg = 'Hello Zetranova, please verify my school on Zetclass.\nSchool: ' + (st.school || '') + '\nLicence / registration number: ' + st.licenceNo + '\nI am the owner / authorised representative.';
      card.appendChild(el('div', { class: 'btn-row', style: 'margin-top:.4rem' }, [el('a', { class: 'btn ghost', href: 'https://wa.me/' + waDigits + '?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener', text: 'Tell us on WhatsApp' })]));
    }
    return card;
  }

  global.Views = global.Views || {};
  global.Views.subscription = { title: 'Subscription', render: render };
})(window);
