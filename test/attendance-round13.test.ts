// Round 13 fix for Attendance (version 0.3.8): freeze acknowledgements are plain buttons; docs say what happens; a race on one mark per e-mail ID gives the friendly answer.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { pseudonym } from "../src/audit";
import * as attendance from "../src/attendance";
import { ERR } from "../src/error-messages";
import { getSociety } from "../src/store";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";
import { filesUnder, read } from "./scan";

const START = Date.UTC(2026, 11, 5, 12, 30);
const NOW = START - 10 * 60_000;

async function family() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  const aid = (await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Hall", mode: "online" }, jar)).json.session.id as string;
  const add = (unit: string, name: string, n: number) => h.call("POST", `/api/lists/${sid}/records`, { unit, name, capacity: "Owner", mobile: "90000004" + n + "0", email: "family@sample.example" }, jar);
  expect((await add("C-3", "Chitra Family", 1)).status).toBe(201); expect((await add("D-4", "Dev Family", 2)).status).toBe(201);
  const idOf = (unit: string) => (h.raw.query("SELECT id FROM voters WHERE unit = ?").get(unit) as { id: string }).id;
  return { h, aid, society: (await getSociety(h.env, sid))!, c3: idOf("C-3"), d4: idOf("D-4") };
}
const marks = (h: { raw: any }) => h.raw.query("SELECT voter_id FROM att_marks").all() as { voter_id: string }[];

describe("1. a second mark by the same e-mail ID that lands between the read and the batch", () => {
  test("a rival mark inserted just before the batch gives the plain answer, code one_per_email, and exactly one mark stays", async () => {
    const f = await family(); const { h } = f; const pid = await pseudonym(h.env, "family@sample.example"); let done = false;
    const env = { ...h.env, DB: { prepare: (s: string) => h.env.DB.prepare(s), batch: async (st: any[]) => { if (!done) { done = true; h.raw.run("INSERT INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, 'email', ?, 1)", [f.aid, f.society.id, f.c3, pid]); } return h.env.DB.batch(st); } } };
    await expect(attendance.markSelf(env as any, NOW, f.society, "family@sample.example", f.aid, f.d4)).rejects.toMatchObject({ status: 409, code: "one_per_email", message: ERR.onePerEmail });
    expect(marks(h)).toEqual([{ voter_id: f.c3 }]);
  });
  test("a raw UNIQUE failure of the one-mark-per-e-mail index also gives the plain answer, not a 500", async () => {
    const f = await family(); const { h } = f;
    const env = { ...h.env, DB: { prepare: (s: string) => h.env.DB.prepare(s), batch: async () => { throw new Error("UNIQUE constraint failed: att_marks.session_id, att_marks.marked_by"); } } };
    await expect(attendance.markSelf(env as any, NOW, f.society, "family@sample.example", f.aid, f.d4)).rejects.toMatchObject({ status: 409, code: "one_per_email", message: ERR.onePerEmail });
    expect(marks(h)).toEqual([]);
  });
  test("other failures are not hidden", async () => {
    const f = await family(); const { h } = f;
    const env = { ...h.env, DB: { prepare: (s: string) => h.env.DB.prepare(s), batch: async () => { throw new Error("disk is full"); } } };
    await expect(attendance.markSelf(env as any, NOW, f.society, "family@sample.example", f.aid, f.d4)).rejects.toThrow("disk is full");
  });
});

describe("2. the freeze flow has plain confirm buttons and the server still asks for the confirmation", () => {
  const js = read("public/assets/organizer-work.js");
  test("the page offers a Yes, freeze anyway button that sets the same fields, and no acknowledgement checkbox", () => {
    expect(js).toContain('"Yes, freeze anyway"');
    expect(js).toContain('el("button"'); expect(js).toContain('state[field] = true');
    expect(js).toContain('"ackPending" : "ackWarnings"');
    expect(js).not.toMatch(/I understand|I have looked at them/);
    expect(js).not.toMatch(/state\.ack(Pending|Warnings) = q\.target/);
  });
  test("without the confirmation field the server still answers pending / warnings; with it true, the freeze goes through", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await enrolVoter(h, slug, "late@sample.example", { unit: "Z-9", name: "Late Voter", mobile: "9000000199" }); // stays waiting
    const body = { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true };
    const a = await h.call("POST", `/api/lists/${sid}/publish/frozen`, body, jar);
    expect(a.status).toBe(409); expect(a.json.code).toBe("pending"); expect(a.json.error).not.toMatch(/tick/i); expect(a.json.error).toContain("Yes, freeze anyway");
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publications WHERE kind = 'frozen'").get()).toEqual({ n: 0 });
    let b = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { ...body, ackPending: true }, jar);
    if (b.status === 409 && b.json.code === "warnings") { expect(b.json.error).not.toMatch(/tick/i); b = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { ...body, ackPending: true, ackWarnings: true }, jar); }
    expect(b.status).toBe(201);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publications WHERE kind = 'frozen'").get()).toEqual({ n: 1 });
  });
});

describe("3. README, ASSUMPTIONS and KNOWLEDGE do not claim a tick", () => {
  test("no wrong claim about a tick before sending, a tick that the person agreed, or a tick for consent", () => {
    for (const f of ["README.md", "ASSUMPTIONS.md", "KNOWLEDGE.md"]) {
      const t = read(f);
      expect(t, f).not.toMatch(/a tick is required|must tick|with a tick before|Voters give consent with a tick/i);
      for (const line of t.split("\n").filter((l) => /\btick/i.test(l))) expect(line, f).toMatch(/no tick box|no tick|not a tick|has no tick|tick box(es)? (is|are) gone|0\.3\.[78]|history/i);
    }
    expect(read("ASSUMPTIONS.md")).toContain("Pressing the plain confirm button");
  });
});

describe("4. the version", () => {
  const version = JSON.parse(read("public/version.json")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string; notes: string }> };
  test("the 0.3.8 entry stays, naming the head 1ec24618 it was built on", () => {
    const e = version.changes.find((c) => c.version === "0.3.8")!;
    expect(e.commit).toBe("1ec24618");
    expect(() => execFileSync("git", ["cat-file", "-e", "1ec24618^{commit}"], { stdio: "ignore" })).not.toThrow();
  });
});
