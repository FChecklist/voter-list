# Voter List: knowledge

Short notes for anyone working on this product. Design and defaults are in `README.md`, `ASSUMPTIONS.md` and `docs/GAPS-AND-PLAN.md`.

## Version

- Current version: **0.2.4** (not deployed yet; first release date to be set when it is deployed).
- `public/version.json` holds the version, release time, commit and a list of past changes. The site serves it at `/version.json` (the file is in `public/`, which is what `bun run build:pages` copies to `dist/`).
- `package.json` carries the same version number. Keep the two equal.
- `CHANGELOG.md` has the notes in plain words, newest first, dated in IST.
- The `commit` field is the commit the release was built on. The release's own commit cannot name itself, so it points at the one just before. For 0.1.0 that is the public snapshot `1259492`.

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

## Attendance roster time zone

The time zone of a roster upload list is a fixed offset from UTC, with no daylight saving. The organizer picks a country whose offset they use (see `COUNTRY_TZ` in `src/attendance.ts`). The `can_attend` column of a voter defaults to 1 (see `migrations/0002_lists.sql`), so a new voter is eligible unless staff change it.
