// Elections: the voting time, one vote for one voter, the two-step code and ticket, the checks on a ballot, in-person modes and paper ballots.
import { describe, expect, test } from "bun:test";
import { OBSERVER, RO, SCHED, asMember, at, base, cand, castAs, draft, emailOf, pick, staffUrl, toFinal, toVoting, voterUrl, standardVotes, type World } from "./elections-world";

const q = (w: World, sql: string, ...a: unknown[]) => w.h.raw.query(sql).all(...(a as never[])) as any[];
const RECEIPT = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
async function voting() { const w = await base({ voters: 8 }).then((b) => draft(b)); await toVoting(w); return w; }

describe("the voting time", () => {
  test("opening needs the word OPEN and a final list; votes are taken only between the opening and closing times", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b));
    expect((await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar)).json.code).toBe("bad_status"); // no final list yet
    await toFinal(w);
    expect((await w.h.call("POST", staffUrl(w, "/open"), {}, w.jar)).json.code).toBe("confirm");
    expect((await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.coJar)).status).toBe(403);
    w.h.clock.now = at("2026-11-16T10:00");
    expect((await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar)).json.election.status).toBe("voting");
    const me = emailOf(0);
    expect((await castAs(w, me, {})).sent.json.code).toBe("too_early"); // open, but the voting time has not come
    w.h.clock.now = at("2026-11-20T08:59"); expect((await castAs(w, me, {})).sent.json.code).toBe("too_early");
    w.h.clock.now = at("2026-11-20T09:30"); expect((await castAs(w, me, pick(w, { 1: [1], 2: [3] }))).vote.status).toBe(201);
    w.h.clock.now = at("2026-11-20T18:00"); expect((await castAs(w, emailOf(1), {})).sent.json.code).toBe("too_late"); // the closing time itself is already too late
  });

  test("the voting time can be made longer with a written reason, never shorter; closing early needs a reason too", async () => {
    const w = await voting(); const ext = (body: Record<string, unknown>, jar = w.jar) => w.h.call("POST", staffUrl(w, "/extend"), body, jar);
    expect((await ext({ until: "2026-11-20T20:00", reason: "Many people could not sign in." }, w.coJar)).status).toBe(403);
    expect((await ext({ until: "2026-11-20T17:00", reason: "Make it shorter please." })).json.code).toBe("bad_until");
    expect((await ext({ until: "2026-11-23T20:00", reason: "Make it much longer please." })).json.code).toBe("bad_until"); // more than 48 hours
    expect((await ext({ until: "2026-11-20T20:00", reason: "short" })).json.code).toBe("need_reason");
    const ok = await ext({ until: "2026-11-20T20:00", reason: "Many people could not sign in." }); expect(ok.status).toBe(200); expect(ok.json.election.schedule.votingClose).toBe("2026-11-20T20:00");
    const trail = (await w.h.call("GET", voterUrl(w, "/trail"))).json.events.find((e: any) => e.type === "election.voting_extended");
    expect(trail.summary).toContain("Many people could not sign in."); // everyone can read why
    w.h.clock.now = at("2026-11-20T19:00"); expect((await castAs(w, emailOf(0), pick(w, { 1: [1] }))).vote.status).toBe(201); // after the old end, before the new one
    const close = (body: Record<string, unknown>) => w.h.call("POST", staffUrl(w, "/close"), body, w.jar);
    expect((await close({})).json.code).toBe("confirm");
    expect((await close({ confirm: "CLOSE" })).json.code).toBe("need_reason"); // before the stated time
    expect((await close({ confirm: "CLOSE", reason: "Everyone on the list has voted." })).json.election.status).toBe("closed");
    expect((await castAs(w, emailOf(1), {})).sent.json.code).toBe("too_late");
    expect((await ext({ until: "2026-11-20T21:00", reason: "Another extension please." })).json.code).toBe("bad_status");
  });
});

describe("one voter, one vote", () => {
  test("a vote is a code, a ticket and a ballot; the answer carries a receipt and nothing about the choice", async () => {
    const w = await voting(); const votes = await standardVotes(w);
    for (const v of votes) { expect(v.vote.json.receipt).toMatch(RECEIPT); expect(JSON.stringify(v.vote.json)).not.toMatch(/nom_/); expect(Object.keys(v.vote.json).sort()).toEqual(["note", "receipt", "voted"]); }
    expect(new Set(votes.map((v) => v.vote.json.receipt)).size).toBe(7);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_voted")[0]).toEqual({ n: 7 }); expect(q(w, "SELECT COUNT(*) AS n FROM el_receipts")[0]).toEqual({ n: 7 });
    expect(q(w, "SELECT COUNT(*) AS n FROM el_ballots")[0]).toEqual({ n: 14 }); // one ballot for each of the 2 contested posts, blank or not
    const me = await w.h.call("GET", voterUrl(w, "/me"), undefined, votes[0]!.jar);
    expect(me.json).toMatchObject({ onList: true, canVoteNow: true, units: [{ unit: "A-101", voted: true, channel: "online" }] });
    expect(JSON.stringify(me.json)).not.toMatch(/nom_/);
    const open = await w.h.call("GET", voterUrl(w, "/me"), undefined, await asMember(w, emailOf(7))); expect(open.json.units[0].voted).toBe(false); // the eighth voter has not voted
    expect(q(w, "SELECT type FROM audit_entries WHERE type = 'election.vote_cast'")).toHaveLength(7);
  });

  test("a second vote is refused: at the code, at the ticket, and by the database", async () => {
    const w = await voting(); const email = emailOf(0); const jar = await asMember(w, email); const call = (p: string, b: unknown) => w.h.call("POST", voterUrl(w, p), b, jar);
    // two tickets before the first vote (two codes asked for)
    expect((await call("/ballot-code", {})).status).toBe(200); const t1 = (await call("/ballot", { code: w.h.code(email) })).json.ticket;
    expect((await call("/ballot-code", {})).status).toBe(200); const t2 = (await call("/ballot", { code: w.h.code(email) })).json.ticket;
    expect(t1).not.toBe(t2);
    expect((await call("/vote", { ticket: t1, choices: pick(w, { 1: [1] }) })).status).toBe(201);
    expect((await call("/vote", { ticket: t2, choices: pick(w, { 1: [2] }) })).json.code).toBe("already_voted");
    expect((await call("/vote", { ticket: t1, choices: pick(w, { 1: [2] }) })).json.code).toBe("bad_ticket"); // a ticket works once
    expect((await call("/ballot-code", {})).json.code).toBe("already_voted");
    expect(q(w, "SELECT COUNT(*) AS n FROM el_voted")[0]).toEqual({ n: 1 }); expect(q(w, "SELECT COUNT(*) AS n FROM el_ballots")[0]).toEqual({ n: 2 });
    const row = q(w, "SELECT roll_row_id FROM el_voted")[0].roll_row_id;
    expect(() => w.h.raw.query("INSERT INTO el_voted (election_id, roll_row_id, channel, by_pid, voted_at) VALUES (?, ?, 'online', 'p_x', 1)").run(w.eid, row)).toThrow(); // the primary key
    for (const sql of ["UPDATE el_voted SET channel = 'paper'", "DELETE FROM el_voted", "UPDATE el_ballots SET weight_milli = 5", "DELETE FROM el_ballots", "UPDATE el_receipts SET receipt_hash = 'x'", "DELETE FROM el_receipts"]) expect(() => w.h.raw.query(sql).run()).toThrow();
  });

  test("only people on the final voter list get a ballot; wrong, used and old codes and tickets are refused", async () => {
    const w = await voting(); const url = (p: string) => voterUrl(w, p);
    const stranger = await asMember(w, "stranger@sample.example");
    expect((await w.h.call("POST", url("/ballot-code"), {}, stranger)).json.code).toBe("not_on_roll");
    expect((await w.h.call("POST", url("/ballot"), { code: "123456" }, stranger)).json.code).toBe("not_on_roll");
    expect((await w.h.call("POST", url("/ballot-code"), {})).status).toBe(401); // not signed in
    const me = emailOf(0), jar = await asMember(w, me);
    expect((await w.h.call("POST", url("/ballot"), { code: "123456" }, jar)).json.code).toBe("bad_code"); // no code was asked for
    await w.h.call("POST", url("/ballot-code"), {}, jar); const code = w.h.code(me);
    expect((await w.h.call("POST", url("/ballot"), { code: code === "000000" ? "000001" : "000000" }, jar)).json.code).toBe("bad_code");
    expect((await w.h.call("POST", url("/ballot"), { code: "12ab56" }, jar)).json.code).toBe("bad_code");
    const opened = await w.h.call("POST", url("/ballot"), { code }, jar); expect(opened.status).toBe(200); expect(opened.json.ticket).toMatch(/^[0-9a-f]{32}$/);
    expect((await w.h.call("POST", url("/ballot"), { code }, jar)).json.code).toBe("bad_code"); // a code works once
    // a ticket belongs to the voter it was given to
    const other = await asMember(w, emailOf(1));
    expect((await w.h.call("POST", url("/vote"), { ticket: opened.json.ticket, choices: {} }, other)).json.code).toBe("not_on_roll");
    expect((await w.h.call("POST", url("/vote"), { ticket: "0".repeat(32), choices: {} }, jar)).json.code).toBe("bad_ticket");
    expect((await w.h.call("POST", url("/vote"), { ticket: "short", choices: {} }, jar)).json.code).toBe("bad_ticket");
    // an old ticket: 15 minutes
    w.h.clock.now += 16 * 60_000;
    expect((await w.h.call("POST", url("/vote"), { ticket: opened.json.ticket, choices: {} }, jar)).json.code).toBe("bad_ticket");
    expect((await w.h.call("POST", url("/ballot"), { code }, jar)).json.code).toBe("bad_code"); // and the code is old too
    expect(q(w, "SELECT COUNT(*) AS n FROM el_voted")[0]).toEqual({ n: 0 });
  });

  test("the ballot is checked: unknown posts and people, too many choices, repeats and none-of-the-above rules", async () => {
    const w = await voting(); const me = emailOf(0), jar = await asMember(w, me);
    await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar);
    const opened = await w.h.call("POST", voterUrl(w, "/ballot"), { code: w.h.code(me) }, jar); const ticket = opened.json.ticket;
    expect(opened.json.ballot.posts.map((p: any) => [p.title, p.vote, p.candidates.length])).toEqual([["President", true, 3], ["Committee member", true, 4], ["Treasurer", false, 1], ["Secretary", false, 0]]);
    const vote = (choices: unknown) => w.h.call("POST", voterUrl(w, "/vote"), { ticket, choices }, jar);
    const [p1, p2, p3] = [w.posts[0]!.id, w.posts[1]!.id, w.posts[2]!.id];
    const refused: Array<[string, unknown, string]> = [
      ["no choices at all", undefined, "bad_choices"], ["a list instead of an object", [], "bad_choices"], ["a post that is not on the ballot", { nope: [] }, "unknown_post"], ["a post nobody votes on", { [p3]: [cand(w, 7)] }, "unknown_post"],
      ["a person of another post", { [p1]: [cand(w, 3)] }, "unknown_candidate"], ["two people for a one-seat post", { [p1]: [cand(w, 0), cand(w, 1)] }, "too_many_votes"],
      ["three people for a two-vote post", { [p2]: [cand(w, 3), cand(w, 4), cand(w, 5)] }, "too_many_votes"], ["the same person twice", { [p2]: [cand(w, 3), cand(w, 3)] }, "same_candidate"],
      ["none of the above with a person", { [p1]: ["NOTA", cand(w, 0)] }, "nota_alone"], ["not a list", { [p1]: cand(w, 0) }, "bad_choices"], ["a number as a choice", { [p1]: [5] }, "bad_choices"],
    ];
    for (const [what, choices, code] of refused) { const r = await vote(choices); expect([what, r.status, r.json.code]).toEqual([what, 400, code]); }
    expect(q(w, "SELECT COUNT(*) AS n FROM el_voted")[0]).toEqual({ n: 0 }); // nothing was written, and the ticket is still good
    expect((await vote({ [p1]: [cand(w, 0)], [p2]: ["NOTA"] })).status).toBe(201);
    // an election without none-of-the-above refuses it
    const w2 = await base({ voters: 8 }).then((b) => draft(b, { nota: false })); await toVoting(w2);
    const r2 = await castAs(w2, emailOf(0), { [w2.posts[0]!.id]: ["NOTA"] }); expect(r2.vote.json.code).toBe("nota_off");
  });

  test("an in-person election takes no online votes", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b, { mode: "in_person" })); await toVoting(w);
    expect((await castAs(w, emailOf(0), {})).sent.json.code).toBe("not_online");
    expect((await w.h.call("POST", voterUrl(w, "/ballot"), { code: "123456" }, await asMember(w, emailOf(0)))).json.code).toBe("not_online");
    expect((await w.h.call("GET", voterUrl(w, "/me"), undefined, await asMember(w, emailOf(0)))).json.canVoteNow).toBe(false);
  });

  test("the ballot code mail is the only mail a vote needs, and a code is never kept in the outbox once mail is real", async () => {
    const w = await voting(); await castAs(w, emailOf(0), pick(w, { 1: [1] }));
    const mail = q(w, "SELECT kind, subject FROM mail_outbox WHERE kind = 'otp-vote'"); expect(mail).toHaveLength(1); expect(mail[0].subject).toContain("Voting code");
    const all = q(w, "SELECT body FROM mail_outbox WHERE kind = 'otp-vote'").map((m) => m.body).join(" ");
    expect(all).not.toMatch(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/); // no receipt is ever mailed
  });
});

describe("paper ballots and the attendance link", () => {
  async function mixed(extra: Record<string, unknown> = {}) { const b = await base({ voters: 8 }); const w = await draft(b, { mode: "mixed", body: extra }); await toVoting(w); return { w, b }; }
  const find = async (w: World, jar: any, text: string) => (await w.h.call("GET", voterUrl(w, `/roll?find=${encodeURIComponent(text)}`), undefined, jar));

  test("the returning officer or a counting agent gives a paper ballot; it counts as the voter's one vote", async () => {
    const { w } = await mixed(); const ro = await asMember(w, RO), observer = await asMember(w, OBSERVER), voter = await asMember(w, emailOf(2));
    const f = await find(w, ro, "A-108"); expect(f.json.people).toEqual([{ rollId: expect.any(Number), unit: "A-108", name: "Hari Sample", voted: false }]);
    const id = f.json.people[0].rollId; const issue = (jar: any, rollId: unknown = id) => w.h.call("POST", voterUrl(w, "/paper/issue"), { rollId }, jar);
    expect((await issue(observer)).status).toBe(403); expect((await issue(voter)).status).toBe(403); expect((await find(w, observer, "A-1")).status).toBe(403);
    expect((await issue(ro, "x")).json.code).toBe("bad_roll_id"); expect((await issue(ro, 99999)).status).toBe(404);
    const ok = await issue(ro); expect(ok.status).toBe(201); expect(ok.json).toEqual({ issued: true, paperBallotsGiven: 1 });
    expect((await issue(await asMember(w, "agent@sample.example"))).json.code).toBe("already_voted");
    expect((await find(w, ro, "hari")).json.people[0].voted).toBe(true);
    expect((await castAs(w, emailOf(7), {})).sent.json.code).toBe("already_voted"); // a person with a paper ballot cannot also vote online
    expect(q(w, "SELECT channel FROM el_voted")).toEqual([{ channel: "paper" }]);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_ballots")[0]).toEqual({ n: 0 }); // a paper ballot makes no online ballot
    const mine = await w.h.call("GET", voterUrl(w, "/me"), undefined, await asMember(w, emailOf(7))); expect(mine.json.units[0]).toMatchObject({ voted: true, channel: "paper" });
  });

  test("paper ballots are for in-person, offline and mixed elections only, and need the attendance mark when a session is named", async () => {
    const online = await base({ voters: 8 }).then((b) => draft(b)); await toVoting(online);
    expect((await online.h.call("POST", voterUrl(online, "/paper/issue"), { rollId: 1 }, await asMember(online, RO))).json.code).toBe("no_paper");
    const b = await base({ voters: 8 });
    const s = await b.h.call("POST", `/api/lists/${b.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode: "in_person" }, b.jar); expect(s.status).toBe(201);
    const aid = s.json.session.id as string;
    const w = await draft(b, { mode: "in_person", body: { attendanceSessionId: aid } }); await toVoting(w);
    const ro = await asMember(w, RO); const hari = (await find(w, ro, "A-108")).json.people[0].rollId;
    expect((await w.h.call("POST", voterUrl(w, "/paper/issue"), { rollId: hari }, ro)).json.code).toBe("not_present"); // not marked present
    const sheet = await w.h.call("GET", `/api/lists/${w.sid}/attendance/sessions/${aid}?find=A-108`, undefined, w.jar); expect(sheet.status).toBe(200);
    const vid = sheet.json.people[0].voterId as string;
    expect((await w.h.call("POST", `/api/lists/${w.sid}/attendance/sessions/${aid}/mark`, { voterId: vid }, w.coJar)).status).toBe(200);
    expect((await w.h.call("POST", voterUrl(w, "/paper/issue"), { rollId: hari }, ro)).status).toBe(201);
    // the link is read only: Attendance was not changed by the election
    expect(q(w, "SELECT COUNT(*) AS n FROM att_marks")[0]).toEqual({ n: 1 });
    // an attendance session of another list cannot be named
    const other = await base({ voters: 6 }); const s2 = await other.h.call("POST", `/api/lists/${other.sid}/attendance/sessions`, { title: "Other meeting", startsAt: "2026-12-05T18:00", mode: "online" }, other.jar);
    const bad = await w.h.call("POST", `/api/lists/${w.sid}/elections`, { title: "Another election", mode: "mixed", schedule: SCHED, posts: [{ title: "Chair", seats: 1 }], attendanceSessionId: s2.json.session.id }, w.jar);
    expect([bad.status, bad.json.code]).toEqual([400, "bad_attendance"]);
  });
});
