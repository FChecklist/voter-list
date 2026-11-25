// Attendance chunk 2: the organizer page and the voter page, the CSV sheet, and the owner's wording rules for every new screen.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { routeTable } from "../src/handler";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

const read = (p: string) => readFileSync(p, "utf8");
const PAGES = ["public/attendance/index.html", "public/attend/index.html"];
const SCRIPTS = ["public/assets/attendance.js", "public/assets/attend.js"];

/** The string literals of a script, comments skipped. */
function literals(src: string): string[] {
  const out: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, b = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { b += src.slice(j, j + 2); j += 2; continue; } if (c !== "`" && src[j] === "\n") break; b += src[j]; j++; }
      out.push(c === "`" ? b.replace(/\$\{[^}]*\}/g, " ") : b); i = j + 1; continue;
    }
    i++;
  }
  return out;
}
const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]*>/g, " ");
/** A literal people read: it has a letter, and is not a code word (a tag, class, id, path, key or HTTP verb). */
const isShown = (s: string) => /[A-Za-z]{2}/.test(s) && !/^[a-z0-9_\-\/#.:?=&%,|()\[\] ]*$/.test(s) && !/^(GET|POST)$/.test(s) && !/^[A-Za-z]+:\/\//.test(s) && !/^\S+@\S+$/.test(s) && !/^[\w-]+\/[\w.+-]+$/.test(s) && !s.startsWith("/");
const shown = () => SCRIPTS.flatMap((f) => literals(read(f)).filter(isShown).map((s) => ({ f, s })));
/** The notice line (a plain sentence with a Terms link) and the link text: by the owner's rule they have no Hindi. */
const isConsent = (s: string) => s.startsWith("By pressing") || s === "Terms and Conditions";

const win: any = {}; new Function("window", read("public/assets/lang/hi.js"))(win);
const hi = win.VL_LANGS.hi;
const hasHindi = (s: string) => Object.prototype.hasOwnProperty.call(hi.words, s.trim()) || hi.patterns.some(([re]: [RegExp]) => re.test(s.trim()));

describe("attendance pages: files", () => {
  test("each page loads files that exist, has no inline script or handler, and is routed", () => {
    for (const p of PAGES) {
      const html = read(p);
      for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) expect(existsSync("public" + m[1]), `${p} loads ${m[1]}`).toBe(true);
      expect(/<script(?![^>]*\bsrc=)/i.test(html), p).toBe(false);
      expect(/\son[a-z]+\s*=/i.test(html), p).toBe(false);
      expect(html).toContain("/assets/i18n.js"); expect(html).toContain("/assets/lang/hi.js"); expect(html).toContain("/assets/steps.js"); expect(html).toContain("/assets/ui.js");
    }
    expect(read("public/attendance/index.html")).toContain("/assets/attendance.js");
    expect(read("public/attend/index.html")).toContain("/assets/attend.js");
    expect(read("public/_redirects")).toContain("/attend/*  /attend/index.html  200");
  });
  test("no innerHTML, eval or string timers in the new scripts", () => {
    for (const f of SCRIPTS) { const t = read(f); expect(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(t), f).toBe(false); expect(/set(Timeout|Interval)\(\s*["'`]/.test(t), f).toBe(false); }
  });
  test("every address the new scripts call is a real route", () => {
    const table = routeTable(); const missing: string[] = [];
    const want: [string, string][] = [
      ["GET", "/api/attendance/lists"], ["POST", "/api/attendance/rosters"], ["GET", "/api/attendance/template.xlsx"], ["GET", "/api/attendance/template.csv"],
      ["GET", "/api/lists/soc_1/attendance/sessions"], ["POST", "/api/lists/soc_1/attendance/sessions"], ["GET", "/api/lists/soc_1/attendance/sessions/att_1"], ["GET", "/api/lists/soc_1/attendance/sessions/att_1/sheet.csv"],
      ["POST", "/api/lists/soc_1/attendance/sessions/att_1/mark"], ["POST", "/api/lists/soc_1/attendance/sessions/att_1/close"],
      ["GET", "/api/v/0123456789abcdef/attendance"], ["GET", "/api/v/0123456789abcdef/attend/me"], ["POST", "/api/v/0123456789abcdef/attendance/att_1/here"], ["POST", "/api/v/0123456789abcdef/start"], ["POST", "/api/v/0123456789abcdef/verify"], ["POST", "/api/v/0123456789abcdef/logout"],
    ];
    for (const [m, p] of want) if (!table.some((r) => r.method === m && r.re.test(p))) missing.push(m + " " + p);
    expect(missing).toEqual([]);
    // the three Organizer sign-in routes the organizer page calls
    for (const p of ["/api/auth/start", "/api/auth/verify", "/api/auth/logout"]) { expect(table.some((r) => r.method === "POST" && r.re.test(p)), p).toBe(true); expect(read("public/assets/attendance.js").includes(p), p).toBe(true); }
    // and each of those paths is really used by a script (so this list cannot drift from the pages)
    const src = SCRIPTS.map(read).join("\n");
    for (const needle of ["/api/attendance/lists", "/api/attendance/rosters", "/attendance/sessions", "/sheet.csv", "/mark`", "/close`", 'A("/attendance")', 'A("/attend/me")', "/here`"]) expect(src.includes(needle), needle).toBe(true);
  });
});

describe("attendance pages: the owner's wording rules", () => {
  test("no my / mine / your / yours in any text of the new pages and scripts", () => {
    const bad = [...shown().filter(({ s }) => /\b(my|mine|your|yours)\b/i.test(s)).map((x) => x.f + ": " + x.s), ...PAGES.filter((p) => /\b(my|mine|your|yours)\b/i.test(textOf(read(p))))];
    expect(bad).toEqual([]);
  });
  test("no nickname and no host in text people read; names are only Name", () => {
    const bad = shown().filter(({ s }) => /nick\s*name|display name|\bhosts?\b/i.test(s)).map((x) => x.s);
    expect(bad).toEqual([]);
    for (const p of PAGES) expect(/nick|\bhost\b/i.test(textOf(read(p)))).toBe(false);
    expect(shown().some(({ s }) => s === "Co-organizer")).toBe(true);
  });
  test("no tick box, no 'I agree', and a plain notice line with a Terms link instead", () => {
    for (const f of SCRIPTS) {
      const t = read(f);
      expect(/checkbox|radio|\bchecked\s*:/i.test(t), f).toBe(false);
      expect(/I agree|I accept|agree to/i.test(t), f).toBe(false);
      expect(t).toContain('href: "/terms/"'); expect(t).toContain('"By pressing Mark present, ');
    }
  });
  test("the button says mark present", () => {
    for (const f of SCRIPTS) expect(read(f)).toContain('"Mark present"');
    // the visible text of the mark button and its screen has no your / yours / my / mine (checked on the live script in attendance-round5.test.ts too)
    for (const f of SCRIPTS) expect(literals(read(f)).filter((s) => /\bMark present\b/.test(s) && /\b(your|yours|my|mine)\b/i.test(s))).toEqual([]);
  });
  test("no money, price, payee or payment text: the money flag stays off and nothing is hard-coded", () => {
    for (const { s } of shown()) expect(/₹|\bRs\b|\bUSD\b|\bINR\b|\bprice\b|\bpay(ment|ee)?\b|credits?|Moneypenny|\bRazorpay\b/i.test(s), s).toBe(false);
    expect(/payee|moneypenny|razorpay/i.test(SCRIPTS.map(read).join("\n"))).toBe(false);
  });
  test("no invented date or number is written into a page", () => {
    for (const { s } of shown()) expect(/\b(19|20)\d\d\b/.test(s), s).toBe(false);
  });
  test("the one allowed exception line is not needed here: the AI line is absent, so nothing needs an allow-list", () => {
    expect(shown().some(({ s }) => /paste in your AI/.test(s))).toBe(false);
  });
});

describe("attendance pages: Hindi", () => {
  test("every plain sentence has a Hindi key or pattern; consent lines have none", () => {
    const sentences = shown().filter(({ s }) => !isConsent(s) && !s.startsWith("Test mode:"));
    expect(sentences.length).toBeGreaterThan(60);
    expect(sentences.filter(({ s }) => !hasHindi(s)).map((x) => x.s)).toEqual([]);
    expect(hasHindi("Test mode: the code is 123456")).toBe(true);
  });
  test("running texts with a number have a Hindi pattern", () => {
    for (const s of ["3 of 10 present.", "1 session", "4 sessions", "1 person", "2 people", "1 row", "5 rows"]) expect(hasHindi(s), s).toBe(true);
  });
  test("no Hindi line for the notice, and the Hindi text is not the English text", () => {
    const notice = /By pressing Mark present|Terms and Conditions|Terms link/i;
    for (const [k, v] of Object.entries(hi.words) as [string, string][]) { expect(notice.test(k), "key " + k).toBe(false); expect(notice.test(String(v)), "value of " + k).toBe(false); }
    for (const [re] of hi.patterns as [RegExp][]) expect(re.test("By pressing Mark present, this e-mail ID is recorded as present under the Terms and Conditions."), String(re)).toBe(false);
    for (const { s } of shown().filter(({ s }) => !isConsent(s) && !s.startsWith("Test mode:") && Object.prototype.hasOwnProperty.call(hi.words, s.trim()) && !["Excel", "CSV"].includes(s.trim()))) expect(hi.words[s.trim()], s).not.toBe(s.trim());
  });
});

// ------------------------------------------------------------------------------------------------------------------ the API behind the pages
async function society() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
  await enrolVoter(h, slug, "bharat@sample.example", { unit: "B-2", name: "Bharat Sample", mobile: "9000000202" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const coJar = await h.staff("co@sample.example");
  const id = (await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode: "in_person" }, jar)).json.session.id as string;
  const voterId = (e: string) => (h.raw.query("SELECT id FROM voters WHERE email = ?").get(e) as { id: string }).id;
  return { h, jar, coJar, sid, slug, id, asha: voterId("asha@sample.example") };
}
const rowsOf = (t: string) => t.trim().split("\r\n");

describe("attendance sheet (CSV)", () => {
  test("the Organizer gets everyone on the list, who is present and how, as a CSV file", async () => {
    const s = await society();
    await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${s.id}/mark`, { voterId: s.asha }, s.jar);
    const r = await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${s.id}/sheet.csv`, undefined, s.jar);
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toContain("text/csv"); expect(r.headers.get("content-disposition")).toContain("attendance-sheet.csv");
    const rows = rowsOf(r.text);
    expect(rows[0]).toBe("Flat / House / Member ID,Name,E-mail ID,Present,Marked how,Marked at");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^A-1,Asha Sample,asha@sample.example,Yes,Organizer or co-organizer,\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    expect(rows[2]).toBe("B-2,Bharat Sample,bharat@sample.example,No,,");
  });
  test("a co-organizer gets masked names and e-mail IDs", async () => {
    const s = await society();
    const t = (await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${s.id}/sheet.csv`, undefined, s.coJar)).text;
    expect(t).not.toContain("Asha Sample"); expect(t).not.toContain("asha@sample.example"); expect(t).not.toContain("bharat@sample.example");
    expect(rowsOf(t)).toHaveLength(3);
  });
  test("a person marked by e-mail code shows that way; a closed session still downloads", async () => {
    const s = await society();
    const on = await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "Online meeting", startsAt: "2026-12-05T18:00", mode: "online" }, s.jar); const oid = on.json.session.id;
    s.h.clock.now = Date.UTC(2026, 11, 5, 12, 30);
    const v = await s.h.member(s.slug, "asha@sample.example"); s.jar = await s.h.staff("organizer@sample.example"); // a new sign-in: the clock moved on
    expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${oid}/here`, {}, v)).status).toBe(200);
    await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${oid}/close`, {}, s.jar);
    const t = (await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${oid}/sheet.csv`, undefined, s.jar)).text;
    expect(t).toContain("A-1,Asha Sample,asha@sample.example,Yes,E-mail code,");
  });
  test("every download leaves a row in the signed log, with counts and no personal data", async () => {
    const s = await society();
    const before = (s.h.raw.query("SELECT COUNT(*) AS n FROM audit_entries WHERE type = 'attendance.sheet_exported'").get() as { n: number }).n;
    await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${s.id}/sheet.csv`, undefined, s.coJar);
    await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${s.id}/sheet.csv`, undefined, s.jar);
    const rows = s.h.raw.query("SELECT * FROM audit_entries WHERE type = 'attendance.sheet_exported' ORDER BY seq").all() as any[];
    expect(rows.length - before).toBe(2);
    const dump = JSON.stringify(rows); expect(dump).not.toContain("asha@"); expect(dump).not.toContain("Asha");
    expect((await s.h.call("GET", `/api/lists/${s.sid}/audit/verify`, undefined, s.jar)).json.ok).toBe(true);
  });
  test("signed-out, a stranger and an unknown session are refused", async () => {
    const s = await society(); const url = `/api/lists/${s.sid}/attendance/sessions/${s.id}/sheet.csv`;
    expect((await s.h.call("GET", url)).status).toBe(401);
    expect((await s.h.call("GET", url, undefined, await s.h.staff("stranger@sample.example"))).status).toBeGreaterThanOrEqual(403);
    expect((await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/att_nope/sheet.csv`, undefined, s.jar)).status).toBe(404);
  });
  test("a cell that starts like a formula is defused; a list made from an uploaded sheet has the same CSV", async () => {
    const h = await makeHarness(); const jar = await h.staff("solo@sample.example");
    const up = await h.call("POST", "/api/attendance/rosters", { title: "Spring list", format: "paste", text: "Flat / House / Member ID,Name,E-mail ID\nA-1,=Asha Sample,asha@sample.example\nB-2,Bharat Sample,bharat@sample.example\n" }, jar);
    expect(up.status).toBe(201); const sid = up.json.list.id;
    const ses = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Spring meeting", startsAt: "2026-12-05T18:00", mode: "offline" }, jar);
    const t = (await h.call("GET", `/api/lists/${sid}/attendance/sessions/${ses.json.session.id}/sheet.csv`, undefined, jar)).text;
    expect(t).toContain("'=Asha Sample"); expect(t).not.toContain(",=Asha");
  });
  test("a closed and erased list gives no sheet", async () => {
    const s = await society(); s.h.raw.query("UPDATE societies SET erased_at = 1 WHERE id = ?").run(s.sid);
    expect((await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${s.id}/sheet.csv`, undefined, s.jar)).status).toBe(410);
  });
});

describe("what the pages ask the API", () => {
  test("the list picker shows Voter Lists and uploaded sheets with the voter link, and needs sign in", async () => {
    const s = await society();
    expect((await s.h.call("GET", "/api/attendance/lists")).status).toBe(401);
    const r = await s.h.call("GET", "/api/attendance/lists", undefined, s.jar);
    expect(r.json.lists).toHaveLength(1);
    expect(r.json.lists[0]).toMatchObject({ id: s.sid, kind: "voter_list", role: "organizer", link: "/attend/" + s.slug });
    expect(r.json.countries).toContain("India");
    const co = await s.h.call("GET", "/api/attendance/lists", undefined, s.coJar); expect(co.json.lists[0].role).toBe("co-organizer");
    await s.h.call("POST", "/api/attendance/rosters", { title: "Sheet list", format: "paste", text: "Flat / House / Member ID,Name,E-mail ID\nA-1,Asha Sample,asha@sample.example\n" }, s.jar);
    expect((await s.h.call("GET", "/api/attendance/lists", undefined, s.jar)).json.lists.map((l: any) => l.kind).sort()).toEqual(["sheet", "voter_list"]);
  });
  test("a signed-in voter sees only where this e-mail ID is on the list; signed-out is refused; a stranger sees none", async () => {
    const s = await society();
    expect((await s.h.call("GET", `/api/v/${s.slug}/attend/me`)).status).toBe(401);
    const me = await s.h.call("GET", `/api/v/${s.slug}/attend/me`, undefined, await s.h.member(s.slug, "asha@sample.example"));
    expect(me.json).toEqual({ email: "asha@sample.example", list: expect.any(String), rows: [{ voterId: s.asha, unit: "A-1" }] });
    expect(JSON.stringify(me.json)).not.toContain("Bharat");
    expect((await s.h.call("GET", `/api/v/${s.slug}/attend/me`, undefined, await s.h.member(s.slug, "stranger@sample.example"))).json.rows).toEqual([]);
  });
});
