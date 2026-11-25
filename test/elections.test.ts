// Elections, first chunk: the dark switch, setting up an election, the notice, nominations, scrutiny, appeals, withdrawal and the final candidate list.
// (Voting, secrecy and the count are in elections-vote.test.ts, elections-count.test.ts and elections-secrecy.test.ts.)
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";
import { OFFICIALS, RO, SCHED, asMember, at, base, cand, draft, emailOf, nominate, notice, staffUrl, toFinal, voterUrl, DEFAULT_POSTS } from "./elections-world";

const rows = (h: { raw: { query: (s: string) => { all: (...a: any[]) => any[] } } }, sql: string, ...a: unknown[]) => h.raw.query(sql).all(...a);

describe("elections are dark until switched on", () => {
  test("every address answers not found when ELECTIONS_ENABLED is not 1, and works again when it is", async () => {
    const b = await base({ voters: 6 }); const w = await draft(b);
    expect((await w.h.call("GET", staffUrl(w), undefined, w.jar)).status).toBe(200);
    for (const off of [undefined, "0", "true", ""]) {
      (w.h.env as any).ELECTIONS_ENABLED = off;
      const voter = await asMember(w, emailOf(0));
      const calls: Array<[string, string, unknown, any]> = [
        ["POST", `/api/lists/${w.sid}/elections`, {}, w.jar], ["GET", `/api/lists/${w.sid}/elections`, undefined, w.jar], ["GET", staffUrl(w), undefined, w.jar], ["PATCH", staffUrl(w), {}, w.jar],
        ["POST", staffUrl(w, "/notice"), { confirm: "NOTICE" }, w.jar], ["POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar],
        ["GET", `/api/v/${w.slug}/elections`, undefined, undefined], ["GET", voterUrl(w), undefined, undefined], ["GET", voterUrl(w, "/results"), undefined, undefined], ["GET", voterUrl(w, "/report"), undefined, undefined],
        ["GET", voterUrl(w, "/trail"), undefined, undefined], ["GET", voterUrl(w, "/receipt/ABCD-EFGH-JKLM"), undefined, undefined],
        ["GET", voterUrl(w, "/me"), undefined, voter], ["POST", voterUrl(w, "/nominations"), {}, voter], ["POST", voterUrl(w, "/ballot-code"), {}, voter], ["POST", voterUrl(w, "/vote"), {}, voter],
        ["POST", voterUrl(w, "/count"), {}, voter], ["POST", voterUrl(w, "/declare"), {}, voter],
      ];
      for (const [m, p, body, jar] of calls) { const r = await w.h.call(m, p, body, jar); expect([m, p, r.status]).toEqual([m, p, 404]); }
    }
    (w.h.env as any).ELECTIONS_ENABLED = "1";
    expect((await w.h.call("GET", staffUrl(w), undefined, w.jar)).status).toBe(200);
  });
});

describe("setting up an election", () => {
  test("only the Organizer makes one; a co-organizer can read it, with the officials' e-mail IDs masked", async () => {
    const b = await base({ voters: 6 });
    const body = { title: "Committee election", mode: "online", schedule: SCHED, posts: [{ title: "President", seats: 1 }], officials: OFFICIALS };
    expect((await b.h.call("POST", `/api/lists/${b.sid}/elections`, body, b.coJar)).status).toBe(403);
    expect((await b.h.call("POST", `/api/lists/${b.sid}/elections`, body)).status).toBe(401);
    const r = await b.h.call("POST", `/api/lists/${b.sid}/elections`, body, b.jar); expect(r.status).toBe(201);
    expect(r.json.election).toMatchObject({ status: "draft", mode: "online", rules: { fixed: false, nota: false, randomOrder: true, weighting: "equal" }, schedule: { timeZone: "UTC+05:30", nominationsOpen: SCHED.nominationsOpen } });
    expect(r.json.election.officials.find((o: any) => o.role === "returning_officer").email).toBe(RO);
    const co = await b.h.call("GET", `/api/lists/${b.sid}/elections/${r.json.election.id}`, undefined, b.coJar); expect(co.status).toBe(200);
    expect(co.json.officials.find((o: any) => o.role === "returning_officer").email).toMatch(/^\*{8}.*@sample\.example$/);
    expect((await b.h.call("GET", `/api/lists/${b.sid}/elections`, undefined, b.coJar)).json.elections).toHaveLength(1);
    // the signed trail and the election's own trail both have the line, and the trail line holds no e-mail ID
    expect(rows(b.h, "SELECT type FROM audit_entries WHERE type = 'election.created'")).toHaveLength(1);
    expect(rows(b.h, "SELECT summary FROM el_events WHERE type = 'election.created'")).toHaveLength(1);
  });

  test("bad set-up is refused, each in plain words", async () => {
    const b = await base({ voters: 6 });
    const good = { title: "Committee election", mode: "online", schedule: SCHED, posts: [{ title: "President", seats: 1 }], officials: OFFICIALS };
    const bad: Array<[string, Record<string, unknown>]> = [
      ["title too short", { title: "x" }], ["phone number in the title", { title: "Call 9876543210 now" }], ["unknown mode", { mode: "telepathy" }],
      ["times out of order", { schedule: { ...SCHED, votingClose: "2026-11-20T08:00" } }], ["a time that is not a date", { schedule: { ...SCHED, votingOpen: "soon" } }],
      ["no posts", { posts: [] }], ["no seats", { posts: [{ title: "President", seats: 0 }] }], ["more votes than seats", { posts: [{ title: "President", seats: 1, maxVotes: 2 }] }],
      ["too many posts", { posts: Array.from({ length: 21 }, (_, i) => ({ title: `Post ${i + 1}`, seats: 1 })) }],
      ["weighted votes in person", { weighting: "by_list", mode: "in_person" }], ["bad e-mail for the returning officer", { officials: { returningOfficer: { email: "nope", name: "X" } } }],
      ["one person holding two jobs", { officials: { returningOfficer: { email: RO, name: "Ravi" }, observers: [{ email: RO, name: "Ravi" }] } }],
      ["appeal time of zero hours", { appealHours: 0 }], ["an attendance session that is not on this list", { attendanceSessionId: "att_nothing" }],
    ];
    for (const [what, patch] of bad) { const r = await b.h.call("POST", `/api/lists/${b.sid}/elections`, { ...good, ...patch }, b.jar); expect([what, r.status]).toEqual([what, 400]); expect(typeof r.json.error).toBe("string"); }
    expect(rows(b.h, "SELECT COUNT(*) AS n FROM el_elections")[0]).toEqual({ n: 0 });
  });

  test("the draft can be changed until the notice; the notice needs the word NOTICE, a returning officer and a final voter list", async () => {
    const b = await base({ voters: 6 }); const w = await draft(b);
    const p = await b.h.call("PATCH", staffUrl(w), { title: "Committee election, new title", nota: false, posts: [{ title: "Chair", seats: 1 }, { title: "Member", seats: 2 }], appealHours: 12 }, b.jar);
    expect(p.status).toBe(200); expect(p.json.election).toMatchObject({ title: "Committee election, new title", rules: { nota: false, appealHours: 12 } }); expect(p.json.election.posts).toHaveLength(2);
    expect((await b.h.call("PATCH", staffUrl(w), { title: "x" }, b.jar)).status).toBe(400);
    expect((await b.h.call("PATCH", staffUrl(w), { title: "Another" }, b.coJar)).status).toBe(403);
    expect((await b.h.call("POST", staffUrl(w, "/notice"), {}, b.jar)).json.code).toBe("confirm");
    // no returning officer: no notice
    const none = await draft(await base({ voters: 6 }), { officials: { countingAgents: [{ email: "a@sample.example", name: "A" }] } });
    expect((await notice(none)).json.code).toBe("need_officer");
    // no final voter list: no notice
    const h = await makeHarness({ ELECTIONS_ENABLED: "1" }); const { jar, sid } = await newList(h);
    const c = await h.call("POST", `/api/lists/${sid}/elections`, { title: "Committee election", mode: "online", schedule: SCHED, posts: [{ title: "President", seats: 1 }], officials: OFFICIALS }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/elections/${c.json.election.id}/notice`, { confirm: "NOTICE" }, jar)).json.code).toBe("no_roll");
  });

  test("the notice links the final voter list, fixes the rules and shows them in plain words; a draft is not public", async () => {
    const b = await base({ voters: 6 }); const w = await draft(b);
    expect((await b.h.call("GET", voterUrl(w))).status).toBe(404); // a draft is not public
    expect((await b.h.call("GET", `/api/v/${b.slug}/elections`)).json.elections).toEqual([]);
    const n = await notice(w); expect(n.status).toBe(200);
    expect(n.json.election).toMatchObject({ status: "notice", roll: { fingerprint: b.fingerprint, voters: 6, publication: b.pubId }, rules: { fixed: true } });
    expect(n.json.mailed).toBe(false);
    const pub = await b.h.call("GET", voterUrl(w)); expect(pub.status).toBe(200);
    expect(pub.json.rules.words.join(" ")).toContain("final voter list"); expect(pub.json.rules.words.join(" ")).toContain("draw");
    expect(pub.json.officials.map((o: any) => o.role)).toEqual(["returning_officer", "counting_agent", "observer"]);
    expect(JSON.stringify(pub.json)).not.toContain("@sample.example"); // no e-mail ID on the public page
    expect(pub.json.candidates).toEqual([]); expect(pub.json.turnout).toBeNull();
    expect((await b.h.call("GET", `/api/v/${b.slug}/elections`)).json.elections.map((e: any) => e.status)).toEqual(["notice"]);
    expect((await notice(w)).status).toBe(409); // not twice
  });

  test("after the notice the rules are fixed, in the API and in the database", async () => {
    const b = await base({ voters: 6 }); const w = await draft(b); await notice(w);
    const p = await b.h.call("PATCH", staffUrl(w), { title: "Changed after notice" }, b.jar); expect(p.status).toBe(409); expect(p.json.code).toBe("frozen");
    const run = (sql: string, ...a: unknown[]) => () => b.h.raw.query(sql).run(...(a as never[]));
    expect(run("UPDATE el_elections SET title = 'Changed' WHERE id = ?", w.eid)).toThrow();
    expect(run("UPDATE el_elections SET mode = 'in_person' WHERE id = ?", w.eid)).toThrow();
    expect(run("UPDATE el_elections SET nota = 1 - nota WHERE id = ?", w.eid)).toThrow();
    expect(run("UPDATE el_elections SET voting_open_at = voting_open_at + 1 WHERE id = ?", w.eid)).toThrow();
    expect(run("UPDATE el_elections SET voting_close_at = voting_close_at - 1000 WHERE id = ?", w.eid)).toThrow(); // the end can move later, never earlier
    expect(run("UPDATE el_elections SET status = 'draft' WHERE id = ?", w.eid)).toThrow(); // only forward
    expect(run("DELETE FROM el_elections WHERE id = ?", w.eid)).toThrow();
    expect(run("DELETE FROM el_posts WHERE election_id = ?", w.eid)).toThrow();
    expect(run("UPDATE el_posts SET seats = 2 WHERE election_id = ?", w.eid)).toThrow();
    expect(run("INSERT INTO el_posts (id, election_id, n, title, seats, max_votes) VALUES ('x', ?, 9, 'Extra post', 1, 1)", w.eid)).toThrow();
    expect(run("DELETE FROM el_officials WHERE election_id = ?", w.eid)).toThrow();
    expect(run("INSERT INTO el_officials (election_id, email, role, name, added_at) VALUES (?, 'new@sample.example', 'observer', 'New', 1)", w.eid)).toThrow();
    expect(rows(b.h, "SELECT title FROM el_elections WHERE id = ?", w.eid)[0]).toEqual({ title: "Committee election 2027" });
  });

  test("weighted votes need online voting and groups of at least 5 voters with the same weight", async () => {
    const small = await base({ voters: 4 }); const ws = await draft(small, { weighting: "by_list" });
    const r = await notice(ws); expect(r.status).toBe(409); expect(r.json.code).toBe("weight_group"); // 4 voters share one weight: the weight could point at one person
    const ok = await base({ voters: 6 }); const wo = await draft(ok, { weighting: "by_list" });
    expect((await notice(wo)).status).toBe(200);
  });
});

describe("nominations", () => {
  test("they are taken only inside the nomination time, from people on the final voter list", async () => {
    const b = await base({ voters: 8 }); const w = await draft(b); await notice(w);
    expect((await nominate(w, 0, 0)).json.code).toBe("not_nomination_time"); // the clock is still before the opening time
    w.h.clock.now = at("2026-11-12T11:00");
    const stranger = await asMember(w, "stranger@sample.example");
    expect((await w.h.call("POST", voterUrl(w, "/nominations"), { postId: w.posts[0]!.id, proposerEmail: emailOf(1), seconderEmail: emailOf(2), declaration: "I am willing to serve." }, stranger)).json.code).toBe("not_on_roll");
    expect((await w.h.call("POST", voterUrl(w, "/nominations"), { postId: "nope" }, await asMember(w, emailOf(0)))).status).toBe(404);
    const ok = await nominate(w, 0, 0); expect(ok.status).toBe(201); expect(ok.json.nomination.status).toBe("submitted");
    expect((await nominate(w, 0, 0)).json.code).toBe("stands"); // the same person for the same post, twice
    expect((await nominate(w, 0, 1)).status).toBe(201); // another post is allowed
    w.h.clock.now = at("2026-11-14T18:30");
    expect((await nominate(w, 1, 0)).json.code).toBe("not_nomination_time");
    expect(rows(w.h, "SELECT COUNT(*) AS n FROM el_nominations")[0]).toEqual({ n: 2 });
  });

  test("a proposer and a seconder are needed, both on the list, and the words are checked", async () => {
    const b = await base({ voters: 8 }); const w = await draft(b); await notice(w); w.h.clock.now = at("2026-11-12T11:00");
    const bad: Array<[string, Record<string, unknown>]> = [
      ["proposer and seconder the same", { proposerEmail: emailOf(3), seconderEmail: emailOf(3) }], ["proposer is the candidate", { proposerEmail: emailOf(0) }],
      ["proposer not on the list", { proposerEmail: "outsider@sample.example" }], ["no seconder", { seconderEmail: "" }],
      ["declaration too short", { declaration: "ok" }], ["phone number in the statement", { statement: "Call me on 9876543210 for more." }], ["e-mail ID in the declaration", { declaration: "Write to someone@example.com for details." }],
    ];
    for (const [what, patch] of bad) { const r = await nominate(w, 0, 0, patch); expect([what, r.status]).toEqual([what, 400]); }
    expect(rows(w.h, "SELECT COUNT(*) AS n FROM el_nominations")[0]).toEqual({ n: 0 });
  });

  test("the returning officer, the other officials and the person who made the election cannot stand", async () => {
    const b = await base({ voters: 8, organizer: emailOf(0) }); // the Organizer is also voter 1
    const w = await draft(b, { officials: { returningOfficer: { email: RO, name: "Ravi Officer" }, countingAgents: [{ email: emailOf(7), name: "Hari Agent" }] } }); await notice(w); w.h.clock.now = at("2026-11-12T11:00");
    expect((await nominate(w, 7, 0)).json.code).toBe("is_official"); // a counting agent who is also on the list
    expect((await nominate(w, 0, 0)).json.code).toBe("is_creator");
    expect((await nominate(w, 1, 0)).status).toBe(201);
    // the second lock: the database refuses a nomination from an official even if the application is bypassed
    expect(() => b.h.raw.query("INSERT INTO el_nominations (id, election_id, post_id, roll_row_id, email, name, unit, proposer_roll_id, seconder_roll_id, declaration, submitted_at) VALUES ('n9', ?, ?, 1, ?, 'Hari', 'A-108', 2, 3, 'I am willing to serve.', 1)").run(w.eid, w.posts[0]!.id, emailOf(7))).toThrow();
  });
});

describe("scrutiny, appeals and withdrawal", () => {
  async function noticed(voters = 8) { const b = await base({ voters }); const w = await draft(b); await notice(w); w.h.clock.now = at("2026-11-12T11:00"); return w; }
  const decide = (w: Awaited<ReturnType<typeof noticed>>, jar: any, nid: string, body: Record<string, unknown>) => w.h.call("POST", voterUrl(w, `/nominations/${nid}/decide`), body, jar);

  test("only the returning officer decides; a rejection needs a reason and is final for the officer", async () => {
    const w = await noticed(); const nid = (await nominate(w, 0, 0)).json.nomination.id as string;
    w.h.clock.now = at("2026-11-13T10:00");
    const ro = await asMember(w, RO), agent = await asMember(w, "agent@sample.example"), observer = await asMember(w, "observer@sample.example"), voter = await asMember(w, emailOf(3));
    for (const jar of [agent, observer, voter]) expect((await decide(w, jar, nid, { decision: "accepted" })).status).toBe(403);
    expect((await decide(w, await w.h.staff("co@sample.example"), nid, { decision: "accepted" })).status).toBe(401); // a staff cookie is not the voter cookie
    expect((await decide(w, ro, nid, { decision: "rejected" })).json.code).toBe("need_reason");
    expect((await decide(w, ro, nid, { decision: "maybe" })).status).toBe(400);
    const r = await decide(w, ro, nid, { decision: "rejected", reason: "The proposer is not a voter of this society." }); expect(r.status).toBe(200);
    expect((await decide(w, ro, nid, { decision: "accepted" })).json.code).toBe("decided");
    const mine = await w.h.call("GET", voterUrl(w, "/my-nominations"), undefined, await asMember(w, emailOf(0)));
    expect(mine.json.nominations[0]).toMatchObject({ status: "rejected", decisionReason: "The proposer is not a voter of this society." });
    expect(mine.json.nominations[0].appealUntil).toBe(at("2026-11-13T10:00") + 24 * 3_600_000);
    // the official list hides the candidates' e-mail IDs from everyone but the returning officer
    const forObserver = await w.h.call("GET", voterUrl(w, "/nominations"), undefined, observer);
    expect(forObserver.json.nominations[0].email).toMatch(/^\*{8}/); expect((await w.h.call("GET", voterUrl(w, "/nominations"), undefined, voter)).status).toBe(403);
    expect((await w.h.call("GET", voterUrl(w, "/nominations"), undefined, ro)).json.nominations[0].email).toBe(emailOf(0));
  });

  test("a rejected candidate can appeal once, in time; a different person decides the appeal", async () => {
    const b = await base({ voters: 8 }); const w = await draft(b, { officials: { returningOfficer: { email: "organizer@sample.example", name: "The Organizer" } } }); await notice(w);
    w.h.clock.now = at("2026-11-12T11:00"); const nid = (await nominate(w, 0, 0)).json.nomination.id as string;
    w.h.clock.now = at("2026-11-13T10:00"); const ro = await asMember(w, "organizer@sample.example");
    await decide(w, ro, nid, { decision: "rejected", reason: "The seconder is not a voter of this society." });
    const me = await asMember(w, emailOf(0)), appeal = (text: unknown) => w.h.call("POST", voterUrl(w, `/nominations/${nid}/appeal`), { text }, me);
    expect((await appeal("no")).status).toBe(400);
    expect((await appeal("The seconder is a voter, see the final voter list.")).status).toBe(200);
    expect((await appeal("Please look again at the seconder.")).json.code).toBe("appeal_once");
    const url = staffUrl(w, `/nominations/${nid}/appeal/decide`);
    expect((await w.h.call("POST", url, { decision: "upheld", reason: "The seconder is on the list." }, b.coJar)).status).toBe(403); // a co-organizer cannot decide it
    // the Organizer is also the returning officer here, so the same person cannot decide the appeal
    expect((await w.h.call("POST", url, { decision: "upheld", reason: "The seconder is on the list." }, b.jar)).json.code).toBe("same_decider");
    // with another returning officer the Organizer can decide: upheld puts the nomination back as accepted
    const w2 = await noticed(); const n2 = (await nominate(w2, 0, 0)).json.nomination.id as string; w2.h.clock.now = at("2026-11-13T10:00");
    await decide(w2, await asMember(w2, RO), n2, { decision: "rejected", reason: "The seconder is not a voter of this society." });
    const me2 = await asMember(w2, emailOf(0));
    expect((await w2.h.call("POST", voterUrl(w2, `/nominations/${n2}/appeal`), { text: "The seconder is a voter, see the list." }, me2)).status).toBe(200);
    const up = await w2.h.call("POST", staffUrl(w2, `/nominations/${n2}/appeal/decide`), { decision: "upheld", reason: "The seconder is on the list." }, w2.jar);
    expect(up.status).toBe(200); expect(up.json.nomination).toMatchObject({ appeal: "upheld", status: "accepted" });
    expect(rows(w2.h, "SELECT status, appeal_status FROM el_nominations WHERE id = ?", n2)[0]).toEqual({ status: "accepted", appeal_status: "upheld" });
    // too late: an appeal after the appeal time is refused
    const w3 = await noticed(); const n3 = (await nominate(w3, 0, 0)).json.nomination.id as string; w3.h.clock.now = at("2026-11-13T10:00");
    await decide(w3, await asMember(w3, RO), n3, { decision: "rejected", reason: "The seconder is not a voter of this society." });
    w3.h.clock.now = at("2026-11-14T10:01");
    expect((await w3.h.call("POST", voterUrl(w3, `/nominations/${n3}/appeal`), { text: "The seconder is a voter, see the list." }, await asMember(w3, emailOf(0)))).json.code).toBe("appeal_closed");
  });

  test("a candidate can withdraw until the withdrawal time, not after", async () => {
    const w = await noticed(); const a = (await nominate(w, 0, 0)).json.nomination.id as string, b2 = (await nominate(w, 1, 0)).json.nomination.id as string;
    const me = await asMember(w, emailOf(0));
    expect((await w.h.call("POST", voterUrl(w, `/nominations/${b2}/withdraw`), {}, me)).status).toBe(404); // not their own nomination
    expect((await w.h.call("POST", voterUrl(w, `/nominations/${a}/withdraw`), {}, me)).json.nomination.status).toBe("withdrawn");
    expect((await w.h.call("POST", voterUrl(w, `/nominations/${a}/withdraw`), {}, me)).status).toBe(409);
    w.h.clock.now = at("2026-11-15T18:01");
    expect((await w.h.call("POST", voterUrl(w, `/nominations/${b2}/withdraw`), {}, await asMember(w, emailOf(1)))).json.code).toBe("withdrawal_closed");
  });

  test("the final candidate list waits for every decision, appeal and the withdrawal time, then fixes the list", async () => {
    const w = await noticed(); const nid = (await nominate(w, 0, 0)).json.nomination.id as string; await nominate(w, 1, 0); await nominate(w, 7, 2);
    const final = (confirm: unknown = "FINAL") => w.h.call("POST", staffUrl(w, "/candidates/final"), { confirm }, w.jar);
    expect((await final()).json.code).toBe("too_early"); // before the withdrawal time
    w.h.clock.now = at("2026-11-15T19:00");
    expect((await final("later")).json.code).toBe("confirm");
    expect((await final()).json.code).toBe("undecided");
    const ro = await asMember(w, RO);
    const list = (await w.h.call("GET", voterUrl(w, "/nominations"), undefined, ro)).json.nominations as any[];
    await decide(w, ro, nid, { decision: "rejected", reason: "The seconder is not a voter of this society." });
    for (const n of list) if (n.id !== nid) await decide(w, ro, n.id, { decision: "accepted" });
    expect((await final()).json.code).toBe("appeal_time"); // the rejected candidate may still appeal
    w.h.clock.now = at("2026-11-15T20:00");
    expect((await w.h.call("POST", voterUrl(w, `/nominations/${nid}/appeal`), { text: "The seconder is a voter, see the final voter list." }, await asMember(w, emailOf(0)))).status).toBe(200);
    expect((await final()).json.code).toBe("open_appeals");
    expect((await w.h.call("POST", staffUrl(w, `/nominations/${nid}/appeal/decide`), { decision: "dismissed", reason: "The seconder is not on the list." }, w.jar)).status).toBe(200);
    const done = await final(); expect(done.status).toBe(200);
    expect(done.json.election.status).toBe("candidates_final"); expect(done.json.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // one candidate was rejected and the appeal dismissed: the posts are decided by who is left
    expect(done.json.election.posts.map((p: any) => [p.title, p.kind])).toEqual([["President", "unopposed"], ["Committee member", "vacant"], ["Treasurer", "unopposed"], ["Secretary", "vacant"]]);
    expect((await final()).status).toBe(409); // not twice
  });

  test("the final list: posts become contested, unopposed or vacant, and the list has a fingerprint that is shown to everyone", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b)); await toFinal(w);
    const pub = await w.h.call("GET", voterUrl(w)); expect(pub.json.status).toBe("candidates_final");
    expect(pub.json.posts.map((p: any) => [p.title, p.kind])).toEqual([["President", "contested"], ["Committee member", "contested"], ["Treasurer", "unopposed"], ["Secretary", "vacant"]]);
    expect(pub.json.candidates.map((c: any) => c.name).sort()).toEqual(["Asha Sample", "Bharat Sample", "Chitra Sample", "Dev Sample", "Esha Sample", "Farid Sample", "Gita Sample", "Hari Sample"]);
    expect(pub.json.candidatesFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(pub.json.candidates)).not.toContain("@sample.example");
    expect((await nominate(w, 0, 3)).json.code).toBe("not_nomination_time"); // no new nominations after the list is final
    const trail = (await w.h.call("GET", voterUrl(w, "/trail"))).json.events.map((e: any) => e.type);
    expect(trail).toContain("election.notice"); expect(trail).toContain("election.candidates_final"); expect(trail.filter((t: string) => t === "election.nomination_decided")).toHaveLength(8);
    expect(cand(w, 0)).toMatch(/^nom_/);
  });
});
