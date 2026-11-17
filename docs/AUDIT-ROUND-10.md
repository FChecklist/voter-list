# Audit round 10 (independent)

Auditor: a tenth fresh reviewer, read-only; ran the tests (141 pass) and the type check, four attack scripts against the real handler (seven purge scenarios, a purge scale test, the mail claim with injected failures, authorization, CSRF, replay and tamper attempts), and drove the voter page (Hindi sign-in, enrol, confirm, sent back, resubmit, Withdraw dialog, public table) and the Organizer page in the browser. Date 13 Nov 2026. Reviewed commit: `045b58f`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 1 MEDIUM, 8 LOW). Requirements 1 to 8 MET; 9 PARTLY (the MEDIUM, and free-plan CPU, which is accepted until the preview smoke test).

Round-9 fixes reproduced: the purge condition across seven scenarios (withdraw: purged; withdraw then re-enrol: kept; withdraw, host re-add, team remove: kept; team remove then Undo: kept; team remove alone: kept; import over a withdrawn record: skipped), "known means vouched", the atomic claim (one valid statement; a thrown provider call gives a clean 502; test mode never touches the production path), the draft proof, the labelled table. Authorization, CSRF, replay, frozen immutability (triggers), closed Organizer sign-up, public masks and the deploy plan all verified.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | The purge's correlated history lookup did not name the society, so the history index could not be used: about 2 seconds per purge with 600 kept removed records and 24,000 events, inline on 1 in 20 code requests. | **Fixed.** The society is named in every lookup (measured by the auditor at 2.2 ms afterwards). A test guards every occurrence. |
| L1 | LOW | An approved voter who edited their own record was demoted to a newcomer. | **Fixed.** A record the team has approved stays "known". Test. |
| L2 | LOW | A team-written send-back note stays in the history after the record is cleared. | **Accepted, documented** (notes may not hold contact details; the history rules forbid rewriting; changing that needs a migration). |
| L3 | LOW | An upload cannot bring back a person the team removed. | **Accepted, documented** ("Add a person" does it). |
| L4 | LOW | The CSV and PDF carry non-personal extra columns (weight, may attend, a short note). | **Owner's call**, added to PROGRESS question 3. |
| L5 | LOW | Dead count query in `sendMail`; stale comment. | **Fixed.** |
| L6 | LOW | A claimed mail slot never updated counted until midnight. | **Fixed.** A claim nobody answered for 10 minutes stops counting; the status update cannot break the send. Test. |
| L7 | LOW | The 30-day clearing runs only when the product is used. | **Accepted, documented.** |
| L8 | LOW | The preview shares the free Resend key with production. | **Fixed.** The deploy plan sets the preview's daily cap to 20. |
