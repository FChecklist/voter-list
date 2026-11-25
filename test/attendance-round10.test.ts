// Round 10 fix for Attendance (version 0.3.5): a withdrawn voter who has an attendance mark can be purged; sign-in never fails because of the purge; undo of a marked record is refused plainly.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { purgeStale } from "../src/auth";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";
import { read } from "./scan";

const DAY = 86_400_000;
const q = (h: { raw: any }, sql: string, ...a: unknown[]) => h.raw.query(sql).get(...a) as Record<string, number>;

async function markedList() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  const asha = await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
  const bharat = await enrolVoter(h, slug, "bharat@sample.example", { unit: "B-2", name: "Bharat Sample", mobile: "9000000202" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  const made = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode: "online" }, jar);
  expect(made.status).toBe(201);
  const aid = made.json.session.id as string;
  for (const v of [asha, bharat]) expect((await h.call("POST", `/api/lists/${sid}/attendance/sessions/${aid}/mark`, { voterId: v.rec.id }, jar)).status).toBe(200);
  return { h, jar, sid, slug, aid, asha, bharat };
}

describe("1. a withdrawn voter with an attendance mark is purged after 30 days", () => {
  test("purgeStale does not throw; the voter and the mark are gone; the other voter's mark and the present count are as documented", async () => {
    const f = await markedList(); const { h } = f;
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks")).toEqual({ n: 2 });
    expect((await h.call("POST", `/api/v/${f.slug}/records/${f.asha.rec.id}/withdraw`, {}, f.asha.jar)).status).toBe(200);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ? AND status = 'removed'", f.asha.rec.id)).toEqual({ n: 1 }); // withdrawn, still on file for 30 days
    h.clock.now += 31 * DAY;
    await purgeStale(h.env, h.clock.now);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ?", f.asha.rec.id)).toEqual({ n: 0 });
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.asha.rec.id)).toEqual({ n: 0 });
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.bharat.rec.id)).toEqual({ n: 1 }); // a person who did not withdraw keeps the mark
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ?", f.bharat.rec.id)).toEqual({ n: 1 });
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE session_id = ?", f.aid)).toEqual({ n: 1 }); // documented: the purged person's mark is deleted, so the present count drops by one
  });

  test("a mark of a person still on the list cannot be deleted (append-only still holds)", async () => {
    const f = await markedList();
    expect(() => f.h.raw.query("DELETE FROM att_marks WHERE voter_id = ?").run(f.bharat.rec.id)).toThrow();
    expect(q(f.h, "SELECT COUNT(*) AS n FROM att_marks")).toEqual({ n: 2 });
  });
});

/** Wraps the database: `onPrepare(sql)` may return a hook for the statement; `batchFails(sqls)` makes a batch throw. Statements are tracked by their text. */
function spy(h: { env: any }, o: { afterFirst?: (sql: string) => void; failBatchOn?: RegExp }) {
  const real = h.env.DB;
  const wrap = (st: any, sql: string): any => new Proxy(st, { get(t, p) {
    if (p === "__sql") return sql;
    if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
    if (p === "first" && o.afterFirst) return async (...a: unknown[]) => { const r = await t.first(...a); o.afterFirst!(sql); return r; };
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  h.env.DB = new Proxy(real, { get(t, p) {
    if (p === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
    if (p === "batch" && o.failBatchOn) return (sts: any[]) => { if (sts.some((x) => o.failBatchOn!.test(x.__sql ?? ""))) throw new Error("forced batch failure"); return t.batch(sts.map((x) => x.__sql !== undefined ? x : x)); };
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  return () => { h.env.DB = real; };
}

describe("2. sign-in survives a failing purge", () => {
  test("purgeStale itself throws (its batch on the withdrawn-voter delete fails): sign-in answers 200 and one error line with no personal data is logged", async () => {
    const f = await markedList(); const { h } = f;
    expect((await h.call("POST", `/api/v/${f.slug}/records/${f.asha.rec.id}/withdraw`, {}, f.asha.jar)).status).toBe(200);
    h.clock.now += 31 * DAY;
    const restore = spy(h, { failBatchOn: /^DELETE FROM voters WHERE status = 'removed'/ });
    const orig = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    (globalThis.crypto as any).getRandomValues = (u: Uint32Array) => { u.fill(0); return u; }; // only to make the purge run on this request; the failure is the batch
    const lines: string[] = []; const quiet = console.error; console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await expect(purgeStale(h.env, h.clock.now)).rejects.toThrow("forced batch failure");
      const r = await h.call("POST", `/api/v/${f.slug}/start`, { email: "someone@sample.example" });
      expect(r.status).toBe(200);
    } finally { (globalThis.crypto as any).getRandomValues = orig; console.error = quiet; restore(); }
    expect(lines).toContain("purgeStale failed");
    expect(lines.join(" ")).not.toMatch(/sample\.example|Asha|Bharat|9000000/);
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.asha.rec.id)).toEqual({ n: 1 }); // the failed batch changed nothing
  });
});

describe("2b. the database lets a mark go only through the purge", () => {
  test("a voter who is only removed (not withdrawn, not past 30 days) keeps the mark: the delete is refused", async () => {
    const f = await markedList(); const { h } = f;
    expect((await h.call("POST", `/api/lists/${f.sid}/records/remove`, { ids: [f.asha.rec.id], reason: "left the society" }, f.jar)).status).toBe(200);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ? AND status = 'removed'", f.asha.rec.id)).toEqual({ n: 1 });
    expect(() => h.raw.query("DELETE FROM att_marks WHERE voter_id = ?").run(f.asha.rec.id)).toThrow();
    h.clock.now += 31 * DAY; await purgeStale(h.env, h.clock.now); // removed by the team, not withdrawn: not purged even after 30 days
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.asha.rec.id)).toEqual({ n: 1 });
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ?", f.asha.rec.id)).toEqual({ n: 1 });
  });
  test("a withdrawn voter inside the 30 days is not purged and the mark stays; a stray purge marker is cleared by the purge", async () => {
    const f = await markedList(); const { h } = f;
    expect((await h.call("POST", `/api/v/${f.slug}/records/${f.asha.rec.id}/withdraw`, {}, f.asha.jar)).status).toBe(200);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ? AND status = 'removed'", f.asha.rec.id)).toEqual({ n: 1 });
    h.clock.now += 5 * DAY; await purgeStale(h.env, h.clock.now);
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.asha.rec.id)).toEqual({ n: 1 });
    expect(() => h.raw.query("DELETE FROM att_marks WHERE voter_id = ?").run(f.asha.rec.id)).toThrow();
    h.clock.now += 30 * DAY; await purgeStale(h.env, h.clock.now);
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.asha.rec.id)).toEqual({ n: 0 });
    expect(q(h, "SELECT COUNT(*) AS n FROM att_purge")).toEqual({ n: 0 });
  });
});

describe("3. undo of a record that already has an attendance mark", () => {
  test("is refused with 409 and plain words, and nothing changes", async () => {
    const f = await markedList(); const { h } = f;
    const add = await h.call("POST", `/api/lists/${f.sid}/records`, { unit: "C-3", name: "Chitra Sample", capacity: "Owner", mobile: "9000000203", email: "chitra@sample.example", agreed: true }, f.jar);
    expect(add.status).toBe(201);
    expect((await h.call("POST", `/api/lists/${f.sid}/attendance/sessions/${f.aid}/mark`, { voterId: add.json.id }, f.jar)).status).toBe(200);
    const acts = (await h.call("GET", `/api/lists/${f.sid}/actions`, undefined, f.jar)).json.actions;
    const key = acts.find((a: any) => a.kind === "added").key;
    const r = await h.call("POST", `/api/lists/${f.sid}/undo`, { key }, f.jar);
    expect(r.status).toBe(409); expect(r.json.code).toBe("has_attendance");
    expect(r.json.error ?? r.json.message ?? r.text).not.toMatch(/\b(my|mine|your|yours)\b/i);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ?", add.json.id)).toEqual({ n: 1 });
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", add.json.id)).toEqual({ n: 1 });
    expect(q(h, "SELECT COUNT(*) AS n FROM voter_events WHERE voter_id = ? AND kind = 'undone'", add.json.id)).toEqual({ n: 0 });
  });

  test("a mark that lands after the first read and before the batch still gives 409 and changes nothing", async () => {
    const f = await markedList(); const { h } = f;
    const add = await h.call("POST", `/api/lists/${f.sid}/records`, { unit: "E-5", name: "Esha Sample", capacity: "Owner", mobile: "9000000205", email: "esha@sample.example", agreed: true }, f.jar);
    expect(add.status).toBe(201);
    const key = (await h.call("GET", `/api/lists/${f.sid}/actions`, undefined, f.jar)).json.actions.find((a: any) => a.kind === "added").key;
    let landed = false;
    const restore = spy(h, { afterFirst: (sql) => { if (!landed && sql.includes("FROM att_marks")) { landed = true; h.raw.query("INSERT INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, 'organizer', 'x', ?)").run(f.aid, f.sid, add.json.id, h.clock.now); } } });
    let r; try { r = await h.call("POST", `/api/lists/${f.sid}/undo`, { key }, f.jar); } finally { restore(); }
    expect(landed).toBe(true);
    expect(r.status).toBe(409);
    expect(r.json.error ?? r.json.message ?? r.text).not.toMatch(/\b(my|mine|your|yours)\b/i);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ?", add.json.id)).toEqual({ n: 1 });
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", add.json.id)).toEqual({ n: 1 });
    expect(q(h, "SELECT COUNT(*) AS n FROM voter_events WHERE voter_id = ? AND kind = 'undone'", add.json.id)).toEqual({ n: 0 });
  });

  test("the list of actions no longer offers an undo for a record that has a mark", async () => {
    const f = await markedList(); const { h } = f;
    const add = await h.call("POST", `/api/lists/${f.sid}/records`, { unit: "F-6", name: "Farid Sample", capacity: "Owner", mobile: "9000000206", email: "farid@sample.example", agreed: true }, f.jar);
    expect((await h.call("POST", `/api/lists/${f.sid}/attendance/sessions/${f.aid}/mark`, { voterId: add.json.id }, f.jar)).status).toBe(200);
    const acts = (await h.call("GET", `/api/lists/${f.sid}/actions`, undefined, f.jar)).json.actions;
    expect(acts.find((a: any) => a.kind === "added").undoable).toBe(false);
  });

  test("a record with no mark is still undone", async () => {
    const f = await markedList(); const { h } = f;
    const add = await h.call("POST", `/api/lists/${f.sid}/records`, { unit: "D-4", name: "Dev Sample", capacity: "Owner", mobile: "9000000204", email: "dev@sample.example", agreed: true }, f.jar);
    const key = (await h.call("GET", `/api/lists/${f.sid}/actions`, undefined, f.jar)).json.actions.find((a: any) => a.kind === "added").key;
    expect((await h.call("POST", `/api/lists/${f.sid}/undo`, { key }, f.jar)).status).toBe(200);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ?", add.json.id)).toEqual({ n: 0 });
  });
});

describe("4. the version names a real commit", () => {
  const version = JSON.parse(read("public/version.json")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string }> };
  const git = (...args: string[]) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  test("0.3.11 is the version everywhere, and every commit named in version.json is a commit that exists (a missing history fails, it is not skipped)", () => {
    expect(version.version).toBe("0.3.11");
    expect(version.changes[0]!.version).toBe("0.3.11");
    for (const c of version.changes.filter((x) => x.commit).slice(0, 3)) expect(() => git("cat-file", "-e", c.commit + "^{commit}"), c.commit).not.toThrow();
  });
  test("migration 0013 is left as released, 0014 narrows the trigger, and KNOWLEDGE.md tells merges to renumber", () => {
    expect(read("KNOWLEDGE.md")).toContain("renumber");
    expect(read("migrations/0013_attendance_purge.sql")).toContain("trg_att_marks_no_delete");
    expect(read("migrations/0014_attendance_purge_marker.sql")).toContain("att_purge");
    expect(read("migrations/0014_attendance_purge_marker.sql")).not.toContain("status = 'removed'");
  });

  // Two releases never name the same commit (KNOWLEDGE.md). Releases before 0.3.3 name none. No duplicate exists today, so the allowlist is empty.
  const ALLOWED_DUPLICATES: Record<string, string> = {};
  const duplicates = (entries: Array<{ commit?: string }>) => { const seen = new Map<string, number>(); for (const e of entries) if (e.commit) seen.set(e.commit, (seen.get(e.commit) ?? 0) + 1); return [...seen].filter(([c, n]) => n > 1 && !(c in ALLOWED_DUPLICATES)).map(([c]) => c); };
  test("every entry in version.json names a distinct commit, and a planted duplicate is caught", () => {
    expect(duplicates(version.changes)).toEqual([]);
    expect(duplicates([{ commit: "aaaaaaa" }, { commit: "bbbbbbb" }, { commit: "aaaaaaa" }])).toEqual(["aaaaaaa"]);
    expect(duplicates([{ commit: "aaaaaaa" }, { commit: "bbbbbbb" }])).toEqual([]);
  });
});
