# Audit round 25 (independent, fresh reviewer; real handler, browser walk, about 30 mutations)

Date: 14 Nov 2026. Commit audited: 7e03e66. Verdict: **AUDIT: FAIL** (two MEDIUM, five LOW). Typecheck clean; all tests passed. The reviewer walked the real pages (Step 1, Step 5 reason box by keyboard, look-up, record correction, Host view, voter status, public list in Hindi at 400 px) and found them sound apart from the points below. Privacy of the public list, exports and the signed trail, the e-mail rules, and speed at 3000 records (checks 111 ms) were found sound.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| R25-1 | MEDIUM | A Host could undo the Organizer's upload (the upload keeps no "after" state, so the guard saw nothing), then add the person again with no "no" and no reason. | Fixed: for an action that created records, the guard looks at the live record; a Host cannot undo an action whose people carry the Organizer's mark or reason. Test added. |
| R25-2 | MEDIUM | The sender name was sent to Cloudflare as a quoted string; Cloudflare's REST examples use `{ address, name }`. | Confirmed against Cloudflare's "Specify recipients" page and fixed: the sender is sent as `{ address, name }` (a bare address stays a string). Plan document corrected. Row 23 of the smoke test still checks a real send. Test added. |
| R25-3 | LOW | The contact-detail check refused ordinary notes (dates, amounts, flat numbers) with a misleading message and closed the dialog; some other-script digits and short links got through. | Fixed: runs of digits in any script (9 or more, even with spaces or dashes) and e-mail/link shapes are refused; dates and amounts pass; the box stays open with what was typed when the server says no. Test added. |
| R25-4 | LOW | The correction form said "Allowed to vote? Yes" for a person the Organizer had taken off in Step 5; saving only a new reason did nothing. | Fixed: the form shows the real state; a reason alone can be changed (Organizer, or Host when the Host gave it). Test added. |
| R25-5 | LOW | An undecided person had only "tap to authorize"; to say "no, Co-owner" the Organizer first had to authorize. | Fixed: a "Not allowed: choose a reason" button on undecided people. |
| R25-6 | LOW | The person's own words stay in the frozen list's rows. | Documented in `ASSUMPTIONS.md` (as with the name on that line, a frozen list is erased only as a whole). |
| R25-7 | LOW | After each Step 5 action the page jumped to Step 6. | Fixed: the page keeps its place. |

Mutations that survived and now have tests: unpaid dues from the society's dues check staying private by default, and a reason being cleared when a person moves flat. Not covered by a test: the 10-second provider timeout.
