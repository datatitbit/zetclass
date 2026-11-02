<?php
/* ============================================================
 * auth.php — server-side authentication + per-school tokens.
 *
 * Password hashing MATCHES the front-end (auth-lib.js) exactly so the
 * same stored hashes verify on either side:
 *   PBKDF2-SHA256, 100,000 iterations, 256-bit (32-byte) key,
 *   salt = the raw bytes of the stored hex salt, output = lower-hex.
 *
 * Session tokens are compact HMAC-signed blobs (like a mini-JWT):
 *   base64url(json_claims) . base64url(hmac_sha256(payload, APP_SECRET))
 * Claims: sid (school id | null for platform), uid, role, plat, iat, exp.
 * The token is the ONLY trusted source of a request's school id.
 * ============================================================ */

/* ---- base64url ---- */
function b64url($bin) { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
function b64url_dec($s) {
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) { $s .= str_repeat('=', 4 - $pad); }
    return base64_decode($s);
}

/* ---- password hashing (mirrors auth-lib.js) ---- */
function pbkdf2_hex($password, $saltHex) {
    // raw_output=true to be unambiguous across PHP versions, then hex-encode.
    $raw = hash_pbkdf2('sha256', (string)$password, hex2bin((string)$saltHex), 100000, 32, true);
    return bin2hex($raw);
}
function auth_verify_password($password, $saltHex, $hashHex) {
    if (!$saltHex || !$hashHex) { return false; }
    $calc = pbkdf2_hex($password, $saltHex);
    // constant-time compare, case-insensitive on the hex.
    return hash_equals(strtolower((string)$hashHex), strtolower($calc));
}

/* ---- tokens ---- */
function token_issue($secret, $claims, $ttl) {
    $claims['iat'] = time();
    $claims['iatm'] = microtime(true);   // precise issue time, so "signed in before the password reset" is exact to the microsecond
    $claims['exp'] = time() + (int)$ttl;
    $payload = b64url(json_encode($claims));
    $sig = b64url(hash_hmac('sha256', $payload, $secret, true));
    return $payload . '.' . $sig;
}
function token_verify($secret, $token) {
    if (!$token || strpos($token, '.') === false) { return null; }
    list($payload, $sig) = explode('.', $token, 2);
    $expect = b64url(hash_hmac('sha256', $payload, $secret, true));
    if (!hash_equals($expect, $sig)) { return null; }
    $claims = json_decode(b64url_dec($payload), true);
    if (!is_array($claims)) { return null; }
    if (isset($claims['exp']) && time() > (int)$claims['exp']) { return null; }
    return $claims;
}

/* ---- request helpers ---- */
function bearer_token() {
    $h = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) { $h = $_SERVER['HTTP_AUTHORIZATION']; }
    elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) { $h = $_SERVER['REDIRECT_HTTP_AUTHORIZATION']; }
    elseif (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) { if (strtolower($k) === 'authorization') { $h = $v; break; } }
    }
    if (stripos($h, 'Bearer ') === 0) { return trim(substr($h, 7)); }
    return '';
}

// Requires a valid token; otherwise emits 401 and exits (uses out() from index.php).
function require_auth($cfg) {
    $claims = token_verify($cfg['APP_SECRET'], bearer_token());
    if (!$claims) { out(['error' => 'Unauthorized'], 401); }
    return $claims;
}

/* ---- user lookup (scoped to one school) ---- */
function find_user($pdo, $school, $username) {
    $st = $pdo->prepare("SELECT data FROM documents WHERE collection='users' AND school_id=?");
    $st->execute([$school]);
    foreach ($st->fetchAll() as $row) {
        $u = json_decode($row['data'], true);
        if (isset($u['username']) && strtolower($u['username']) === strtolower((string)$username)) { return $u; }
    }
    return null;
}

/* ---- subscription gate ---- */
// Returns true if the school may be used. A missing registry row means a
// legacy single-school install → allow. Suspended/cancelled → deny.
function school_active($pdo, $school) {
    try {
        $st = $pdo->prepare("SELECT status FROM schools WHERE id=?");
        $st->execute([$school]);
        $r = $st->fetch();
    } catch (Throwable $e) { return true; }
    if (!$r) { return true; }
    return in_array($r['status'], ['active', 'trial', 'grace'], true);
}
