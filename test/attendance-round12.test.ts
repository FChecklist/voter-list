// Round 12 fix for Attendance (version 0.3.7): adding a person needs no tick box; a scan keeps tick boxes and "I agree" out of every source.
import { describe, expect, test } from "bun:test";
import { makeHarness, newList } from "./harness";
import { filesUnder, read } from "./scan";

const q = (h: { raw: any }, sql: string, ...a: unknown[]) => h.raw.query(sql).get(...a) as Record<string, any>;
const body = (n: number) => ({ unit: `R-${n}`, name: `Rita Sample${n}`, capacity: "Owner", mobile: `90000012${String(n).padStart(2, "0")}`, email: `rita${n}@sample.example` });

describe("1. adding a person has no tick box and no consent flag", () => {
  test("without an agreed field the record is added and exists when re-read; the trail names who added it and holds no consent flag", async () => {
    const h = await makeHarness(); const { jar, sid, email } = await newList(h);
    const r = await h.call("POST", `/api/lists/${sid}/records`, body(1), jar);
    expect(r.status).toBe(201);
    expect(q(h, "SELECT status, source, decided_by FROM voters WHERE id = ?", r.json.id)).toEqual({ status: "approved", source: "host", decided_by: email });
    const row = q(h, "SELECT entry_json FROM audit_entries WHERE type = 'record.added' AND society_id = ?", sid);
    const entry = JSON.parse(row.entry_json);
    expect(JSON.stringify(entry)).not.toMatch(/agreed/i);
    expect(entry.actor).toEqual({ pid: expect.any(String), role: "organizer" }); // the trail names who added it (a private id and the role)
    expect(q(h, "SELECT actor_email, kind FROM voter_events WHERE voter_id = ?", r.json.id)).toEqual({ actor_email: email, kind: "added" });
  });
  test("an old client that still sends agreed (true or false) keeps working; the field is ignored", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    for (const [n, agreed] of [[2, true], [3, false]] as const) {
      const r = await h.call("POST", `/api/lists/${sid}/records`, { ...body(n), agreed }, jar);
      expect(r.status).toBe(201);
      expect(q(h, "SELECT COUNT(*) AS n FROM voters WHERE id = ? AND status = 'approved'", r.json.id)).toEqual({ n: 1 });
    }
  });
  test("the dialog has a plain notice with the Terms link, no checkbox field, and no need_agreed code is left", () => {
    const js = read("public/assets/organizer-work.js");
    expect(js).toContain("The person will see this record when they sign in with this e-mail ID, under the ");
    expect(js).toContain('href: "/terms/"');
    expect(js).not.toContain('name: "agreed"');
    expect(read("src/review.ts")).not.toContain("need_agreed");
  });
});

describe("2. no source holds a consent tick box or the words tick the box / I agree", () => {
  // Functional checkboxes that are not a consent gate, by file and count (row select, close now, a list setting). The two freeze acknowledgements became plain buttons in 0.3.8. Any new one fails here.
  const ALLOWED: Record<string, number> = { "public/assets/organizer-work.js": 2, "public/assets/organizer.js": 1 };
  const files = [...filesUnder("src", /\.(js|ts)$/), ...filesUnder("public/assets", /\.(js|ts)$/)];
  test("the scan reads real files", () => { expect(files).toContain("src/review.ts"); expect(files).toContain("public/assets/ui.js"); });
  // The same kind of functional lines for the freeze checks and close-now box (not a consent gate), by file and count. Any new use fails here.
  const WORDS_ALLOWED: Record<string, number> = {};
  test('words: no "tick the box" and no "I agree" anywhere (the freeze messages and close-now line were reworded in 0.3.8)', () => {
    expect(files.filter((f) => /\bI agree\b/i.test(read(f)))).toEqual([]);
    const found: Record<string, number> = {};
    for (const f of files) { const n = (read(f).match(/tick the box/gi) ?? []).length; if (n) found[f] = n; }
    expect(found).toEqual(WORDS_ALLOWED);
  });
  test('type: "checkbox" appears only in the listed functional places', () => {
    const found: Record<string, number> = {};
    for (const f of files) { const n = (read(f).match(/type:\s*"checkbox"/g) ?? []).length; if (n) found[f] = n; }
    expect(found).toEqual(ALLOWED);
  });
  test('no checkbox in any file under public/assets has an agree / understand / looked at / accept label or id near it', () => {
    const all = filesUnder("public/assets", /./); const bad: string[] = [];
    for (const f of all) {
      const t = read(f);
      for (const m of t.matchAll(/type:\s*["']checkbox["']|type=["']?checkbox/g)) {
        const near = t.slice(Math.max(0, m.index! - 250), m.index! + 450);
        if (/agree|understand|looked at|accept/i.test(near)) bad.push(f + " near " + JSON.stringify(near.slice(200, 260)));
      }
    }
    expect(bad).toEqual([]);
    // the scan is real: it sees a planted box in a planted text
    const planted = 'el("input", { type: "checkbox", id: "x" }), "I understand. Freeze anyway."';
    expect(/type:\s*["']checkbox["']/.test(planted) && /agree|understand|looked at|accept/i.test(planted)).toBe(true);
  });
});
