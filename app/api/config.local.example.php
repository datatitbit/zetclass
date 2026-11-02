<?php
/* ============================================================
 * config.local.example.php — TEMPLATE for the real, secret settings.
 *
 * 1. Run  node tools/make-config.js  on your own computer (recommended —
 *    it asks you questions and writes config.local.php for you, so your
 *    passwords are never typed into chat or an email), OR
 * 2. Copy this file to  config.local.php  and fill in the values by hand.
 *
 * Then upload config.local.php to the SAME folder as index.php on the
 * server (cPanel > File Manager > public_html/.../api/). Never commit it.
 * ============================================================ */
return [
    'DB_DRIVER'  => 'mysql',
    'MYSQL_HOST' => 'localhost',
    'MYSQL_NAME' => 'cpanelprefix_dbname',
    'MYSQL_USER' => 'cpanelprefix_dbuser',
    'MYSQL_PASS' => 'the-database-password',

    // Long random string used to sign login sessions. Keep it secret.
    'APP_SECRET' => 'paste-64-random-hex-characters-here',

    // The developer/owner account (log in at zetclass.com/admin).
    'PLATFORM_ADMIN' => [
        'username' => 'your-developer-username',
        'salt'     => 'hex-salt-from-make-config',
        'hash'     => 'hex-hash-from-make-config',
    ],

    // Optional: email me when a school signs up.
    // 'NOTIFY_EMAIL' => 'you@example.com',
];
