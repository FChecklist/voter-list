# Changelog

Newest first. Dates are in IST. Every deployed change gets a new version here, in `public/version.json` and in `KNOWLEDGE.md` (see the Version section there).

## 0.3.5 - not deployed yet (IST)

Fix after round 9 of Attendance chunks 1-2 (an independent audit of 0.3.4 found one High defect).

- A voter who withdrew after being marked present could never be erased: after 30 days the clean-up (`purgeStale`) hit the foreign key from `att_marks` to `voters` and failed, and because it runs on about 1 in 20 sign-in requests, sign-in answered 500 for everyone. Now the clean-up deletes that person's attendance marks in the same batch, before the voter row. The choice is to delete, not to keep an anonymous count: a session's present count drops by the erased person's mark. Migration `0013_attendance_purge.sql` changes the delete trigger of `att_marks` so a mark can be deleted when its person's record is no longer on the list (status removed); marks of people still on the list stay append-only.
- Sign-in: a failing clean-up is logged ("purgeStale failed", no personal data) and never turns a sign-in into an error.
- Undo of a record that an import or a host added, when that person already has an attendance mark, answers 409 (`has_attendance`) with a plain message and changes nothing. (Removing the marks first was not chosen: marks are append-only.)
- Tests: `test/attendance-round10.test.ts`; the version test fails when a commit named in `public/version.json` does not exist.

## 0.3.4 - not deployed yet (IST)

Fixes after round 8 of Attendance chunks 1-2 (two independent audits of 0.3.3 failed it; this round closes the open Medium findings and the cheap Lows).

- The public session list (`/api/v/<link>/attendance` and the one-session answer) no longer shows the title or the place for any kind of list. Until now a list made from an uploaded sheet still showed them to anyone who held its link. Now only a voter who signed in with the e-mail code for that link and is on its list sees them (for a Voter List and for an uploaded sheet alike); the Organizer and co-organizer pages show them as before. This is the owner's privacy-favouring default, and the owner can change it (see `ASSUMPTIONS.md`, round 8).
- An e-mail ID is tidied the same way everywhere it is compared with the list or turned into a private code in Attendance (`myRows`, `markSelf`, `mark`, the one-mark rule and the public list): spaces, capital letters, `mailto:`, angle brackets and a trailing dot or comma, using the same `cleanEmail` the sign-in and the uploads use. One e-mail ID marks one person in a session however it is typed, and the same person is never counted twice. The enrol and upload paths (`importer.ts`, `review.ts`, `records.ts`, `attendance.ts`) already stored the tidied value; a test now says so. A `+tag` is kept as part of the e-mail ID (there is no rule that joins `a+tag@x` with `a@x` anywhere in the product), so those are two e-mail IDs.
- Cache: a request to the public session list that carries any cookie gets `private, no-store`; only a request with no cookie at all may be cached for 30 seconds (`public, max-age=30`, `Vary: Cookie`).
- `public/version.json`: the 0.3.3 entry named the same commit as 0.3.2 (`86394a1`). It now names `2bd234f`, the commit 0.3.3 was built on. Each of the two newest entries carries its own `commit`, and the top-level `commit` is the newest one's (`c93930d` for this version).
- Tests: the list of Hindi lines for a native reader must match the lines added exactly, in count and in words (before, it only checked there were more than 38); the Hindi consent scan also catches the Hindi words for rule, accept and permission, and a test shows a line with any of them fails it; the wording scan for possessive words also reads `KNOWLEDGE.md` and `CHANGELOG.md`. The `docs/` folder is not scanned: its notes are working papers, not screen text, and several older ones use those words.
- Open for the owner: the Hindi lines still need a native Hindi reader (unchanged); whether `a+tag@x` should be the same e-mail ID as `a@x`.

## 0.3.3 - not deployed yet (IST)

Fixes after round 7 of Attendance chunks 1-2.

- The public session list of a Voter List link (`/api/v/<link>/attendance` and the one-session answer) no longer shows the title or the place. It still shows the time, how, state and counts. A voter who signed in with the e-mail code for that link and is on its list still sees the title and place; that answer is never cached, and the public answer varies by cookie. A list made from an uploaded sheet keeps showing titles and places (a question to the owner, below).
- One e-mail ID marks one person in a session, even when it is on more than one flat. The voter page says so before the button, and a second try gets a plain message (`one_per_email`). The Organizer and co-organizers can still mark the other flats. Migration 0012 holds the same rule in the database for marks made by e-mail code.
- A co-organizer's view is now stated: the page says "Limited view" (the Organizer's says "Full view"); the sheet's column names say "(partly hidden)" and the file is `attendance-sheet-limited.csv`; the find box takes a flat or member ID only (a name typed there showed which row held it). The session answer carries `view`.
- Hindi lines for texts the server builds that had none: the sheet reader messages, the two code limits, the same-moment and already-closed messages, the failure message, the messages for a phone number in a title, place or name, the country names, and the count ("3 of 10") in the sessions table. The mode texts (In person, Online, Offline) already had Hindi lines; a test now ties every server-built text to a Hindi line. Every Hindi line added is listed in `lang/hi.js` as needing a native Hindi reader. No Hindi on any consent line.
- The wording scan for possessive words (the owner's rule) now covers every source file, the dev scripts and all pages, reads template strings fully, and a second scan checks the real answers, e-mails and sheets. One dev seed message was fixed.
- The upload form shows only the sheet reader's own messages, each with a Hindi line. A fault inside the reader or the decoder (a damaged zip, a bad sheet id, characters that are not base64) now shows "That file could not be read." instead of the engine's own English words.
- Pressing Mark present twice for the same flat at the same moment keeps the answer "This person is already marked present." (the one-person message is for another person).
- A first load that fails (not a missing sign-in, which opens the sign-in page, and not a closed list) shows a plain message and a Try again button on both pages, instead of a Loading line that never ends.
- The voter page header showed the names of page parts instead of the e-mail ID and had no Sign out button; fixed.
- Question for the owner: should the title and place of a list made from an uploaded sheet also be hidden from people who are not signed in? Today they are shown (the order named Voter List links only).

## 0.3.2 - not deployed yet (IST)

Fixes after round 6 of Attendance chunks 1-2.

- One list of every error message the pages can show (`src/error-messages.ts`); the server takes its attendance messages from it and a test checks each has a Hindi line (the country message had none; added).
- The test for the notice line also checks Hindi values, not only keys.
- An e-mail ID with no dot in its domain (a@localhost) is masked after the first letter.
- Each Mark present button in the Organizer table has an aria-label with the flat or member ID.
- The three Organizer sign-in routes are also checked in the pages test.

## 0.3.1 - not deployed yet (IST)

Fixes after round 5 of Attendance chunks 1-2.

- The Organizer sign-in page shows the e-mail ID masked after the code is sent.
- The voter page shows a plain closed message when the list is closed or erased.
- Hindi lines for the server error messages (to be checked by a native Hindi reader).
- Tests: formula-safe CSV cells, the three Organizer sign-in routes, the wording of the mark screen.

## 0.3.0 - not deployed yet (IST)

Attendance chunk 2: the screens.

- New Organizer page at `/attendance/`: sign in, choose a list or upload a sheet, create a session, see who is marked, mark present (Organizer and co-organizer), close a session (Organizer), download the attendance sheet as CSV.
- New voter page at `/attend/<link>`: sign in with the e-mail code, see open sessions, mark present in an online session. In-person and offline sessions say to ask the Organizer or a co-organizer.
- The attendance sheet CSV lists everyone who may attend with Present Yes or No, how and when marked. A co-organizer gets masked names and e-mail IDs. Cells that start like a formula are defused. Each download is written to the signed log (counts only, no personal data).
- New API: `GET /api/attendance/lists`, `GET /api/lists/:sid/attendance/sessions/:aid/sheet.csv`, `GET /api/v/:slug/attend/me`.
- Hindi lines for every new plain sentence. The notice line with the Terms link has no Hindi line, by the owner's rule.
- No tick boxes, no payment text, money flag still off.

## 0.2.4 - not deployed yet (IST)

Fixes after the fourth audit of Attendance chunk 1.

- Voter List staff pages (records, team, publish, erase and the rest) answer 404 for a list made from an uploaded roster. Attendance and the signed audit trail still work for it.
- The roster list name is cleaned of control characters and is at most 80 letters, as the session title is.
- Migration 0011 uses `CREATE TRIGGER IF NOT EXISTS`, so it can run twice.
- The close-session answer names its counts (eligible, present) instead of spreading them.

## 0.2.3 - not deployed yet (IST)

Fixes after the third audit of Attendance chunk 1.

- A voter can mark themselves only until 12 hours after the session starts. The Organizer and co-organizers can still mark.
- A roster upload with a country that is not in the list is refused with a plain message. Before, it quietly got India time.
- Migration 0009 is back to its first content (it may have run somewhere). The 80-letter title limit is now enforced by triggers in new migration 0011.

## 0.2.2 - not deployed yet (IST)

Fixes after the second audit of Attendance chunk 1.

- Sign-in (`verify`) and self-mark answer 410 for an erased list, as the first step does.
- The Excel roster preview now needs a listed Organizer, as the upload does. Before, any signed-in e-mail ID could use it.
- A voter can mark themselves only from 15 minutes before the session starts.
- The database title limit is 80 letters, the same as the code. Migration 0009 was edited in place; it was not applied anywhere.

## 0.2.1 - not deployed yet (IST)

Fixes after the audit of Attendance chunk 1.

- Erasing a list now removes its attendance sessions and marks. Before, one mark made the erase fail.
- A mark can be deleted only when its list is erased. Marks still cannot be changed, and cannot be deleted in any other case. Migration 0010.
- The public attendance pages answer 410 for an erased list, as the sign-in step does.
- A session title is at most 80 letters and a place at most 120. Control characters are removed.

## 0.2.0 - not deployed yet (IST)

Attendance Management, first chunk. API and tests only; there are no screens yet.

- An Organizer makes an attendance session for a list: title, date and time, place, and how people are checked (in person, online or offline).
- The Organizer or a co-organizer marks a person present. In an online session a voter can mark themselves after signing in with the code sent to their e-mail ID.
- One mark per voter per session. The database refuses a second one, and marks cannot be changed or deleted.
- A closed session takes no more marks.
- Co-organizers see names and e-mail IDs masked, as in the Voter List.
- Public counts (people on the list and people present) at `/api/v/<link>/attendance`, with no names, e-mail IDs or flat numbers.
- Every session, mark and close is in the signed audit trail, with private codes only.
- An organizer with no Voter List can download an Excel (or CSV) template and upload it. The preview refuses rows with no e-mail ID and says why. The upload makes an attendance-only list.
- Migration 0009 adds `societies.purpose`, `att_sessions` and `att_marks`.
- Not in this change: screens, notification e-mails, payment and packages, live codes, check-out, proxies, reports and the sign-off names. The payment slot stays off.

## 0.1.0 - 17 Nov 2026 (IST)

First versioned release. This describes the product as it already was; nothing in the behaviour changed.

- The git history starts at the public snapshot of 17 Nov 2026, 17:45 IST (commit `1259492`). Earlier history was removed, so no older versions can be listed.
- Voters open one link per list, sign in with e-mail and a 6-digit code, enrol, send their records and see where things stand. The voter page is in English and Hindi.
- The Organizer and up to 10 Hosts check records, approve or send them back with a reason, and publish.
- A draft list is public at once and can be replaced. A final list is frozen at a cut-off time, signed, and has a proof page anyone can check.
- A signed, hash-chained audit log records who did and opened what.
- Database migrations 0001 to 0008 are included. 0008 is for the central payment service.
- The payment slot is off by default. Voter List holds no Razorpay key.
- Per the README, only a preview copy has been deployed and nothing is live. Deploying needs the owner's go-ahead.
