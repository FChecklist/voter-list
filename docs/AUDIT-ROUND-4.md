# Audit round 4 (independent)

Auditor: a fourth fresh reviewer, read-only; read the code, ran the tests, drove both pages at phone and laptop width, ran a full end-to-end list (9 voters, 3 hosts, send-back, drafts, final freeze, proof, reopen) and ran mutation checks in a scratch copy. Date 13 Nov 2026. Reviewed commit: `5a03942`.

**Verdict: AUDIT: FAIL** (2 HIGH, 5 MEDIUM, 6 LOW, no BLOCKER). 104 tests pass, typecheck clean. Requirements: 1 to 4 MET, 5 PARTLY, 6 to 8 MET, 9 PARTLY.

Round-3 fixes it confirmed working: the consent box is visible and tickable (24 px) at 375 px and on desktop in every step that has a tick box; document types show; the proof dialog is complete; the mail pools add up to the cap; the new tests bite (three mutations each failed a test).

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | HIGH | The withdrawn-person filter matched the typed flat text, so "a 101" vs "A-101" kept the person on the public draft; a withdrawn person who enrolled again reappeared; and after the 30-day purge nothing hid them. | **Fixed.** A draft line is shown only while a person with that flat key (not the typed text) and e-mail ID is still on the list (approved, or approved with a change being checked). Three new tests plus one for the in-check case. |
| H2 | HIGH | About 50 voter sign-ins a day for the whole product (free allowance), and anyone holding the common link could use a list's daily quota and lock its people out. | **Partly fixed.** The per-list cap now applies only to unknown addresses: anyone the Organizer uploaded or added, or who already enrolled, is never locked out by strangers. Per-address limits raised (60 codes and 200 checks an hour) because a hall or mobile carrier shares one address. **The size of the allowance is the owner's decision** (PROGRESS question 7); a larger sender and the free Cloudflare Turnstile check on sign-in are the recommended hardening before a large society uses it. |
| M1 | MED | Per-address limits too tight for shared Wi-Fi or carrier addresses. | **Fixed** (as above). |
| M2 | MED | A person added by staff went straight onto the list without their agreement. | **Fixed.** Adding needs the Organizer or Host to tick "This person has agreed to be on the voter list" (the server refuses without it); the person also sees the record and the notice on sign-in. Test. |
| M3 | MED | After a reopen, a person who withdraws still shows on the signed earlier final list. | **Documented in the notice** ("a final list that was already signed stays exactly as it was; a later withdrawal takes effect from the next list"). A signed list cannot change by design. |
| M4 | MED | Publishing a draft had no limit (each press rewrites every line). | **Fixed.** 12 an hour per list. Test. |
| M5 | MED | The standing host's 7-day session. | **Fixed.** 12 hours for that identity. Test. |
| L1 | LOW | "Upload or paste a list first" in the empty-list check. | **Fixed.** |
| L2 to L6 | LOW | CSS test is a text check; no standalone verifier in the UI; corrections after the cut-off enter the final list labelled "at the cut-off"; approved documents change only with a detail change; a Host can open 300 records an hour. | **Accepted for v1.** The first is backed by real browser checks in rounds 3 and 4; corrections after the cut-off are audited and by design. |
