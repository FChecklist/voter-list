# Audit round 20 (independent, fresh reviewer, drove the real UI in a browser)

Date: 14 Nov 2026. Commit audited: 009dc5a. Verdict: **AUDIT: FAIL** (one MEDIUM). 183 tests passed; typecheck clean. Round 19 fixes confirmed (a Host cannot choose, undo or upload an authorization; masked names; frozen list, proof, exports, phone width, e-mail rules all sound).

| ID | Sev | Finding | Handling |
|---|---|---|---|
| M1 | MEDIUM | A single-person flat had no control: a lone person left at "not authorized" (for example after the flat-mate was removed) or a lone person the rule does not allow could not be fixed from Step 5. | Fixed: Step 5 now lists every flat that needs a decision (several people, or nobody authorized, or a person the rule does not allow), each with a take-away / authorize button. Test added. |
| L1 | LOW | Undo list wording ambiguous. | Fixed. |
| L2 | LOW | "More flats" note pointed at uploads, which cannot change people already registered. | Fixed. |
| L3 | LOW | Importer note misleading for a Host. | Fixed. |
| L4 | LOW | Stale test count. | Fixed. |
