// Results, first chunk, through the real API: the real handler, the real migrations on SQLite, a fake clock.
// A closed meeting or election is entered, a result is made from it, kept fixed, made final or corrected, shown to the public and checked.
import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "../src/results-core";
import { enrolVoter, makeHarness, newList, waiting, type R } from "./harness";

const H = 3_600_000, DAY = 86_400_000;
const must = (r: R, status: number): R => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${r.text.slice(0, 400)}`); return r; };

/** A list with four voters and a frozen final list; an attendance session that three of them attended; the clock set to the morning after the meeting closed. */
async function setup(o: { flag?: boolean; freeze?: boolean; attendance?: boolean; eventType?: "meeting" | "election"; retention?: boolean } = {}) {
  const h = await makeHarness({ ...(o.flag === false ? {} : { RESULTS_ENABLED: "1" }), ...(o.retention ? { RETENTION_DAYS: "30" } : {}) });
  const { jar, sid, slug } = await newList(h);
  const people: Array<[string, string, string, string]> = [["asha@sample.example", "A-1", "Asha Sample", "9000000201"], ["bharat@sample.example", "B-2", "Bharat Sample", "9000000202"], ["chitra@sample.example", "C-3", "Chitra Sample", "9000000203"], ["dev@sample.example", "D-4", "Dev Sample", "9000000204"]];
  for (const [email, unit, name, mobile] of people) await enrolVoter(h, slug, email, { unit, name, mobile });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const coJar = await h.staff("co@sample.example");
  const idOf = (e: string) => (h.raw.query("SELECT id FROM voters WHERE email = ?").get(e) as { id: string }).id;
  let pub = "", att = "";
  if (o.freeze !== false) {
    const f = must(await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: o.eventType === "election" ? "Committee election 2026" : "Annual general meeting 2026", eventType: o.eventType ?? "meeting", closeNow: true, ackWarnings: true, ackPending: true, confirm: "FREEZE" }, jar), 201);
    pub = f.json.id;
  }
  if (o.attendance !== false) {
    h.clock.now = Date.UTC(2026, 10, 12, 4, 30); // 10:00 in India
    att = must(await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Club house", startsAt: "2026-11-12T10:00", place: "Club house", mode: "in_person" }, jar), 201).json.session.id;
    for (const e of ["asha@sample.example", "bharat@sample.example", "chitra@sample.example"]) must(await h.call("POST", `/api/lists/${sid}/attendance/sessions/${att}/mark`, { voterId: idOf(e) }, jar), 200);
    h.clock.now = Date.UTC(2026, 10, 12, 14, 0); // 19:30 in India
    must(await h.call("POST", `/api/lists/${sid}/attendance/sessions/${att}/close`, {}, jar), 200);
  }
  h.clock.now = Date.UTC(2026, 10, 13, 6, 0); // the morning after: the meeting closed at 20:00 in India on the 12th
  return { h, jar, coJar, sid, slug, pub, att };
}
type S = Awaited<ReturnType<typeof setup>>;

const MOTIONS = [
  { text: "Approve the accounts for the year", for: 3, against: 0, abstain: 0 },
  { text: "Appoint the auditor", for: 2, against: 1 },
  { text: "Change the by-laws", for: 2, against: 1, threshold: "three_quarters" },
];
const meeting = (s: S, over: Record<string, unknown> = {}) => ({
  kind: "meeting", ref: "AGM-2026", title: "Owners assembly", closedAt: "2026-11-12T20:00", mode: "in_person", challengeHours: 2, attendanceId: s.att, quorum: { type: "count", value: 3 },
  countedBy: ["Asha Counter"], validatedBy: ["Vikram Validator"], observers: ["Omar Observer"], supervisedBy: ["Sunita Supervisor"], motions: MOTIONS, ...over,
});
const election = (s: S, over: Record<string, unknown> = {}) => ({
  kind: "election", ref: "EC-2026", title: "Committee election", closedAt: "2026-11-12T20:00", mode: "online", challengeHours: 1, attendanceId: s.att, ballots: 3, tieRule: "lot",
  countedBy: ["Asha Counter"], validatedBy: ["Vikram Validator"], observers: ["Omar Observer"], supervisedBy: ["Sunita Supervisor"],
  posts: [
    { name: "President", seats: 1, candidates: [{ name: "Asha Rao", votes: 2 }, { name: "Bharat Nair", votes: 1 }] },
    { name: "Committee members", seats: 2, candidates: [{ name: "Chitra Iyer", votes: 2 }, { name: "Dev Menon", votes: 1 }, { name: "Esha Pillai", votes: 1 }] },
  ], ...over,
});
const url = (s: S, rid = "", more = "") => `/api/lists/${s.sid}/results${rid ? "/" + rid : ""}${more}`;
const enter = (s: S, body: unknown, jar = s.jar) => s.h.call("POST", url(s, "closings"), body, jar);
const make = (s: S, closingId: string, jar = s.jar) => s.h.call("POST", url(s), { closingId }, jar);
const get = (s: S, rid = "", more = "", jar = s.jar) => s.h.call("GET", url(s, rid, more), undefined, jar);
const final = (s: S, rid: string, jar = s.jar, confirm = "FINAL") => s.h.call("POST", url(s, rid, "/final"), { confirm }, jar);
const visibility = (s: S, rid: string, v: string, jar = s.jar) => s.h.call("POST", url(s, rid, "/visibility"), { visibility: v }, jar);
const pubGet = (s: S, more = "") => s.h.call("GET", `/api/v/${s.slug}/results${more}`);
/** The closing, then the draft result made from it. */
async function declared(s: S, body?: unknown) {
  const c = must(await enter(s, body ?? meeting(s)), 201);
  const r = must(await make(s, c.json.closing.id), 201);
  return { c, r, id: r.json.result.id as string, fp: r.json.result.fingerprint as string };
}
const trailTypes = async (s: S) => ((await s.h.call("GET", `/api/lists/${s.sid}/audit/export.json`, undefined, s.jar)).json.entries as any[]).map((e) => e.entry.type as string);

describe("Results are dark until the flag is on", () => {
  test("without RESULTS_ENABLED every Results address answers not found, signed in or not, and nothing is written", async () => {
    for (const flag of [undefined, "0", "true", "yes"]) {
      const h = await makeHarness(flag === undefined ? {} : { RESULTS_ENABLED: flag }); const { jar, sid, slug } = await newList(h);
      const all: Array<[string, string]> = [
        ["GET", `/api/lists/${sid}/results`], ["POST", `/api/lists/${sid}/results`], ["GET", `/api/lists/${sid}/results/closings`], ["POST", `/api/lists/${sid}/results/closings`],
        ["GET", `/api/lists/${sid}/results/x`], ["GET", `/api/lists/${sid}/results/x/verify`], ["GET", `/api/lists/${sid}/results/x/export.csv`],
        ["POST", `/api/lists/${sid}/results/x/final`], ["POST", `/api/lists/${sid}/results/x/correct`], ["POST", `/api/lists/${sid}/results/x/visibility`],
        ["GET", `/api/v/${slug}/results`], ["GET", `/api/v/${slug}/results/x`], ["GET", `/api/v/${slug}/results/x/verify`],
      ];
      for (const [m, p] of all) for (const j of [jar, undefined]) { const r = await h.call(m, p, m === "GET" ? undefined : {}, j); expect([m, p, r.status, r.json?.code]).toEqual([m, p, 404, "not_found"]); }
      expect(h.raw.query("SELECT (SELECT COUNT(*) FROM res_closings) + (SELECT COUNT(*) FROM res_results) AS n").get()).toEqual({ n: 0 });
    }
  });
  test("with the flag on, a signed-out visitor is asked to sign in", async () => {
    const s = await setup({ freeze: false, attendance: false });
    const r = await s.h.call("GET", url(s)); expect(r.status).toBe(401); expect(r.json.code).toBe("signed_out");
  });
});

describe("a closed meeting is entered, and a result is made from it", () => {
  test("a full meeting: draft with computed outcomes, a challenge window, FINAL after it, and a signed trail with no personal data", async () => {
    const s = await setup(); const { r, id, fp } = await declared(s);
    expect(r.json.result).toMatchObject({ kind: "meeting", ref: "AGM-2026", version: 1, status: "draft", visibility: "hidden", failedChecks: 0, challengeOpen: true, canFinalize: false, supersedes: null, supersededBy: null });
    expect(r.json.result.challengeEndsAt).toBe(s.h.clock.now + 2 * H); expect(r.json.result.challengeEndsLocal).toBe("2026-11-13T13:30");
    expect(r.json.content.motions.map((m: any) => m.outcome)).toEqual(["passed", "passed", "not_passed"]);
    expect(r.json.content.checks.filter((c: any) => c.level === "fail")).toEqual([]);
    expect(r.json.content).toMatchObject({ quorum: { met: true, present: 3, required: 3 }, attendance: { present: 3, eligible: 4, status: "closed" }, list: { finalNo: 1, voters: 4, eventType: "meeting" }, source: "organizer", version: 1 });
    expect(r.json.headline).toEqual({ motions: 3, passed: 2, notPassed: 1, noVotes: 0 });
    expect(r.json.notice).toContain("challenge window is open until 2026-11-13T13:30");
    expect(r.json.result.auditSeq).toBe(r.json.audit);
    // during the window: refused, and nothing changes
    const early = await final(s, id); expect(early.status).toBe(409); expect(early.json.code).toBe("challenge_open"); expect(early.json.error).toContain("2026-11-13T13:30");
    s.h.clock.now += 3 * H;
    expect((await final(s, id, s.jar, "yes")).json.code).toBe("confirm");
    expect((await final(s, id, s.coJar)).status).toBe(403);
    const f = must(await final(s, id, s.jar, "final"), 200); // case does not matter
    expect(f.json.result).toMatchObject({ status: "final", finalizedAt: s.h.clock.now, canFinalize: false }); expect(f.json.result.finalAuditSeq).toBe(f.json.audit);
    expect(f.json.notice).toBe("This result is final.");
    expect((await final(s, id)).json.code).toBe("not_draft");
    // the signed trail names the steps, carries the fingerprint, verifies, and holds no personal data
    const trail = await s.h.call("GET", `/api/lists/${s.sid}/audit/export.json`, undefined, s.jar); expect(trail.json.verified).toBe(true);
    const e = (t: string) => trail.json.entries.find((x: any) => x.entry.type === t).entry;
    expect(e("results.declared").payload).toMatchObject({ result: id, fingerprint: fp, failed: 0, version: 1 }); expect(e("results.finalized").payload).toMatchObject({ result: id, fingerprint: fp });
    expect(trail.json.entries.map((x: any) => x.entry.type)).toEqual(expect.arrayContaining(["results.closing_entered", "results.declared", "results.finalized"]));
    for (const bad of ["Asha Counter", "Omar Observer", "Vikram", "Owners assembly", "AGM-2026", "sample.example", "9000000201", "Asha Sample"]) expect(trail.text).not.toContain(bad);
    // the database holds exactly what was declared
    expect(s.h.raw.query("SELECT status, failed_checks, fingerprint FROM res_results WHERE id = ?").get(id)).toEqual({ status: "final", failed_checks: 0, fingerprint: fp });
  });

  test("a result cannot be created by hand: extra fields are ignored, no address changes the numbers, and a second result is refused", async () => {
    const s = await setup(); const c = must(await enter(s, meeting(s)), 201);
    expect(c.json.closing).toMatchObject({ revision: 1, source: "organizer", kind: "meeting", ref: "AGM-2026" });
    const r = must(await s.h.call("POST", url(s), { closingId: c.json.closing.id, content: { motions: [] }, status: "final", visibility: "full", fingerprint: "0".repeat(64), failedChecks: 0, version: 5, challengeHours: 0 }, s.jar), 201);
    expect(r.json.result).toMatchObject({ status: "draft", visibility: "hidden", version: 1 }); expect(r.json.result.fingerprint).not.toBe("0".repeat(64)); expect(r.json.content.motions).toHaveLength(3);
    expect(r.json.result.challengeEndsAt).toBe(s.h.clock.now + 2 * H);
    for (const m of ["PUT", "PATCH", "DELETE"]) expect((await s.h.call(m, url(s, r.json.result.id), {}, s.jar)).status).toBe(404);
    const again = await make(s, c.json.closing.id); expect(again.status).toBe(409); expect(again.json.code).toBe("result_exists");
    const dup = await enter(s, meeting(s)); expect(dup.status).toBe(409); expect(dup.json.code).toBe("closing_exists");
    expect(await make(s, "")).toMatchObject({ status: 400 }); expect((await make(s, "")).json.code).toBe("need_closing");
    expect((await make(s, "rcl_nothere")).status).toBe(404);
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_results").get()).toEqual({ n: 1 });
  });

  test("no result without a final voter list", async () => {
    const s = await setup({ freeze: false, attendance: false });
    const c = must(await enter(s, meeting(s, { quorum: { type: "none" } })), 201);
    const r = await make(s, c.json.closing.id); expect(r.status).toBe(409); expect(r.json.code).toBe("no_final_list");
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_results").get()).toEqual({ n: 0 });
    // once the list is frozen the same closing makes a result; the list was frozen after the meeting closed, and the result says so
    must(await s.h.call("POST", `/api/lists/${s.sid}/publish/frozen`, { eventName: "Annual general meeting 2026", eventType: "meeting", closeNow: true, ackWarnings: true, ackPending: true, confirm: "FREEZE" }, s.jar), 201);
    const ok = must(await make(s, c.json.closing.id), 201);
    expect(ok.json.content.checks.find((k: any) => k.code === "list_frozen_late")).toMatchObject({ level: "fail" }); expect(ok.json.result.failedChecks).toBe(1);
  });

  test("what is refused when a closing is entered", async () => {
    const s = await setup();
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ kind: "vote" }, 400, "bad_kind"], [{ title: "x" }, 400, "bad_title"], [{ title: "Call 9876543210" }, 400, "contact_details"], [{ closedAt: "2026-12-30T10:00" }, 400, "future_close"],
      [{ closedAt: "nonsense" }, 400, "bad_time"], [{ motions: [] }, 400, "bad_motions"], [{ mode: "hybrid" }, 400, "bad_mode"], [{ challengeHours: 1000 }, 400, "bad_window"],
      [{ attendanceId: "att_doesnotexist" }, 404, "no_such_attendance"], [{ listPubId: "pub_doesnotexist" }, 404, "no_such_list"],
    ];
    for (const [over, status, code] of cases) { const r = await enter(s, meeting(s, over)); expect([JSON.stringify(over), r.status, r.json.code]).toEqual([JSON.stringify(over), status, code]); }
    expect((await s.h.call("POST", url(s, "closings"), [], s.jar)).status).toBe(400);
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_closings").get()).toEqual({ n: 0 });
  });

  test("only 30 closings an hour", async () => {
    const s = await setup({ attendance: false });
    for (let i = 0; i < 30; i++) must(await enter(s, meeting(s, { ref: `R-${i}`, quorum: { type: "none" } })), 201);
    const r = await enter(s, meeting(s, { ref: "R-30", quorum: { type: "none" } })); expect(r.status).toBe(429); expect(r.json.code).toBe("rate_limited");
  });

  test("the closing and its results are listed together", async () => {
    const s = await setup(); const { c, id } = await declared(s);
    const l = (await get(s, "closings")).json.closings; expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: c.json.closing.id, kind: "meeting", revision: 1, closedAtLocal: "2026-11-12T20:00", results: [{ id, version: 1, status: "draft" }] });
    expect((await get(s)).json.results[0]).toMatchObject({ id, title: "Owners assembly", closedAtLocal: "2026-11-12T20:00", headline: { motions: 3 } });
  });
});

describe("a failed check keeps a result from becoming final", () => {
  test("votes beyond the people marked present fail the result; FINAL is refused by the API and by the database", async () => {
    const s = await setup(); const { r, id } = await declared(s, meeting(s, { motions: [{ text: "Approve the accounts for the year", for: 4, against: 0 }] }));
    expect(r.json.result.failedChecks).toBe(1);
    expect(r.json.content.checks.find((c: any) => c.code === "votes_over_present")).toMatchObject({ level: "fail" });
    expect(r.json.notice).toContain("One or more checks failed");
    s.h.clock.now += 3 * H;
    const f = await final(s, id); expect(f.status).toBe(409); expect(f.json.code).toBe("failed_checks");
    expect(() => s.h.raw.query("UPDATE res_results SET status = 'final', finalized_at = 5, finalized_by = 'x' WHERE id = ?").run(id)).toThrow(/constraint/i);
    expect(s.h.raw.query("SELECT status FROM res_results WHERE id = ?").get(id)).toEqual({ status: "draft" });
  });

  test("a quorum that is not met, or cannot be checked, fails", async () => {
    const s = await setup();
    const a = await declared(s, meeting(s, { quorum: { type: "count", value: 4 } }));
    expect(a.r.json.content.checks.find((c: any) => c.code === "quorum")).toMatchObject({ level: "fail" }); expect(a.r.json.result.failedChecks).toBe(1);
    const b = await declared(s, meeting(s, { ref: "AGM-NOATT", attendanceId: undefined, quorum: { type: "percent", value: 50 } }));
    expect(b.r.json.content.checks.map((c: any) => `${c.code}:${c.level}`)).toEqual(expect.arrayContaining(["attendance_missing:warn", "quorum:fail"]));
    const c = await declared(s, meeting(s, { ref: "AGM-NOQ", attendanceId: undefined, quorum: { type: "none" } }));
    expect(c.r.json.result.failedChecks).toBe(0); expect(c.r.json.content.attendance).toBeNull();
  });

  test("a closing time before the final list was frozen fails; one entered late or by hand only carries a note", async () => {
    const s = await setup();
    const early = await declared(s, meeting(s, { closedAt: "2026-11-10T10:00" })); // the list was frozen on the 11th
    expect(early.r.json.content.checks.find((c: any) => c.code === "list_frozen_late")).toMatchObject({ level: "fail" });
    const ok = await declared(s, meeting(s, { ref: "AGM-OK" }));
    expect(ok.r.json.content.checks.filter((c: any) => c.level === "warn").map((c: any) => c.code)).toEqual(["entered_by_hand"]);
    s.h.clock.now += 9 * DAY; // the earlier sign-in has expired by now, so sign in again
    const jar = await s.h.staff("organizer@sample.example");
    const late = must(await enter(s, meeting(s, { ref: "AGM-LATE" }), jar), 201); const lr = must(await make(s, late.json.closing.id, jar), 201);
    expect(lr.json.content.checks.find((c: any) => c.code === "late_entry")).toMatchObject({ level: "warn" }); expect(lr.json.result.failedChecks).toBe(0);
  });
});

describe("an election", () => {
  test("posts, an unsettled tie that blocks FINAL, then a correction that settles it and goes final", async () => {
    const s = await setup({ eventType: "election" }); const { r, id } = await declared(s, election(s));
    const posts = r.json.content.election.posts;
    expect(posts[0]).toMatchObject({ name: "President", winners: ["Asha Rao"], tie: null, uncontested: false });
    expect(posts[1]).toMatchObject({ name: "Committee members", winners: ["Chitra Iyer"], tie: { open: 1, among: ["Dev Menon", "Esha Pillai"], decidedBy: null } });
    expect(r.json.content.election.turnoutBp).toBe(7500); expect(r.json.headline).toEqual({ posts: 2, seats: 3, ballots: 3 });
    expect(r.json.content.checks.find((c: any) => c.code === "tie_unsettled")).toMatchObject({ level: "fail" }); expect(r.json.result.failedChecks).toBe(1);
    s.h.clock.now += 2 * H; expect((await final(s, id)).json.code).toBe("failed_checks");
    const settled = election(s, { posts: [election(s).posts[0], { ...election(s).posts[1], tieWinners: ["Esha Pillai"] }] });
    const c = must(await s.h.call("POST", url(s, id, "/correct"), { reason: "The tie for the last seat was settled by lot", closing: settled }, s.jar), 201);
    expect(c.json.result).toMatchObject({ version: 2, supersedes: id, failedChecks: 0, status: "draft" });
    expect(c.json.content.election.posts[1]).toMatchObject({ winners: ["Chitra Iyer", "Esha Pillai"], tie: { decidedBy: "lot" } });
    s.h.clock.now += 2 * H; must(await final(s, c.json.result.id), 200);
    expect((await get(s, id)).json.result).toMatchObject({ status: "superseded", supersededBy: c.json.result.id });
  });
  test("ballots beyond the final list, or winners of a tie that do not fit, are refused or flagged", async () => {
    const s = await setup({ eventType: "election" });
    const bad = await enter(s, election(s, { posts: [{ name: "President", seats: 1, candidates: [{ name: "Asha Rao", votes: 1 }, { name: "Bharat Nair", votes: 1 }], tieWinners: ["Chitra Iyer"] }] }));
    expect(bad.status).toBe(400); expect(bad.json.code).toBe("bad_tie_winners"); expect(bad.json.error).toContain("President");
    const many = await declared(s, election(s, { ballots: 5 })); expect(many.r.json.content.checks.find((c: any) => c.code === "ballots_over_list")).toMatchObject({ level: "fail" });
  });
});

describe("a correction replaces a result and keeps the old one", () => {
  test("a final result is corrected with a reason; the old one stays, marked as replaced, and a chain forms", async () => {
    const s = await setup(); const { r, id, fp } = await declared(s);
    s.h.clock.now += 3 * H; must(await final(s, id), 200);
    const fixed = meeting(s, { motions: [MOTIONS[0], { text: "Appoint the auditor", for: 1, against: 2 }, MOTIONS[2]] });
    const corr = (rid: string, body: Record<string, unknown>, jar = s.jar) => s.h.call("POST", url(s, rid, "/correct"), body, jar);
    expect((await corr(id, { reason: "x", closing: fixed })).json.code).toBe("bad_reason");
    expect((await corr(id, { reason: "The votes were copied the wrong way round", closing: meeting(s, { ref: "OTHER-1" }) })).json.code).toBe("same_process");
    expect((await corr(id, { reason: "The votes were copied the wrong way round", closing: { ...fixed, kind: "election" } })).status).toBe(400);
    expect((await corr(id, { reason: "The votes were copied the wrong way round", closing: fixed }, s.coJar)).status).toBe(403);
    expect((await corr(id, { reason: "Call 9876543210 for details", closing: fixed })).json.code).toBe("contact_details");
    const reason = "The votes on the second motion were copied the wrong way round";
    const c = must(await corr(id, { reason, closing: fixed }), 201);
    expect(c.json.result).toMatchObject({ version: 2, supersedes: id, status: "draft", visibility: "hidden", failedChecks: 0 }); expect(c.json.closing).toMatchObject({ revision: 2, kind: "meeting" });
    expect(c.json.content.correction).toEqual({ reason, supersedesFp: fp }); expect(c.json.content.motions[1].outcome).toBe("not_passed");
    // the old one is still there, unchanged, and says where it went
    const old = (await get(s, id)).json; expect(old.result).toMatchObject({ status: "superseded", supersededBy: c.json.result.id, version: 1, fingerprint: fp }); expect(old.content.motions[1].outcome).toBe("passed");
    expect(old.notice).toContain("replaced by a correction");
    expect((await get(s)).json.results.map((x: any) => [x.version, x.status, x.supersedes === null ? null : "old"])).toEqual([[2, "draft", "old"], [1, "superseded", null]]);
    // it cannot be corrected twice, and the database allows only one live result for one meeting
    expect((await corr(id, { reason, closing: fixed })).json.code).toBe("already_corrected");
    const closingId = (s.h.raw.query("SELECT closing_id FROM res_results WHERE id = ?").get(c.json.result.id) as { closing_id: string }).closing_id;
    expect(() => s.h.raw.query("INSERT INTO res_results (id, society_id, closing_id, kind, ref, version, status, content_json, fingerprint, challenge_ends_at, audit_seq, created_by, created_at) VALUES ('x', ?, ?, 'meeting', 'AGM-2026', 9, 'draft', '{}', ?, 1, 1, 'p', 1)").run(s.sid, closingId, "a".repeat(64))).toThrow(/UNIQUE/);
    // a third version follows the second
    s.h.clock.now += 3 * H;
    const c3 = must(await corr(c.json.result.id, { reason: "One more count was wrong", closing: meeting(s, { motions: [MOTIONS[0], { text: "Appoint the auditor", for: 1, against: 2 }, { text: "Change the by-laws", for: 3, against: 0, threshold: "three_quarters" }] }) }), 201);
    expect(c3.json.result).toMatchObject({ version: 3, supersedes: c.json.result.id }); expect(c3.json.closing.revision).toBe(3);
    expect((await get(s, c.json.result.id)).json.result.status).toBe("superseded");
    expect(await trailTypes(s)).toEqual(expect.arrayContaining(["results.corrected"]));
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_results WHERE status <> 'superseded'").get()).toEqual({ n: 1 });
  });

  test("a correction keeps the visibility the old result had", async () => {
    const s = await setup(); const { id } = await declared(s); must(await visibility(s, id, "masked"), 200);
    const c = must(await s.h.call("POST", url(s, id, "/correct"), { reason: "A count was copied wrongly", closing: meeting(s) }, s.jar), 201);
    expect(c.json.result.visibility).toBe("masked");
    expect((await visibility(s, id, "hidden")).json.code).toBe("already_corrected"); // the old result is fixed now
  });
});

describe("a declared result is fixed in the database", () => {
  test("the numbers, the fingerprint, the window and the closing cannot be changed or deleted, whatever the code does", async () => {
    const s = await setup(); const { id } = await declared(s);
    const q = (sql: string, ...p: unknown[]) => () => s.h.raw.query(sql).run(...(p as never[]));
    expect(q("UPDATE res_results SET content_json = '{}' WHERE id = ?", id)).toThrow(/immutable/);
    expect(q("UPDATE res_results SET fingerprint = ? WHERE id = ?", "b".repeat(64), id)).toThrow(/immutable/);
    expect(q("UPDATE res_results SET challenge_ends_at = 1 WHERE id = ?", id)).toThrow(/immutable/);
    expect(q("UPDATE res_results SET failed_checks = 9 WHERE id = ?", id)).toThrow(/immutable/);
    expect(q("UPDATE res_closings SET payload_json = '{}'")).toThrow(/append-only/);
    expect(q("DELETE FROM res_closings")).toThrow(/append-only/);
    expect(q("DELETE FROM res_results")).toThrow(/immutable/);
    expect(q("INSERT INTO res_results (id, society_id, closing_id, kind, ref, version, status, content_json, fingerprint, challenge_ends_at, audit_seq, created_by, created_at, finalized_at) VALUES ('y', ?, 'z', 'meeting', 'Q', 1, 'final', '{}', ?, 1, 1, 'p', 1, 1)", s.sid, "a".repeat(64))).toThrow(/draft/);
    expect(q("UPDATE res_results SET visibility = 'masked' WHERE id = ?", id)).not.toThrow(); // the only thing the Organizer may change on a draft, apart from FINAL and a correction
    s.h.clock.now += 3 * H; must(await final(s, id), 200);
    expect(q("UPDATE res_results SET status = 'draft', finalized_at = NULL WHERE id = ?", id)).toThrow(/immutable/);
    expect(q("UPDATE res_results SET finalized_by = 'x' WHERE id = ?", id)).toThrow(/immutable/);
    expect(q("UPDATE res_results SET final_audit_seq = 1 WHERE id = ?", id)).toThrow(/immutable/);
    expect(q("UPDATE res_results SET superseded_at = 5 WHERE id = ?", id)).toThrow(/constraint/i); // not marked as replaced while it is still the live result
    expect(s.h.raw.query("SELECT status FROM res_results WHERE id = ?").get(id)).toEqual({ status: "final" });
    // once a correction has replaced it, nothing about the old result can change any more, not even who may see it
    must(await s.h.call("POST", url(s, id, "/correct"), { reason: "A count was copied wrongly", closing: meeting(s) }, s.jar), 201);
    expect(s.h.raw.query("SELECT status FROM res_results WHERE id = ?").get(id)).toEqual({ status: "superseded" });
    for (const sql of ["UPDATE res_results SET visibility = 'full' WHERE id = ?", "UPDATE res_results SET status = 'final' WHERE id = ?", "UPDATE res_results SET status = 'draft', finalized_at = NULL, superseded_at = NULL WHERE id = ?", "UPDATE res_results SET superseded_at = 1 WHERE id = ?"]) expect(q(sql, id)).toThrow(/immutable/);
  });
});

describe("anyone can check a result", () => {
  test("the stored result gives its fingerprint, the signed entries carry it, a code typed from paper is compared", async () => {
    const s = await setup(); const { r, id } = await declared(s);
    const v = async (q = "") => s.h.call("GET", url(s, id, "/verify" + q), undefined, s.jar);
    expect((await v()).json).toMatchObject({ intact: true, ok: true, declared: { valid: true, carries: true }, final: null, claim: null, algorithm: "Ed25519" });
    const short = r.json.result.fingerprintShort as string; expect(short).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect((await v("?code=" + encodeURIComponent(short.toLowerCase()))).json.claim).toEqual({ given: true, matches: true });
    expect((await v("?code=0000-0000-0000-0000")).json.claim).toEqual({ given: true, matches: false });
    expect((await v("?code=abc")).json.code).toBe("short_code");
    s.h.clock.now += 3 * H; must(await final(s, id), 200);
    expect((await v()).json).toMatchObject({ intact: true, ok: true, status: "final", final: { valid: true, carries: true } });
  });

  test("a result changed behind the scenes is caught, whether or not its fingerprint was rewritten too", async () => {
    const s = await setup(); const { id } = await declared(s);
    const v = async () => (await s.h.call("GET", url(s, id, "/verify"), undefined, s.jar)).json;
    s.h.raw.exec("DROP TRIGGER trg_res_results_fixed"); // somebody with access to the database removes the guard
    s.h.raw.query("UPDATE res_results SET content_json = replace(content_json, '\"for\":3', '\"for\":9') WHERE id = ?").run(id);
    expect(await v()).toMatchObject({ intact: false, ok: false, declared: { valid: true, carries: true } });
    const row = s.h.raw.query("SELECT content_json FROM res_results WHERE id = ?").get(id) as { content_json: string };
    s.h.raw.query("UPDATE res_results SET fingerprint = ? WHERE id = ?").run(await fingerprintOf(JSON.parse(row.content_json)), id);
    expect(await v()).toMatchObject({ intact: true, ok: false, declared: { valid: true, carries: false } }); // the signed entry still carries the original fingerprint
  });
});

describe("what the public may see", () => {
  test("hidden until the Organizer chooses; masked names, then full names; never an e-mail ID or a phone number", async () => {
    const s = await setup(); const { id } = await declared(s);
    expect((await pubGet(s)).json.results).toEqual([]);
    const hid = await pubGet(s, `/${id}`); expect([hid.status, hid.json.code]).toEqual([404, "not_found"]);
    expect((await pubGet(s, "/res_doesnotexist")).status).toBe(404); expect((await pubGet(s, `/${id}/verify`)).status).toBe(404);
    const v = must(await visibility(s, id, "masked"), 200); expect(v.json).toMatchObject({ changed: true, result: { visibility: "masked" } });
    const list = await pubGet(s); expect(list.status).toBe(200); expect(list.headers.get("x-robots-tag")).toBe("noindex");
    expect(list.json.results).toHaveLength(1); expect(list.json.results[0]).toMatchObject({ id, title: "Owners assembly", status: "draft", headline: { motions: 3, passed: 2 } });
    const one = await pubGet(s, `/${id}`); expect(one.status).toBe(200);
    expect(one.json.content.signoff).toEqual({ countedBy: ["As**** Co****"], validatedBy: ["Vi**** Va****"], observers: ["Om**** Ob****"], supervisedBy: ["Su**** Su****"] });
    expect(one.json.notice).toContain("challenge window is open until 2026-11-13T13:30");
    for (const bad of ["Asha Counter", "Omar Observer", "sample.example", "9000000201", "Asha Sample", "Bharat Sample", "voterId"]) expect(one.text).not.toContain(bad);
    expect(one.json.content.motions).toHaveLength(3); expect(one.json.content.checks.length).toBeGreaterThan(3); // the warnings are shown too
    must(await visibility(s, id, "full"), 200);
    const full = await pubGet(s, `/${id}`); expect(full.json.content.signoff.countedBy).toEqual(["Asha Counter"]);
    for (const bad of ["sample.example", "9000000201", "Asha Sample"]) expect(full.text).not.toContain(bad);
    expect((await s.h.call("GET", `/api/v/${s.slug}/results/${id}/verify`)).json).toMatchObject({ ok: true, intact: true });
    must(await visibility(s, id, "hidden"), 200); expect((await pubGet(s, `/${id}`)).status).toBe(404); expect((await pubGet(s)).json.results).toEqual([]);
  });

  test("changing the visibility is for the Organizer, is checked, is written to the trail, and a repeat changes nothing", async () => {
    const s = await setup(); const { id } = await declared(s);
    expect((await visibility(s, id, "full", s.coJar)).status).toBe(403);
    expect((await visibility(s, id, "everyone")).json.code).toBe("bad_visibility");
    must(await visibility(s, id, "masked"), 200);
    const same = must(await visibility(s, id, "masked"), 200); expect(same.json.changed).toBe(false);
    expect((await trailTypes(s)).filter((t) => t === "results.visibility")).toHaveLength(1);
  });

  test("a final result says so, a replaced one says where it went, and a public code check works", async () => {
    const s = await setup(); const { r, id } = await declared(s); must(await visibility(s, id, "masked"), 200);
    s.h.clock.now += 3 * H; must(await final(s, id), 200);
    expect((await pubGet(s, `/${id}`)).json.notice).toBe("This result is final.");
    const short = r.json.result.fingerprintShort as string;
    expect((await s.h.call("GET", `/api/v/${s.slug}/results/${id}/verify?code=${encodeURIComponent(short)}`)).json).toMatchObject({ ok: true, claim: { matches: true }, final: { valid: true } });
    expect((await s.h.call("GET", `/api/v/${s.slug}/results/${id}/verify?code=abc`)).status).toBe(400);
    must(await s.h.call("POST", url(s, id, "/correct"), { reason: "A count was copied wrongly", closing: meeting(s) }, s.jar), 201);
    const old = await pubGet(s, `/${id}`); expect(old.json.notice).toContain("replaced by a correction"); expect(old.json.result.supersededBy).toBeTruthy();
    expect((await pubGet(s)).json.results.map((x: any) => x.version)).toEqual([2, 1]); // the correction inherited "masked", so both are shown
  });
});

describe("who may do what, and one list never sees another's results", () => {
  test("the Organizer writes; a co-organizer reads with names masked; a stranger gets not found; a signed-out visitor is asked to sign in", async () => {
    const s = await setup(); const { id } = await declared(s);
    expect((await enter(s, meeting(s, { ref: "X-1" }), s.coJar)).status).toBe(403);
    expect((await make(s, "rcl_x", s.coJar)).status).toBe(403);
    expect((await s.h.call("POST", url(s, id, "/correct"), { reason: "A count was copied wrongly", closing: meeting(s) }, s.coJar)).status).toBe(403);
    for (const p of ["", "closings", id, id + "/verify", id + "/export.csv"]) expect([p, (await get(s, p, "", s.coJar)).status]).toEqual([p, 200]);
    const co = (await get(s, id, "", s.coJar)).json, org = (await get(s, id)).json;
    expect(org.content.signoff.countedBy).toEqual(["Asha Counter"]); expect(co.content.signoff.countedBy[0]).toMatch(/^Ash\*+ Cou\*+$/); expect(JSON.stringify(co)).not.toContain("Asha Counter");
    const other = await newList(s.h, { email: "other@sample.example" });
    for (const [m, p] of [["GET", url(s)], ["GET", url(s, id)], ["GET", url(s, "closings")], ["POST", url(s, "closings")], ["POST", url(s)], ["GET", url(s, id, "/verify")], ["GET", url(s, id, "/export.csv")], ["POST", url(s, id, "/final")], ["POST", url(s, id, "/visibility")]] as const) {
      const r = await s.h.call(m, p, m === "GET" ? undefined : {}, other.jar); expect([m, p, r.status]).toEqual([m, p, 404]);
      const u = await s.h.call(m, p, m === "GET" ? undefined : {}); expect([m, p, u.status]).toEqual([m, p, 401]);
    }
  });

  test("another list's results, attendance sessions and final lists are not reachable", async () => {
    const s = await setup(); const { id } = await declared(s);
    const other = await newList(s.h, { email: "other@sample.example" });
    const o = (over: Record<string, unknown>) => s.h.call("POST", `/api/lists/${other.sid}/results/closings`, meeting(s, { quorum: { type: "none" }, ...over }), other.jar);
    expect((await o({ attendanceId: s.att })).json.code).toBe("no_such_attendance");
    expect((await o({ listPubId: s.pub })).json.code).toBe("no_such_list");
    expect((await s.h.call("GET", `/api/lists/${other.sid}/results/${id}`, undefined, other.jar)).status).toBe(404);
    expect((await s.h.call("GET", `/api/lists/${other.sid}/results`, undefined, other.jar)).json.results).toEqual([]);
    expect((await s.h.call("GET", `/api/v/${other.slug}/results/${id}`)).status).toBe(404);
  });
});

describe("the sheet, the timeline and the erase", () => {
  test("the sheet carries the result and its fingerprint, is safe in a spreadsheet, masks names for a co-organizer and leaves a line in the trail", async () => {
    const s = await setup(); const { r, id } = await declared(s, meeting(s, { motions: [{ text: "=HYPERLINK(1)", for: 3, against: 0 }] }));
    const csv = await get(s, id, "/export.csv"); expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv"); expect(csv.headers.get("content-disposition")).toContain("result-meeting-v1.csv");
    for (const want of [r.json.result.fingerprint, "Owners assembly", "Asha Counter", "'=HYPERLINK(1)", "Passed", "AGM-2026"]) expect(csv.text).toContain(want);
    expect(csv.text).not.toContain(",=HYPERLINK"); expect(csv.text).not.toContain("sample.example");
    const co = await get(s, id, "/export.csv", s.coJar); expect(co.text).not.toContain("Asha Counter"); expect(co.text).toContain("Ash******");
    expect((await trailTypes(s)).filter((t) => t === "results.exported")).toHaveLength(2);
  });

  test("the timeline lists every step in the order it happened", async () => {
    const s = await setup(); const { id } = await declared(s); s.h.clock.now += 3 * H; must(await final(s, id), 200);
    const t = (await get(s, id)).json.timeline as Array<{ at: number; local: string; code: string }>;
    expect(t.map((x) => x.code)).toEqual(["list_frozen", "attendance_start", "attendance_closed", "process_closed", "result_made", "challenge_ends", "finalized"]);
    expect(t.map((x) => x.at)).toEqual([...t.map((x) => x.at)].sort((a, b) => a - b));
    expect(t.find((x) => x.code === "process_closed")?.local).toBe("2026-11-12T20:00"); expect(t.find((x) => x.code === "attendance_start")?.local).toBe("2026-11-12T10:00");
  });

  test("erasing the list takes the results and closings with it, the signed trail stays and still verifies, and every Results address answers gone", async () => {
    const s = await setup({ retention: true }); const { id } = await declared(s); s.h.clock.now += 3 * H; must(await final(s, id), 200);
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_results").get()).toEqual({ n: 1 });
    s.h.clock.now += 400 * DAY; const j2 = await s.h.staff("organizer@sample.example");
    must(await s.h.call("POST", `/api/lists/${s.sid}/erase`, { confirm: "ERASE" }, j2), 200);
    expect(s.h.raw.query("SELECT (SELECT COUNT(*) FROM res_results) AS r, (SELECT COUNT(*) FROM res_closings) AS c").get()).toEqual({ r: 0, c: 0 });
    const j3 = await s.h.staff("organizer@sample.example");
    const trail = await s.h.call("GET", `/api/lists/${s.sid}/audit/export.json`, undefined, j3); expect(trail.json.verified).toBe(true);
    expect(trail.json.entries.map((x: any) => x.entry.type)).toEqual(expect.arrayContaining(["results.declared", "results.finalized", "list.erased"]));
    for (const [m, p] of [["GET", url(s)], ["GET", url(s, id)], ["POST", url(s, "closings")]] as const) expect([m, p, (await s.h.call(m, p, m === "GET" ? undefined : {}, j3)).status]).toEqual([m, p, 410]);
    for (const p of ["", `/${id}`]) expect((await pubGet(s, p)).status).toBe(410);
  });
});

describe("two requests at the same moment", () => {
  test("one wins and the other gets a plain 409: one closing, one live result, one FINAL, one correction", async () => {
    const s = await setup();
    const codes = (rs: R[]) => rs.map((r) => r.status).sort();
    const loser = (rs: R[], status: number) => rs.find((r) => r.status === status)!;
    const two = await Promise.all([enter(s, meeting(s)), enter(s, meeting(s))]);
    expect(codes(two)).toEqual([201, 409]); expect(loser(two, 409).json.code).toBe("closing_exists");
    const cid = loser(two, 201).json.closing.id;
    const made = await Promise.all([make(s, cid), make(s, cid)]);
    expect(codes(made)).toEqual([201, 409]); expect(loser(made, 409).json.code).toBe("result_exists");
    const id = loser(made, 201).json.result.id;
    expect(s.h.raw.query("SELECT (SELECT COUNT(*) FROM res_closings) AS c, (SELECT COUNT(*) FROM res_results) AS r").get()).toEqual({ c: 1, r: 1 });
    s.h.clock.now += 3 * H;
    const fin = await Promise.all([final(s, id), final(s, id)]);
    expect(codes(fin)).toEqual([200, 409]);
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM audit_entries WHERE type = 'results.finalized'").get()).toEqual({ n: 1 });
    const body = { reason: "A count was copied wrongly", closing: meeting(s, { motions: [MOTIONS[0], { text: "Appoint the auditor", for: 1, against: 2 }, MOTIONS[2]] }) };
    const cor = await Promise.all([s.h.call("POST", url(s, id, "/correct"), body, s.jar), s.h.call("POST", url(s, id, "/correct"), body, s.jar)]);
    expect(codes(cor)).toEqual([201, 409]); expect(loser(cor, 409).json.code).toBe("already_corrected");
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_results WHERE status <> 'superseded'").get()).toEqual({ n: 1 });
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM res_closings").get()).toEqual({ n: 2 });
    const trail = await s.h.call("GET", `/api/lists/${s.sid}/audit/export.json`, undefined, s.jar); expect(trail.json.verified).toBe(true);
  });
});

describe("a list made from an uploaded attendance sheet has no Results", () => {
  test("it has no final voter list, so every Results address answers not found for it, for staff and for the public", async () => {
    const h = await makeHarness({ RESULTS_ENABLED: "1" }); const jar = await h.staff("solo@sample.example");
    const sheet = "Flat / House / Member ID,Name,Mobile,E-mail\nA-1,Asha Sample,9000000201,asha@sample.example\nA-2,Bharat Sample,9000000202,bharat@sample.example";
    const up = must(await h.call("POST", "/api/attendance/rosters", { title: "Spring meeting list", format: "paste", text: sheet }, jar), 201);
    const sid = up.json.list.id as string, slug = (up.json.list.link as string).split("/").pop()!;
    for (const [m, p] of [["GET", `/api/lists/${sid}/results`], ["POST", `/api/lists/${sid}/results/closings`], ["POST", `/api/lists/${sid}/results`], ["GET", `/api/v/${slug}/results`]] as const) {
      const r = await h.call(m, p, m === "GET" ? undefined : {}, jar); expect([m, p, r.status]).toEqual([m, p, 404]);
    }
    expect(h.raw.query("SELECT (SELECT COUNT(*) FROM res_closings) + (SELECT COUNT(*) FROM res_results) AS n").get()).toEqual({ n: 0 });
  });
});
