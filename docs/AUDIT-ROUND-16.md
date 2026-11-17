# Audit round 16 (independent)

Auditor: a sixteenth fresh reviewer, read-only; ran the tests (160 pass), the type check, the Function bundle check (192 KB, no `bun:` or `node:` imports), five attack scripts plus a scale script against the real handler (concurrency, the whole voter journey, frozen lists, the Organizer flow, races), and a browser session at 375 px in Hindi and English. Date 13 Nov 2026. Reviewed commit: `5e02280`.

**Verdict: AUDIT: PASS** (0 BLOCKER, 0 HIGH, 0 MEDIUM, 8 LOW). Requirements 1 to 8 MET; 9 PARTLY (free-plan CPU and D1 behaviour, unverified until the preview smoke test). This is the second PASS in a row (round 15 was the first), after sixteen rounds in all.

Held up: eight concurrency races (one winner each, hosts ended at 10, the audit chain verified); every change refused after the freeze, with triggers on the stored lists and the log; the India-time cut-off to the millisecond; public masks in the CSV and PDF; the standing host; document limits under a race; Hindi coverage.

## Findings (all LOW; code left as audited, to follow after the preview)

| ID | Finding | Disposition |
|---|---|---|
| L1 | The 5-homes limit is checked and then inserted, so 8 parallel requests can pass it (still bounded by 12 enrolments a day per e-mail ID). | Follow-up: enforce in the insert. |
| L2 | Undoing an import of more than 5,000 rows leaves the rest, and the undo bar names a smaller count. | Follow-up: lift the cap for one batch and show the true count. |
| L3 | A refused enrol or document attempt counts toward the daily limit, so many typing mistakes can lock a voter out for the day. | Follow-up: count after validation. |
| L4 | A record the team removed disappears from the voter's page without a word. | Follow-up: a short "removed by the list team" note. |
| L5 | If the chosen voter of a two-person flat withdraws, the other person waits for the Organizer to choose again (the checks say so). | Follow-up: offer the remaining person automatically. |
| L6 | In Hindi, "Reason:" in the sent-back box stays English. | Follow-up: own element for the label. |
| L7 | The Withdraw dialog does not repeat that a signed final list keeps the person (the notice does). | ASSUMPTIONS corrected; the sentence is a follow-up. |
| L8 | An uploaded name may contain angle brackets (shown as text; no exploit). | Follow-up: strip them. |
