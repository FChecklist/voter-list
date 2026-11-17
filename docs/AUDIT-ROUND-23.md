# Audit round 23 (independent, fresh reviewer; real handler and browser)

Date: 14 Nov 2026. Commit audited: d6722d3. Verdict: **AUDIT: FAIL** (one MEDIUM, four LOW). 189 tests passed; typecheck clean. Of 13 deliberate mutations, all 13 were caught by a test. The earlier rounds' fixes (17 to 22), the counts across Step 5, draft, frozen list, public page, CSV and PDF, the role label in every place, and the e-mail rules were found sound.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| F1 | MEDIUM | "Look up any flat": after a change the card refreshed itself, but the counts, the warnings and the "flats that need your choice" list above it stayed stale ("Everything looks right" with a flat nobody votes for). | Fixed: after any change the whole Step 5 page is read again, and the look-up comes back with it (same flat, same words). Enter now also runs the look-up. Test added. |
| F2 | LOW | With more than 400 flats lacking an authorized person, the "N more flats" line was counted from the capped issue list; with 100 or more other warnings the summary line could be cut. | Fixed: the number is the report's true count, and the summary line is kept (others are shortened first). Test added. |
| F3 | LOW | Head-count variant: a flat has A (authorized by the Organizer) and B (undecided); A is removed or withdraws; B is now alone and authorized by default, so the flat leaves the Step 5 table. | Documented in `ASSUMPTIONS.md` with the other head-count points (a lone person is authorized by default; the look-up lets the Organizer say no at any time). |
| F4 | LOW | A Host could undo the Organizer's "corrected" move of a person who carried a mark, putting the mark back. | Fixed: a Host can no longer undo any action that changed an authorization mark or a reason the Organizer gave (the Undo list shows it as not undoable for a Host). Test added. |
| F5 | LOW | A Host saw disabled buttons reading "Authorized ✓ (tap to take away)". | Fixed: a Host reads plain words ("Authorized", "Not authorized"). Test added. |

Not verified by this round: whether the Cloudflare Email Service accepts a quoted display name in `from` (smoke-test row 23 checks it with a real send), Hindi for the radio label on the signed-in enrol step, D1 on real Cloudflare, the PDF's visual layout of the long role label.

The same change set also adds the reasons for "not allowed to vote" (owner's requirement of 14 Nov 2026); that part is covered from round 24.
