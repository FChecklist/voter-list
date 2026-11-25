-- One person marks themselves once per session: an e-mail ID is one person, even when it is on more than one flat.
-- A mark made by e-mail code keeps the private code of the e-mail ID in `marked_by`, so one code can appear once per session among those marks.
-- Marks made by the Organizer or a co-organizer are not held to this (they mark by flat). The PRIMARY KEY (session_id, voter_id) of 0009 still gives one mark per voter id.
-- Attendance is not deployed yet (see CHANGELOG.md), so no database is expected to hold two e-mail-code marks from one e-mail ID in one session.
-- If one does, this migration stops with an error (marks are append-only, so the owner decides what to do). It can run twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_att_marks_one_self_mark ON att_marks(session_id, marked_by) WHERE method = 'email';
