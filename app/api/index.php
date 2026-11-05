<?php
/* ============================================================
 * index.php — REST front controller for the Zetclass API.
 * Mirrors the front-end data-access layer (store.js -> ApiAdapter).
 *
 * SECURITY MODEL (multi-tenant):
 *   - POST ?r=auth/login is the ONLY public route. It verifies the
 *     username/password against that school's users and returns a
 *     signed token carrying the school id + role.
 *   - Every other route requires  Authorization: Bearer <token>.
 *   - The active school is taken FROM THE TOKEN only — never from the
 *     request body or query. Every read/write is filtered by it, and
 *     every write is stamped with it. A client cannot touch, name, or
 *     overwrite another school's data.
 *   - Subscription/trial state is SERVER-AUTHORITATIVE: it lives on the
 *     schools row and is only ever changed through the platform routes
 *     below. A school cannot extend its own trial by editing anything
 *     it controls (browser storage, its own singletons, etc.).
 *   - EVERY platform (owner) route appends a row to platform_audit.
 *
 * Routes (via ?r=...):
 *   POST   ?r=auth/login   {username,password[,school_id]}  -> {token,...}
 *   POST   ?r=register     {school_name,email,phone,password,accept_terms[,contact_name]}
 *                          PUBLIC self-service signup: creates the school on a
 *                          free trial + its Admin login, returns a session token
 *   GET    ?r={collection}                 list   (this school)
 *   GET    ?r={collection}/{id}            get one
 *   POST   ?r={collection}                 insert/upsert (JSON body)
 *   PUT    ?r={collection}/{id}            update (partial)
 *   DELETE ?r={collection}/{id}            remove
 *   PUT    ?r={collection}  {replace:[]}   replace this school's collection
 *   GET    ?r=singleton/{name}             get singleton
 *   PUT    ?r=singleton/{name}             set singleton
 *   POST   ?r=seq/{kind}                   next sequence number
 *   GET    ?r=export                       this school's full dataset
 *   PUT    ?r=import      {...}            replace this school's full dataset
 *   POST   ?r=pay        {amount,...}      mock payment (test mode)
 *   POST   ?r=sms        {to,body}         mock SMS (test mode)
 *   GET    ?r=subscription                 this school's licence state
 *                                          (read-only; server-computed)
 *   -- platform super-admin only --
 *   GET    ?r=schools/list                 list schools + user counts
 *   POST   ?r=provision   {school_id,name} create + seed a new school
 *   POST   ?r=suspend     {school_id,status} set a school's status
 *   POST   ?r=trial       {school_id, days | trial_ends_at | clear}
 *                                          extend / set / end the free trial
 *   POST   ?r=plan        {school_id,plan} change subscription tier
 *   POST   ?r=platform/payment {school_id,plan,days|paid_until[,amount,note]}
 *                                          record a payment / renew a subscription
 *   POST   ?r=platform/note {school_id,note}   developer's private note
 *   POST   ?r=platform/password {school_id,user_id}  issue a one-time temp password
 *   POST   ?r=reset       {school_id}      wipe one school back to a clean start
 *   POST   ?r=impersonate {school_id}      short-lived Admin token (logged)
 *   GET    ?r=platform/users?school=<id>   list one school's login accounts
 *   POST   ?r=platform/user {school_id,user_id,disabled}
 *                                          enable/disable one account
 *   GET    ?r=platform/audit[?school=<id>&limit=N]   read the audit log
 * ============================================================ */

// Never print PHP warnings/notices into the JSON the app is parsing (and never
// leak file paths); real faults go to the server's error log instead.
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
// Authenticated data must never be stored by a browser/proxy cache.
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
$cfg = require __DIR__ . '/config.php';

// The app and this API share one address (zetclass.com), so browsers need NO
// cross-site permission and none is given by default. Only if the app is ever
// served from a different address, set CORS_ORIGIN in config.local.php to that
// one exact address (e.g. https://app.example.com) — never '*'.
if (!empty($cfg['CORS_ORIGIN']) && $cfg['CORS_ORIGIN'] !== '*') {
    header('Access-Control-Allow-Origin: ' . $cfg['CORS_ORIGIN']);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/services-stub.php';

// Some shared hosts ship PHP without the mbstring extension. Signup uses these two
// functions, so provide a plain fallback rather than crashing with a fatal error.
if (!function_exists('mb_strlen'))  { function mb_strlen($s) { return strlen(utf8_decode((string)$s)); } }
if (!function_exists('mb_substr'))  { function mb_substr($s, $start, $len = null) { return $len === null ? substr((string)$s, $start) : substr((string)$s, $start, $len); } }

function out($data, $code = 200) { http_response_code($code); echo json_encode($data); exit; }
function body() {
    $raw = file_get_contents('php://input', false, null, 0, 8000000); // 8 MB cap (a full-school import is the largest legit body)
    if (!$raw) { return []; }
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

/* ---- request helpers ---- */
function client_ip() {
    // REMOTE_ADDR is the only value a visitor cannot forge. (If the site is
    // ever put behind a proxy/CDN, map its real-IP header here deliberately.)
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

/* Fixed-window throttle. Returns false once $key has been hit more than $max
 * times inside the current $windowSec window. Used for login + signup so a
 * script cannot guess passwords or mass-create trial schools. */
function rate_limit($pdo, $key, $max, $windowSec) {
    $key = substr($key, 0, 120);
    $now = time();
    try {
        $st = $pdo->prepare("SELECT window_start, hits FROM rate_limits WHERE k=?");
        $st->execute([$key]);
        $row = $st->fetch();
        if (!$row || ($now - (int)$row['window_start']) >= $windowSec) {
            $pdo->prepare("REPLACE INTO rate_limits(k,window_start,hits) VALUES(?,?,1)")->execute([$key, $now]);
            return true;
        }
        if ((int)$row['hits'] >= $max) { return false; }
        $pdo->prepare("UPDATE rate_limits SET hits = hits + 1 WHERE k=?")->execute([$key]);
        return true;
    } catch (Throwable $e) { return true; } // never lock everyone out because the throttle table failed
}
function rate_limit_peek($pdo, $key, $max, $windowSec) {
    try {
        $st = $pdo->prepare("SELECT window_start, hits FROM rate_limits WHERE k=?");
        $st->execute([substr($key, 0, 120)]);
        $row = $st->fetch();
        return !($row && (time() - (int)$row['window_start']) < $windowSec && (int)$row['hits'] >= $max);
    } catch (Throwable $e) { return true; }
}
function rate_limit_clear($pdo, $key) {
    try { $pdo->prepare("DELETE FROM rate_limits WHERE k=?")->execute([substr($key, 0, 120)]); } catch (Throwable $e) {}
}

/* ---- signup field validation ----
 * Each returns [cleanValue, errorMessageOrNull]. Messages are written for a
 * school secretary, not a programmer: say what to fix. */
function clean_text($s, $max) {
    $s = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string)$s);
    $s = trim(preg_replace('/\s+/u', ' ', $s));
    return mb_substr($s, 0, $max);
}
function valid_school_name($raw) {
    $v = clean_text($raw, 120);
    if (mb_strlen($v) < 3) { return [$v, 'Please enter your school’s full name.']; }
    if (!preg_match('/\p{L}/u', $v)) { return [$v, 'The school name must contain letters.']; }
    if (preg_match('/[<>]/', $v)) { return [$v, 'The school name cannot contain < or >.']; }
    return [$v, null];
}
function valid_person_name($raw) {
    $v = clean_text($raw, 80);
    if (mb_strlen($v) < 2) { return [$v, 'Please enter your full name.']; }
    if (preg_match('/[<>]/', $v)) { return [$v, 'Your name cannot contain < or >.']; }
    return [$v, null];
}
function valid_email_addr($raw) {
    $v = strtolower(trim((string)$raw));
    if ($v === '' || strlen($v) > 160 || !filter_var($v, FILTER_VALIDATE_EMAIL)) {
        return [$v, 'Please enter a valid email address, like name@example.com.'];
    }
    return [$v, null];
}
function valid_phone_no($raw, $needCountryCode = false) {
    // Keep a leading +, drop spaces/dashes/brackets/dots; 9-15 digits (E.164 range).
    // Public signup passes $needCountryCode: the number must start with + and a
    // country code (which never begins with 0), e.g. +233 24 123 4567.
    $v = trim((string)$raw);
    $plus = (strpos($v, '+') === 0) ? '+' : '';
    $digits = preg_replace('/\D+/', '', $v);
    if ($needCountryCode && ($plus === '' || substr($digits, 0, 1) === '0')) {
        return [$v, 'Please include your country code, for example +233 24 123 4567.'];
    }
    if (strlen($digits) < 9 || strlen($digits) > 15) {
        return [$v, 'Please enter a valid phone number, for example 024 123 4567 or +233 24 123 4567.'];
    }
    return [$plus . $digits, null];
}
/* Optional location details a school can give: country (required at public signup), WhatsApp number,
 * region, district, locality / area and postal address. Returns [values, errors]; empty optional values
 * are simply ''. $b is the request body. Text is cleaned (tags/control characters removed, length capped). */
function valid_school_extras($b, $needCountry = false) {
    $v = ['country' => '', 'whatsapp' => '', 'region' => '', 'district' => '', 'locality' => '', 'postal_address' => '', 'website' => ''];
    $err = [];
    $v['country'] = clean_text($b['country'] ?? '', 60);
    if ($needCountry && mb_strlen($v['country']) < 2) { $err['country'] = 'Please choose your country.'; }
    if (trim((string)($b['whatsapp'] ?? '')) !== '') {
        list($w, $e) = valid_phone_no($b['whatsapp'], true);
        if ($e) { $err['whatsapp'] = 'Please check the WhatsApp number (or leave it empty).'; } else { $v['whatsapp'] = $w; }
    }
    // Website (optional): a plain address like www.school.edu.gh or https://school.edu.gh. https:// is added when missing.
    $site = trim((string)($b['website'] ?? ''));
    if ($site !== '') {
        $withScheme = preg_match('#^https?://#i', $site) ? $site : 'https://' . $site;
        $host = parse_url($withScheme, PHP_URL_HOST);
        if (strlen($withScheme) > 200 || preg_match('/[\s<>"\']/', $withScheme) || !$host || strpos($host, '.') === false) { $err['website'] = 'Please check the website address (for example www.myschool.edu.gh), or leave it empty.'; }
        else { $v['website'] = $withScheme; }
    }
    foreach (['region' => 80, 'district' => 80, 'locality' => 120, 'postal_address' => 200] as $k => $max) {
        $t = clean_text($b[$k] ?? '', $max);
        if (preg_match('/[<>]/', $t)) { $err[$k] = 'Please remove the < and > characters.'; } else { $v[$k] = $t; }
    }
    return [$v, $err];
}
/* One-time password the developer hands to a school (new school, reset, or
 * "forgot password"). Ambiguous characters (0/O, 1/l/I) are left out so it can
 * be read over the phone or WhatsApp. The school is forced to change it at
 * first sign-in. */
function temp_password() {
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    $s = '';
    for ($i = 0; $i < 10; $i++) { $s .= $alphabet[random_int(0, strlen($alphabet) - 1)]; }
    return substr($s, 0, 5) . '-' . substr($s, 5);
}
function valid_new_password($raw, $email, $schoolName) {
    $p = (string)$raw;
    // A weak password does NOT stop a registration: the sign-up page shows a short tip on how to
    // make it stronger instead. Only an absolute floor remains (not blank / not trivially short).
    if (strlen($p) < 8)   { return [$p, 'Your password needs at least 8 characters.']; }
    if (strlen($p) > 128) { return [$p, 'Your password is too long (128 characters at most).']; }
    return [$p, null];
}

/* ---- Reserved school-slug guard ---------------------------------------
 * A school's id is used directly in its public URL (zetclass.com/<id>, no
 * /school/ prefix), so it must never collide with a real top-level route —
 * kept in sync with app/js/app.js's RESERVED_SLUGS for the same reason (see
 * that file's comment). Add new reserved words to BOTH lists. Format is
 * restricted to lowercase letters/digits/hyphens so URLs stay clean. */
$RESERVED_SLUGS = [
    'admin', 'school', 'api', 'app', 'login', 'logout', 'signup', 'register', 'forgot-password', 'reset-password',
    'pricing', 'about', 'contact', 'help', 'support', 'www', 'blog', 'terms',
    'privacy', 'docs', 'status', 'assets', 'static',
];
function valid_school_slug($sid, $reserved) {
    if (!preg_match('/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/', $sid)) { return false; }
    return !in_array(strtolower($sid), $reserved, true);
}

/* Derives a URL slug from a school's display name when the caller leaves
 * school_id blank — lowercase, hyphens between words, truncated at a whole
 * word so long names stay readable. Mirrors slugify() in app/js/platform.js
 * (the operator's live "Add school" preview); this copy is what actually
 * runs when a caller omits school_id (or bypasses the UI and calls the API
 * directly), so it must stay in sync with that one. */
/* Is this school name already used by another school? (Compared by school_name_key(), so capitals,
 * spaces and punctuation do not matter.) $exceptId lets a school keep or re-save its own name. */
function school_name_taken($pdo, $name, $exceptId = null) {
    $st = $pdo->prepare("SELECT id FROM schools WHERE name_key=?");
    $st->execute([school_name_key($name)]);
    foreach ($st->fetchAll() as $r) { if ($exceptId === null || $r['id'] !== $exceptId) { return $r['id']; } }
    return null;
}
function school_name_taken_msg($name) {
    return 'A school called “' . $name . '” is already registered on Zetclass. If it is yours, sign in instead. '
         . 'If it is a different school, add your town or area to the name, for example “' . $name . ', Kumasi”.';
}

function slugify_school_name($name, $maxLen = 40) {
    $s = strtolower((string)$name);
    $s = str_replace(["'", "\xE2\x80\x99"], '', $s); // apostrophes (incl. UTF-8 curly ’)
    $s = preg_replace('/[^a-z0-9]+/', '-', $s);
    $s = trim($s, '-');
    if ($s === '') { return 'school'; }
    if (strlen($s) > $maxLen) {
        $cut = substr($s, 0, $maxLen);
        $cut = preg_replace('/-[^-]*$/', '', $cut);
        $cut = rtrim($cut, '-');
        $s = $cut !== '' ? $cut : substr($s, 0, $maxLen);
    }
    return $s;
}

/* ---- Owner-plane audit trail ----------------------------------------------
 * Appends one row per privileged action. Returns false if the write failed;
 * callers surface that as "audit": false in their response rather than
 * swallowing it, so an unlogged privileged action is visible instead of
 * silent. (Failing the whole action on a log error would let a broken audit
 * table lock the owner out of their own console, which is worse.) */
function audit($pdo, $claims, $action, $schoolId = null, $targetId = null, $detail = null) {
    try {
        $pdo->prepare("INSERT INTO platform_audit(platform_uid,action,school_id,target_id,detail,created_at) VALUES(?,?,?,?,?,?)")
            ->execute([
                $claims['uid'] ?? 'platform',
                $action,
                $schoolId,
                $targetId,
                $detail === null ? null : json_encode($detail),
                gmdate('c'),
            ]);
        return true;
    } catch (Throwable $e) {
        return false;
    }
}

/* ---- Subscription state (server is the source of truth) -------------------
 * Derived purely from the schools registry row, in this order:
 *   1. status is not active/trial/grace          -> 'suspended'
 *   2. paid_until is set (a paid subscription)   -> 'active' until that date,
 *                                                   then 'expired' (read-only)
 *   3. trial_ends_at is set (free trial)         -> 'trialing' until that date,
 *                                                   then 'expired' (read-only)
 *   4. neither set                               -> 'active' (no end date;
 *                                                   e.g. a legacy install)
 * Dates are plain YYYY-MM-DD compared in UTC so the answer does not drift with
 * the caller's timezone. days_left counts down to whichever end date applies. */
function days_until($ymd) {
    return (int)floor((strtotime($ymd . ' 00:00:00 UTC') - strtotime(gmdate('Y-m-d') . ' 00:00:00 UTC')) / 86400);
}
function subscription_state($row) {
    $status    = $row['status'] ?? 'active';
    $trialEnds = $row['trial_ends_at'] ?? null;
    $paidUntil = $row['paid_until'] ?? null;
    $daysLeft  = null;
    $state     = 'active';
    if (!in_array($status, ['active', 'trial', 'grace'], true)) {
        $state = 'suspended';
    } elseif ($paidUntil) {
        $daysLeft = days_until($paidUntil);
        $state = $daysLeft >= 0 ? 'active' : 'expired';
    } elseif ($trialEnds) {
        $daysLeft = days_until($trialEnds);
        $state = $daysLeft >= 0 ? 'trialing' : 'expired';
    }
    return [
        'school_id'     => $row['id'] ?? null,
        'name'          => $row['name'] ?? '',
        'status'        => $status,
        'plan'          => $row['plan'] ?? null,
        'trial_ends_at' => $trialEnds,
        'paid_until'    => $paidUntil,
        'state'         => $state,
        'days_left'     => $daysLeft,
        'source'        => 'server',
        // Ownership check: the school's own licence number, and whether the owner has verified it.
        'verified'      => !empty($row['verified_at']),
        'verified_at'   => $row['verified_at'] ?? null,
        'licence_no'    => $row['licence_no'] ?? null,
    ];
}

try {
    $pdo = db_connect($cfg);
} catch (Throwable $e) {
    // The real reason (which can include host/user names) goes to the server's
    // error log — never to the visitor.
    error_log('Zetclass DB connection failed: ' . $e->getMessage());
    out(['error' => 'The service is temporarily unavailable. Please try again in a few minutes.'], 503);
}

$method = $_SERVER['REQUEST_METHOD'];
$r = isset($_GET['r']) ? trim($_GET['r'], '/') : '';
$parts = $r === '' ? [] : explode('/', $r);
$head = $parts[0] ?? '';
$arg  = $parts[1] ?? null;

/* ============================================================
 * PUBLIC: login
 * ============================================================ */
if ($head === 'auth' && $arg === 'login' && $method === 'POST') {
    if ($cfg['APP_SECRET'] === 'CHANGE_ME_APP_SECRET_PLACEHOLDER') {
        out(['error' => 'Server not configured: APP_SECRET is unset'], 500);
    }
    $b = body();
    $username = isset($b['username']) ? (string)$b['username'] : '';
    $password = isset($b['password']) ? (string)$b['password'] : '';
    $school   = !empty($b['school_id']) ? strtolower(trim((string)$b['school_id'])) : $cfg['SCHOOL_ID'];

    // Brute-force guard: after 8 wrong guesses for the same account from the
    // same address (or 40 from one address overall) in 15 minutes, stop
    // answering until the window passes. A correct login clears the counter.
    $ip = client_ip();
    $acctKey = 'login:' . $ip . ':' . strtolower($school . '/' . $username);
    $ipKey   = 'loginip:' . $ip;
    if (!rate_limit_peek($pdo, $acctKey, 8, 900) || !rate_limit_peek($pdo, $ipKey, 40, 900)) {
        out(['error' => 'Too many sign-in attempts. Please wait 15 minutes and try again.'], 429);
    }

    // Platform super-admin (cross-school), if configured.
    $pa = $cfg['PLATFORM_ADMIN'];
    if (!empty($pa['username']) && strtolower($username) === strtolower($pa['username'])) {
        if (auth_verify_password($password, $pa['salt'], $pa['hash'])) {
            rate_limit_clear($pdo, $acctKey);
            $tok = token_issue($cfg['APP_SECRET'], ['sid' => null, 'uid' => 'platform', 'role' => 'Platform', 'plat' => true], $cfg['TOKEN_TTL']);
            out(['token' => $tok, 'role' => 'Platform', 'school_id' => null]);
        }
        rate_limit($pdo, $acctKey, 8, 900); rate_limit($pdo, $ipKey, 40, 900);
        out(['error' => 'Invalid credentials'], 401);
    }

    $u = find_user($pdo, $school, $username);
    if (!$u || !auth_verify_password($password, $u['password_salt'] ?? '', $u['password_hash'] ?? '')) {
        rate_limit($pdo, $acctKey, 8, 900); rate_limit($pdo, $ipKey, 40, 900);
        out(['error' => 'Invalid credentials'], 401);
    }
    rate_limit_clear($pdo, $acctKey);
    // Checked only AFTER the password verifies, so this never reveals whether
    // a given username exists to someone who cannot already authenticate.
    if (!empty($u['disabled'])) {
        out(['error' => 'This account has been disabled. Please contact your school administrator.'], 403);
    }
    if (!school_active($pdo, $school)) {
        out(['error' => 'This school\'s subscription is inactive. Please contact the administrator.'], 403);
    }
    $tok = token_issue($cfg['APP_SECRET'], [
        'sid'  => $school,
        'uid'  => $u['id'],
        'role' => $u['role'] ?? '',
        'plat' => false,
    ], $cfg['TOKEN_TTL']);
    out([
        'token'     => $tok,
        'role'      => $u['role'] ?? '',
        'school_id' => $school,
        // Non-secret profile the front-end needs to render the session.
        'user' => [
            'id'                   => $u['id'],
            'name'                 => $u['name'] ?? '',
            'username'             => $u['username'] ?? '',
            'role'                 => $u['role'] ?? '',
            'staff_id'             => $u['staff_id'] ?? null,
            'class_ids'            => $u['class_ids'] ?? [],
            'linked_student_ids'   => $u['linked_student_ids'] ?? [],
            'must_change_password' => !empty($u['must_change_password']),
        ],
    ]);
}

/* ============================================================
 * PUBLIC: "forgot my password" (school Administrators)
 *
 *   POST ?r=auth/forgot {school_id, username}
 *     Emails a one-hour, single-use reset link to the school's REGISTERED email.
 *     The answer is always the same ("if that account exists...") so nobody can
 *     use this to find out which schools or usernames exist. Every Administrator
 *     request is also queued in the developer console, so if the email never
 *     arrives (or no email is on file) the developer can verify the school by
 *     phone and issue a temporary password.
 *   POST ?r=auth/reset {school_id, token, password}
 *     Sets the new password if the link is valid, unused and unexpired.
 *
 * Teachers, staff and parents have no email on file: they ask their own school
 * Administrator (Settings > Access Control > Reset password).
 * ============================================================ */
if ($head === 'auth' && $arg === 'forgot' && $method === 'POST') {
    if ($cfg['APP_SECRET'] === 'CHANGE_ME_APP_SECRET_PLACEHOLDER') {
        out(['error' => 'Server not configured: APP_SECRET is unset'], 500);
    }
    $b = body();
    $school   = strtolower(trim((string)($b['school_id'] ?? '')));
    $username = trim((string)($b['username'] ?? ''));
    if ($school === '' || $username === '') { out(['error' => 'Please enter your school address and username.'], 400); }
    $ip = client_ip();
    if (!rate_limit($pdo, 'forgot:' . $ip, 6, 3600)) {
        out(['error' => 'Too many reset requests from this connection. Please try again in an hour, or contact us.'], 429);
    }
    $generic = ['ok' => true, 'message' => 'If that is a school Administrator account, a reset link has been sent to the school\'s registered email address. It works for one hour.'];
    // A given account can only be targeted 3 times an hour (stops someone flooding the owner's inbox).
    if (!rate_limit($pdo, 'forgotacct:' . $school . '/' . strtolower($username), 3, 3600)) { out($generic); }

    $u = find_user($pdo, $school, $username);
    $reg = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $reg->execute([$school]);
    $sch = $reg->fetch();
    if ($u && $sch && ($u['role'] ?? '') === 'Admin' && empty($u['disabled']) && school_active($pdo, $school)) {
        $token = bin2hex(random_bytes(32));
        $emailSent = 0;
        // Replace any older open request for this account, so only the newest link works.
        $pdo->prepare("UPDATE password_resets SET status='handled' WHERE school_id=? AND user_id=? AND status='open'")->execute([$school, $u['id']]);
        $pdo->prepare("INSERT INTO password_resets(school_id,user_id,username,token_hash,expires_at,requested_at,email_sent,status) VALUES(?,?,?,?,?,?,0,'open')")
            ->execute([$school, $u['id'], $u['username'] ?? $username, hash('sha256', $token), time() + 3600, gmdate('c')]);
        $rid = (int)$pdo->lastInsertId();
        if (!empty($sch['email'])) {
            $link = rtrim($cfg['BASE_URL'], '/') . '/reset-password?school=' . rawurlencode($school) . '&token=' . $token;
            $name = clean_text($sch['name'] ?? 'your school', 120);
            $msg = "Hello,\n\nSomeone asked to reset the password for the Administrator account of $name on Zetclass.\n\n"
                 . "To choose a new password, open this link (it works once, for one hour):\n$link\n\n"
                 . "If you did not ask for this, you can ignore this email - your password has not changed.\n\n"
                 . "Zetclass\n";
            $headers = 'From: Zetclass <' . $cfg['MAIL_FROM'] . ">\r\nContent-Type: text/plain; charset=utf-8";
            $emailSent = @mail($sch['email'], 'Reset your Zetclass password', $msg, $headers) ? 1 : 0;
            if ($emailSent) { $pdo->prepare("UPDATE password_resets SET email_sent=1 WHERE id=?")->execute([$rid]); }
        }
        audit($pdo, ['uid' => 'self'], 'password_request', $school, $u['id'], ['username' => $u['username'] ?? '', 'email_sent' => (bool)$emailSent]);
    }
    out($generic);
}
if ($head === 'auth' && $arg === 'reset' && $method === 'POST') {
    $b = body();
    $school = strtolower(trim((string)($b['school_id'] ?? '')));
    $token  = trim((string)($b['token'] ?? ''));
    $ip = client_ip();
    if (!rate_limit($pdo, 'resetuse:' . $ip, 15, 3600)) { out(['error' => 'Too many attempts. Please try again later.'], 429); }
    $bad = ['error' => 'This reset link is not valid any more. It may have been used or it may have expired - please ask for a new one.'];
    if ($school === '' || !preg_match('/^[0-9a-f]{64}$/', $token)) { out($bad, 400); }
    $row = $pdo->prepare("SELECT * FROM password_resets WHERE token_hash=? AND school_id=? AND status='open' AND expires_at>=?");
    $row->execute([hash('sha256', $token), $school, time()]);
    $pr = $row->fetch();
    if (!$pr) { out($bad, 400); }

    $ud = $pdo->prepare("SELECT data FROM documents WHERE school_id=? AND collection='users' AND id=?");
    $ud->execute([$school, $pr['user_id']]);
    $urow = $ud->fetch();
    $u = $urow ? json_decode($urow['data'], true) : null;
    if (!is_array($u) || !empty($u['disabled']) || !school_active($pdo, $school)) { out($bad, 400); }

    $sr = $pdo->prepare("SELECT email, name FROM schools WHERE id=?"); $sr->execute([$school]);
    $sinfo = $sr->fetch() ?: [];
    list($newPw, $pwErr) = valid_new_password($b['password'] ?? '', strtolower((string)($sinfo['email'] ?? '')), (string)($sinfo['name'] ?? ''));
    if ($pwErr) { out(['error' => $pwErr, 'fields' => ['password' => $pwErr]], 400); }

    $salt = bin2hex(random_bytes(16));
    $u['password_salt'] = $salt;
    $u['password_hash'] = pbkdf2_hex($newPw, $salt);
    $u['must_change_password'] = false;
    $u['sessions_valid_after'] = microtime(true);      // signs out every session opened before this moment
    $pdo->prepare("UPDATE documents SET data=? WHERE school_id=? AND collection='users' AND id=?")->execute([json_encode($u), $school, $pr['user_id']]);
    $pdo->prepare("UPDATE password_resets SET status='used' WHERE id=?")->execute([$pr['id']]);
    $pdo->prepare("UPDATE password_resets SET status='handled' WHERE school_id=? AND user_id=? AND status='open'")->execute([$school, $pr['user_id']]);
    // A wrong-password lockout should not outlive a successful reset.
    $pdo->prepare("DELETE FROM rate_limits WHERE k LIKE ?")->execute(['login:%:' . $school . '/' . strtolower($u['username'] ?? '')]);
    audit($pdo, ['uid' => 'self'], 'password_reset_self', $school, $pr['user_id'], ['username' => $u['username'] ?? '']);
    out(['ok' => true, 'message' => 'Your password has been changed. You can sign in now.']);
}

/* ============================================================
 * PUBLIC: self-service signup — "create an account and start using it".
 *
 * Required: school name, your name, email, phone, password. On success the
 * school exists on a free trial with ONE login (username "admin") and the
 * response carries a session token, so the browser can go straight into the
 * app. No demo pupils or demo logins are copied in (see db_strip_demo()).
 * Protections: per-address throttle, hidden honeypot field, one trial per
 * email and per phone number, strict field validation, all-or-nothing insert.
 * ============================================================ */
if ($head === 'register' && $method === 'POST') {
    if ($cfg['APP_SECRET'] === 'CHANGE_ME_APP_SECRET_PLACEHOLDER') {
        out(['error' => 'Server not configured: APP_SECRET is unset'], 500);
    }
    if (empty($cfg['SIGNUP_ENABLED'])) {
        out(['error' => 'New sign-ups are closed at the moment. Please contact us to be added.'], 403);
    }
    $ip = client_ip();
    // Typos are fine (30 tries/hour) but only 5 schools per hour / 15 per day per address.
    if (!rate_limit($pdo, 'regtry:' . $ip, 30, 3600)
        || !rate_limit_peek($pdo, 'reg:' . $ip, 5, 3600)
        || !rate_limit_peek($pdo, 'regday:' . $ip, 15, 86400)) {
        out(['error' => 'Too many sign-up attempts from this connection. Please try again later, or contact us.'], 429);
    }

    $b = body();
    // Honeypot: real people never see or fill this field; scripts usually do.
    if (!empty($b['company_website'])) { out(['error' => 'We could not create your account. Please try again.'], 400); }

    list($schoolName, $e1) = valid_school_name($b['school_name'] ?? '');
    // A contact person is OPTIONAL: signup needs only the school's own details (name, email,
    // phone, password). If none is given the Administrator is simply "School Administrator".
    $contactName = ''; $e2 = null;
    if (trim((string)($b['contact_name'] ?? '')) !== '') { list($contactName, $e2) = valid_person_name($b['contact_name']); }
    list($email, $e3)       = valid_email_addr($b['email'] ?? '');
    list($phone, $e4)       = valid_phone_no($b['phone'] ?? '', true);
    list($password, $e5)    = valid_new_password($b['password'] ?? '', $email, $schoolName);
    // The person must accept the Terms of Service and Privacy Notice (app/terms.html, app/privacy.html).
    // The version they accepted is written to the signup record in the activity log.
    $e6 = !empty($b['accept_terms']) ? null : 'Please tick the box to accept the Terms of Service and Privacy Notice.';
    // The person must declare that they own, or are authorised to register, this school.
    // The declaration (with time and connection address) is written to the signup record, as evidence.
    $e7 = !empty($b['confirm_authority']) ? null : 'Please confirm that you are the owner or an authorised representative of this school.';
    list($extras, $extraErrs) = valid_school_extras($b, true);
    $fieldErrors = array_filter(['school_name' => $e1, 'contact_name' => $e2, 'email' => $e3, 'phone' => $e4, 'password' => $e5, 'confirm_authority' => $e7, 'accept_terms' => $e6] + $extraErrs);
    if ($fieldErrors) { out(['error' => 'Please fix the highlighted fields.', 'fields' => $fieldErrors], 400); }

    // One school per NAME: a second "ABC School" (any capitals / spacing / punctuation) is refused.
    if (school_name_taken($pdo, $schoolName)) {
        $m = school_name_taken_msg($schoolName);
        out(['error' => $m, 'fields' => ['school_name' => $m]], 409);
    }

    // One free trial per email / phone number (stops trial-farming). A genuine
    // second campus can ask us to add it by hand from the developer console.
    $dup = $pdo->prepare("SELECT id FROM schools WHERE LOWER(email)=? OR phone=?");
    $dup->execute([$email, $phone]);
    if ($dup->fetch()) {
        out(['error' => 'A school is already registered with this email or phone number. Please sign in, or contact us if you need help.',
             'fields' => ['email' => 'Already registered — sign in instead.']], 409);
    }

    // Web address: derived from the name, made unique with -2, -3 ...
    $base = slugify_school_name($schoolName);
    if (!valid_school_slug($base, $RESERVED_SLUGS)) { $base = 'school'; }
    $sid = $base;
    $chk = $pdo->prepare("SELECT id FROM schools WHERE id=?");
    for ($n = 2; $n < 500; $n++) {
        $chk->execute([$sid]);
        if (!$chk->fetch()) { break; }
        $sid = $base . '-' . $n;
    }

    $trialDays = max(1, (int)($cfg['TRIAL_DAYS'] ?? 30));
    $pdo->beginTransaction();
    try {
        db_seed_school($pdo, $sid, db_load_seed(), $schoolName, [
            'demo' => false,
            'admin' => ['name' => $contactName !== '' ? $contactName : 'School Administrator', 'username' => 'admin', 'password' => $password, 'must_change' => false],
            'email' => $email, 'phone' => $phone, 'contact_name' => $contactName,
            'created_via' => 'self-signup', 'trial_days' => $trialDays,
        ] + $extras);
        audit($pdo, ['uid' => 'self-signup'], 'signup', $sid, null, ['name' => $schoolName, 'email' => $email, 'terms_version' => '2026-11-05c', 'authority_declared' => true, 'ip' => $ip]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        error_log('Zetclass signup failed: ' . $e->getMessage());
        // Two people submitting at the same instant: the DATABASE's unique rules caught the clash.
        if (stripos($e->getMessage(), 'unique') !== false || stripos($e->getMessage(), 'duplicate') !== false) {
            $taken = school_name_taken($pdo, $schoolName) ? school_name_taken_msg($schoolName) : 'A school is already registered with this name, email or phone number.';
            out(['error' => $taken, 'fields' => ['school_name' => $taken]], 409);
        }
        out(['error' => 'We could not create your account right now. Please try again in a moment.'], 500);
    }
    rate_limit($pdo, 'reg:' . $ip, 5, 3600);
    rate_limit($pdo, 'regday:' . $ip, 15, 86400);

    // Best-effort heads-up to the developer; never allowed to fail the signup.
    if (!empty($cfg['NOTIFY_EMAIL'])) {
        @mail($cfg['NOTIFY_EMAIL'], 'New Zetclass signup: ' . $schoolName,
              "School: $schoolName\nContact: " . ($contactName !== '' ? $contactName : '(not given)') . "\nCountry: {$extras['country']}\nEmail: $email\nPhone: $phone\nWhatsApp: " . ($extras['whatsapp'] !== '' ? $extras['whatsapp'] : '(not given)') . "\nAddress: zetclass.com/$sid\n",
              'Content-Type: text/plain; charset=utf-8');
    }

    $tok = token_issue($cfg['APP_SECRET'], ['sid' => $sid, 'uid' => 'u-admin', 'role' => 'Admin', 'plat' => false], $cfg['TOKEN_TTL']);
    out([
        'ok'            => true,
        'token'         => $tok,
        'role'          => 'Admin',
        'school_id'     => $sid,
        'school_name'   => $schoolName,
        'trial_ends_at' => gmdate('Y-m-d', time() + ($trialDays * 86400)),
        'trial_days'    => $trialDays,
        'user' => [
            'id' => 'u-admin', 'name' => $contactName !== '' ? $contactName : 'School Administrator', 'username' => 'admin', 'role' => 'Admin',
            'staff_id' => 'SF0001', 'class_ids' => [], 'linked_student_ids' => [], 'must_change_password' => false,
        ],
    ], 201);
}

/* ============================================================
 * From here on, a valid token is required.
 * ============================================================ */
$claims = require_auth($cfg);
$isPlat = !empty($claims['plat']);

/* ---- platform super-admin routes ---- */
if ($head === 'schools' && $arg === 'list' && $method === 'GET') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $rows = $pdo->query("SELECT id, name, status, plan, created_at, trial_ends_at, paid_until, email, phone, contact_name, created_via, notes, licence_no, verified_at, verify_note, country, whatsapp, region, district, locality, postal_address, website FROM schools ORDER BY created_at DESC")->fetchAll();
    $cntStmt = $pdo->prepare("SELECT COUNT(*) c FROM documents WHERE collection='users' AND school_id=?");
    foreach ($rows as &$row) {
        $cntStmt->execute([$row['id']]);
        $row['user_count'] = (int)$cntStmt->fetch()['c'];
        $sub = subscription_state($row);
        $row['state'] = $sub['state'];
        $row['days_left'] = $sub['days_left'];
    }
    unset($row);
    out($rows);
}
if ($head === 'provision' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $name = $b['name'] ?? 'New School';
    if (school_name_taken($pdo, $name)) { out(['error' => school_name_taken_msg($name)], 409); }
    if (!empty($b['school_id'])) {
        $sid = $b['school_id'];
        if (!valid_school_slug($sid, $RESERVED_SLUGS)) {
            out(['error' => 'school_id must be lowercase letters, numbers and hyphens only, and cannot be a reserved word (' . implode(', ', $RESERVED_SLUGS) . ')'], 400);
        }
        $exists = $pdo->prepare("SELECT id FROM schools WHERE id=?"); $exists->execute([$sid]);
        if ($exists->fetch()) { out(['error' => 'School already exists', 'school_id' => $sid], 409); }
    } else {
        // No school_id given: derive one from the name, then make it unique
        // by appending -2, -3, ... on collision (same convention as GitHub/
        // Notion-style slugs) — a caller can never trigger a name clash.
        $base = slugify_school_name($name);
        if (!valid_school_slug($base, $RESERVED_SLUGS)) { $base = 'school'; }
        $sid = $base;
        $chk = $pdo->prepare("SELECT id FROM schools WHERE id=?");
        for ($n = 2; ; $n++) {
            $chk->execute([$sid]);
            if (!$chk->fetch()) { break; }
            $sid = $base . '-' . $n;
        }
    }
    // Real school (default): clean starter kit + one Admin login with a one-time
    // temporary password the developer hands over. demo=true keeps the old
    // sample roster + demo logins (training/testing ONLY — those logins use a
    // publicly known password).
    $demo = !empty($b['demo']);
    $opts = ['created_via' => 'platform', 'demo' => $demo];
    $tempPassword = null;
    $email = ''; $phone = ''; $contactName = '';
    if (!empty($b['email']))        { list($email, $err) = valid_email_addr($b['email']);  if ($err) { out(['error' => $err], 400); } }
    if (!empty($b['phone']))        { list($phone, $err) = valid_phone_no($b['phone']);    if ($err) { out(['error' => $err], 400); } }
    if (!empty($b['contact_name'])) { $contactName = clean_text($b['contact_name'], 80); }
    if ($email !== '' || $phone !== '') {
        // Same rule as public signup: one school per email and per phone number.
        $dupe = $pdo->prepare("SELECT id FROM schools WHERE LOWER(email)=? OR phone=?");
        $dupe->execute([$email === '' ? null : $email, $phone === '' ? null : $phone]);
        if ($dupe->fetch()) { out(['error' => 'Another school already uses this email or phone number.'], 409); }
    }
    $opts += ['email' => $email, 'phone' => $phone, 'contact_name' => $contactName, 'trial_days' => max(1, (int)($cfg['TRIAL_DAYS'] ?? 30))];
    if (!$demo) {
        $tempPassword = temp_password();
        $opts['admin'] = ['name' => $contactName ?: 'School Administrator', 'username' => 'admin', 'password' => $tempPassword, 'must_change' => true];
    }
    $pdo->beginTransaction();
    try {
        db_seed_school($pdo, $sid, db_load_seed(), $name, $opts);
        $logged = audit($pdo, $claims, 'provision', $sid, null, ['name' => $name, 'demo' => $demo]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        error_log('Zetclass provision failed: ' . $e->getMessage());
        out(['error' => 'Could not create the school (see the server error log).'], 500);
    }
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid, 'name' => $name,
         'username' => $demo ? null : 'admin', 'temp_password' => $tempPassword], 201);
}
if ($head === 'suspend' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    $status = $b['status'] ?? 'suspended'; // active | trial | grace | suspended | cancelled
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    if (!in_array($status, ['active', 'trial', 'grace', 'suspended', 'cancelled'], true)) {
        out(['error' => 'Unknown status'], 400);
    }
    $prev = $pdo->prepare("SELECT status FROM schools WHERE id=?"); $prev->execute([$sid]);
    $prevRow = $prev->fetch();
    if (!$prevRow) { out(['error' => 'School not found'], 404); }
    $pdo->prepare("UPDATE schools SET status=? WHERE id=?")->execute([$status, $sid]);
    $logged = audit($pdo, $claims, 'status', $sid, null, ['from' => $prevRow['status'], 'to' => $status]);
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid, 'status' => $status]);
}
/* Free-trial control. SERVER-AUTHORITATIVE: the trial lives on the schools
 * row as trial_ends_at, so a school cannot extend its own trial by clearing
 * browser storage or editing anything it owns. Three mutually exclusive
 * modes, in precedence order:
 *   clear:true            -> end the trial now (school is fully paid)
 *   trial_ends_at:Y-m-d   -> set an explicit end date
 *   days:N                -> EXTEND by N days from whichever is later, today
 *                            or the current end date. So extending a live
 *                            trial adds to it, and extending an already
 *                            expired one gives a fresh full N days rather
 *                            than silently landing in the past. */
if ($head === 'trial' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $sc = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $sc->execute([$sid]);
    $row = $sc->fetch();
    if (!$row) { out(['error' => 'School not found'], 404); }

    if (!empty($b['clear'])) {
        $newEnd = null;
    } elseif (!empty($b['trial_ends_at'])) {
        $d = (string)$b['trial_ends_at'];
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) { out(['error' => 'trial_ends_at must be YYYY-MM-DD'], 400); }
        $newEnd = $d;
    } else {
        $extra = isset($b['days']) ? (int)$b['days'] : 0;
        if ($extra < 1 || $extra > 3650) { out(['error' => 'days must be between 1 and 3650'], 400); }
        $today = gmdate('Y-m-d');
        $base = (!empty($row['trial_ends_at']) && $row['trial_ends_at'] > $today) ? $row['trial_ends_at'] : $today;
        $newEnd = gmdate('Y-m-d', strtotime($base . ' 00:00:00 UTC') + ($extra * 86400));
    }

    // Giving a school a (new) trial puts it back on trial: any earlier paid-until
    // date is cleared, otherwise it would silently outrank the trial you just set.
    if ($newEnd === null) {
        $pdo->prepare("UPDATE schools SET trial_ends_at=NULL WHERE id=?")->execute([$sid]);
    } else {
        $pdo->prepare("UPDATE schools SET trial_ends_at=?, paid_until=NULL WHERE id=?")->execute([$newEnd, $sid]);
    }
    $logged = audit($pdo, $claims, 'trial', $sid, null, ['from' => $row['trial_ends_at'] ?? null, 'to' => $newEnd]);
    $after = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $after->execute([$sid]);
    out(['ok' => true, 'audit' => $logged, 'subscription' => subscription_state($after->fetch())]);
}
/* Subscription tier. Kept in step with license-lib.js's PLANS keys. */
if ($head === 'plan' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid  = $b['school_id'] ?? '';
    $plan = $b['plan'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    if (!in_array($plan, ['basic', 'growth', 'premium'], true)) {
        out(['error' => 'plan must be one of: basic, growth, premium'], 400);
    }
    $prev = $pdo->prepare("SELECT plan FROM schools WHERE id=?"); $prev->execute([$sid]);
    $prevRow = $prev->fetch();
    if (!$prevRow) { out(['error' => 'School not found'], 404); }
    $pdo->prepare("UPDATE schools SET plan=? WHERE id=?")->execute([$plan, $sid]);
    $logged = audit($pdo, $claims, 'plan', $sid, null, ['from' => $prevRow['plan'], 'to' => $plan]);
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid, 'plan' => $plan]);
}
/* Record a payment / renew a subscription. This is how a school moves from
 * "free trial" to "paid": it sets the plan, sets paid_until (the end of the
 * period they have paid for), ends any trial, and makes sure the school is
 * active. A renewal STACKS: paying early extends from the current paid_until,
 * not from today, so nobody loses days. After paid_until passes the school
 * becomes read-only automatically — nobody has to remember to switch it off.
 * Give either days (e.g. 120 = one term) or an exact paid_until date. */
if ($head === 'platform' && $arg === 'payment' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $sc = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $sc->execute([$sid]);
    $row = $sc->fetch();
    if (!$row) { out(['error' => 'School not found'], 404); }

    $plan = $b['plan'] ?? ($row['plan'] ?: 'basic');
    if (!in_array($plan, ['basic', 'growth', 'premium'], true)) { out(['error' => 'plan must be one of: basic, growth, premium'], 400); }

    $today = gmdate('Y-m-d');
    if (!empty($b['paid_until'])) {
        $newEnd = (string)$b['paid_until'];
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $newEnd) || strtotime($newEnd . ' UTC') === false) { out(['error' => 'paid_until must be YYYY-MM-DD'], 400); }
        if ($newEnd < $today) { out(['error' => 'paid_until must be today or a future date'], 400); }
    } else {
        $days = isset($b['days']) ? (int)$b['days'] : 0;
        if ($days < 1 || $days > 1100) { out(['error' => 'days must be between 1 and 1100'], 400); }
        $base = (!empty($row['paid_until']) && $row['paid_until'] > $today) ? $row['paid_until'] : $today;
        $newEnd = gmdate('Y-m-d', strtotime($base . ' 00:00:00 UTC') + ($days * 86400));
    }
    $amount = null;
    if (isset($b['amount']) && $b['amount'] !== '') {
        if (!is_numeric($b['amount']) || $b['amount'] < 0 || $b['amount'] > 10000000) { out(['error' => 'amount must be a number'], 400); }
        $amount = round((float)$b['amount'], 2);
    }
    $note = clean_text($b['note'] ?? '', 200);

    $pdo->prepare("UPDATE schools SET plan=?, paid_until=?, trial_ends_at=NULL, status='active' WHERE id=?")->execute([$plan, $newEnd, $sid]);
    $logged = audit($pdo, $claims, 'payment', $sid, null, [
        'plan' => $plan, 'from' => $row['paid_until'] ?? null, 'to' => $newEnd, 'amount' => $amount, 'note' => $note,
    ]);
    $after = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $after->execute([$sid]);
    out(['ok' => true, 'audit' => $logged, 'subscription' => subscription_state($after->fetch())]);
}
/* Ownership verification (OWNER ONLY). After checking a school's proof (for example its NaSIA licence
 * number against NaSIA's records, a call to the phone on file, or a photo of its certificate sent on
 * WhatsApp), the owner marks it Verified, with a note of how. Verified can be removed again. */
if ($head === 'platform' && $arg === 'verify' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $ex = $pdo->prepare("SELECT id, verified_at FROM schools WHERE id=?"); $ex->execute([$sid]);
    $row = $ex->fetch();
    if (!$row) { out(['error' => 'School not found'], 404); }
    $verified = !empty($b['verified']);
    $note = clean_text($b['note'] ?? '', 300);
    $pdo->prepare("UPDATE schools SET verified_at=?, verify_note=? WHERE id=?")
        ->execute([$verified ? gmdate('c') : null, $note === '' ? null : $note, $sid]);
    $logged = audit($pdo, $claims, $verified ? 'verify' : 'unverify', $sid, null, ['note' => $note]);
    out(['ok' => true, 'audit' => $logged, 'verified' => $verified, 'verified_at' => $verified ? gmdate('c') : null, 'verify_note' => $note]);
}
/* Developer's private note about a school (e.g. "paid GHS 600 by MoMo, ref 123"). */
if ($head === 'platform' && $arg === 'note' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $note = clean_text($b['note'] ?? '', 500);
    $st = $pdo->prepare("UPDATE schools SET notes=? WHERE id=?"); $st->execute([$note, $sid]);
    if ($st->rowCount() === 0) {
        $ex = $pdo->prepare("SELECT id FROM schools WHERE id=?"); $ex->execute([$sid]);
        if (!$ex->fetch()) { out(['error' => 'School not found'], 404); }
    }
    $logged = audit($pdo, $claims, 'note', $sid, null, ['length' => mb_strlen($note)]);
    out(['ok' => true, 'audit' => $logged, 'notes' => $note]);
}
/* Correct a school's registry details: name, contact person, email, phone.
 * Only the fields sent are changed. Same rules as public signup (valid email /
 * phone, one school per email and per phone), except the developer may clear
 * email/phone (e.g. a school added by hand before it has them). The school's
 * web address (its id) is NOT editable: every record and login is tied to it.
 * The school's own profile (the name on report cards) follows only if it still
 * matched the old registry value, so a name or phone the school chose itself
 * is never overwritten. */
if ($head === 'platform' && $arg === 'details' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $sc = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $sc->execute([$sid]);
    $row = $sc->fetch();
    if (!$row) { out(['error' => 'School not found'], 404); }

    $new = [];
    if (array_key_exists('name', $b)) {
        list($v, $err) = valid_school_name($b['name']);
        if ($err) { out(['error' => $err], 400); }
        if (school_name_taken($pdo, $v, $sid)) { out(['error' => school_name_taken_msg($v)], 409); }
        $new['name'] = $v;
    }
    if (array_key_exists('contact_name', $b)) {
        $v = clean_text($b['contact_name'], 80);
        if (preg_match('/[<>]/', $v)) { out(['error' => 'The contact name cannot contain < or >.'], 400); }
        $new['contact_name'] = $v === '' ? null : $v;
    }
    if (array_key_exists('email', $b)) {
        if (trim((string)$b['email']) === '') { $new['email'] = null; }
        else { list($v, $err) = valid_email_addr($b['email']); if ($err) { out(['error' => $err], 400); } $new['email'] = $v; }
    }
    if (array_key_exists('phone', $b)) {
        if (trim((string)$b['phone']) === '') { $new['phone'] = null; }
        else { list($v, $err) = valid_phone_no($b['phone']); if ($err) { out(['error' => $err], 400); } $new['phone'] = $v; }
    }
    // Country, WhatsApp, region, district, locality and postal address (all optional; an empty value clears it).
    $xk = array_values(array_filter(['country', 'whatsapp', 'region', 'district', 'locality', 'postal_address', 'website'], function ($k) use ($b) { return array_key_exists($k, $b); }));
    if ($xk) {
        list($xv, $xe) = valid_school_extras($b, false);
        foreach ($xk as $k) {
            if (isset($xe[$k])) { out(['error' => $xe[$k]], 400); }
            $new[$k] = $xv[$k] === '' ? null : $xv[$k];
        }
    }
    // Only fields that actually change.
    foreach ($new as $k => $v) { if ((string)$v === (string)($row[$k] ?? '')) { unset($new[$k]); } }
    if (!$new) { out(['ok' => true, 'unchanged' => true, 'school' => [
        'name' => $row['name'], 'contact_name' => $row['contact_name'], 'email' => $row['email'], 'phone' => $row['phone']]]); }

    if (isset($new['email']) || isset($new['phone'])) {
        $dupe = $pdo->prepare("SELECT id FROM schools WHERE id<>? AND ((email IS NOT NULL AND LOWER(email)=?) OR (phone IS NOT NULL AND phone=?))");
        $dupe->execute([$sid, $new['email'] ?? '', $new['phone'] ?? '']);
        if ($dupe->fetch()) { out(['error' => 'Another school already uses this email or phone number.'], 409); }
    }

    $pdo->beginTransaction();
    try {
        $set = []; $vals = [];
        foreach ($new as $k => $v) { $set[] = "$k=?"; $vals[] = $v; }   // $k is from the fixed list above, never user text
        $vals[] = $sid;
        $pdo->prepare("UPDATE schools SET " . implode(',', $set) . " WHERE id=?")->execute($vals);
        if (isset($new['name'])) { $pdo->prepare("UPDATE schools SET name_key=? WHERE id=?")->execute([school_name_key($new['name']), $sid]); }

        $ps = $pdo->prepare("SELECT data FROM singletons WHERE school_id=? AND name='school'");
        $ps->execute([$sid]);
        $pr = $ps->fetch();
        if ($pr) {
            $prof = json_decode($pr['data'], true);
            if (is_array($prof)) {
                $touched = false;
                foreach (['name', 'email', 'phone'] as $k) {
                    if (!array_key_exists($k, $new)) { continue; }
                    $cur = (string)($prof[$k] ?? '');
                    if ($cur === '' || $cur === (string)($row[$k] ?? '')) { $prof[$k] = (string)($new[$k] ?? ''); $touched = true; }
                }
                if ($touched) {
                    $pdo->prepare("UPDATE singletons SET data=? WHERE school_id=? AND name='school'")->execute([json_encode($prof), $sid]);
                }
            }
        }
        $change = [];
        foreach ($new as $k => $v) { $change[$k] = ['from' => $row[$k] ?? null, 'to' => $v]; }
        $logged = audit($pdo, $claims, 'details', $sid, null, $change);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        error_log('Zetclass details update failed: ' . $e->getMessage());
        out(['error' => 'Could not save the changes (see the server error log).'], 500);
    }
    $after = $pdo->prepare("SELECT name, contact_name, email, phone FROM schools WHERE id=?"); $after->execute([$sid]);
    out(['ok' => true, 'audit' => $logged, 'school' => $after->fetch()]);
}
/* "Forgot password" help: issue a one-time temporary password for one account
 * (default: the school's first active Admin). The school must change it at
 * next sign-in. The new password is shown to the developer ONCE and never
 * stored in readable form, nor written to the audit log. */
if ($head === 'platform' && $arg === 'password' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    $uid = $b['user_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $us = $pdo->prepare("SELECT id, data FROM documents WHERE collection='users' AND school_id=?");
    $us->execute([$sid]);
    $target = null;
    foreach ($us->fetchAll() as $r2) {
        $u = json_decode($r2['data'], true);
        if (!is_array($u)) { continue; }
        if ($uid ? ($r2['id'] === $uid) : (($u['role'] ?? '') === 'Admin' && empty($u['disabled']))) { $target = [$r2['id'], $u]; break; }
    }
    if (!$target) { out(['error' => 'Account not found in that school'], 404); }
    list($tid, $u) = $target;
    $temp = temp_password();
    $salt = bin2hex(random_bytes(16));
    $u['password_salt'] = $salt;
    $u['password_hash'] = pbkdf2_hex($temp, $salt);
    $u['must_change_password'] = true;
    $u['sessions_valid_after'] = microtime(true);
    $pdo->prepare("UPDATE documents SET data=? WHERE collection='users' AND id=? AND school_id=?")->execute([json_encode($u), $tid, $sid]);
    $pdo->prepare("UPDATE password_resets SET status='handled' WHERE school_id=? AND user_id=? AND status='open'")->execute([$sid, $tid]);
    $logged = audit($pdo, $claims, 'password_reset', $sid, $tid, ['username' => $u['username'] ?? '']);
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid, 'user_id' => $tid, 'username' => $u['username'] ?? '', 'temp_password' => $temp]);
}
/* Password-help requests: Administrators who pressed "Forgot password". Shown to the
 * developer so a school whose email never arrives (or has none on file) can still be
 * helped - verify them by phone/WhatsApp, then issue a temporary password. */
if ($head === 'platform' && $arg === 'requests' && $method === 'GET') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $st = $pdo->query("SELECT p.id, p.school_id, p.username, p.requested_at, p.email_sent, p.user_id, s.name AS school_name, s.email, s.phone, s.contact_name
                       FROM password_resets p LEFT JOIN schools s ON s.id = p.school_id
                       WHERE p.status='open' ORDER BY p.id DESC LIMIT 50");
    out($st->fetchAll());
}
if ($head === 'platform' && $arg === 'request' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $id = (int)($b['id'] ?? 0);
    if ($id < 1) { out(['error' => 'id required'], 400); }
    $pdo->prepare("UPDATE password_resets SET status='handled' WHERE id=?")->execute([$id]);
    out(['ok' => true]);
}
/* Permanently delete a school and everything it owns (test signups, or a school
 * asking for its data to be removed). Needs the school's address typed back as
 * confirmation, and leaves one audit line (name only, no contact details). */
if ($head === 'platform' && $arg === 'delete' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    if (($b['confirm'] ?? '') !== $sid) { out(['error' => 'Type the school address exactly to confirm the deletion.'], 400); }
    $reg = $pdo->prepare("SELECT name FROM schools WHERE id=?"); $reg->execute([$sid]);
    $row = $reg->fetch();
    if (!$row) { out(['error' => 'School not found'], 404); }
    $pdo->beginTransaction();
    try {
        foreach (['documents', 'singletons', 'meta_seq', 'password_resets'] as $t) { $pdo->prepare("DELETE FROM $t WHERE school_id=?")->execute([$sid]); }
        $pdo->prepare("DELETE FROM schools WHERE id=?")->execute([$sid]);
        $logged = audit($pdo, $claims, 'delete', $sid, null, ['name' => $row['name']]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        error_log('Zetclass delete failed: ' . $e->getMessage());
        out(['error' => 'Could not delete the school (see the server error log).'], 500);
    }
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid]);
}
if ($head === 'reset' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $reg = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $reg->execute([$sid]);
    $row = $reg->fetch();
    if (!$row) { out(['error' => 'School not found'], 404); }
    // Wipe the school's data and re-seed a CLEAN starter kit with a fresh Admin
    // login (one-time temp password returned below). Subscription, contact
    // details and plan on the registry row are left exactly as they were.
    $tempPassword = temp_password();
    $pdo->beginTransaction();
    try {
        $pdo->prepare("DELETE FROM documents WHERE school_id=?")->execute([$sid]);
        $pdo->prepare("DELETE FROM singletons WHERE school_id=?")->execute([$sid]);
        $pdo->prepare("DELETE FROM meta_seq WHERE school_id=?")->execute([$sid]);
        db_seed_school($pdo, $sid, db_load_seed(), $row['name'], [
            'demo' => false,
            'admin' => ['name' => $row['contact_name'] ?: 'School Administrator', 'username' => 'admin', 'password' => $tempPassword, 'must_change' => true],
            'email' => $row['email'] ?? '', 'phone' => $row['phone'] ?? '',
            'country' => $row['country'] ?? '', 'whatsapp' => $row['whatsapp'] ?? '', 'region' => $row['region'] ?? '',
            'district' => $row['district'] ?? '', 'locality' => $row['locality'] ?? '', 'postal_address' => $row['postal_address'] ?? '', 'website' => $row['website'] ?? '',
        ]);
        $logged = audit($pdo, $claims, 'reset', $sid);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) { $pdo->rollBack(); }
        error_log('Zetclass reset failed: ' . $e->getMessage());
        out(['error' => 'Could not reset the school (see the server error log).'], 500);
    }
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid, 'username' => 'admin', 'temp_password' => $tempPassword]);
}
/* ---- platform/* : per-user administration + the audit log itself ---- */
if ($head === 'platform' && $arg === 'users' && $method === 'GET') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $sid = $_GET['school'] ?? '';
    if (!$sid) { out(['error' => 'school query parameter required'], 400); }
    $us = $pdo->prepare("SELECT data FROM documents WHERE collection='users' AND school_id=?");
    $us->execute([$sid]);
    $list = [];
    foreach ($us->fetchAll() as $row) {
        $u = json_decode($row['data'], true);
        if (!is_array($u)) { continue; }
        // Password salt/hash are never returned — not even to the owner plane.
        $list[] = [
            'id'                   => $u['id'] ?? null,
            'name'                 => $u['name'] ?? '',
            'username'             => $u['username'] ?? '',
            'role'                 => $u['role'] ?? '',
            'disabled'             => !empty($u['disabled']),
            'must_change_password' => !empty($u['must_change_password']),
        ];
    }
    out($list);
}
if ($head === 'platform' && $arg === 'user' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    $uid = $b['user_id'] ?? '';
    if (!$sid || !$uid) { out(['error' => 'school_id and user_id required'], 400); }
    $disabled = !empty($b['disabled']);

    $row = $pdo->prepare("SELECT data FROM documents WHERE collection='users' AND id=? AND school_id=?");
    $row->execute([$uid, $sid]);
    $d = $row->fetch();
    if (!$d) { out(['error' => 'User not found in that school'], 404); }
    $u = json_decode($d['data'], true);
    if (!is_array($u)) { out(['error' => 'User record is unreadable'], 500); }

    // Guard: never let the owner disable a school's LAST working Admin — that
    // would lock the school out of its own settings. Suspend the whole school
    // instead if that is the intent.
    if ($disabled && ($u['role'] ?? '') === 'Admin' && empty($u['disabled'])) {
        $all = $pdo->prepare("SELECT data FROM documents WHERE collection='users' AND school_id=?");
        $all->execute([$sid]);
        $liveAdmins = 0;
        foreach ($all->fetchAll() as $r2) {
            $o = json_decode($r2['data'], true);
            if (is_array($o) && ($o['role'] ?? '') === 'Admin' && empty($o['disabled'])) { $liveAdmins++; }
        }
        if ($liveAdmins <= 1) {
            out(['error' => 'This is the school\'s only active Admin. Suspend the whole school instead, or enable another Admin first.'], 409);
        }
    }

    $u['disabled'] = $disabled;
    $pdo->prepare("UPDATE documents SET data=? WHERE collection='users' AND id=? AND school_id=?")
        ->execute([json_encode($u), $uid, $sid]);
    $logged = audit($pdo, $claims, $disabled ? 'user_disable' : 'user_enable', $sid, $uid, ['username' => $u['username'] ?? '']);
    out(['ok' => true, 'audit' => $logged, 'school_id' => $sid, 'user_id' => $uid, 'disabled' => $disabled]);
}
if ($head === 'platform' && $arg === 'audit' && $method === 'GET') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $sid = isset($_GET['school']) ? $_GET['school'] : null;
    // Cast + clamp before interpolating: LIMIT cannot be a bound parameter.
    $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 100;
    if ($sid) {
        $st = $pdo->prepare("SELECT * FROM platform_audit WHERE school_id=? ORDER BY id DESC LIMIT $limit");
        $st->execute([$sid]);
    } else {
        $st = $pdo->prepare("SELECT * FROM platform_audit ORDER BY id DESC LIMIT $limit");
        $st->execute();
    }
    $rows = $st->fetchAll();
    foreach ($rows as &$r2) { $r2['detail'] = !empty($r2['detail']) ? json_decode($r2['detail'], true) : null; }
    unset($r2);
    out($rows);
}
if ($head === 'impersonate' && $method === 'POST') {
    if (!$isPlat) { out(['error' => 'Forbidden'], 403); }
    $b = body();
    $sid = $b['school_id'] ?? '';
    if (!$sid) { out(['error' => 'school_id required'], 400); }
    $sc = $pdo->prepare("SELECT id FROM schools WHERE id=?"); $sc->execute([$sid]);
    if (!$sc->fetch()) { out(['error' => 'School not found'], 404); }

    // Impersonate as that school's first ACTIVE Admin user, if one exists —
    // falls back to a synthetic Admin identity (no linked user record).
    $adminUser = null;
    $us = $pdo->prepare("SELECT data FROM documents WHERE collection='users' AND school_id=?");
    $us->execute([$sid]);
    foreach ($us->fetchAll() as $row) {
        $u = json_decode($row['data'], true);
        if (is_array($u) && ($u['role'] ?? '') === 'Admin' && empty($u['disabled'])) { $adminUser = $u; break; }
    }

    // Deliberately much shorter than a normal session (TOKEN_TTL) — this is a
    // support/debugging session, not a login, and every one is logged below.
    $impTtl = 900; // 15 minutes
    $platUid = $claims['uid'] ?? 'platform';
    $tok = token_issue($cfg['APP_SECRET'], [
        'sid'    => $sid,
        'uid'    => $adminUser['id'] ?? ('platform-imp-' . $sid),
        'role'   => 'Admin',
        'plat'   => false,
        'imp'    => true,
        'imp_by' => $platUid,
    ], $impTtl);

    $issuedAt = gmdate('c');
    $expiresAt = gmdate('c', time() + $impTtl);
    $logged = audit($pdo, $claims, 'impersonate', $sid, $adminUser['id'] ?? null, [
        'issued_at'  => $issuedAt,
        'expires_at' => $expiresAt,
        'ttl'        => $impTtl,
    ]);

    out([
        'token'      => $tok,
        'role'       => 'Admin',
        'school_id'  => $sid,
        'imp'        => true,
        'audit'      => $logged,
        'expires_at' => $expiresAt,
        'user' => [
            'id'                   => $adminUser['id'] ?? ('platform-imp-' . $sid),
            'name'                 => ($adminUser['name'] ?? 'Impersonated Admin') . ' (impersonated)',
            'username'             => $adminUser['username'] ?? '',
            'role'                 => 'Admin',
            'staff_id'             => $adminUser['staff_id'] ?? null,
            'class_ids'            => $adminUser['class_ids'] ?? [],
            'linked_student_ids'   => $adminUser['linked_student_ids'] ?? [],
            'must_change_password' => false,
        ],
    ]);
}

/* ============================================================
 * School-scoped routes. The school ALWAYS comes from the token.
 * (A platform token may target a school with ?school=<id> for support.)
 * ============================================================ */
$SCHOOL = $claims['sid'];
if ($SCHOOL === null) {
    if ($isPlat && isset($_GET['school'])) { $SCHOOL = $_GET['school']; }
    else { out(['error' => 'No school context for this token'], 400); }
}

if (!school_active($pdo, $SCHOOL)) {
    out(['error' => 'Subscription inactive'], 403);
}

/* ---- A disabled or deleted account loses its open session immediately ----
 * Tokens are stateless and last up to 12 hours; without this check, disabling
 * someone (or deleting their account) would only stop their NEXT sign-in. */
if (!$isPlat && empty($claims['imp'])) {
    $liveUser = $pdo->prepare("SELECT data FROM documents WHERE school_id=? AND collection='users' AND id=?");
    $liveUser->execute([$SCHOOL, $claims['uid'] ?? '']);
    $liveRow = $liveUser->fetch();
    $liveDoc = $liveRow ? json_decode($liveRow['data'], true) : null;
    // sessions_valid_after is set when a password is reset (by the owner, or through the
    // emailed link): any session opened BEFORE that moment is signed out, so a reset
    // also kicks out whoever else may have been using the old password.
    $stale = is_array($liveDoc) && !empty($liveDoc['sessions_valid_after']) && (float)($claims['iatm'] ?? $claims['iat'] ?? 0) < (float)$liveDoc['sessions_valid_after'];
    if (!is_array($liveDoc) || !empty($liveDoc['disabled']) || $stale) {
        out(['error' => 'This account is no longer active. Please sign in again or contact your school administrator.'], 401);
    }
}

/* ---- Expired trial / subscription = READ-ONLY, enforced HERE ----
 * The app also greys itself out when a trial ends, but a browser is not a
 * security boundary: anyone could bypass the screen and call this API directly.
 * So the server itself refuses every change (POST/PUT/DELETE) from a school
 * whose trial or paid period has ended. Reading and exporting stay allowed —
 * the data is theirs. The developer (platform token) is never blocked, so
 * support can still fix things. */
$regStmt = $pdo->prepare("SELECT * FROM schools WHERE id=?");
$regStmt->execute([$SCHOOL]);
$regRow = $regStmt->fetch();
if ($regRow && !$isPlat && in_array($method, ['POST', 'PUT', 'DELETE'], true)
    && subscription_state($regRow)['state'] === 'expired') {
    out(['error' => 'Your free trial or subscription has ended, so changes are switched off. Your data is safe and you can still view and export it. Please contact Zetranova to subscribe.'], 403);
}

/* ---- Who may touch accounts, permissions and whole-school backups ----
 * The page hides these from non-admins, but the API must enforce it too:
 * without this, a Parent's login could list every staff password hash or set
 * their own role to Admin by calling the API by hand. */
$callerRole  = $claims['role'] ?? '';
$callerIsAdm = $isPlat || $callerRole === 'Admin';
if (($head === 'import' || $head === 'export') && !$callerIsAdm) {
    out(['error' => 'Only the school Administrator can do this.', 'code' => 'role'], 403);
}
if ($head === 'permissions' && $method !== 'GET' && !$callerIsAdm) {
    out(['error' => 'Only the school Administrator can change permissions.', 'code' => 'role'], 403);
}
if ($head === 'users' && !$callerIsAdm) {
    // Everyone else may read and update ONLY their own record, and only the
    // password fields of it (that is how "Change password" works).
    if ($arg === null || $arg !== ($claims['uid'] ?? null) || !in_array($method, ['GET', 'PUT'], true)) {
        out(['error' => 'Only the school Administrator can manage accounts.', 'code' => 'role'], 403);
    }
    if ($method === 'PUT') {
        $allowed = ['password_salt', 'password_hash', 'must_change_password'];
        foreach (array_keys(body()) as $k) {
            if (!in_array($k, $allowed, true)) { out(['error' => 'You can only change your own password.', 'code' => 'role'], 403); }
        }
    }
}
// Parents have a read-only portal. The screens already hide every edit button;
// this makes the server say no too, so a parent cannot change records by
// calling the API by hand. (Their only write is their own password, allowed above.)
if ($callerRole === 'Parent' && !$isPlat && in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
    $ownPassword = ($head === 'users' && $method === 'PUT' && $arg !== null && $arg === ($claims['uid'] ?? null));
    if (!$ownPassword) { out(['error' => 'Parent accounts are view-only.', 'code' => 'role'], 403); }
}

/* Staff pay details are for people who run Payroll. Teachers and Parents never
 * need them, so the server leaves them out of what it sends those roles. */
function redact_for_role($collection, $rows, $role) {
    if ($collection !== 'staff' || !in_array($role, ['Teacher', 'Parent'], true)) { return $rows; }
    foreach ($rows as $i => $r) {
        if (is_array($r)) { unset($rows[$i]['basic_salary'], $rows[$i]['allowances'], $rows[$i]['payroll_overrides'], $rows[$i]['payment_method']); }
    }
    return $rows;
}

/* ---- this school's own licence state (read-only) ----
 * The school reads its trial/plan from here instead of computing it from
 * anything stored client-side. A missing registry row means a legacy
 * single-school install, which is treated as fully active. */
if ($head === 'subscription' && $method === 'GET') {
    $st = $pdo->prepare("SELECT * FROM schools WHERE id=?");
    $st->execute([$SCHOOL]);
    $row = $st->fetch();
    if (!$row) {
        out([
            'school_id' => $SCHOOL, 'name' => '', 'status' => 'active', 'plan' => null,
            'trial_ends_at' => null, 'state' => 'active', 'days_left' => null, 'source' => 'server',
        ]);
    }
    out(subscription_state($row));
}

/* A school's Administrator gives the school's licence / registration number (for a private school:
 * its NaSIA licence number) so the owner can verify that the school really is theirs to register.
 * Changing the number removes an earlier Verified mark: new details have to be checked again. */
if ($head === 'verification' && $method === 'POST') {
    if ($callerRole !== 'Admin') { out(['error' => 'Only the school Administrator can do this.', 'code' => 'role'], 403); }
    $b = body();
    $no = clean_text($b['licence_no'] ?? '', 80);
    if (mb_strlen($no) < 3) { out(['error' => 'Please enter your school’s licence or registration number (at least 3 characters).'], 400); }
    $cur = $pdo->prepare("SELECT licence_no FROM schools WHERE id=?"); $cur->execute([$SCHOOL]);
    $was = $cur->fetch();
    if (!$was) { out(['error' => 'School not found'], 404); }
    $changed = (string)($was['licence_no'] ?? '') !== $no;
    if ($changed) { $pdo->prepare("UPDATE schools SET licence_no=?, verified_at=NULL, verify_note=NULL WHERE id=?")->execute([$no, $SCHOOL]); }
    $logged = audit($pdo, $claims, 'verify_request', $SCHOOL, null, ['licence_no' => $no]);
    $after = $pdo->prepare("SELECT * FROM schools WHERE id=?"); $after->execute([$SCHOOL]);
    out(['ok' => true, 'audit' => $logged, 'subscription' => subscription_state($after->fetch())]);
}

/* ---- singletons (per school) ---- */
if ($head === 'singleton') {
    if ($method === 'GET') {
        $row = $pdo->prepare("SELECT data FROM singletons WHERE school_id=? AND name=?");
        $row->execute([$SCHOOL, $arg]);
        $d = $row->fetch();
        out($d ? json_decode($d['data'], true) : null);
    }
    if ($method === 'PUT') {
        $obj = body();
        $obj = tag_school($obj, $SCHOOL);
        $st = $pdo->prepare("REPLACE INTO singletons(school_id,name,data) VALUES(?,?,?)");
        $st->execute([$SCHOOL, $arg, json_encode($obj)]);
        out($obj);
    }
}

/* ---- per-school sequence counter ---- */
if ($head === 'seq' && $method === 'POST') {
    $b = body();
    $chk = $pdo->prepare("SELECT val FROM meta_seq WHERE school_id=? AND kind=?");
    $chk->execute([$SCHOOL, $arg]);
    if (!$chk->fetch()) {
        $pdo->prepare("INSERT INTO meta_seq(school_id,kind,val) VALUES(?,?,0)")->execute([$SCHOOL, $arg]);
    }
    if (isset($b['at_least'])) {
        // Raise the counter to at least N (never lowers it, never adds 1). Used when
        // sample records that already carry numbers (ST0001…) are loaded, so the
        // next real pupil/staff number cannot repeat one of them.
        $n = max(0, min(1000000, (int)$b['at_least']));
        $pdo->prepare("UPDATE meta_seq SET val=? WHERE school_id=? AND kind=? AND val<?")->execute([$n, $SCHOOL, $arg, $n]);
    } else {
        $pdo->prepare("UPDATE meta_seq SET val = val + 1 WHERE school_id=? AND kind=?")->execute([$SCHOOL, $arg]);
    }
    $v = $pdo->prepare("SELECT val FROM meta_seq WHERE school_id=? AND kind=?");
    $v->execute([$SCHOOL, $arg]);
    out((int)$v->fetch()['val']);
}

/* ---- export just this school's data ---- */
if ($head === 'export' && $method === 'GET') {
    $data = [];
    $cols = $pdo->prepare("SELECT DISTINCT collection FROM documents WHERE school_id=?");
    $cols->execute([$SCHOOL]);
    foreach ($cols->fetchAll() as $c) {
        $rows = $pdo->prepare("SELECT data FROM documents WHERE collection=? AND school_id=?");
        $rows->execute([$c['collection'], $SCHOOL]);
        $data[$c['collection']] = array_map(fn($x) => json_decode($x['data'], true), $rows->fetchAll());
    }
    $ones = $pdo->prepare("SELECT name,data FROM singletons WHERE school_id=?");
    $ones->execute([$SCHOOL]);
    foreach ($ones->fetchAll() as $s) { $data[$s['name']] = json_decode($s['data'], true); }
    $seq = [];
    $seqs = $pdo->prepare("SELECT kind,val FROM meta_seq WHERE school_id=?");
    $seqs->execute([$SCHOOL]);
    foreach ($seqs->fetchAll() as $m) { $seq[$m['kind']] = (int)$m['val']; }
    $data['meta'] = ['seq' => $seq];
    out($data);
}

/* ---- import: replace this school's ENTIRE dataset from an uploaded blob ----
 * Mirrors db_seed_school()'s write logic exactly, but WITHOUT touching the
 * `schools` registry row, and scoped to $SCHOOL from the token — a client
 * can never import data into (or overwrite) any school but its own, and
 * every row/singleton/seq is force-stamped with $SCHOOL regardless of what
 * school_id (if any) is present in the uploaded JSON. Because the registry
 * row is untouched, a school also cannot import itself a longer free trial. */
if ($head === 'import' && $method === 'PUT') {
    $data = body();
    $pdo->prepare("DELETE FROM documents WHERE school_id=?")->execute([$SCHOOL]);
    $pdo->prepare("DELETE FROM singletons WHERE school_id=?")->execute([$SCHOOL]);
    $pdo->prepare("DELETE FROM meta_seq WHERE school_id=?")->execute([$SCHOOL]);
    $singletons = db_singletons();
    $insDoc = $pdo->prepare("INSERT INTO documents(id,collection,school_id,data) VALUES(?,?,?,?)");
    $insOne = $pdo->prepare("REPLACE INTO singletons(school_id,name,data) VALUES(?,?,?)");
    foreach ($data as $key => $val) {
        if ($key === 'meta' || $key === 'constants') { continue; }
        if (in_array($key, $singletons)) {
            $val = tag_school($val, $SCHOOL);
            $insOne->execute([$SCHOOL, $key, json_encode($val)]);
        } elseif (is_array($val)) {
            foreach ($val as $rec) {
                if (!is_array($rec)) { continue; }
                $id = $rec['id'] ?? uniqid($key . '-');
                $rec['id'] = $id;
                $rec['school_id'] = $SCHOOL; // force tenant tag; ignore any client-supplied value
                $insDoc->execute([$id, $key, $SCHOOL, json_encode($rec)]);
            }
        }
    }
    if (isset($data['meta']['seq'])) {
        $insSeq = $pdo->prepare("REPLACE INTO meta_seq(school_id,kind,val) VALUES(?,?,?)");
        foreach ($data['meta']['seq'] as $k => $v) { $insSeq->execute([$SCHOOL, $k, (int)$v]); }
    }
    out(['ok' => true]);
}

if ($head === 'pay' && $method === 'POST')  out(svc_payment_charge($cfg, body()));
if ($head === 'sms' && $method === 'POST')  out(svc_sms_send($cfg, body()));

/* ============================================================
 * Generic collection CRUD — every statement filtered by $SCHOOL.
 * ============================================================ */
if ($head === '') { out(['error' => 'No route'], 400); }
$collection = $head;

if ($method === 'GET' && $arg === null) {
    $rows = $pdo->prepare("SELECT data FROM documents WHERE collection=? AND school_id=?");
    $rows->execute([$collection, $SCHOOL]);
    out(redact_for_role($collection, array_map(fn($x) => json_decode($x['data'], true), $rows->fetchAll()), $callerRole));
}
if ($method === 'GET') {
    $row = $pdo->prepare("SELECT data FROM documents WHERE collection=? AND id=? AND school_id=?");
    $row->execute([$collection, $arg, $SCHOOL]);
    $d = $row->fetch();
    $one = $d ? json_decode($d['data'], true) : null;
    out($one === null ? null : redact_for_role($collection, [$one], $callerRole)[0]);
}
if ($method === 'POST') {
    $obj = body();
    if (empty($obj['id'])) { $obj['id'] = $collection . '-' . bin2hex(random_bytes(5)); }
    $obj['school_id'] = $SCHOOL; // force tenant tag; ignore any client-supplied value

    // The primary key is (school_id, collection, id), so this REPLACE can only
    // ever insert or replace THIS school's own row — never another school's.
    $pdo->prepare("REPLACE INTO documents(id,collection,school_id,data) VALUES(?,?,?,?)")
        ->execute([$obj['id'], $collection, $SCHOOL, json_encode($obj)]);
    out($obj, 201);
}
if ($method === 'PUT' && $arg === null) {
    // replace this school's whole collection: { replace:[...] }
    $b = body();
    $arr = $b['replace'] ?? [];
    $pdo->prepare("DELETE FROM documents WHERE collection=? AND school_id=?")->execute([$collection, $SCHOOL]);
    $st = $pdo->prepare("INSERT INTO documents(id,collection,school_id,data) VALUES(?,?,?,?)");
    foreach ($arr as $rec) {
        $id = $rec['id'] ?? ($collection . '-' . bin2hex(random_bytes(5))); $rec['id'] = $id;
        $rec['school_id'] = $SCHOOL;
        $st->execute([$id, $collection, $SCHOOL, json_encode($rec)]);
    }
    out($arr);
}
if ($method === 'PUT') {
    $patch = body();
    $row = $pdo->prepare("SELECT data FROM documents WHERE collection=? AND id=? AND school_id=?");
    $row->execute([$collection, $arg, $SCHOOL]);
    $d = $row->fetch();
    if (!$d) { out(null, 404); }
    $obj = array_merge(json_decode($d['data'], true), $patch);
    $obj['school_id'] = $SCHOOL; // never allow a patch to move a row to another school
    $pdo->prepare("UPDATE documents SET data=? WHERE collection=? AND id=? AND school_id=?")
        ->execute([json_encode($obj), $collection, $arg, $SCHOOL]);
    out($obj);
}
if ($method === 'DELETE') {
    $pdo->prepare("DELETE FROM documents WHERE collection=? AND id=? AND school_id=?")
        ->execute([$collection, $arg, $SCHOOL]);
    out(['ok' => true]);
}

out(['error' => 'Unsupported route', 'route' => $r, 'method' => $method], 400);
