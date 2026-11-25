-- Narrows 0013. A mark may be deleted only when its list is erased (0010), or while the 30-day clean-up of a withdrawn voter has put that voter in att_purge in the same batch.
-- A voter who is only removed no longer lets marks be deleted. Migration 0013 itself is left as released; this one drops and recreates the trigger.
CREATE TABLE IF NOT EXISTS att_purge (society_id TEXT NOT NULL, voter_id TEXT NOT NULL, PRIMARY KEY (society_id, voter_id));
DROP TRIGGER IF EXISTS trg_att_marks_no_delete;
CREATE TRIGGER trg_att_marks_no_delete BEFORE DELETE ON att_marks
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
 AND NOT EXISTS (SELECT 1 FROM att_purge p WHERE p.society_id = OLD.society_id AND p.voter_id = OLD.voter_id)
BEGIN SELECT RAISE(ABORT, 'attendance marks are append-only'); END;
