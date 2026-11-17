# Audit round 19 (independent, fresh reviewer, drove the real UI in a browser)

Date: 14 Nov 2026. Commit audited: 25d945c. Reviewer's verdict: **AUDIT: FAIL** (two MEDIUM findings). 182 tests passed; typecheck clean; round 18 fixes confirmed; masking, freeze, proof, export, e-mail rules and caps confirmed sound.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| M1 | MEDIUM | A Host could take back the Organizer's authorization through "undo". | Fixed: undo of an authorization is Organizer-only (403 for a Host, shown as not undoable to a Host). Test added. |
| M2 | MEDIUM | A Host could set authorization through an upload sheet. | Fixed: a Host's upload ignores the "Authorized to vote" column. Test added. |
| L1 | LOW | Default authorization changes with the head-count of a flat. | Accepted and documented in ASSUMPTIONS.md (both directions). |
| L2 | LOW | Step 5 card said "All clear" with warnings open. | Fixed ("N to look at"). |
| L3 | LOW | The flats table re-sorted after each choice. | Fixed: waiting-first order only applies when not every flat fits; otherwise the order stays put. |
| L4 | LOW | README still said "one voter per flat". | Fixed. |
| L5 | LOW | PROGRESS described the preview build as the audited code. | Fixed. |
| L6 | LOW | Plan and token details in the public docs. | Fixed: generalized. |
| L7 | LOW | PDF weight header. | Fixed ("Wt (flat)"). |
| L8 | LOW | The "choose who may vote" hint shown to a Host. | Fixed (neutral wording). |
