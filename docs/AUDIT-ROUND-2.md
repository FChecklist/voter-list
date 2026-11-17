# Audit round 2 (independent)

Auditor: a second fresh reviewer, read-only, who read the code, ran the tests and **drove both pages in the browser** at phone and laptop width as voter, Organizer, Host and the standing host. Date 13 Nov 2026. Reviewed commit: `0ac8464`.

**Verdict: AUDIT: FAIL** (2 HIGH, 7 MEDIUM, 12 LOW, no BLOCKER). `bun test --isolate` 87 pass, typecheck clean. Requirement table from the auditor: 1 MET, 2 PARTLY, 3 PARTLY, 4 MET, 5 MET, 6 MET, 7 PARTLY, 8 MET, 9 PARTLY.

Round-1 fixes it confirmed working: own-record refusal, stale-revision refusal, the 11th-host trigger, after-cut-off refusals, frozen-list refusals, no personal data in the signed log, immutability triggers, cross-list 404s. One was incomplete (F3, see H1).

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | HIGH | An approved voter had no Withdraw button (the API allowed it, the page never offered it) while the consent line promised it. | **Fixed.** `canWithdraw` is true for approved and for approved-then-changed records while the list is open. Test. |
| H2 | HIGH | The 80 a day mail allowance is shared by voters, staff codes and invitations; strangers could drain it for every list. | **Partly fixed.** The allowance is now two separate pools (voters: cap minus reserve; staff codes and invitations: the reserve), so neither side can lock out the other; one list may use at most two thirds of the voter pool; one account may send at most 15 invitations a day. Tests. **The size of the allowance itself is the owner's decision** (PROGRESS question 7, now with the arithmetic): about 60 voter sign-ins a day product-wide on the free allowance. A real society needs a larger sender, and a free Cloudflare Turnstile check on the sign-in start is the recommended hardening before launch. |
| M1 | MED | After the closing time, Step 1 could not be saved (the unchanged time was re-sent and refused) and "Close enrolment now" was not on the page. | **Fixed.** An unchanged closing time is ignored; Step 1 has a "Close enrolment now" button (with confirmation) and a note once enrolment is closed. Tests. |
| M2 | MED | Reopening and publishing a draft hid the signed final list; earlier finals were not reachable. | **Fixed.** Public list, PDF/CSV and proof accept `?pub=<id>` for any earlier final list; the voter page shows "Earlier final lists" with PDF and proof. Test. |
| M3 | MED | Proxy-letter and document rules were checked only at Send. | **Fixed.** Changing a sent record to Proxy without the letter is refused, and a document the record needs cannot be removed once it is with the team (add the new one first). Test. |
| M4 | MED | Public reads unmetered; documents in the database could fill the free storage. | **Partly fixed.** One list may keep at most 100 MB of documents. Public pages are cacheable (Cache-Control) and the preview smoke test measures reads. A separate object store for documents is a later step, if the free plan proves too tight. |
| M5 | MED | Thin DPDP notice; API still accepted "Government ID". | **Fixed.** A short itemised notice (purpose, retention, rights, contact) sits under the consent tick; "Government ID" is refused by the API. Test. |
| M6 | MED | Standing host: single-factor, 7-day session, every list; `/api/me` shows only the newest 200 lists. | **Documented, owner decision** (PROGRESS question 1). Every opening is logged and shown to the Organizer; the seat is named in the consent notice. |
| M7 | MED | Free-plan CPU and per-request query limits unproven. | **Documented.** The preview smoke test is the gate; fallbacks are in the README. |
| L1 | LOW | `Origin: null` gave a 500. | **Fixed** (403). Test. |
| L2 | LOW | Bulk selection has no select-all. | Accepted for v1 (60 per action by design). |
| L3 | LOW | Undo is only inside Step 4. | Accepted; Undo stays in Step 4 and the record history. |
| L4 | LOW | Raw words in the record history. | **Fixed.** |
| L5 | LOW | "Change" on Step 1 shows a fresh code form without sign-out. | Accepted. |
| L6 | LOW | Same element ids when the document form is open in two steps. | **Fixed.** |
| L7 | LOW | A re-created record keeps host-set flags. | Accepted (it is the same person and flat). |
| L8 | LOW | "Draft published" tick can go stale. | Accepted. |
| L9 | LOW | Irreversible actions accept a 7-day cookie without a fresh code. | Accepted; recorded as an owner option. |
| L10 | LOW | Code-guess window and a stranger blocking a named person's requests. | Accepted (limits are already per address and per code). |
| L11 | LOW | Blunt staff errors. | Accepted. |
| L12 | LOW | The local server is SQLite, not Workers and D1. | Known; the preview smoke test covers it. |
