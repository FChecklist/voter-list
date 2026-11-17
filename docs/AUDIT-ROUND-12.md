# Audit round 12 (independent)

Auditor: a twelfth fresh reviewer, read-only; ran the tests (149 pass), the type check and the Function bundle check (no `bun:` or `node:` imports, 190 KB), six attack scripts against the real handler (mail pools, purge scenarios, authorization, CSRF, replay, frozen immutability, closed sign-up, every public surface), and drove the voter and Organizer pages at 375 px in English and Hindi. Date 13 Nov 2026. Reviewed commit: `7b123c9`.

**Verdict: AUDIT: PASS** (0 BLOCKER, 0 HIGH, 0 MEDIUM, 6 LOW). Requirements 1 to 8 MET; 9 PARTLY (free-plan CPU and D1 behaviour, unverified until the preview smoke test).

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| L1 | LOW | The 7-digit rule also refused a real long member ID, and applied to stored IDs on every edit, so an uploaded `M-0001234567` could never be confirmed. | **Fixed.** Only a newly typed ID is checked, and the digit limit is 10; the message is gentler. Test. |
| L2 | LOW | `PUT /weights` with a null item gave 500; a repeated flat gave a misleading 409. | **Fixed.** Clear 400 for both. Test. |
| L3 | LOW | A mistyped mail cap became NaN; a cap of 1 left staff with nothing; smoke row 15 overstated the preview's note allowance. | **Fixed.** A mistyped number falls back to the default; staff keep the mail on a cap of 1; row 15 now says about 1 a day on the preview. Test. |
| L4 | LOW | The automatic 30-day clearing writes no signed entry. | **Accepted, documented** in ASSUMPTIONS (the voter withdrew and was told; a counts-only entry is a small addition if the owner wants it). |
| L5 | LOW | Two of the four indexes in migration 0006 already existed. | **Fixed.** Only the two new ones remain. |
| L6 | LOW | Some touch targets were 36 to 40 px. | **Fixed.** 44 px minimum for buttons, filter pills and the language select. |
