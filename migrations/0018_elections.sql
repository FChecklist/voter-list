-- Elections, first chunk: an election for a list, its posts, officials, nominations, the secret ballot, the count, challenges and the public trail.
-- Dark by default (the application answers 404 unless ELECTIONS_ENABLED is "1"). Nothing here changes an existing table.
--
-- How the vote stays secret (every point below has a test in test/elections-secrecy.test.ts):
--   * WHO voted is the register (el_voted): one row per voter per election, in the database as a primary key.
--   * WHAT was chosen is a ballot (el_ballots): a random id, the post, a weight and the choice SEALED with a key the database does not hold.
--     A ballot has no voter, no time, no counter and no row number (WITHOUT ROWID, random key), so no column in any table links a ballot to a person.
--   * A receipt (el_receipts) is a hash of a random code. It is not linked to a voter or a ballot; it only proves "a ballot was counted".
--   * No exact time sits next to a person: the register keeps only the DAY, used codes and tickets are deleted, and the signed entry of a vote carries the day.
--   * The register, the ballots and the receipts are written in ONE batch, so they always agree; the count checks that they do.
PRAGMA foreign_keys = ON;

CREATE TABLE el_elections (
  id                   TEXT PRIMARY KEY,
  society_id           TEXT NOT NULL REFERENCES societies(id),
  title                TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  term                 TEXT NOT NULL DEFAULT '' CHECK (length(term) <= 60),
  mode                 TEXT NOT NULL CHECK (mode IN ('in_person','online','offline','mixed')),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','notice','candidates_final','voting','closed','counted','declared')),
  weighting            TEXT NOT NULL DEFAULT 'equal' CHECK (weighting IN ('equal','by_list')),
  nota                 INTEGER NOT NULL DEFAULT 0 CHECK (nota IN (0,1)),              -- "none of the above" is on the ballot
  random_order         INTEGER NOT NULL DEFAULT 1 CHECK (random_order IN (0,1)),      -- names are shown in a new random order to each voter
  uncontested          TEXT NOT NULL DEFAULT 'elected' CHECK (uncontested IN ('elected')),
  tie_rule             TEXT NOT NULL DEFAULT 'draw' CHECK (tie_rule IN ('draw')),
  appeal_hours         INTEGER NOT NULL DEFAULT 24 CHECK (appeal_hours BETWEEN 1 AND 336),
  challenge_hours      INTEGER NOT NULL DEFAULT 24 CHECK (challenge_hours BETWEEN 1 AND 336),
  nominations_open_at  INTEGER NOT NULL,                                             -- UTC ms
  nominations_close_at INTEGER NOT NULL,
  withdrawal_close_at  INTEGER NOT NULL,
  voting_open_at       INTEGER NOT NULL,
  voting_close_at      INTEGER NOT NULL,
  seal_salt            TEXT NOT NULL,                                                -- random; one part of the key that seals the ballots (the other part is a server secret)
  attendance_session_id TEXT,                                                        -- optional: paper ballots are given only to people marked present in this attendance session
  roll_pub_id          TEXT,                                                         -- the frozen voter list the election reads (set when the notice goes out)
  roll_fingerprint     TEXT,
  roll_voters          INTEGER,
  roll_weight_milli    INTEGER,
  candidates_fingerprint TEXT,
  signoff_json         TEXT,
  created_by           TEXT NOT NULL,                                                -- private code of the person who made the election
  created_at           INTEGER NOT NULL,
  notice_at INTEGER, final_at INTEGER, opened_at INTEGER, closed_at INTEGER, counted_at INTEGER, declared_at INTEGER,
  CHECK (nominations_open_at < nominations_close_at AND nominations_close_at <= withdrawal_close_at AND withdrawal_close_at <= voting_open_at AND voting_open_at < voting_close_at)
);
CREATE INDEX idx_el_elections_society ON el_elections(society_id, created_at);

-- the rules are fixed when the notice goes out; only the voting end time can move, and only later (see "extend")
CREATE TRIGGER trg_el_rules_frozen BEFORE UPDATE OF society_id, title, term, mode, weighting, nota, random_order, uncontested, tie_rule, appeal_hours, challenge_hours, nominations_open_at, nominations_close_at, withdrawal_close_at, voting_open_at, seal_salt, attendance_session_id, created_by, created_at ON el_elections
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'guard_failed:The rules are fixed. They cannot change after the notice is out.::end'); END;
CREATE TRIGGER trg_el_voting_end_later BEFORE UPDATE OF voting_close_at ON el_elections
WHEN OLD.status <> 'draft' AND NEW.voting_close_at < OLD.voting_close_at
BEGIN SELECT RAISE(ABORT, 'guard_failed:The voting time can be made longer, never shorter.::end'); END;
CREATE TRIGGER trg_el_no_delete BEFORE DELETE ON el_elections BEGIN SELECT RAISE(ABORT, 'an election is kept'); END;
-- an election can only move forward: draft, notice, candidates_final, voting, closed, counted, declared
CREATE TRIGGER trg_el_status_forward BEFORE UPDATE OF status ON el_elections
WHEN NEW.status <> OLD.status AND (CASE NEW.status WHEN 'draft' THEN 0 WHEN 'notice' THEN 1 WHEN 'candidates_final' THEN 2 WHEN 'voting' THEN 3 WHEN 'closed' THEN 4 WHEN 'counted' THEN 5 WHEN 'declared' THEN 6 END)
  <= (CASE OLD.status WHEN 'draft' THEN 0 WHEN 'notice' THEN 1 WHEN 'candidates_final' THEN 2 WHEN 'voting' THEN 3 WHEN 'closed' THEN 4 WHEN 'counted' THEN 5 WHEN 'declared' THEN 6 END)
BEGIN SELECT RAISE(ABORT, 'guard_failed:An election only moves forward.::end'); END;

CREATE TABLE el_posts (
  id          TEXT PRIMARY KEY,
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  n           INTEGER NOT NULL CHECK (n BETWEEN 1 AND 20),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  seats       INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 20),
  max_votes   INTEGER NOT NULL CHECK (max_votes BETWEEN 1 AND 20),                   -- how many people one voter may choose for this post
  kind        TEXT NOT NULL DEFAULT 'pending' CHECK (kind IN ('pending','contested','unopposed','vacant')),
  CHECK (max_votes <= seats),
  UNIQUE (election_id, n),
  UNIQUE (election_id, id)
);
CREATE TRIGGER trg_el_posts_frozen_i BEFORE INSERT ON el_posts WHEN (SELECT status FROM el_elections WHERE id = NEW.election_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'guard_failed:The posts are fixed. They cannot change after the notice is out.::end'); END;
CREATE TRIGGER trg_el_posts_frozen_u BEFORE UPDATE OF election_id, n, title, seats, max_votes ON el_posts WHEN (SELECT status FROM el_elections WHERE id = OLD.election_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'guard_failed:The posts are fixed. They cannot change after the notice is out.::end'); END;
CREATE TRIGGER trg_el_posts_frozen_d BEFORE DELETE ON el_posts WHEN (SELECT status FROM el_elections WHERE id = OLD.election_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'guard_failed:The posts are fixed. They cannot change after the notice is out.::end'); END;

-- the returning officer (exactly one), counting agents and observers
CREATE TABLE el_officials (
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  email       TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('returning_officer','counting_agent','observer')),
  name        TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (election_id, email, role)
);
CREATE UNIQUE INDEX uq_el_one_officer ON el_officials(election_id) WHERE role = 'returning_officer';
CREATE TRIGGER trg_el_officials_frozen_i BEFORE INSERT ON el_officials WHEN (SELECT status FROM el_elections WHERE id = NEW.election_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'guard_failed:The officials are fixed. They cannot change after the notice is out.::end'); END;
CREATE TRIGGER trg_el_officials_frozen_d BEFORE DELETE ON el_officials
WHEN (SELECT status FROM el_elections WHERE id = OLD.election_id) <> 'draft'
 AND (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'guard_failed:The officials are fixed. They cannot change after the notice is out.::end'); END;
CREATE TRIGGER trg_el_officials_no_update BEFORE UPDATE ON el_officials BEGIN SELECT RAISE(ABORT, 'guard_failed:Remove the official and add again.::end'); END;

CREATE TABLE el_nominations (
  id              TEXT PRIMARY KEY,
  election_id     TEXT NOT NULL REFERENCES el_elections(id),
  post_id         TEXT NOT NULL,
  roll_row_id     INTEGER NOT NULL,                                                  -- the candidate's line on the frozen voter list
  email           TEXT NOT NULL COLLATE NOCASE,
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL,
  proposer_roll_id INTEGER NOT NULL,
  seconder_roll_id INTEGER NOT NULL,
  declaration     TEXT NOT NULL CHECK (length(declaration) BETWEEN 10 AND 300),
  statement       TEXT NOT NULL DEFAULT '' CHECK (length(statement) <= 400),        -- the same space for every candidate
  status          TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','rejected','withdrawn')),
  decided_at      INTEGER,
  decided_by      TEXT,
  decision_reason TEXT NOT NULL DEFAULT '',
  appeal_text     TEXT,
  appealed_at     INTEGER,
  appeal_status   TEXT CHECK (appeal_status IN ('open','upheld','dismissed')),
  appeal_reason   TEXT NOT NULL DEFAULT '',
  appeal_decided_at INTEGER,
  withdrawn_at    INTEGER,
  submitted_at    INTEGER NOT NULL,
  FOREIGN KEY (election_id, post_id) REFERENCES el_posts(election_id, id),
  UNIQUE (election_id, post_id, roll_row_id)
);
CREATE INDEX idx_el_nominations ON el_nominations(election_id, post_id, status);
-- the returning officer and the other officials cannot stand (the application checks first and says why; this is the second lock)
CREATE TRIGGER trg_el_officials_not_candidates BEFORE INSERT ON el_nominations
WHEN EXISTS (SELECT 1 FROM el_officials o WHERE o.election_id = NEW.election_id AND o.email = NEW.email)
BEGIN SELECT RAISE(ABORT, 'guard_failed:The returning officer and the other election officials cannot stand in this election.::end'); END;
CREATE TRIGGER trg_el_nominations_no_delete BEFORE DELETE ON el_nominations
WHEN (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'nominations are kept'); END;

-- the second code (sent to the e-mail ID just before the ballot opens) and the one-time ballot ticket it unlocks
CREATE TABLE el_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  roll_row_id INTEGER NOT NULL,
  code_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);                                                                                 -- a used code is deleted at once (nothing keeps who used it, or when)
CREATE INDEX idx_el_codes ON el_codes(election_id, roll_row_id, id);
CREATE TABLE el_tickets (
  id          TEXT PRIMARY KEY,                                                      -- a hash of the ticket, never the ticket
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  roll_row_id INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);                                                                                 -- deleted when the vote is cast: a used ticket keeps no person and no time

-- THE REGISTER: who has voted (and how: online or on paper). One row per voter per election; the database refuses a second.
CREATE TABLE el_voted (
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  roll_row_id INTEGER NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('online','paper')),
  by_pid      TEXT NOT NULL,                                                         -- private code of the voter (online) or of the person who gave the paper ballot
  voted_at    TEXT NOT NULL CHECK (voted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- the calendar day only (society time zone), never the hour: sequential voters cannot be matched to a time
  PRIMARY KEY (election_id, roll_row_id)
) WITHOUT ROWID;

-- THE BALLOTS: no voter, no time, no counter. The choice is sealed (AES-GCM) with a key made from a server secret and the election's salt.
CREATE TABLE el_ballots (
  id           TEXT PRIMARY KEY,
  election_id  TEXT NOT NULL REFERENCES el_elections(id),
  post_id      TEXT NOT NULL,
  weight_milli INTEGER NOT NULL CHECK (weight_milli > 0),
  sealed       TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_el_ballots_post ON el_ballots(election_id, post_id);

-- THE RECEIPTS: a hash of a random code. No voter, no ballot, no time.
CREATE TABLE el_receipts (
  election_id  TEXT NOT NULL REFERENCES el_elections(id),
  receipt_hash TEXT NOT NULL,
  PRIMARY KEY (election_id, receipt_hash)
) WITHOUT ROWID;

-- register, ballots, receipts: append-only. A row can be deleted only when the whole list has been erased (the erase batch sets erased_at first).
CREATE TRIGGER trg_el_voted_no_update BEFORE UPDATE ON el_voted BEGIN SELECT RAISE(ABORT, 'the register is append-only'); END;
CREATE TRIGGER trg_el_voted_no_delete BEFORE DELETE ON el_voted
WHEN (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'the register is append-only'); END;
CREATE TRIGGER trg_el_ballots_no_update BEFORE UPDATE ON el_ballots BEGIN SELECT RAISE(ABORT, 'ballots are append-only'); END;
CREATE TRIGGER trg_el_ballots_no_delete BEFORE DELETE ON el_ballots
WHEN (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'ballots are append-only'); END;
CREATE TRIGGER trg_el_receipts_no_update BEFORE UPDATE ON el_receipts BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER trg_el_receipts_no_delete BEFORE DELETE ON el_receipts
WHEN (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;

-- every count; a recount is a new count that points at the earlier one, and the earlier one stays
CREATE TABLE el_counts (
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  count_no    INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('first','recount')),
  reason      TEXT NOT NULL DEFAULT '',
  paper_json  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  reconciled  INTEGER NOT NULL CHECK (reconciled IN (0,1)),
  counted_by  TEXT NOT NULL,
  counted_at  INTEGER NOT NULL,
  audit_seq   INTEGER NOT NULL,
  PRIMARY KEY (election_id, count_no)
);
CREATE TRIGGER trg_el_counts_no_update BEFORE UPDATE ON el_counts BEGIN SELECT RAISE(ABORT, 'a count is never changed; make a recount'); END;
CREATE TRIGGER trg_el_counts_no_delete BEFORE DELETE ON el_counts
WHEN (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a count is never changed; make a recount'); END;

CREATE TABLE el_challenges (
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  n           INTEGER NOT NULL,
  roll_row_id INTEGER NOT NULL,
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 10 AND 600),
  filed_at    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  answer      TEXT NOT NULL DEFAULT '',
  answered_by TEXT,
  answered_at INTEGER,
  PRIMARY KEY (election_id, n)
);
CREATE TRIGGER trg_el_challenges_rewrite BEFORE UPDATE ON el_challenges
WHEN NEW.election_id <> OLD.election_id OR NEW.n <> OLD.n OR NEW.roll_row_id <> OLD.roll_row_id OR NEW.text <> OLD.text OR NEW.filed_at <> OLD.filed_at OR OLD.status <> 'open'
BEGIN SELECT RAISE(ABORT, 'a challenge is kept as filed; it can be answered once'); END;
CREATE TRIGGER trg_el_challenges_no_delete BEFORE DELETE ON el_challenges
WHEN (SELECT s.erased_at FROM societies s JOIN el_elections e ON e.society_id = s.id WHERE e.id = OLD.election_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'challenges are kept'); END;

-- the public trail of what the people running the election did (no personal data); each line also sits in the signed audit trail (audit_seq)
CREATE TABLE el_events (
  election_id TEXT NOT NULL REFERENCES el_elections(id),
  n           INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,
  role        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  audit_seq   INTEGER NOT NULL,
  PRIMARY KEY (election_id, n)
);
CREATE TRIGGER trg_el_events_no_update BEFORE UPDATE ON el_events BEGIN SELECT RAISE(ABORT, 'the election trail is append-only'); END;
CREATE TRIGGER trg_el_events_no_delete BEFORE DELETE ON el_events BEGIN SELECT RAISE(ABORT, 'the election trail is append-only'); END;
