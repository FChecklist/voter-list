-- Voter List: versions, rows, imports, change history.
PRAGMA foreign_keys = ON;

-- One society has at most one working draft (societies.draft_version_id) and any number of published versions.
-- A draft has version_no NULL; version_no is given at the moment of publishing (1, 2, 3, ...).
CREATE TABLE list_versions (
  id                  TEXT PRIMARY KEY,
  society_id          TEXT NOT NULL REFERENCES societies(id),
  version_no          INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('draft','published')),
  kind                TEXT NOT NULL DEFAULT 'edit' CHECK (kind IN ('first_cut','edit')),
  base_version_id     TEXT,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  published_by        TEXT,
  published_at        INTEGER,
  correction_deadline TEXT,                           -- 'YYYY-MM-DD', the last day requests are accepted (local end of day)
  rule_code           INTEGER,                        -- the settings in force when this version was published
  weight_mode         TEXT,
  dues_enabled        INTEGER,
  dues_cutoff         TEXT,
  units               INTEGER,
  owners              INTEGER,
  voters              INTEGER,
  total_weight_milli  INTEGER,
  fingerprint         TEXT,
  note                TEXT NOT NULL DEFAULT '',
  UNIQUE (society_id, id),
  UNIQUE (society_id, version_no),
  CHECK ((status = 'published') = (version_no IS NOT NULL))
);

CREATE TABLE list_rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id  TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  row_no      INTEGER NOT NULL,
  unit        TEXT NOT NULL,                          -- as the society writes it, e.g. A-101 (may be '' while a problem is open)
  unit_key    TEXT NOT NULL,                          -- normalised for comparison: upper case, no spaces or dashes
  name        TEXT NOT NULL DEFAULT '',
  capacity    TEXT CHECK (capacity IN ('Owner','Co-owner','Tenant','Member')),
  mobile      TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  is_voter    INTEGER CHECK (is_voter IN (0,1)),      -- NULL = not marked yet
  weight_milli INTEGER CHECK (weight_milli IS NULL OR weight_milli > 0),
  can_attend  INTEGER NOT NULL DEFAULT 1 CHECK (can_attend IN (0,1)),
  can_vote    INTEGER NOT NULL DEFAULT 1 CHECK (can_vote IN (0,1)),
  dues_paid_on TEXT,
  source_row  INTEGER,
  FOREIGN KEY (society_id, version_id) REFERENCES list_versions(society_id, id)
);
CREATE INDEX idx_rows_version_unit ON list_rows(version_id, unit_key);
CREATE INDEX idx_rows_version_email ON list_rows(version_id, email);

CREATE TABLE imports (
  id           TEXT PRIMARY KEY,
  society_id   TEXT NOT NULL REFERENCES societies(id),
  version_id   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  format       TEXT NOT NULL CHECK (format IN ('csv','xlsx','paste')),
  mode         TEXT NOT NULL CHECK (mode IN ('replace','merge')),
  rows_read    INTEGER NOT NULL,
  rows_kept    INTEGER NOT NULL,
  report_json  TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- every change to a working draft, with the value before and after (staff only; the signed log carries masked values)
CREATE TABLE list_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id  TEXT NOT NULL REFERENCES societies(id),
  version_id  TEXT NOT NULL,
  unit_key    TEXT NOT NULL,
  unit        TEXT NOT NULL,
  field       TEXT NOT NULL,
  before_val  TEXT,
  after_val   TEXT,
  source      TEXT NOT NULL CHECK (source IN ('import','edit','manual','claim','undo')),
  claim_id    TEXT,
  reason      TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  undone_by   INTEGER                                  -- id of the 'undo' change that reversed this one
);
CREATE INDEX idx_changes_society ON list_changes(society_id, id);

-- a published version is a fixed record: nobody, not even the application, may change it
CREATE TRIGGER trg_versions_no_delete_published BEFORE DELETE ON list_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published list version is immutable'); END;

CREATE TRIGGER trg_versions_no_update_published BEFORE UPDATE ON list_versions
WHEN OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'published list version is immutable'); END;

CREATE TRIGGER trg_rows_no_insert_published BEFORE INSERT ON list_rows
WHEN (SELECT status FROM list_versions WHERE id = NEW.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published list version is immutable'); END;

CREATE TRIGGER trg_rows_no_update_published BEFORE UPDATE ON list_rows
WHEN (SELECT status FROM list_versions WHERE id = OLD.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published list version is immutable'); END;

CREATE TRIGGER trg_rows_no_delete_published BEFORE DELETE ON list_rows
WHEN (SELECT status FROM list_versions WHERE id = OLD.version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published list version is immutable'); END;

-- the history of changes is append-only except for marking a change as undone
CREATE TRIGGER trg_changes_no_delete BEFORE DELETE ON list_changes
BEGIN SELECT RAISE(ABORT, 'change history is append-only'); END;

CREATE TRIGGER trg_changes_no_rewrite BEFORE UPDATE ON list_changes
WHEN NEW.id <> OLD.id OR NEW.society_id <> OLD.society_id OR NEW.unit_key <> OLD.unit_key OR NEW.field <> OLD.field
  OR IFNULL(NEW.before_val,'') <> IFNULL(OLD.before_val,'') OR IFNULL(NEW.after_val,'') <> IFNULL(OLD.after_val,'')
  OR NEW.actor_email <> OLD.actor_email OR NEW.ts <> OLD.ts OR OLD.undone_by IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'change history is append-only'); END;
