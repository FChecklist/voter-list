# Audit round 26 - result: FAIL (fixed in the next commit)

Scope: the combined change (Cloudflare sender, Owner label and several registrations per flat, reasons for "not allowed to vote"). Fresh independent auditor.

Findings and what was done:
- R26-1/R26-10 filler such as "na" or "-" in a sheet's Reason column became "another reason" with that filler as the words. Now it is no reason (the "No" is flagged for the Organizer). Test added.
- R26-2 an Organizer's "Allowed: No" without a reason carried no owner mark, so a Host could undo or override it. The upload now records the Organizer (or Host) as the one who said no even when no reason is given. Tests added (undo 403, Host allow 403, voter cannot retype flat).
- R26-3 the signed trail did not say which reasons an upload gave or an undo cleared. It now carries codes and counts only. Tests added.
- R26-4 remove-then-add elsewhere bypasses the Host move guard: accepted, written in ASSUMPTIONS.
- R26-5 phone-number check: threshold raised to ten digits, plain message (Hindi added); landline trade-off documented.
- R26-6 sender name: quotes, control characters and backslashes can no longer reach the provider request. Test added.
- R26-7 the note box of the correction form has an accessible name.
- R26-8 Hindi added for "Approved".
- R26-9 stray scratch script removed from git.
- R26-11 tests that fail if either half of the "already marked" undo guard is removed (Authorized: Yes upload; Allowed: No upload).

Tests after the fixes: 215 passing, type check clean.
