# Audit round 5 (independent)

Auditor: a fifth fresh reviewer, read-only; read the code, ran the tests, drove both pages at phone and laptop width, ran a full end-to-end list (Owner, Co-owner, Tenant, Proxy, send-back, resubmit, draft, final freeze, proof, reopen, timed cut-off) and broke 21 fixes one at a time in a scratch copy. Date 13 Nov 2026. Reviewed commit: `5d2d0b2`.

**Verdict: AUDIT: FAIL** (2 HIGH, 4 MEDIUM, 13 LOW, no BLOCKER). 112 tests pass, typecheck clean. Requirements: 1, 3 to 6, 8 MET; 2, 7, 9 PARTLY. Both HIGH findings were about the free e-mail allowance. Round-4 fixes it confirmed: the draft filter, the staff-add tick, the 12 a hour draft limit and the 12-hour standing-host session.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | HIGH | Anyone could ask for a staff code for any address; 19 requests used the whole staff pool and blocked every new Host or Organizer sign-in for the day. | **Fixed.** Staff codes now come from separate pools by who asks: known staff (an existing Organizer, Host, user or the standing host) use the staff pool; an address nobody knows uses a small newcomer pool of its own (2 a day at the default allowance, 5 at most), so a flood of made-up addresses can no longer starve staff, and cannot create more than a few accounts a day. Test. |
| F2 | HIGH | People already on a list still shared the product-wide voter pool with strangers, so the pool could be emptied from the attacker's own list. | **Fixed.** Voter codes are split: people already on the list (uploaded, added or enrolled) have a pool of their own (20 a day at the default) that newcomers cannot touch (30 a day); each pool has a two-thirds-per-list cap. Tests with the real caps on (fill each pool, see the others keep working). |
| F3 | MED | "Host added. They were told by e-mail." even when no mail went. | **Fixed.** The answer says whether the mail went; the page says "please tell them yourself" otherwise. Test. |
| F4 | MED | An approved Owner could not become a Proxy without an unrelated edit first. | **Fixed.** The owner's Proxy Nomination Form may be added to an approved record; every other document stays locked. Test. |
| F5 | MED | The notice said data is "then erased" though erase is a button. | **Fixed.** The notice says the Organizer erases it with one button. |
| F6 | MED | Step 5 said "Everything looks right" while flats still needed a voter chosen. | **Fixed.** |
| F7 | LOW | A bare web address in the society name ("evil.com") was accepted (a stray control character in the pattern). | **Fixed.** Test. |
| F8 | LOW | The Team step spoke to a Host as if they were the Organizer. | **Fixed.** |
| F11 | LOW | No test for Host freeze. | **Fixed.** Test. |
| F12 | LOW | The draft headline showed old flat counts after a withdrawal. | **Fixed** (a provisional list shows only the people count). |
| F19 | LOW | Erase left the mailed send-back text. | **Fixed** (voters' mail copies are deleted on erase). The event reasons of the record history stay (they are written by the voter or team and cannot be rewritten by design). |
| F9, F10, F13 to F18 | LOW | Dialogs lose typed text on error; focus after "Send me a code"; a stranger can use up a named person's 4-an-hour code requests; response differences once a list's cap is used; no zone label on the cut-off; send-back mail has no link; staff-added person is not mailed; the standing host's list picker shows 200 lists. | **Accepted for v1**, recorded. |

## What stays an owner decision

The size of the free e-mail allowance (about 50 voter codes a day product-wide; 20 for people already on a list and 30 for newcomers) and the free Cloudflare Turnstile check on sign-in (PROGRESS question 7). The unproven free-plan CPU limit is gated by the preview smoke test.
