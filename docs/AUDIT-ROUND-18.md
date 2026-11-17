# Audit round 18 (independent, fresh reviewer): sender fixes, "Owner / 1st Name in Registration", several people per flat

Date: 14 Nov 2026. Commit audited: 265293b. Reviewer's verdict: **AUDIT: FAIL** (two MEDIUM findings; no BLOCKER or HIGH). 179 tests passed; typecheck clean. The round 17 fixes were confirmed correct with no regression.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| M1 | MEDIUM | The "Add a person" dialog showed the bare stored role "Owner". | Fixed: the options go through `VL.cap`; a test checks it. |
| M2 | MEDIUM | The Step 5 table of multi-person flats was capped at 300, unsorted, and resolved flats stayed in it, so flats beyond the cap could not be authorized. | Fixed: flats still waiting for a choice come first, the cap is 400 with a visible "N more flats are not shown" note and a pointer to the upload sheet, and many "nobody authorized" warnings fold into one line after ten. |
| L1 | LOW | A missing or non-boolean `authorized` meant "authorize". | Fixed: only `true` or `false` are accepted (400 otherwise); only an absent key defaults to true. |
| L2 | LOW | The hint for an ineligible lone person was misleading. | Fixed: the hint now points to the real remedies. |
| L3 | LOW | A lone person authorized by default loses that when a second person is approved (warning only). | Judged acceptable by the reviewer; documented in ASSUMPTIONS.md. Step 5 warns and shows the flat first. |
| L4 | LOW | Many W_NO_VOTER warnings could push others out of the 100-issue list. | Fixed (folded after ten). |
| L5 | LOW | Two wordings for "not authorized" in exports; dead helper. | Fixed (one wording). |
| L6 | LOW | CSV weight column could be summed twice. | Fixed: the column is headed "Weight (of the flat)". |
| L7 | LOW | Lowercase role words and "Voter says" wording. | Fixed. |
| L8 | LOW | No Hindi for "flat, as role". | Fixed (pattern added). |
| L9 | LOW | Smoke row 23 outside the table; stale counts and comments. | Fixed. |
| L10 | LOW | Test gaps (other-flat or other-list person, frozen list, Host views and calls, proof after two authorized). | Fixed: tests added. One of them found a real fault on the way (a Host could authorize): authorizing is now an **Organizer-only** action, and a Host sees the flats with names in the short form. |
