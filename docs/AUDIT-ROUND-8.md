# Audit round 8 (independent)

Auditor: an eighth fresh reviewer, read-only; ran the tests (134 pass) and the type check, six attack scripts against the real handler (production-like settings, mocked mail, `waitUntil`, mocked Turnstile, database operation counting), and drove the voter and Organizer pages at phone and laptop width in English and Hindi (enrol as Tenant, send back, resubmit, approve, draft, freeze with warnings, public list, proof, Withdraw dialog). Date 13 Nov 2026. Reviewed commit: `2d0ff17`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 2 MEDIUM, 7 LOW). Requirements: 1 to 6 and 8 MET, 9 MET at code level, 7 PARTLY (Hindi gaps).

Round-7 fixes reproduced and sound: identical status and body for every kind of code request (including a failing provider and no mail key), a failed deferred mail leaves a consistent outbox, spreading the Pages env keeps every binding, newcomers capped at two thirds and notes at a sixth (a 240-request robot flood sent exactly 40 and a known voter and staff still signed in), Turnstile cannot be bypassed (every odd token shape failed, nothing counted before it passes), all authorization, CSRF, replay and concurrency checks, frozen data immutable, deploy plan coherent. No leak on any public surface.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | The 30-day clearing of a withdrawn voter left the full line in the stored draft list (only hidden by a filter), so the notice was untrue. | **Fixed.** The clearing now also deletes the person's lines from the (replaceable) draft list; a signed final list is untouched, as the notice says. Test. |
| M2 | MED | Hindi gaps at the final-list step (patterns did not match the real sentences; "No" missing); the coverage test did not see them. | **Fixed.** Patterns match the real text; "No" and the rest added. The coverage test now scans every plain sentence in the voter page's scripts against the Hindi file, and checks the Step 7 sentences. |
| L1 | LOW | Tiny residual timing difference (one database write) between "no mail" paths. | **Accepted, documented as structural only**: orders of magnitude below the old mail-call gap, bounded by 4 requests an hour per address. |
| L2 | LOW | The Organizer is not told about the newcomer cap. | **Fixed.** A short tip in Step 2 (people you upload or add are known, so their codes never wait; new people share 25 a day). |
| L3 | LOW | Turnstile secret without the site key locked everyone out. | **Fixed.** The check is on only when both are set. Test; smoke row says "both". |
| L4 | LOW | More untranslated Hindi (Cancel, labels, Saving…, the 503 message). | **Fixed.** |
| L5 | LOW | The final-list page said mobiles and e-mail IDs are masked but did not show them. | **Fixed.** The page now shows both masked columns, as the owner asked. |
| L6 | LOW | The rollback tag was set before the preview. | **Fixed.** Tagged at the start of Step 5, on the commit about to go live. |
| L7 | LOW | A bulk send-back made a lot of small queries after the mail cap. | **Fixed.** A courtesy note goes out for the first 10 records of an action only; every voter sees the reason on the page. |
