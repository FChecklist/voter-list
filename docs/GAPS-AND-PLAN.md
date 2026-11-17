# Voter List: gaps, research and plan (Round B)

Written 13 Nov 2026. Inputs: `docs/AUDIT-ROUND-0.md` (what was wrong), `docs/RESEARCH-NOTES.md` (what Indian societies and comparable products do, and what the DPDP Act asks). This file turns both into the plan that was built in Round C.

## 1. What the owner asked for, and where the old product fell short

| # | Owner's requirement | Old product | Plan |
|---|---|---|---|
| 1 | One web page, top to bottom, next step opens as the previous completes | Several screens, side menus | **One page each** for the voter and for the organizer. A step bar at the top; one primary button per step; finished steps fold into a one-line summary. |
| 2 | One common link per list; e-mail + 6-digit code | One link per voter; code existed | **One link per list** (`/v/<16 hex>`), created with the list. Same e-mail + code for everybody; no passwords. |
| 3 | Enrol as Owner / Co-owner / Tenant / Proxy (proxy only if the organizer allows), confirm, view, update, documents, status | Claims and drafts across screens | Voter page Steps 1 to 7 (below). Proxy appears only where the chosen voting rule allows it. |
| 4 | Check, Approve, or Not approved (with reason) then resubmit then check again; bulk actions | Approve/reject existed but not as a loop | A record has one status line: Waiting, Approved, Sent back. A voter's edit sends it back to Waiting. Bulk approve and send-back, with undo. |
| 5 | Publish a draft, then publish frozen with a date and time cut-off; public masked page | Frozen only | **Draft** (public, labelled provisional, replaceable) and **Frozen** (immutable, fingerprinted, signed, cut-off moment recorded). Public page masks names, mobiles and e-mail IDs with `****`. |
| 6 | 1 Organizer, up to 10 Hosts, a permanent host | Officers, no cap | Enforced in the database. The standing host `host@townhall-records.com` sits outside the 10 (decision D1). |
| 7 | Friendly | Terse, tables | Plain words, "what happens next" under every step, progress bar, undo, safe defaults. |
| 8 | Indian society practice | Partly | Section 3. |
| 9 | World class but simple, mobile first, accessible, free plan | Not verified | Section 5. |

## 2. The single-page mock

### Voter page (`/v/<link>`)

```
 Sample Heights RWA  ·  Voter list                          [Help]
 ● Sign in  ○ Enrol  ○ Confirm  ○ Your details  ○ Documents  ○ Status  ○ Public list
 ──────────────────────────────────────────────────────────────────────
 Step 1  Sign in                                         (opens at once)
   Your e-mail ID  [ asha@…            ]   [ Send me a code ]
   Then: the 6-digit code from your inbox  [ ______ ]  [ Continue ]
   What happens next: you stay signed in for 8 hours on this device.
 ──────────────────────────────────────────────────────────────────────
 Step 2  Tell us who you are                      (opens after sign-in)
   Flat / house  [ A-101 ]   Your name [ ]   Mobile [ ]
   I am the   (•) Owner  ( ) Co-owner  ( ) Tenant  ( ) Proxy*   *only if this list allows it
   Proxy for (owner's name) [ ]           [ Save and continue ]
 ──────────────────────────────────────────────────────────────────────
 Step 3  Check and send                         (opens after Step 2)
   Summary of what you typed.  [x] I agree my details are used for this list (itemised notice)
   [ Send to the list team ]    What happens next: the team checks it, usually within a few days.
 ──────────────────────────────────────────────────────────────────────
 Step 4  Your details        see them, change them (a change goes back for a fresh check)
 Step 5  Documents           up to 3 files, PDF/JPG/PNG, 400 KB each. Proxy needs the nomination form.
 Step 6  Where things stand  timeline: sent, checked, "sent back because …", resent, approved
 Step 7  The public list     masked list (draft marked provisional), search by flat, proof of the frozen list
```

Rules of the page: only the current step is expanded; earlier ones show a one-line summary with "Change". A person with several flats gets "Add another flat". Everything works at 360 px width, keyboard only, and with a screen reader.

### Organizer and Host page (`/`)

```
 Townhall Records · Voter List        Sample Heights RWA            you@… (Organizer)
 ● Set up  ○ Share link  ○ Team  ○ Check records  ○ Final checks  ○ Publish draft  ○ Publish final
 ──────────────────────────────────────────────────────────────────────
 Step 1  Set up         name, kind, state, who may vote (voting rule), documents required, closing time
 Step 2  Share the link one link for everyone [ Copy ]  [ WhatsApp text ]  [ Upload a list instead (optional) ]
 Step 3  Your team      1 Organizer, up to 10 Hosts, + Townhall Records host (not counted). [ Skip for now ]
 Step 4  Check records  Waiting / Sent back / Approved tabs. Open one: see details and documents.
                        [ Approve ]  [ Not approved… (reason) ]   bulk: tick several.   Undo (last actions)
 Step 5  Final checks   plain-words problems (e.g. "Flat C-1 has two people and none is authorized yet"; the Organizer authorizes any number of them); weights if unequal
 Step 6  Publish draft  public, masked, marked provisional; publish again to replace it
 Step 7  Publish final  event name and type, closing date and time, type FREEZE; fingerprint, signature, proof link
 ──────────────────────────────────────────────────────────────────────
 Below: Audit trail (who did what, signed) · Retention and erase · Reopen for a new meeting
```

A Host sees the same page; the buttons they may not use (settings, team, publish) are absent and explained. A Host sees names, mobiles and e-mail IDs masked until they open one record, and every opening is written to the signed log.

## 3. How Indian societies work, and what we took from it

From `RESEARCH-NOTES.md` (all state specifics flagged there as unverified where sources conflicted):

- The vote belongs to the **member** (owner); one vote per unit is the norm; joint owners vote in order of the share certificate. Tenants and proxies are barred or allowed only by bye-law, state by state (Maharashtra bars proxy; some model bye-laws allow it). So: **voting rules are a choice per list**, Proxy and Tenant appear only where the chosen rule allows them, and the organizer's choice is shown to the voter in plain words.
- Arrears can bar voting or candidacy, and states differ. So: a **dues cut-off date** is an organizer setting with the reason shown, never a hidden rule.
- The real sequence is **provisional list, objections, final list**, decided by a Returning Officer. So: Draft publication is the provisional list; voters can correct their record until the cut-off; the Frozen list is final. The Organizer (or a Host acting for them) plays the Returning Officer role; we do not add a fourth role.
- Weighted voting exists (apartment-act societies, by share of undivided interest). So: **weights** per flat, with a plain "equal or unequal" switch.
- General body meetings and elections need the list as on a cut-off date and keep it for minutes (MOM). So: the frozen list records event name, type, the cut-off moment, and a signed fingerprint.

**Borrowed:** one vote per flat (MyGate, ApnaComplex); defaulter flag with a shown reason (MyGate); maker-checker split (Right2Vote) as Host checks, Organizer publishes; freeze before the event and public pseudonymous listing (Helios); upload with column mapping and row-level errors (Simply Voting, ElectionBuddy); a receipt for each change (Right2Vote) as the status timeline and e-mail notes; counts without exposing choices (MyGate); data minimisation (POLYAS); a clear price (Right2Vote, ElectionBuddy).

**Deliberately left out:** casting and counting ballots or e-voting (legal approval is society-specific, and it is a far riskier product); Aadhaar OTP, biometrics, selfie checks, geofencing (DPDP and Aadhaar Act exposure, little value for a list); SMS and WhatsApp codes (cost, weakest channel; e-mail is the owner's choice); billing, visitor management, forums (suite features); Hindi and regional language toggle in this release (see questions in PROGRESS.md).

None of the Indian incumbents documents a self-enrolment, approval, send-back, masked-draft, frozen-list workflow. That is the product's gap and its difference.

## 4. DPDP Act 2023 and what it means here

(Reading of the Act and Rules; **needs a lawyer's confirmation before launch**. The main Rules take effect around May 2027, but building to them now is the safer course.)

- The society is likely the data fiduciary; Townhall Records is a processor under contract. A short processor note for the Organizer is in the README.
- Consent: an itemised tick before a record is sent (what, why, who sees it, what is public, how to withdraw), time-stamped per record (`confirmed_at`). The notice says that a masked name and flat appear on the public list.
- Withdrawal as easy as consent: **Withdraw my record** removes it from the next draft; a frozen list is not rewritten (the notice says so).
- Minimisation: name, flat, role, e-mail (sign-in), mobile; documents only as the list requires. No Aadhaar number is asked for; the upload screen says "cover any ID number before you upload".
- Retention (revised 13 Nov by the owner): records are **kept always**; the erase button below exists only if `RETENTION_DAYS` is set (minimum 30), after legal advice. When used: Erasing removes records, documents and histories' personal fields; the signed log and the list's fingerprint stay so the fact of the meeting can still be proved, but not who was on it. Erased lists answer "closed".
- Logs: every opening of a record or document by staff is signed into the log. Rules ask for logs to be kept at least a year; the log is never erased.
- Breach and rights requests: the Organizer is the contact; the README gives the 72-hour breach clock and the 90-day response clock.

## 5. Product bar: how it is met

- **Mobile first and accessible:** single column, 44 px targets, visible labels, one code field with `autocomplete="one-time-code"` that accepts paste and spaces, focus moved to the heading of each step, errors in a summary at the top of the step, colour never the only signal, keyboard and screen-reader tested by the independent auditor.
- **Fast and free-plan friendly:** no framework, one small script per page; one batch per write; paged lists; audit verification in segments of 100; Draft/Frozen lists paged; PDF kept small. The Cloudflare free plan's 10 ms CPU limit is the main risk for import, PDF and audit verification; the deploy plan therefore begins with a **preview deployment and smoke test**, with named fallbacks.
- **Safe by default:** hosts masked; sensible limits (3 documents of 400 KB, 5 homes per voter, 60 records per bulk action, 10 lists per organizer); every state change in one database batch with its signed log entry; optimistic concurrency so nobody approves a record that has changed under them; undo for everything the team does.

## 6. Decisions taken (and why)

- **D1.** The standing host does **not** count among the 10 Hosts. Reason: it is the platform's seat, not the Organizer's choice; counting it would silently leave the Organizer with 9. The database trigger counts only non-permanent hosts. Documented in README and the page ("10 hosts + Townhall Records").
- **D2.** The standing host **cannot be removed** by the Organizer (database refuses it). If the Organizer's own e-mail is the standing host's address, the seat is skipped.
- **D3.** Hosts cannot publish, freeze, change settings, manage the team or make full exports. The Organizer can. Hosts act on the Organizer's behalf for checking, correcting, importing and undoing; the log names who did it.
- **D4.** Public masks (revised 13 Nov by the owner): name = first 2 letters of each word + `****`; mobile = `******` + last 4 digits; e-mail ID = `********` + last 4 characters. Flat number is shown (it is what people search by).
- **D5.** Nobody decides their own record (the Organizer who is also a voter needs a Host).
- **D6.** Imported people are invited, not approved: they confirm their own details first.
- **D7.** The price slot is off until the owner sets `PRICE_INR`; payments go only through IT SERVICES BY RAJAT AGARWAL via Razorpay, which is **not wired** in this repo.

## 7. Build order

1. Backend, migration `0005`, and tests (done; 71 tests).
2. Voter single page, then Organizer single page.
3. Seed script (synthetic voters only), README and deploy plan, ASSUMPTIONS.
4. Independent audit rounds; fix; retest; repeat until two PASS in a row.
