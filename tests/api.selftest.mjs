/* ============================================================
 * api.selftest.mjs — end-to-end check of the Zetclass server:
 * signup, many schools in one database, school isolation, trial /
 * payment / expiry rules, throttling, roles, and developer-only routes.
 *
 * RUN IT against a THROWAWAY local server (never the live site — it
 * creates schools and fills the signup throttle):
 *   1. Start the PHP test server with a throwaway database and the
 *      developer account  dev / test-platform-pass  (see tests/README.md)
 *   2. node tests/api.selftest.mjs [http://127.0.0.1:8081/api/index.php]
 * Exit code 0 = every check passed.
 * ============================================================ */
const BASE = process.argv[2] || 'http://127.0.0.1:8081/api/index.php';
const DEV_USER = process.env.DEV_USER || 'dev';
const DEV_PASS = process.env.DEV_PASS || 'test-platform-pass';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
async function call(method, route, body, token, query) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let url = BASE + '?r=' + route;
  if (query) for (const k of Object.keys(query)) url += '&' + k + '=' + encodeURIComponent(query[k]);
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text.slice(0, 200); }
  return { status: res.status, json };
}
const section = (t) => console.log('\n' + t);
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// --- optional helpers: talk to the test database directly / read the pretend mailbox ---
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
function dbAvailable() { return !!(process.env.MYSQL_CMD || (process.env.PHP_BIN && process.env.SQLITE_DB)); }
function dbRun(sql) {
  if (process.env.MYSQL_CMD) { execFileSync(process.env.MYSQL_CMD, [...process.env.MYSQL_ARGS.split(' '), '-e', sql]); return; }
  execFileSync(process.env.PHP_BIN, ['-r', '$p=new PDO("sqlite:".getenv("SQLITE_DB"));$p->exec(' + JSON.stringify(sql) + ');'], { env: { ...process.env } });
}
function dbScalar(sql) {
  if (process.env.MYSQL_CMD) return execFileSync(process.env.MYSQL_CMD, [...process.env.MYSQL_ARGS.split(' '), '-N', '-B', '-e', sql]).toString().trim();
  return execFileSync(process.env.PHP_BIN, ['-r', '$p=new PDO("sqlite:".getenv("SQLITE_DB"));echo $p->query(' + JSON.stringify(sql) + ')->fetchColumn();'], { env: { ...process.env } }).toString().trim();
}
const mailbox = () => process.env.MAIL_DIR ? fs.readdirSync(process.env.MAIL_DIR).sort().map(f => fs.readFileSync(path.join(process.env.MAIL_DIR, f), 'utf8')) : [];
const linkIn = (mail) => { const m = /https:\/\/zetclass\.com\/reset-password\?school=([^&\s]+)&token=([0-9a-f]{64})/.exec(mail || ''); return m ? { school: decodeURIComponent(m[1]), token: m[2], url: m[0] } : null; };
// A request whose Host header lies (to prove the emailed link never trusts it).
function callWithHost(route, body, hostHeader) {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + '?r=' + route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Host: hostHeader } }, (res) => {
      let t = ''; res.on('data', (c) => t += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(t) }); } catch { resolve({ status: res.statusCode, json: t }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

const good = (n) => ({ school_name: n.school, contact_name: n.person || 'Ama Mensah', email: n.email, phone: n.phone, password: n.pw || 'Sunrise-2026!', accept_terms: true });

// ---------------------------------------------------------------
section('1. Signup validation (every required field, plain-English errors)');
{
  let r = await call('POST', 'register', {});
  check('empty form is rejected (400)', r.status === 400);
  check('…and every required field is named', ['school_name', 'contact_name', 'email', 'phone', 'password'].every(k => r.json.fields && r.json.fields[k]), r.json);
  r = await call('POST', 'register', good({ school: 'Test A', email: 'not-an-email', phone: '+233241234567' }));
  check('bad email is rejected', r.status === 400 && r.json.fields.email, r.json);
  r = await call('POST', 'register', good({ school: 'Test A', email: 'a@b.co', phone: '12' }));
  check('bad phone is rejected', r.status === 400 && r.json.fields.phone, r.json);
  r = await call('POST', 'register', { ...good({ school: 'Test A', email: 'a@b.co', phone: '+233241234567' }), accept_terms: false });
  check('signup is refused unless the Terms and Privacy box is ticked', r.status === 400 && r.json.fields.accept_terms, r.json);
  for (const [label, ph] of [['a local number with no country code', '0241234567'], ['a number with no + sign', '233241234567'], ['a country code that starts with 0', '+0241234567']]) {
    r = await call('POST', 'register', good({ school: 'Test A', email: 'a@b.co', phone: ph }));
    check(`signup refuses ${label} (country code required)`, r.status === 400 && r.json.fields.phone && /country code/i.test(r.json.fields.phone), r.json);
  }
  r = await call('POST', 'register', good({ school: 'X', email: 'a@b.co', phone: '+233241234567' }));
  check('1-letter school name is rejected', r.status === 400 && r.json.fields.school_name, r.json);
  r = await call('POST', 'register', good({ school: 'Test A', email: 'a@b.co', phone: '+233241234567', pw: 'short' }));
  check('short password is rejected', r.status === 400 && r.json.fields.password, r.json);
  r = await call('POST', 'register', good({ school: 'Test A', email: 'a@b.co', phone: '+233241234567', pw: 'password123' }));
  check('very common password is rejected', r.status === 400 && r.json.fields.password, r.json);
  r = await call('POST', 'register', { ...good({ school: 'Test A', email: 'a@b.co', phone: '+233241234567' }), company_website: 'http://spam.example' });
  check('honeypot field filled (bot) is rejected', r.status === 400, r.json);
  r = await call('POST', 'register', good({ school: '<script>alert(1)</script>', email: 'a@b.co', phone: '+233241234567' }));
  check('markup in school name is rejected', r.status === 400 && r.json.fields.school_name, r.json);
}

// ---------------------------------------------------------------
section('2. Signup happy path + many schools in ONE database');
const A = { school: "St. Mary's Basic School", email: 'Head@StMarys.example', phone: '+233 24 123 4567', person: 'Ama Mensah' };
const B = { school: "St. Mary's Basic School", email: 'other@school.example', phone: '+233205550001', person: 'Kofi Boateng' }; // same NAME, different school
const C = { school: 'Bright Future Academy', email: 'bf@school.example', phone: '+233205550002', person: 'Esi Owusu' };
const D = { school: 'Tamper Test School', email: 'tamper@school.example', phone: '+233205550003', person: 'Test Person' };
let sa, sb, sc, sd;
{
  sa = await call('POST', 'register', good(A));
  check('school A created (201)', sa.status === 201 && sa.json.token, sa.json);
  check('A: web address made from the name', sa.json.school_id === 'st-marys-basic-school', sa.json.school_id);
  check('A: trial is 30 days', sa.json.trial_days === 30 && sa.json.trial_ends_at === ymd(30), sa.json);
  check('A: returns a ready-to-use Admin session', sa.json.role === 'Admin' && sa.json.user.username === 'admin');
  sb = await call('POST', 'register', good(B));
  check('school B (same name, different school) created — proves many schools fit in one database', sb.status === 201, sb.json);
  check('B: unique address (-2)', sb.json.school_id === 'st-marys-basic-school-2', sb.json.school_id);
  sc = await call('POST', 'register', good(C));
  check('school C created', sc.status === 201 && sc.json.school_id === 'bright-future-academy', sc.json);
  sd = await call('POST', 'register', good(D));
  check('school D created', sd.status === 201, sd.json);
  let d = await call('POST', 'register', good({ ...C, school: 'Another One', phone: '+233200000009' }));
  check('same EMAIL twice is blocked (one trial per email) — 409', d.status === 409, d);
  d = await call('POST', 'register', good({ ...C, school: 'Another Two', email: 'new@school.example' }));
  check('same PHONE twice is blocked (one trial per phone) — 409', d.status === 409, d);
  d = await call('POST', 'register', good({ ...C, school: 'Another Three', email: 'HEAD@stmarys.EXAMPLE', phone: '+233200000010' }));
  check('email match ignores upper/lower case — 409', d.status === 409, d);
}

// ---------------------------------------------------------------
section('3. What a brand-new school starts with (and does NOT)');
const tA = sa.json.token, tB = sb.json.token, tC = sc.json.token;
{
  const users = await call('GET', 'users', null, tA);
  check('A: exactly ONE login (its Admin) — no shared demo accounts', Array.isArray(users.json) && users.json.length === 1 && users.json[0].username === 'admin', users.json);
  const students = await call('GET', 'students', null, tA);
  check('A: zero demo pupils', Array.isArray(students.json) && students.json.length === 0, students.json && students.json.length);
  const staff = await call('GET', 'staff', null, tA);
  check('A: just the Admin as staff #1', staff.json.length === 1 && staff.json[0].staff_id === 'SF0001', staff.json);
  const classes = await call('GET', 'classes', null, tA);
  check('A: starter classes are in place', classes.json.length >= 10, classes.json.length);
  const school = await call('GET', 'singleton/school', null, tA);
  check('A: school profile has its own name/email/phone', school.json.name === A.school && school.json.email === 'head@stmarys.example' && school.json.phone === '+233241234567', school.json);
  const inv = await call('GET', 'inventoryItems', null, tA);
  check('A: no demo stock', inv.json.length === 0);
  const ac = await call('GET', 'singleton/academic', null, tA);
  const thisYear = new Date().getUTCFullYear(), m = new Date().getUTCMonth() + 1;
  const expectStart = m >= 8 ? thisYear : thisYear - 1;
  check('A: academic year follows today’s date (not last year’s)', ac.json.year === expectStart + '/' + (expectStart + 1), ac.json.year);
  const perms = await call('GET', 'permissions', null, tA);
  const roleOf = (r) => perms.json.find(p => p.role === r);
  check('A: every role has its permission row (so Teachers, Parents etc. can use the app)', ['Admin', 'Director', 'Teacher', 'Other staff', 'Parent'].every(r => roleOf(r) && roleOf(r).perms), perms.json.map(p => p.role));
  check('A: Teacher can use Attendance but not Finance', roleOf('Teacher').perms.Attendance === true && roleOf('Teacher').perms.Finance === false);
  const af = [{ key: 'first_name', label: 'First name' }, { key: 'custom', label: 'House' }];
  await call('PUT', 'singleton/admissionFields', af, tA);
  const afBack = await call('GET', 'singleton/admissionFields', null, tA);
  check('A: a school’s edited admission-form fields are kept as a list (not lost)', Array.isArray(afBack.json) && afBack.json.length === 2 && afBack.json[1].key === 'custom', afBack.json);
  const seq = await call('POST', 'seq/student', {}, tA);
  check('A: first pupil number starts at 1', seq.json === 1, seq.json);
  // Loading sample pupils that already carry numbers must push the counter past them.
  const bump = await call('POST', 'seq/student', { at_least: 98 }, tA);
  const afterBump = await call('POST', 'seq/student', {}, tA);
  const noLower = await call('POST', 'seq/student', { at_least: 5 }, tA);
  const otherSchool = await call('POST', 'seq/student', {}, tB);
  check('A: sample data can raise the pupil counter (98), the next real pupil is 99, and it never goes down', bump.json === 98 && afterBump.json === 99 && noLower.json === 99, [bump.json, afterBump.json, noLower.json]);
  check('B: another school’s pupil counter is not affected', otherSchool.json === 1, otherSchool.json);
}

// ---------------------------------------------------------------
section('4. Schools cannot see or touch each other');
{
  const ua = await call('GET', 'users', null, tA), ub = await call('GET', 'users', null, tB);
  check('A and B each see only their own user list', ua.json.length === 1 && ub.json.length === 1 && ua.json[0].name !== ub.json[0].name, [ua.json[0].name, ub.json[0].name]);
  await call('POST', 'students', { id: 'stu-shared-id', first_name: 'Only', last_name: 'InA', student_id: 'ST0001' }, tA);
  await call('POST', 'students', { id: 'stu-shared-id', first_name: 'Only', last_name: 'InB', student_id: 'ST0001' }, tB);
  const sa2 = await call('GET', 'students', null, tA), sb2 = await call('GET', 'students', null, tB);
  check('same record id in two schools does not clash', sa2.json.length === 1 && sb2.json.length === 1 && sa2.json[0].last_name === 'InA' && sb2.json[0].last_name === 'InB');
  const peek = await call('GET', 'students', null, tA, { school: sb.json.school_id });
  check('?school=<other> is ignored for a normal school token', peek.json.length === 1 && peek.json[0].last_name === 'InA', peek.json);
  const forged = await call('GET', 'students', null, tA.slice(0, -4) + 'AAAA');
  check('a tampered token is refused (401)', forged.status === 401);
  const noTok = await call('GET', 'students');
  check('no token = refused (401)', noTok.status === 401);
}

// ---------------------------------------------------------------
section('5. Subscription state as the school sees it');
{
  const s = await call('GET', 'subscription', null, tA);
  check('A is on a free trial, 30 days left', s.json.state === 'trialing' && s.json.days_left === 30 && s.json.trial_ends_at === ymd(30), s.json);
  check('A cannot see anyone else’s subscription (own row only)', s.json.school_id === 'st-marys-basic-school');
}

// ---------------------------------------------------------------
section('6. Developer-only controls — a school can NOT reach them');
for (const [m, route, body] of [
  ['GET', 'schools/list'], ['POST', 'provision', { name: 'Hack' }], ['POST', 'suspend', { school_id: 'bright-future-academy', status: 'suspended' }],
  ['POST', 'trial', { school_id: 'st-marys-basic-school', days: 999 }], ['POST', 'plan', { school_id: 'st-marys-basic-school', plan: 'premium' }],
  ['POST', 'platform/payment', { school_id: 'st-marys-basic-school', days: 365 }], ['POST', 'platform/note', { school_id: 'x', note: 'x' }],
  ['POST', 'platform/details', { school_id: 'bright-future-academy', name: 'Hijacked School' }],
  ['POST', 'platform/password', { school_id: 'bright-future-academy' }], ['POST', 'reset', { school_id: 'bright-future-academy' }],
  ['POST', 'impersonate', { school_id: 'bright-future-academy' }], ['GET', 'platform/audit'], ['GET', 'platform/users', null],
]) {
  const r = await call(m, route, body, tA, route === 'platform/users' ? { school: 'bright-future-academy' } : undefined);
  check(`school Admin → ${m} ${route} is refused (403)`, r.status === 403, r.status);
}
{
  // Uses its own throwaway school (D) because an import replaces a school's whole dataset.
  const tImp = sd.json.token;
  await call('PUT', 'singleton/license', { trial_ends_at: '2099-01-01', trial_days: 9999 }, tImp);
  const s = await call('GET', 'subscription', null, tImp);
  check('a school editing its own “license” data cannot extend its trial', s.json.days_left === 30, s.json);
  await call('PUT', 'import', { school: { name: 'Hacked' }, meta: { seq: {} }, trial_ends_at: '2099-01-01', paid_until: '2099-01-01', plan: 'premium' }, tImp);
  // (The import replaced this school's accounts, so its old session is now rightly invalid —
  // read the result through the developer's view of the school instead.)
  const devNow = await call('POST', 'auth/login', { username: DEV_USER, password: DEV_PASS });
  const dRow = (await call('GET', 'schools/list', null, devNow.json.token)).json.find(x => x.id === 'tamper-test-school');
  check('a school importing a doctored dataset cannot extend its trial or grant itself a plan', dRow && dRow.days_left === 30 && dRow.trial_ends_at === ymd(30) && dRow.plan === 'basic' && !dRow.paid_until, dRow);
}

// ---------------------------------------------------------------
section('7. The developer console');
let dev;
{
  const bad = await call('POST', 'auth/login', { username: DEV_USER, password: 'wrong' });
  check('wrong developer password refused', bad.status === 401);
  dev = await call('POST', 'auth/login', { username: DEV_USER, password: DEV_PASS });
  check('developer can sign in', dev.status === 200 && dev.json.role === 'Platform', dev);
}
const tD = dev.json.token;
{
  const list = await call('GET', 'schools/list', null, tD);
  const a = list.json.find(s => s.id === 'st-marys-basic-school');
  check('developer sees all schools', list.status === 200 && list.json.length >= 3, list.json && list.json.length);
  check('developer sees the contact details captured at signup', a && a.email === 'head@stmarys.example' && a.phone === '+233241234567' && a.contact_name === 'Ama Mensah' && a.created_via === 'self-signup', a);
  check('list shows state + days left', a && a.state === 'trialing' && a.days_left === 30);

  let r = await call('POST', 'trial', { school_id: 'st-marys-basic-school', days: 30 }, tD);
  check('developer: +1 month trial extension → 60 days', r.json.subscription.days_left === 60 && r.json.subscription.state === 'trialing', r.json);
  r = await call('POST', 'trial', { school_id: 'st-marys-basic-school', trial_ends_at: ymd(10) }, tD);
  check('developer: set exact trial end date', r.json.subscription.days_left === 10, r.json);
  r = await call('POST', 'trial', { school_id: 'st-marys-basic-school', days: 0 }, tD);
  check('developer: invalid extension (0 days) refused', r.status === 400);

  r = await call('POST', 'platform/payment', { school_id: 'st-marys-basic-school', plan: 'growth', days: 120, amount: 1200, note: 'Term 1 by MoMo ref 555' }, tD);
  check('developer: record a payment → paid, plan Growth, 120 days', r.json.subscription.state === 'active' && r.json.subscription.plan === 'growth' && r.json.subscription.days_left === 120 && r.json.subscription.trial_ends_at === null, r.json);
  r = await call('POST', 'platform/payment', { school_id: 'st-marys-basic-school', days: 120 }, tD);
  check('developer: renewing early STACKS onto the paid period (240 days)', r.json.subscription.days_left === 240, r.json.subscription);
  r = await call('POST', 'platform/payment', { school_id: 'st-marys-basic-school', paid_until: ymd(-3) }, tD);
  check('developer: a paid-until date in the past is refused', r.status === 400);
  r = await call('POST', 'platform/payment', { school_id: 'st-marys-basic-school', plan: 'gold', days: 30 }, tD);
  check('developer: unknown plan refused', r.status === 400);
  const sub = await call('GET', 'subscription', null, tA);
  check('the school sees the payment (Growth, active, ~240 days)', sub.json.state === 'active' && sub.json.plan === 'growth' && sub.json.days_left === 240, sub.json);

  r = await call('POST', 'platform/note', { school_id: 'bright-future-academy', note: 'Called 3 Oct — wants Basic plan' }, tD);
  const l2 = await call('GET', 'schools/list', null, tD);
  check('developer: private note saved and listed', r.json.ok && l2.json.find(s => s.id === 'bright-future-academy').notes.startsWith('Called 3 Oct'));

  const aud = await call('GET', 'platform/audit', null, tD, { limit: 100 });
  const actions = aud.json.map(x => x.action);
  check('every action is in the audit log (signup, trial, payment, note)', ['signup', 'trial', 'payment', 'note'].every(a => actions.includes(a)), actions);
  const pay = aud.json.find(x => x.action === 'payment' && x.detail && x.detail.amount === 1200);
  check('audit keeps the payment amount + reference', pay && pay.detail.amount === 1200 && /MoMo/.test(pay.detail.note), pay);
}

// ---------------------------------------------------------------
section('8. Suspend, expiry and the server-side read-only lock');
{
  // C: suspend
  let r = await call('POST', 'suspend', { school_id: 'bright-future-academy', status: 'suspended' }, tD);
  const login = await call('POST', 'auth/login', { username: 'admin', password: 'Sunrise-2026!', school_id: 'bright-future-academy' });
  check('suspended school cannot sign in (403)', login.status === 403, login);
  const api = await call('GET', 'students', null, tC);
  check('…and its existing session stops working too (403)', api.status === 403, api);
  await call('POST', 'suspend', { school_id: 'bright-future-academy', status: 'active' }, tD);
  const back = await call('GET', 'students', null, tC);
  check('reactivated school works again', back.status === 200);

  // B: expire the trial
  await call('POST', 'trial', { school_id: 'st-marys-basic-school-2', trial_ends_at: ymd(-1) }, tD);
  const sub = await call('GET', 'subscription', null, tB);
  check('trial in the past → state "expired"', sub.json.state === 'expired' && sub.json.days_left === -1, sub.json);
  const w1 = await call('POST', 'students', { first_name: 'New', last_name: 'Pupil' }, tB);
  check('EXPIRED school cannot add data (403) — enforced by the server, not just the screen', w1.status === 403 && /ended/.test(w1.json.error), w1);
  const w2 = await call('PUT', 'singleton/school', { name: 'x' }, tB);
  const w3 = await call('DELETE', 'students/stu-shared-id', null, tB);
  check('…nor change settings or delete (403)', w2.status === 403 && w3.status === 403);
  const rd = await call('GET', 'students', null, tB);
  const ex = await call('GET', 'export', null, tB);
  check('…but can still READ and EXPORT its data', rd.status === 200 && rd.json.length === 1 && ex.status === 200);
  const login2 = await call('POST', 'auth/login', { username: 'admin', password: 'Sunrise-2026!', school_id: 'st-marys-basic-school-2' });
  check('…and can still sign in', login2.status === 200);
  const devWrite = await call('POST', 'students', { id: 'dev-added', first_name: 'Dev', last_name: 'Added' }, tD, { school: 'st-marys-basic-school-2' });
  check('developer can still write for support while a school is expired', devWrite.status === 201, devWrite);
  // developer renews → unlocked
  await call('POST', 'platform/payment', { school_id: 'st-marys-basic-school-2', plan: 'basic', days: 120 }, tD);
  const w4 = await call('POST', 'students', { first_name: 'After', last_name: 'Payment' }, tB);
  check('after the developer records a payment the school is editable again', w4.status === 201, w4);
  // A paid period that has run out must lock by itself. The developer API refuses to
  // set a past date on purpose, so this check edits its throwaway test database directly.
  if ((process.env.PHP_BIN && process.env.SQLITE_DB) || process.env.MYSQL_CMD) {
    const { execFileSync } = await import('node:child_process');
    if (process.env.MYSQL_CMD) {
      // MySQL/MariaDB test database: MYSQL_CMD = path to the mysql client; MYSQL_ARGS = "-uroot -h127.0.0.1 -P3307 dbname"
      execFileSync(process.env.MYSQL_CMD, [...process.env.MYSQL_ARGS.split(' '), '-e', `UPDATE schools SET paid_until='${ymd(-2)}' WHERE id='st-marys-basic-school-2'`]);
    } else {
      execFileSync(process.env.PHP_BIN, ['-r', `$p=new PDO('sqlite:'.getenv('SQLITE_DB'));$p->prepare('UPDATE schools SET paid_until=? WHERE id=?')->execute(['${ymd(-2)}','st-marys-basic-school-2']);`], { env: { ...process.env } });
    }
    const lapsed = await call('GET', 'subscription', null, tB);
    const wl = await call('POST', 'students', { first_name: 'Late', last_name: 'Payer' }, tB);
    check('a PAID period that has run out locks automatically (read-only) — nobody has to remember', lapsed.json.state === 'expired' && wl.status === 403, [lapsed.json, wl.status]);
  } else { console.log('  skip paid-period-lapse check (set PHP_BIN and SQLITE_DB to run it)'); }
}

// ---------------------------------------------------------------
section('9. Roles inside one school (no privilege escalation)');
{
  // Admin A creates a Teacher and a Parent
  const mk = async (name, username, role) => {
    const salt = 'a'.repeat(32);
    // hash is computed client-side in the real app; here we just need ANY known password -> use change-by-platform instead
    return call('POST', 'users', { id: 'u-' + username, name, username, role, staff_id: '', linked_student_ids: [], password_salt: salt, password_hash: 'x'.repeat(64), must_change_password: true }, tA);
  };
  const t = await mk('Teacher One', 'teacher1', 'Teacher');
  check('school Admin can create an account', t.status === 201);
  const reset = await call('POST', 'platform/password', { school_id: 'st-marys-basic-school', user_id: 'u-teacher1' }, tD);
  check('developer issues a one-time temporary password', reset.status === 200 && /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(reset.json.temp_password), reset.json && Object.keys(reset.json));
  const tl = await call('POST', 'auth/login', { username: 'teacher1', password: reset.json.temp_password, school_id: 'st-marys-basic-school' });
  check('the temp password works and forces a change', tl.status === 200 && tl.json.user.must_change_password === true, tl);
  const tT = tl.json.token;
  check('Teacher cannot list accounts (no password hashes leak)', (await call('GET', 'users', null, tT)).status === 403);
  check('Teacher cannot read someone else’s account', (await call('GET', 'users/u-admin', null, tT)).status === 403);
  check('Teacher can read their own account (needed for Change password)', (await call('GET', 'users/u-teacher1', null, tT)).status === 200);
  check('Teacher CANNOT promote themselves to Admin', (await call('PUT', 'users/u-teacher1', { role: 'Admin' }, tT)).status === 403);
  check('Teacher CANNOT create accounts', (await call('POST', 'users', { id: 'u-evil', username: 'evil', role: 'Admin' }, tT)).status === 403);
  check('Teacher CANNOT delete accounts', (await call('DELETE', 'users/u-admin', null, tT)).status === 403);
  check('Teacher can change their own password fields', (await call('PUT', 'users/u-teacher1', { password_salt: 'b'.repeat(32), password_hash: 'c'.repeat(64), must_change_password: false }, tT)).status === 200);
  check('Teacher CANNOT change permissions', (await call('PUT', 'permissions', { replace: [] }, tT)).status === 403);
  check('Teacher CANNOT download the whole-school backup', (await call('GET', 'export', null, tT)).status === 403);
  check('Teacher CANNOT overwrite the school with an import', (await call('PUT', 'import', {}, tT)).status === 403);
  check('Teacher can still do normal work (mark attendance)', (await call('POST', 'attendance', { student_id: 'ST0001', date: ymd(0), status: 'present' }, tT)).status === 201);
  // Staff pay details stay private from Teachers and Parents
  await call('POST', 'staff', { id: 'st-pay-test', staff_id: 'SF0002', name: 'Paid Person', role: 'Teacher', basic_salary: 3000, allowances: 200, payment_method: 'Bank' }, tA);
  const adminStaff = await call('GET', 'staff', null, tA);
  const teacherStaff = await call('GET', 'staff', null, tT);
  const adminRow = adminStaff.json.find(x => x.id === 'st-pay-test'), teacherRow = teacherStaff.json.find(x => x.id === 'st-pay-test');
  check('Admin can see staff salaries', adminRow && adminRow.basic_salary === 3000);
  check('Teacher gets staff names but NOT salaries or bank details', teacherRow && teacherRow.name === 'Paid Person' && teacherRow.basic_salary === undefined && teacherRow.allowances === undefined && teacherRow.payment_method === undefined, teacherRow);
  const oneStaff = await call('GET', 'staff/st-pay-test', null, tT);
  check('…also when a single staff record is requested', oneStaff.json && oneStaff.json.basic_salary === undefined);

  // Parent accounts are view-only on the server too
  await call('POST', 'users', { id: 'u-parent1', name: 'Parent One', username: 'parent1', role: 'Parent', staff_id: '', linked_student_ids: ['ST0001'], password_salt: 'a'.repeat(32), password_hash: 'x'.repeat(64) }, tA);
  const pr = await call('POST', 'platform/password', { school_id: 'st-marys-basic-school', user_id: 'u-parent1' }, tD);
  const pl = await call('POST', 'auth/login', { username: 'parent1', password: pr.json.temp_password, school_id: 'st-marys-basic-school' });
  const tP = pl.json.token;
  check('Parent can read school data (their portal needs it)', (await call('GET', 'students', null, tP)).status === 200);
  check('Parent CANNOT add records', (await call('POST', 'attendance', { student_id: 'ST0001', status: 'absent' }, tP)).status === 403);
  check('Parent CANNOT edit records', (await call('PUT', 'students/stu-shared-id', { last_name: 'Changed' }, tP)).status === 403);
  check('Parent CANNOT delete records', (await call('DELETE', 'students/stu-shared-id', null, tP)).status === 403);
  check('Parent CANNOT change settings', (await call('PUT', 'singleton/school', { name: 'x' }, tP)).status === 403);
  check('Parent can still change their OWN password', (await call('PUT', 'users/u-parent1', { password_salt: 'b'.repeat(32), password_hash: 'c'.repeat(64), must_change_password: false }, tP)).status === 200);
  check('Parent does not see salaries', (await call('GET', 'staff', null, tP)).json.every(x => x.basic_salary === undefined));

  // Disabling or deleting an account ends its open session at once
  check('Teacher session works before being disabled', (await call('GET', 'classes', null, tT)).status === 200);
  await call('POST', 'platform/user', { school_id: 'st-marys-basic-school', user_id: 'u-teacher1', disabled: true }, tD);
  const afterDisable = await call('GET', 'classes', null, tT);
  check('a DISABLED user’s already-open session stops working immediately (401)', afterDisable.status === 401, afterDisable);
  await call('DELETE', 'users/u-parent1', null, tA);
  check('a DELETED user’s already-open session stops working immediately (401)', (await call('GET', 'classes', null, tP)).status === 401);

  // Platform password reset for the Admin ("forgot password")
  const ar = await call('POST', 'platform/password', { school_id: 'st-marys-basic-school' }, tD);
  const oldLogin = await call('POST', 'auth/login', { username: 'admin', password: 'Sunrise-2026!', school_id: 'st-marys-basic-school' });
  const newLogin = await call('POST', 'auth/login', { username: 'admin', password: ar.json.temp_password, school_id: 'st-marys-basic-school' });
  check('“Forgot password”: old password stops working, temp password works', oldLogin.status === 401 && newLogin.status === 200, [oldLogin.status, newLogin.status]);
  const aud = await call('GET', 'platform/audit', null, tD, { limit: 200 });
  check('the temp password is NOT written to the audit log', !JSON.stringify(aud.json).includes(ar.json.temp_password));
}

// ---------------------------------------------------------------
section('10. Developer adds a school by hand; reset');
{
  let r = await call('POST', 'provision', { name: 'Hand Added School', email: 'owner@hand.example', phone: '0244445555', contact_name: 'Yaw Darko' }, tD);
  check('developer can add a school (clean start + one-time password)', r.status === 201 && r.json.temp_password && r.json.username === 'admin', r.json);
  const l = await call('POST', 'auth/login', { username: 'admin', password: r.json.temp_password, school_id: r.json.school_id });
  check('…its Admin can sign in and must change the password', l.status === 200 && l.json.user.must_change_password === true);
  const stu = await call('GET', 'students', null, l.json.token);
  check('…and it has no demo pupils', stu.json.length === 0);
  const dup = await call('POST', 'provision', { name: 'Hand Added Twin', email: 'OWNER@hand.example', contact_name: 'Someone' }, tD);
  check('developer adding a school with an email already in use is refused (409)', dup.status === 409, dup);
  const d = await call('POST', 'provision', { name: 'Demo Sandbox', demo: true }, tD);
  const dl = await call('POST', 'auth/login', { username: 'admin', password: '123', school_id: d.json.school_id });
  check('explicit demo school still available for training (admin / 123)', d.status === 201 && dl.status === 200);
  const delTarget = await call('POST', 'provision', { name: 'Delete Me School', email: 'delete@me.example' }, tD);
  const noConfirm = await call('POST', 'platform/delete', { school_id: delTarget.json.school_id, confirm: 'wrong' }, tD);
  check('deleting a school needs its address typed back (wrong text refused, 400)', noConfirm.status === 400, noConfirm);
  check('a school Admin cannot delete a school (403)', (await call('POST', 'platform/delete', { school_id: delTarget.json.school_id, confirm: delTarget.json.school_id }, tA)).status === 403);
  const doDelete = await call('POST', 'platform/delete', { school_id: delTarget.json.school_id, confirm: delTarget.json.school_id }, tD);
  const afterDel = (await call('GET', 'schools/list', null, tD)).json;
  const loginGone = await call('POST', 'auth/login', { username: 'admin', password: delTarget.json.temp_password, school_id: delTarget.json.school_id });
  const auditDel = (await call('GET', 'platform/audit', null, tD, { limit: 50 })).json.find(x => x.action === 'delete');
  check('developer can permanently delete a school: gone from the list, its login no longer works, and the deletion is logged (name only)',
    doDelete.status === 200 && !afterDel.find(s => s.id === delTarget.json.school_id) && loginGone.status === 401 && auditDel && auditDel.detail.name === 'Delete Me School' && !JSON.stringify(auditDel).includes('delete@me.example'), [doDelete.status, loginGone.status, auditDel]);
  const rs = await call('POST', 'reset', { school_id: 'hand-added-school' }, tD);
  const afterReset = await call('GET', 'schools/list', null, tD);
  const row = afterReset.json.find(s => s.id === 'hand-added-school');
  check('reset wipes data but keeps contact + subscription details', rs.status === 200 && row.email === 'owner@hand.example' && row.state === 'trialing', row);

  // --- developer corrects a school's details ---
  const HID = 'hand-added-school';
  const edit = (b, tok) => call('POST', 'platform/details', { school_id: HID, ...b }, tok || tD);
  const listRow = async () => (await call('GET', 'schools/list', null, tD)).json.find(s => s.id === HID);
  check('a school Admin cannot edit school details (403)', (await edit({ name: 'Mine Now' }, tA)).status === 403);
  check('editing an unknown school → 404', (await call('POST', 'platform/details', { school_id: 'no-such-school', name: 'Nope Academy' }, tD)).status === 404);
  check('details: a name that is too short is refused (400)', (await edit({ name: 'ab' })).status === 400);
  check('details: a bad email is refused (400)', (await edit({ email: 'not-an-email' })).status === 400);
  check('details: a bad phone is refused (400)', (await edit({ phone: '12' })).status === 400);
  check('details: an email already used by another school is refused (409)', (await edit({ email: 'BF@school.example' })).status === 409);
  check('details: a phone already used by another school is refused (409)', (await edit({ phone: '+233 20 555 0002' })).status === 409);
  check('…and none of the refused edits changed anything', (await listRow()).email === 'owner@hand.example', await listRow());

  const adm = await call('POST', 'auth/login', { username: 'admin', password: rs.json.temp_password, school_id: HID });
  r = await edit({ name: 'Hand Added Academy', contact_name: 'Yaw A. Darko', phone: '024 444 6666' });
  let lr = await listRow();
  check('developer can change name, contact person and phone', r.status === 200 && lr.name === 'Hand Added Academy' && lr.contact_name === 'Yaw A. Darko' && lr.phone === '0244446666' && lr.email === 'owner@hand.example', [r.json, lr]);
  check('…the web address stays the same', lr.id === HID);
  let prof = (await call('GET', 'singleton/school', null, adm.json.token)).json;
  check('…the school’s own profile (report-card name/phone) follows when the school had not customised it', prof.name === 'Hand Added Academy' && prof.phone === '0244446666', prof);
  check('…and the school can still sign in', adm.status === 200 && (await call('POST', 'auth/login', { username: 'admin', password: rs.json.temp_password, school_id: HID })).status === 200);

  await call('PUT', 'singleton/school', { ...prof, name: 'Hand Added Report Name' }, adm.json.token);
  await edit({ name: 'Hand Added College' });
  prof = (await call('GET', 'singleton/school', null, adm.json.token)).json;
  check('a profile name the school chose itself is NOT overwritten', prof.name === 'Hand Added Report Name' && (await listRow()).name === 'Hand Added College', prof);

  r = await edit({ email: '' });
  check('developer can clear an email (stored as empty)', r.status === 200 && !(await listRow()).email);
  r = await edit({ email: 'new-owner@hand.example', phone: '0244446666' });
  check('developer can set an email again; re-saving the same phone is not a duplicate', r.status === 200 && (await listRow()).email === 'new-owner@hand.example', r.json);
  r = await edit({ name: 'Hand Added College', phone: '0244446666' });
  check('saving without changes says so', r.status === 200 && r.json.unchanged === true, r.json);
  const detAudit = (await call('GET', 'platform/audit', null, tD, { limit: 100 })).json.filter(x => x.action === 'details' && x.school_id === HID);
  check('every details edit is logged with before/after', detAudit.length >= 3 && detAudit.some(x => x.detail.name && x.detail.name.from === 'Hand Added School' && x.detail.name.to === 'Hand Added Academy'), detAudit.map(x => x.detail));
}

// ---------------------------------------------------------------
section('11. Forgot password: emailed link first, developer as the fallback');
if (!process.env.MAIL_DIR) { console.log('  skip (set MAIL_DIR and run tests/smtp-sink.mjs to test the reset emails)'); }
else {
  const forgot = (school, user) => call('POST', 'auth/forgot', { school_id: school, username: user });
  const reqs = async () => (await call('GET', 'platform/requests', null, tD)).json;
  const m0 = mailbox().length;

  // Same answer for real and made-up accounts: nobody can probe who exists.
  const ghost = await forgot('no-such-school', 'admin');
  const aTeacher = await forgot('st-marys-basic-school', 'teacher1');
  check('asking about a school/account that does not exist gives a friendly answer (no probing)', ghost.status === 200 && ghost.json.ok === true, ghost);
  check('a non-Administrator account (teacher) is never emailed and never queued', aTeacher.status === 200 && mailbox().length === m0 && !(await reqs()).some(r => r.school_id === 'st-marys-basic-school'), aTeacher.json);
  check('missing fields are refused (400)', (await call('POST', 'auth/forgot', { school_id: '', username: '' })).status === 400);

  // School B: the normal, self-service route
  const tB1 = (await call('POST', 'auth/login', { username: 'admin', password: 'Sunrise-2026!', school_id: 'st-marys-basic-school-2' })).json.token;
  const realB = await forgot('st-marys-basic-school-2', 'admin');
  check('Administrator request: same friendly answer as an unknown account', realB.status === 200 && realB.json.message === ghost.json.message, realB.json);
  const mailB = mailbox().slice(m0).pop();
  const linkB = linkIn(mailB);
  check('a reset email goes to the school REGISTERED address', /^To: .*other@school\.example/mi.test(mailB || ''), (mailB || '').slice(0, 200));
  check('the email holds a one-time link on the real site address (zetclass.com) with a 64-character token', !!linkB && linkB.school === 'st-marys-basic-school-2', mailB);
  check('the developer can see the request (email sent)', (await reqs()).some(r => r.school_id === 'st-marys-basic-school-2' && r.email_sent == 1));
  if (dbAvailable()) check('only a fingerprint of the token is stored, never the token itself', dbScalar("SELECT COUNT(*) FROM password_resets WHERE token_hash='" + linkB.token + "'") === '0');

  const wrongTok = await call('POST', 'auth/reset', { school_id: 'st-marys-basic-school-2', token: 'a'.repeat(64), password: 'Fresh-Start-2026!' });
  const junkTok = await call('POST', 'auth/reset', { school_id: 'st-marys-basic-school-2', token: 'not-a-token', password: 'Fresh-Start-2026!' });
  const wrongSchool = await call('POST', 'auth/reset', { school_id: 'bright-future-academy', token: linkB.token, password: 'Fresh-Start-2026!' });
  check('a wrong, malformed, or other-school token is refused (400)', wrongTok.status === 400 && junkTok.status === 400 && wrongSchool.status === 400);
  const weak = await call('POST', 'auth/reset', { school_id: 'st-marys-basic-school-2', token: linkB.token, password: 'short' });
  check('a weak new password is refused with a plain message, and the link is NOT used up', weak.status === 400 && weak.json.fields && weak.json.fields.password, weak.json);
  const done = await call('POST', 'auth/reset', { school_id: 'st-marys-basic-school-2', token: linkB.token, password: 'Fresh-Start-2026!' });
  check('the link sets the new password (200)', done.status === 200 && done.json.ok === true, done.json);
  check('old password stops working', (await call('POST', 'auth/login', { username: 'admin', password: 'Sunrise-2026!', school_id: 'st-marys-basic-school-2' })).status === 401);
  const nowLogin = await call('POST', 'auth/login', { username: 'admin', password: 'Fresh-Start-2026!', school_id: 'st-marys-basic-school-2' });
  check('new password works, with no forced change', nowLogin.status === 200 && nowLogin.json.user.must_change_password === false);
  check('the link cannot be used a second time', (await call('POST', 'auth/reset', { school_id: 'st-marys-basic-school-2', token: linkB.token, password: 'Another-Pass-2026!' })).status === 400);
  check('a session opened BEFORE the reset is signed out', (await call('GET', 'classes', null, tB1)).status === 401);
  check('the new session works', (await call('GET', 'classes', null, nowLogin.json.token)).status === 200);
  check('the finished request leaves the developer list', !(await reqs()).some(r => r.school_id === 'st-marys-basic-school-2'));

  // School C: link expires after an hour -> developer fallback
  await forgot('bright-future-academy', 'admin');
  if (dbAvailable()) {
    const linkC = linkIn(mailbox().pop());
    dbRun('UPDATE password_resets SET expires_at=' + (Math.floor(Date.now() / 1000) - 60) + " WHERE school_id='bright-future-academy'");
    check('an expired link (older than one hour) is refused', (await call('POST', 'auth/reset', { school_id: 'bright-future-academy', token: linkC.token, password: 'Fresh-Start-2026!' })).status === 400);
  }
  const reqC = (await reqs()).find(r => r.school_id === 'bright-future-academy');
  check('the failed/expired request waits in the developer Password help requests list, with phone and school name', reqC && reqC.phone === '+233205550002' && reqC.school_name === 'Bright Future Academy', reqC);
  check('a school Administrator cannot see or clear that list (403)', (await call('GET', 'platform/requests', null, tA)).status === 403 && (await call('POST', 'platform/request', { id: 1 }, tA)).status === 403);
  const help = await call('POST', 'platform/password', { school_id: 'bright-future-academy', user_id: reqC.user_id }, tD);
  const helped = await call('POST', 'auth/login', { username: 'admin', password: help.json.temp_password, school_id: 'bright-future-academy' });
  check('FALLBACK: developer issues a temporary password; the school signs in with it and must change it', help.status === 200 && helped.status === 200 && helped.json.user.must_change_password === true);
  check('...and that request is closed automatically', !(await reqs()).some(r => r.school_id === 'bright-future-academy'));

  // The emailed link must never be built from the visitor's Host header
  const evil = await callWithHost('auth/forgot', { school_id: 'hand-added-school', username: 'admin' }, 'evil.example');
  const evilMail = mailbox().pop();
  check('a forged Host header cannot redirect the emailed link to another website', evil.status === 200 && /https:\/\/zetclass\.com\/reset-password/.test(evilMail || '') && !/evil\.example/.test(evilMail || ''), (evilMail || '').slice(0, 300));
  const evilReq = (await reqs()).find(r => r.school_id === 'hand-added-school');
  await call('POST', 'platform/request', { id: evilReq.id }, tD);
  check('developer can dismiss a request', !(await reqs()).some(r => r.school_id === 'hand-added-school'));

  // Throttle
  let last, hit429 = false;
  for (let i = 0; i < 10 && !hit429; i++) { last = await forgot('ghost-' + i, 'admin'); hit429 = last.status === 429; }
  check('too many reset requests from one connection are paused (429)', hit429, last && last.status);

  const aud = (await call('GET', 'platform/audit', null, tD, { limit: 300 })).json.map(x => x.action);
  check('requests and completed resets appear in the activity log', aud.includes('password_request') && aud.includes('password_reset_self'), aud.slice(0, 12));
}

section('12. Brute-force and signup flood protection');
{
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', 'auth/login', { username: 'admin', password: 'wrong-' + i, school_id: 'bright-future-academy' });
  check('after 8 wrong passwords sign-in is paused (429)', last.status === 429, last);
  const stillBad = await call('POST', 'auth/login', { username: 'admin', password: 'Sunrise-2026!', school_id: 'bright-future-academy' });
  check('…even the right password waits out the pause', stillBad.status === 429);
  let r; let created = 0;
  for (let i = 0; i < 8; i++) {
    r = await call('POST', 'register', good({ school: 'Flood School ' + i, email: `flood${i}@x.example`, phone: `+23320111${i}0` }));
    if (r.status === 201) created++;
  }
  check('signup flood is cut off (limit per address per hour)', created <= 5 && r.status === 429, { created, last: r.status });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
