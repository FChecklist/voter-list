-- Voter List: hardening pass (second audit).
--   * guard_assert: a write-only "assertion" that aborts a whole D1 batch. A batch of statements is atomic, so a statement
--     such as `INSERT INTO guard_assert SELECT changes() = 1, 'why'` placed right after an UPDATE ... WHERE status='waiting'
--     turns "someone else got there first" into a clean rollback of everything in the batch (no half-applied decisions).
--   * list_changes gets the row it was about (row_ref) and, for a deleted line, a snapshot, so added/deleted/merged lines can be undone.
--   * one frozen copy per event, one open order per society, and indexes for the housekeeping deletes.
PRAGMA foreign_keys = ON;

CREATE VIEW guard_assert AS SELECT 1 AS ok, '' AS why;
CREATE TRIGGER trg_guard_assert INSTEAD OF INSERT ON guard_assert
WHEN NEW.ok IS NOT 1
BEGIN SELECT RAISE(ABORT, 'guard_failed:' || IFNULL(NEW.why, '') || '::end'); END;

ALTER TABLE list_changes ADD COLUMN row_ref INTEGER;
ALTER TABLE list_changes ADD COLUMN snapshot TEXT;

DROP TRIGGER trg_changes_no_rewrite;
CREATE TRIGGER trg_changes_no_rewrite BEFORE UPDATE ON list_changes
WHEN NEW.id <> OLD.id OR NEW.society_id <> OLD.society_id OR NEW.unit_key <> OLD.unit_key OR NEW.field <> OLD.field
  OR IFNULL(NEW.before_val,'') <> IFNULL(OLD.before_val,'') OR IFNULL(NEW.after_val,'') <> IFNULL(OLD.after_val,'')
  OR IFNULL(NEW.row_ref,-1) <> IFNULL(OLD.row_ref,-1) OR IFNULL(NEW.snapshot,'') <> IFNULL(OLD.snapshot,'')
  OR NEW.actor_email <> OLD.actor_email OR NEW.ts <> OLD.ts OR OLD.undone_by IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'change history is append-only'); END;

-- the same event cannot be frozen twice (a second click, a retry, two organizers)
CREATE UNIQUE INDEX uq_freeze_event ON freezes(society_id, event_type, lower(event_name), event_date);
-- at most one unused order per society and purpose: creating an order is idempotent
CREATE UNIQUE INDEX uq_order_open ON orders(society_id, purpose) WHERE used_for_version IS NULL;

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_otp_created ON otp_codes(created_at);
CREATE INDEX idx_outbox_created ON mail_outbox(created_at);
