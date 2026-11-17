-- Voter List v2: one common link per list, voters enrol themselves, hosts check every record, draft and frozen publications.
-- Nothing was ever deployed with 0001..0004, and those files are untouched. This migration only ADDS, with one exception:
-- `memberships` is rebuilt (its role list must now say organizer / host); every row is copied across. The old tables
-- (list_versions, list_rows, imports, list_changes, claims, claim_docs, freezes, freeze_rows) stay in place, unused and harmless.
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- the list itself (a row of `societies` is a voter list)
ALTER TABLE societies ADD COLUMN phase TEXT NOT NULL DEFAULT 'open' CHECK (phase IN ('open','frozen'));
ALTER TABLE societies ADD COLUMN cutoff_at INTEGER;                       -- enrolment closes at this moment (ms, UTC); NULL = open until the list is frozen
ALTER TABLE societies ADD COLUMN docs_required INTEGER NOT NULL DEFAULT 0 CHECK (docs_required IN (0,1));
ALTER TABLE societies ADD COLUMN link_shared_at INTEGER;                  -- the organizer pressed "I have shared the link" (step bar only)
ALTER TABLE societies ADD COLUMN erased_at INTEGER;                       -- personal data of this list was erased after its retention period (the signed log and fingerprints remain)
ALTER TABLE societies ADD COLUMN hosts_skipped INTEGER NOT NULL DEFAULT 0 CHECK (hosts_skipped IN (0,1));

-- ---------------------------------------------------------------- team: exactly 1 organizer, at most 10 hosts (+ the permanent host)
CREATE TABLE memberships_new (
  society_id TEXT NOT NULL REFERENCES societies(id),
  email      TEXT NOT NULL COLLATE NOCASE,
  mobile     TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL CHECK (role IN ('organizer','host')),
  status     TEXT NOT NULL CHECK (status IN ('active','removed')),
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  permanent  INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0,1)),     -- the standing Townhall Records host: cannot be removed, not counted in the 10
  PRIMARY KEY (society_id, email),
  CHECK (permanent = 0 OR role = 'host')
);
-- old Officers become Hosts; if a list had several Organizers, the earliest stays Organizer and the others become Hosts
INSERT INTO memberships_new (society_id, email, mobile, role, status, invited_by, created_at, permanent)
SELECT m.society_id, m.email, m.mobile,
       CASE WHEN m.role = 'organizer' AND m.status = 'active' AND m.rowid = (SELECT MIN(x.rowid) FROM memberships x WHERE x.society_id = m.society_id AND x.role = 'organizer' AND x.status = 'active') THEN 'organizer' ELSE 'host' END,
       m.status, m.invited_by, m.created_at, 0
FROM memberships m;
DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;
CREATE INDEX idx_memberships_email ON memberships(email);
CREATE UNIQUE INDEX uq_one_organizer ON memberships(society_id) WHERE role = 'organizer' AND status = 'active';
CREATE UNIQUE INDEX uq_one_permanent ON memberships(society_id) WHERE permanent = 1;

-- the database itself refuses an 11th host (the permanent host is extra), so no race or bug can exceed the limit
CREATE TRIGGER trg_hosts_max_insert BEFORE INSERT ON memberships
WHEN NEW.role = 'host' AND NEW.status = 'active' AND NEW.permanent = 0
 AND (SELECT COUNT(*) FROM memberships WHERE society_id = NEW.society_id AND role = 'host' AND status = 'active' AND permanent = 0) >= 10
BEGIN SELECT RAISE(ABORT, 'guard_failed:A voter list can have up to 10 hosts. Please free a seat first (pause or remove one host).::end'); END;
CREATE TRIGGER trg_hosts_max_update BEFORE UPDATE ON memberships
WHEN NEW.role = 'host' AND NEW.status = 'active' AND NEW.permanent = 0 AND (OLD.role <> 'host' OR OLD.status <> 'active')
 AND (SELECT COUNT(*) FROM memberships WHERE society_id = NEW.society_id AND role = 'host' AND status = 'active' AND permanent = 0) >= 10
BEGIN SELECT RAISE(ABORT, 'guard_failed:A voter list can have up to 10 hosts. Please free a seat first (pause or remove one host).::end'); END;
CREATE TRIGGER trg_permanent_stays BEFORE UPDATE ON memberships
WHEN OLD.permanent = 1 AND (NEW.status <> 'active' OR NEW.role <> 'host' OR NEW.permanent <> 1)
BEGIN SELECT RAISE(ABORT, 'guard_failed:The Townhall Records host is a standing member of every voter list.::end'); END;
CREATE TRIGGER trg_permanent_no_delete BEFORE DELETE ON memberships WHEN OLD.permanent = 1
BEGIN SELECT RAISE(ABORT, 'guard_failed:The Townhall Records host is a standing member of every voter list.::end'); END;

-- ---------------------------------------------------------------- voter records (one per person per flat / house)
-- status: invited (loaded by a host from a file, the voter has not yet confirmed) | draft (the voter is still filling it) | submitted (waiting for a check)
--         | approved | sent_back (not approved, with a reason; the voter may fix and send again) | removed (kept a while for undo, then purged)
-- approved_json keeps the last APPROVED details of the voter-owned fields, so a voter who edits an approved record is not dropped from the list while the edit waits for its check.
CREATE TABLE voters (
  id            TEXT PRIMARY KEY,
  society_id    TEXT NOT NULL REFERENCES societies(id),
  unit          TEXT NOT NULL,
  unit_key      TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  capacity      TEXT CHECK (capacity IN ('Owner','Co-owner','Tenant','Proxy','Member')),
  mobile        TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL COLLATE NOCASE,
  proxy_for     TEXT NOT NULL DEFAULT '',                        -- a Proxy names the owner they act for
  is_voter      INTEGER CHECK (is_voter IN (0,1)),               -- when a flat has several approved people: the one who votes (NULL = not chosen)
  weight_milli  INTEGER CHECK (weight_milli IS NULL OR weight_milli > 0),
  can_attend    INTEGER NOT NULL DEFAULT 1 CHECK (can_attend IN (0,1)),
  can_vote      INTEGER NOT NULL DEFAULT 1 CHECK (can_vote IN (0,1)),
  dues_paid_on  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('invited','draft','submitted','approved','sent_back','removed')),
  reason        TEXT NOT NULL DEFAULT '',                        -- why it was sent back (the voter reads this)
  approved_json TEXT,                                            -- last approved {name,mobile,capacity,proxyFor}
  source        TEXT NOT NULL CHECK (source IN ('voter','upload','host')),
  revision      INTEGER NOT NULL DEFAULT 1,
  confirmed_at  INTEGER,
  submitted_at  INTEGER,
  decided_by    TEXT,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (society_id, id),
  UNIQUE (society_id, unit_key, email)
);
CREATE INDEX idx_voters_status ON voters(society_id, status, updated_at);
CREATE INDEX idx_voters_email ON voters(society_id, email);
CREATE INDEX idx_voters_unit ON voters(society_id, unit_key);

CREATE TABLE voter_docs (
  id         TEXT PRIMARY KEY,
  society_id TEXT NOT NULL,
  voter_id   TEXT NOT NULL,
  doc_type   TEXT NOT NULL CHECK (doc_type IN ('Government ID','Sale Deed or Share Certificate','Allotment or Possession Letter','Registration Paper','Rent Agreement','Proxy Nomination Form','Society ID','Others')),
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png')),
  size       INTEGER NOT NULL CHECK (size > 0 AND size <= 400000),
  sha256     TEXT NOT NULL,
  data_b64   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (society_id, voter_id) REFERENCES voters(society_id, id)
);
CREATE INDEX idx_voter_docs ON voter_docs(voter_id);
-- three documents a record, whoever adds them and however fast (two uploads at once cannot make a fourth)
CREATE TRIGGER trg_voter_docs_max BEFORE INSERT ON voter_docs
WHEN (SELECT COUNT(*) FROM voter_docs WHERE voter_id = NEW.voter_id) >= 3
BEGIN SELECT RAISE(ABORT, 'guard_failed:Up to 3 documents can be kept with a record.::end'); END;

-- the history of every record (staff-only; the signed log carries only pseudonyms and counts). Append-only. Two allowed changes: marking an event as undone, and
-- redacting its before/after copies to NULL when the personal data is erased after the retention period (a value can be removed, never rewritten).
CREATE TABLE voter_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id  TEXT NOT NULL REFERENCES societies(id),
  voter_id    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  actor_role  TEXT NOT NULL CHECK (actor_role IN ('voter','organizer','host','system')),
  kind        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  reason      TEXT NOT NULL DEFAULT '',
  before_json TEXT,                                              -- the whole record before (for undo)
  after_json  TEXT,                                              -- the whole record after
  after_rev   INTEGER,                                           -- the record's revision right after this event: an undo works only while that is still the current revision
  batch       TEXT,                                              -- one bulk action = one batch id
  undone_by   INTEGER
);
CREATE INDEX idx_voter_events_voter ON voter_events(society_id, voter_id, id);
CREATE INDEX idx_voter_events_batch ON voter_events(society_id, batch);
CREATE TRIGGER trg_voter_events_no_delete BEFORE DELETE ON voter_events BEGIN SELECT RAISE(ABORT, 'record history is append-only'); END;
CREATE TRIGGER trg_voter_events_no_rewrite BEFORE UPDATE ON voter_events
WHEN NEW.id <> OLD.id OR NEW.society_id <> OLD.society_id OR NEW.voter_id <> OLD.voter_id OR NEW.ts <> OLD.ts OR (NEW.actor_email <> OLD.actor_email AND NEW.actor_email <> '(erased)') OR NEW.kind <> OLD.kind
  OR (NEW.before_json IS NOT NULL AND IFNULL(NEW.before_json,'') <> IFNULL(OLD.before_json,'')) OR (NEW.after_json IS NOT NULL AND IFNULL(NEW.after_json,'') <> IFNULL(OLD.after_json,''))
  OR NEW.after_rev IS NOT OLD.after_rev OR NEW.reason <> OLD.reason OR NEW.batch IS NOT OLD.batch OR (OLD.undone_by IS NOT NULL AND NEW.undone_by IS NOT OLD.undone_by)
BEGIN SELECT RAISE(ABORT, 'record history is append-only'); END;

-- ---------------------------------------------------------------- publications: draft (provisional, may change) and frozen (immutable)
CREATE TABLE publications (
  id          TEXT PRIMARY KEY,
  society_id  TEXT NOT NULL REFERENCES societies(id),
  kind        TEXT NOT NULL CHECK (kind IN ('draft','frozen')),
  seq         INTEGER NOT NULL,                                  -- 1, 2, 3 ... within (list, kind)
  event_name  TEXT NOT NULL DEFAULT '',
  event_type  TEXT NOT NULL DEFAULT '' CHECK (event_type IN ('','meeting','election')),
  cutoff_at   INTEGER,                                           -- frozen: the cut-off moment (ms, UTC): nothing after it is in this list
  rule_code   INTEGER NOT NULL,
  weight_mode TEXT NOT NULL,
  dues_enabled INTEGER NOT NULL,
  dues_cutoff TEXT,
  units       INTEGER NOT NULL,
  people      INTEGER NOT NULL,
  voters      INTEGER NOT NULL,                                  -- units whose voter may vote
  total_weight_milli INTEGER NOT NULL,
  not_included INTEGER NOT NULL DEFAULT 0,                       -- records still waiting / sent back / not yet confirmed at that moment
  fingerprint TEXT NOT NULL,
  audit_seq   INTEGER NOT NULL,                                  -- the signed audit entry that recorded this publication
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  UNIQUE (society_id, id),
  UNIQUE (society_id, kind, seq)
);
CREATE TABLE publication_rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id  TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  unit        TEXT NOT NULL,
  unit_key    TEXT NOT NULL,
  name        TEXT NOT NULL,
  capacity    TEXT NOT NULL,
  mobile      TEXT NOT NULL,
  email       TEXT NOT NULL,
  proxy_for   TEXT NOT NULL DEFAULT '',
  is_voter    INTEGER NOT NULL,
  weight_milli INTEGER NOT NULL,
  can_attend  INTEGER NOT NULL,
  can_vote    INTEGER NOT NULL,
  FOREIGN KEY (society_id, publication_id) REFERENCES publications(society_id, id)
);
CREATE INDEX idx_pub_rows ON publication_rows(publication_id, seq);
CREATE INDEX idx_pub_rows_unit ON publication_rows(publication_id, unit_key);
CREATE TRIGGER trg_publications_immutable_u BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT, 'a publication is immutable'); END;
CREATE TRIGGER trg_publications_immutable_d BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'a publication is immutable'); END;
CREATE TRIGGER trg_pub_rows_immutable_u BEFORE UPDATE ON publication_rows BEGIN SELECT RAISE(ABORT, 'a publication is immutable'); END;
-- the rows of an OLD DRAFT may be swept away when a newer draft replaces them (the signed entry and the fingerprint stay); frozen rows only by the
-- audited erasure of the whole list after its retention period (societies.erased_at is set first, in the same batch)
CREATE TRIGGER trg_pub_rows_frozen_d BEFORE DELETE ON publication_rows
WHEN (SELECT kind FROM publications WHERE id = OLD.publication_id) = 'frozen' AND (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a frozen publication is immutable'); END;
-- a publication holds exactly the number of lines it declares (`people`); a line can never be slipped in afterwards
CREATE UNIQUE INDEX uq_pub_rows_seq ON publication_rows(publication_id, seq);
CREATE TRIGGER trg_pub_rows_sealed BEFORE INSERT ON publication_rows
WHEN NEW.seq < 1 OR NEW.seq > (SELECT people FROM publications WHERE id = NEW.publication_id)
BEGIN SELECT RAISE(ABORT, 'a publication holds exactly the lines it declares'); END;

CREATE INDEX idx_publications_latest ON publications(society_id, kind, seq);
