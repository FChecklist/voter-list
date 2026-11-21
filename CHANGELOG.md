# Changelog

Newest first. Dates are in IST. Every deployed change gets a new version here, in `public/version.json` and in `KNOWLEDGE.md` (see the Version section there).

## 0.1.0 - 17 Nov 2026 (IST)

First versioned release. This describes the product as it already was; nothing in the behaviour changed.

- The git history starts at the public snapshot of 17 Nov 2026, 17:45 IST (commit `1259492`). Earlier history was removed, so no older versions can be listed.
- Voters open one link per list, sign in with e-mail and a 6-digit code, enrol, send their records and see where things stand. The voter page is in English and Hindi.
- The Organizer and up to 10 Hosts check records, approve or send them back with a reason, and publish.
- A draft list is public at once and can be replaced. A final list is frozen at a cut-off time, signed, and has a proof page anyone can check.
- A signed, hash-chained audit log records who did and opened what.
- Database migrations 0001 to 0008 are included. 0008 is for the central payment service.
- The payment slot is off by default. Voter List holds no Razorpay key.
- Per the README, only a preview copy has been deployed and nothing is live. Deploying needs the owner's go-ahead.
