-- Results, first chunk (CP-311 to CP-345 of the 500-checkpoint plan; see docs/RESULTS.md).
-- A result is made only from a CLOSING: a closed meeting or a closed election, as it was delivered with its counts. Nobody types a result in:
-- the server copies every number of a result from one closing. A closing and a result cannot be changed afterwards. A mistake is put right by a
-- correction, which is a NEW result that points at the old one; the old one stays, marked superseded.
-- The whole product is dark: the API answers 404 unless RESULTS_ENABLED is "1".
PRAGMA foreign_keys = ON;

-- the closed process as it was delivered (append-only). `source` says who delivered it: today only the Organizer; later the Meetings and Elections systems.
CREATE TABLE res_closings (
  id           TEXT PRIMARY KEY,
  society_id   TEXT NOT NULL REFERENCES societies(id),
  kind         TEXT NOT NULL CHECK (kind IN ('meeting','election')),
  ref          TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 60),     -- the delivering system's own id of the process
  revision     INTEGER NOT NULL CHECK (revision >= 1),                 -- 1 for the first delivery; a correction delivers revision 2, 3 ...
  source       TEXT NOT NULL CHECK (source IN ('organizer','meetings','elections')),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  closed_at    INTEGER NOT NULL,                                       -- UTC ms: when the meeting or election closed
  payload_json TEXT NOT NULL,                                          -- the closing as accepted (counts, names), after cleaning
  created_by   TEXT NOT NULL,                                          -- private code of whoever delivered it, never an e-mail ID
  created_at   INTEGER NOT NULL,
  UNIQUE (society_id, id),
  UNIQUE (society_id, kind, ref, revision)
);
CREATE INDEX idx_res_closings_society ON res_closings(society_id, created_at);

-- the declared result. content_json and fingerprint never change. status: draft (the challenge window may still be open) -> final, or -> superseded by a correction.
CREATE TABLE res_results (
  id                TEXT PRIMARY KEY,
  society_id        TEXT NOT NULL REFERENCES societies(id),
  closing_id        TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('meeting','election')),
  ref               TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK (version >= 1),
  supersedes        TEXT,                                              -- the result this one corrects (the old one stays and is marked superseded)
  status            TEXT NOT NULL CHECK (status IN ('draft','final','superseded')),
  visibility        TEXT NOT NULL DEFAULT 'hidden' CHECK (visibility IN ('hidden','masked','full')),
  content_json      TEXT NOT NULL,
  fingerprint       TEXT NOT NULL CHECK (length(fingerprint) = 64),
  failed_checks     INTEGER NOT NULL DEFAULT 0 CHECK (failed_checks >= 0),
  challenge_ends_at INTEGER NOT NULL,                                  -- UTC ms: the result can be made final from this moment
  audit_seq         INTEGER NOT NULL,                                  -- the signed audit entry that recorded the draft
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  finalized_at      INTEGER,
  finalized_by      TEXT,
  final_audit_seq   INTEGER,                                           -- the signed audit entry that recorded the final result
  superseded_at     INTEGER,
  UNIQUE (society_id, id),
  UNIQUE (society_id, kind, ref, version),
  FOREIGN KEY (society_id, closing_id) REFERENCES res_closings(society_id, id),
  FOREIGN KEY (society_id, supersedes) REFERENCES res_results(society_id, id),
  -- a result with a failed check can never be final, whatever the code does
  CHECK ((status = 'draft' AND finalized_at IS NULL) OR (status = 'final' AND finalized_at IS NOT NULL AND failed_checks = 0) OR (status = 'superseded' AND superseded_at IS NOT NULL))
);
CREATE INDEX idx_res_results_society ON res_results(society_id, created_at);
-- one live result for one process: a second one can only come as a correction, which supersedes the first in the same batch
CREATE UNIQUE INDEX uq_res_live ON res_results(society_id, kind, ref) WHERE status <> 'superseded';

-- closings are append-only; they can go only when the whole list is erased (the erase batch sets erased_at first)
CREATE TRIGGER trg_res_closings_no_update BEFORE UPDATE ON res_closings BEGIN SELECT RAISE(ABORT, 'a closing is append-only'); END;
CREATE TRIGGER trg_res_closings_no_delete BEFORE DELETE ON res_closings
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a closing is append-only'); END;

-- a new result always starts as a draft
CREATE TRIGGER trg_res_results_new_is_draft BEFORE INSERT ON res_results
WHEN NEW.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'a new result starts as a draft and is immutable once made'); END;

-- what a result says never changes. Only three things may: the visibility, draft -> final (with who and when), and ->superseded by a correction.
CREATE TRIGGER trg_res_results_fixed BEFORE UPDATE ON res_results
WHEN NEW.id <> OLD.id OR NEW.society_id <> OLD.society_id OR NEW.closing_id <> OLD.closing_id OR NEW.kind <> OLD.kind OR NEW.ref <> OLD.ref
  OR NEW.version <> OLD.version OR NEW.supersedes IS NOT OLD.supersedes OR NEW.content_json <> OLD.content_json OR NEW.fingerprint <> OLD.fingerprint
  OR NEW.failed_checks <> OLD.failed_checks OR NEW.challenge_ends_at <> OLD.challenge_ends_at OR NEW.audit_seq <> OLD.audit_seq
  OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  OR OLD.status = 'superseded'
  OR (OLD.status = 'final' AND NEW.status = 'draft')
  OR (OLD.finalized_at IS NOT NULL AND (NEW.finalized_at IS NOT OLD.finalized_at OR NEW.finalized_by IS NOT OLD.finalized_by OR NEW.final_audit_seq IS NOT OLD.final_audit_seq))
BEGIN SELECT RAISE(ABORT, 'a declared result is immutable'); END;

CREATE TRIGGER trg_res_results_no_delete BEFORE DELETE ON res_results
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a declared result is immutable'); END;
