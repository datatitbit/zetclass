<?php
/* ============================================================
 * config.php — environment configuration for the REST API.
 * Development: SQLite (zero setup). Production (cPanel): MySQL.
 * Switch by setting DB_DRIVER to 'sqlite' or 'mysql'.
 *
 * MULTI-TENANT NOTE: this API now enforces per-school isolation.
 * Every request (except login) must carry a Bearer token issued by
 * ?r=auth/login. The school is read FROM THE TOKEN — never from the
 * request body or from SCHOOL_ID below. SCHOOL_ID is only the default
 * tenant used when seeding a brand-new database (single-school installs)
 * and when a login request omits an explicit school_id.
 * ============================================================ */

/* SECRETS LIVE IN config.local.php, NOT HERE.
 * config.local.php (same folder) is never committed to git and never shipped
 * in a code upload, so re-uploading the app can't overwrite or leak your
 * database password / signing secret. Anything it returns is merged over the
 * defaults below. Copy config.local.example.php to config.local.php and fill
 * it in (tools/make-config.js does this for you). */
$cfg = [
    'DB_DRIVER' => getenv('SMS_DB_DRIVER') ?: 'sqlite',

    // SQLite (development)
    'SQLITE_PATH' => getenv('SMS_SQLITE_PATH') ?: (__DIR__ . '/data/sms.sqlite'),

    // MySQL (cPanel production) — replace PLACEHOLDER values
    'MYSQL_HOST'    => getenv('SMS_DB_HOST') ?: 'localhost',
    'MYSQL_NAME'    => getenv('SMS_DB_NAME') ?: 'cpaneluser_sms',
    'MYSQL_USER'    => getenv('SMS_DB_USER') ?: 'cpaneluser_smsapp',
    'MYSQL_PASS'    => getenv('SMS_DB_PASS') ?: 'CHANGE_ME_PLACEHOLDER',
    'MYSQL_CHARSET' => 'utf8mb4',

    // Default tenant id used ONLY to seed a fresh database and as the
    // fallback school for a login that doesn't name one. In a shared,
    // multi-school database the real school always comes from the token.
    'SCHOOL_ID' => getenv('SMS_SCHOOL_ID') ?: 'sch-1',

    // ---- Auth / token signing ----
    // Secret used to HMAC-sign session tokens. MUST be set to a long random
    // value in production (e.g. `openssl rand -hex 32`). If left as the
    // placeholder, the API refuses to issue tokens (see index.php).
    'APP_SECRET' => getenv('SMS_APP_SECRET') ?: 'CHANGE_ME_APP_SECRET_PLACEHOLDER',
    'TOKEN_TTL'  => (int)(getenv('SMS_TOKEN_TTL') ?: 43200), // seconds (default 12h)

    // ---- Platform (Zetranova) super-admin ----
    // A single cross-school account that can provision/suspend schools.
    // Generate salt+hash with tools/hashpass.php (see README-ISOLATION.md).
    // Leave username empty to disable the platform account entirely.
    'PLATFORM_ADMIN' => [
        'username' => getenv('SMS_PLATFORM_USER') ?: '',
        'salt'     => getenv('SMS_PLATFORM_SALT') ?: '',
        'hash'     => getenv('SMS_PLATFORM_HASH') ?: '',
    ],

    // Create a public demo school ("sch-1", logins admin/director/... with the
    // password 123) the first time the database is empty. Keep OFF on the live
    // server; use ON for local development and demos.
    'SEED_DEMO_ON_EMPTY' => getenv('SMS_SEED_DEMO') === '1',

    // ---- Self-service signup (POST ?r=register) ----
    // Set to false to close public signup (existing schools keep working; the
    // developer can still add schools by hand from the platform console).
    'SIGNUP_ENABLED' => getenv('SMS_SIGNUP_ENABLED') !== '0',
    // Free-trial length for a NEW school, in days (developer can change per
    // school afterwards from the platform console).
    'TRIAL_DAYS'     => (int)(getenv('SMS_TRIAL_DAYS') ?: 30),
    // The public web address used in emailed links (password reset). Set here, NOT
    // taken from the visitor's request, so nobody can make Zetclass email a link
    // that points at another website.
    'BASE_URL'  => getenv('SMS_BASE_URL') ?: 'https://zetclass.com',
    // Cross-site permission for the API. Empty (default) = none, which is right
    // while the app and API share one address. Otherwise ONE exact address.
    'CORS_ORIGIN' => getenv('SMS_CORS_ORIGIN') ?: '',
    // The "From" address on emails Zetclass sends. Use an address on your own domain.
    'MAIL_FROM' => getenv('SMS_MAIL_FROM') ?: 'no-reply@zetclass.com',
    // Optional: an address that gets a plain-text email whenever a school
    // signs up. Leave empty to disable. (Best effort — never blocks signup.)
    'NOTIFY_EMAIL'   => getenv('SMS_NOTIFY_EMAIL') ?: '',

    // External services run in TEST MODE until real keys are added.
    'PAYMENTS' => [
        'provider'   => 'mock',
        'test_mode'  => true,
        'secret_key' => 'sk_test_PLACEHOLDER',
    ],
    'SMS' => [
        'provider'  => 'mock',
        'test_mode' => true,
        'api_key'   => 'sms_test_PLACEHOLDER',
        'sender_id' => 'SCHOOL',
    ],
];

// Merge the untracked local override (secrets + per-server settings) on top.
$localFile = __DIR__ . '/config.local.php';
if (is_file($localFile)) {
    $over = require $localFile;
    if (is_array($over)) { $cfg = array_replace_recursive($cfg, $over); }
}
return $cfg;
