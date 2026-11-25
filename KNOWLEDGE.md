# Voter List: knowledge

Short notes for anyone working on this product. Design and defaults are in `README.md`, `ASSUMPTIONS.md` and `docs/GAPS-AND-PLAN.md`.

## Version

- Current version: **0.4.1** (not deployed yet; first release date to be set when it is deployed).
- `public/version.json` holds the version, release time, commit and a list of past changes. The site serves it at `/version.json` (the file is in `public/`, which is what `bun run build:pages` copies to `dist/`).
- `package.json` carries the same version number. Keep the two equal.
- `CHANGELOG.md` has the notes in plain words, newest first, dated in IST.
- The `commit` field is the commit the release was built on. The release's own commit cannot name itself, so it points at the one just before. For 0.1.0 that is the public snapshot `1259492`. Every item in `changes` carries its own `commit` the same way (the parent of the commit that bumped to that version), and the top-level `commit` must equal the newest item's `commit`; `test/version.test.ts` checks this. Version 0.4.1 is the Results audit fixes: a masked result is built from an allow-list of structured fields only (see `maskedContent` in `src/results-core.ts`).

### How to bump (every deployed change)

1. Pick the new number: MAJOR.MINOR.PATCH. PATCH for fixes, MINOR for new features, MAJOR for breaking changes.
2. In the same pull request, update all of these:
   - `public/version.json`: set `version`, `releasedAt`, `releasedAtIST`, `commit`, and add a new first item to `changes`.
   - `CHANGELOG.md`: add a new entry at the top.
   - `package.json`: set the same `version`.
   - this file (`KNOWLEDGE.md`): update "Current version" above.
3. Run `bun test --isolate` and `bun run typecheck` before merging.
4. Deploying is separate and still needs the owner's go-ahead (see the README).

## Accepted limits

- Attendance: if a person's right to attend changes at the same moment a mark is made, the mark can still be saved. Marks are append-only, and an Organizer can see this in the audit trail. This is accepted.

- Attendance screens: the voter page lists the open sessions of the list from the public counts (cached for 30 seconds), so a session closed a moment ago can still show a "Mark present" button; the server then answers that the session is closed and the page shows that answer. This is accepted.
- Attendance sheet CSV: the Organizer gets full names and e-mail IDs, as in the Voter List full export; a co-organizer gets masked values. The download leaves a signed-log row (session, line count, full or masked) and no personal data. Marks cannot be removed (append-only), so a wrong mark is handled by the Organizer outside the sheet. This is accepted for now.
- Attendance pages: Hindi lines for the server error messages of chunk 1 (session closed, not on the list, wrong code, too many tries, list closed and the rest) are in `lang/hi.js`, and a test checks that every server error message has one. The Hindi was written to be simple and polite, but **a native Hindi reader must check it** before release. The notice line with the Terms link has no Hindi line, by the owner's rule.
- The voter page for a list made from an uploaded sheet is `/attend/<link>` (the organizer page shows it). The `/v/<link>` page of such a list still shows the Voter List steps.

## Attendance roster time zone

The time zone of a roster upload list is a fixed offset from UTC, with no daylight saving. The organizer picks a country whose offset they use (see `COUNTRY_TZ` in `src/attendance.ts`). The `can_attend` column of a voter defaults to 1 (see `migrations/0002_lists.sql`), so a new voter is eligible unless staff change it.

## Results (first chunk, dark)

Plain-words guide: `docs/RESULTS.md`. Code: `src/results-core.ts` (counting, checks, fingerprint, no database), `src/results.ts` (service), routes in `src/handler.ts`, tables in `migrations/0012_results.sql`.

- Every Results address answers 404 unless `RESULTS_ENABLED` is exactly `1`. The check comes before sign-in, so a dark product shows nothing at all.
- Meetings and Elections are separate products and are not here. Only the Organizer enters a closing, and each such result carries the warning `entered_by_hand`. When those products can deliver, they use the same closing format.
- A declared result is fixed by the database (triggers). Only visibility, draft to final, and draft or final to replaced can change. A final result with a failed check is refused by a table rule as well as by the code.
- Accepted: a correction keeps the visibility of the old result, so a result shown to the public stays shown (as a draft, with its notice) while the correction waits for its own challenge window.
- Accepted: the names of the people who counted, validated, observed and supervised are recorded as the Organizer typed them. They are not confirmed by e-mail yet.
- Accepted: the public fingerprint check can show that a result is unchanged since it was declared. It cannot show that the Organizer entered true counts. The warning `entered_by_hand` says so on the result.
- The Hindi lines for the Results messages come with the Results screens; a native Hindi reader must check them.
