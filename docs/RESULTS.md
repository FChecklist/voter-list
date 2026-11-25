# Results (first chunk)

Results turns a closed meeting or election into one declared result that anyone can check. It is built the way Attendance was built: its own tables, its own routes, no screens yet, and it talks to the other parts of Voter List only by reading their public facts (the final voter list and the attendance count). **It is dark.** Every Results address answers "not found" until the owner switches it on with `RESULTS_ENABLED=1`. Nothing is deployed, and no database was changed.

Results has no payment code at all, so the money flag does not touch it.

## How a result is made

1. **The closing.** The Organizer enters a meeting or election that has closed, with its counts: for a meeting, each motion with its votes for, against and abstain; for an election, the ballots and each candidate's votes. A closing is kept as it was entered and is never changed. A new revision is added only when a result is corrected.
2. **The draft result.** The server makes the result from the closing. Nobody types a result in. The server works out the outcomes, runs the checks, writes the rule in words, takes the final voter list and the attendance count, and gives the whole result a fingerprint. A challenge window starts (48 hours unless the Organizer chose 0 to 720).
3. **FINAL.** After the challenge window has ended, and only if no check failed, the Organizer types FINAL. From then on the result can never be changed.
4. **A correction.** A mistake is put right with a new result that points at the old one. The old one stays, marked "Replaced by a correction", and the whole chain stays visible.

Every step writes one signed line into the list's audit trail. That line holds ids, counts and the fingerprint, and never a name, an e-mail ID or a phone number.

## What the counting does

- A motion passes by its own rule: **simple** (more votes for than against), **two_thirds** or **three_quarters** of the votes for and against. Abstentions count neither way. With no votes for or against, the motion shows "No votes for or against".
- In an election, the candidates with the most votes win the seats of a post. A post with no more candidates than seats is won by its candidates, and an empty seat is shown. A tie for the last seat stays open until the Organizer names who won it under the stated rule (`lot`, `chair` or `revote`). Until then the result carries a failed check and cannot be made final.
- The quorum is a number of people or a percent of the people who may attend, read from a closed attendance session. A quorum that is asked for but cannot be checked counts as failed.

## The checks

A failed check stops FINAL, in the code and in the database. A warning is shown to everyone who reads the result.

| Check | Level | What it says |
| --- | --- | --- |
| `list_frozen_late` | fail | The final voter list was frozen after the meeting or election closed. |
| `quorum` | fail | The quorum was not met, or no attendance session is linked to check it. |
| `votes_over_list`, `ballots_over_list` | fail | More votes or ballots than the final list allows. |
| `votes_over_present` | fail | More votes on a motion than people marked present. |
| `votes_over_ballots` | fail | A post has more votes than its ballots can give (ballots times seats). |
| `tie_unsettled` | fail | A tie is not settled by the stated rule. |
| `list_event`, `attendance_missing`, `attendance_open`, `entered_by_hand`, `late_entry`, `no_observers`, `no_supervisor` | warning | Things a reader should know. |

## Who can do what

- **Organizer:** enters a closing, makes a result, makes it final, corrects it, chooses who may see it.
- **Co-organizer:** can read results, check them and download the sheet. Names in what a co-organizer sees are masked.
- **The public:** sees only what the Organizer chose: **hidden** (the default; answers "not found", the same as a result that does not exist), **masked** (names shown like "As**** Co****") or **full**. Public pages ask search engines not to list them.
- Meetings and Elections are separate products and are not in this repository, so for now only the Organizer can enter a closing, and every such result carries the warning `entered_by_hand`.

## Switching it on

`RESULTS_ENABLED` must be exactly `1`. Any other value, or none, keeps every Results address dark. `wrangler.toml` leaves it unset. The migration is `migrations/0012_results.sql`. Applying it to a real database, and the switch itself, wait for the owner's go-ahead. When it is applied, apply the migration before the new code is published, because erasing a list now also clears the two Results tables.

## For an AI helper

Copy this link and paste in your AI to work.

The steps below are what the helper follows. It signs in as the Organizer with the same e-mail code as the rest of Voter List, and it keeps the session cookie. `<sid>` is the id of the list. Times are in the list's own time zone, written like `2026-11-12T20:00`. Every error comes back as `{ "error": "a plain sentence", "code": "a_short_code" }` with the HTTP status.

1. **Find out if Results is on.** `GET /api/lists/<sid>/results` answers 404 `not_found` while it is dark.
2. **Make sure a final voter list is frozen.** Results reads it. Without one, step 4 answers 409 `no_final_list`. If the meeting or election had an Attendance session, close it first.
3. **Enter the closing.** `POST /api/lists/<sid>/results/closings` answers 201 with `closing.id`. A meeting looks like this:
   ```json
   { "kind": "meeting", "ref": "AGM-2026", "title": "Owners assembly", "closedAt": "2026-11-12T20:00", "mode": "in_person",
     "challengeHours": 48, "attendanceId": "<optional attendance session id>", "quorum": { "type": "count", "value": 3 },
     "countedBy": ["Asha Counter"], "validatedBy": ["Vikram Validator"], "observers": ["Omar Observer"], "supervisedBy": ["Sunita Supervisor"],
     "motions": [ { "text": "Approve the accounts", "for": 3, "against": 0, "abstain": 0 },
                  { "text": "Change the by-laws", "for": 2, "against": 1, "threshold": "three_quarters" } ] }
   ```
   An election has `"kind": "election"`, `"ballots": 3`, `"tieRule": "lot"` and `"posts": [ { "name": "President", "seats": 1, "candidates": [ { "name": "Asha Rao", "votes": 2 } ] } ]` in place of the motions. `mode` is `in_person`, `online` or `offline`. `quorum.type` is `none`, `count` or `percent`. `listPubId` names a final list; without it the newest list frozen before the closing is used.
4. **Make the draft result.** `POST /api/lists/<sid>/results` with `{ "closingId": "<closing.id>" }` answers 201 with `result.id`, `content` (the outcomes, the rule and the checks), `notice`, `timeline` and the fingerprint.
5. **Read it.** `GET /api/lists/<sid>/results/<result.id>`. Look at `result.failedChecks` (it must be 0 to go on) and at `content.checks`. `GET /api/lists/<sid>/results` lists all results.
6. **Check it.** `GET /api/lists/<sid>/results/<result.id>/verify` answers `ok: true` when the stored result still gives its fingerprint and the signed audit lines carry the same fingerprint. Add `?code=` with 12 or more letters and digits from the printed fingerprint to compare a code read from paper.
7. **Make it final.** After `result.challengeEndsLocal` has passed, `POST /api/lists/<sid>/results/<result.id>/final` with `{ "confirm": "FINAL" }`.
8. **Choose who may see it.** `POST /api/lists/<sid>/results/<result.id>/visibility` with `{ "visibility": "masked" }` (or `full`, or `hidden`).
9. **Public pages.** `GET /api/v/<link>/results`, `GET /api/v/<link>/results/<result.id>` and `GET /api/v/<link>/results/<result.id>/verify` need no sign-in. A hidden result answers 404.
10. **Download the sheet.** `GET /api/lists/<sid>/results/<result.id>/export.csv` opens in any spreadsheet. Each download is written to the audit trail.
11. **Put a mistake right.** `POST /api/lists/<sid>/results/<result.id>/correct` with `{ "reason": "5 to 300 letters", "closing": { ...the corrected closing, same kind and ref... } }` answers 201 with the new draft result. The old one is marked as replaced. The new one keeps the visibility the old one had and starts its own challenge window.

Limits: 30 writes an hour for a list (closings, results and corrections together), answered with 429 and a polite message. Names are 2 to 80 letters, a title 2 to 80, a motion text 2 to 300, up to 30 motions, up to 20 posts, up to 60 candidates a post. Phone numbers and e-mail IDs in any text are refused.

## What is built, and what is not

**Built in this chunk:** the data model (closings, results, the three database guards: no change to a declared result, one live result for one meeting or election, and no FINAL with a failed check), the counting and the checks, the challenge window, FINAL, corrections that keep the old result, visibility with masked names, the sheet, the check for anyone, the signed audit lines, erase together with the list, and the tests.

**Not built yet, and why:**

- Screens for the Organizer and the public, and a help page. This chunk is the API only, as Attendance chunk 1 was. Screens come next.
- E-mails about a result (CP-321, CP-322): they need the mail wording reviewed and share the account's daily mail allowance.
- A result PDF with signature and QR code (CP-326), a WhatsApp share (CP-331) and a handover pack (CP-329).
- Pages and e-mails in other languages (CP-332, CP-349). The Hindi lines for the messages come with the screens, and a native Hindi reader must check them.
- Challenge forms for voters (CP-285, CP-294).
- Sign-off by e-mail from the people who counted and validated (CP-410 to CP-413). Their names are recorded as the Organizer typed them.
- Automatic delivery of a closing from the Meetings and Elections products. They are not in this repository.
- Results for a list made from an uploaded attendance sheet. Such a list has no final voter list to stand on, so every Results address answers "not found" for it.
- An archive certificate (CP-339). Erasing a list removes its results with it, and the audit trail still checks out.
- Page tests for each country (CP-350).
- Not run on real Cloudflare D1. The same migrations and statements run on `bun:sqlite` in the tests.

## Tests

`test/results-core.test.ts` (30 tests) covers the counting rules, the cleaning of a closing and the fingerprint with no database, and checks the counting on thousands of seeded random posts and on every pair of votes up to 60. `test/results.test.ts` (28 tests) goes through the real handler and the real migrations: dark by default, a full meeting, a failed check that blocks FINAL (also with a direct write to the database), an election with an open tie and its correction, the chain of corrections, the database guards, checking and tampering, what the public sees, permissions between lists, the sheet, the timeline, erase, a list made from an uploaded sheet (it has no Results), and two requests at the same moment (one wins, the other gets a plain 409).

Each rule was also broken on purpose to prove its test fails: the challenge window, the hidden answer, the two-thirds line, the one live result, the plain 409 for a clash, and the guard on FINAL.
