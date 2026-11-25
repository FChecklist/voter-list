# Elections (Townhall Records), first chunks

A society election, start to finish, on the frozen final voter list of a Voter List: nominations, a notice, a secret ballot (online, in person or both), the count, challenges, the declaration and one public report. It stands on its own, in the same way as Attendance: its own tables (`migrations/0018_elections.sql`), its own files (`src/elections*.ts`) and a connection to the rest only through the Voter List's public contract (the frozen publication and the signed trail) and a read-only look at Attendance.

**It is dark.** Every address answers "not found" until the owner sets `ELECTIONS_ENABLED` to `1`. Nothing here takes payment.

## Who does what

| Person | What they can do |
| --- | --- |
| Organizer | Sets up the draft, issues the notice, publishes the final candidate list, opens, closes and extends voting, decides appeals. Signs in as staff. |
| Co-organizer | Reads the election and sees nominations with masked e-mail IDs. Cannot change it. |
| Returning officer | One person per election. Accepts or rejects nominations, counts, answers challenges and is the only one who declares the result. Signs in like a voter, with the e-mail code. |
| Counting agent | Finds people at the desk, gives paper ballots, counts and recounts. Cannot declare. |
| Observer | Reads the count. Nothing else. |
| Voter | A person on the final voter list. Stands for a post, proposes or seconds, votes, checks a receipt, sends a challenge. |

The person who sets up the election, the officials, the Organizer and every co-organizer cannot stand as candidates (checked when a nomination is sent and again when voting is opened). The returning officer cannot be the Organizer, cannot open the voting and cannot decide an appeal. The pages refuse each of these, and the database has a second lock for the officials. A candidate needs a proposer and a seconder who are on the list.

## The steps

1. **Draft** (Organizer). Title, posts and seats, how many votes a voter has for each post, the way of voting (online, in person, offline or mixed), none of the above on or off, equal or weighted votes, the times (nominations open and close, last time to withdraw, voting opens and closes) and the officials. A draft can be changed freely and is not public.
2. **Notice** (Organizer types `NOTICE`). The rules are fixed from now on, in the pages and in the database. The notice links the latest frozen voter list, so everyone can see who may vote and who may stand.
3. **Nominations.** A person on the list sends a nomination with a written statement, a proposer and a seconder. The returning officer accepts or rejects it, and a rejection needs a reason. A rejected person can appeal; the Organizer decides the appeal, and the person who rejected cannot also decide it. A candidate can withdraw until the last time to withdraw.
4. **Final candidate list** (Organizer types `FINAL`). Each post becomes *contested* (more candidates than seats), *unopposed* (candidates up to the seats: elected without a vote) or *vacant* (no candidate). The list gets a fingerprint.
5. **Voting** (Organizer types `OPEN`). Online: the voter signs in, asks for a six-digit ballot code that is mailed, opens the ballot with it, and votes. In person: the returning officer or a counting agent finds the person on the list and gives a paper ballot. When an attendance session is named, a paper ballot goes only to a person marked present in it.
6. **Close** (Organizer types `CLOSE`). Closing before the stated time needs a written reason. The voting time can be made longer, by at most 48 hours and with a written reason, and never shorter.
7. **Count** (returning officer or counting agent). Not possible before the close. Paper ballots are counted by hand and the numbers are typed in; they must add up before they are stored. A recount needs a written reason and keeps the earlier counts.
8. **Challenges.** For the challenge time (24 hours by default) any person on the list can send a question about the count. The returning officer answers each one in writing.
9. **Declaration** (returning officer types `DECLARE`). Only when the challenge time is over, every challenge has an answer, and a fresh look at the box agrees with the stored count: the register, the ballots, the receipts and the signed trail must match, and the same ballots must still give the same fingerprint.
10. **Report.** One public page (`/report`) holds the rules, the dates, the candidates, the trail, every count, the challenges and answers, the result and the sign-off.

## How the vote stays secret

- **Two separate places.** The *register* says who has voted. The *ballots* say what was chosen. They are written in one step but share no column: a ballot has a random id, a post, a weight and a sealed choice. No voter, no time, no counter, and the table has no hidden row number.
- **Sealed.** Each choice is encrypted with a key made from a server secret and the election's own random salt. Every sealed choice is the same length, is different every time even for the same choice, and is tied to its own ballot and post. A person with the whole database file but not the server secret cannot open anything.
- **A ballot for every contested post.** A voter who leaves a post blank still puts a blank ballot in, so the number of ballots tells nothing about who skipped what.
- **Nothing is added up before the close.** No address and no function counts a choice while voting is open. The open pages show how many have voted, never what.
- **The receipt.** After voting the voter gets a code. Only a hash of it is kept, in a table of its own. Anyone with the code can check that a ballot with it is in the box. It shows nothing about the choice and cannot be joined to the voter.
- **No time next to a person.** The register keeps the calendar day a person voted (in the society's time zone), never the hour or the minute. A ballot code and a ticket are deleted as soon as they are used, so they keep no person and no time. The signed entry of a vote carries the date (its time is the start of that day), the private code of the voter and no ballot id. This matters in a small society, where voters who vote one after the other could otherwise be matched to what was written in the same step. What is *not* hidden: the order of the signed entries, the day, and any time kept by systems outside Elections (for example the e-mail outbox).
- **One vote.** The register's key is the election and the person; the database refuses a second line. Two votes sent at the same moment give one set of ballots.
- **One step.** The register line, the ballots, the receipt and the signed-trail entry are written together or not at all.
- **A changed box is caught.** Before the count is stored, and again before the result is declared, the register, the ballots, the receipts and the signed trail are checked against each other. A ballot taken out, added, changed or swapped, a register line taken out or added, or a receipt taken out stops the declaration.

All of this is proved by the tests listed below, which read the real database after real votes.

## What the count check proves

Before a count is stored, the register, the ballots, the receipts and the signed trail are compared by number: the votes in the register must equal the ballots, the receipts and the "vote cast" entries of the trail, and the same for paper ballots. A ballot taken out, a register line added, or a trail entry turned into another kind makes the count fail to reconcile and the result cannot be declared. The check counts entries; it does not check their signatures, because that work is done page by page on the public trail so that no single request does all of it. A person who could change the database and also write a matching forged trail entry would not be caught by the count, but the forged entry carries no valid signature and breaks the chain, which anyone can see when the trail is verified (the trail page and the audit export). Verify the trail before declaring a result.

## For an AI helper

Copy this link and paste in your AI to work.

Staff addresses use the Organizer or co-organizer sign-in; the others use the common voter link sign-in. Every request that changes something sends the header `x-vl: 1`.

1. Staff: `POST /api/lists/:sid/elections` to make the draft, `PATCH` to change it, `POST .../notice`, `POST .../candidates/final`, `POST .../open`, `POST .../close`, `POST .../extend`, `POST .../nominations/:nid/appeal/decide`; `GET` the list, one election, and the nominations.
2. Anyone with the common link: `GET /api/v/:slug/elections`, `.../:eid`, `.../trail`, `.../results`, `.../report`, `.../challenges`, `.../receipt/:code`.
3. A signed-in voter: `GET .../me`, `.../own-nominations`; `POST .../nominations`, `.../nominations/:nid/withdraw`, `.../appeal`, `.../ballot-code`, `.../ballot`, `.../vote`, `.../challenges`.
4. The people named for the election: `GET .../nominations`, `.../roll?find=`, `.../count`; `POST .../nominations/:nid/decide`, `.../paper/issue`, `.../count`, `.../challenges/:n/answer`, `.../declare`.

## Settings and limits

- `ELECTIONS_ENABLED` is `1` to switch the product on. Anything else keeps it dark.
- A ballot code works for 10 minutes and once; a ticket for 15 minutes and once. A voter can ask for three codes an hour.
- Each online vote can send two e-mails: the sign-in code (not needed when the voter signed in during the last 8 hours) and the ballot code. The daily limits `MAIL_DAILY_CAP` and `MAIL_LIST_CAP` (80 and 25 by default) decide how many people can vote online in a day, so the owner has to raise them for anything but a very small society.
- Weighted votes need online voting and at least 5 voters in every weight group, because a weight shared by fewer people could point to one person.
- Erasing a list (after the retention time, when the owner has set one) removes every person's details and every vote of its elections. The rules, the posts and the public trail stay; they hold no personal data.

## Tests

`test/elections.test.ts` (set-up, notice, nominations, scrutiny, appeals, the final list), `test/elections-vote.test.ts` (voting time, one vote each, tickets and codes, checks on a ballot, paper ballots, the attendance link), `test/elections-count.test.ts` (who counts and when, tallies, recounts, the draw for a tie, paper numbers, challenges, the declaration, a changed box, erasure) `test/elections-secrecy.test.ts` (the shape of the database, no join between voter and choice, the seal, no count before the close, the receipt, one step, two votes at once), `test/elections-oracle.test.ts` (random votes counted twice, once by the product and once by the test on its own, and compared) and `test/elections-permissions.test.ts` (every address tried by every kind of person). The shared set-up is `test/elections-world.ts`.

## Not in this chunk

Screens for voters, officials and the Organizer; Hindi lines for those screens (a native Hindi reader must check them); e-mailing the notice to every voter; a proxy vote; ranked or transferable votes; a run-off after a tie (the draw is the only tie rule). See `KNOWLEDGE.md` for the limits that are accepted for now.
