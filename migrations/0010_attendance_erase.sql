-- A mark can be deleted only when its list has been erased (the erase batch sets erased_at first). Everything else stays append-only.
DROP TRIGGER IF EXISTS trg_att_marks_no_delete;
CREATE TRIGGER trg_att_marks_no_delete BEFORE DELETE ON att_marks
WHEN (SELECT erased_at FROM societies WHERE id = OLD.society_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'attendance marks are append-only'); END;
