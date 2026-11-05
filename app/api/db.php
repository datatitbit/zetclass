<?php
/* ============================================================
 * db.php — PDO connection + schema bootstrap + first-run seed.
 *
 * Multi-tenant document store. Every row is tagged with school_id and
 * the API filters every query by the school in the request's token:
 *   schools(id, name, status, plan, created_at,
 *           trial_ends_at)                            -- tenant registry
 *   documents(id, collection, school_id, data)       -- array collections
 *   singletons(school_id, name, data)                -- per-school settings
 *   meta_seq(school_id, kind, val)                    -- per-school counters
 *   platform_audit(...)                               -- owner-action audit log
 *
 * NOTE ON MIGRATION: the singletons/meta_seq tables are now keyed by
 * school_id. A database created by the OLD schema (name-only PK) must be
 * migrated or rebuilt before use — see README-ISOLATION.md.
 * ============================================================ */

// Free-trial length given to a newly provisioned school, in days. Mirrors
// license-lib.js's TRIAL_DAYS default; the owner can override per school.
if (!defined('DEFAULT_TRIAL_DAYS')) { define('DEFAULT_TRIAL_DAYS', 30); }

// Bump when the table layout changes. db_connect() only re-runs the (slow)
// schema setup when the database reports an older version, instead of running
// ~20 CREATE/ALTER statements on every single request like it used to.
if (!defined('SCHEMA_VERSION')) { define('SCHEMA_VERSION', 6); }

/* One school per NAME. Two names count as the same school when they match after ignoring
 * capital letters, spaces, punctuation and apostrophes ("St. Mary's" = "st marys" = "ST MARYS").
 * Stored in schools.name_key, which has a UNIQUE index so the database itself refuses a clash. */
function school_name_key($name) {
    $s = function_exists('mb_strtolower') ? mb_strtolower((string)$name, 'UTF-8') : strtolower((string)$name);
    $s = preg_replace('/[^\p{L}\p{N}]+/u', '', $s);
    return substr((string)$s, 0, 150);
}

function db_connect($cfg) {
    if ($cfg['DB_DRIVER'] === 'mysql') {
        $dsn = "mysql:host={$cfg['MYSQL_HOST']};dbname={$cfg['MYSQL_NAME']};charset={$cfg['MYSQL_CHARSET']}";
        $pdo = new PDO($dsn, $cfg['MYSQL_USER'], $cfg['MYSQL_PASS'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $jsonType = 'LONGTEXT';
    } else {
        $dir = dirname($cfg['SQLITE_PATH']);
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        $pdo = new PDO('sqlite:' . $cfg['SQLITE_PATH'], null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $jsonType = 'TEXT';
    }

    if (!db_schema_is_current($pdo)) { db_bootstrap_schema($pdo, $cfg['DB_DRIVER'], $jsonType); }

    // First-run demo school. OFF by default on a real server: an auto-created
    // demo school ("sch-1", admin / 123) would be a publicly known login on
    // your live system. Turn on with SMS_SEED_DEMO=1 (or 'SEED_DEMO_ON_EMPTY'
    // => true in config.local.php) for local development and training.
    if (!empty($cfg['SEED_DEMO_ON_EMPTY'])) { db_seed_if_empty($pdo, $cfg['SCHOOL_ID']); }
    return $pdo;
}

function db_schema_is_current($pdo) {
    try {
        $r = $pdo->query("SELECT v FROM app_meta WHERE k='schema_version'")->fetch();
        return $r && (int)$r['v'] >= SCHEMA_VERSION;
    } catch (Throwable $e) { return false; } // app_meta missing = brand-new or pre-v3 database
}

/* Creates every table and applies every additive migration. Safe to run any
 * number of times (each step is idempotent). */
function db_bootstrap_schema($pdo, $driver, $jsonType) {
    $isMysql = ($driver === 'mysql');
    // MySQL: InnoDB (so the all-or-nothing transactions really are all-or-nothing) and
    // utf8mb4 (so names like St. Mary’s or Ghanaian-language text store correctly).
    $tbl = $isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
    $pdo->exec("CREATE TABLE IF NOT EXISTS app_meta (k VARCHAR(40) PRIMARY KEY, v VARCHAR(40) NOT NULL)$tbl");

    // trial_ends_at: SERVER-side free-trial end (replaces the old browser clock
    // a school could reset by clearing its own storage).
    // paid_until: end of the period the school has paid for (NULL on a trial).
    // email / phone / contact_name: who to reach about this school (captured
    // at signup, visible only in the developer console).
    // created_via: 'self-signup' or 'platform'. notes: developer's private notes.
    $pdo->exec("CREATE TABLE IF NOT EXISTS schools (
        id VARCHAR(40) PRIMARY KEY,
        name VARCHAR(160),
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        plan VARCHAR(40),
        created_at VARCHAR(30),
        trial_ends_at VARCHAR(30),
        paid_until VARCHAR(30),
        email VARCHAR(160),
        phone VARCHAR(40),
        contact_name VARCHAR(120),
        created_via VARCHAR(20),
        notes VARCHAR(500),
        name_key VARCHAR(160)
    )$tbl");
    // The key INCLUDES school_id. It used to be (collection, id) alone, which
    // meant two schools could not both own a record called e.g. "cl-b1" or
    // "u-admin" - so a second school could never be added. See migration below.
    $pdo->exec("CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(80) NOT NULL,
        collection VARCHAR(60) NOT NULL,
        school_id VARCHAR(40) NOT NULL,
        data $jsonType,
        PRIMARY KEY (school_id, collection, id)
    )$tbl");
    $pdo->exec("CREATE TABLE IF NOT EXISTS singletons (
        school_id VARCHAR(40) NOT NULL,
        name VARCHAR(60) NOT NULL,
        data $jsonType,
        PRIMARY KEY (school_id, name)
    )$tbl");
    $pdo->exec("CREATE TABLE IF NOT EXISTS meta_seq (
        school_id VARCHAR(40) NOT NULL,
        kind VARCHAR(40) NOT NULL,
        val INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (school_id, kind)
    )$tbl");
    // Append-only audit trail for EVERY platform (owner) action - provisioning,
    // suspending, resetting, trial/plan/payment changes, per-user enable/disable
    // and impersonation. Never updated or deleted by the app.
    $auditPk = $isMysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    $pdo->exec("CREATE TABLE IF NOT EXISTS platform_audit (
        id $auditPk,
        platform_uid VARCHAR(60) NOT NULL,
        action VARCHAR(40) NOT NULL,
        school_id VARCHAR(40),
        target_id VARCHAR(80),
        detail $jsonType,
        created_at VARCHAR(30) NOT NULL
    )$tbl");
    // "Forgot password" requests. The emailed link carries a random token; only its
    // SHA-256 fingerprint is stored here, so a copy of this table can't be used to
    // reset anyone's password. status: open -> used (link used) | handled (developer
    // issued a temporary password, or dismissed it).
    $pdo->exec("CREATE TABLE IF NOT EXISTS password_resets (
        id $auditPk,
        school_id VARCHAR(40) NOT NULL,
        user_id VARCHAR(80) NOT NULL,
        username VARCHAR(60),
        token_hash VARCHAR(64),
        expires_at INT NOT NULL,
        requested_at VARCHAR(30) NOT NULL,
        email_sent TINYINT NOT NULL DEFAULT 0,
        status VARCHAR(12) NOT NULL DEFAULT 'open'
    )$tbl");
    // Fixed-window throttle used by login and signup (see rate_limit() in index.php).
    $pdo->exec("CREATE TABLE IF NOT EXISTS rate_limits (
        k VARCHAR(120) PRIMARY KEY,
        window_start INT NOT NULL,
        hits INT NOT NULL DEFAULT 0
    )$tbl");

    // ---- Additive migrations (idempotent) ----
    // ALTER ... ADD COLUMN throws when the column exists on both MySQL and
    // SQLite; that failure is the "already migrated" case, so it is ignored.
    foreach ([
        'trial_ends_at VARCHAR(30)', 'paid_until VARCHAR(30)', 'email VARCHAR(160)',
        'phone VARCHAR(40)', 'contact_name VARCHAR(120)', 'created_via VARCHAR(20)', 'notes VARCHAR(500)', 'name_key VARCHAR(160)',
    ] as $colDef) {
        try { $pdo->exec("ALTER TABLE schools ADD COLUMN $colDef"); } catch (Throwable $e) {}
    }
    // Fill the name key for schools that existed before it did. If two old schools already share a
    // name, only the first gets the key (the other stays NULL), so the unique index below can still be built.
    try {
        foreach ($pdo->query("SELECT id, name FROM schools WHERE name_key IS NULL")->fetchAll() as $r) {
            try { $pdo->prepare("UPDATE schools SET name_key=? WHERE id=?")->execute([school_name_key($r['name']), $r['id']]); } catch (Throwable $e) {}
        }
    } catch (Throwable $e) {}

    db_migrate_documents_pk($pdo, $isMysql, $jsonType);

    // One school per email and per phone number, enforced by the DATABASE (not
    // just the signup form's pre-check), so two simultaneous signups cannot both
    // get through. Empty values are stored as NULL, which a unique index ignores.
    foreach ([
        "CREATE INDEX idx_docs_coll_school ON documents (collection, school_id)",
        "CREATE INDEX idx_audit_school ON platform_audit (school_id)",
        "CREATE UNIQUE INDEX uq_schools_email ON schools (email)",
        "CREATE UNIQUE INDEX uq_schools_phone ON schools (phone)",
        "CREATE UNIQUE INDEX uq_schools_name_key ON schools (name_key)",
        "CREATE INDEX idx_pwreset_token ON password_resets (token_hash)",
        "CREATE INDEX idx_pwreset_school ON password_resets (school_id)",
    ] as $ix) { try { $pdo->exec($ix); } catch (Throwable $e) {} }

    $pdo->prepare($isMysql ? "REPLACE INTO app_meta(k,v) VALUES('schema_version', ?)" : "INSERT OR REPLACE INTO app_meta(k,v) VALUES('schema_version', ?)")
        ->execute([(string)SCHEMA_VERSION]);
}

/* Databases created before schema v3 have PRIMARY KEY (collection, id). Rebuild
 * the key as (school_id, collection, id) without losing a single row. */
function db_migrate_documents_pk($pdo, $isMysql, $jsonType) {
    $hasSchoolInKey = false;
    if ($isMysql) {
        $st = $pdo->query("SELECT COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='documents' AND CONSTRAINT_NAME='PRIMARY'");
        foreach ($st->fetchAll() as $r) { if ($r['c'] === 'school_id') { $hasSchoolInKey = true; } }
        if (!$hasSchoolInKey) { $pdo->exec("ALTER TABLE documents DROP PRIMARY KEY, ADD PRIMARY KEY (school_id, collection, id)"); }
        return;
    }
    foreach ($pdo->query("PRAGMA table_info(documents)")->fetchAll() as $r) {
        if ($r['name'] === 'school_id' && (int)$r['pk'] > 0) { $hasSchoolInKey = true; }
    }
    if ($hasSchoolInKey) { return; }
    // SQLite cannot change a primary key in place: copy into a new table.
    $pdo->beginTransaction();
    try {
        $pdo->exec("ALTER TABLE documents RENAME TO documents_old");
        $pdo->exec("CREATE TABLE documents (id VARCHAR(80) NOT NULL, collection VARCHAR(60) NOT NULL, school_id VARCHAR(40) NOT NULL, data $jsonType, PRIMARY KEY (school_id, collection, id))");
        $pdo->exec("INSERT INTO documents(id,collection,school_id,data) SELECT id,collection,school_id,data FROM documents_old");
        $pdo->exec("DROP TABLE documents_old");
        $pdo->commit();
    } catch (Throwable $e) { if ($pdo->inTransaction()) { $pdo->rollBack(); } throw $e; }
}

// Stamps a settings object with its school. A settings value that is a LIST
// (e.g. the admission-form fields) must be left as a list: adding a "school_id"
// key to it silently turns it into an object, and the app then ignores it and
// falls back to the factory defaults, throwing away the school's own edits.
function tag_school($val, $school) {
    if (is_array($val) && $val !== array_values($val)) { $val['school_id'] = $school; }
    return $val;
}

// The starter permission table is keyed by role name ({"Teacher": {"Dashboard": true, ...}}),
// but the app stores it as one row per role ({role, perms}). Seeding it as plain rows
// dropped the role names, so every role except Admin ended up with NO access at all.
function db_permissions_rows($school, $perms) {
    if (!is_array($perms) || $perms === array_values($perms)) { return $perms; } // already rows
    $rows = [];
    foreach ($perms as $role => $map) {
        $rows[] = ['id' => 'perm-' . strtolower(preg_replace('/[^A-Za-z0-9]+/', '-', $role)), 'school_id' => $school, 'role' => $role, 'perms' => $map];
    }
    return $rows;
}

// Collections that are single objects (one per school).
function db_singletons() {
    return ['school', 'academic', 'idRules', 'admissionFields', 'weighting', 'labels', 'payrollSettings', 'automation', 'inventorySettings', 'dashboardSettings', 'demoSettings'];
}

// Seed a brand-new database with the default school, only if empty.
function db_seed_if_empty($pdo, $defaultSchool) {
    $count = (int)$pdo->query("SELECT COUNT(*) c FROM schools")->fetch()['c'];
    if ($count > 0) { return; } // already has at least one school
    $seed = db_load_seed();
    if (!$seed) { return; }
    $name = isset($seed['school']['name']) ? $seed['school']['name'] : 'School';
    db_seed_school($pdo, $defaultSchool, $seed, $name);
}

function db_load_seed() {
    $seedPath = __DIR__ . '/seed.json';
    if (!file_exists($seedPath)) { return null; }
    $seed = json_decode(file_get_contents($seedPath), true);
    return $seed ?: null;
}

/* Removes everything that only makes sense in the shared DEMO school: the five
 * demo logins (public password 123), the sample pupils/parents/staff, sample
 * stock, and any record tagged is_demo. What remains is the structural
 * starter kit a real school needs on day one: classes, fee types, grading,
 * report templates, permissions, labels, payroll rules, and so on. */
function db_strip_demo($seed) {
    foreach (['users', 'students', 'parents', 'staff', 'inventoryItems', 'inventoryStock',
              'inventoryTransactions', 'inventoryAudit', 'stockMovements', 'scores', 'attendance',
              'staffAttendance', 'studentRemarks', 'conduct', 'checklists', 'invoices', 'payments',
              'messages', 'announcements', 'expenses', 'otherIncome', 'payrollRuns', 'automationLog'] as $k) {
        if (isset($seed[$k])) { $seed[$k] = []; }
    }
    foreach ($seed as $k => $v) {
        // Lists only (not keyed singletons): drop any leftover is_demo record.
        if (is_array($v) && $v === array_values($v)) {
            $seed[$k] = array_values(array_filter($v, function ($r) { return !is_array($r) || empty($r['is_demo']); }));
        }
    }
    $seed['meta'] = ['seq' => ['student' => 0, 'staff' => 0, 'invtxn' => 0]];
    return $seed;
}

/* A sensible Ghana-style calendar for a school created TODAY, so a school
 * signing up in October does not open on last year's "Third Term". Term 1 runs
 * Sept-Dec, Term 2 Jan-Apr, Term 3 Apr-Jul. Fully editable in Settings. */
function db_default_academic($school, $ts = null) {
    $ts = $ts ?: time();
    $y = (int)gmdate('Y', $ts); $m = (int)gmdate('n', $ts);
    $start = ($m >= 8) ? $y : $y - 1;                 // academic year starts in September
    $term  = ($m >= 8) ? 1 : (($m <= 3) ? 2 : 3);     // Aug-Dec: T1 · Jan-Mar: T2 · Apr-Jul: T3
    $end = $start + 1;
    return [
        'id' => 'ay-1', 'school_id' => $school,
        'year' => $start . '/' . $end,
        'current_term' => $term,
        'promotional_term' => 3,
        'terms' => [
            ['n' => 1, 'name' => 'First Term',  'vacation' => "$start-12-19", 'reopening' => "$end-01-06"],
            ['n' => 2, 'name' => 'Second Term', 'vacation' => "$end-04-02",   'reopening' => "$end-04-28"],
            ['n' => 3, 'name' => 'Third Term',  'vacation' => "$end-07-24",   'reopening' => "$end-09-09"],
        ],
    ];
}

/* Insert/replace all default data for one school under $school id.
 * Used for first-run seeding, for the developer's "Add school", and for
 * self-service signup.
 *
 * $opts:
 *   demo         true  = keep the demo roster + demo logins (training/testing only)
 *                false = REAL school: clean starter kit + ONE Admin login (default)
 *   admin        ['name','username','password','must_change'] — the real school's
 *                first login (required when demo is false)
 *   email, phone, contact_name, created_via — recorded on the registry row
 *   trial_days   length of the free trial (default DEFAULT_TRIAL_DAYS)
 * Callers that want all-or-nothing behaviour wrap this in a transaction. */
function db_seed_school($pdo, $school, $seed, $name = null, $opts = []) {
    if (!$seed) { $seed = db_load_seed(); }
    if (!$seed) { return; }
    $demo = !empty($opts['demo']) || (!array_key_exists('demo', $opts) && !array_key_exists('admin', $opts));
    $trialDays = isset($opts['trial_days']) ? max(1, (int)$opts['trial_days']) : DEFAULT_TRIAL_DAYS;
    $schoolName = $name ?: ($seed['school']['name'] ?? 'School');

    if (!$demo) {
        $seed = db_strip_demo($seed);
        $seed['academic'] = db_default_academic($school);
        // Replace the demo school's profile with this school's own details and
        // blank out the placeholders (they would otherwise print on every report).
        $sch = isset($seed['school']) && is_array($seed['school']) ? $seed['school'] : [];
        $sch['name']     = $schoolName;
        $sch['email']    = $opts['email'] ?? '';
        $sch['phone']    = $opts['phone'] ?? '';
        $sch['whatsapp'] = '';
        foreach (['motto', 'address', 'location', 'website', 'logo', 'signature', 'stamp'] as $k) { $sch[$k] = ''; }
        $sch['theme_enabled'] = false;
        $seed['school'] = $sch;
        $seed['demoSettings'] = ['id' => 'demo-1', 'school_id' => $school, 'demo_login_enabled' => false];

        $a = $opts['admin'] ?? [];
        $salt = bin2hex(random_bytes(16));
        $adminName = trim((string)($a['name'] ?? '')) ?: 'School Administrator';
        $seed['users'] = [[
            'id' => 'u-admin', 'school_id' => $school, 'name' => $adminName,
            'username' => $a['username'] ?? 'admin', 'role' => 'Admin', 'staff_id' => 'SF0001',
            'linked_student_ids' => [],
            'password_salt' => $salt, 'password_hash' => pbkdf2_hex((string)($a['password'] ?? ''), $salt),
            'must_change_password' => !empty($a['must_change']),
        ]];
        // The Admin is also staff #1 so payroll/attendance have a matching record.
        $seed['staff'] = [[
            'id' => 'st-1', 'school_id' => $school, 'staff_id' => 'SF0001', 'name' => $adminName,
            'role' => 'Admin', 'phone' => $opts['phone'] ?? '', 'class_ids' => [], 'subject_teacher_of' => [],
            'dashboard_full_access' => false, 'basic_salary' => 0, 'allowances' => 0,
            'employee_type' => 'Full-time', 'payment_method' => 'Cash', 'payroll_overrides' => [],
        ]];
        $seed['meta'] = ['seq' => ['student' => 0, 'staff' => 1, 'invtxn' => 0]];
    }

    // Registry row. A brand-new school starts on a server-side free trial:
    // $trialDays from today, recorded as trial_ends_at. The owner can
    // extend, shorten or clear it later from the platform dashboard.
    // IMPORTANT: a school with data but NO registry row is treated as a legacy
    // install = active forever, free (see school_active()). So a failed insert
    // here must stop everything (the caller's transaction then rolls back); it
    // must never be swallowed. Only a school that is ALREADY registered (a reset
    // re-seeding its data, or the first-run demo) skips the insert.
    $exists = $pdo->prepare("SELECT id FROM schools WHERE id=?");
    $exists->execute([$school]);
    if (!$exists->fetch()) {
        $reg = $pdo->prepare("INSERT INTO schools(id,name,status,plan,created_at,trial_ends_at,email,phone,contact_name,created_via,name_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
        $reg->execute([
            $school,
            $schoolName,
            'active',
            'basic',
            gmdate('c'),
            gmdate('Y-m-d', time() + ($trialDays * 86400)),
            ($opts['email'] ?? '') !== '' ? $opts['email'] : null,   // empty -> NULL so the unique index ignores it
            ($opts['phone'] ?? '') !== '' ? $opts['phone'] : null,
            ($opts['contact_name'] ?? '') !== '' ? $opts['contact_name'] : null,
            $opts['created_via'] ?? 'platform',
            school_name_key($schoolName),
        ]);
    }

    if (isset($seed['permissions'])) { $seed['permissions'] = db_permissions_rows($school, $seed['permissions']); }
    $singletons = db_singletons();
    $insDoc = $pdo->prepare("INSERT INTO documents(id,collection,school_id,data) VALUES(?,?,?,?)");
    $insOne = $pdo->prepare("REPLACE INTO singletons(school_id,name,data) VALUES(?,?,?)");

    foreach ($seed as $key => $val) {
        if ($key === 'meta' || $key === 'constants') { continue; }
        if (in_array($key, $singletons)) {
            $val = tag_school($val, $school);
            $insOne->execute([$school, $key, json_encode($val)]);
        } elseif (is_array($val)) {
            foreach ($val as $rec) {
                if (!is_array($rec)) { continue; }
                $id = isset($rec['id']) ? $rec['id'] : uniqid($key . '-');
                $rec['id'] = $id;
                $rec['school_id'] = $school; // force tenant tag
                $insDoc->execute([$id, $key, $school, json_encode($rec)]);
            }
        }
    }

    $insSeq = $pdo->prepare("REPLACE INTO meta_seq(school_id,kind,val) VALUES(?,?,?)");
    if (isset($seed['meta']['seq'])) {
        foreach ($seed['meta']['seq'] as $kind => $v) { $insSeq->execute([$school, $kind, (int)$v]); }
    }
}
