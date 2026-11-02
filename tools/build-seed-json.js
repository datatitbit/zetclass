#!/usr/bin/env node
/* ============================================================
 * build-seed-json.js — regenerate app/api/seed.json from app/js/seed.js
 *
 * WHY: seed.js is the one place the app's starter data (classes, fee types,
 * grading, permissions, report templates, ...) is edited. The PHP server
 * seeds every NEW school from app/api/seed.json. If the two drift apart, new
 * schools silently start with outdated defaults (this already happened once).
 * Run this after ANY change to app/js/seed.js, then commit both files:
 *
 *     node tools/build-seed-json.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'app');
const code = fs.readFileSync(path.join(root, 'js', 'seed.js'), 'utf8');

// seed.js expects a browser: give it a fake window whose localStorage always
// answers with a fixed school id, so the output is the same every time.
const store = { getItem: () => 'sch-1', setItem: () => {} };
const sandbox = { window: { localStorage: store }, localStorage: store };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const seed = Object.assign({}, sandbox.window.SMS_SEED);
delete seed.constants; // browser-only helper lists; the server does not store them

const out = path.join(root, 'api', 'seed.json');
fs.writeFileSync(out, JSON.stringify(seed, null, 2) + '\n');
console.log('Wrote ' + path.relative(process.cwd(), out) + ' — ' +
  (seed.students || []).length + ' demo pupils, ' + (seed.users || []).length + ' demo logins, ' +
  (seed.classes || []).length + ' classes.');
