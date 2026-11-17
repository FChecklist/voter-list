# Audit round 28 - result: AUDIT: PASS

Date: 14 Nov 2026. Code audited: `src/` and `public/` unchanged since round 27 (the only later commit, `679a14f`, touches documents and tests). A fresh read-only reviewer with a different method: a randomized test of more than 40 sequences of 220 steps mixing Organizer, Host and voter actions (edit, move, undo, remove, re-add, upload, withdraw and re-enrol), plus marker strings in every private field scanned across every public output. 215 tests passed; typecheck clean.

No finding of medium severity or higher. Rounds 27 and 28 are two passes in a row, so the combined change may be deployed to the preview.

Low notes (not fixed, so the audited code stays as audited; each is a follow-up):
1. If the Organizer tightens the public-reason setting in Step 1, a draft already published keeps its older wording until the next publish (the page says so). Fix later: publish again in the same request.
2. A Host can set "Allowed to vote = No" with their own reason on a person the Organizer authorized. It is logged, visible, and the Organizer can reverse it. Accepted (round 24, point 6).
3. A lone person the Organizer said no to can withdraw and re-enrol under another e-mail. Accepted (rounds 23 and 26).
4. A row with a "no" from before migration 0007 has no owner mark; a Host may fill in its reason. Matters only for an old, populated database; none is deployed.
5. `canVote` in a hand-made request is not type-checked (`"false"` is truthy). The pages send true booleans. Fix later.
6. A Host's undo of a very large import makes one query per 90 people; this may exceed the free plan's query limit per call. To be seen in the smoke test.
7. In Step 5, "Change the reason" on a person who carries only a Host's block turns "undecided" into an Organizer "No".
8. The contact check refuses "Sold flat.In process" (the missing space after the full stop looks like a web address).
9. A sheet row with "Yes" and a reason is reported as a problem, and the person is imported as authorized with the reason dropped.

Not checked by the reviewer: real D1, a real Cloudflare send, the Organizer page in a browser.
