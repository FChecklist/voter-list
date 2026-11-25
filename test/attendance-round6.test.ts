// Round 6 fixes for Attendance chunks 1-2.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ERR, ERROR_MESSAGES } from "../src/error-messages";

const read = (p: string) => readFileSync(p, "utf8");
const win: any = {}; new Function("window", read("public/assets/lang/hi.js"))(win);
const hi = win.VL_LANGS.hi;
const hasHindi = (s: string) => Object.prototype.hasOwnProperty.call(hi.words, s.trim()) || hi.patterns.some(([re]: [RegExp]) => re.test(s.trim()));

function runPage(file: string, api: (m: string, p: string, b?: any) => Promise<any>) {
  const errs: string[] = [];
  const el = (tag: string, attrs: any = {}, ...kids: any[]) => ({ tag, attrs: attrs || {}, kids: kids.flat(9), addEventListener() {}, append(...k: any[]) { this.kids.push(...k.flat(9)); } });
  const root: any = { kids: [] as any[], replaceChildren(...k: any[]) { this.kids = k.flat(9); } };
  const who: any = { kids: [] as any[], replaceChildren(...k: any[]) { this.kids = k.flat(9); } };
  const VL: any = {
    el, api, toast() {}, fail: (e: any) => errs.push(e.message || String(e)), busy: async (_b: any, fn: () => Promise<void>) => fn(), captcha: () => ({ node: null, token: () => "t", reset() {} }),
    err: () => ({ clear() {}, show: (m: string) => errs.push(m) }), localTime: (s: any) => String(s), stepbar: () => null, plural: (n: number, a: string) => n + " " + a, copy() {}, focusStep() {}, fill() {}, table: (_h: any, rows: any) => el("table", {}, rows),
    stepcards: (steps: any[]) => steps.map((st) => [st.title, st.state === "locked" ? st.lockedNote : typeof st.body === "function" ? st.body() : st.body]),
  };
  new Function("window", "document", "location", "fetch", read(file))({ VL }, { getElementById: (id: string) => (id === "app" ? root : who) }, { pathname: "/attend/abc", hash: "" }, () => { throw new Error("no fetch"); });
  const find = (n: any, f: (x: any) => boolean, out: any[] = []): any[] => { if (n && typeof n === "object") { if (f(n)) out.push(n); (n.kids || []).forEach((k: any) => find(k, f, out)); } return out; };
  return { errs, root, find: (f: (x: any) => boolean) => find({ kids: root.kids }, f) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
/** Pull maskMail out of a page script and run it. */
const maskOf = (file: string) => { const m = read(file).match(/const maskMail = .*;/)![0]; return new Function(m + "; return maskMail;")() as (e: string) => string; };

describe("round 6", () => {
  test("2. every message in ERROR_MESSAGES has a Hindi line, and the server uses the list", () => {
    expect(ERROR_MESSAGES.length).toBeGreaterThan(40);
    expect(ERROR_MESSAGES.filter((m) => !hasHindi(m))).toEqual([]);
    expect(ERROR_MESSAGES.some((m) => m.startsWith("Please choose a country from the list: India"))).toBe(true); // the template string, filled in
    // src/attendance.ts has no message literal of its own: each HttpError takes its text from the list
    const src = read("src/attendance.ts");
    expect([...src.matchAll(/new HttpError\(\d+,\s*(["`])/g)].length).toBe(0);
    for (const v of Object.values(ERR)) expect(ERROR_MESSAGES).toContain(v);
  });
  test("2b. messages written in the page scripts, and the other server files, are all in the list", () => {
    for (const f of ["public/assets/attendance.js", "public/assets/attend.js"]) for (const m of read(f).matchAll(/(?:toast|err\.show)\(\s*"([^"]+)"/g)) expect(ERROR_MESSAGES, m[1]).toContain(m[1]!);
    for (const m of read("public/assets/attend.js").matchAll(/"(This list has been closed\.[^"]*)"/g)) expect(ERROR_MESSAGES).toContain(m[1]!);
    for (const f of ["src/auth.ts", "src/handler.ts", "src/store.ts"]) for (const m of read(f).matchAll(/new HttpError\(\d+,\s*"((?:[^"\\]|\\.)*)"/g)) if (m[1] !== "Please say true or false.") expect(ERROR_MESSAGES, f + ": " + m[1]).toContain(m[1]!.replace(/\\"/g, '"'));
  });
  test("4. maskMail keeps only the first letter before @ when the domain has no dot (both pages)", () => {
    for (const f of ["public/assets/attend.js", "public/assets/attendance.js"]) {
      const mask = maskOf(f);
      expect(mask("a@localhost"), f).toBe("a****@localhost");
      expect(mask("alice.smith@localhost"), f).toBe("a****@localhost");
      expect(mask("alice.smith@example.com"), f).toBe("a****@e****.com");
    }
  });
  test("5. each organizer table button says whose row it marks", async () => {
    const detail = { session: { id: "att_1", title: "Meeting", status: "open", startsAt: 1, modeText: "Online", mode: "online", counts: { present: 0, eligible: 2 } }, people: [{ voterId: "v1", unit: "A-1", name: "Asha", email: "a", present: false }, { voterId: "v2", unit: "B-2", name: "Bharat", email: "b", present: false }] };
    const pg = runPage("public/assets/attendance.js", async (_m, p) => {
      if (p === "/api/attendance/lists") return { email: "o@x.com", countries: [], lists: [{ id: "soc_1", name: "L", kind: "voter_list", role: "organizer", link: "/attend/x" }] };
      if (p.includes("/attendance/sessions/att_1")) return detail;
      if (p.endsWith("/attendance/sessions")) return { sessions: [{ id: "att_1", title: "Meeting", status: "open", startsAt: 1, modeText: "Online", mode: "online", counts: { present: 0, eligible: 2 } }] };
      return {};
    });
    await tick(); await tick();
    await pg.find((n) => n.tag === "button" && n.kids.join("") === "Open")[0].attrs.on.click(); await tick();
    const btn = pg.find((n) => n.tag === "button" && n.kids.join("") === "Mark present");
    const labels = btn.map((b) => b.attrs["aria-label"]);
    expect(labels).toEqual(["Mark present: A-1", "Mark present: B-2"]);
  });
});
