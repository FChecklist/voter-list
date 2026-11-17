# Audit round 21 (independent, fresh reviewer, drove the real UI in the built-in browser pane)

Date: 14 Nov 2026. Commit audited: 9b5d9c3. Verdict: **AUDIT: FAIL** (one MEDIUM). 184 tests passed; typecheck clean. The reviewer made 13 deliberate mutations of code and tests; every one was caught. Counts agree between Step 5, draft, frozen list, public page and exports; phone width fine; e-mail rules and caps unchanged; "a command wrapper" run -- tree clean.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| F1 | MEDIUM | A person's authorization mark travelled with the record when its flat changed (by the person, or by a staff correction), so a person could arrive in another flat already authorized. | Fixed: when the flat changes, the mark is cleared (the lone-person default or the Organizer's choice applies). Tests for the staff and the voter path added. |
| F2 | LOW | With more than 400 flats needing a choice, deliberately left-alone flats could crowd the table. | Fixed: flats with no decision at all come first. |
| F3 | LOW | A Host saw an older action as "Last action". | Fixed: only the newest action is offered. |
| F4 | LOW | PDF weight header wrapped. | Fixed ("Wt", with a note line). |
| F5 | LOW | A Host's upload preview mentioned authorization marks. | Fixed (not shown to a Host). |
| F6 | LOW | "Unit" instead of "Flat" in a message. | Fixed. |
