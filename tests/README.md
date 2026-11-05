# Tests

`api.selftest.mjs` checks the whole server: signup rules, many schools in one database, school isolation,
trial / payment / expiry rules, roles, throttling, the developer-only routes (including editing a school's details), the country-code rule on signup, and the forgot-password flow (178 checks; 152 without the pretend mail server).

**Run it only against a throwaway test server — never the live site** (it creates schools and uses up the signup quota).

## What you need
- Node 18+ and PHP 8.2 (with `pdo_sqlite`, or `pdo_mysql` for MySQL/MariaDB).
- A throwaway developer account on the test server: username `dev`, password `test-platform-pass`
  (set `SMS_PLATFORM_USER`, `SMS_PLATFORM_SALT`, `SMS_PLATFORM_HASH` — salt/hash made the same way as `tools/make-config.js`).

## Run (SQLite)
```bash
export SMS_APP_SECRET=any-long-test-string SMS_DB_DRIVER=sqlite SMS_SQLITE_PATH=/tmp/test.sqlite
php -S 127.0.0.1:8081 -t app          # (or any server that serves app/ and app/api/index.php)
PHP_BIN=php SQLITE_DB=/tmp/test.sqlite node tests/api.selftest.mjs
```

## Run (MySQL / MariaDB)
Create an empty database and user, import `app/api/schema.mysql.sql` (or an older copy, to rehearse an upgrade), then:
```bash
export SMS_DB_DRIVER=mysql SMS_DB_HOST="127.0.0.1;port=3307" SMS_DB_NAME=zt_test SMS_DB_USER=zt SMS_DB_PASS=...
MYSQL_CMD=/path/to/mysql MYSQL_ARGS="-uroot -h127.0.0.1 -P3307 zt_test" node tests/api.selftest.mjs http://127.0.0.1:8083/api/index.php
```

## Testing the password-reset emails
The reset emails are sent with PHP's normal `mail()`. To read them in a test, run the pretend mail server and point PHP at it:
```bash
node tests/smtp-sink.mjs /tmp/mails 2525      # saves every email PHP sends as a text file; delivers nothing
# in php.ini:  SMTP = 127.0.0.1   smtp_port = 2525   sendmail_from = no-reply@zetclass.com
MAIL_DIR=/tmp/mails PHP_BIN=php SQLITE_DB=/tmp/test.sqlite node tests/api.selftest.mjs
```
Without `MAIL_DIR` that section is skipped.

Every line should say `ok`; the last line should say `178 passed, 0 failed` (`152 passed` when `MAIL_DIR` is not set).
The sample-data screens (js/sample-data.js) run in the browser, so they are checked by hand: sign up with the box ticked, open every module, then use Settings → Sample Data to remove and add groups.
Run it before every upload to the live server.
