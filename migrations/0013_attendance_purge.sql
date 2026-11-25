-- A withdrawn voter's details are erased after 30 days (purgeStale). Their attendance marks must go with them, or the voter row can never be deleted.
-- Marks stay append-only, with two exceptions: a list that has been erased (0010), and a person whose record is no longer on the list (status 'removed').
-- Only the purge deletes marks; nothing else in the code does. The session's present count drops by those marks.
DROP TRIGGER IF EXISTS trg_att_marks_no_delete;
CREATE TRIGGER trg_att_marks_no_delete BEFORE DELETE ON att_marks
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
 AND NOT EXISTS (SELECT 1 FROM voters v WHERE v.society_id = OLD.society_id AND v.id = OLD.voter_id AND v.status = 'removed')
BEGIN SELECT RAISE(ABORT, 'attendance marks are append-only'); END;
