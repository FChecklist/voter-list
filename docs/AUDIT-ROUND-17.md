# Audit round 17 (independent, fresh reviewer): the Cloudflare Email Service sender

Date: 14 Nov 2026. Commit audited: bf57a40. Result of the reviewer: **AUDIT: FAIL**, only because of one MEDIUM finding about the old git history. No BLOCKER or HIGH finding; `bun test --isolate` 169 pass, typecheck clean.

| ID | Sev | Finding | Handling |
|---|---|---|---|
| M1 | MEDIUM | An owner's personal e-mail address sits in a code comment of 10 early commits (not in the current files). A public repository would show it in `git log -p`. | **The public repository never receives this history.** The code was put into `townhall-records` as a snapshot with no history (PR 1), and the public copy was scanned for e-mail addresses. The local working history stays private and is not to be pushed anywhere public. If it ever must be, rewrite it first (`git filter-repo --replace-text`). |
| L1 | LOW | A `CF_ACCOUNT_ID` of `..` slips past URL encoding. | Fixed: the Cloudflare route is used only when the id is exactly 32 hex characters; otherwise it counts as not set (same 503 as before). Test added. |
| L2 | LOW | A newline or backslash in the sender's display name could break the quoted From. | Fixed: control characters and backslashes are removed from the name. Test added. |
| L3 | LOW | No time limit on the provider call. | Fixed: 10-second limit on both routes; a timeout ends as a failed row and a clean 502. |
| L4 | LOW | `success:true` with nobody delivered or queued counted as sent. | Fixed: when the answer lists delivered and queued, at least one must be non-empty. Test added. |
| L5 | LOW | Stale Resend notes (wrangler.toml, README, SMOKE-TEST, PROGRESS). | Fixed. |
| L6 | LOW | DKIM name not exact; DMARC `p=reject` remark; From format only weakly checked. | Fixed in docs/EMAIL-SENDING-DNS-PLAN.md (the six real records, the DMARC note, the shared quota, the From fallback) and a new smoke row 23 reads the outbox row and the received From line. |
| L7 | LOW | Cloudflare documents the object form `{email, name}`; the string form is untested. | Open until the preview mail test. Fallback is a small, separately audited change. |
| L8 | LOW | No `startCode` test on the Cloudflare route. | Fixed: a test covers the uniform answer, one mail only for a known address, and the 503 with a single secret. |
| L9 | LOW | D1 database ids in `wrangler.toml`. | Accepted: identifiers, not secrets. |

The reviewer's confirmed-sound list: the five e-mail rules and caps untouched, atomic slot claim byte-identical, route precedence, failure handling, no secret in logs or history, no injection through recipient/subject/body.
