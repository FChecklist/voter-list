// Round 15 fix for Attendance (version 0.3.10): the flat is kept on the mark, so moving a person later does not change a past session.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";
import { read } from "./scan";

const q = (h: { raw: any }, sql: string, ...a: unknown[]) => h.raw.query(sql).get(...a) as Record<string, any>;

async function setup() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  const asha = await enrolVoter(h, slug, "asha@sample.example", { unit: "A-101", name: "Asha Sample", mobile: "9000000301" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  const session = async (title: string) => { const m = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title, startsAt: "2026-12-05T18:00", place: "Club house", mode: "in_person" }, jar); expect(m.status).toBe(201); return m.json.session.id as string; };
  const mark = (aid: string) => h.call("POST", `/api/lists/${sid}/attendance/sessions/${aid}/mark`, { voterId: asha.rec.id }, jar);
  const sheet = async (aid: string) => (await h.call("GET", `/api/lists/${sid}/attendance/sessions/${aid}/sheet.csv`, undefined, jar)).text;
  const people = async (aid: string) => (await h.call("GET", `/api/lists/${sid}/attendance/sessions/${aid}`, undefined, jar)).json.people as Array<{ unit: string }>;
  return { h, jar, sid, slug, asha, session, mark, sheet, people };
}

describe("1. the flat is frozen on the mark", () => {
  test("a person moved to another flat keeps the old flat on a past session; a new session shows the new flat", async () => {
    const f = await setup(); const { h } = f;
    const old = await f.session("Meeting one"); expect((await f.mark(old)).status).toBe(200);
    expect(q(h, "SELECT unit_at_mark AS u FROM att_marks WHERE session_id = ?", old).u).toBe("A-101");
    await h.call("POST", `/api/lists/${f.sid}/attendance/sessions/${old}/close`, {}, f.jar);
    const moved = await h.call("PATCH", `/api/lists/${f.sid}/records/${f.asha.rec.id}`, { unit: "B-202", reason: "Moved flat" }, f.jar);
    expect(moved.status).toBe(200);
    expect(q(h, "SELECT unit AS u FROM voters WHERE id = ?", f.asha.rec.id).u).toBe("B-202");
    expect(await f.sheet(old)).toContain("A-101"); expect(await f.sheet(old)).not.toContain("B-202");
    expect((await f.people(old)).map((p) => p.unit)).toEqual(["A-101"]);
    const fresh = await f.session("Meeting two");
    expect(await f.sheet(fresh)).toContain("B-202"); // not marked yet: the current flat
    expect((await f.mark(fresh)).status).toBe(200);
    expect(q(h, "SELECT unit_at_mark AS u FROM att_marks WHERE session_id = ?", fresh).u).toBe("B-202");
    expect(await f.sheet(fresh)).toContain("B-202");
    expect(await f.sheet(old)).toContain("A-101");
  });

  test("migration 0015 backfills a mark made before it, from the voter's flat, and marks stay append-only", async () => {
    const f = await setup(); const { h } = f; const aid = await f.session("Meeting"); await f.mark(aid);
    // simulate a mark made before the migration: no frozen flat yet (the update trigger is lifted for this set-up only), then run the migration without its ALTER line
    h.raw.exec("DROP TRIGGER trg_att_marks_no_update"); h.raw.exec("UPDATE att_marks SET unit_at_mark = NULL");
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE unit_at_mark IS NULL").n).toBe(1);
    const sql = read("migrations/0015_attendance_unit_at_mark.sql"); expect(sql).toContain("ADD COLUMN unit_at_mark TEXT");
    h.raw.exec(sql.split("\n").filter((l) => !/^ALTER TABLE/.test(l)).join("\n"));
    expect(q(h, "SELECT unit_at_mark AS u FROM att_marks").u).toBe("A-101");
    expect(() => h.raw.exec("UPDATE att_marks SET unit_at_mark = 'Z-9'")).toThrow();
    expect(() => h.raw.exec("UPDATE att_marks SET marked_at = 5")).toThrow();
  });

  test("no update of an existing mark is possible", async () => {
    const f = await setup(); const aid = await f.session("Meeting"); await f.mark(aid);
    expect(() => f.h.raw.query("UPDATE att_marks SET unit_at_mark = 'Z-1'").run()).toThrow();
  });
});

describe("2. removing and re-adding a person who has marks", () => {
  test("the marks stay, the flat on the marks does not change, and no second voter row appears", async () => {
    const f = await setup(); const { h } = f;
    const aid = await f.session("Meeting"); await f.mark(aid);
    expect((await h.call("POST", `/api/lists/${f.sid}/records/remove`, { ids: [f.asha.rec.id], reason: "Left the society" }, f.jar)).status).toBe(200);
    const add = await h.call("POST", `/api/lists/${f.sid}/records`, { email: "asha@sample.example", unit: "a-101", name: "Asha Sample", capacity: "Owner", mobile: "9000000301" }, f.jar);
    expect(add.status, add.text).toBe(201);
    expect(add.json.id).toBe(f.asha.rec.id);
    expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE email = 'asha@sample.example'").n).toBe(1);
    expect(q(h, "SELECT COUNT(*) AS n FROM att_marks WHERE voter_id = ?", f.asha.rec.id).n).toBe(1);
    expect(q(h, "SELECT unit_at_mark AS u FROM att_marks WHERE voter_id = ?", f.asha.rec.id).u).toBe("A-101");
    expect(await f.sheet(aid)).toContain("A-101");
  });
});

describe("3. the version", () => {
  const version = JSON.parse(read("public/version.json")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string }> };
  test("0.3.10 everywhere; the newest entry names 9a8f91a8; migration 0015 is recorded", () => {
    expect(version.version).toBe("0.3.10"); expect(version.changes[0]!.version).toBe("0.3.10");
    expect(JSON.parse(read("package.json")).version).toBe("0.3.10");
    expect(read("CHANGELOG.md")).toContain("## 0.3.10"); expect(read("KNOWLEDGE.md")).toContain("0015");
    expect(version.changes[0]!.commit).toBe("9a8f91a8"); expect(version.commit).toBe("9a8f91a8");
    expect(() => execFileSync("git", ["cat-file", "-e", "9a8f91a8^{commit}"], { stdio: "ignore" })).not.toThrow();
  });
  test("the documents toggle has no unused id, and the migration number is used once", () => {
    expect(read("public/assets/organizer.js")).not.toContain('{ id: "ld" }');
    expect(readdirSync("migrations").filter((n) => n.startsWith("0015_"))).toHaveLength(1);
  });
});
