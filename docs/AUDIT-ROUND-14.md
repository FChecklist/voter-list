# Audit round 14 (independent)

Auditor: a fourteenth fresh reviewer, read-only; ran the tests (155 pass), the type check, the Function bundle check (191 KB, no `bun:` or `node:` imports), seven new attack scripts against the real handler and a browser session at 375 px in English and Hindi. Date 13 Nov 2026. Reviewed commit: `06edd3f`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 1 MEDIUM, 3 LOW). Verified sound: authorization on every route, the standing host and team limits, CSRF and replay, frozen lists and the audit log, closed sign-up, mail caps and uniform answers, seven purge scenarios, every public surface against twelve odd records, masked-flat consistency with the proof, the fingerprint and the audit log, and the Hindi and phone-width pages.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | The "who votes for this flat" choices on the checks view showed a Host the people's full names, without any record being opened or logged. | **Fixed.** Hosts see masked names there too; the Organizer sees names. Test. |
| L1 | LOW | The public flat search matches by the start of the hidden key, so a masked ID (digits shown as `#`) could be recovered digit by digit. No normal path stores such an ID. | **Fixed.** A masked ID is found only by typing the masked form, never by digits. Test. |
| L2 | LOW | An upload kept flats a voter could not confirm (86 characters, tags), and the skip message for a long member ID was misleading. | **Fixed.** The upload applies the same rules as typing (length, characters, two-word limit); the message now says "could not be used (too long, odd characters, or a phone number or e-mail ID)". Test. |
| L3 | LOW | README and ASSUMPTIONS state the Host masking guarantee as absolute. | **True now** that M1 is fixed. |
