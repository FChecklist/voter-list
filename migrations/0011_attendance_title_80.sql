-- Session titles are at most 80 letters. Migration 0009 allows 120 and must never be edited once it may have run,
-- and SQLite cannot change a CHECK, so the limit is enforced by triggers.
CREATE TRIGGER IF NOT EXISTS trg_att_sessions_title_ins BEFORE INSERT ON att_sessions
WHEN length(NEW.title) > 80
BEGIN SELECT RAISE(ABORT, 'session title is at most 80 letters'); END;
CREATE TRIGGER IF NOT EXISTS trg_att_sessions_title_upd BEFORE UPDATE OF title ON att_sessions
WHEN length(NEW.title) > 80
BEGIN SELECT RAISE(ABORT, 'session title is at most 80 letters'); END;
