# Townhall Meetings (first chunks, API only)

Version 0.5.0, work package `th-meetings`. **Dark and not deployed.** There are no screens yet. Every Meetings address answers "Not found." until the owner sets `MEETINGS_ENABLED` to `1`. This page is the help for people and for AI helpers (checkpoints CP-233 and CP-245, as a document; a page for it comes with the screens).

## What Meetings does, in plain words

A meeting starts as a draft: a title, a kind (annual, special, committee or emergency), a date and time, a place and a way to meet (in person, online or offline). The Organizer builds the agenda, then sends the notice. The notice is refused if it is shorter than the days of notice the bye-laws need for that kind of meeting. Once the notice is out, the agenda and the date, place and kind of meeting are fixed. A change needs a new notice.

On the day the Organizer or a co-organizer opens the meeting (the chair and the secretary must be named first). Decisions need a quorum, which is read from Attendance. A motion has a mover, a seconder and a stated majority. The result is entered with the vote counts and the names of the people who counted, and it cannot be changed or deleted. After the meeting closes, minutes are drafted (by a person or by an AI helper), and they are approved at a later meeting. Approved minutes are frozen, and a correction is a new version with a reason. Follow-up actions have an owner, a due date and a status.

Nothing in Meetings invents a legal number. The days of notice and the quorum percent come from the Organizer, once for each kind of meeting. If they are not set, the notice and the decisions are refused.

## Switching it on

- `MEETINGS_ENABLED` must be exactly `1`. Any other value, or none, keeps every address at "Not found." (the same answer as an address that does not exist, even when signed out).
- Meetings is for a Voter List. A list made only for attendance from an uploaded sheet gets "Not found." too.
- This change does not switch anything on and does not touch any live setting. Switching on is the owner's step.

## Who may do what

- **Organizer**: sets the rules, creates and changes meetings and agendas, sends, withdraws, postpones and cancels notices, names the officers, closes the meeting, approves minutes.
- **Co-organizer**: reads everything (names and e-mail IDs are masked), opens, adjourns and resumes a meeting, logs points of order, moves motions, records results, drafts minutes and keeps the action items.
- Nobody signed out, and nobody from another list, can reach any meeting address (401 or 404).

## Steps for an AI helper (CP-233)

When the help page is built, the link to this list of steps will sit beside the sentence "Copy this link and paste in your AI to work."

Every call needs the signed-in staff session. Every change also needs the header `x-vl: 1`. Answers are JSON. A refusal has `error` (plain words) and `code`. **[HUMAN]** marks a step a person must do or tick; an AI helper must stop and ask, and must never invent the answer. Paths start with `/api/lists/:sid/meetings`.

1. **[HUMAN]** Read the rules in the bye-laws and set them for the kind of meeting: `PUT /rules/annual` with `noticeDays`, `quorumPercent` (0 means "no quorum needed", on purpose), `clause` (the bye-law), `adjournClause` (what the bye-laws say when there is no quorum).
2. Create the meeting: `POST /` with `title`, `type`, `startsAt` (local time, for example `2026-12-05T18:00`), `place`, `mode`, and, for a quorum, `attendanceSessionId` of an Attendance session of the same list. `visibility` stays `private` until the Organizer chooses.
3. Add the agenda: `POST /:mid/agenda` for each item with `title`, `kind` (`information` or `decision`), `minutes` and `note`.
4. **[HUMAN]** Check the agenda, then send the notice: `POST /:mid/notice`. A short notice is refused with the earliest allowed date.
5. **[HUMAN]** Name the chair and the secretary (and a timekeeper if wanted): `PUT /:mid/roles` with `{ chair: {name, email}, secretary: {name, email} }`.
6. **[HUMAN]** At the noticed time the chair opens the meeting: `POST /:mid/open`. Attendance is marked in Attendance, not here. Read `GET /:mid/quorum`.
7. For each decision item: `POST /:mid/motions` with `itemId`, `text`, `majority` (`simple`, `two_thirds` or `three_quarters`), `moverVoterId`, `seconderVoterId`. An amendment adds `amendsMotionId`. Anyone with an interest: `POST /:mid/motions/:xid/interests` with `voterId`.
8. **[HUMAN]** The counters count the vote. Enter it: `POST /:mid/motions/:xid/result` with `method`, `for`, `against`, `abstain` and `countedBy` (one to five named people, not the chair alone). Without a quorum the result is refused with the legal next steps.
9. **[HUMAN]** Close the meeting: `POST /:mid/close`. Add the people who validated and supervised: `POST /:mid/people` with `role` (`validated_by` or `supervised_by`), `name`, `email`.
10. Draft the minutes: `POST /:mid/minutes` with `body` and `source` (`human` or `ai`). Always a draft.
11. **[HUMAN]** A person reads an AI draft and accepts it: `POST /:mid/minutes/:vid/accept`.
12. **[HUMAN]** At a later meeting the Organizer approves the minutes: `POST /:mid/minutes/:vid/approve` with `approvedInMeetingId`. After that they are frozen.
13. Add the actions: `POST /:mid/actions` with `text`, `ownerName`, `ownerEmail`, `dueDate` (`YYYY-MM-DD`). Update with `PATCH /:mid/actions/:aid` and `status` (`open`, `done`, `dropped`).
14. Read the result: `GET /:mid/decisions`, `GET /:mid/minutes`, `GET /:mid/report.json` (with its own fingerprint), `GET /:mid/calendar.ics`.

## All addresses

Staff, under `/api/lists/:sid/meetings`:

| Address | What |
|---|---|
| `GET /rules`, `PUT /rules/:type` | the rules of each kind of meeting |
| `POST /`, `GET /`, `GET /:mid`, `PATCH /:mid` | create, list, read, change (date, place and kind only while a draft; visibility and the attendance link until closed) |
| `PUT /:mid/roles`, `POST /:mid/people` | officers; observers, validated by, supervised by |
| `POST /:mid/agenda`, `PATCH` and `DELETE /:mid/agenda/:iid` | agenda (draft only) |
| `POST /:mid/notice`, `/revise`, `/postpone`, `/cancel` | send, withdraw (with a reason, then a new version goes out), postpone, cancel |
| `POST /:mid/open`, `/adjourn`, `/resume`, `/close`, `/points` | the run of the meeting |
| `GET /:mid/quorum`, `GET /:mid/decisions` | the quorum now; the motions with results and interests |
| `POST /:mid/motions`, `/motions/:xid/withdraw`, `/interests`, `/result` | motions |
| `GET` and `POST /:mid/minutes`, `POST /minutes/:vid/accept`, `/approve` | minutes |
| `GET` and `POST /:mid/actions`, `PATCH /:mid/actions/:aid` | follow-up actions |
| `GET /:mid/report.json`, `GET /:mid/calendar.ics` | the report; the calendar file |

Public, under `/api/v/:slug/meetings` (`GET` only, `noindex`): the list, `/:mid` and `/:mid/calendar.ics`. What shows depends on `visibility`: `private` shows nothing, `notice` shows the notice and the agenda, `all` also shows the decisions (without names) and the latest approved minutes. A person's name, e-mail ID or flat is never on a public page.

## What cannot be changed (the database enforces it, not only the code)

- Agenda items once the meeting is no longer a draft.
- The title, kind, date, place and mode of a noticed meeting, unless a new notice version is issued. A meeting is never deleted.
- Notices, meeting events, counted results and declared interests: append-only.
- A motion is never deleted; its text is fixed; a withdrawal stays visible.
- Approved minutes.
- Erasing a list removes every meeting record in the same step, as for Attendance. The signed log stays and still verifies; it holds counts, fingerprints and private codes, never a name or an e-mail ID.

## Limits and choices (accepted, written down)

- "Days of notice" are 24-hour days. A notice sent exactly on the line is allowed.
- Quorum counts people, not weighted votes. The required number is the percent of the people who may attend, rounded up, and at least 1.
- The vote cannot be larger than the people present minus those with a declared interest, when an Attendance session is linked.
- The meeting cannot be opened before the time in the notice, and not without a chair and a secretary.
- At most 100 agenda items and 200 actions for a meeting, and 5 named counters for a result.
- The notice is recorded with the number of people on the roll of the list at that time. It is not e-mailed by Meetings (see the table below).
- Agenda items cannot be re-ordered; delete and add again while it is a draft.
- The report is JSON, not a PDF.

## Status of the checkpoints (section E of the plan, CP-198 to CP-252)

| CP | Status | Note |
|---|---|---|
| 198 | Built | the list and Attendance are read only through their public functions, never their tables; the attendance link is optional only when the quorum percent is 0 |
| 199 | Built | the time zone is the list's own |
| 200, 201 | Built | per list and kind of meeting; per country rule packs are not built |
| 202 | Partly | title, note and time; no document on an item (see 209) |
| 203 | Built | |
| 204 | Not built | late agenda item rule |
| 205, 206, 207 | Not built | notice e-mail, delivery proof and the bounce task need a mail plan (owner question) |
| 208, 209, 210 | Not built | pre-meeting questions, papers with fingerprints, the meeting room page |
| 211 | Built | chair and secretary are needed to open; the timekeeper is optional |
| 212, 213 | Built | quorum from Attendance; the next steps use the Organizer's own adjourn clause |
| 214, 215, 216, 217, 218, 219 | Built | motions, four voting methods (counts are entered, no ballot is run here), counters, amendments, points of order, interests |
| 220 | Not built | speaker list |
| 221, 222, 223, 224 | Built | AI drafts need a person's acceptance |
| 225 | Partly | action items are built; e-mail reminders are not |
| 226 | Not built | recording link |
| 227 | Built as an API | no screen |
| 228 | Partly | observers can be named; they have no live view |
| 229 | Built | |
| 230 | Partly | postponed and cancelled notices are recorded with the reason; nothing is e-mailed |
| 231 | Partly | the calendar file is served; it is not attached to an e-mail |
| 232 | Built | |
| 233, 245 | Partly | this document; the help page comes with the screens |
| 234, 235, 236 | Built | database triggers as well as code |
| 237 | Partly | every step is in the signed log with time and a private code; the public page shows decisions, not the trail |
| 238, 239, 240 | Not built | scans, login logs and paper minutes evidence |
| 241 | Built | |
| 242 | Partly | JSON report with a fingerprint; no PDF |
| 243, 244 | Not built | price and upgrade (the money flag is untouched) |
| 246, 247, 248 | Built | whole-story test, short-notice test, no-quorum test |
| 249, 250 | Others' steps | independent audits and the release are done by others, not by the builder |
| 251, 252 | Not built | two-country and phone-only runs need screens |

## For developers

- Files: `migrations/*_meetings.sql` (tables, indexes and triggers all start with `mtg_`), `src/meeting-core.ts` (shared checks, quorum, the dark switch and the role table), `src/meetings.ts` (rules, meeting, agenda, notice, the run), `src/meeting-motions.ts`, `src/meeting-minutes.ts`, `src/meeting-report.ts`, `src/meeting-routes.ts` (the addresses, mounted from `handler.ts` in three lines), `src/meeting-messages.ts` (every message people can read).
- Audit entry types: `meeting.*`, `motion.*`, `minutes.*`, `action.*`. Payloads hold ids, counts, fingerprints and private codes only.
- Notice fingerprint: SHA-256 of the canonical snapshot kept in the notice row, so anyone can recompute it.
- Tests: `test/meetings.test.ts`. They run on the same migrations as production, so the triggers are real.
- The migration is `migrations/0017_meetings.sql` (it was 0012 before the merge with Attendance and Results, which use 0012 to 0016). Elections still carries a 0012 file and is renamed to the next free number when it is merged. Nothing depends on the number.
