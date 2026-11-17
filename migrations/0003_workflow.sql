-- Voter List: claims and objections, frozen copies for events, the signed audit chain, test-mode orders.
PRAGMA foreign_keys = ON;

-- A request from a verified person about a PUBLISHED version, inside the correction window.
--   correction : "my record says X, it should say Y"        (field + requested_value)
--   claim      : "I should be on the list for unit U"        (field 'entry', requested_value = who/capacity)
--   objection  : "the entry for unit U is wrong / not entitled" (field 'entry', requested_value = reason)
-- Accepting a request changes the WORKING DRAFT only; the published version stays as it was until a new version is published.
CREATE TABLE claims (
  id              TEXT PRIMARY KEY,
  society_id      TEXT NOT NULL,
  version_id      TEXT NOT NULL,                       -- the published version the person was looking at
  unit_key        TEXT NOT NULL,
  unit            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('correction','claim','objection')),
  field           TEXT NOT NULL CHECK (field IN ('name','mobile','email','capacity','voter','entry')),
  current_val     TEXT NOT NULL DEFAULT '',
  target_name     TEXT NOT NULL DEFAULT '',             -- the name on the line the request is about (a unit can have co-owners)
  requested_value TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  requester_email TEXT NOT NULL COLLATE NOCASE,
  status          TEXT NOT NULL CHECK (status IN ('waiting','accepted','partly','rejected','withdrawn')),
  applied_value   TEXT,
  applied_change_id INTEGER,                           -- the list_changes row that applied it (so it can be moved back to waiting)
  decided_by      TEXT,
  decided_at      INTEGER,
  decision_note   TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (society_id, version_id) REFERENCES list_versions(society_id, id)
);
CREATE INDEX idx_claims_society ON claims(society_id, status, created_at);
CREATE INDEX idx_claims_requester ON claims(society_id, requester_email);

CREATE TABLE claim_docs (
  id         TEXT PRIMARY KEY,
  claim_id   TEXT NOT NULL REFERENCES claims(id),
  society_id TEXT NOT NULL REFERENCES societies(id),
  doc_type   TEXT NOT NULL CHECK (doc_type IN ('Government ID','Registration Paper','Rent Agreement','Proxy Nomination Form','Society ID','Others')),
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png')),
  size       INTEGER NOT NULL CHECK (size > 0 AND size <= 400000),
  sha256     TEXT NOT NULL,
  data_b64   TEXT NOT NULL
);
CREATE INDEX idx_claim_docs_claim ON claim_docs(claim_id);

-- Each event freezes its own copy of a published version. Immutable once written.
CREATE TABLE freezes (
  id                 TEXT PRIMARY KEY,
  society_id         TEXT NOT NULL,
  version_id         TEXT NOT NULL,
  version_no         INTEGER NOT NULL,
  event_name         TEXT NOT NULL CHECK (length(event_name) BETWEEN 2 AND 120),
  event_type         TEXT NOT NULL CHECK (event_type IN ('meeting','election')),
  event_date         TEXT NOT NULL,
  rule_code          INTEGER NOT NULL,
  units              INTEGER NOT NULL,
  voters             INTEGER NOT NULL,
  total_weight_milli INTEGER NOT NULL,
  proxies            INTEGER NOT NULL DEFAULT 0,
  fingerprint        TEXT NOT NULL,
  frozen_by          TEXT NOT NULL,
  frozen_at          INTEGER NOT NULL,
  UNIQUE (society_id, id),
  FOREIGN KEY (society_id, version_id) REFERENCES list_versions(society_id, id)
);

-- the frozen register: one line per unit, after the society's rule, dues check and any proxy for THIS event
CREATE TABLE freeze_rows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id   TEXT NOT NULL,
  freeze_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  unit         TEXT NOT NULL,
  unit_key     TEXT NOT NULL,
  name         TEXT NOT NULL,
  capacity     TEXT NOT NULL,
  mobile       TEXT NOT NULL,
  email        TEXT NOT NULL,
  weight_milli INTEGER NOT NULL,
  can_attend   INTEGER NOT NULL,
  can_vote     INTEGER NOT NULL,
  via_proxy    INTEGER NOT NULL DEFAULT 0,
  proxy_letter TEXT NOT NULL DEFAULT '',
  proxy_from   TEXT,
  proxy_to     TEXT,
  FOREIGN KEY (society_id, freeze_id) REFERENCES freezes(society_id, id)
);
CREATE INDEX idx_freeze_rows ON freeze_rows(freeze_id, seq);

CREATE TRIGGER trg_freezes_immutable_u BEFORE UPDATE ON freezes BEGIN SELECT RAISE(ABORT, 'a frozen copy is immutable'); END;
CREATE TRIGGER trg_freezes_immutable_d BEFORE DELETE ON freezes BEGIN SELECT RAISE(ABORT, 'a frozen copy is immutable'); END;
CREATE TRIGGER trg_freeze_rows_immutable_u BEFORE UPDATE ON freeze_rows BEGIN SELECT RAISE(ABORT, 'a frozen copy is immutable'); END;
CREATE TRIGGER trg_freeze_rows_immutable_d BEFORE DELETE ON freeze_rows BEGIN SELECT RAISE(ABORT, 'a frozen copy is immutable'); END;

-- The signed, hash-chained audit trail (src/vendor/log.ts). One chain per society. Append-only.
CREATE TABLE audit_entries (
  society_id TEXT NOT NULL REFERENCES societies(id),
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  sig        TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (society_id, seq)
);
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit trail is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit trail is append-only'); END;

-- Test-mode orders only. The live Razorpay gateway (payee: IT SERVICES BY RAJAT AGARWAL) is deliberately not wired in this repo.
CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  society_id   TEXT NOT NULL REFERENCES societies(id),
  purpose      TEXT NOT NULL CHECK (purpose IN ('save_version_1')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL CHECK (status IN ('created','paid')),
  test         INTEGER NOT NULL DEFAULT 1 CHECK (test = 1),
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER,
  used_for_version TEXT
);
