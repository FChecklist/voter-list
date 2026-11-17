# Audit round 1 (independent)

Auditor: a fresh reviewer with no part in the build, read-only, given the nine requirements and the standing rules. Date 13 Nov 2026. Reviewed commit: `b18614b`.

**Verdict: AUDIT: FAIL** (3 HIGH, 9 MEDIUM, no BLOCKER). It ran `bun test --isolate` (76 pass) and `bun run typecheck` (clean). It did not drive the pages in a browser.

Requirement table from the auditor: 1 MET (code review), 2 PARTLY, 3 PARTLY, 4 MET, 5 PARTLY, 6 MET, 7 MET, 8 MET, 9 PARTLY.

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | HIGH | A burst of writes on one list failed (the signed log is one chain per list; 8 retries; 20 simultaneous enrolments gave 12 errors), and showed a false "already exists". | **Fixed.** 40 jittered retries; an honest "many people are saving at once, nothing lost" 503 if still busy; voter sign-ins are no longer written to the log. Tests: 30 simultaneous voters and 30 simultaneous staff additions all succeed. |
| F2 | HIGH | The e-mail allowance cannot carry a big society; invitations were unlimited; a flood could burn a list's code requests. | **Partly fixed.** Invitations limited (20 an hour per list, 3 a day per inbox); per-list code requests 120 to 300 a day; voter sessions 2 to 8 hours; friendlier message. The daily cap itself is the owner's decision (PROGRESS question 7): it depends on the Resend plan. |
| F3 | HIGH | Consent text promised withdrawal the code refused; notice understated what is public. | **Fixed.** A voter can withdraw even an approved record while the list is open; the notice now says exactly what is public and names the standing host's access. Test added. |
| F4 | MED | A Host could approve their own record by adding it. | **Fixed** (add and correct refused for the actor's own e-mail ID). Test. |
| F5 | MED | Editing an approved record skipped the proxy-letter rule. | **Fixed.** Test. |
| F6 | MED | The frozen snapshot could miss a change made at the same moment. | **Fixed.** The freeze batch is refused unless the records' count and revision total are the same as when the list was read. |
| F7 | MED | After the cut-off, staff could still add people. | **Fixed.** Adding and uploading are refused after the closing time; checking what was sent earlier is still allowed. Test. |
| F8 | MED | Anyone could invalidate the Organizer's live code by asking for another. | **Fixed.** The three newest live codes are accepted. Test. |
| F9 | MED | Free-plan CPU and reads unproven (6000-record timings; the "sealed" trigger counted rows on every insert). | **Partly fixed.** Trigger replaced by a constant-time check; audit check already segmented. Real Workers CPU cannot be known without the preview smoke test, which is in the deploy plan with fallbacks. |
| F10 | MED | Free text (flat field, reopen reason) could put names in the log that can never be erased. | **Fixed.** Flat field limited to a safe character set; the reopen reason is no longer logged. Event name stays (the Organizer's own words, scanned for phone numbers and e-mail IDs). Test. |
| F11 | MED | The standing host is a single point of exposure; consent did not name it. | **Partly fixed.** The consent notice now names it. A second sign-in step for that seat is a decision for the owner (PROGRESS question 1). |
| F12 | MED | The society name could carry a phishing line into code e-mails. | **Fixed.** URLs, e-mail IDs and domains are refused in the name. Test. |
| F13 | LOW | "Send back" on an approved record always failed. | **Fixed** (button removed; Undo and Remove cover it). |
| F14 | LOW | A malformed address in the host-removal URL gave a 500. | **Fixed.** Test. |
| F15 | LOW | Blunt wording ("We cannot send e-mail...", "does not take proxies"); Government ID offered. | **Fixed** (friendlier wording; the ID option removed from the page). |
| F16 | LOW | Accessibility: live region on the whole page, tab roles without panels, small targets, duplicate ids. | **Fixed** except duplicate ids across two open forms (one form is open at a time in the pages). Step labels 12 px, small buttons 40 px, checkboxes 26 px. |
| F17 | LOW | A real-looking e-mail address in vendored comments. | **Fixed** (replaced with an example address). |
| F18 | LOW | Time zones are fixed offsets (no daylight saving for UK/US). | **Documented.** India (no daylight saving) is the product's market. |
| F19 | LOW | The public "proof" is the server vouching for itself. | **Documented** (README and ASSUMPTIONS say "server-assisted"; the signature and public key are published so an outside party can verify). |
| F20 | LOW | Test gaps (source-grep page tests, per-IP limits, concurrency). | **Partly fixed:** concurrency, own-record, proxy edit, cut-off add, mail limits and code tests added (`test/round1.test.ts`). There is still no automated browser suite. |
| F21 | LOW | Self-enrolment had no list-size cap; documents have no per-list quota. | **Partly fixed:** 6000-record cap on self-enrolment; per-voter document limits stay. |
| F22 | LOW | Documents could be added to an approved record. | **Fixed.** Test. |
| F23 | LOW | The standing host seat is skipped if the Organizer's e-mail equals it, and not added later. | **Documented** (an edge case; ASSUMPTIONS). |

State after fixes: 87 tests pass, typecheck clean.
