-- Meetings (first chunks): rules, meetings, agenda, notices, people, events, motions, results, minutes and action items.
-- Meetings is its own product. It reads the list (the `voters` rows) and Attendance only through their public functions in code, so no table here
-- points at `voters`, `att_sessions` or `att_marks`: a person or a session is named by its id and checked in code.
-- Rules the database keeps itself, whatever the code does:
--   * a notice, a vote result, an event and a declared interest are append-only
--   * the agenda cannot change once a notice is out (the Organizer withdraws the notice first)
--   * a motion can never be deleted; a withdrawal stays visible
--   * minutes never change; approved minutes are frozen, a correction is a new linked version
-- Everything can be removed only when the list itself has been erased (the erase batch sets societies.erased_at first).
PRAGMA foreign_keys = ON;

-- the rules a list sets once per kind of meeting, from its bye-laws (nothing is assumed by the system)
CREATE TABLE meeting_rules (
  society_id     TEXT NOT NULL REFERENCES societies(id),
  meeting_type   TEXT NOT NULL CHECK (meeting_type IN ('annual','special','committee','emergency')),
  notice_days    INTEGER NOT NULL CHECK (notice_days BETWEEN 0 AND 365),
  quorum_percent INTEGER NOT NULL CHECK (quorum_percent BETWEEN 0 AND 100),      -- 0 = the Organizer wrote that no quorum is needed
  clause         TEXT NOT NULL DEFAULT '' CHECK (length(clause) <= 200),         -- the bye-law clause relied on
  adjourn_clause TEXT NOT NULL DEFAULT '' CHECK (length(adjourn_clause) <= 300), -- what the bye-laws say to do without a quorum
  set_by         TEXT NOT NULL,                                                  -- private code, never an e-mail ID
  set_at         INTEGER NOT NULL,
  PRIMARY KEY (society_id, meeting_type)
);

CREATE TABLE meetings (
  id                    TEXT PRIMARY KEY,
  society_id            TEXT NOT NULL REFERENCES societies(id),
  number                INTEGER NOT NULL CHECK (number >= 1),
  title                 TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  meeting_type          TEXT NOT NULL CHECK (meeting_type IN ('annual','special','committee','emergency')),
  starts_at             INTEGER NOT NULL,                                        -- UTC ms
  place                 TEXT NOT NULL DEFAULT '' CHECK (length(place) <= 120),
  mode                  TEXT NOT NULL CHECK (mode IN ('in_person','online','offline')),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','noticed','open','adjourned','closed','cancelled')),
  visibility            TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','notice','all')),
  attendance_session_id TEXT,                                                    -- an Attendance session of the same list, checked in code
  notice_version        INTEGER NOT NULL DEFAULT 0,
  opened_at             INTEGER,
  closed_at             INTEGER,
  created_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (society_id, id),
  UNIQUE (society_id, number)
);
CREATE INDEX idx_meetings_society ON meetings(society_id, starts_at);
-- the title, kind, date, place and mode are fixed by the notice: while a notice is out they change only together with a new notice version; once the meeting has started they never change
CREATE TRIGGER trg_meetings_fixed BEFORE UPDATE ON meetings
WHEN (NEW.title <> OLD.title OR NEW.meeting_type <> OLD.meeting_type OR NEW.starts_at <> OLD.starts_at OR NEW.place <> OLD.place OR NEW.mode <> OLD.mode)
 AND (OLD.status NOT IN ('draft','noticed') OR (OLD.status = 'noticed' AND NEW.notice_version = OLD.notice_version))
BEGIN SELECT RAISE(ABORT, 'the date, place and kind of a meeting are immutable once the notice is out; a change needs a new notice'); END;
CREATE TRIGGER trg_meetings_no_delete BEFORE DELETE ON meetings
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a meeting is append-only: it is closed or cancelled, never deleted'); END;

CREATE TABLE meeting_items (
  id         TEXT PRIMARY KEY,
  society_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  position   INTEGER NOT NULL CHECK (position >= 1),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  kind       TEXT NOT NULL CHECK (kind IN ('information','decision')),
  minutes    INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 600),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);
CREATE INDEX idx_meeting_items ON meeting_items(meeting_id, position);
CREATE TRIGGER trg_meeting_items_fixed_ins BEFORE INSERT ON meeting_items
WHEN (SELECT status FROM meetings WHERE id = NEW.meeting_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'the agenda is immutable once the notice is out'); END;
CREATE TRIGGER trg_meeting_items_fixed_upd BEFORE UPDATE ON meeting_items
WHEN (SELECT status FROM meetings WHERE id = OLD.meeting_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'the agenda is immutable once the notice is out'); END;
CREATE TRIGGER trg_meeting_items_fixed_del BEFORE DELETE ON meeting_items
WHEN (SELECT status FROM meetings WHERE id = OLD.meeting_id) <> 'draft' AND (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'the agenda is immutable once the notice is out'); END;

-- every notice that went out, with the agenda exactly as it was and its fingerprint
CREATE TABLE meeting_notices (
  id            TEXT PRIMARY KEY,
  society_id    TEXT NOT NULL,
  meeting_id    TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  kind          TEXT NOT NULL CHECK (kind IN ('notice','postponed','cancelled')),
  issued_at     INTEGER NOT NULL,
  issued_by     TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,              -- the time the notice states
  required_days INTEGER,                       -- the notice period that applied when it was sent (null for a cancellation)
  clause        TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,                 -- the meeting facts and the agenda exactly as sent; the fingerprint is the SHA-256 of this
  fingerprint   TEXT NOT NULL,
  recipients    INTEGER NOT NULL CHECK (recipients >= 0),
  UNIQUE (meeting_id, version),
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);
CREATE TRIGGER trg_meeting_notices_no_update BEFORE UPDATE ON meeting_notices BEGIN SELECT RAISE(ABORT, 'a notice is append-only'); END;
CREATE TRIGGER trg_meeting_notices_no_delete BEFORE DELETE ON meeting_notices
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a notice is append-only'); END;

-- chair, secretary and timekeeper of one meeting; observers; and the sign-off names at the end
CREATE TABLE meeting_people (
  society_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('chair','secretary','timekeeper','observer','validated_by','supervised_by')),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  email      TEXT NOT NULL COLLATE NOCASE,
  added_by   TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, role, email),
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);

-- the order of what happened in the meeting room: opened, adjourned, resumed, closed, points of order, a notice withdrawn
CREATE TABLE meeting_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('opened','adjourned','resumed','closed','point_of_order','notice_withdrawn')),
  text       TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 300),
  ts         INTEGER NOT NULL,
  by_pid     TEXT NOT NULL,
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);
CREATE INDEX idx_meeting_events ON meeting_events(meeting_id, id);
CREATE TRIGGER trg_meeting_events_no_update BEFORE UPDATE ON meeting_events BEGIN SELECT RAISE(ABORT, 'meeting events are append-only'); END;
CREATE TRIGGER trg_meeting_events_no_delete BEFORE DELETE ON meeting_events
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'meeting events are append-only'); END;

-- a motion is never deleted: it is decided or withdrawn, and both stay visible
CREATE TABLE motions (
  id               TEXT PRIMARY KEY,
  society_id       TEXT NOT NULL,
  meeting_id       TEXT NOT NULL,
  item_id          TEXT NOT NULL REFERENCES meeting_items(id),
  number           INTEGER NOT NULL CHECK (number >= 1),
  text             TEXT NOT NULL CHECK (length(text) BETWEEN 2 AND 1000),
  mover_voter_id   TEXT NOT NULL,
  seconder_voter_id TEXT NOT NULL,
  majority         TEXT NOT NULL CHECK (majority IN ('simple','two_thirds','three_quarters')),
  amends_motion_id TEXT REFERENCES motions(id),
  status           TEXT NOT NULL DEFAULT 'moved' CHECK (status IN ('moved','withdrawn','decided')),
  withdrawn_reason TEXT NOT NULL DEFAULT '' CHECK (length(withdrawn_reason) <= 200),
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  CHECK (mover_voter_id <> seconder_voter_id),
  UNIQUE (meeting_id, number),
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);
CREATE TRIGGER trg_motions_no_delete BEFORE DELETE ON motions
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a motion is append-only: it is decided or withdrawn, never deleted'); END;
CREATE TRIGGER trg_motions_text_fixed BEFORE UPDATE ON motions
WHEN NEW.text <> OLD.text OR NEW.number <> OLD.number OR NEW.mover_voter_id <> OLD.mover_voter_id OR NEW.seconder_voter_id <> OLD.seconder_voter_id OR NEW.majority <> OLD.majority OR OLD.status <> 'moved'
BEGIN SELECT RAISE(ABORT, 'a motion is immutable once moved; only its first decision or withdrawal is recorded'); END;

CREATE TABLE motion_interests (
  motion_id   TEXT NOT NULL REFERENCES motions(id),
  society_id  TEXT NOT NULL,
  voter_id    TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  declared_by TEXT NOT NULL,
  declared_at INTEGER NOT NULL,
  PRIMARY KEY (motion_id, voter_id)
);
CREATE TRIGGER trg_motion_interests_no_update BEFORE UPDATE ON motion_interests BEGIN SELECT RAISE(ABORT, 'a declared interest is append-only'); END;
CREATE TRIGGER trg_motion_interests_no_delete BEFORE DELETE ON motion_interests
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a declared interest is append-only'); END;

-- one result per motion: the counts, who counted, and the quorum as it stood when the result was recorded
CREATE TABLE motion_results (
  motion_id       TEXT PRIMARY KEY REFERENCES motions(id),
  society_id      TEXT NOT NULL,
  meeting_id      TEXT NOT NULL,
  method          TEXT NOT NULL CHECK (method IN ('show_of_hands','online','secret_ballot','by_list_rule')),
  for_count       INTEGER NOT NULL CHECK (for_count >= 0),
  against_count   INTEGER NOT NULL CHECK (against_count >= 0),
  abstain_count   INTEGER NOT NULL CHECK (abstain_count >= 0),
  counted_by_json TEXT NOT NULL,
  quorum_eligible INTEGER NOT NULL,
  quorum_required INTEGER NOT NULL,
  quorum_present  INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('passed','not_passed')),
  note            TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  decided_at      INTEGER NOT NULL,
  decided_by      TEXT NOT NULL
);
CREATE TRIGGER trg_motion_results_no_update BEFORE UPDATE ON motion_results BEGIN SELECT RAISE(ABORT, 'a vote result is append-only'); END;
CREATE TRIGGER trg_motion_results_no_delete BEFORE DELETE ON motion_results
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a vote result is append-only'); END;

-- minutes: every version is kept; a version never changes; once approved it is frozen with its fingerprint
CREATE TABLE meeting_minutes (
  id                     TEXT PRIMARY KEY,
  society_id             TEXT NOT NULL,
  meeting_id             TEXT NOT NULL,
  version                INTEGER NOT NULL CHECK (version >= 1),
  body                   TEXT NOT NULL CHECK (length(body) BETWEEN 10 AND 20000),
  source                 TEXT NOT NULL CHECK (source IN ('human','ai')),
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  supersedes_id          TEXT,
  reason                 TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  fingerprint            TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  accepted_by            TEXT,
  accepted_at            INTEGER,
  approved_by            TEXT,
  approved_at            INTEGER,
  approved_in_meeting_id TEXT,
  UNIQUE (meeting_id, version),
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);
CREATE TRIGGER trg_meeting_minutes_frozen BEFORE UPDATE ON meeting_minutes
WHEN OLD.status = 'approved' OR NEW.body <> OLD.body OR NEW.fingerprint <> OLD.fingerprint OR NEW.version <> OLD.version OR NEW.source <> OLD.source
BEGIN SELECT RAISE(ABORT, 'minutes are immutable: approved minutes are frozen and a correction is a new version'); END;
CREATE TRIGGER trg_meeting_minutes_no_delete BEFORE DELETE ON meeting_minutes
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'minutes are immutable'); END;

CREATE TABLE meeting_actions (
  id          TEXT PRIMARY KEY,
  society_id  TEXT NOT NULL,
  meeting_id  TEXT NOT NULL,
  motion_id   TEXT,
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 2 AND 300),
  owner_name  TEXT NOT NULL CHECK (length(owner_name) BETWEEN 2 AND 60),
  owner_email TEXT NOT NULL COLLATE NOCASE,
  due_date    TEXT NOT NULL,                  -- YYYY-MM-DD, as people type dates
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (society_id, meeting_id) REFERENCES meetings(society_id, id)
);
CREATE INDEX idx_meeting_actions ON meeting_actions(meeting_id, due_date);
