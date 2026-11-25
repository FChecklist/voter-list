// Round 16 fix for Attendance (version 0.3.11): a flat move by a co-organizer, the read-only toggle, the version history.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";
import { read } from "./scan";

const q = (h: { raw: any }, sql: string, ...a: unknown[]) => h.raw.query(sql).get(...a) as Record<string, any>;
const WORDS = "Only the Organizer can move a person who has been marked present.";

async function setup() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  const asha = await enrolVoter(h, slug, "asha@sample.example", { unit: "A-101", name: "Asha Sample", mobile: "9000000301" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const co = await h.staff("co@sample.example");
  const m = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode: "in_person" }, jar);
  const aid = m.json.session.id as string;
  const mark = () => h.call("POST", `/api/lists/${sid}/attendance/sessions/${aid}/mark`, { voterId: asha.rec.id }, jar);
  const move = (who: typeof jar, unit: string) => h.call("PATCH", `/api/lists/${sid}/records/${asha.rec.id}`, { unit, reason: "Moved flat" }, who);
  return { h, jar, co, sid, asha, mark, move };
}

describe("1. a co-organizer moving a person who has attendance marks", () => {
  test("the voter is undecided (is_voter null) and unmarked: the co-organizer can move them", async () => {
    const f = await setup();
    expect(q(f.h, "SELECT is_voter AS v FROM voters WHERE id = ?", f.asha.rec.id).v).toBeNull();
    const r = await f.move(f.co, "B-202"); expect(r.status, r.text).toBe(200);
    expect(q(f.h, "SELECT unit AS u FROM voters WHERE id = ?", f.asha.rec.id).u).toBe("B-202");
  });
  test("after a mark the same move is refused with the plain 403 and the flat is unchanged", async () => {
    const f = await setup(); expect((await f.mark()).status).toBe(200);
    expect(q(f.h, "SELECT is_voter AS v FROM voters WHERE id = ?", f.asha.rec.id).v).toBeNull();
    const r = await f.move(f.co, "B-202"); expect(r.status).toBe(403); expect(r.json.error).toBe(WORDS);
    expect(q(f.h, "SELECT unit AS u FROM voters WHERE id = ?", f.asha.rec.id).u).toBe("A-101");
    expect((await f.move(f.co, "A-101")).status).toBe(200); // the same flat (no move) is not blocked
  });
  test("the Organizer can still move a marked person", async () => {
    const f = await setup(); await f.mark();
    const r = await f.move(f.jar, "B-202"); expect(r.status, r.text).toBe(200);
    expect(q(f.h, "SELECT unit AS u FROM voters WHERE id = ?", f.asha.rec.id).u).toBe("B-202");
  });
  test("a decided voter (is_voter true, then false) is still refused for a co-organizer, with or without a mark; the Organizer may move an unmarked one", async () => {
    const f = await setup(); const flat = () => q(f.h, "SELECT unit AS u FROM voters WHERE id = ?", f.asha.rec.id).u;
    for (const decided of [1, 0]) {
      f.h.raw.query("UPDATE voters SET is_voter = ? WHERE id = ?").run(decided, f.asha.rec.id);
      expect(q(f.h, "SELECT COUNT(*) AS n FROM att_marks").n).toBe(0);
      const r = await f.move(f.co, "B-202"); expect(r.status, r.text).toBe(403); expect(flat()).toBe("A-101"); // the old rule, no mark yet
    }
    const org = await f.move(f.jar, "B-202"); expect(org.status, org.text).toBe(200); expect(flat()).toBe("B-202");
    // a decided voter WITH a mark: refused for the co-organizer, flat unchanged
    const g = await setup(); expect((await g.mark()).status).toBe(200);
    for (const decided of [1, 0]) {
      g.h.raw.query("UPDATE voters SET is_voter = ? WHERE id = ?").run(decided, g.asha.rec.id);
      const r = await g.move(g.co, "B-202"); expect(r.status).toBe(403);
      expect(q(g.h, "SELECT unit AS u FROM voters WHERE id = ?", g.asha.rec.id).u).toBe("A-101");
    }
  });
  test("the check also sits inside the save: a mark that lands after the first read stops the move, and without the guard in the batch it would not", async () => {
    // runs one move; the mark lands when the save is being built (after the first read), so only a guard inside the batch can stop it
    const run = async (dropGuard: boolean) => {
      const f = await setup(); const { h } = f; const aid = q(h, "SELECT id FROM att_sessions").id;
      const db = h.env.DB as any; const prepare = db.prepare.bind(db); let landed = false;
      db.prepare = (sql: string) => {
        if (!landed && /^UPDATE voters SET/.test(sql)) { landed = true; h.raw.query("INSERT INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, 'organizer', 'p_x', 1)").run(aid, q(h, "SELECT society_id AS s FROM voters WHERE id = ?", f.asha.rec.id).s, f.asha.rec.id); }
        // the planted variant: the guard statement is swapped for one that always passes, as if it had been left out of the batch
        if (dropGuard && /^INSERT INTO guard_assert .*NOT EXISTS\(SELECT 1 FROM att_marks/.test(sql)) return { bind: () => prepare("INSERT INTO guard_assert (ok, why) SELECT 1, ?").bind("planted") };
        return prepare(sql);
      };
      try { const r = await f.move(f.co, "B-202"); return { r, landed, flat: q(h, "SELECT unit AS u FROM voters WHERE id = ?", f.asha.rec.id).u, marks: q(h, "SELECT COUNT(*) AS n FROM att_marks").n }; }
      finally { db.prepare = prepare; }
    };
    const real = await run(false);
    expect(real.landed).toBe(true); expect(real.marks).toBe(1);
    expect(real.r.status).toBe(409); expect(real.r.json.error).toBe(WORDS); // (a) the plain wording (a guard that fails inside the batch is a clean 409, see audit.ts)
    expect(real.flat).toBe("A-101"); // (b) the flat is unchanged
    const planted = await run(true);
    expect(planted.landed).toBe(true); expect(planted.marks).toBe(1);
    expect(planted.r.status, planted.r.text).toBe(200); expect(planted.flat).toBe("B-202"); // (c) no guard in the batch: the move goes through, so this test fails on a regression
  });
});

/** The fake page of the round 14 helper test, with a form that knows its fields. */
function loadUi() {
  class Node {}
  class Element extends Node {
    tag = ""; attrs: Record<string, string> = {}; className = ""; kids: unknown[] = []; disabled = false;
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    addEventListener() {}
    append(...k: unknown[]) { this.kids.push(...k); }
    set textContent(t: string) { this.kids = [t]; }
  }
  class Text extends Node { constructor(public t: string) { super(); } }
  const document = { createElement: (tag: string) => Object.assign(new Element(), { tag }), createTextNode: (t: string) => new Text(t) };
  const window: Record<string, any> = {};
  new Function("window", "document", "Element", "Node", read("public/assets/ui.js"))(window, document, Element, Node);
  return { VL: window.VL as { toggle: (l: string, p: boolean, c?: any, w?: string[], d?: boolean) => any }, Element };
}

describe("2. a read-only form leaves the toggle switched off", () => {
  test("VL.toggle takes a disabled state", () => {
    const { VL } = loadUi();
    expect(VL.toggle("Docs", false).disabled).toBe(false);
    expect(VL.toggle("Docs", true, undefined, undefined, true).disabled).toBe(true);
  });
  test("the exact selector in organizer.js reaches the switch button on a fake form", () => {
    const line = read("public/assets/organizer.js").split("\n").find((l) => l.includes("if (dis) form.querySelectorAll("))!;
    const sel = /querySelectorAll\(("[^\n]*?")\)\.forEach/.exec(line)![1]!;
    const selector = JSON.parse(sel) as string; // "input,select,button[role=\"switch\"]"
    const { VL, Element } = loadUi();
    const sw = VL.toggle("Docs", false); const plain = Object.assign(new Element(), { tag: "button" }); const input = Object.assign(new Element(), { tag: "input" });
    // a tiny matcher for the three kinds of selector parts used here
    const matches = (n: any, part: string) => { const m = /^(\w+)(?:\[(\w+)="?(\w+)"?\])?$/.exec(part)!; return n.tag === m[1] && (!m[2] || n.attrs[m[2]] === m[3]); };
    const form = { querySelectorAll: (s: string) => [sw, plain, input].filter((n) => s.split(",").some((p) => matches(n, p.trim()))) };
    if (/dis\b/.test(line)) form.querySelectorAll(selector).forEach((n: any) => { n.disabled = true; });
    expect(sw.disabled).toBe(true); expect(input.disabled).toBe(true); expect(plain.disabled).toBe(false);
    expect(read("public/assets/organizer.js")).toContain("if (dis) form.querySelectorAll(");
  });
});

describe("3. the version history", () => {
  const version = JSON.parse(read("public/version.json")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string }> };
  const OLD_WITHOUT_COMMIT = ["0.3.2", "0.3.1", "0.3.0", "0.2.4", "0.2.3", "0.2.2", "0.2.1", "0.2.0", "0.1.0"];
  const without = (es: Array<{ version: string; commit?: string }>) => es.filter((e) => !e.commit).map((e) => e.version);
  test("the current version is the same everywhere; the 0.3.12 entry stays in the history and names 2fd57cf1, a commit that exists", () => {
    expect(version.changes[0]!.version).toBe(version.version);
    expect(JSON.parse(read("package.json")).version).toBe(version.version);
    expect(read("KNOWLEDGE.md")).toContain("**" + version.version + "**");
    expect(version.commit).toBe(version.changes[0]!.commit);
    expect(read("CHANGELOG.md")).toContain("## 0.3.12");
    expect(version.changes.find((e) => e.version === "0.3.12")!.commit).toBe("2fd57cf1");
    expect(() => execFileSync("git", ["cat-file", "-e", "2fd57cf1^{commit}"], { stdio: "ignore" })).not.toThrow();
  });
  test("the commit named for 0.3.11 is the parent of the commit that bumped the version to 0.3.11 (skipped when the history is shallow)", () => {
    const git = (...a: string[]) => execFileSync("git", a, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    let shallow = true; try { shallow = git("rev-parse", "--is-shallow-repository") !== "false"; } catch { /* no git: skip */ }
    if (shallow) return;
    const named = version.changes.find((e) => e.version === "0.3.11")!.commit!;
    const bump = "2fd57cf"; // the commit that bumped the version to 0.3.11
    expect(git("rev-parse", bump + "^").startsWith(named)).toBe(true);
    expect(git("rev-parse", named).startsWith(named)).toBe(true);
  });
  test("the entries without a commit are exactly the old versions, and a new one without a commit is caught", () => {
    expect(without(version.changes)).toEqual(OLD_WITHOUT_COMMIT);
    expect(without([{ version: "0.3.12" }, ...version.changes])).not.toEqual(OLD_WITHOUT_COMMIT);
    expect(read("KNOWLEDGE.md")).toContain("predates the rule");
  });
});
