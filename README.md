> **All rights reserved.** Copyright (c) 2026 IT SERVICES BY RAJAT AGARWAL. This repository is public so the code can be read and reviewed; it is not open source and no licence to use or copy it is granted (see `LICENSE`). Secrets, keys and data are never kept here. Tests run automatically on GitHub's free servers (see `.github/workflows/test.yml`); that workflow never deploys.

# Voter List (Townhall Records)

Version history: see `CHANGELOG.md` (current version in `public/version.json`).

A single-page product for AOA, HOA and RWA societies to build, check, publish and freeze the voter list for a general meeting or an election. Part of Townhall Records (townhall-records.com). **Only a preview copy is deployed** (see `docs/PROGRESS.md`); nothing is live and no DNS was changed. The deploy plan is below and waits for the owner's go-ahead.

## What it does

**One common link per voter list.** Voters open `/v/<link>`, sign in with their e-mail ID and a 6-digit code (no passwords), and move down one page: Sign in, Enrol (Owner / Co-owner / Tenant / Proxy, as the list allows), Check and send, Voter information, Documents, Where things stand, The public list.

**The Organizer and co-organizers** use `/`: Set up, Share the link, The team, Check the records, Final checks, Publish the draft list, Publish the final list. Each record is Approved, or Not approved (sent back to the voter with a reason); the voter fixes it and sends it again, and it comes back for a fresh check. Bulk actions and Undo are there.

**Publishing.** A **draft** list is public at once, masked and marked provisional, and can be replaced. A **final** list is frozen at a date-and-time cut-off: immutable (the database refuses changes), fingerprinted and signed, with a proof page anyone can check. The public page shows the flat number, a masked name, the role, may-vote, the mobile's last 4 digits and the e-mail ID's last 4 characters, and nothing else.

**Roles.** (Only the Organizer decides who is authorized to vote in a flat; Hosts can see but not change it.) Exactly 1 Organizer and up to 10 Hosts per list, enforced in the database. `host@townhall-records.com` is a permanent standing Host on every list; it does **not** use one of the 10 seats and cannot be removed. Hosts check and correct records on the Organizer's behalf; they see people masked until they open one record, and every opening and every action is written to the signed audit log under that identity. Only the Organizer changes settings, publishes, freezes, manages the team, makes full exports or erases.

**Why someone may not vote.** A person who is "not allowed to vote" always has a reason, chosen from a short list or written by the Organizer or Host (a Host cannot change a reason the Organizer gave). The Organizer, the Hosts and the person see it; the public list shows only what the Organizer allows in Step 1 (by default reasons that follow from the role, never unpaid dues or private notes); the signed trail records the reason, who gave it and when. An uploaded list can carry a reason column, and a "No" without a reason must be fixed before the list can be published.

Also: bulk upload (people are invited, not approved), up to 3 documents per record (PDF/JPG/PNG, 400 KB), a dues cut-off, equal or weighted votes, several people per flat with the Organizer authorizing who votes, plain-words checks, a signed hash-chained audit trail, records kept always (erasing only if the owner sets a retention period; a lawyer should review under the DPDP Act 2023), a language switch on the voter page (English and Hindi; the Organizer page is English for now; more languages by adding a file), and a 10-lists-per-organizer limit.

**Elections (dark until the owner switches it on).** A society election on the frozen final voter list: nominations, a notice, a secret ballot (online, in person or both), the count, challenges, the declaration and one public report. The vote stays secret because the register of who voted and the sealed ballots share no column, and the tests read the real database to prove it. Read `docs/ELECTIONS.md`.

Read `docs/GAPS-AND-PLAN.md` for the design, the single-page mocks, what was borrowed from other products and what was left out. `ASSUMPTIONS.md` lists every default. `docs/PROGRESS.md` holds the owner's open questions.

## Run it locally

```bash
bun install
bun run gen:keys                 # writes .dev.vars with fresh LOCAL secrets (gitignored)
bun run scripts/seed.ts          # one made-up society with synthetic voters (optional)
bun run dev                      # http://localhost:8787  (TEST_MODE: sign-in codes are shown on the page)
```

The seed prints the demo voter link. Organizer: `organizer@sample.example`. All names, e-mail IDs and numbers are invented (`.example` cannot receive mail).

## Tests

```bash
bun test --isolate
bun run typecheck
```

`test/pure.test.ts` (text cleaning, CSV/Excel, checks, fingerprints), `test/flow.test.ts` (the whole journey: sign-in, enrol, send, approve / send back / resubmit, draft, frozen, proof, reopen), `test/team.test.ts` (1 Organizer, 10 Hosts, the standing host, masking, audited opens, hand-over), `test/hardening.test.ts` (undo, import, documents, closing time, CSRF, code limits, privacy of the signed log, tamper detection, erasure), `test/pages.test.ts` (the pages only call real routes and use no inline script or innerHTML). `test/elections*.test.ts` (Elections: set-up and nominations, voting, the count and declaration, and the secrecy proofs). The API tests call the real request handler against a real SQLite database with a fake clock.

## Deploy plan (Cloudflare free plan). NOTHING BELOW HAS BEEN RUN. It needs the owner's explicit go.

**Names.** Cloudflare Pages project `voter-list`. D1 databases `voter-list` (live) and `voter-list-preview` (for the smoke test). **Address: `voterlist.townhall-records.com`** (the owner approved this name on 13 Nov 2026; the approval covers the name only). That name does **not** resolve in DNS today, so the product is not live there. Adding it is a DNS change and waits for its own go.

**Three separate go-aheads, in this order. Nothing moves to the next without the owner saying so.**
1. **Preview go:** create the two databases, the secrets and the Pages project, and publish to a preview address (`*.pages.dev`) only. Nothing public, no DNS change, the marketing site is not touched.
2. **Live go:** apply the migrations to the live database and publish to production (still only on the `voter-list.pages.dev` address).
3. **Address go:** add `voterlist.townhall-records.com` (Step 5b below). Only this step touches DNS.

**Rollback id: `RB-VL-1`** = the git tag `voter-list-v1-predeploy` (set on the exact commit that is deployed). This is the first deployment, so there is nothing earlier to return to. Rollback means: (1) remove the custom domain `voterlist.townhall-records.com` from the `voter-list` Pages project and delete the one `voterlist` CNAME record it created (the marketing site and every other record stay exactly as they were), (2) in the Pages dashboard roll back or delete the deployment, (3) the live D1 can be restored to any minute of the last 7 days with `wrangler d1 time-travel restore voter-list --timestamp=<time>`; `wrangler d1 time-travel info voter-list` shows the bookmark to note *before* each later migration. For later versions, rollback means redeploying the tag of the version before. Nothing in the brief needs data to survive a rollback of version 1.

**Step 0. Before anything.** Owner gives the go (in chat, via the boss session) and picks answers to the questions at the top of `docs/PROGRESS.md`. Nothing is paid: Pages, D1 and Functions are used on the free plan.

**Step 1. Check the build.**
```bash
bun test --isolate && bun run typecheck && bun run build:pages
```

**Step 2. Create the databases (owner's Cloudflare login).**
```bash
wrangler login
wrangler d1 create voter-list           # copy the printed id into wrangler.toml, database_id
wrangler d1 create voter-list-preview   # copy the id into wrangler.toml, [env.preview], database_id
wrangler d1 migrations apply voter-list-preview --remote --env preview    # applies migrations 0001 to 0018 to the PREVIEW database only
```

**Step 3. Create secrets outside the repo.** Production secrets must be new, not the dev ones; keep the signing key backed up offline, because it signs the audit trail and the final lists.
```bash
bun run scripts/gen-prod-keys.ts ../voter-list-secrets.json   # refuses a path inside the repo; prints no secret
wrangler pages project create voter-list --production-branch main
wrangler pages secret bulk ../voter-list-secrets.json --project-name voter-list --env production
wrangler pages secret bulk ../voter-list-secrets.json --project-name voter-list --env preview   # the preview needs its own copy; for a throw-away preview you may generate a second file with gen-prod-keys instead
wrangler pages secret put CF_EMAIL_TOKEN --project-name voter-list --env production    # an API token allowed to send with the Cloudflare Email Service; type it at the prompt, never in a command line (repeat with --env preview)
wrangler pages secret put CF_ACCOUNT_ID --project-name voter-list --env production      # the Cloudflare account id (repeat with --env preview)
wrangler pages secret put MAIL_FROM --project-name voter-list --env production           # Townhall Records <no-reply@townhall-records.com> (repeat with --env preview)
wrangler pages secret put MAIL_DAILY_CAP --project-name voter-list --env preview        # type 20: the Cloudflare Email Service has one shared daily quota for the whole account, so keep this small (never above 20 without the owner's say) (voters then get 10 of the 20 and sign-ins 10)
wrangler pages secret put ORGANIZERS --project-name voter-list --env preview           # the same list for the preview, or no Organizer can sign in there and smoke-test row 1 fails
wrangler pages secret put ORGANIZERS --project-name voter-list --env production        # the e-mail IDs (comma separated) allowed to start lists; see the note below
```

**Step 4. Preview first (this is where the free plan's 10 ms CPU limit is found out).**
```bash
bun run build:pages
wrangler pages deploy dist --project-name voter-list --branch preview
```
This publishes to a preview address using `voter-list-preview`, never the live database. Walk through `docs/SMOKE-TEST.md` on a phone and a laptop, and watch the Pages Function logs for "Exceeded CPU" while doing the import, the final freeze, the public PDF and the full audit check. If any step is over the limit the fallbacks, in order of cost, are: do the heavy step in smaller pieces (already segmented for the audit check), move the upload parsing into the browser, or ask the owner about the paid Workers plan (an owner decision).

**Step 5. Go live (only after the preview passes and the owner says go).** First tag the exact commit you are about to deploy (`git tag voter-list-v1-predeploy`), so the rollback id points at what is live.
```bash
wrangler d1 migrations apply voter-list --remote
wrangler pages deploy dist --project-name voter-list --branch main
```
**Step 5b. The address (third go; the only DNS step).** In plain words: `townhall-records.com` is the marketing site (Pages project `townhall-site`). `voterlist.townhall-records.com` is a *separate name* under it, so it can point at a different project and the marketing site is not involved. The safe way:
1. **Look first, change nothing.** Open the Cloudflare dashboard, the `townhall-records.com` zone, DNS, Records. Save a screenshot or the exported list (the "before"). Check there is no existing `voterlist` record and no wildcard `*` record. Note where the DNS lives: this plan assumes it is in the same Cloudflare account as the Pages projects; if the nameservers are elsewhere, see the last line of this step.
2. Open Workers & Pages, the **`voter-list`** project (not `townhall-site`), Custom domains, "Set up a custom domain", type `voterlist.townhall-records.com`, confirm. Cloudflare adds **one** CNAME record, `voterlist`, pointing to `voter-list.pages.dev`, and issues the certificate (a few minutes).
3. **Look again.** Compare the records with the "before": the only difference must be that one new `voterlist` record. The apex `townhall-records.com`, `www`, the mail records (MX, SPF, DKIM, DMARC) and `townhall-site` must be unchanged. Open `https://townhall-records.com` and confirm the marketing site loads as before.
4. Open `https://voterlist.townhall-records.com` and walk through rows 18 to 22 of `docs/SMOKE-TEST.md`.
5. Do **not** use any "move the whole domain" or "change nameservers" option, and do not add a wildcard. If the DNS is *not* in this Cloudflare account, the owner adds that single CNAME (`voterlist` pointing to `voter-list.pages.dev`) at their DNS provider and nothing else, and adds the custom domain in the Pages project as in step 2.
Do not put the address on the marketing site until row 22 passes.

**The sender of the 6-digit codes.** Codes and invitations go out from `"Townhall Records" <no-reply@townhall-records.com>` (the display name is always put in quotes; this is the built-in default; set it explicitly as the `MAIL_FROM` secret so nothing depends on a default). They are sent by the **Cloudflare Email Service** (decided 14 Nov 2026; `CF_EMAIL_TOKEN` and `CF_ACCOUNT_ID`); the older Resend route (`RESEND_API_KEY`) still works if only that key is set. Before the first send, the sending domain is onboarded in the dashboard; `docs/EMAIL-SENDING-DNS-PLAN.md` lists the exact mail-only records it adds, how they are checked against the records that exist, and the rollback (delete exactly those records). Replies to `no-reply` are not read. Also confirm that the standing host address `host@townhall-records.com` can receive mail, because its sign-in code arrives there.

**Turnstile.** When the free Turnstile check is created, add `voterlist.townhall-records.com` (and the preview `*.pages.dev` address for the test) to its allowed hostnames.

**Step 6. After going live.** Note the `d1 time-travel info` bookmark. Put the public address in the Townhall Records site only after that.

Before running any command below, check the flags with `wrangler pages secret --help` and `wrangler d1 migrations apply --help` (the tool changes often); the commands are the plan, not a tested script.

Environment: `SIGNING_KEY`, `PEPPER` (required); `ORGANIZERS` (comma-separated e-mail IDs that may start lists; without it, nobody new can become an Organizer in production, by design) or `OPEN_SIGNUP=1` (anyone may; only after the Cloudflare Turnstile check is in place); `CF_EMAIL_TOKEN` with `CF_ACCOUNT_ID` (Cloudflare Email Service) or `RESEND_API_KEY` (older route), `MAIL_FROM`, `MAIL_DAILY_CAP`, `MAIL_STAFF_RESERVE`, `MAIL_LIST_CAP` (optional); `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` (optional, the free Cloudflare check on sign-in; it is on only when both are set); `PERMANENT_HOST_EMAIL` (default `host@townhall-records.com`), `RETENTION_DAYS` (unset = records are kept always; if set, minimum 30), `PRICE_INR` (optional, see ASSUMPTIONS.md), `RESULTS_ENABLED` (Results stays dark unless this is exactly `1`; it is left unset until the owner's go-ahead, see `docs/RESULTS.md`). **Never set `TEST_MODE` in production.** Never commit `.dev.vars` or any key. Payments, if ever added, go only through IT SERVICES BY RAJAT AGARWAL via Razorpay; that is not wired here.

## Data protection note for Organizers (DPDP Act 2023)

The society (through its Organizer) decides why and how the voter list is used, so it is most likely the data fiduciary; Townhall Records processes the data for it. There is no tick box: a voter presses the plain confirm button after reading the notice with its Terms link, and the time and the terms version are recorded. A voter can withdraw a record before the list is final. The notice says what is public (flat number, role, may-vote, a masked name, the mobile's last 4 digits and the e-mail ID's last 4 characters). The signed log records who opened which record. If something goes wrong with personal data, the Board must be told within 72 hours, and a person's request for correction or erasure should be answered within 90 days; the Organizer is the contact. **The owner decided that voter records are kept always** (no automatic erase); corrections are made by the Organizer and signed into the log. The one exception is a record that a voter withdraws by their own choice: it is cleared after 30 days, and the voter is told so. Permanent keeping sits uneasily with the Act's purpose-limitation and erase-on-request ideas, so a lawyer should review it before launch. This note is a plain reading, not legal advice: a lawyer should confirm it before launch.

## Layout

```
migrations/   0001..0004 (core, lists, workflow, hardening; the old tables stay unused), 0005_enrolment (voters, documents, events, publications, roles), 0006_indexes (for the clean-up), then 0007 to 0015 (up to the flat kept on the attendance mark), then 0016_results, 0017_meetings and 0018_elections (the last three were each a 0012 file before they were merged with the attendance work and were renumbered)
src/          handler.ts (router and API), lists / records / review / publish / overview / erase / orders (services), store.ts (access rules),
              auth.ts, audit.ts, checks.ts, importer.ts, csv.ts, xlsx.ts, text.ts, model.ts, vendor/,
              results.ts and results-core.ts (Results: the service, and the counting and checks with no database),
              meetings.ts and meeting-*.ts (Meetings), elections*.ts and election-messages.ts (Elections)
functions/    the Pages Function that calls the handler
public/       index.html (Organizer and Hosts), v/index.html (voters), assets/ (steps.js, voter.js, organizer*.js, ui.js, app.css)
scripts/      gen-dev-vars, gen-prod-keys, migrate, seed, build-pages
test/         the suites above
docs/         AUDIT-ROUND-*.md, GAPS-AND-PLAN.md, RESEARCH-NOTES.md, PROGRESS.md, SMOKE-TEST.md, RESULTS.md
```

### Results (API only, dark)
A closed meeting or election becomes one declared result that anyone can check: the server makes it from the closing the Organizer entered, runs the checks, fingerprints it and opens a challenge window; the Organizer types FINAL after the window, and a mistake is put right by a correction that keeps the old result. Every Results address answers "not found" unless `RESULTS_ENABLED` is `1`. Plain-words guide, the steps for an AI helper and the honest list of what is not built: `docs/RESULTS.md`. Tables: `migrations/0016_results.sql`. Tests: `test/results-core.test.ts`, `test/results.test.ts` and `test/results-docs.test.ts`.

### Payments (price slot, off by default)
Owner's rule for every site: payments go only through the central payment service of IT SERVICES BY RAJAT AGARWAL (Razorpay, one ledger), as the Games do. Voter List has no Razorpay key and never calls Razorpay. With `PRICE_INR`, `PAY_SERVICE_KEY` (secret, piped in, never in a command line) and `PAY_SITE` set, `POST /api/lists/:sid/orders` asks the central service to open the order and returns what the payment frame needs; `POST /api/lists/:sid/orders/:oid/verify` asks the central service to confirm the payment (paid, same amount, same currency, our order id as the reference) before the order counts. Not wired live: the site must first be registered in the central ledger and its address added to the payment frame's allow-list (both on the owner's side), and a pay screen is still to be built. Migration `0008_central_pay.sql` rebuilds the `orders` table (real orders, Razorpay order id).
