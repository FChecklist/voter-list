# Audit round 22 (independent, fresh reviewer; real handler and browser)

Date: 14 Nov 2026. Commit audited: c73803f. Verdict: **AUDIT: FAIL** (three MEDIUM). 186 tests passed; typecheck clean. Of 10 deliberate mutations, 9 were caught. Counts agree across Step 5, draft, frozen list, public page and exports; e-mail rules, access control, masks, phone width, tree hygiene sound.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| A1 | MEDIUM | The Organizer could not say no to a lone, default-authorized person from the page. | Fixed: a "Look up any flat" box in Step 5 (any flat, any size), with the same buttons. Test added. |
| A2 | MEDIUM | A Host could discard the Organizer's choices (move a person out and back; remove and re-add; withdraw and re-enrol). | Fixed: a Host cannot move a person who carries the Organizer's mark; a removed and re-added person keeps the mark for that flat; a move by the Organizer clears the mark and the trail names "authorization"; undo of an authorization has its own trail name. Tests added. |
| A3 | MEDIUM | An upload's lone-in-sheet default took the default vote from someone already registered in that flat. | Fixed: the default is not applied to a flat that already has people. Test added. |
| L1 | LOW | "unit" wording in a hint. | Fixed. |
| L2 | LOW | Two unused helper functions. | Removed. |
| L3 | LOW | No test for uploading the new label. | Test added. |
| L4 | LOW | Undo of an authorization was a generic trail entry. | Fixed. |
