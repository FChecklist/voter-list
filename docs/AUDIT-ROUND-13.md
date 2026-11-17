# Audit round 13 (independent)

Auditor: a thirteenth fresh reviewer, read-only; ran the tests (152 pass), the type check, the Function bundle check (191 KB, no `bun:` or `node:` imports), seven new attack scripts against the real handler and a browser session at 375 px in English and Hindi. Date 13 Nov 2026. Reviewed commit: `52a233a`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 1 MEDIUM, 3 LOW). Everything else held: authorization across roles and lists, CSRF, replay, sessions, host masking, the 10-host limit and the standing host, closed sign-up, mail caps and uniform answers, every purge scenario, immutability of frozen lists and the audit log, and no personal data on any other public surface.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | A phone number sitting in the Flat column of an uploaded sheet (a shifted column) was imported, confirmed and approved, and then showed in the public list, CSV and PDF. | **Fixed twice over.** An upload skips such rows and says so ("with a phone number or e-mail ID in the flat column"); and when a list is made, any stored ID that looks like a phone number or e-mail ID is masked (digits become `#`), so it can never reach a public surface. Test. |
| L1 | LOW | The real page sends the whole form on every save, so a long stored member ID still got "looks like a phone number" and the voter was stuck. | **Fixed.** The phone check applies only when the ID is new or changed (compared with the stored key). Test sends the whole form. |
| L2 | LOW | An empty `MAIL_DAILY_CAP` meant 0 mails. | **Fixed.** Empty means "not set". Test. |
| L3 | LOW | The flat input stopped at 30 characters; the server allows 40. | **Fixed.** |

Noted, not changed: the stored (hidden) flat key of a masked ID can still be matched by the public "find my flat" search; the person would need to type the exact number, and only learns that it is on the list.
