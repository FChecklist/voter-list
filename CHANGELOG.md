# Changelog

Newest first. Dates are in IST. Every deployed change gets a new version here, in `public/version.json` and in `KNOWLEDGE.md` (see the Version section there).

## 0.4.0 - not deployed yet (IST)

Results, first chunk (API only, dark). Full notes: `docs/RESULTS.md`.

- A closed meeting or election is entered by the Organizer (`POST /api/lists/:sid/results/closings`). It is kept as entered and never changed.
- The server makes a draft result from it: the outcomes, the rule in words, the checks, a fingerprint and a challenge window (48 hours unless the Organizer chose 0 to 720). Nothing about the outcome is typed in.
- After the window, and only with no failed check, the Organizer types FINAL. The database refuses a final result with a failed check, and refuses any change to a declared result.
- A mistake is put right by a correction with a reason: a new result that points at the old one. The old one stays, marked as replaced.
- The Organizer chooses who may see a result: hidden (the default), masked names or full names. Public pages ask search engines not to list them.
- A sheet download, a check anyone can run, signed audit lines with ids, counts and the fingerprint only, and erase together with the list.
- New tables and guards in migration `0012_results.sql`. Every Results address answers "not found" unless `RESULTS_ENABLED` is `1`; it stays unset until the owner's go-ahead.
- 54 new tests (28 for the counting rules, 26 through the real handler and migrations).
- Not built yet: screens, e-mails, PDF with QR code, WhatsApp share, other languages, challenge forms, sign-off by e-mail, delivery from the Meetings and Elections products.

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
