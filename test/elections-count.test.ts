// Elections: the count, recounts, paper counts, the draw for a tie, challenges, the declaration, the public report, a changed box, and erasure.
import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/vendor/crypto";
import { AGENT, OBSERVER, RO, asMember, at, base, cand, castAs, closeAndCount, draft, emailOf, pick, staffUrl, toVoting, voterUrl, standardVotes, type World } from "./elections-world";

const q = (w: World, sql: string, ...a: unknown[]) => w.h.raw.query(sql).all(...(a as never[])) as any[];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?<!\d)\d{10}(?!\d)/; // checked after long hex runs and epoch times are taken out, so a fingerprint can never look like a phone number
const scrub = (t: string) => t.replace(/[0-9a-f]{12,}/gi, "#");
const by = (r: any[]) => Object.fromEntries(r.map((x) => [x.title, x])) as Record<string, any>;

async function story(o: { mode?: string; env?: Record<string, string> } = {}) { const w = await base({ voters: 8, env: o.env }).then((b) => draft(b, { mode: o.mode })); await toVoting(w); return w; }
/** Several people vote; throws at the first refusal so a test never runs on a half-made box. */
async function castAll(w: World, votes: Array<Record<number, Array<number | "NOTA">>>) {
  for (let i = 0; i < votes.length; i++) { const r = await castAs(w, emailOf(i), pick(w, votes[i]!)); if (r.vote?.status !== 201) throw new Error(`vote ${i} failed ` + JSON.stringify(r.vote?.json ?? r.opened?.json ?? r.sent?.json)); }
}
async function closeOnly(w: World) {
  w.h.clock.now = at("2026-11-20T18:05");
  const c = await w.h.call("POST", staffUrl(w, "/close"), { confirm: "CLOSE" }, w.jar); if (c.status !== 200) throw new Error("close failed " + c.text);
  return asMember(w, RO);
}
const countAs = (w: World, jar: any, body: unknown = {}) => w.h.call("POST", voterUrl(w, "/count"), body, jar);
/** The count is done and the challenge time (24 hours) is over. */
async function counted(w: World, paper?: unknown) { const r = await closeAndCount(w, paper); if (r.count.status !== 201) throw new Error("count failed " + r.count.text); return r; }
const afterChallengeTime = (w: World) => { w.h.clock.now = at("2026-11-21T18:06"); };

describe("who may count, and when", () => {
  test("nothing is added up before the voting has closed; only the returning officer and the counting agents count", async () => {
    const w = await story(); await standardVotes(w);
    const ro = await asMember(w, RO), agent = await asMember(w, AGENT), observer = await asMember(w, OBSERVER), voter = await asMember(w, emailOf(0));
    // while the box is open: no count, no results, no report, for any person
    for (const jar of [ro, agent, observer, voter]) expect([(await countAs(w, jar)).status, (await countAs(w, jar)).json.code]).toEqual([jar === voter || jar === observer ? 403 : 409, jar === voter || jar === observer ? "forbidden" : "not_closed"]);
    for (const jar of [ro, agent, observer]) expect((await w.h.call("GET", voterUrl(w, "/count"), undefined, jar)).json.code).toBe("results_locked");
    for (const p of ["/results", "/report", "/challenges"]) expect((await w.h.call("GET", voterUrl(w, p))).json.code).toBe("results_locked");
    expect(q(w, "SELECT COUNT(*) AS n FROM el_counts")[0]).toEqual({ n: 0 });
    // closed (a member's sign-in lasts 8 hours, so each person signs in again): only the team may count
    await closeOnly(w);
    const observer2 = await asMember(w, OBSERVER), voter2 = await asMember(w, emailOf(0)), ro2 = await asMember(w, RO), agent2 = await asMember(w, AGENT);
    expect((await countAs(w, observer2)).status).toBe(403); expect((await countAs(w, voter2)).status).toBe(403); expect((await countAs(w, {})).status).toBe(401);
    expect((await w.h.call("GET", voterUrl(w, "/count"), undefined, ro2)).json.code).toBe("no_count"); // closed but not counted yet
    const first = await countAs(w, agent2); expect(first.status).toBe(201); expect(first.json).toMatchObject({ count: 1, kind: "first", reconciled: true, problems: [] });
    expect((await w.h.call("POST", voterUrl(w, "/declare"), { confirm: "DECLARE" }, agent2)).status).toBe(403); // a counting agent counts; only the returning officer declares
    expect((await w.h.call("GET", voterUrl(w, "/count"), undefined, observer2)).status).toBe(200); // everyone named for the election may read the count
    expect((await w.h.call("GET", voterUrl(w, "/count"), undefined, voter2)).status).toBe(403);
  });
});

describe("the count", () => {
  test("the standard story adds up: every vote, every blank, none of the above, unopposed and vacant posts", async () => {
    const w = await story(); await standardVotes(w); const { count } = await closeAndCount(w);
    expect(count.status).toBe(201); expect(count.json.fingerprint).toMatch(/^[0-9a-f]{64}$/); expect(count.json.reconciled).toBe(true);
    const r = by(count.json.result);
    expect(r["President"]).toMatchObject({ seats: 1, kind: "contested", ballots: 7, blank: 1, invalid: 0, noneOfTheAbove: 1, elected: [cand(w, 1)] });
    expect(r["President"].candidates.map((c: any) => [c.name, c.votes, c.elected, c.rank])).toEqual([["Bharat Sample", 3, true, 1], ["Asha Sample", 2, false, 2], ["Chitra Sample", 0, false, 3]]);
    expect(r["Committee member"]).toMatchObject({ seats: 2, ballots: 7, blank: 1, invalid: 0, noneOfTheAbove: 0, draw: null });
    expect(r["Committee member"].candidates.map((c: any) => [c.name, c.votes, c.elected])).toEqual([["Dev Sample", 4, true], ["Esha Sample", 3, true], ["Farid Sample", 2, false], ["Gita Sample", 1, false]]);
    expect([...r["Committee member"].elected].sort()).toEqual([cand(w, 3), cand(w, 4)].sort());
    expect(r["Treasurer"]).toMatchObject({ kind: "unopposed", ballots: 0, elected: [cand(w, 7)] }); expect(r["Treasurer"].candidates.map((c: any) => c.elected)).toEqual([true]);
    expect(r["Secretary"]).toMatchObject({ kind: "vacant", elected: [], candidates: [] });
    const view = (await w.h.call("GET", voterUrl(w, "/count"), undefined, await asMember(w, RO))).json;
    expect(view).toMatchObject({ count: 1, kind: "first", fingerprint: count.json.fingerprint, reconciled: true, turnout: { online: 7, paper: 0, eligible: 8 } });
    expect(view.reconciliation).toMatchObject({ ok: true, problems: [], facts: { onlineVoters: 7, paperVoters: 0, rollVoters: 8, receipts: 7, chainVotes: 7, chainPaper: 0 } });
    expect(view.result).toEqual(count.json.result);
    expect(q(w, "SELECT status FROM el_elections")[0]).toEqual({ status: "counted" });
    expect(q(w, "SELECT type FROM audit_entries WHERE type = 'election.counted'")).toHaveLength(1);
    // the signed trail of the count carries the fingerprint and no tally
    const entry = q(w, "SELECT entry_json FROM audit_entries WHERE type = 'election.counted'")[0].entry_json as string;
    expect(entry).toContain(count.json.fingerprint); for (const bad of ["Bharat", "votes", cand(w, 1)]) expect(entry).not.toContain(bad);
  });

  test("a recount needs a written reason, keeps the first count, and gives the same numbers for the same box", async () => {
    const w = await story(); await standardVotes(w); const { ro, count } = await closeAndCount(w);
    expect((await countAs(w, ro)).json.code).toBe("need_reason");
    expect((await countAs(w, ro, { reason: "short" })).json.code).toBe("need_reason");
    expect((await countAs(w, ro, { reason: "Please call 9876543210 to check." })).status).toBe(400); // a reason is read by everyone: no contact details
    const again = await countAs(w, ro, { reason: "A voter asked for the count to be checked." });
    expect(again.status).toBe(201); expect(again.json).toMatchObject({ count: 2, kind: "recount", reconciled: true, fingerprint: count.json.fingerprint }); expect(again.json.result).toEqual(count.json.result);
    const view = (await w.h.call("GET", voterUrl(w, "/count"), undefined, ro)).json;
    expect(view.counts.map((c: any) => [c.count, c.kind, c.reconciled])).toEqual([[1, "first", true], [2, "recount", true]]); expect(view.counts[1].reason).toBe("A voter asked for the count to be checked.");
    expect(q(w, "SELECT count_no, kind FROM el_counts ORDER BY count_no")).toEqual([{ count_no: 1, kind: "first" }, { count_no: 2, kind: "recount" }]);
    for (const sql of ["UPDATE el_counts SET fingerprint = 'x'", "DELETE FROM el_counts"]) expect(() => w.h.raw.query(sql).run()).toThrow(); // a count is never changed
    const trail = (await w.h.call("GET", voterUrl(w, "/trail"))).json.events.map((e: any) => e.type);
    expect(trail).toContain("election.counted"); expect(trail).toContain("election.recounted");
  });

  test("a tie is settled by a draw that anyone can repeat from the public facts", async () => {
    const w = await story();
    await castAll(w, [{ 1: [0], 2: [3, 4] }, { 1: [0], 2: [3, 4] }, { 1: [1], 2: [3, 5] }, { 1: [1], 2: [3] }, { 1: [2], 2: [4] }, { 1: [], 2: [5] }, { 1: [], 2: [6] }]);
    const { ro, count } = await closeAndCount(w); const r = by(count.json.result);
    const p1 = r["President"]; expect(p1.draw).not.toBeNull(); expect(r["Committee member"].draw).toBeNull();
    expect(p1.candidates.map((c: any) => [c.name, c.votes, c.tied])).toEqual([["Asha Sample", 2, true], ["Bharat Sample", 2, true], ["Chitra Sample", 1, false]]);
    expect(p1.elected).toHaveLength(1); expect(p1.draw.tied).toEqual([cand(w, 0), cand(w, 1)].sort()); expect(p1.draw.places).toBe(1);
    // anyone can recompute the draw: the box fingerprint comes from the ballot ids and the register, the candidates fingerprint is public
    const ids = q(w, "SELECT id FROM el_ballots ORDER BY id").map((x) => x.id as string);
    const reg = q(w, "SELECT roll_row_id, channel FROM el_voted ORDER BY roll_row_id").map((x) => `${x.roll_row_id}:${x.channel}`);
    const box = await sha256Hex("election-box/v1\n" + ids.join(",") + "\n" + reg.join(","));
    const view = (await w.h.call("GET", voterUrl(w, "/count"), undefined, ro)).json; expect(view.box).toBe(box);
    const pub = (await w.h.call("GET", voterUrl(w))).json; expect(pub.candidatesFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const seed = await sha256Hex(["election-draw/v1", w.eid, pub.candidatesFingerprint, box, w.posts[0]!.id].join("|")); expect(p1.draw.seed).toBe(seed);
    const keyed = await Promise.all(p1.draw.tied.map(async (id: string) => ({ id, k: await sha256Hex(`${seed}|${id}`) })));
    keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    expect(p1.draw.order).toEqual(keyed.map((x: any) => x.id)); expect(p1.elected).toEqual([keyed[0]!.id]);
    // the draw does not change when the same box is counted again
    const again = await countAs(w, ro, { reason: "Counted again to check the draw." }); expect(again.json.fingerprint).toBe(count.json.fingerprint); expect(by(again.json.result)["President"].draw).toEqual(p1.draw);
  });
});

describe("paper ballots are counted by hand and typed in", () => {
  async function paperWorld() {
    const w = await story({ mode: "mixed" }); const ro = await asMember(w, RO);
    for (const flat of ["A-107", "A-108"]) { const id = (await w.h.call("GET", voterUrl(w, `/roll?find=${flat}`), undefined, ro)).json.people[0].rollId; expect((await w.h.call("POST", voterUrl(w, "/paper/issue"), { rollId: id }, ro)).status).toBe(201); }
    await castAll(w, [{ 1: [1], 2: [3, 4] }, { 1: [1], 2: [3] }, { 1: [0], 2: [] }, { 1: [], 2: [4] }]);
    return w;
  }
  const P = (w: World, c: Record<string, unknown>) => ({ [w.posts[0]!.id]: { ballots: 2, blank: 1, invalid: 0, nota: 0, candidates: { [cand(w, 1)]: 1 } }, [w.posts[1]!.id]: { ballots: 2, blank: 0, invalid: 0, nota: 0, candidates: { [cand(w, 3)]: 2, [cand(w, 4)]: 1 } }, ...c });

  test("the paper numbers are checked before they are stored; right numbers are added to the online votes", async () => {
    const w = await paperWorld(); const ro = await closeOnly(w); const [p1, p2] = [w.posts[0]!.id, w.posts[1]!.id];
    const refused: Array<[string, unknown, number, string]> = [
      ["none typed in", undefined, 400, "bad_paper"], ["an empty list", {}, 400, "bad_paper"], ["a text", "two", 400, "bad_paper"], ["one post missing", { [p1]: P(w, {})[p1] }, 400, "bad_paper"],
      ["a post that is not voted on", P(w, { [w.posts[2]!.id]: { ballots: 2, blank: 2, invalid: 0, nota: 0, candidates: {} } }), 400, "unknown_post"],
      ["the wrong number of ballots", P(w, { [p1]: { ballots: 3, blank: 1, invalid: 0, nota: 0, candidates: { [cand(w, 1)]: 2 } } }), 400, "paper_totals"],
      ["a person who is not a candidate", P(w, { [p1]: { ballots: 2, blank: 1, invalid: 0, nota: 0, candidates: { [cand(w, 7)]: 1 } } }), 400, "unknown_candidate"],
      ["marks that do not fit the ballots", P(w, { [p1]: { ballots: 2, blank: 0, invalid: 0, nota: 0, candidates: { [cand(w, 1)]: 1 } } }), 400, "paper_inner"],
      ["more marks than a two-vote post allows", P(w, { [p2]: { ballots: 2, blank: 0, invalid: 0, nota: 0, candidates: { [cand(w, 3)]: 3, [cand(w, 4)]: 2 } } }), 400, "paper_inner"],
      ["a negative number", P(w, { [p1]: { ballots: 2, blank: -1, invalid: 0, nota: 0, candidates: { [cand(w, 1)]: 3 } } }), 400, "bad_paper"],
    ];
    for (const [what, paper, status, code] of refused) { const r = await countAs(w, ro, paper === undefined ? {} : { paper }); expect([what, r.status, r.json.code]).toEqual([what, status, code]); }
    expect(q(w, "SELECT COUNT(*) AS n FROM el_counts")[0]).toEqual({ n: 0 });
    const ok = await countAs(w, ro, { paper: P(w, {}) }); expect(ok.status).toBe(201); expect(ok.json).toMatchObject({ reconciled: true, problems: [] });
    const r = by(ok.json.result);
    expect(r["President"]).toMatchObject({ ballots: 6, blank: 2, noneOfTheAbove: 0 }); expect(r["President"].candidates.map((c: any) => [c.name, c.votes])).toEqual([["Bharat Sample", 3], ["Asha Sample", 1], ["Chitra Sample", 0]]);
    expect(r["Committee member"]).toMatchObject({ ballots: 6, blank: 1 }); expect(r["Committee member"].candidates.map((c: any) => [c.name, c.votes])).toEqual([["Dev Sample", 4], ["Esha Sample", 3], ["Farid Sample", 0], ["Gita Sample", 0]]);
    const view = (await w.h.call("GET", voterUrl(w, "/count"), undefined, ro)).json; expect(view.turnout).toEqual({ online: 4, paper: 2, eligible: 8 });
    // a recount without new numbers uses the paper numbers already stored; with a corrected paper number it is a different count and the first one stays
    const same = await countAs(w, ro, { reason: "Counted again with the same paper numbers." }); expect(same.json.fingerprint).toBe(ok.json.fingerprint);
    const fixed = await countAs(w, ro, { reason: "A paper number was typed wrongly.", paper: P(w, { [p1]: { ballots: 2, blank: 0, invalid: 0, nota: 0, candidates: { [cand(w, 1)]: 1, [cand(w, 0)]: 1 } } }) });
    expect(fixed.status).toBe(201); expect(fixed.json.fingerprint).not.toBe(ok.json.fingerprint); expect(q(w, "SELECT COUNT(*) AS n FROM el_counts")[0]).toEqual({ n: 3 });
  });

  test("paper numbers are refused when no paper ballot was given out", async () => {
    const w = await story(); await standardVotes(w); const ro = await closeOnly(w);
    const r = await countAs(w, ro, { paper: { [w.posts[0]!.id]: { ballots: 1, blank: 1, invalid: 0, nota: 0, candidates: {} } } }); expect([r.status, r.json.code]).toEqual([400, "no_paper"]);
    expect((await countAs(w, ro, { paper: {} })).status).toBe(201);
  });
});

describe("challenges and the declaration", () => {
  test("a challenge comes only from the final voter list, in the challenge time, with no contact details; only the returning officer answers", async () => {
    const w = await story(); await standardVotes(w); const { ro } = await counted(w);
    const url = voterUrl(w, "/challenges"), file = (jar: any, text: unknown) => w.h.call("POST", url, { text }, jar);
    const stranger = await asMember(w, "stranger@sample.example"), voter = await asMember(w, emailOf(2));
    expect([(await file(stranger, "I think the count is wrong in one post.")).status, (await file(stranger, "I think the count is wrong in one post.")).json.code]).toEqual([403, "not_on_roll"]);
    expect((await file(voter, "short")).json.code).toBe("bad_text");
    expect((await file(voter, "Please call me on 9876543210 about this.")).status).toBe(400); expect((await file(voter, "Write to me at me@sample.example about this.")).status).toBe(400);
    expect((await file(voter, "I would like the president count checked once more.")).status).toBe(201);
    const list = (await w.h.call("GET", url)).json.challenges; expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ n: 1, status: "open", answer: "", answeredAt: null });
    expect(JSON.stringify(list)).not.toMatch(EMAIL); expect(Object.keys(list[0]).sort()).toEqual(["answer", "answeredAt", "filedAt", "n", "status", "text"]); // no name, no flat, no e-mail
    const answer = (jar: any, n: number, text: unknown = "The president count was checked again and is the same.") => w.h.call("POST", voterUrl(w, `/challenges/${n}/answer`), { answer: text }, jar);
    expect((await answer(await asMember(w, AGENT), 1)).status).toBe(403); expect((await answer(voter, 1)).status).toBe(403);
    expect((await answer(ro, 1, "ok")).json.code).toBe("bad_text"); expect((await answer(ro, 2)).json.code).toBe("not_found");
    expect((await answer(ro, 1)).status).toBe(200); expect((await answer(ro, 1)).json.code).toBe("answered");
    expect((await w.h.call("GET", url)).json.challenges[0]).toMatchObject({ status: "answered", answer: "The president count was checked again and is the same." });
    expect(() => w.h.raw.query("UPDATE el_challenges SET text = 'x'").run()).toThrow(); expect(() => w.h.raw.query("DELETE FROM el_challenges").run()).toThrow();
    // the same voter may send three in an hour, not four
    for (let i = 0; i < 2; i++) expect((await file(voter, `Another question number ${i + 2} about the count.`)).status).toBe(201);
    expect((await file(voter, "A fourth question about the count today.")).status).toBe(429);
    // and not after the challenge time
    afterChallengeTime(w); expect((await file(await asMember(w, emailOf(3)), "Too late but I would like to ask.")).json.code).toBe("challenge_closed");
  });

  test("the result can be declared only by the returning officer, after the challenge time, with every challenge answered", async () => {
    const w = await story(); await standardVotes(w); const { ro } = await counted(w);
    const declare = (jar: any, body: unknown = { confirm: "DECLARE" }) => w.h.call("POST", voterUrl(w, "/declare"), body, jar);
    expect((await declare(ro, {})).json.code).toBe("confirm");
    expect((await declare(ro)).json.code).toBe("challenge_window"); // the same evening: the challenge time is not over
    expect((await w.h.call("POST", voterUrl(w, "/challenges"), { text: "Please check the committee count once more." }, await asMember(w, emailOf(4)))).status).toBe(201);
    afterChallengeTime(w); const ro2 = await asMember(w, RO), agent2 = await asMember(w, AGENT), organizer = w.jar;
    expect((await declare(ro2)).json.code).toBe("open_challenges");
    expect((await w.h.call("POST", voterUrl(w, "/challenges/1/answer"), { answer: "The committee count was checked and is the same." }, ro2)).status).toBe(200);
    expect((await declare(agent2)).status).toBe(403); expect((await declare(await asMember(w, emailOf(0)))).status).toBe(403); expect((await w.h.call("POST", staffUrl(w, "/declare"), { confirm: "DECLARE" }, organizer)).status).toBe(404); // the Organizer has no address to declare
    // the result is not public until it is declared
    for (const p of ["/results", "/report"]) expect((await w.h.call("GET", voterUrl(w, p))).json.code).toBe("results_locked");
    const done = await declare(ro2); expect(done.status).toBe(200); expect(done.json.declared).toBe(true);
    const counts = (await w.h.call("GET", voterUrl(w, "/count"), undefined, ro2)).json;
    expect(done.json.result).toMatchObject({ countFingerprint: counts.fingerprint, signoff: { by: "returning officer", count: 1, fingerprint: counts.fingerprint }, turnout: { online: 7, paper: 0, eligible: 8 } });
    const res = await w.h.call("GET", voterUrl(w, "/results")); expect(res.status).toBe(200); expect(res.json).toEqual(done.json.result);
    expect(by(res.json.result)["President"].elected).toEqual([cand(w, 1)]);
    // after the declaration nothing moves
    expect((await countAs(w, ro2, { reason: "Counted again after the result." })).json.code).toBe("declared");
    expect((await declare(ro2)).json.code).toBe("declared");
    expect((await w.h.call("POST", voterUrl(w, "/challenges"), { text: "A question after the result was declared." }, await asMember(w, emailOf(5)))).json.code).toBe("challenge_closed");
    for (const sql of ["UPDATE el_elections SET status = 'voting'", "UPDATE el_elections SET title = 'x'", "DELETE FROM el_elections", "UPDATE el_counts SET reconciled = 0"]) expect(() => w.h.raw.query(sql).run()).toThrow();
    expect(q(w, "SELECT status FROM el_elections")[0]).toEqual({ status: "declared" });
  });

  test("the report holds the whole story for the notice board and shows no e-mail ID or phone number", async () => {
    const w = await story(); await standardVotes(w); const { ro } = await counted(w);
    await w.h.call("POST", voterUrl(w, "/challenges"), { text: "Please check the president count once more." }, await asMember(w, emailOf(2)));
    await w.h.call("POST", voterUrl(w, "/challenges/1/answer"), { answer: "The president count was checked and is the same." }, ro);
    afterChallengeTime(w); expect((await w.h.call("POST", voterUrl(w, "/declare"), { confirm: "DECLARE" }, await asMember(w, RO))).status).toBe(200);
    const rep = await w.h.call("GET", voterUrl(w, "/report")); expect(rep.status).toBe(200);
    expect(rep.json.election).toMatchObject({ title: "Committee election 2027", status: "declared", candidates: expect.any(Array) });
    expect(rep.json.trail.map((e: any) => e.type)).toEqual(expect.arrayContaining(["election.notice", "election.candidates_final", "election.voting_opened", "election.voting_closed", "election.counted", "election.challenge_filed", "election.challenge_answered", "election.declared"]));
    expect(rep.json.counts).toHaveLength(1); expect(rep.json.challenges).toHaveLength(1); expect(rep.json.officials.map((o: any) => o.role)).toEqual(expect.arrayContaining(["returning_officer", "counting_agent", "observer"]));
    expect(rep.json.signedTrail.head).toBeTruthy(); expect(rep.json.secrecy).toContain("cannot be joined");
    for (const p of ["", "/results", "/report", "/trail", "/challenges"]) { const t = (await w.h.call("GET", voterUrl(w, p))).text; expect([p, EMAIL.test(t)]).toEqual([p, false]); expect([p, PHONE.test(scrub(t))]).toEqual([p, false]); }
    expect((await w.h.call("GET", `/api/v/${w.slug}/elections`)).json.elections[0]).toMatchObject({ status: "declared" });
  });
});

describe("a changed box cannot be declared", () => {
  /** A count that is fine, then the challenge time passes. The attacker has the database file: the append-only locks are dropped first, so only the checks of the count stand in the way. */
  async function ready() { const w = await story(); await standardVotes(w); const c = await counted(w); expect(c.count.json.reconciled).toBe(true); afterChallengeTime(w); return { w, ro: await asMember(w, RO) }; }
  const declare = (w: World, ro: any) => w.h.call("POST", voterUrl(w, "/declare"), { confirm: "DECLARE" }, ro);
  const drop = (w: World, ...triggers: string[]) => { for (const t of triggers) w.h.raw.query(`DROP TRIGGER ${t}`).run(); };

  test("the untouched box is declared (the control for the tests below)", async () => { const { w, ro } = await ready(); expect((await declare(w, ro)).status).toBe(200); });

  test("a ballot taken out after the count", async () => {
    const { w, ro } = await ready(); drop(w, "trg_el_ballots_no_delete"); w.h.raw.query("DELETE FROM el_ballots WHERE id = (SELECT id FROM el_ballots LIMIT 1)").run();
    const r = await declare(w, ro); expect([r.status, r.json.code]).toEqual([409, "mismatch"]);
  });
  test("a ballot changed after the count: moved to another ballot's place or damaged", async () => {
    const { w, ro } = await ready(); drop(w, "trg_el_ballots_no_update");
    const two = q(w, "SELECT id, sealed FROM el_ballots WHERE post_id = ? ORDER BY id LIMIT 2", w.posts[0]!.id);
    w.h.raw.query("UPDATE el_ballots SET sealed = ? WHERE id = ?").run(two[1].sealed, two[0].id); // a sealed choice is bound to its own ballot id, so a swap does not open
    expect((await declare(w, ro)).json.code).toBe("mismatch");
    w.h.raw.query("UPDATE el_ballots SET sealed = ? WHERE id = ?").run(two[0].sealed, two[0].id); w.h.raw.query("UPDATE el_ballots SET sealed = ? WHERE id = ?").run(two[1].sealed, two[1].id);
    expect((await declare(w, ro)).status).toBe(200); // put back exactly as it was: the same fingerprint again, so the box is accepted
  });
  test("a ballot added that nobody voted", async () => {
    const { w, ro } = await ready(); w.h.raw.query("INSERT INTO el_ballots (id, election_id, post_id, weight_milli, sealed) VALUES ('f'||hex(randomblob(15)), ?, ?, 1000, 'forged')").run(w.eid, w.posts[0]!.id);
    expect((await declare(w, ro)).json.code).toBe("mismatch");
  });
  test("a person taken out of the register, or a vote added by hand", async () => {
    const { w, ro } = await ready(); drop(w, "trg_el_voted_no_delete"); w.h.raw.query("DELETE FROM el_voted WHERE roll_row_id = (SELECT roll_row_id FROM el_voted LIMIT 1)").run();
    expect((await declare(w, ro)).json.code).toBe("mismatch");
    const w2 = (await ready()); w2.w.h.raw.query("INSERT INTO el_voted (election_id, roll_row_id, channel, by_pid, voted_at) SELECT ?, id, 'online', 'p_x', 1 FROM publication_rows WHERE publication_id = (SELECT roll_pub_id FROM el_elections) AND is_voter = 1 AND can_vote = 1 AND id NOT IN (SELECT roll_row_id FROM el_voted) LIMIT 1").run(w2.w.eid);
    expect((await declare(w2.w, w2.ro)).json.code).toBe("mismatch");
  });
  test("a receipt taken out", async () => {
    const { w, ro } = await ready(); drop(w, "trg_el_receipts_no_delete"); w.h.raw.query("DELETE FROM el_receipts WHERE receipt_hash = (SELECT receipt_hash FROM el_receipts LIMIT 1)").run();
    expect((await declare(w, ro)).json.code).toBe("mismatch");
  });
  test("a box changed before the count is counted but marked as not matching, and cannot be declared", async () => {
    const w = await story(); await standardVotes(w); drop(w, "trg_el_ballots_no_delete"); w.h.raw.query("DELETE FROM el_ballots WHERE id = (SELECT id FROM el_ballots LIMIT 1)").run();
    const { count } = await closeAndCount(w); expect(count.status).toBe(201); expect(count.json.reconciled).toBe(false); expect(count.json.problems.join(" ")).toContain("the box holds 6 ballots but 7 people voted online");
    const view = (await w.h.call("GET", voterUrl(w, "/count"), undefined, await asMember(w, RO))).json; expect(view.reconciled).toBe(false);
    afterChallengeTime(w); expect((await declare(w, await asMember(w, RO))).json.code).toBe("mismatch");
  });
  test("the signed trail must agree with the register: a vote line left out of the trail", async () => {
    const w = await story(); await standardVotes(w); const entry = q(w, "SELECT seq FROM audit_entries WHERE type = 'election.vote_cast' LIMIT 1")[0].seq;
    drop(w, "trg_audit_no_update"); w.h.raw.query("UPDATE audit_entries SET type = 'election.other' WHERE seq = ?").run(entry);
    const { count } = await closeAndCount(w); expect(count.json.reconciled).toBe(false); expect(count.json.problems.join(" ")).toContain("The signed trail has 6 online votes but the register has 7");
  });
});

describe("erasing a list", () => {
  test("after the retention time the Organizer's erase removes every person's details and every vote, and keeps the rules and the public trail", async () => {
    const w = await story({ env: { RETENTION_DAYS: "30" } }); await standardVotes(w); const { ro } = await counted(w);
    await w.h.call("POST", voterUrl(w, "/challenges"), { text: "Please check the president count once more." }, await asMember(w, emailOf(2)));
    await w.h.call("POST", voterUrl(w, "/challenges/1/answer"), { answer: "The president count was checked and is the same." }, ro);
    afterChallengeTime(w); expect((await w.h.call("POST", voterUrl(w, "/declare"), { confirm: "DECLARE" }, await asMember(w, RO))).status).toBe(200);
    for (const t of ["el_nominations", "el_officials", "el_voted", "el_ballots", "el_receipts", "el_counts", "el_challenges"]) expect([t, q(w, `SELECT COUNT(*) AS n FROM ${t}`)[0].n > 0]).toEqual([t, true]);
    w.h.clock.now += 400 * 86_400_000; const jar = await w.h.staff(w.organizer);
    expect((await w.h.call("POST", `/api/lists/${w.sid}/erase`, { confirm: "ERASE" }, jar)).status).toBe(200);
    for (const t of ["el_nominations", "el_officials", "el_voted", "el_ballots", "el_receipts", "el_counts", "el_challenges", "el_tickets", "el_codes"]) expect([t, q(w, `SELECT COUNT(*) AS n FROM ${t}`)[0].n]).toEqual([t, 0]);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_elections")[0]).toEqual({ n: 1 }); expect(q(w, "SELECT COUNT(*) AS n FROM el_posts")[0].n).toBe(4); expect(q(w, "SELECT COUNT(*) AS n FROM el_events")[0].n).toBeGreaterThan(5);
    const left = JSON.stringify([q(w, "SELECT * FROM el_events"), q(w, "SELECT * FROM el_elections"), q(w, "SELECT * FROM el_posts")]);
    expect(left).not.toMatch(EMAIL); expect(left).not.toContain("Bharat");
  });
});
