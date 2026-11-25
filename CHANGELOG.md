# Changelog

Newest first. Dates are in IST. Every deployed change gets a new version here, in `public/version.json` and in `KNOWLEDGE.md` (see the Version section there).

## 0.3.3 - not deployed yet (IST)

Fixes after round 7 of Attendance chunks 1-2.

- The public session list of a Voter List link (`/api/v/<link>/attendance` and the one-session answer) no longer shows the title or the place. It still shows the time, how, state and counts. A voter who signed in with the e-mail code for that link and is on its list still sees the title and place; that answer is never cached, and the public answer varies by cookie. A list made from an uploaded sheet keeps showing titles and places (a question to the owner, below).
- One e-mail ID marks one person in a session, even when it is on more than one flat. The voter page says so before the button, and a second try gets a plain message (`one_per_email`). The Organizer and co-organizers can still mark the other flats. Migration 0012 holds the same rule in the database for marks made by e-mail code.
- A co-organizer's view is now stated: the page says "Limited view" (the Organizer's says "Full view"); the sheet's column names say "(partly hidden)" and the file is `attendance-sheet-limited.csv`; the find box takes a flat or member ID only (a name typed there showed which row held it). The session answer carries `view`.
- Hindi lines for texts the server builds that had none: the sheet reader messages, the two code limits, the same-moment and already-closed messages, the failure message, the messages for a phone number in a title, place or name, the country names, and the count ("3 of 10") in the sessions table. The mode texts (In person, Online, Offline) already had Hindi lines; a test now ties every server-built text to a Hindi line. Every Hindi line added is listed in `lang/hi.js` as needing a native Hindi reader. No Hindi on any consent line.
- The wording scan for my / mine / your / yours now covers every source file, the dev scripts and all pages, reads template strings fully, and a second scan checks the real answers, e-mails and sheets. One dev seed message was fixed.
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
