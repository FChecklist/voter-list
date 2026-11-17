# Audit round 11 (independent)

Auditor: an eleventh fresh reviewer, read-only; ran the tests (144 pass) and the type check, attack scripts against the real handler, and drove the voter and Organizer pages. Date 13 Nov 2026. Reviewed commit: `c33e8a5`.

**Verdict: AUDIT: FAIL** (0 BLOCKER, 0 HIGH, 1 MEDIUM, 4 LOW).

## Findings and what was done

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | MED | The deploy plan's preview setting (daily cap 20) combined with the default staff reserve (20) left voters with no mail at all. | **Fixed.** The staff reserve never takes more than half the day's allowance (`min(cap / 2, reserve)`), so voters always keep a share; the README says what the preview gets (10 and 10). Test reads the README's literal values. |
| L1 | LOW | The 30-day clean-up scanned tables without indexes and ran its heavy statements every time. | **Fixed.** Migration 0006 adds four indexes; the clean-up finds candidates once and runs the heavy statements only when there are any. Test. |
| L2 | LOW | Saving weights read the voters once per flat (up to 60 reads). | **Fixed.** One read for all flats. Test; smoke row 16. |
| L3 | LOW | A phone number could hide in the flat field as spaced or dotted digits. | **Fixed.** A flat with 7 or more digits in all is refused. Test with the auditor's five examples. |
| L4 | LOW | Hindi: labels set in code ("Saving…", "Sending…") could show English for a moment. | **Fixed.** The language sweep now runs straight away after a change (not on the next frame); the Hindi lines exist and a test guards them. |
