# Audit round 3 (independent)

Auditor: a third fresh reviewer, read-only, who read the code, ran the tests, **drove both pages in the browser** at phone and laptop width, and checked in a scratch copy whether the tests catch regressions. Date 13 Nov 2026. Reviewed commit: `abf2fd0`.

**Verdict: AUDIT: FAIL** (1 HIGH, 5 MEDIUM, 12 LOW, no BLOCKER). `bun test --isolate` 96 pass, typecheck clean. Requirements: 1 MET, 2 MET, 3 PARTLY, 4 MET, 5 PARTLY, 6 MET, 7 PARTLY, 8 MET, 9 PARTLY.

Round-2 fixes it confirmed live: Withdraw for approved records, Step 1 after the closing time with a real "Close enrolment now", earlier final lists with proof, `Origin: null`, "Government ID" refused, proxy-letter and document-removal guards, the 11th host refused, one Organizer after a hand-over, standing host outside the 10 and not removable, cross-list `?pub=` refused (404).

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | HIGH | The consent tick box was 1.6 px wide in a flex label (the 44 px input rule squeezed it): nobody could see it was ticked. | **Fixed.** Checkboxes and radios keep a fixed 24 px size. The focus ring is now darker (6B4E0E, above 3:1). Test. |
| M1 | MED | The document type never showed (the API said `doc_type`, the pages read `docType`). | **Fixed** in one place (`docView`), both voter and staff views. Test. |
| M2 | MED | The proof dialog showed a blank public key. | **Fixed** (reads `signature.publicKey`). Test. |
| M3 | MED | A voter who withdrew stayed on the public draft until the next draft. | **Fixed.** A provisional list is shown without anyone who has since withdrawn or been removed (page, PDF and CSV); a final list is never filtered. The page counts people from what it shows. Test. |
| M4 | MED | Sign-in logging touched at most 25 lists and could not scale for the standing host (on every list). | **Fixed.** The standing host's sign-in is not written to every list; every record opening and decision it makes is still logged under its identity. Test. |
| M5 | MED | Send-back notes used the voter-code pool: one bulk send-back could use up the day's codes. | **Fixed.** Three separate pools: voter codes 50, send-back notes 10, staff 20 (of 80). Test. |
| M6 | MED | No tests for cross-list `?pub=` or the note pool. | **Fixed.** Tests added (the auditor's two mutations now fail). |
| L5 | LOW | "1 people in 1 flats". | **Fixed.** |
| L3 | LOW | The send-back text always said Step 4. | **Fixed** (Step 4 for details, Step 5 for documents). |
| L6 | LOW | "Sent by the voter by Voter". | **Fixed.** |
| L8 | LOW | A null item in a bulk decision gave a 500. | **Fixed.** Test. |
| L10 | LOW | Focus ring contrast. | **Fixed** (darker ring). Button height of 40 px kept for small buttons. |
| L1, L2, L4, L7, L9, L11, L12 | LOW | Cancel link on "Start another list"; "Change" on Step 2; empty list shows "1 to fix"; a Host's Step 2 stays current; PDF is Latin-only; withdrawn people's send-back mail text lingers up to 30 days; final list says "frozen at the cut-off". | **Accepted for v1**, recorded. |
| CPU | SUSP | The overview rebuilds the roll on each load; the free 10 ms CPU is unproven above about 1000 records. | **Documented.** The preview smoke test is the gate. |
