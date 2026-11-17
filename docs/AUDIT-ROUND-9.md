# Audit round 9 (independent)

Auditor: a ninth fresh reviewer, read-only; ran the tests (137 pass) and the type check, six attack scripts against the real handler (production-like settings), drove the voter page at phone width in Hindi and English (enrol as Tenant, send back, resubmit, approve, freeze, public list and proof), checked the README deploy plan and the build (Function bundle 139 KB, no `bun:` imports in the Worker path). Date 13 Nov 2026. Reviewed commit: `10f6422`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 2 MEDIUM, 5 LOW). Requirements 1 to 8 MET; 9 PARTLY (the e-mail guarantee, below).

Round-8 fixes reproduced: the withdrawn voter's draft line is cleared after 45 days (another voter's line and a signed final list untouched); the first-10 note limit (25 sent back, exactly 10 mailed, all 25 see the reason); Turnstile only with both keys; the mobile and e-mail columns in English and Hindi; the Step 7 Hindi sentences; no leak on any public surface (draft, final, `?pub=`, CSV, PDF text, proof); all authorization, CSRF, replay and freeze-tamper attempts.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | The 30-day clearing could delete a record the team removed, if the voter had withdrawn, come back, and the team later removed it (the old `withdrawn` event still counted). | **Fixed.** A record is cleared only when the voter's own withdrawal is the latest thing that happened to it. Test (withdraw, re-enrol, approve, remove, 45 days: kept). |
| M2 | MED | A stranger could become "known" for free (a self-made record counted), and so use the voters' pool through the "known" path: 15 newcomer plus 45 "known" mails exhausted it, and an uploaded voter got no code. | **Fixed.** "Known" now means vouched for by the team: uploaded, added by a host, approved or sent back. A record someone makes for themselves is a newcomer until the team has acted on it, so the per-list cap and the two-thirds limit apply. Docs and tests updated. |
| L1 | LOW | The daily pool was checked and then sent, so a 40-way burst overshot it. | **Fixed.** The slot is claimed and counted in one statement (`'queued'` until the provider answers). Test: 40 simultaneous mails, exactly 10 go out. |
| L2 | LOW | The public proof of a draft turned false after the purge. | **Fixed.** A draft's proof makes no line-by-line claim; a final list's still does. Test. |
| L3 | LOW | Hindi: dates stay English; "जमा" reads as "deposited"; stiff notice line. | **Partly fixed:** "frozen" now reads "बंद की गई". Dates in English form are documented. The native reader's review (already an open owner item) covers the rest. |
| L4 | LOW | The wider public table scrolls inside a box with no keyboard access or label. | **Fixed.** The scroll box is focusable and labelled (with its Hindi line). |
| L5 | LOW | ASSUMPTIONS contradicted itself on document size. | **Fixed.** |
