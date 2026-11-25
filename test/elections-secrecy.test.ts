// Elections: the secret ballot, proved. Who voted is in the register. What was chosen is in sealed ballots that carry no name, no time and no number.
// These tests read the real database after real votes and look for any way to join the two; they also check that nothing is added up before voting closes.
import { describe, expect, test } from "bun:test";
import { pseudonym } from "../src/audit";
import { openChoiceWith, sealKey } from "../src/elections-vote";
import { runCount } from "../src/elections-count";
import { deriveKey32 } from "../src/vendor/crypto";
import { AGENT, OBSERVER, RO, asMember, base, cand, castAs, closeAndCount, draft, emailOf, pick, staffUrl, toVoting, voterUrl, standardVotes, type World } from "./elections-world";

const q = (w: World, sql: string, ...a: unknown[]) => w.h.raw.query(sql).all(...(a as never[])) as any[];
async function story(o: { mode?: string } = {}) { const w = await base({ voters: 8 }).then((b) => draft(b, { mode: o.mode })); await toVoting(w); return w; }
const tables = (w: World) => q(w, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((x) => x.name as string);
/** Every row of the given tables (all tables when none are named), as one text that a person with the whole database file could read. */
const dump = (w: World, only?: string[]) => (only ?? tables(w)).map((t) => `## ${t}\n` + q(w, `SELECT * FROM ${t}`).map((r) => JSON.stringify(r)).join("\n")).join("\n");
const keysOf = (v: unknown, out: string[] = []): string[] => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };
const cols = (w: World, t: string) => q(w, `PRAGMA table_info(${t})`).map((c) => c.name as string).sort();
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("the shape of the database", () => {
  test("a ballot has no voter, no time and no number; a receipt holds nothing but its own hash; neither table has a row number", async () => {
    const w = await story();
    expect(cols(w, "el_ballots")).toEqual(["election_id", "id", "post_id", "sealed", "weight_milli"]);
    expect(cols(w, "el_receipts")).toEqual(["election_id", "receipt_hash"]);
    for (const t of ["el_ballots", "el_receipts"]) expect(() => w.h.raw.query(`SELECT rowid FROM ${t}`).all()).toThrow(); // WITHOUT ROWID: no hidden counter that would give the order of voting
    for (const t of ["el_ballots", "el_receipts"]) expect(q(w, `PRAGMA foreign_key_list(${t})`).map((f) => f.table)).toEqual(["el_elections"]); // nothing points to a voter or to the register
    expect(q(w, "PRAGMA index_info(idx_el_ballots_post)").map((c) => c.name)).toEqual(["election_id", "post_id"]);
    // no other table has a place to put a ballot, a receipt or a choice
    for (const t of tables(w).filter((x) => x !== "el_ballots" && x !== "el_receipts")) for (const c of cols(w, t)) expect([t, c, /ballot|receipt|sealed|choice|picked|selected/i.test(c)]).toEqual([t, c, false]);
    // the register says who voted, and holds no choice
    expect(cols(w, "el_voted")).toEqual(["by_pid", "channel", "election_id", "roll_row_id", "voted_at"]);
  });
});

describe("after real votes, nothing in the database joins a voter to a choice", () => {
  test("the vote side of the database holds no e-mail ID; ballot ids, receipt codes and choices are written in one place only", async () => {
    const w = await story(); const votes = await standardVotes(w);
    const emails = votes.map((_, i) => emailOf(i)); const pids = await Promise.all(emails.map((e) => pseudonym(w.h.env, e)));
    const side = ["el_ballots", "el_receipts", "el_voted", "el_tickets", "el_codes", "el_counts", "el_challenges", "el_events", "audit_entries"];
    const sideText = dump(w, side).toLowerCase();
    for (const e of emails) expect([e, sideText.includes(e)]).toEqual([e, false]);
    expect(sideText).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
    // the register holds each voter's private code once; the ballots, receipts, tickets and the public trail never hold it
    const reg = q(w, "SELECT by_pid, channel FROM el_voted ORDER BY by_pid"); expect(reg.map((r) => r.by_pid)).toEqual([...pids].sort()); expect(new Set(reg.map((r) => r.channel))).toEqual(new Set(["online"]));
    for (const t of ["el_ballots", "el_receipts", "el_counts", "el_events", "el_challenges"]) for (const p of pids) expect([t, dump(w, [t]).includes(p)]).toEqual([t, false]);
    // each ballot id is in exactly one place; the receipt codes the voters were given are nowhere (only their hashes are kept)
    const whole = dump(w);
    const ids = q(w, "SELECT id FROM el_ballots").map((x) => x.id as string); expect(ids).toHaveLength(14); expect(new Set(ids).size).toBe(14);
    for (const id of ids) expect([id, occurrences(whole, id)]).toEqual([id, 1]);
    for (const v of votes) { const code = v.vote.json.receipt as string; expect(whole).not.toContain(code); expect(whole).not.toContain(code.replace(/-/g, "")); expect(whole.toLowerCase()).not.toContain(code.replace(/-/g, "").toLowerCase()); }
    // a choice is never stored in the clear, and a sealed ballot does not name a candidate
    expect(whole).not.toMatch(/"s":\s*\[/); expect(whole).not.toContain("NOTA");
    for (const b of q(w, "SELECT sealed FROM el_ballots")) for (const id of Object.values(w.cand)) expect(b.sealed).not.toContain(id);
    // the server secret is nowhere in the database
    expect(whole).not.toContain(w.h.env.PEPPER);
  });

  test("the signed trail of a vote says that a vote was cast, by a private code, and nothing more", async () => {
    const w = await story(); const r = await castAs(w, emailOf(0), pick(w, { 1: [1], 2: [3, 4] })); expect(r.vote.status).toBe(201);
    const rows = q(w, "SELECT entry_json FROM audit_entries WHERE type = 'election.vote_cast'"); expect(rows).toHaveLength(1);
    const text = rows[0].entry_json as string; const pid = await pseudonym(w.h.env, emailOf(0));
    expect(text).toContain(pid); expect(text).toContain('"channel":"online"');
    for (const bad of [...Object.values(w.cand), ...q(w, "SELECT id FROM el_ballots").map((x) => x.id as string), r.vote.json.receipt, "NOTA", "choice", "sealed", "receipt"]) expect([bad, text.includes(bad)]).toEqual([bad, false]);
    // and the public trail does not list single votes at all
    const trail = (await w.h.call("GET", voterUrl(w, "/trail"))).json.events as any[]; expect(trail.filter((e) => /vote_cast|voted/.test(e.type + e.summary))).toEqual([]);
  });

  test("a voter who leaves every post blank still puts one ballot in the box for each post, so the number of ballots tells nothing", async () => {
    const w = await story(); await castAs(w, emailOf(0), pick(w, { 1: [1], 2: [3, 4] })); await castAs(w, emailOf(1), {});
    expect(q(w, "SELECT post_id, COUNT(*) AS n FROM el_ballots GROUP BY post_id").map((x) => x.n)).toEqual([2, 2]);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_voted")[0]).toEqual({ n: 2 });
    expect(new Set(q(w, "SELECT length(sealed) AS n FROM el_ballots").map((x) => x.n)).size).toBe(1); // a blank ballot is as long as a full one
  });
});

describe("the seal", () => {
  test("a sealed choice is the same length for every choice, different every time, and opens only with the right key, ballot and post", async () => {
    const w = await story(); await standardVotes(w);
    const rows = q(w, "SELECT id, post_id, sealed FROM el_ballots"); const salt = q(w, "SELECT seal_salt FROM el_elections")[0].seal_salt as string; expect(salt).toMatch(/^[0-9a-f]{32,}$/);
    expect(new Set(rows.map((r) => (r.sealed as string).length)).size).toBe(1); expect(new Set(rows.map((r) => r.sealed)).size).toBe(rows.length); // three voters chose Bharat: three different texts
    const key = await sealKey(w.h.env, { id: w.eid, seal_salt: salt });
    const open = async (r: any, k = key, post = r.post_id, id = r.id) => openChoiceWith(k, w.eid, id, post, r.sealed);
    // with the right key every ballot opens, and the box holds exactly what the voters chose (the count of the standard story)
    const p1 = rows.filter((r) => r.post_id === w.posts[0]!.id); const opened = await Promise.all(p1.map((r) => open(r)));
    expect(opened.every((c) => c !== null)).toBe(true);
    const tally = (cid: string) => opened.filter((c) => c!.s.includes(cid)).length;
    expect([tally(cand(w, 0)), tally(cand(w, 1)), tally(cand(w, 2)), opened.filter((c) => c!.n === 1).length, opened.filter((c) => c!.n === 0 && c!.s.length === 0).length]).toEqual([2, 3, 0, 1, 1]);
    // a person with the whole database but not the server secret cannot open anything; neither can another election's key
    const wrong = await deriveKey32("a different server secret", `election-seal/${w.eid}/${salt}`);
    const other = await sealKey(w.h.env, { id: w.eid, seal_salt: "0".repeat(salt.length) });
    for (const r of rows) { expect(await open(r, wrong)).toBeNull(); expect(await open(r, other)).toBeNull(); }
    // a sealed choice is tied to its own ballot and post: moved elsewhere it does not open
    expect(await open(p1[0], key, w.posts[1]!.id)).toBeNull(); expect(await open(p1[0], key, p1[0].post_id, p1[1].id)).toBeNull();
    expect(await openChoiceWith(key, "another-election", p1[0].id, p1[0].post_id, p1[0].sealed)).toBeNull();
  });
});

describe("nothing is added up before voting closes", () => {
  test("no address, for no person, shows a count, a result, a report or a challenge list while the box is open", async () => {
    const w = await story(); await castAs(w, emailOf(0), pick(w, { 1: [1], 2: [3, 4] })); await castAs(w, emailOf(1), pick(w, { 1: [1] }));
    const ro = await asMember(w, RO), agent = await asMember(w, AGENT), observer = await asMember(w, OBSERVER), voter = await asMember(w, emailOf(2));
    for (const [who, jar] of [["returning officer", ro], ["counting agent", agent], ["observer", observer], ["voter", voter], ["signed out", {}]] as const) {
      for (const p of ["/results", "/report", "/challenges"]) expect([who, p, (await w.h.call("GET", voterUrl(w, p), undefined, jar as any)).json.code]).toEqual([who, p, "results_locked"]);
      const view = await w.h.call("GET", voterUrl(w, "/count"), undefined, jar as any); expect([who, view.status === 403 || view.status === 401 || (view.status === 409 && view.json.code === "results_locked")]).toEqual([who, true]);
      const post = await w.h.call("POST", voterUrl(w, "/count"), {}, jar as any); expect([who, post.status === 403 || post.status === 401 || (post.status === 409 && post.json.code === "not_closed")]).toEqual([who, true]);
    }
    expect(q(w, "SELECT COUNT(*) AS n FROM el_counts")[0]).toEqual({ n: 0 });
    // the Organizer and a co-organizer have no address for counts either
    for (const jar of [w.jar, w.coJar]) for (const tail of ["/count", "/results", "/tally"]) expect((await w.h.call("GET", staffUrl(w, tail), undefined, jar)).status).toBe(404);
    // the counting function itself refuses, whoever calls it
    const society = q(w, "SELECT * FROM societies WHERE id = ?", w.sid)[0];
    await expect(runCount(w.h.env, w.h.clock.now, society, { role: "returning_officer", email: RO }, w.eid, {})).rejects.toMatchObject({ status: 409, code: "not_closed" });
    expect(q(w, "SELECT COUNT(*) AS n FROM el_counts")[0]).toEqual({ n: 0 });
  });

  test("the pages that are open to people show how many have voted and not one choice", async () => {
    const w = await story(); await castAs(w, emailOf(0), pick(w, { 1: [1], 2: [3, 4] })); await castAs(w, emailOf(1), pick(w, { 1: [1] }));
    const pages = [(await w.h.call("GET", voterUrl(w))).json, (await w.h.call("GET", `/api/v/${w.slug}/elections`)).json, (await w.h.call("GET", staffUrl(w), undefined, w.jar)).json, (await w.h.call("GET", staffUrl(w), undefined, w.coJar)).json, (await w.h.call("GET", voterUrl(w, "/trail"))).json];
    for (const p of pages) for (const k of keysOf(p)) expect([k, /^(votes?|tally|tallies|results?|ballots|blank|invalid|noneOfTheAbove|elected|draw|counts?)$/i.test(k)]).toEqual([k, false]);
    expect(pages[0]).toMatchObject({ status: "voting", turnout: { voted: 2, eligible: 8 } }); expect(pages[2]).toMatchObject({ turnout: { voted: 2, eligible: 8 } });
    // the candidates on the public page carry their own details only
    for (const c of pages[0].candidates) expect(Object.keys(c).filter((k) => !["id", "post", "name", "unit", "statement", "status", "submittedAt"].includes(k))).toEqual([]);
    // the ballot a voter is given shows the candidates and no number
    const me = emailOf(2), jar = await asMember(w, me); await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar);
    const opened = await w.h.call("POST", voterUrl(w, "/ballot"), { code: w.h.code(me) }, jar); expect(keysOf(opened.json.ballot).filter((k) => /vote|tally|count|result/i.test(k) && k !== "vote" && k !== "maxVotes")).toEqual([]);
  });
});

describe("the receipt", () => {
  test("a receipt shows that a ballot is in the box and nothing else; it works in any spelling and for nobody else's code", async () => {
    const w = await story(); const votes = await standardVotes(w); const code = votes[0]!.vote.json.receipt as string;
    const check = (c: string) => w.h.call("GET", voterUrl(w, `/receipt/${encodeURIComponent(c)}`));
    for (const spelling of [code, code.toLowerCase(), code.replace(/-/g, "")]) { const r = await check(spelling); expect([spelling, r.status]).toEqual([spelling, 200]); expect(Object.keys(r.json).sort()).toEqual(["found", "note"]); expect(r.json.found).toBe(true); }
    expect(JSON.stringify((await check(code)).json)).not.toMatch(/nom_|[0-9a-f]{16}/);
    expect((await check("AAAA-AAAA-AAAA")).status).toBe(404); expect((await check("hello")).json.code).toBe("bad_receipt"); expect((await check("AAAA-AAAA-AAA0")).json.code).toBe("bad_receipt"); // no 0, 1, I or O in a receipt
    expect(new Set(votes.map((v) => v.vote.json.receipt)).size).toBe(7);
    // the box holds only a hash, and the hash is not the code
    const hashes = q(w, "SELECT receipt_hash FROM el_receipts").map((r) => r.receipt_hash as string); expect(hashes).toHaveLength(7); for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // a draft election is not public, so a receipt there is "not found" too
    const w2 = await base({ voters: 8 }).then((b) => draft(b)); expect((await w2.h.call("GET", voterUrl(w2, "/receipt/AAAA-AAAA-AAAA"))).status).toBe(404);
  });
});

describe("one vote is one step", () => {
  test("a step that fails leaves nothing behind: no register line, no ballot, no receipt, and the ticket still works", async () => {
    const w = await story(); const me = emailOf(0), jar = await asMember(w, me);
    await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar); const { ticket } = (await w.h.call("POST", voterUrl(w, "/ballot"), { code: w.h.code(me) }, jar)).json;
    const before = q(w, "SELECT COUNT(*) AS n FROM audit_entries")[0].n;
    w.h.raw.query("CREATE TRIGGER boom BEFORE INSERT ON el_receipts BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    const bad = await w.h.call("POST", voterUrl(w, "/vote"), { ticket, choices: pick(w, { 1: [1] }) }, jar); expect(bad.status).toBe(500); expect(JSON.stringify(bad.json)).not.toContain("boom");
    for (const t of ["el_voted", "el_ballots", "el_receipts"]) expect([t, q(w, `SELECT COUNT(*) AS n FROM ${t}`)[0].n]).toEqual([t, 0]);
    expect(q(w, "SELECT COUNT(*) AS n FROM audit_entries")[0].n).toBe(before); expect(q(w, "SELECT COUNT(*) AS n FROM el_tickets")[0]).toEqual({ n: 1 });
    w.h.raw.query("DROP TRIGGER boom").run();
    expect((await w.h.call("POST", voterUrl(w, "/vote"), { ticket, choices: pick(w, { 1: [1] }) }, jar)).status).toBe(201); // the same ticket, now it works
    expect(q(w, "SELECT COUNT(*) AS n FROM el_ballots")[0]).toEqual({ n: 2 });
  });

  test("two votes sent at the same moment for one voter put exactly one set of ballots in the box", async () => {
    const w = await story(); const me = emailOf(0), jar = await asMember(w, me); const tickets: string[] = [];
    for (let i = 0; i < 2; i++) { await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar); tickets.push((await w.h.call("POST", voterUrl(w, "/ballot"), { code: w.h.code(me) }, jar)).json.ticket); }
    const both = await Promise.all(tickets.map((t, i) => w.h.call("POST", voterUrl(w, "/vote"), { ticket: t, choices: pick(w, { 1: [i] }) }, jar)));
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    for (const [t, n] of [["el_voted", 1], ["el_ballots", 2], ["el_receipts", 1]] as const) expect([t, q(w, `SELECT COUNT(*) AS n FROM ${t}`)[0].n]).toEqual([t, n]);
    expect(q(w, "SELECT COUNT(*) AS n FROM audit_entries WHERE type = 'election.vote_cast'")[0]).toEqual({ n: 1 });
  });
});

describe("after the count", () => {
  test("the numbers are shared and the box still cannot be joined to the register", async () => {
    const w = await story(); const votes = await standardVotes(w); const { count } = await closeAndCount(w); expect(count.status).toBe(201);
    // after the count: tallies are public to the team, and the same checks as before the count still hold
    const whole = dump(w); expect(whole).not.toMatch(/"s":\s*\[/);
    for (const v of votes) expect(whole).not.toContain(v.vote.json.receipt);
    const ids = q(w, "SELECT id FROM el_ballots").map((x) => x.id as string); for (const id of ids) expect(occurrences(dump(w, tables(w).filter((t) => t !== "el_ballots")), id)).toBe(0);
    // the stored count has numbers per post and no voter
    const stored = q(w, "SELECT result_json FROM el_counts")[0].result_json as string;
    for (const i of [0, 1, 2, 3, 4, 5, 6]) expect(stored).not.toContain(emailOf(i));
    for (const p of await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => pseudonym(w.h.env, emailOf(i))))) expect(stored).not.toContain(p);
  });
});
