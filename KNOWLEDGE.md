# Voter List: knowledge

Short notes for anyone working on this product. Design and defaults are in `README.md`, `ASSUMPTIONS.md` and `docs/GAPS-AND-PLAN.md`.

## Version

- Current version: **0.3.4** (not deployed yet; first release date to be set when it is deployed).
- `public/version.json` holds the version, release time, commit and a list of past changes. The site serves it at `/version.json` (the file is in `public/`, which is what `bun run build:pages` copies to `dist/`).
- `package.json` carries the same version number. Keep the two equal.
- `CHANGELOG.md` has the notes in plain words, newest first, dated in IST.
- The `commit` field is the commit the release was built on. The release's own commit cannot name itself, so it points at the one just before (the parent of the commit that bumps the version). For 0.1.0 that is the public snapshot `1259492`; for 0.3.3 it is `2bd234f`; for 0.3.4 it is `c93930d`. Since 0.3.3 each entry of `changes` carries its own `commit`, and the top-level `commit` is the newest entry's. Two releases must never name the same commit.

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

- Attendance screens: the voter page lists the open sessions of the list from the public list. The public answer never holds a title or a place (for any kind of list) unless the voter signed in for that link and is on its list; a request that carries any cookie is answered `private, no-store`, and only a request with no cookie may be cached for 30 seconds. So a session closed a moment ago can still show a "Mark present" button; the server then answers that the session is closed and the page shows that answer. This is accepted.
- Attendance sheet CSV: the Organizer gets full names and e-mail IDs, as in the Voter List full export; a co-organizer gets the limited view: masked values, column names marked "(partly hidden)" and the file name `attendance-sheet-limited.csv`. The download leaves a signed-log row (session, line count, full or masked) and no personal data. Marks cannot be removed (append-only), so a wrong mark is handled by the Organizer outside the sheet. This is accepted for now.
- Attendance pages: Hindi lines for the server error messages of chunk 1 (session closed, not on the list, wrong code, too many tries, list closed and the rest) are in `lang/hi.js`, and a test checks that every server error message has one. The Hindi was written to be simple and polite, but **a native Hindi reader must check it** before release. The notice line with the Terms link has no Hindi line, by the owner's rule. The Hindi lines added in a version are listed in a comment block of `lang/hi.js` headed "NEEDS NATIVE REVIEW" (the block for 0.3.3 lists the ones added in 0.3.3).
- An e-mail ID counts as one person: in an online session it can mark one person present, even when it is on more than one flat (a family that shares one e-mail ID has one self-mark; the team marks the rest). The database holds the rule for marks made by e-mail code (migration 0012). This is accepted. An e-mail ID is tidied (spaces, capitals, `mailto:`, angle brackets, a trailing dot or comma) before it is compared or turned into a private code; a `+tag` stays part of it, so `a+tag@x` and `a@x` are two e-mail IDs (the owner can decide otherwise).
- The voter page for a list made from an uploaded sheet is `/attend/<link>` (the organizer page shows it). The `/v/<link>` page of such a list still shows the Voter List steps.

## Attendance roster time zone

The time zone of a roster upload list is a fixed offset from UTC, with no daylight saving. The organizer picks a country whose offset they use (see `COUNTRY_TZ` in `src/error-messages.ts`). The `can_attend` column of a voter defaults to 1 (see `migrations/0002_lists.sql`), so a new voter is eligible unless staff change it.
