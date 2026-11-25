// Elections: fixes after the audit of version 0.4.0. Each test reads the real database after the real step and asserts the outcome from the stored state.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pseudonym } from "../src/audit";
import { msToLocal } from "../src/lists";
import { CO, RO, TZ, asMember, at, base, castAs, closeAndCount, draft, emailOf, nominate, notice, pick, staffUrl, standardVotes, toFinal, toVoting, voterUrl, type World } from "./elections-world";

const q = (w: World, sql: string, ...a: unknown[]) => w.h.raw.query(sql).all(...(a as never[])) as any[];
async function story() { const w = await base({ voters: 8 }).then((b) => draft(b)); await toVoting(w); return w; }

// ------------------------------------------------------------------------------------------------------------------ 1. no exact time next to a person
const isDayStart = (ms: number) => msToLocal(ms, TZ).endsWith("T00:00");
/** Every exact time (a millisecond clock value that is not the start of a day, or text with an hour and minute) found in the values of one row. */
function exactTimes(v: unknown, out: unknown[] = []): unknown[] {
  if (typeof v === "number") { if (v >= 1e11 && !isDayStart(v)) out.push(v); }
  else if (typeof v === "string") { if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) || /^\d{2}:\d{2}/.test(v)) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => exactTimes(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => exactTimes(x, out));
  return out;
}

describe("no exact time of voting sits next to a voter", () => {
  test("after sequential votes the register, tickets, codes and signed entries hold the day only, and a used ticket and code keep no person", async () => {
    const w = await story();
    const who = [0, 1, 2]; const pids: string[] = [], rolls: number[] = [];
    for (const i of who) {
      w.h.clock.now += (7 + i) * 60_000 + 13_000; // each voter a few minutes after the one before, as in a small society
      const r = await castAs(w, emailOf(i), pick(w, { 1: [i % 2], 2: [3] })); expect(r.vote.status).toBe(201);
      pids.push(await pseudonym(w.h.env, emailOf(i)));
    }
    const day = msToLocal(w.h.clock.now, TZ).slice(0, 10); expect(day).toBe("2026-11-20");
    // the register: the calendar day, in the society's time zone, and nothing else
    const reg = q(w, "SELECT roll_row_id, by_pid, voted_at FROM el_voted ORDER BY roll_row_id"); expect(reg).toHaveLength(3);
    for (const r of reg) { rolls.push(r.roll_row_id); expect(r.voted_at).toBe(day); }
    // a used ticket and a used code are gone: no row holds a roll row id any more, and no table keeps a used time
    expect(q(w, "SELECT COUNT(*) AS n FROM el_tickets")[0]).toEqual({ n: 0 });
    expect(q(w, "SELECT COUNT(*) AS n FROM el_codes")[0]).toEqual({ n: 0 });
    for (const t of ["el_tickets", "el_codes"]) expect([t, q(w, `PRAGMA table_info(${t})`).map((c) => c.name).includes("used_at")]).toEqual([t, false]);
    expect(q(w, "SELECT COUNT(*) AS n FROM rate_hits WHERE k LIKE 'elcode:%' OR k LIKE 'elopen:%'")[0]).toEqual({ n: 0 }); // the exact times of asking for a code
    // the signed entry of each vote: the date, a time that is the start of that day, the private code, no ballot id
    const rows = q(w, "SELECT ts, entry_json FROM audit_entries WHERE type = 'election.vote_cast' ORDER BY seq"); expect(rows).toHaveLength(3);
    rows.forEach((r, k) => {
      const e = JSON.parse(r.entry_json); expect(r.ts).toBe(e.ts); expect(isDayStart(e.ts)).toBe(true);
      expect(e.payload).toEqual({ election: w.eid, channel: "online", date: day }); expect(e.actor.pid).toBe(pids[k]);
    });
    // the general rule, over every row that links a person: no exact time anywhere
    const linked: unknown[] = [...reg, ...q(w, "SELECT * FROM el_tickets"), ...q(w, "SELECT * FROM el_codes"), ...rows.map((r) => ({ ts: r.ts, ...JSON.parse(r.entry_json) }))];
    expect(linked.flatMap((r) => exactTimes(r))).toEqual([]);
    // a ballot row still carries no voter, no time and no counter
    expect(q(w, "PRAGMA table_info(el_ballots)").map((c) => c.name).sort()).toEqual(["election_id", "id", "post_id", "sealed", "weight_milli"]);
  });

  test("one person, one vote still holds: the used ticket and the used code cannot be used again", async () => {
    const w = await story(); const me = emailOf(0), jar = await asMember(w, me);
    await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar);
    const code = w.h.code(me); const opened = await w.h.call("POST", voterUrl(w, "/ballot"), { code }, jar); expect(opened.status).toBe(200);
    const ticket = opened.json.ticket as string, choices = pick(w, { 1: [1], 2: [3] });
    expect((await w.h.call("POST", voterUrl(w, "/ballot"), { code }, jar)).status).toBe(401); // the same code, a second time, before voting
    expect((await w.h.call("POST", voterUrl(w, "/vote"), { ticket, choices }, jar)).status).toBe(201);
    expect((await w.h.call("POST", voterUrl(w, "/vote"), { ticket, choices }, jar)).json.code).toBe("bad_ticket"); // the same ticket
    expect((await w.h.call("POST", voterUrl(w, "/ballot"), { code }, jar)).json.code).toBe("already_voted");
    expect((await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar)).json.code).toBe("already_voted");
    const again = await castAs(w, me, pick(w, { 1: [0] })); expect(again.sent.status).toBe(409);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_voted")[0]).toEqual({ n: 1 });
    expect(q(w, "SELECT COUNT(*) AS n FROM el_ballots")[0]).toEqual({ n: 2 });
    expect(q(w, "SELECT COUNT(*) AS n FROM el_receipts")[0]).toEqual({ n: 1 });
    expect(q(w, "SELECT COUNT(*) AS n FROM audit_entries WHERE type = 'election.vote_cast'")[0]).toEqual({ n: 1 });
  });

  test("a paper ballot is also entered with the day only", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b, { mode: "mixed" })); await toVoting(w);
    const ro = await asMember(w, RO); const line = q(w, "SELECT id FROM publication_rows WHERE is_voter = 1 AND can_vote = 1 ORDER BY seq LIMIT 1")[0].id;
    w.h.clock.now += 11 * 60_000 + 7_000;
    const r = await w.h.call("POST", voterUrl(w, "/paper/issue"), { rollId: line }, ro); expect(r.status).toBe(201);
    expect(q(w, "SELECT voted_at FROM el_voted")).toEqual([{ voted_at: "2026-11-20" }]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 2. the people who run the election cannot stand
describe("the Organizer and every co-organizer are barred from standing", () => {
  test("an Organizer who is not the one who made the election is refused at nomination", async () => {
    const b = await base({ voters: 8, organizer: emailOf(0) }); const w = await draft(b);
    q(w, "UPDATE el_elections SET created_by = 'p_someone_else' WHERE id = ?", w.eid); // so that only the staff bar can refuse (the maker check is separate)
    await notice(w); w.h.clock.now = at("2026-11-12T11:00");
    const r = await nominate(w, 0, 0); expect([r.status, r.json.code]).toEqual([409, "is_staff"]);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_nominations")[0]).toEqual({ n: 0 });
    expect((await nominate(w, 1, 0)).status).toBe(201); // an ordinary voter can stand
  });

  test("a co-organizer who is already on the team is refused at nomination", async () => {
    const b = await base({ voters: 8 }); const w = await draft(b);
    expect((await w.h.call("POST", `/api/lists/${w.sid}/team`, { email: emailOf(3) }, w.jar)).status).toBe(201);
    await notice(w); w.h.clock.now = at("2026-11-12T11:00");
    const r = await nominate(w, 3, 0); expect([r.status, r.json.code]).toEqual([409, "is_staff"]);
    expect(q(w, "SELECT COUNT(*) AS n FROM el_nominations")[0]).toEqual({ n: 0 });
  });

  test("a co-organizer added AFTER the nomination stops the opening of the voting", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b)); await toFinal(w);
    const standing = q(w, "SELECT email FROM el_nominations WHERE status = 'accepted' ORDER BY id LIMIT 1")[0].email as string;
    expect((await w.h.call("POST", `/api/lists/${w.sid}/team`, { email: standing }, w.jar)).status).toBe(201);
    w.h.clock.now = at("2026-11-20T09:30"); w.jar = await w.h.staff(w.organizer);
    const r = await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar); expect([r.status, r.json.code]).toEqual([409, "staff_stands"]);
    expect(q(w, "SELECT status, opened_at FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "candidates_final", opened_at: null }]);
    // when that nomination is withdrawn by the candidate's own rejection, voting can open
    q(w, "UPDATE el_nominations SET status = 'withdrawn' WHERE email = ?", standing);
    expect((await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar)).status).toBe(200);
    expect(q(w, "SELECT status FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "voting" }]);
  });

  test("an Organizer who stands is refused at opening, even when the nomination was let in", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b)); await toFinal(w);
    const standing = q(w, "SELECT email FROM el_nominations WHERE status = 'accepted' ORDER BY id LIMIT 1")[0].email as string;
    q(w, "UPDATE memberships SET email = ? WHERE society_id = ? AND role = 'organizer'", standing, w.sid); // the Organizer is now the candidate (old data)
    w.h.clock.now = at("2026-11-20T09:30"); const jar = await w.h.staff(standing);
    const r = await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, jar); expect([r.status, r.json.code]).toEqual([409, "opener_is_candidate"]); // the older check for the person who opens, which comes first
    expect(q(w, "SELECT status FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "candidates_final" }]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 3. the trail count does not depend on how the entry is written
describe("reconcile reads the signed trail by its fields, not by its spelling", () => {
  test("a clean election reconciles; the same entries written with other spacing still reconcile; a ballot deleted makes it fail", async () => {
    const w = await story(); await standardVotes(w);
    // the real entries, as commit() wrote them
    const real = q(w, "SELECT entry_json FROM audit_entries WHERE type = 'election.vote_cast' LIMIT 1")[0].entry_json as string; expect(real).toContain(`"election":"${w.eid}"`);
    // the same entries in another valid spelling (extra spaces): the count must not change
    expect(q(w, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_audit_no_update'")).toEqual([{ name: "trg_audit_no_update" }]); // the lock really exists: dropping it below is a deliberate step, not a no-op
    w.h.raw.query("DROP TRIGGER trg_audit_no_update").run();
    for (const r of q(w, "SELECT seq, entry_json FROM audit_entries WHERE type = 'election.vote_cast'")) {
      w.h.raw.query("UPDATE audit_entries SET entry_json = ? WHERE seq = ?").run(JSON.stringify(JSON.parse(r.entry_json), null, 1), r.seq);
    }
    const { count } = await closeAndCount(w); expect(count.status).toBe(201); expect(count.json.problems).toEqual([]); expect(count.json.reconciled).toBe(true);
    expect(q(w, "SELECT reconciled FROM el_counts")).toEqual([{ reconciled: 1 }]);
  });

  test("a ballot deleted after the votes is found by the same check", async () => {
    const w = await story(); await standardVotes(w);
    w.h.raw.query("DROP TRIGGER trg_el_ballots_no_delete").run(); w.h.raw.query("DELETE FROM el_ballots WHERE id = (SELECT id FROM el_ballots LIMIT 1)").run();
    const { count } = await closeAndCount(w); expect(count.json.reconciled).toBe(false);
    expect(q(w, "SELECT reconciled FROM el_counts")).toEqual([{ reconciled: 0 }]);
  });

  test("a vote entry that is turned into another kind is found (the trail has fewer votes than the register)", async () => {
    const w = await story(); await standardVotes(w);
    w.h.raw.query("DROP TRIGGER trg_audit_no_update").run(); w.h.raw.query("UPDATE audit_entries SET entry_json = replace(entry_json, ?, '\"election\":\"other\"') WHERE type = 'election.vote_cast' AND seq = (SELECT MIN(seq) FROM audit_entries WHERE type = 'election.vote_cast')").run(`"election":"${w.eid}"`);
    const { count } = await closeAndCount(w); expect(count.json.reconciled).toBe(false); expect(count.json.problems.join(" ")).toContain("The signed trail has 6 online votes but the register has 7");
  });
});

// ------------------------------------------------------------------------------------------------------------------ 4. independence of the returning officer
describe("the returning officer is independent of the people who run the election", () => {
  test("the Organizer cannot be named the returning officer (set-up and update)", async () => {
    const b = await base({ voters: 6 });
    const r = await b.h.call("POST", `/api/lists/${b.sid}/elections`, { title: "Committee election", mode: "online", schedule: { nominationsOpen: "2026-11-12T10:00", nominationsClose: "2026-11-14T18:00", withdrawalClose: "2026-11-15T18:00", votingOpen: "2026-11-20T09:00", votingClose: "2026-11-20T18:00" }, posts: [{ title: "President", seats: 1 }], officials: { returningOfficer: { email: b.organizer, name: "The Organizer" } } }, b.jar);
    expect([r.status, r.json.code]).toEqual([409, "officer_is_organizer"]);
    expect(q({ h: b.h } as World, "SELECT COUNT(*) AS n FROM el_elections")[0]).toEqual({ n: 0 });
    const w = await draft(b);
    const u = await w.h.call("PATCH", staffUrl(w), { officials: { returningOfficer: { email: b.organizer, name: "The Organizer" } } }, b.jar); expect([u.status, u.json.code]).toEqual([409, "officer_is_organizer"]);
    expect(q(w, "SELECT email FROM el_officials WHERE role = 'returning_officer'")).toEqual([{ email: RO }]);
  });

  /** Old data: the returning officer is changed after the notice, the way a database that was made before this rule could hold it. */
  const swapOfficer = (w: World, email: string) => {
    for (const t of ["trg_el_officials_frozen_d", "trg_el_officials_frozen_i"]) w.h.raw.query(`DROP TRIGGER ${t}`).run();
    w.h.raw.query("DELETE FROM el_officials WHERE election_id = ? AND role = 'returning_officer'").run(w.eid);
    w.h.raw.query("INSERT INTO el_officials (election_id, email, role, name, added_at) VALUES (?, ?, 'returning_officer', 'X', 1)").run(w.eid, email);
  };

  test("a co-organizer may be the returning officer, but only the Organizer opens the voting", async () => {
    const w = await draft(await base({ voters: 8 }), { officials: { returningOfficer: { email: CO, name: "Co Officer" } } });
    expect(q(w, "SELECT email FROM el_officials WHERE role = 'returning_officer'")).toEqual([{ email: CO }]);
    await notice(w); w.h.clock.now = at("2026-11-12T11:00");
    for (const [i, p] of [[0, 0], [1, 0], [2, 1], [3, 1], [4, 1]]) await nominate(w, i!, p!);
    q(w, "UPDATE el_nominations SET status = 'accepted', decided_at = 1, decided_by = 'p_x'");
    w.h.clock.now = at("2026-11-15T19:00"); w.jar = await w.h.staff(w.organizer);
    expect((await w.h.call("POST", staffUrl(w, "/candidates/final"), { confirm: "FINAL" }, w.jar)).status).toBe(200);
    w.h.clock.now = at("2026-11-20T09:30"); w.jar = await w.h.staff(w.organizer); w.coJar = await w.h.staff(CO);
    expect((await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.coJar)).status).toBe(403);
    expect(q(w, "SELECT status FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "candidates_final" }]);
    expect((await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar)).status).toBe(200);
    expect(q(w, "SELECT status FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "voting" }]);
  });

  test("whoever opens the voting is not the returning officer (old data with the Organizer as officer is stopped at opening)", async () => {
    const w = await base({ voters: 8 }).then((b) => draft(b)); await toFinal(w);
    swapOfficer(w, w.organizer);
    w.h.clock.now = at("2026-11-20T09:30"); w.jar = await w.h.staff(w.organizer);
    const r = await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar); expect([r.status, r.json.code]).toEqual([409, "opener_is_officer"]);
    expect(q(w, "SELECT status, opened_at FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "candidates_final", opened_at: null }]);
  });

  test("an appeal is not decided by the returning officer, whoever made the first decision", async () => {
    const b = await base({ voters: 8 }); const w = await draft(b);
    // old data: the returning officer is the Organizer's e-mail ID, and the first decision carries another private code
    await notice(w); w.h.clock.now = at("2026-11-12T11:00"); const nid = (await nominate(w, 0, 0)).json.nomination.id as string; swapOfficer(w, b.organizer);
    q(w, "UPDATE el_nominations SET status = 'rejected', decided_at = ?, decided_by = 'p_someone_else', decision_reason = 'The seconder is not a voter.', appeal_status = 'open', appeal_text = 'The seconder is a voter.', appealed_at = ? WHERE id = ?", w.h.clock.now, w.h.clock.now, nid);
    const r = await w.h.call("POST", staffUrl(w, `/nominations/${nid}/appeal/decide`), { decision: "upheld", reason: "The seconder is on the list." }, b.jar);
    expect([r.status, r.json.code]).toEqual([409, "officer_appeal"]);
    expect(q(w, "SELECT status, appeal_status FROM el_nominations WHERE id = ?", nid)).toEqual([{ status: "rejected", appeal_status: "open" }]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 5. the locks the tamper tests drop are there, by name
describe("the election locks exist by name", () => {
  const names = (w: World) => q(w, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_el_%' ORDER BY name").map((x) => x.name as string);
  const ALL = [
    "trg_el_ballots_no_delete", "trg_el_ballots_no_update", "trg_el_challenges_no_delete", "trg_el_challenges_rewrite", "trg_el_counts_no_delete", "trg_el_counts_no_update", "trg_el_events_no_delete", "trg_el_events_no_update", "trg_el_no_delete", "trg_el_nominations_no_delete", "trg_el_officials_frozen_d", "trg_el_officials_frozen_i",
    "trg_el_officials_no_update", "trg_el_officials_not_candidates", "trg_el_posts_frozen_d", "trg_el_posts_frozen_i", "trg_el_posts_frozen_u", "trg_el_receipts_no_delete", "trg_el_receipts_no_update",
    "trg_el_rules_frozen", "trg_el_status_forward", "trg_el_voted_no_delete", "trg_el_voted_no_update", "trg_el_voting_end_later",
  ].sort();

  test("every trigger the migration makes is on the list, and none is missing (a rename fails here, with its name)", async () => {
    const w = await story(); const have = names(w);
    expect({ missing: ALL.filter((x) => !have.includes(x)), unlisted: have.filter((x) => !ALL.includes(x)) }).toEqual({ missing: [], unlisted: [] });
  });

  test("every trigger name that a test drops exists in the database", async () => {
    const w = await story(); const have = names(w).concat(q(w, "SELECT name FROM sqlite_master WHERE type = 'trigger'").map((x) => x.name as string));
    for (const f of ["elections-count", "elections-secrecy", "elections-audit-fixes"]) {
      const text = readFileSync(`${import.meta.dir}/${f}.test.ts`, "utf8");
      for (const m of text.matchAll(/DROP TRIGGER(?: IF EXISTS)? (trg_[a-z_]+)|drop\(\s*\w+\s*,\s*((?:"trg_[a-z_]+"\s*,?\s*)+)\)/g)) {
        for (const n of m[1] ? [m[1]] : [...m[2]!.matchAll(/"(trg_[a-z_]+)"/g)].map((x) => x[1]!)) expect([`${f}: a test drops a trigger that does not exist: ${n}`, have.includes(n)]).toEqual([`${f}: a test drops a trigger that does not exist: ${n}`, true]);
      }
    }
  });

  test("the ballot-update lock itself works: a changed sealed choice is refused and the row stays as it was", async () => {
    const w = await story(); await castAs(w, emailOf(0), pick(w, { 1: [1], 2: [3] }));
    const before = JSON.stringify(q(w, "SELECT * FROM el_ballots ORDER BY id"));
    expect(() => w.h.raw.query("UPDATE el_ballots SET sealed = 'x'").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("UPDATE el_ballots SET weight_milli = 5000").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("DELETE FROM el_ballots").run()).toThrow(/append-only/);
    expect(JSON.stringify(q(w, "SELECT * FROM el_ballots ORDER BY id"))).toBe(before);
    // with the lock dropped the same change goes through: the test above really exercised the trigger
    w.h.raw.query("DROP TRIGGER trg_el_ballots_no_update").run(); w.h.raw.query("UPDATE el_ballots SET weight_milli = 5000").run();
    expect(q(w, "SELECT DISTINCT weight_milli FROM el_ballots")).toEqual([{ weight_milli: 5000 }]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 6. the version notes name their own commit
describe("the version files agree", () => {
  const v = JSON.parse(readFileSync(`${import.meta.dir}/../public/version.json`, "utf8")); const pkg = JSON.parse(readFileSync(`${import.meta.dir}/../package.json`, "utf8"));
  test("the top-level commit is the newest entry's own commit, and both are real commit ids", () => {
    expect(v.changes[0].version).toBe(v.version); expect(pkg.version).toBe(v.version);
    expect(v.changes[0].commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(v.commit).toBe(v.changes[0].commit);
  });
  test("the changelog and the knowledge file carry the same version", () => {
    expect(readFileSync(`${import.meta.dir}/../CHANGELOG.md`, "utf8")).toContain(`## ${v.version}`);
    expect(readFileSync(`${import.meta.dir}/../KNOWLEDGE.md`, "utf8")).toContain(`**${v.version}**`);
  });
});
