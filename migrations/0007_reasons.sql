-- 0007: why a person is not allowed to vote (owner requirement, 14 Nov 2026).
-- A person marked "not allowed" carries a chosen reason (a short code) and, when the Organizer or Host wishes, a few words of their own; who set it is kept
-- so a Host cannot change what the Organizer set. The publication keeps two texts per line: the one the society chose to show publicly and the full one for staff.
ALTER TABLE voters ADD COLUMN no_vote_reason TEXT;
ALTER TABLE voters ADD COLUMN no_vote_note TEXT;
ALTER TABLE voters ADD COLUMN no_vote_by TEXT;
-- what the public list may show: 'none', 'role' (reasons that follow from the role, such as Tenant; the default) or 'all' (also dues and the Organizer's own words)
ALTER TABLE societies ADD COLUMN reason_public TEXT NOT NULL DEFAULT 'role';
ALTER TABLE publication_rows ADD COLUMN reason_public TEXT NOT NULL DEFAULT '';
ALTER TABLE publication_rows ADD COLUMN reason_full TEXT NOT NULL DEFAULT '';
