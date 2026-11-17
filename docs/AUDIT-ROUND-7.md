# Audit round 7 (independent)

Auditor: a seventh fresh reviewer, read-only; read the code, ran the tests (129 pass) and the type check, ran three scratch attack scripts against the real handler (production-like settings, mocked mail provider with delay), and drove the voter page at phone and laptop width in English and Hindi (enrol, send, approve, draft, final freeze, public list). Date 13 Nov 2026. Reviewed commit: `03bba8e`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 6 MEDIUM, 8 LOW). Requirements: 1, 2, 3, 4, 5, 6, 8 MET; 7 and 9 PARTLY.

Verified sound: Turnstile (fails closed when set up, no-op when not, runs before anything is counted or mailed, only the public site key is exposed, CSP exactly right); closed Organizer sign-up; the public masks match the owner's rule on every surface (list, CSV, PDF, proof, `?pub=`, errors); all authorization, CSRF, replay and freeze-tamper attempts; the standing host cannot be removed (also upper-case or look-alike `@`); the language switch (persists, CSP-clean, accessible picker); the deploy plan order and the rollback tag. The simplification was judged real (six pools became two) and safe for staff; for voters it needed the extra limits below.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | "Same answer for everyone" was not true for timing or error codes: unknown/over-cap requests returned early, skipping the slow mail call, so a stranger could time requests to learn who is on a list; a failing provider or spent staff pool gave known staff an error and unknown ones a 200. | **Fixed.** The mail is now sent after the answer when the host allows it (Pages `waitUntil`, passed from the entry file), a mail that cannot go is not reported for anyone, unknown paths do the same small hashing work, and the "mail not set up" check is for everyone. Test (identical answers with the provider down; answer returns before the slow mail finishes). |
| M2 | MED | While Turnstile is off, a script could use up the voters' pool and lock real voters out; one bulk send-back could spend it alone; the "as safe or safer" wording was only true with Turnstile. | **Fixed.** Newcomers together may use at most two thirds of the voters' pool, send-back notes at most a sixth, so people already on a list can always sign in. Turnstile is now a go-live row in the smoke test and the PROGRESS wording is honest. Tests. |
| M3 | MED | The Organizer/Host page showed a language picker but translated almost nothing. | **Fixed (scope).** The switch is on the voter page only for now; the Organizer page does not show it. Docs say so. Translating the Organizer page (~300 lines) is a string file plus native review, left to the owner's call. |
| M4 | MED | Hindi gaps on the voter page: server "what next" lines, legend, validation errors, aria-labels. | **Fixed.** All added; a test scans every server message in `records.ts`, `auth.ts` and `handler.ts` against the Hindi file so a missing line fails the build. |
| M5 | MED | The 30-day clearing also removed records the team had removed, and the voter notice never mentioned the 30 days. | **Fixed.** Only a record the voter withdrew is cleared; a team-removed record is kept like every record. The notice, the Withdraw dialog, the Organizer text, README and ASSUMPTIONS now say the same. Test. |
| M6 | MED | The deploy plan set `ORGANIZERS` for production only, so the preview would send no code; smoke test had no rows for closed sign-up or Turnstile. | **Fixed.** Preview line added; rows 13 to 15 added. |
| L1 | LOW | A hand-over could make an unlisted person an Organizer who could start more lists. | **Fixed.** Only listed Organizers start lists. Test. |
| L2 | LOW | A stranger who knows an address can use up its 4 an hour / 8 a day. | **Accepted, documented** (Turnstile slows it). |
| L3 | LOW | Standing-host sign-ins are not in each list's trail. | **Accepted, documented** (it is on every list; its actions are logged). |
| L4 | LOW | Smoke-test row 8 mis-described which masks the page shows; the one-letter rule was undocumented. | **Fixed.** |
| L5 | LOW | A blocked Turnstile script left a confusing message. | **Fixed.** A short plain fallback line (and its Hindi). |
| L6 | LOW | RB-VL-1 for later versions. | **Fixed** (README says it). |
| L7 | LOW | A bulk send-back could make many mail calls. | **Fixed by M2** (notes are at most a sixth of the pool, about 10 calls a day); smoke row 15. |
| L8 | LOW | The flat field allows up to two words. | **Accepted, documented** (a staff approver sees it before it can be public). |
