-- Attendance Management, first chunk: sessions and one mark per voter per session.
-- A list made only to hold an uploaded Excel attendance list (an organizer without the Voter List product) is a `societies` row
-- with purpose 'attendance_upload', so privacy masking, roles and the signed audit trail work exactly as they do for a voter list.
PRAGMA foreign_keys = ON;

ALTER TABLE societies ADD COLUMN purpose TEXT NOT NULL DEFAULT 'voter_list' CHECK (purpose IN ('voter_list','attendance_upload'));

CREATE TABLE att_sessions (
  id           TEXT PRIMARY KEY,
  society_id   TEXT NOT NULL REFERENCES societies(id),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  starts_at    INTEGER NOT NULL,                                   -- UTC ms
  place        TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL CHECK (mode IN ('in_person','online','offline')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  UNIQUE (society_id, id)
);
CREATE INDEX idx_att_sessions_society ON att_sessions(society_id, starts_at);

-- one row per voter per session: the database refuses a second one, whatever the code does
CREATE TABLE att_marks (
  session_id   TEXT NOT NULL REFERENCES att_sessions(id),
  society_id   TEXT NOT NULL REFERENCES societies(id),
  voter_id     TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('email','organizer')),   -- email = the voter signed in with a code sent to the e-mail ID
  marked_by    TEXT NOT NULL,                                           -- private code of whoever marked it (never an e-mail ID)
  marked_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, voter_id),
  FOREIGN KEY (society_id, voter_id) REFERENCES voters(society_id, id)
);
CREATE TRIGGER trg_att_marks_no_update BEFORE UPDATE ON att_marks BEGIN SELECT RAISE(ABORT, 'attendance marks are append-only'); END;
CREATE TRIGGER trg_att_marks_no_delete BEFORE DELETE ON att_marks BEGIN SELECT RAISE(ABORT, 'attendance marks are append-only'); END;
