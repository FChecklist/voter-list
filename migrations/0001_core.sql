-- Voter List: core schema (Cloudflare D1 / SQLite). Applied in order by `wrangler d1 migrations apply` or scripts/migrate.ts.
-- Rules this schema enforces itself (not only the application):
--   * every child row carries society_id and a composite foreign key, so a row can never point at another society's parent
--   * a published list version, its rows, a freeze and its rows, and every audit entry are immutable (triggers below)
--   * timestamps are integer milliseconds since the epoch (UTC); dates that humans type are 'YYYY-MM-DD' text
--   * weights are integer thousandths (1000 = weight 1) so the signed log can hold them (canonical JSON allows only integers)

PRAGMA foreign_keys = ON;

CREATE TABLE societies (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  kind             TEXT NOT NULL CHECK (kind IN ('RWA','AOA','HOA','Co-operative society','Others')),
  kind_other       TEXT NOT NULL DEFAULT '',
  country          TEXT NOT NULL DEFAULT 'India',
  state            TEXT NOT NULL DEFAULT '',
  reg_no           TEXT NOT NULL DEFAULT '',          -- recorded exactly as given, never called verified
  reg_office       TEXT NOT NULL DEFAULT '',
  bye_laws_note    TEXT NOT NULL DEFAULT '',
  rule_code        INTEGER NOT NULL DEFAULT 1 CHECK (rule_code BETWEEN 1 AND 5),
  rule_clause      TEXT NOT NULL DEFAULT '',          -- the bye-law clause the society relies on (free text)
  weight_mode      TEXT NOT NULL DEFAULT 'equal' CHECK (weight_mode IN ('equal','unequal')),
  dues_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (dues_enabled IN (0,1)),
  dues_cutoff      TEXT,
  tz_offset_min    INTEGER NOT NULL DEFAULT 330,      -- minutes east of UTC; a correction deadline ends at 23:59:59 local
  verify_slug      TEXT UNIQUE,                       -- the verification link, made once and kept the same
  draft_version_id TEXT,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

-- staff: Organizer (everything) or Officer (works on the list and the requests, cannot publish, freeze or change the rules)
CREATE TABLE memberships (
  society_id TEXT NOT NULL REFERENCES societies(id),
  email      TEXT NOT NULL COLLATE NOCASE,
  mobile     TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL CHECK (role IN ('organizer','officer')),
  status     TEXT NOT NULL CHECK (status IN ('active','removed')),
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (society_id, email)
);
CREATE INDEX idx_memberships_email ON memberships(email);

-- kind 'staff': signed in by e-mail code, society_id NULL (the person may belong to several societies)
-- kind 'member': signed in through one society's verification link; sees only the units attached to that e-mail
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                        -- sha256 of the token, never the token
  kind       TEXT NOT NULL CHECK (kind IN ('staff','member')),
  email      TEXT NOT NULL COLLATE NOCASE,
  society_id TEXT REFERENCES societies(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((kind = 'member') = (society_id IS NOT NULL))
);

CREATE TABLE otp_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL COLLATE NOCASE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('staff','member')),
  society_id TEXT,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER
);
CREATE INDEX idx_otp_lookup ON otp_codes(email, purpose, society_id, id);

CREATE TABLE rate_hits (
  k  TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_rate_hits ON rate_hits(k, ts);

CREATE TABLE mail_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('queued','sent','failed','capped')),
  created_at INTEGER NOT NULL
);
