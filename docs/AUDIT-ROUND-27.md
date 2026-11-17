# Audit round 27 - result: AUDIT: PASS

Date: 14 Nov 2026. Commit audited: `9c9b728`. A fresh read-only reviewer. 215 tests passed; typecheck clean. Scope: the combined change (Cloudflare sender, Owner label and several people per flat, reasons for "not allowed to vote").

No finding of medium severity or higher. What the reviewer checked: every path that writes the Organizer's marks and reasons (a Host could not change, override or undo them, including by moving, removing and re-adding, or by undoing an upload); that a "no" cannot exist without a reason; that dues and the person's own words never reach the public list, the CSV or PDF, the publication fingerprint or the signed trail; that contact details are refused; migration 0007; mail sender form and header safety. About 35 deliberate breakages in scratch copies were each caught by a test, except those listed as low note 5.

Low notes and what was done:
1. On screen, filler such as "n/a" is accepted as the person's own words (three letters are enough). Accepted, in ASSUMPTIONS.
2. A sheet's Reason text is matched by its first words ("Dues paid" reads as dues). The reviewer sees the result in the preview. Accepted.
3. A missing reason blocks the final freeze, not a draft publish; README wording says so. Accepted.
4. `MAIL_DAILY_CAP` defaults to 80 when unset; it is 20 on the preview. Documented.
5. Some guard breakages are caught by a second, overlapping check rather than by their own test (`touchesMark` and `markedNow`). Left; the two checks cover the same cases.
6. A real Cloudflare account id was in a test: replaced with a dummy value (docs and tests only, commit `679a14f`).
7. The wording "no personal data in the signed log" was loosened to what is true. Done.
