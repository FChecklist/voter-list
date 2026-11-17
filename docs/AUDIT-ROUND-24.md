# Audit round 24 (independent, fresh reviewer; real handler, mutation tests, migration on an older database)

Date: 14 Nov 2026. Commit audited: 8fccb4d. Verdict: **AUDIT: FAIL** (one HIGH, three MEDIUM, eight LOW). 202 tests passed; typecheck clean. 22 deliberate mutations were all caught by a test. Migration 0007 on a real older database with a frozen list worked. Timing with 3000 records: checks 176 to 233 ms, draft publish 369 ms, public list 15 ms, and no per-row queries were added. Not attacked this round: the e-mail part, a real browser, Cloudflare itself.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| R24-1 | HIGH | The public wording of a chosen reason carried the person's own words (a "Tenant" reason with a note about dues showed the note publicly in the default mode). | Fixed: the public text is built from the fixed wording only; the note is added only when the Organizer chose "every reason". Test added. |
| R24-2 | MEDIUM | An uploaded reason was dropped when the sheet had no Authorized column (and for every Host upload), so a sheet that said no produced a yes. | Fixed: a reason always means "not allowed"; where the mark cannot be written, "allowed to vote" is switched off instead. The report line is shown to Hosts too. Test added. |
| R24-3 | MEDIUM | The phone/e-mail test was weaker than the signed log's: some notes gave a misleading server error, some disguised contact details got through. | Fixed: the same scanner as the rest of the app plus a digit count (also Hindi digits), "(at)", links; plain 400 message; the same test for sheet uploads. Test added. |
| R24-4 | MEDIUM | The free-text note went into the signed trail, which can never be erased. | Fixed: the signed trail carries the reason's code, who and when; the note stays with the record. Test changed. |
| R24-5 | LOW | "Choose the reason" on a person who is authorized but not allowed to vote took their authorization away. | Fixed: it writes only the reason on the record. |
| R24-6 | LOW | One reason serves two switches; the Organizer's reason replaces a Host's. | Documented in `ASSUMPTIONS.md`. |
| R24-7 | LOW | The reason menu opened on "Dues unpaid"; the dialog had no accessible name. | Fixed: it opens on "Choose a reason..." and will not save until one is chosen; the dialog is named for screen readers. |
| R24-8 | LOW | A Host could not undo their own harmless action on a record that carried an Organizer reason. | Fixed: only an action that really changed the mark or the reason is closed to a Host. Test added. |
| R24-9 | LOW | A person the Organizer said no to (by upload) could retype their own flat and lose the "no". | Fixed: refused with a plain message telling them to ask the Organizer. Test added. |
| R24-10 | LOW | Hindi showed English for reasons with a note, for joined reasons and for the person's own words. | Fixed with patterns. |
| R24-11 | LOW | A person whose record is not on the list yet sees no status. | Documented. |
| R24-12 | LOW | Changing the public-reasons setting does not change a draft already public. | Step 1 now says so; documented. |
