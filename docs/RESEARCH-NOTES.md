# Voter List - research notes (web research only)

Research date: 2026-11-13. Method: web search and page/PDF fetches only; no code touched.
Confidence tags used below: **[PRIMARY]** = read from the official text (Gazette, Act, Rules, official model bye-laws);
**[SECONDARY]** = law firm / news / practitioner commentary / vendor page; **[UNVERIFIED]** = could not confirm.
This is research, not legal advice. State rules, registered bye-laws of each society, and later amendments override everything here.
No personal data of real people is included in this file.

---

## 1. How voter lists / member registers work in Indian societies

### 1.1 Legal frameworks differ by building type and state
A "housing society" in India is governed by one of several regimes. The product must not assume one.

| Type | Typical law | Notes |
|---|---|---|
| Co-operative housing society | State Co-operative Societies Act (e.g. Maharashtra Co-operative Societies Act 1960 + Rules 1961 + Election Rules 2014 + model bye-laws) | Elections often run by a State Co-operative Election Authority (SCEA) or a Returning Officer (RO) |
| Apartment owners' association (AOA) | State Apartment Ownership / Apartments Act (Karnataka 1972, UP 2010, Telangana 1987, Haryana 1983) | Vote weight often by percentage of undivided interest in the Declaration |
| RWA / HOA | Societies Registration Act 1860 (or state equivalent, e.g. Haryana 2012 Act) | Bye-laws of the society control almost everything |

### 1.2 Who is a voter - categories
- **Owner / member (first-named holder on share certificate / deed)**: the default voter in every regime found.
- **Co-owner / joint holder**: Maharashtra - votes only in the absence of the first-named (see s.27(2) below). UP model bye-laws - only the first-named person in the share certificate has the right to vote (bye-law 5) [PRIMARY]. Haryana - typically first owner only (blog, [SECONDARY]).
- **Tenant / occupant**: generally **no vote**. Maharashtra: a "nominal member" (e.g. a tenant/occupant) has no right to vote (MCS Act s.27(8)) [PRIMARY]. Delhi and Haryana sources say tenants cannot vote unless bye-laws say so [SECONDARY]. NoBrokerHood's own explainer says tenants are excluded and only registered owners vote [SECONDARY]. I found **no** regime where a tenant votes by default.
- **Proxy / authorised representative**: see section 2.
- **Associate member** (Maharashtra): the 2014 model bye-laws gave an "associate member" only the right to attend and vote in the absence of the member (bye-laws 25, 105); the 2019 amendment renamed the old associate member as "joint member" and redefined "associate member" as a close relative authorised in writing. The mismatch between Act and model bye-laws causes real disputes (LiveLaw commentary) [SECONDARY].
- **Heirs / nominees** (Maharashtra): the 2026 amendment rules reportedly add "provisional members" (legal heirs admitted before transfer) who get no ownership right; whether they vote was not confirmed [SECONDARY, UNVERIFIED].
- **Corporate / firm / trust holders** (Maharashtra s.27(4)-(6)): a company, firm, local authority or trust holding shares may appoint one director/officer/partner/member to vote on its behalf [PRIMARY]. A flat owned by an entity needs a "named representative" field.

### 1.3 One-unit-one-vote vs weighted
- **Maharashtra co-op societies**: one member, one vote, "exercised personally, and not by proxy"; Chairman has a casting vote on a tie (s.27(1)); model bye-law 105: every Active Member has one vote, and in his absence his associate (joint) member [PRIMARY, official Act PDF and 2014 model bye-laws].
- **UP model bye-laws** (Apartment Act 2010): voting is on a **percentage basis** - the percentage assigned to the unit in the Declaration (bye-law 8); votes are cast in person (bye-law 10); quorum 30% of owners present in person (bye-law 9) [PRIMARY: up-rera.in model bye-laws PDF]. A practitioner FAQ reports a UP court dispute where "one flat, one vote" was found not in line with the rules/model bye-laws [SECONDARY].
- **Karnataka AOA Act 1972**: practitioners disagree. Several advocates read s.11(f) and Exhibit B cl.9 of the model bye-laws as requiring voting by percentage of undivided interest and say bye-laws cannot change that; association guides say one vote per apartment [SECONDARY, conflicting].
- **Telangana Apartments Act 1987**: s.31(2) binds owners to decisions taken at the percentage fixed in the Declaration/bye-laws; one forum answer says weight follows undivided interest (s.14(f)) and "one unit one vote" is advisable absent specific provisions [SECONDARY, partly informal].
- **Haryana (HRRSA 2012 RWAs)**: one flat/plot, one vote; joint owners - first owner (blog) [SECONDARY].
- **Delhi RWAs**: the voting right per flat is restricted to the owner (blog); I could not pin the governing statute (sources point to Societies Registration Act 1860, others to Delhi Co-operative Societies Act) [SECONDARY, UNVERIFIED].
- **Design consequence**: store a per-unit **vote weight** (default 1) and a rule "one vote per unit, exercised by one named person"; make weighting an organiser setting taken from the Declaration/bye-laws.

### 1.4 Dues / arrears / eligibility
- **Maharashtra**: MCS Act s.26: no person exercises the rights of a member until the payments prescribed by the rules/bye-laws are made [PRIMARY]. Model bye-law 22(c): a member is "Active" only if he attended at least one general body meeting in the previous five consecutive years (unless absence condoned), owns a flat, and has paid maintenance/other charges regularly; society classifies Active/Non-Active at the close of each financial year, with appeal to the Registrar within 60 days (bye-law 22(c)-(f)) [PRIMARY]. Only Active Members vote (bye-law 105) [PRIMARY]. 2014 bye-law 118: a member in default, 3 months after written demand, is disqualified from the committee (candidacy) [PRIMARY]. After the 2019 amendment a "defaulter" is defined in s.154B-1(11),(12) as someone who fails to pay within 3 months of the bill/notice; defaulters cannot be elected to the committee (s.154B-23(1)(ii)) - per a May 2023 Free Press Journal explainer; whether a defaulter loses the **vote** was not clearly stated there [SECONDARY, UNCERTAIN]. Temporary relaxations: a Oct-2020 ordinance relaxed active-member voting conditions for elections up to 31 Mar 2021 (PRS) [SECONDARY]; a 2013-amendment commentary says no member was to be disqualified from voting under s.26 for the first election after 15 Feb 2014 [SECONDARY]. Older practitioner write-ups say members in arrears on the scrutiny date cannot take part [SECONDARY]. **Conclusion: Maharashtra defaulter-vote rule is genuinely unsettled in the sources I could read; make it an organiser-set rule with the reason shown.**
- **UP model bye-law 7**: no voting or candidacy if in arrears of common-expense contributions for more than 60 days on the last day of the year preceding the election [PRIMARY]. (Dues owed to the promoter do not count - practitioner reading [SECONDARY].)
- **Haryana RWA (blog)**: members in arrears of dues, including annual subscription, lose the vote [SECONDARY].
- **Design consequence**: a "dues status as of cut-off date" flag per unit, set by the organiser (uploaded or manual), plus an "eligibility rule" setting (blocks vote / blocks candidacy / informational only). Show reason to the voter.

### 1.5 Cut-off ("eligibility") date
- Maharashtra: a practitioner article describes the voter register being taken as on 31 Dec (elections Jan-Jun) or 30 Jun (elections Jul-Dec) [SECONDARY, could not tie to a rule number - UNVERIFIED]. Another explainer says the provisional list (Form E-3) must be published at least 60 days before the committee's term expires [SECONDARY]. Election Rules 2014 require the Final list to be displayed at least 10 days before the election programme is declared [SECONDARY].
- UP: arrears measured on the last day of the preceding year (bye-law 7) [PRIMARY].
- **Design consequence**: the product's "published frozen with a date-time cut-off" matches the concept; allow the organiser to state the legal basis in free text. Do not hard-code Maharashtra dates.

### 1.6 Publication before elections: notice, objections, final list
Maharashtra Co-operative Societies (Election to Committee) Rules 2014 (in force 11 Sep 2014; amended 2019) [SECONDARY summaries; exact rule text not read]:
- Provisional list published; claims/objections to the Election Officer within **10 days** of publication; officer decides in 10 days; **final list within 15 days** after the objection deadline; display at the officer's office and society notice board at least 10 days before the election programme is declared (courtbook.in Rule 8 summary).
- For **Type E** societies (up to 250 members, 2019 amendment; the earlier threshold was 200 - sources conflict): committee prepares provisional list (Form E-3) at least 60 days before term expiry; copies to members and the Registrar; claims within 10 days of publication; the RO decides; **final list (Form E-3(1))** after claims are settled; no change after that. One explainer says final list within 2 days of claims being settled, another within 10 days - **conflict, UNVERIFIED** (Free Press Journal 2023; indiancooperative.com).
- The list columns reported: names, membership numbers, gender, age, flat numbers, remarks, alphabetical (Form E-3) [SECONDARY].
- A member with several flats is listed once ("one member one vote"). Joint/associate members can be listed on written recommendation from the original member [SECONDARY].
- Bombay High Court: including ~25% of voters without proper verification violated the Rules [SECONDARY summary of one judgment - UNVERIFIED].
- Appeals on nomination rejection under s.152A: 3 days to file, 10 days to decide (FPJ) [SECONDARY].
- ApnaComplex's generic guidance: post the voter list at least 60 days before polls [SECONDARY, vendor blog].
- **UP model bye-laws** do not fix a notice period; a practitioner suggests a schedule: provisional list, objections, final list, nominations, scrutiny, withdrawal, final candidates, poll, with 15-30 days notice as reasonable [SECONDARY]. Election Committee is not in the bye-laws; GBM should appoint it.
- **Product implication**: the DRAFT-then-FROZEN model fits the legal pattern (provisional list -> objection window -> final list). Add: configurable objection window, an "objections received/decided" log, and an RO/organiser "decision" record. Do not claim the product's frozen list is legally "the" voter list - the RO/authority adopts it.

### 1.7 Returning / election officer
- Maharashtra: Type A-D societies - SCEA appoints the RO; Type E - managing committee appoints an RO from the SCEA panel or among members; the RO must be trained by a notified institution and cannot be an employee, auditor, outgoing committee member or candidate (Rule 76-A/76-B per secondary sources) [SECONDARY].
- UP: Election Officer chosen from attendees at the AGBM (bye-law 13 per practitioner FAQ) [SECONDARY].
- Haryana RWA blog: Returning Officer decides objections to the voter list; register of voters in Form XII [SECONDARY].
- Product implication: the organiser must be able to name a "Returning Officer" role (could be an external person) with view/approve rights that cannot be the same as a candidate; the app should record a conflict-of-interest declaration.

### 1.8 General body meeting notice and minutes (Maharashtra 2014 model bye-laws) [PRIMARY]
- Notice: **14 clear days** for AGM, **5 clear days** for special GBM (shorter allowed in an emergency by unanimous committee decision), under intimation to the Federation and Registering Authority (bye-law 98).
- Quorum: **2/3 of total members or 20, whichever is less** (bye-law 99); adjourned meeting 7-30 days later, business transacted whether or not quorum (bye-law 100).
- Minutes: draft finalised by the committee within 3 months, circulated within 15 days, 15 days for member observations, then final minutes recorded (bye-law 107). "MOM" is a minutes-of-meeting term used in practice.
- A resolution cancelling an earlier one needs six clear months (bye-law 108).
- 2026 changes (reported): video conferencing now expressly permitted for GBM and redevelopment meetings; Maharashtra Co-operative Societies (Amendment) Rules 2026 notified 18 Jun 2026; draft model bye-laws put out for comment (Aug 2026) [SECONDARY - ADDA blog, TaxGuru; Moneylife page was not fetchable (HTTP 403) - content UNVERIFIED]. TaxGuru reports quorum two-thirds or 20, "51% of total members present" language that it flags as ambiguous.
- UP model bye-laws: quorum 30% of owners present in person; no quorum -> adjourn at least 48 hours; at the adjourned meeting two owners in person suffice (bye-law 9; FAQ) [PRIMARY/SECONDARY].

### 1.9 State-by-state one-liners (uncertainty flagged)
- **Maharashtra**: richest and most formal (Act, Rules, model bye-laws, SCEA). One member one vote, personal voting, no proxy, nominal/tenant no vote. Uncertain: current text after the 2019 amendments and 2026 rules.
- **Karnataka**: AOA Act 1972 + model bye-laws; weight by percentage of undivided interest is the better reading (contested). Proxy: not in the Act; bye-law matter. UNVERIFIED.
- **UP**: Apartment Act 2010 + 2011 Rules + model bye-laws; first-named owner votes, percentage weighted, >60 days arrears bars vote and candidacy [PRIMARY]; 2016 amendment reported not notified [SECONDARY].
- **Delhi RWAs**: mostly Societies Registration Act bye-laws; owners vote, tenants do not (usually); proxy rules by bye-law. UNVERIFIED, weak sources.
- **Haryana**: HRRSA 2012 for RWAs (blog: 21+ at admission, arrears bar vote, one flat one vote, first-owner votes, in person). The Haryana Apartment Ownership Act 1983 was **not researched**. UNVERIFIED.
- **Telangana**: Apartments (Promotion of Construction and Ownership) Act 1987; weight by percentage in Declaration/bye-laws; e-voting in a co-operative needs bye-law amendment + Registrar approval (Telangana court answer on kaanoon) [SECONDARY].

Sources: https://sahakarayukta.maharashtra.gov.in/site/upload/documents/Maharashtra_Co-operative_Societies_Act_1960.pdf (s.26, s.27); https://sahakarayukta.maharashtra.gov.in/SITE/PDF/Rules_Acts_Bylaws/Model_Bye_Laws_of_Coop_Housing_Society_New_Flatowner_Type_(2-9-14)%20(1).pdf (bye-laws 22, 25, 98-108, 114-118); https://up-rera.in/pdf/Model-By-Laws.pdf (UP bye-laws 5, 7-10); https://courtbook.in/maharashtra-co-operative-societies-election-to-committee-rules-2014/section-8 ; https://www.freepressjournal.in/business/housing-society-elections-a-step-by-step-guide-on-rules-rights-of-members-all-other-important-things ; https://www.indiancooperative.com/nchf-2/chs-elections-in-maharashtra-some-facts/amp/ ; https://blog.ipleaders.in/election-procedure-for-housing-societies/ ; https://www.livelaw.in/articles/model-bye-laws-cooperative-housing-societies-maharashtra-302112 ; https://prsindia.org/files/bills_acts/bills_states/maharashtra/2020/Ordinance summary- The Maharashtra Co-operative Societies (Second Amendment) Ordinance, 2020 .pdf ; https://taxguru.in/corporate-law/maharashtra-overhauls-co-operative-housing-society-rules.html ; https://blog.ind.adda.io/?p=14399 ; https://www.prashantkanha.com/faqs-on-election-of-apartment-owners-association/ ; https://www.kaanoon.com/172876/can-voting-rights-be-changed-from-proportional-to-uds-to-1-vote-per-unit-under-karnataka-1972-act ; https://www.kaanoon.com/295478/apartment-owners-association-election-process ; https://www.kaanoon.com/429996/association-formation ; https://aanchalvihar.blogspot.com/2025/11/eligibility-criteria-for-voting-in-rwa.html ; https://www.nobrokerhood.com/blog/rwa-election-process/ ; https://www.nobrokerhood.com/blog/online-voting-rights-in-housing-society-elections/

**Not confirmed**: the current in-force text of the 2013 and 2019 amendment sections (s.73CB, 154B-1, 154B-23); Election Rules 2014 rule numbers beyond Rule 8; a Maharashtra rule giving the exact voter-list "cut-off date"; the 2026 Maharashtra amendment text; Delhi/Haryana primary law.

---

## 2. Proxy rules

| Place | Position | Source quality |
|---|---|---|
| Maharashtra co-op societies | Voting right "exercised personally, and not by proxy" (s.27(1)). Model bye-law 103: no proxy, power-of-attorney holder or letter-of-authority holder may attend a GBM on a member's behalf. The only substitutes: joint holder in order of share-certificate names, "present and not a minor" (s.27(2)); corporate/firm/trust representatives (s.27(4)-(6)); the Maharashtra 2014 associate-member route (written consent + NOC form, Appendix 5). | PRIMARY (Act PDF + model bye-laws) |
| UP Apartment Act model bye-laws | Bye-law 10: "Votes will be cast in person"; the same bye-law says resolutions need a majority of owners casting votes "in person or proxy" - internally ambiguous. A practitioner says co-owners/family/authorised reps vote only under a valid proxy from the first-named owner, and the board must verify proxy authorisations; the practitioner's position is itself contested in the comments. | PRIMARY text, SECONDARY reading |
| Delhi / Haryana RWAs | "Must vote in person"; proxy not allowed in the statutory framework per blogs | SECONDARY, weak, UNVERIFIED |
| Karnataka AOA | Not in the Act text I could find; answers disagree (proxy allowed / only in person / delegate to family) | SECONDARY, conflicting |
| Telangana | Not found | UNVERIFIED |
| Vendors | NoBrokerHood says its platform "prevents proxy voting". Right2Vote supports "limited multiple voting" where one proxy holds several voters' ballots under one ID. | SECONDARY (vendor) |

**Typical documents** (no authoritative template found for societies): a signed authority letter from the owner naming the proxy and the meeting/election, owner and proxy photo ID, society membership/flat reference. Because most regimes bar proxies, expect the document most often to be an **authority letter for a representative of a corporate/firm owner**, a **joint-owner consent**, or a **nominee/heir** letter. **Typical limits**: I found **no** society-level numeric cap (e.g. "one proxy per person"); this is **UNVERIFIED**. Companies-law style caps are not applicable to societies.

**Product implication**: make "Proxy" an enrolment role that is **disabled by default and enabled per society by the organiser** (statute may forbid it), with required fields: principal flat, authority letter upload, validity (this meeting/election only), principal's explicit confirmation (so the principal can see and revoke), and a per-principal cap of 1 active proxy (design choice, not law). Show a warning when the organiser enables it that Maharashtra co-operatives generally forbid it.

Sources: Act and bye-law PDFs above; https://www.prashantkanha.com/faqs-on-election-of-apartment-owners-association/ ; https://right2vote.in/features/ ; https://www.nobrokerhood.com/blog/online-voting-rights-in-housing-society-elections/ ; https://www.moneylife.in/article/housing-society-problems-and-solutions-appointing-a-proxy-to-attend-society-meetings/74807.html (search result only, page not read).

---

## 3. Comparable products

Summary of what I could verify (vendor pages are marketing; I note where nothing is public).

| Product | Voter onboarding | Verification / approval | Resubmission | Masking / publication | Audit trail | Pricing (public?) |
|---|---|---|---|---|---|---|
| **ApnaComplex** (India) | Polls target all residents or a subgroup (Owners / Residents / Committee); "voting rights one per unit or one per user"; anonymous polls; blog covers election process and uses of the app (notice board, wiki). No dedicated election module or voter-roll workflow found. | Not found | Not found | Not found | Not found | Unpublished per-unit; one secondary says plans from about Rs 499/month, unverified |
| **MyGate** (India) | Admin creates "Election Poll" in dashboard (needs enabling via relationship manager), picks participants; "one vote per flat" option; secret poll; Dec-2022 release note says defaulters can be restricted from voting | Admin-chosen participants; no member self-registration found | n/a | Admin sees who participated and flat numbers, not choices; results not shown to residents in survey flow | Not found | Unpublished (blogs quote Rs 3-12 per flat, unsourced) |
| **NoBrokerHood** (India) | AGM/election voting inside app; own blog describes eligibility checks, OTP + 2FA, selfie/geotag claims, 8-hour windows (24h for NRIs), data kept 3 months | Claims "only eligible members can vote"; mechanics not described | Not found | Not found | Claims end-to-end encryption and audit trails, not detailed | Unpublished |
| **ADDA** (India) | "Online Ballot" module in ADDA ERP: admin lists nominees, residents vote in the app; secret ballot; claims audit trail; advises keeping the member list current | Not described | Not found | Not described | "full audit trails" claimed, contents not described | Not public (demo via sales) |
| **SocietyRun / Society Run** (India) | Nothing found on voting or member roll. Listings show base features: billing, payment gateway, email/SMS | n/a | n/a | n/a | n/a | Directory listing "from INR 15" - unverified |
| **SocietyKit** (India) | Lists digital voting and surveys | Not found | Not found | Not found | Not found | A directory says "from 2 per flat, min 500 flats" - currency unclear, unverified |
| **Right2Vote** (India, e-voting specialist) | Admin adds voters; separate "online voter registration" service collects member details and verifies by OTP (details not documented publicly); OTP to both e-mail and mobile; "reverse OTP" fallback after 60 s | Optional Aadhaar OTP/biometric, selfie, face match, geofence, IP limits (all paid add-ons); maker-checker-scrutinizer roles; election officer | Not found | Hides individual voting status during poll; secret ballot, receipts | Standard audit trail + voter receipts; premium blockchain | Public: min **Rs 10,000 for up to 200 voters** (+18% GST) with standard features; add-ons Rs 10-25/voter with minimums |
| **Helloworld** | **Could not confirm any society product by this name** | - | - | - | - | - |
| **Balloon** | **Could not confirm a product by this name** | - | - | - | - | - |
| **ElectionBuddy** | Voter list upload (Excel, Google Sheets, integrations), unique voter codes by e-mail, optional 2FA on paid tiers; reviewers say list import errors are painful | Voter audit after the election; priced by size of eligible-voter list | Fix by re-uploading | n/a | "Election Audit", independent verification features | Public per election: Free (20 voters), Plus $29 (350), Premium $99 (1,000), Professional from $299 (100,000); MeetingVote $0/$197/$397/from $797 |
| **Simply Voting** | Customer sends spreadsheet (name, e-mail, unique ID); import assistant maps columns; managed service; postal credentials if needed | Vendor handles list; audit trail delivered after election | n/a | n/a | Audit trail and reports delivered after election | Quote-based per elector tier; G2 lists free trial for first 250 electors (secondary) |
| **Helios** (open source) | Closed list: admin uploads voters; each gets username + random per-election password by e-mail; or "open registration" with no fixed list. Admin **freezes** the election before voting. Votes posted to a public bulletin board labelled by voter name or ID | Academic note: a registration failure can negate the auditability that Helios provides | n/a | Public bulletin board shows voter ID with encrypted vote | End-to-end verifiable audit | Free / open source |
| **eBallot / POLYAS** | eBallot: import voters by file, single voter, or from another ballot. POLYAS: Excel import or line-by-line "Register"; advise data minimisation; ID attribute + generated password | POLYAS finalisation only needed for postal credential export | n/a | n/a | not fully verified | Not captured |

Source pages: https://www.apnacomplex.com/features ; https://blog.apnacomplex.com/2023/08/29/community-elections-what-you-should-know-about ; https://adminfaq.mygate.com/articles/128383-is-there-a-provision-on-mygate-to-control-the-number-of-people-per-flat-who-can-cast-vote-in-an-election-poll ; https://mygate.com/blog/feature-in-focus/election-poll-and-surveys/ ; https://www.nobrokerhood.com/blog/online-voting-rights-in-housing-society-elections/ ; https://blog.ind.adda.io/?p=21141 ; https://right2vote.in/features/ ; https://right2vote.in/pricing/ ; https://electionbuddy.com/pricing/ ; https://www.simplyvoting.com/ (via search listings) ; https://en.wikipedia.org/wiki/Helios_Voting ; https://support.polyas.com/?p=7278 ; https://intercom.help/eballot/en/articles/9138509-how-to-import-voters-to-a-ballot

### Key finding
**None of the Indian incumbents publicly documents a voter-list build workflow** (self-enrolment by role, document upload, approver queue, send-back with reason, masked draft list, frozen signed list). They treat "voters" as an existing admin-chosen group and focus on casting the ballot. This is the product's gap and its differentiator. Caveat: lack of public documentation is not proof the feature is absent.

### Features worth borrowing
1. One-vote-per-unit enforcement with a configurable weight (MyGate "one vote per flat"; ApnaComplex "one per unit or one per user").
2. Defaulter restriction as a flag (MyGate Dec-2022 release note) - but display the reason and let the organiser decide the rule.
3. Maker-checker-scrutinizer separation (Right2Vote) -> map to organiser / host / Returning Officer.
4. Freeze before the event; public listing by pseudonymous ID rather than name (Helios bulletin board).
5. Import-assistant style CSV upload with column mapping and clear row-level errors (Simply Voting, ElectionBuddy reviewers complain about this).
6. Voter receipt / confirmation e-mail after each state change (Right2Vote "receipt").
7. Show who has participated without exposing choices (MyGate) - for us: show enrolment status counts, not documents.
8. Data minimisation in the roll (POLYAS advice to include only what is needed).
9. Per-election price transparency (Right2Vote, ElectionBuddy) - a tiny free tier builds trust.

### Features deliberately not worth building (for this scope)
- **Ballot casting / tallying / secret ballot / e-voting**. Legal approval is society-specific (e.g. Telangana answer: bye-law amendment + Registrar approval; Maharashtra Act silent on method per Right2Vote) and moves the product into a far riskier regulated area.
- **Aadhaar OTP, biometrics, selfie/face match, geofencing, blockchain** (Right2Vote add-ons): high DPDP/Aadhaar-Act exposure and low value for a list-building tool; see section 4.
- **SMS / WhatsApp OTP**: cost on a free plan, SMS is the weakest channel (NIST restricted authenticator per OWASP); the brief already chose e-mail.
- Billing, accounting, visitor management, forums (platform suites). Not part of a voter list.
- Face / selfie "liveness" checks of voters.

---

## 4. DPDP Act 2023 and DPDP Rules 2025

### 4.1 Status and commencement (as verified)
- Act: enacted 11 Aug 2023 [PRIMARY: PIB summary and Act PDF].
- Rules: Gazette issue dated **13 Nov 2025**; PIB says notified 14 Nov 2025 [PRIMARY: Gazette PDF header "Thursday, November 13, 2025"; PIB release 17 Nov 2025].
- Rule 1(2): Rules 1, 2, 17-21 in force on publication. Rule 1(3): Rule 4 (Consent Managers) one year after publication. Rule 1(4): **Rules 3, 5-16, 22, 23 come into force eighteen months after publication** [PRIMARY, Rule 1 text]. Counting from 13 Nov 2025 gives about **13 May 2027** (secondary sources say 13 or 14 May 2027; one secondary quotes a MeitY press release saying "fully enforceable from 13 May 2027") [SECONDARY]. Rule 4 therefore falls about 13 Nov 2026 (computed).
- Act commencement notification (G.S.R. 843(E), 13 Nov 2025) brought in only the Board/definitions/ancillary sections now; the core duties (notice, consent, safeguards, rights, breach) are scheduled for the 18-month mark [SECONDARY, dpdprules.org - could not read the notification itself].
- **MeitY proposal (Jan 2026) to shorten the 18-month window** (e.g. to Nov 2026 for some provisions): reported as a proposal only; a Oct-2026 secondary tracker found no instrument making the change. **UNVERIFIED - re-check before launch.**
- Data Protection Board: reported not yet functional as of 7 Oct 2026; a constitutional challenge is pending with no stay reported [SECONDARY, dpdprules.org]. UNVERIFIED.
- Interim: the old IT Act SPDI Rules 2011 continue until the new duties start [SECONDARY].
- **Practical**: build to DPDP now; a society going live on Cloudflare in late 2026 should expect to be inside the regime within about six months.

### 4.2 Who is the data fiduciary / processor?
- "Person" includes an association of persons or body of individuals, incorporated or not, and any artificial juristic person (Act s.2(s)) [PRIMARY]. A society is therefore a person.
- Data Fiduciary = anyone who alone or with others determines the purpose and means of processing (s.2(i)). Data Processor processes on behalf of a fiduciary (s.2(k)). A processor may be engaged only under a valid contract (s.8(2)), and the fiduciary remains responsible (s.8(1)) [PRIMARY].
- Household/personal exemption (s.3(c)(i)) covers an individual's "personal or domestic" use, not an organised society's voter roll (my reading, not legal advice).
- Small entities: s.17(3) lets the Centre exempt some classes (e.g. startups) from specific duties; I found **no** notification exempting societies. **UNVERIFIED**.
- **Likely role split**: each society (AOA/RWA/HOA) = data fiduciary for its roll; the product operator = data processor for each society **if** the operator does not decide purposes. Because the operator designs the schema and the common link, a regulator could treat it as a joint fiduciary. **Recommend**: a one-page data-processing terms accepted by the organiser at set-up; the organiser (not the operator) is named as the contact; operator publishes its own contact for rights requests too. Get legal review.

### 4.3 Obligations most relevant to a voter list (all [PRIMARY] unless noted)
- **Lawful grounds** (s.4): consent, or "certain legitimate uses" (s.7). s.7(a): processing for the specified purpose for which the person **voluntarily provided** the data and has not objected is a legitimate use. A self-enrolled voter plausibly fits s.7(a), but the safer design is an explicit notice plus affirmative consent (s.6(1): free, specific, informed, unconditional, unambiguous, clear affirmative action, limited to data necessary for the purpose).
- **Notice** (s.5; Rule 3): independent of other information, plain language, itemised description of the data, the specified purpose and specific description of the service/use, a link to the website/app, and how to withdraw consent (as easy as giving it), exercise rights, and complain to the Board. Option to read it in English or an Eighth-Schedule language (s.5(3), s.6(3)). Include the contact of a person authorised to answer (s.6(3), s.8(9), Rule 9).
- **Purpose limitation / data minimisation**: consent covers only the specified purpose and only data necessary for it (s.6(1) and illustration). Do not reuse the roll for marketing or other agendas.
- **Accuracy**: s.8(3) - where data is likely to be used to make a decision affecting the person or disclosed to another fiduciary, ensure completeness, accuracy, consistency. The roll decides who may vote -> accuracy duty is real.
- **Correction, completion, updating, erasure** (s.12): the person may request; the fiduciary must correct/complete/update; erase unless retention is necessary for the specified purpose or for compliance with law. Response within a reasonable period not exceeding **90 days** via a published grievance system (Rule 14(3); PIB summary says 90 days). Nomination of someone to exercise rights (s.14, Rule 14(4)).
- **Retention/erasure** (s.8(7)): erase on withdrawal of consent or when the purpose is no longer served, unless law requires retention. Rule 8(1)/Third Schedule retention timers apply only to listed classes (large e-commerce, online gaming, social media) - not to a society. But **Rule 8(3)** requires a fiduciary to retain personal data, traffic data and logs of processing for a **minimum of one year** (for Seventh-Schedule government-access purposes) and then erase, and Rule 6(1)(e) requires retaining logs and personal data for one year to detect unauthorised access, "unless law requires otherwise". These interplay with a "delete after the meeting" promise; MeitY has reportedly proposed cutting Rule 8(3) to 3 months [SECONDARY]. **Plan for >= 1 year log retention; keep personal documents far shorter, and have counsel confirm how the one-year rule applies to uploaded documents.** UNVERIFIED application.
- **Security safeguards** (s.8(5); Rule 6): encryption, obfuscation, masking or virtual tokens; access control; logging/monitoring and review; backups for continued processing; processor contract clauses; organisational measures [PRIMARY]. Penalty for failing reasonable safeguards: up to Rs 250 crore (Schedule) [PRIMARY].
- **Breach** (s.8(6); Rule 7): tell each affected person without delay (what happened, consequences, mitigation, protective steps, contact) and the Board without delay, with detailed information within **72 hours** (extendable on written request). Penalty for failing to notify: up to Rs 200 crore [PRIMARY].
- **Children** (s.9; Rule 10): a child is anyone under 18; verifiable parental consent before processing; no tracking/behavioural monitoring. Penalty up to Rs 200 crore. Apartment voter rolls are adult owners/tenants, but heirs, nominees and co-owners can be minors (Maharashtra s.27(2) excludes minors from voting): **block enrolment of under-18s; a guardian acts**. Persons with disability and lawful guardians: s.9(1), Rule 11.
- **Publishing personal data publicly**: no special DPDP rule found beyond consent/purpose. s.3(c)(ii) excludes data made public by the person or by someone under a legal obligation to publish it; a notice-board voter list required by election rules **might** fall there, but a public web list of an ad-hoc product is not obviously "required by law" - do not rely on it. **UNVERIFIED legal reading.**
- **Significant Data Fiduciary** duties (DPO, DPIA, audit) apply only if notified (s.10, Rule 13) - unlikely for a society.
- **Penalties**: up to Rs 50 crore for other violations; amounts are caps, not likely applied to small societies, but the exposure shapes the processor's contractual risk [PRIMARY: Act Schedule].

### 4.4 Design implications (recommendations, not law)
1. **Public DRAFT list is masked**: show flat/unit code and a masked name (e.g. first name + initial of surname or "R. K." style), role, status; **no phone, e-mail, address, ID or documents**. Name is personal data even when masked, so the consent text must say the masked name and flat appear in a public provisional list.
2. **Voter-side view** shows everything the voter gave plus the status, reason of any send-back, and an audit-style history of changes to their own record.
3. **Consent screen before first upload**: itemised data, purposes (build the voter list for [society] meeting/election; contact about it), who sees it (organiser, hosts, Returning Officer), what is public (masked), retention period, how to withdraw / correct / erase, contact person, complaint route to the Board, language toggle (English + at least Hindi and the state's language). Record consent with timestamp and notice version (s.6(10) puts the burden of proof on the fiduciary).
4. **Withdrawal** as easy as consent: one "Withdraw / delete my data" button; explain that a frozen published list cannot be silently rewritten: the system should show a "withdrawn" mark and mask further, with a note that legal retention may apply.
5. **Retention (proposal)**: uploaded documents deleted a fixed number of days after the list is frozen plus the objection window (e.g. 90 days, configurable), or immediately after approval if the society prefers ("verified by host on date, document type" retained as a flag). Frozen list retained for a society-set period; processing logs at least 1 year (Rule 6(1)(e), 8(3)); note the 3-month sealed-records practice reported for Maharashtra elections [SECONDARY].
6. **Data minimisation**: ask only name, unit, role, e-mail (needed for sign-in), optional phone, ownership/authority document. Do not collect date of birth, Aadhaar number, PAN, bank details.
7. **Security**: store documents in a private bucket with signed short-lived URLs; encrypt at rest; hash/pepper e-mail where used for lookup; log every officer access (who viewed which document) as required by Rule 6(1)(c); role-based access (organiser vs host vs RO); rate limits; breach runbook with 72-hour clock.
8. **Grievance**: published contact (organiser) and operator contact; 90-day maximum (aim far faster); status of requests visible.
9. **Processor terms**: a data-processing clause for the organiser to accept; sub-processor list (Cloudflare etc.); data location statement (Rule 15: cross-border transfers allowed subject to government orders; no restriction notified for ordinary fiduciaries).
10. **Do not** send the voter list to third parties (e.g. e-voting vendors) without a new notice/consent.

### 4.5 Aadhaar / ID document cautions
- Aadhaar Act s.29(4): no Aadhaar number, demographic information or photograph collected or created under that Act may be published, displayed or posted publicly except for purposes specified by regulations [PRIMARY: advocatekhoj.com bare act text; amended by Act 14 of 2019].
- Sharing-of-information regulations repeat that an Aadhaar number must not be published, displayed or posted publicly by any person or entity (Regulation 6(1)) [SECONDARY - search snippet; not read in full].
- Practice: UIDAI-issued **masked Aadhaar** shows only the last four digits; display of only the last four digits is the usual compliance guidance [SECONDARY].
- May 2022: MeitY/UIDAI advisory told people not to share Aadhaar photocopies with unlicensed private entities; the press release was **withdrawn on 29 May 2022** [SECONDARY: SCC Online]. So treat "never collect Aadhaar copies" as cautious best practice, not a settled prohibition.
- Puttaswamy (2018) limited private-entity use of Aadhaar authentication [SECONDARY]; Aadhaar OTP/biometric/selfie verification, as sold by some e-voting vendors, requires a UIDAI licence/registration route I did not research. Do not build it.
- **Rules for this product**: never ask for the Aadhaar number; do not offer Aadhaar as an accepted document type; if a voter uploads one anyway, instruct to **mask the first 8 digits** (or use UIDAI's masked Aadhaar) before upload; never run OCR to extract an ID number; never show any ID in lists, exports or e-mails; restrict to the RO and the specific host; auto-delete after verification or the retention window. Prefer documents that prove entitlement (sale deed / share certificate / allotment letter / maintenance bill / rent agreement) over identity documents; consider accepting a maintenance bill or share certificate as the main proof so ID is only a supporting item.

Sources: https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf ; https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf (Rules text, read in full for Rules 1-16) ; https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf (Act text, read) ; https://dpdprules.org/blog/dpdp-act-rules-what-is-in-force-2026 ; https://ssrana.in/articles/meity-plans-to-cut-short-dpdp-compliance-timeline-and-notify-cross-border-restrictions-for-sdfs/ ; https://takshashila.org.in/content/blogs/20260126-meity-considers-reducing-dpdpa-compliance-timelines.html ; https://www.advocatekhoj.com/library/bareacts/aadhaar2016/29.php ; https://www.scconline.com/post/2022/05/29/meity-issues-advisory-on-sharing-aadhaar-card-with-unlicensed-private-entities/

**Not confirmed**: whether Rule 8(3) one-year retention applies to uploaded documents of a small fiduciary; whether any exemption exists for societies; status of the 12-month compression; Board functionality; Regulation 6(1) wording of the Aadhaar Sharing-of-Information Regulations; whether a public masked draft list is a "disclosure" needing separate consent (my recommendation: say so in the notice).

---

## 5. UX patterns: e-mail + 6-digit code, mobile enrolment, send-back loops

### 5.1 Code entry (e-mail OTP)
- **Single input**, `type="text"`, `autocomplete="one-time-code"`, `inputmode="numeric"`; accept spaces/hyphens/pasted text (GOV.UK pattern) [PRIMARY: GOV.UK design system; MDN]. MDN defines the `one-time-code` token as an OTP used as an additional factor, "such as SMS, email, or authenticator application".
- **WebOTP** (auto-read) is **SMS only** (`transport: ["sms"]`, message must end with `@domain #code`) and is not Baseline; Safari uses `autocomplete="one-time-code"` instead [PRIMARY: MDN WebOTP]. **It does not help e-mail codes**; for e-mail rely on the autocomplete token plus "paste" and on an "open your mail app" hint. Whether mobile keyboards offer e-mail codes as suggestions is device-dependent - **UNVERIFIED**.
- **WCAG 2.2 SC 3.3.8 Accessible Authentication (Minimum), AA**: users must not be forced to transcribe a code; allow paste and autofill; split six-box layouts that accept paste only in the first box fail; copying from an e-mail is considered fine; e-mail-link authentication is a listed sufficient technique (G218). Either a single field (preferred) or six boxes that handle paste across boxes [PRIMARY: W3C Understanding 3.3.8]. **Offering both** a typed code and a "sign in with this link" in the e-mail is the most accessible option.
- **Security/policy points** [OWASP MFA cheat sheet]: short TTL; strict attempt limits; single use; each resend overwrites the previous code (OWASP) - GOV.UK instead keeps the previous code valid until its own expiry - choose one and say it in the UI; no OTP in logs; 6 digits is a small keyspace -> need attempt limits (e.g. lock/delay after about 5-10 failures: GOV.UK delays after 10); e-mail codes are only as safe as the mailbox.
- **Expiry & resend**: GOV.UK SMS pattern uses 15 minutes; expired code -> "code has expired, new code sent"; resend link text "Not received...?" and a request page; during sign-in don't reveal the full contact (here: mask the e-mail) [PRIMARY]. I found **no authoritative figure for a resend cooldown**; a visible 30-60 s countdown is common practice (Right2Vote offers fallback after 60 s) but this is a design choice, not a standard [UNVERIFIED].
- **Error wording** (GOV.UK confirm-a-phone-number): wrong code "Enter a correct security code"; too short/long "You've not entered enough numbers, the code must be N numbers"; non-numeric "The code must be N numbers". Pattern rules: don't validate on blur; show an error summary at top, move focus to it, prefix page title with "Error:", message beside the field linked with `aria-describedby`, say what went wrong and how to fix it; preserve inputs; ignore stray spaces; **never use validation to decide eligibility** - send to an explanation page [PRIMARY: GOV.UK validation + confirm-a-phone-number].
- **Plain India-specific hints** (my recommendations): show "check Spam/Promotions"; "we sent the code to r***@gmail.com"; "wrong e-mail? change it"; accept codes with spaces; keep one working link so people can re-open the page from the mail app on a phone; page must survive being backgrounded while the person switches to the mail app (preserve state; do not reset the timer without notice).

### 5.2 WCAG 2.2 AA basics for forms (all [PRIMARY: W3C])
- **2.5.8 Target Size (Minimum)**: pointer targets at least 24x24 CSS px or sufficient spacing; the AAA 2.5.5 is 44x44 - aim for 44 on mobile.
- **3.3.7 Redundant Entry (A)**: don't ask again for information already given in the same process (auto-populate or let the user select); applies across the enrolment steps - e.g. do not ask for name/flat again in each role.
- **3.3.8 Accessible Authentication** as above.
- **2.4.11 Focus Not Obscured (Minimum)**: sticky headers/footers and the on-screen keyboard must not hide the focused field; keep step buttons from covering it.
- **3.3.1/3.3.3 Error identification and suggestion**; **1.3.5 Identify Input Purpose** (WCAG 2.1, not re-fetched): use `autocomplete="email"`, `name`, etc.
- **2.5.7 Dragging Movements**: any drag-to-reorder or drag-to-upload needs a tap alternative. **3.2.6 Consistent Help**: put "Help / contact the organiser" in the same place on every step.
- Labels always visible (not placeholder-only), `<label for>`, grouping with fieldset/legend for role choice, 16px+ input text to avoid iOS zoom (common practice, not from a fetched source).

### 5.3 Multi-step self-service enrolment on mobile
- One task per step; progress shown as "Step 2 of 5" text; the back button always works; save a draft automatically between steps (server-side draft tied to the e-mail), so a person can leave to find a document and come back via the same link (3.3.7 note: processes needn't persist across sessions, but it helps).
- Role-first branching: ask Owner / Co-owner / Tenant / Proxy first, then show only that role's fields and documents; show the **rule in plain words** ("Tenants are not on the voter list in most societies; the organiser decides" if the organiser selects tenant voting).
- Document upload: camera capture and file picker; show file size/type limits; compress images client-side; show a thumbnail and a "remove/replace" action; give a clear "mask your Aadhaar number before upload" warning; explain what happens to the file.
- Status page ("My enrolment"): current status (Draft / Submitted / Under review / Sent back / Approved / Included in DRAFT / Frozen), what was asked, last change time, and one clear next action.
- Language: offer English plus at least Hindi and the society's local language; the DPDP notice must be available in English or an Eighth-Schedule language.

### 5.4 Approval / send-back loops
No authoritative design-system guideline was found; the following comes from vendor help pages and general practice [SECONDARY, weak].
- Separate **"Send back for correction"** (fixable, edit and resubmit) from **"Reject"** (final) - one vendor help page distinguishes these two; a rejection with no further review closes the item.
- Require a **reason** (a short pick-list plus free text), tied to the specific field or document that needs fixing, shown next to that field when the voter returns; keep the history of rounds.
- Let the voter **edit in place and resubmit** rather than creating a new record; keep earlier versions for audit.
- Notify by e-mail on state changes, but avoid noise (one tutorial lists notifying on every status change as a common mistake).
- Host-side: a queue with filters (new, resubmitted, sent back), keyboard-friendly bulk actions, a lock/"claimed by" marker to avoid two hosts acting on one record, undo for a short time, and an organiser override with its own reason.
- Make reasons **visible to the voter only** (not on the public draft list), and keep wording neutral (guidance: GOV.UK says tell the person what went wrong and how to fix it).

Sources: https://design-system.service.gov.uk/patterns/confirm-a-phone-number/ ; https://design-system.service.gov.uk/patterns/validation/ ; https://design-system.service.gov.uk/patterns/confirm-an-email-address/ ; https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ ; https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html ; https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html ; https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html ; https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html ; https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete ; https://developer.mozilla.org/en-US/docs/Web/API/WebOTP_API ; https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html ; https://help.xenia.team/hc/en-us/articles/50582440666139-Requesting-Changes-or-Rejecting-a-Submission-on-Mobile

---

## Top 12 gaps a good product should cover

1. Role-aware enrolment (Owner / Co-owner / Tenant / Proxy) with organiser-set rules per society, because tenant and proxy votes are barred in most regimes and allowed only by bye-law elsewhere.
2. One-vote-per-unit enforcement with joint-owner precedence (first-named, then next present) and an optional per-unit weight (percentage of undivided interest) for apartment-act societies.
3. A dues/eligibility flag as of a cut-off date, with an organiser-chosen rule (blocks vote / blocks candidacy / info only) and a visible reason, since the defaulter-vote rule varies and is unsettled in Maharashtra.
4. Provisional DRAFT list -> objection window -> decision log -> FROZEN final list, with a named Returning Officer role and a record of the legal basis and cut-off, mirroring the real legal sequence (provisional list, 10-day objections, final list).
5. Masked public DRAFT list (no phone, e-mail, address, ID or documents) with a consent notice that explains exactly what is public.
6. DPDP-ready consent and rights flow: itemised notice (Rule 3) in English and local languages, versioned consent record, withdrawal as easy as consent, correction/erasure requests within 90 days, grievance contact, processor terms for the organiser.
7. Retention and erasure plan: documents purged on a schedule, frozen list kept for a stated period, logs kept at least one year, and clear messaging that a frozen list cannot be silently rewritten.
8. ID-document hygiene: never collect Aadhaar numbers, instruct masking before upload, never display or export IDs, restrict access to the RO/host assigned, log every view.
9. Secure sign-in: single-field e-mail code with `one-time-code`, paste-friendly (WCAG 3.3.8), expiry, attempt limits, resend rules, masked e-mail display, and an alternative magic-link.
10. Send-back-with-reason versus final reject, tied to specific fields/documents, with in-place resubmission, round history, and voter-visible reasons.
11. Tamper-evident audit: who approved/changed what and when, host claim locks, undo, and a signed, fingerprinted frozen list with a verifiable fingerprint that anyone can recompute from the published masked list.
12. Mobile-first accessibility and language: WCAG 2.2 AA (24px minimum targets, focus not obscured, no redundant entry, consistent help), draft autosave across steps, low-bandwidth uploads, and plain-language error text.
