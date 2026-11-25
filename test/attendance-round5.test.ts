// Round 5 fixes for Attendance chunks 1-2.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { routeTable } from "../src/handler";
import { csvCell, toCsv } from "../src/csv";

const read = (p: string) => readFileSync(p, "utf8");
const win: any = {}; new Function("window", read("public/assets/lang/hi.js"))(win);
const hi = win.VL_LANGS.hi;
const hasHindi = (s: string) => Object.prototype.hasOwnProperty.call(hi.words, s.trim()) || hi.patterns.some(([re]: [RegExp]) => re.test(s.trim()));

/** Run a page script against a tiny fake page. Returns what was drawn and the stubbed calls. */
function runPage(file: string, api: (m: string, p: string, b?: any) => Promise<any>, path = "/attend/abc") {
  const calls: string[] = []; const errs: string[] = [];
  const el = (tag: string, attrs: any = {}, ...kids: any[]) => ({ tag, attrs: attrs || {}, kids: kids.flat(9), addEventListener() {} });
  const root: any = { kids: [] as any[], replaceChildren(...k: any[]) { this.kids = k.flat(9); } };
  const who: any = { kids: [] as any[], replaceChildren(...k: any[]) { this.kids = k.flat(9); } };
  const VL: any = {
    el, api: (m: string, p: string, b?: any) => { calls.push(m + " " + p); return api(m, p, b); }, toast() {}, fail: (e: any) => errs.push(e.message || String(e)),
    busy: async (_b: any, fn: () => Promise<void>) => fn(), captcha: () => ({ node: null, token: () => "t", reset() {} }),
    err: () => ({ clear() {}, show: (m: string) => errs.push(m) }), localTime: (s: any) => String(s), stepbar: () => null, stepcards: (steps: any[]) => steps.map((st) => [st.title, st.summary, st.state === "locked" ? st.lockedNote : typeof st.body === "function" ? st.body() : st.body]),
  };
  const doc = { getElementById: (id: string) => (id === "app" ? root : who) };
  const done = new Function("window", "document", "location", "fetch", read(file))({ VL }, doc, { pathname: path, hash: "" }, () => { throw new Error("no fetch"); });
  const text = (n: any): string => (n == null ? "" : typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join(" ") : [...(n.kids || [])].map(text).join(" "));
  const find = (n: any, f: (x: any) => boolean, out: any[] = []): any[] => { if (n && typeof n === "object") { if (f(n)) out.push(n); (n.kids || []).forEach((k: any) => find(k, f, out)); } return out; };
  return { root, who, calls, errs, text: () => text(root.kids), find: (f: (x: any) => boolean) => find({ kids: root.kids }, f), done };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const httpErr = (status: number, message = "x") => Object.assign(new Error(message), { status });

describe("round 5", () => {
  test("1. organizer sign-in page masks the e-mail ID after the code is sent", async () => {
    const pg = runPage("public/assets/attendance.js", async (m, p) => { if (p === "/api/attendance/lists") throw httpErr(401); return {}; });
    await tick();
    const input = pg.find((n) => n.tag === "input" && n.attrs.id === "em")[0]; input.value = "alice.smith@example.com";
    const form = pg.find((n) => n.tag === "form")[0];
    await form.attrs.on.submit({ preventDefault() {} }); await tick();
    const t = pg.text();
    expect(t).toContain("a****@e****.com");
    expect(t).not.toContain("alice.smith@example.com");
  });

  test("2. CSV cells that start like a formula are defused, in every column of the sheet", () => {
    for (const v of ["=1+1", "+2", "-2+3", "@x", "\t=1", "\r=1", "=cmd|' /C calc'!A0"]) expect(csvCell(v).replace(/^"/, "").startsWith("'"), JSON.stringify(v)).toBe(true);
    const bad = ["=1+1", "+2", "-2+3", "@x", "\tsum"];
    const out = toCsv([["Flat / House / Member ID", "Name"], ...bad.map((b) => [b, b, b])]);
    for (const line of out.split("\r\n").slice(1)) for (const cell of line.split(",")) expect(/^"?[=+\-@\t\r]/.test(cell), cell).toBe(false);
    expect(out).toContain("'=1+1,'=1+1"); expect(out).toContain("'+2"); expect(out).toContain("'-2+3"); expect(out).toContain("'@x");
  });

  test("3. every server error message that reaches the page has a Hindi line", () => {
    const missing: string[] = [];
    for (const f of ["src/attendance.ts", "src/auth.ts", "src/handler.ts", "src/store.ts"]) {
      for (const m of read(f).matchAll(/new HttpError\(\d+,\s*"((?:[^"\\]|\\.)*)"/g)) { const msg = m[1]!.replace(/\\"/g, '"'); if (!hasHindi(msg)) missing.push(msg); }
      for (const m of read(f).matchAll(/\?\?\s*"((?:[^"\\]|\\.)*)"/g)) if (/^[A-Z].*[.]$/.test(m[1]!) && /HttpError/.test(m.input!.slice(Math.max(0, m.index! - 80), m.index!)) && !hasHindi(m[1]!)) missing.push(m[1]!);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  test("4. the three organizer auth routes exist and are what the page calls", () => {
    const table = routeTable();
    for (const p of ["/api/auth/start", "/api/auth/verify", "/api/auth/logout"]) expect(table.some((r) => r.method === "POST" && r.re.test(p)), p).toBe(true);
    const src = read("public/assets/attendance.js");
    for (const p of ["/api/auth/start", "/api/auth/verify", "/api/auth/logout"]) expect(src.includes(p), p).toBe(true);
  });

  test("5. a 410 (erased or closed list) shows a plain closed message, not a blank page", async () => {
    const pg = runPage("public/assets/attend.js", async () => { throw httpErr(410, "This list has been closed and its details erased."); });
    await tick();
    expect(pg.text()).toContain("This list has been closed. Nothing can be marked here.");
    expect(pg.errs).toEqual([]);
    expect(hasHindi("This list has been closed. Nothing can be marked here.")).toBe(true);
  });

  test("6. the mark button and its screen have no your / yours / my / mine in visible text", async () => {
    const pub = { list: "Hall list", sessions: [{ id: "att_1", title: "Meeting", place: "Hall", mode: "online", modeText: "Online", status: "open", startsAt: 1 }] };
    const pg = runPage("public/assets/attend.js", async (_m, p) => { if (p.endsWith("/attend/me")) return { email: "a@b.com", rows: [{ voterId: "v1", unit: "A-1" }] }; return pub; });
    await tick();
    const t = pg.text();
    expect(t).toContain("Mark present");
    expect(/\b(your|yours|my|mine)\b/i.test(t), t).toBe(false);
  });
});
