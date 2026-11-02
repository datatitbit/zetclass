-- ============================================================
-- schema.mysql.sql — MySQL schema for cPanel deployment.
--
-- PART A: operational tables used by the live REST API.
--         (The single-page app talks to these via api/index.php.
--          They are auto-created on first run; this file lets a
--          DBA create them manually if preferred.)
-- PART B: normalised relational reference schema that mirrors the
--         data model in the brief (section 20), tenant-aware.
--         Provided for schools/DBAs and future server-side modules.
-- Charset utf8mb4 throughout.
-- ============================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------- PART A: operational document store ----------
-- Mirrors db.php's auto-create schema exactly (that PHP code is the live
-- source of truth; this file just lets a DBA create the same tables by
-- hand). All tables are tenant-tagged; singletons/meta_seq are keyed
-- by (school_id, name)/(school_id, kind) so per-school settings and ID
-- counters never collide across schools sharing this database.

-- trial_ends_at is the SERVER-side source of truth for a school's free trial
-- (YYYY-MM-DD, or NULL for a fully paid school). It deliberately does NOT
-- live in the school's own data, so a school cannot extend its own trial.
-- paid_until: end of the period a school has paid for (NULL while on a free trial).
-- email / phone / contact_name: captured at signup, shown only in the developer console.
-- created_via: 'self-signup' or 'platform'.   notes: the developer's private notes.
-- email and phone are UNIQUE (one school per email / phone; NULLs are ignored).
CREATE TABLE IF NOT EXISTS schools (
  id            VARCHAR(40)  PRIMARY KEY,
  name          VARCHAR(160) NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'active',
  plan          VARCHAR(40)  NULL,
  created_at    VARCHAR(30)  NULL,
  trial_ends_at VARCHAR(30)  NULL,
  paid_until    VARCHAR(30)  NULL,
  email         VARCHAR(160) NULL,
  phone         VARCHAR(40)  NULL,
  contact_name  VARCHAR(120) NULL,
  created_via   VARCHAR(20)  NULL,
  notes         VARCHAR(500) NULL,
  UNIQUE KEY uq_schools_email (email),
  UNIQUE KEY uq_schools_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS documents (
  id         VARCHAR(80)  NOT NULL,
  collection VARCHAR(60)  NOT NULL,
  school_id  VARCHAR(40)  NOT NULL,
  data       LONGTEXT     NULL,
  -- The key INCLUDES school_id so two schools can each own a record with the same id
  -- (e.g. every school has a class "cl-b1"). It used to be (collection, id) only.
  PRIMARY KEY (school_id, collection, id),
  KEY idx_docs_coll_school (collection, school_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS singletons (
  school_id VARCHAR(40) NOT NULL,
  name      VARCHAR(60) NOT NULL,
  data      LONGTEXT    NULL,
  PRIMARY KEY (school_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS meta_seq (
  school_id VARCHAR(40) NOT NULL,
  kind      VARCHAR(40) NOT NULL,
  val       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (school_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Schema version marker + sign-in/signup throttle (both created automatically by api/db.php too).
CREATE TABLE IF NOT EXISTS app_meta (k VARCHAR(40) PRIMARY KEY, v VARCHAR(40) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS rate_limits (
  k VARCHAR(120) PRIMARY KEY, window_start INT NOT NULL, hits INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit trail for EVERY platform (owner) action: provision,
-- status change, trial change, plan change, reset, per-user enable/disable
-- and impersonation. Written by api/index.php's audit() helper; never
-- updated or deleted by the app.
--   action    -- provision | status | trial | plan | reset
--               | user_disable | user_enable | impersonate
--   target_id -- the user id, where the action targets one account
--   detail    -- JSON blob of action-specific before/after values
CREATE TABLE IF NOT EXISTS platform_audit (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  platform_uid  VARCHAR(60) NOT NULL,
  action        VARCHAR(40) NOT NULL,
  school_id     VARCHAR(40) NULL,
  target_id     VARCHAR(80) NULL,
  detail        LONGTEXT    NULL,
  created_at    VARCHAR(30) NOT NULL,
  KEY idx_audit_school (school_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- PART B: normalised relational reference model ----------
-- NOTE: the tenant registry table is `schools` from PART A above (id, name,
-- status, plan, created_at, trial_ends_at) — it is NOT redefined here. A
-- previous version of this file declared a second, richer
-- `CREATE TABLE IF NOT EXISTS schools` here; because MySQL's IF NOT EXISTS is
-- a silent no-op on a name collision, running this file top-to-bottom would
-- have created PART A's schools table first and quietly dropped every extra
-- column below (motto, address, phone, whatsapp, email, website, logo,
-- currency). Fixed by removing the duplicate; add those as a future
-- `school_profiles(school_id VARCHAR(40) PRIMARY KEY REFERENCES schools(id),
-- motto, address, ...)` table if/when PART B's normalised model is actually
-- wired up. All FKs below reference PART A's schools(id) (same VARCHAR(40)
-- type), so nothing else needs to change.

CREATE TABLE IF NOT EXISTS academic_years (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  year VARCHAR(20) NOT NULL, current_term INT DEFAULT 1, promotional_term INT DEFAULT 3,
  FOREIGN KEY (school_id) REFERENCES schools(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS terms (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, year_id VARCHAR(40) NOT NULL,
  n INT NOT NULL, name VARCHAR(40), vacation DATE NULL, reopening DATE NULL,
  FOREIGN KEY (year_id) REFERENCES academic_years(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, name VARCHAR(80) NOT NULL, sort INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_templates (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, kind CHAR(1) NOT NULL,
  name VARCHAR(80), config LONGTEXT  -- blocks/fields/labels as JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS classes (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, category_id VARCHAR(40),
  name VARCHAR(80) NOT NULL, template CHAR(1) DEFAULT 'B', sort INT DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subjects (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, class_id VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL, sort INT DEFAULT 0,
  FOREIGN KEY (class_id) REFERENCES classes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS parents (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, name VARCHAR(140) NOT NULL,
  phone VARCHAR(60), whatsapp VARCHAR(60), email VARCHAR(120)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS students (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  first_name VARCHAR(80), last_name VARCHAR(80), gender CHAR(1), dob DATE NULL,
  class_id VARCHAR(40), parent_id VARCHAR(40) NULL, status VARCHAR(16) DEFAULT 'active',
  admitted_on DATE NULL, promoted_to VARCHAR(80) NULL,
  UNIQUE KEY uniq_code (school_id, student_id),
  FOREIGN KEY (class_id) REFERENCES classes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS parent_student (
  parent_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  PRIMARY KEY (parent_id, student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staff (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, staff_id VARCHAR(12) NOT NULL,
  name VARCHAR(140), role VARCHAR(40), phone VARCHAR(60),
  basic_salary DECIMAL(10,2) DEFAULT 0, allowances DECIMAL(10,2) DEFAULT 0,
  employee_type VARCHAR(20) DEFAULT 'Full-time',    -- Full-time | Part-time | Other
  payment_method VARCHAR(10) DEFAULT 'Bank',        -- Bank | MoMo | Cash
  payroll_overrides LONGTEXT NULL,                  -- {fieldKey:{enabled,value}} JSON
  UNIQUE KEY uniq_staff (school_id, staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Finalised payroll runs (line detail stored as JSON snapshot).
CREATE TABLE IF NOT EXISTS payroll_runs (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  month CHAR(7), status VARCHAR(16), created_on DATE, created_by VARCHAR(120),
  total_net DECIMAL(12,2), total_employer_cost DECIMAL(12,2),
  settings_snapshot LONGTEXT, `lines` LONGTEXT   -- `lines` is a reserved word in MySQL: it MUST stay in backticks
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staff_classes (
  staff_id VARCHAR(40) NOT NULL, class_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (staff_id, class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- NOTE: in the live document store, a user's "disabled" flag lives inside the
-- users document JSON (set from the owner console via POST ?r=platform/user).
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, name VARCHAR(140),
  username VARCHAR(60), password_hash VARCHAR(255) NULL, role VARCHAR(40), staff_id VARCHAR(12) NULL,
  disabled TINYINT(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS grade_bands (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  grade VARCHAR(8), min_pct INT, max_pct INT, remark VARCHAR(60)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scores (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  class_id VARCHAR(40), subject VARCHAR(120), term INT, class_score DECIMAL(5,2) NULL, exam_score DECIMAL(5,2) NULL,
  KEY idx_lookup (class_id, term, subject)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fee_types (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, name VARCHAR(120),
  amount DECIMAL(10,2), applies_to VARCHAR(40) DEFAULT 'all', frequency VARCHAR(16) DEFAULT 'per_term', required TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS invoices (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  class_id VARCHAR(40), term INT, fee_type_id VARCHAR(40), fee_name VARCHAR(120), amount DECIMAL(10,2), created_on DATE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  term INT, amount DECIMAL(10,2), method VARCHAR(30), reference VARCHAR(60), gateway_ref VARCHAR(80) NULL,
  receipt_no VARCHAR(60), created_on DATE, created_by VARCHAR(120)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attendance (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  class_id VARCHAR(40), adate DATE, status VARCHAR(10),
  KEY idx_class_date (class_id, adate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conduct (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  class_id VARCHAR(40), cdate DATE, note TEXT, created_by VARCHAR(120)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS checklists (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, student_id VARCHAR(12) NOT NULL,
  class_id VARCHAR(40), term INT, marks LONGTEXT  -- indicator->rating JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inventory_categories (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, name VARCHAR(80)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Item Master (section 1). qty is a rollup of inventory_stock.qoh.
CREATE TABLE IF NOT EXISTS inventory_items (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  sku VARCHAR(60), name VARCHAR(120),
  inventory_type VARCHAR(12) DEFAULT 'resale',   -- 'resale' | 'asset'
  category VARCHAR(80), target_class VARCHAR(40) NULL,
  cost_price DECIMAL(10,2) NULL, selling_price DECIMAL(10,2) NULL,
  unit VARCHAR(30), unit_cost DECIMAL(10,2) NULL, low_threshold INT DEFAULT 0,
  qty INT DEFAULT 0,
  supplier_name VARCHAR(120) NULL, supplier_contact VARCHAR(120) NULL, supplier_location VARCHAR(120) NULL,
  archived TINYINT(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Stock Levels (section 2). available = qoh - allocated.
CREATE TABLE IF NOT EXISTS inventory_stock (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  item_id VARCHAR(40) NOT NULL, item_name VARCHAR(120), location VARCHAR(80),
  qoh INT DEFAULT 0, allocated INT DEFAULT 0, reorder_level INT DEFAULT 0,
  batch_no VARCHAR(60) NULL, batch_expiry DATE NULL, archived TINYINT(1) DEFAULT 0,
  KEY idx_item_loc (item_id, location)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Allocation & Sales Logistics (section 3).
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  txn_id VARCHAR(30), type VARCHAR(16),           -- 'restock' | 'sale' | 'staff_issue'
  item_id VARCHAR(40), item_name VARCHAR(120), qty INT,
  recipient_id VARCHAR(60) NULL,                  -- student_id / staff_id / supplier ref
  payment_status VARCHAR(60), amount DECIMAL(10,2) DEFAULT 0,
  branch_route VARCHAR(80) NULL, tdate DATE, created_by VARCHAR(120), archived TINYINT(1) DEFAULT 0,
  KEY idx_type_date (type, tdate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Inventory Audit (section 4) — immutable delta ledger.
CREATE TABLE IF NOT EXISTS inventory_audit (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL,
  log_id VARCHAR(40), ts DATETIME, item_id VARCHAR(40), item_name VARCHAR(120),
  qty_change INT, reason_code VARCHAR(80), audit_user VARCHAR(120), snapshot VARCHAR(120) NULL,
  KEY idx_reason (reason_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Legacy simple movement log (kept for backward compatibility).
CREATE TABLE IF NOT EXISTS stock_movements (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, item_id VARCHAR(40),
  item_name VARCHAR(120), type VARCHAR(4), qty INT, note VARCHAR(200), mdate DATE, created_by VARCHAR(120)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS announcements (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, title VARCHAR(160), body TEXT, created_at DATETIME, created_by VARCHAR(120)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, recipient VARCHAR(60), body TEXT,
  channel VARCHAR(16), status VARCHAR(30), sent_at DATETIME, created_by VARCHAR(120)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS message_templates (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, name VARCHAR(80), body TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS permissions (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, role VARCHAR(40), perms LONGTEXT  -- module->bool JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  id VARCHAR(40) PRIMARY KEY, school_id VARCHAR(40) NOT NULL, skey VARCHAR(60), data LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
