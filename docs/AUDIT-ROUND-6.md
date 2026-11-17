# Audit round 6 (independent)

Auditor: a sixth fresh reviewer, read-only; read the code, ran the tests (117 pass), drove both pages at phone and laptop width, ran a full end-to-end list (several voters, send-back, Add a person, draft, timed cut-off, final freeze, proof, reopen) and reproduced the mail-pool attacks with the real caps on. Date 13 Nov 2026. Reviewed commit: `d8ace39`.

**Verdict: AUDIT: FAIL** (2 HIGH, 4 MEDIUM, 7 LOW, no BLOCKER). Requirements: 1, 3, 4, 5, 8 MET; 2, 6, 7, 9 PARTLY.

Verified sound: the whole voter and Organizer journey, the host limits and standing host, hand-over, bulk approve and Undo, final freeze and proof (signature valid, 42 of 42 entries check out), authorization and CSRF, masking, no XSS sinks, `script-src 'self'`, and that the round-5 tests really bite.

## Findings and what was done

The two HIGH findings were the same root cause: **anyone could make an account** (a brand-new Organizer), and an account could then spend the shared daily mail (host invitations, fake "known" voters). Pool arithmetic cannot fix that, so the cause was removed.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | HIGH | A self-made Organizer could use the staff pool (invitations plus code requests for known addresses, including the public standing-host address) and block staff sign-in. | **Fixed at the root.** In production a brand-new Organizer must be on the owner's list (`ORGANIZERS`), unless the owner opens sign-up (`OPEN_SIGNUP=1`, advisable only with the Turnstile check). Starting a list is refused to anyone else (403, plain words). An unknown address gets the usual answer and no mail. Host invitations also have a pool of their own (5 a day), so they can never use staff sign-in codes. Tests. |
| H2 | HIGH | The same self-made account could add fake "known" voters on its own lists and drain the product-wide known-voter pool, locking out real uploaded voters of other lists. | **Fixed at the root** (same change: strangers cannot create the lists or add the people). Remaining ways to spend the pool are by listed Organizers, who are the owner's customers. Test. |
| M1 | MED | Documents said 2 and 18; the code gave 5 and 15. | **Fixed.** ASSUMPTIONS and PROGRESS now list every pool exactly as the code computes it (`mailPools`). |
| M2 | MED | Counting requests after a list's cap was used up showed who is on a list (200 vs 429). | **Fixed.** A voter code request always gives the same answer; once a list's or the day's allowance is used the code simply does not come. The sign-in page says so ("a busy day can delay codes"). Test. |
| M3 | MED | The seeded demo voters could not sign in (the seed left 16 rate-limit hits). | **Fixed.** The seed clears them. |
| M4 | MED | The deploy plan set secrets only for Production, so the preview would fail. | **Fixed.** Preview and production secret commands and `--env preview` on the preview migration, and a note to check flags with `--help` before running (the plan is not a tested script). `ORGANIZERS` added to the plan. |
| M5 | MED | "Wait a little" on a daily cap. | **Fixed.** Distinct, kind messages for the hourly and daily per-address limits. |
| L1 | LOW | A voter could not withdraw after the closing time but before the freeze. | **Fixed.** Withdrawal stays possible until the list is final. Test. |
| L2 | LOW | The signed log did not say which host was added or removed. | **Fixed** (as a pseudonym, never the address). Test. |
| L4 | LOW | "Open" buttons shared one accessible name. | **Fixed** ("Open A-101 Name"). |
| L7 | LOW | The plan said a 2-hour voter session; the code uses 8 hours. | **Fixed** (document). |
| L3, L5, L6 | LOW | Stale tick error after a failed send; untidy characters in names (not exploitable); transfer message at 10 hosts. | **Accepted for v1.** |

## What stays an owner decision

The size of the free e-mail allowance (about 50 voter codes a day product-wide) and Turnstile before opening sign-up (PROGRESS questions 0 and 7). The free-plan CPU limit is gated by the preview smoke test.
