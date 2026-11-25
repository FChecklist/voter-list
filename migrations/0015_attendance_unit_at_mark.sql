-- The flat a person was in when they were marked present is kept on the mark, so moving the person to another flat later
-- does not change the flat shown for a past session. The column is written once, when the mark is inserted.
-- Marks stay append-only: the update trigger is dropped only to backfill rows made before this migration, and is created again, unchanged, in this same file.
ALTER TABLE att_marks ADD COLUMN unit_at_mark TEXT;
DROP TRIGGER IF EXISTS trg_att_marks_no_update;
UPDATE att_marks SET unit_at_mark = (SELECT v.unit FROM voters v WHERE v.society_id = att_marks.society_id AND v.id = att_marks.voter_id) WHERE unit_at_mark IS NULL;
CREATE TRIGGER trg_att_marks_no_update BEFORE UPDATE ON att_marks BEGIN SELECT RAISE(ABORT, 'attendance marks are append-only'); END;
