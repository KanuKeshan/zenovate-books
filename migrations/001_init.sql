-- ClaraBooks core schema.
--
-- Shape rule: anything two people can edit at the same time, or that anyone will
-- ever need to query or report on, is a real table. Everything else — the
-- long-tail feature state the MVP defers — lives in one JSONB column so no
-- existing screen breaks while it waits its turn.
--
-- Money is NUMERIC(18,2). Never float. A cent lost to binary rounding is a
-- reconciliation that never ties and an afternoon nobody gets back.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── identity ───────────────────────────────────────────────────────────────
-- Passwords are Cognito's problem by design; this table holds only the subject
-- claim, so a full dump of this database leaks no credential material.
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub   TEXT UNIQUE NOT NULL,
  -- Plain TEXT with a lower() unique index below, rather than the citext
  -- extension: one less extension to exist on RDS, same guarantee.
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE firms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE firm_members (
  firm_id   UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner','accountant','readonly')),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (firm_id, user_id)
);

-- ─── businesses ─────────────────────────────────────────────────────────────
CREATE TABLE businesses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'Service-based',
  data_source   TEXT NOT NULL DEFAULT 'ledger'
                  CHECK (data_source IN ('ledger','statements')),
  currency      TEXT NOT NULL DEFAULT '$',
  color         TEXT NOT NULL DEFAULT '#534AB7',
  logo          TEXT,
  address       TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  payment_instructions TEXT NOT NULL DEFAULT '',
  -- Bank details are entered by the user and never generated. Held here rather
  -- than in the JSONB blob so they can be excluded from exports deliberately.
  bank_name     TEXT NOT NULL DEFAULT '',
  account_name  TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  routing_number TEXT NOT NULL DEFAULT '',
  account_type  TEXT NOT NULL DEFAULT '',
  -- The deferred feature state: payroll, reimbursements, FP&A settings,
  -- statement data, checklists, category memory. Whole-object writes here are
  -- fine because only one screen at a time owns any of it.
  extras        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Optimistic locking. Every mutating write asserts the version it read and
  -- bumps it; a stale write is rejected rather than silently winning.
  version       BIGINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);
CREATE INDEX businesses_firm_idx ON businesses (firm_id) WHERE archived_at IS NULL;

-- Per-client access. A row here is the ONLY thing that grants a user sight of a
-- business; firm membership alone deliberately grants nothing, so adding a
-- bookkeeper for one client cannot accidentally expose the rest.
CREATE TABLE business_access (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','accountant','readonly')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  UUID REFERENCES users(id),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_access_user_idx ON business_access (user_id);

-- ─── chart of accounts ──────────────────────────────────────────────────────
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('income','expense','asset','liability','equity','revenueReturn')),
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_id, kind, name)
);
CREATE INDEX categories_business_idx ON categories (business_id);

-- ─── clients ────────────────────────────────────────────────────────────────
CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  tax_rate    NUMERIC(7,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

-- ─── invoices ───────────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ref          TEXT NOT NULL,                       -- human-facing number
  client_name  TEXT NOT NULL,
  client_id    UUID REFERENCES clients(id) ON DELETE SET NULL,
  issue_date   DATE NOT NULL,
  due_date     DATE,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'Revenue',
  amount       NUMERIC(18,2) NOT NULL,
  tax_rate     NUMERIC(7,4) NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('Paid','Sent','Pending','Overdue','Draft')),
  migrated     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, ref)
);
CREATE INDEX invoices_business_date_idx ON invoices (business_id, issue_date);
CREATE INDEX invoices_business_status_idx ON invoices (business_id, status);

-- ─── expenses ───────────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  spend_date   DATE NOT NULL,
  vendor       TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'Other',
  amount       NUMERIC(18,2) NOT NULL,
  deductible   BOOLEAN NOT NULL DEFAULT true,
  has_receipt  BOOLEAN NOT NULL DEFAULT false,
  receipt_key  TEXT,                                -- S3 object key, never bytes
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_business_date_idx ON expenses (business_id, spend_date);

-- ─── double entry ───────────────────────────────────────────────────────────
CREATE TABLE journal_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ref          TEXT NOT NULL,
  entry_date   DATE NOT NULL,
  entry_type   TEXT NOT NULL DEFAULT 'Manual',
  memo         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id),
  UNIQUE (business_id, ref)
);
CREATE INDEX journal_entries_business_date_idx ON journal_entries (business_id, entry_date);

CREATE TABLE journal_lines (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id  UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no   INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('asset','liability','equity','income','expense')),
  account   TEXT NOT NULL,
  debit     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  -- A line is one side or the other. Allowing both is how an entry balances on
  -- paper while meaning nothing.
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);

-- ─── bank ───────────────────────────────────────────────────────────────────
CREATE TABLE bank_txns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  txn_date     DATE NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  amount       NUMERIC(18,2) NOT NULL,             -- signed: negative is money out
  balance      NUMERIC(18,2),
  category     TEXT,
  matched      BOOLEAN NOT NULL DEFAULT false,
  posted       BOOLEAN NOT NULL DEFAULT false,
  source       TEXT NOT NULL DEFAULT '',
  -- Re-importing the same statement must not double the ledger. This is the
  -- fingerprint the importer dedupes on.
  dedupe_key   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedupe_key)
);
CREATE INDEX bank_txns_business_date_idx ON bank_txns (business_id, txn_date);

-- ─── opening balances ───────────────────────────────────────────────────────
CREATE TABLE opening_balances (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  as_of       DATE NOT NULL,
  cash        NUMERIC(18,2) NOT NULL DEFAULT 0,
  ar          NUMERIC(18,2) NOT NULL DEFAULT 0,
  ap          NUMERIC(18,2) NOT NULL DEFAULT 0,
  set_by      UUID REFERENCES users(id),
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── audit ──────────────────────────────────────────────────────────────────
-- Accounting software has to be able to answer "who changed this and when".
-- Append-only by convention and by grant: the application role gets INSERT and
-- SELECT here and nothing else.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     UUID REFERENCES users(id),
  business_id UUID,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          INET,
  request_id  TEXT
);
CREATE INDEX audit_log_business_at_idx ON audit_log (business_id, at DESC);
CREATE INDEX audit_log_user_at_idx ON audit_log (user_id, at DESC);
