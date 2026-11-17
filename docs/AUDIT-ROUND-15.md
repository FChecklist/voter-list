# Audit round 15 (independent)

Auditor: a fifteenth fresh reviewer, read-only. Sweep of every route: 60 routes parsed from the handler; 34 of the 36 staff routes called as a Host, the standing host and the Organizer, each response scanned for 40 synthetic secrets (names, e-mails, mobiles, proxy owner, document names and bytes); every public route (draft, final, `?pub=`, CSV, PDF, proof, error paths); four more attack scripts (authorization, CSRF, replay, frozen immutability, closed sign-up, mail pools, purge); the Function bundle; and a browser session at 375 px in English and Hindi. Tests 158 pass. Date 13 Nov 2026. Reviewed commit: `ebd3403`.

**Verdict: AUDIT: PASS** (0 BLOCKER, 0 HIGH, 0 MEDIUM, 7 LOW). Requirements 1 to 8 MET; 9 PARTLY (free-plan CPU and D1 behaviour, unverified until the preview smoke test).

Only the two record-opening routes returned personal details to a Host, and both are logged.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| L1 | LOW | A Host's dry-run check of a sheet could confirm a guessed e-mail on a flat with no log line. | **Fixed.** Every Host check of a sheet is noted in the log (counts only). Test. |
| L2 | LOW | A Host's correction without opening the record is logged but not rate-limited. | **Accepted, documented.** |
| L3 | LOW | The daily D1 rows-written budget was not in the plan. | **Fixed.** Smoke-test row 17 reads it from the dashboard; the figures are in the row. |
| L4 | LOW | Documents were served without a sandbox policy. | **Fixed.** Document and export responses carry `sandbox; default-src 'none'`. Test. |
| L5 | LOW | "Start another list" shown to Hosts. | **Accepted, documented** (the server refuses; cosmetic). |
| L6 | LOW | A Host's duplicate-name warnings run on masked names. | **Accepted, documented.** |
| L7 | LOW | The 10-host message did not say what to do. | **Fixed.** "Please free a seat first (pause or remove one host)." |
