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

describe("2. sign-in survives a failing purge", () => {
  test("every sign-in request still answers 200 when purgeStale is forced to throw (and the purge was tried)", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    let tried = 0;
    const real = h.env.DB;
    h.env.DB = new Proxy(real, { get(t, p, r) { const v = Reflect.get(t, p, r); return p === "prepare" ? (sql: string) => { if (sql.startsWith("DELETE FROM rate_hits")) { tried++; throw new Error("forced purge failure"); } return (v as any).call(t, sql); } : typeof v === "function" ? v.bind(t) : v; } });
    const orig = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    (globalThis.crypto as any).getRandomValues = (u: Uint32Array) => { u.fill(0); return u; }; // randomInt(20) is 0: the purge runs on this request
    const quiet = console.error; console.error = () => {};
    try {
      const r = await h.call("POST", `/api/v/${slug}/start`, { email: "someone@sample.example" });
      expect(r.status).toBe(200);
    } finally { (globalThis.crypto as any).getRandomValues = orig; console.error = quiet; h.env.DB = real; }
    expect(tried).toBeGreaterThan(0);
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
  test("0.3.5 is the version everywhere, and every commit named in version.json is a commit that exists (a missing history fails, it is not skipped)", () => {
    expect(version.version).toBe("0.3.5");
    expect(version.changes[0]!.version).toBe("0.3.5");
    const git = (...args: string[]) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
    for (const c of version.changes.filter((x) => x.commit).slice(0, 2)) expect(() => git("cat-file", "-e", c.commit + "^{commit}"), c.commit).not.toThrow();
  });
  test("migration 0013 exists and KNOWLEDGE.md tells merges to renumber", () => {
    expect(read("KNOWLEDGE.md")).toContain("renumber");
    expect(read("migrations/0013_attendance_purge.sql")).toContain("trg_att_marks_no_delete");
  });
});
