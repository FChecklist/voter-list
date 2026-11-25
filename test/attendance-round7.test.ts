// Round 7 fixes for Attendance chunks 1-2 (version 0.3.3). One block per audit finding, numbered as in the order that came with this round.
//   1 the public session list shows no title or place for a Voter List link      4 Hindi for the texts the server builds (never on a consent line)
//   2 one e-mail ID marks one person in a session, even on several flats        5 no my / mine / your / yours in any text the server builds
//   3 the co-organizer's view (CSV, find box, page label)                        6 a failed first load shows a kind error with a retry
import { describe, expect, test } from "bun:test";
import * as EM from "../src/error-messages";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";
import { ALLOWED_SENTENCE, callLiterals, filesUnder, pageTexts, possessivesIn, read, sentences, stringLiterals } from "./scan";

// ------------------------------------------------------------------------------------------------------------------ a society with one e-mail ID on two flats
const START = Date.UTC(2026, 11, 5, 12, 30); // 2026-12-05T18:00 in India
async function society() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
  await enrolVoter(h, slug, "bharat@sample.example", { unit: "B-2", name: "Bharat Sample", mobile: "9000000202" });
  await enrolVoter(h, slug, "family@sample.example", { unit: "C-3", name: "Chitra Family", mobile: "9000000203" }); // one e-mail ID on two flats
  await enrolVoter(h, slug, "family@sample.example", { unit: "D-4", name: "Dev Family", mobile: "9000000204" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const coJar = await h.staff("co@sample.example");
  const idOf = (unit: string) => (h.raw.query("SELECT id FROM voters WHERE unit = ?").get(unit) as { id: string }).id;
  return { h, jar, coJar, sid, slug, a1: idOf("A-1"), c3: idOf("C-3"), d4: idOf("D-4") };
}
type S = Awaited<ReturnType<typeof society>>;
const mk = (s: S, mode: string, extra: object = {}) => s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode, ...extra }, s.jar);
const marks = (s: S) => (s.h.raw.query("SELECT COUNT(*) AS n FROM att_marks").get() as { n: number }).n;

// ------------------------------------------------------------------------------------------------------------------ 1
describe("1. the public session list of a Voter List link", () => {
  test("a visitor who is not signed in sees the time, how, state and counts, but no title and no place", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    for (const url of [`/api/v/${s.slug}/attendance`, `/api/v/${s.slug}/attendance/${id}`]) {
      const r = await s.h.call("GET", url); expect(r.status).toBe(200);
      for (const word of ["Annual meeting", "Club house"]) expect(r.text, url).not.toContain(word);
      const one = r.json.sessions ? r.json.sessions[0] : r.json.session;
      expect(one).toMatchObject({ id, startsAt: "2026-12-05T18:00", mode: "online", modeText: "Online", status: "open", counts: { eligible: 4, present: 0 } });
      expect(one).not.toHaveProperty("title"); expect(one).not.toHaveProperty("place");
      expect(String(r.headers.get("vary")).toLowerCase(), url).toContain("cookie"); // the answer can differ by who asks, so no cache may mix them up
    }
  });

  test("signed in with a code but not on the list: still no title and no place", async () => {
    const s = await society(); await mk(s, "online");
    const stranger = await s.h.member(s.slug, "stranger@sample.example");
    const r = await s.h.call("GET", `/api/v/${s.slug}/attendance`, undefined, stranger);
    expect(r.status).toBe(200); expect(r.text).not.toContain("Annual meeting"); expect(r.text).not.toContain("Club house");
  });

  test("a voter who is on the list and signed in for this link sees the title and place; that answer is never cached", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    const v = await s.h.member(s.slug, "asha@sample.example");
    const list = await s.h.call("GET", `/api/v/${s.slug}/attendance`, undefined, v);
    expect(list.json.sessions[0]).toMatchObject({ id, title: "Annual meeting", place: "Club house" });
    const one = await s.h.call("GET", `/api/v/${s.slug}/attendance/${id}`, undefined, v);
    expect(one.json.session).toMatchObject({ title: "Annual meeting", place: "Club house" });
    for (const r of [list, one]) { const cc = String(r.headers.get("cache-control")); expect(cc).toContain("no-store"); expect(cc).not.toContain("public"); expect(String(r.headers.get("vary")).toLowerCase()).toContain("cookie"); }
    // what is shown to everyone stays shown to everyone
    expect(list.json.sessions[0].counts).toEqual({ eligible: 4, present: 0 });
  });

  test("being verified for another list does not unlock this one", async () => {
    const s = await society(); await mk(s, "online");
    const other = await newList(s.h, { email: "organizer2@sample.example" });
    await enrolVoter(s.h, other.slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
    await s.h.call("POST", `/api/lists/${other.sid}/records/decide`, { items: await waiting(s.h, other.sid, other.jar), decision: "approve" }, other.jar);
    const ashaThere = await s.h.member(other.slug, "asha@sample.example"); // verified, and on the list, but on the other list
    const r = await s.h.call("GET", `/api/v/${s.slug}/attendance`, undefined, ashaThere);
    expect(r.status).toBe(200); expect(r.text).not.toContain("Annual meeting");
  });

  test("a list made from an uploaded sheet keeps its titles in the public list (unchanged; the owner is asked whether it should follow)", async () => {
    const h = await makeHarness(); const jar = await h.staff("solo@sample.example");
    const up = await h.call("POST", "/api/attendance/rosters", { title: "Spring list", format: "paste", text: "Flat / House / Member ID,Name,E-mail ID\nA-1,Asha Sample,asha@sample.example\n" }, jar);
    const slug = (up.json.list.link as string).split("/").pop()!;
    await h.call("POST", `/api/lists/${up.json.list.id}/attendance/sessions`, { title: "Spring meeting", startsAt: "2026-12-05T18:00", place: "Hall", mode: "offline" }, jar);
    const r = await h.call("GET", `/api/v/${slug}/attendance`); expect(r.json.sessions[0]).toMatchObject({ title: "Spring meeting", place: "Hall" });
  });

  test("the staff pages still see every title and place", async () => {
    const s = await society(); await mk(s, "in_person");
    for (const jar of [s.jar, s.coJar]) expect((await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions`, undefined, jar)).json.sessions[0]).toMatchObject({ title: "Annual meeting", place: "Club house" });
  });
});

// ------------------------------------------------------------------------------------------------------------------ 2
describe("2. one e-mail ID marks one person in a session, even when it is on more than one flat", () => {
  const here = (s: S, id: string, jar: object, voterId?: string) => s.h.call("POST", `/api/v/${s.slug}/attendance/${id}/here`, voterId ? { voterId } : {}, jar);

  test("the second flat of the same e-mail ID is refused with a plain message, and nothing is written", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    s.h.clock.now = START - 10 * 60_000;
    const f = await s.h.member(s.slug, "family@sample.example");
    expect((await s.h.call("GET", `/api/v/${s.slug}/attend/me`, undefined, f)).json.rows).toHaveLength(2);
    expect((await here(s, id, f, s.c3)).status).toBe(200);
    const second = await here(s, id, f, s.d4);
    expect(second.status).toBe(409); expect(second.json.code).toBe("one_per_email"); expect(second.json.error).toBe(EM.ERR.onePerEmail);
    expect(marks(s)).toBe(1);
    expect(s.h.raw.query("SELECT voter_id FROM att_marks").get()).toEqual({ voter_id: s.c3 });
    // the same flat again is still the old answer
    expect((await here(s, id, f, s.c3)).json.code).toBe("already_present");
  });

  test("the message explains the rule and the way out, in plain words", () => {
    const m = EM.ERR.onePerEmail as string;
    expect(typeof m).toBe("string");
    expect(m).toContain("one person"); expect(m).toContain("more than one flat"); expect(m).toContain("Organizer or a co-organizer");
    expect(possessivesIn(m)).toEqual([]);
    for (const g of [EM.ERR.onePerEmail, EM.ERR.alreadyPresent, EM.ERR.closedMeanwhile, EM.ERR.alreadyClosed]) expect(g.length, g).toBeLessThanOrEqual(200); // a guard keeps 200 letters, so a longer message would be cut when two requests meet
  });

  test("the database refuses it too, whatever the code does", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    s.h.clock.now = START - 10 * 60_000;
    const f = await s.h.member(s.slug, "family@sample.example"); await here(s, id, f, s.c3);
    const by = (s.h.raw.query("SELECT marked_by FROM att_marks").get() as { marked_by: string }).marked_by;
    const ins = (method: string, voter: string, who: string) => s.h.raw.query("INSERT INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, 1)").run(id, s.sid, voter, method, who);
    expect(() => ins("email", s.d4, by)).toThrow(); // the same e-mail ID, another flat
    expect(() => ins("email", s.d4, "p_someoneelse")).not.toThrow(); // another e-mail ID is another person
    expect(() => ins("organizer", s.a1, by)).not.toThrow(); // a team member marks many people: the rule is for e-mail marks only
  });

  test("two requests at the same moment still give one mark", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    s.h.clock.now = START - 10 * 60_000;
    const f = await s.h.member(s.slug, "family@sample.example");
    const both = await Promise.all([here(s, id, f, s.c3), here(s, id, f, s.d4)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.json.error).toBe(EM.ERR.onePerEmail);
    expect(marks(s)).toBe(1);
  });

  test("the team can still mark the other flat; another session allows one mark again; other e-mail IDs are not affected", async () => {
    const s = await society(); const one = (await mk(s, "online")).json.session.id, two = (await mk(s, "online", { title: "Second meeting" })).json.session.id;
    s.h.clock.now = START - 10 * 60_000;
    const f = await s.h.member(s.slug, "family@sample.example"), a = await s.h.member(s.slug, "asha@sample.example");
    expect((await here(s, one, f, s.c3)).status).toBe(200);
    expect((await here(s, two, f, s.d4)).status).toBe(200); // another session, one more mark
    expect((await here(s, one, a)).status).toBe(200); // someone else
    const co = await s.h.staff("co@sample.example"); // a new sign-in: the clock moved on
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${one}/mark`, { voterId: s.d4 }, co)).status).toBe(200);
    expect(marks(s)).toBe(4);
  });

  test("the same-moment close and the already-closed answers come from the one message list", () => {
    expect(EM.ERR.closedMeanwhile).toBe("This session was closed at the same moment."); expect(EM.ERR.alreadyClosed).toBe("This session is already closed.");
    const src = read("src/attendance.ts");
    expect(callLiterals(src, /guard(?:Exists|Changed)/)).not.toContain("This session was closed at the same moment.");
    expect(sentences(callLiterals(src, /guard(?:Exists|Changed)/))).toEqual([]); // no message text of its own in the guards
  });

  test("migration 0012 can run twice", async () => {
    const h = await makeHarness(); const { readFileSync } = await import("node:fs");
    h.raw.exec(readFileSync("migrations/0012_attendance_one_self_mark.sql", "utf8"));
  });
});

// ------------------------------------------------------------------------------------------------------------------ 3
describe("3. the co-organizer's view: CSV, find box and the page", () => {
  const detail = (s: S, id: string, jar: object, find = "") => s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${id}?find=${encodeURIComponent(find)}`, undefined, jar);
  const csvOf = (s: S, id: string, jar: object) => s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${id}/sheet.csv`, undefined, jar);

  test("the session says which view it is: full for the Organizer, limited for a co-organizer", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    expect((await detail(s, id, s.jar)).json.view).toBe("full");
    expect((await detail(s, id, s.coJar)).json.view).toBe("limited");
  });

  test("the co-organizer's sheet is the limited view and says so in its column names and file name; the Organizer's sheet is as before", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    const full = await csvOf(s, id, s.jar), limited = await csvOf(s, id, s.coJar);
    const head = (t: string) => t.split("\r\n")[0];
    expect(head(full.text)).toBe("Flat / House / Member ID,Name,E-mail ID,Present,Marked how,Marked at");
    expect(full.headers.get("content-disposition")).toContain('filename="attendance-sheet.csv"');
    expect(full.text).toContain("Asha Sample,asha@sample.example");
    expect(head(limited.text)).toBe("Flat / House / Member ID,Name (partly hidden),E-mail ID (partly hidden),Present,Marked how,Marked at");
    expect(limited.headers.get("content-disposition")).toContain('filename="attendance-sheet-limited.csv"');
    for (const hidden of ["Asha Sample", "asha@sample.example", "Bharat Sample", "family@sample.example", "Chitra", "Dev Family"]) expect(limited.text).not.toContain(hidden);
    expect(limited.text.trim().split("\r\n")).toHaveLength(5); // the head and the four people, as before
    const trail = s.h.raw.query("SELECT entry_json FROM audit_entries WHERE type = 'attendance.sheet_exported' ORDER BY seq").all() as { entry_json: string }[];
    expect(trail.map((r) => JSON.parse(r.entry_json).payload.full)).toEqual([true, false]); // the signed log records which view each download was
  });

  test("a co-organizer finds a person by flat or member ID only, not by name; the Organizer can use both", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    expect((await detail(s, id, s.coJar, "asha")).json.people).toEqual([]); // typing a name must not show which row holds it
    expect((await detail(s, id, s.coJar, "sample")).json.people).toEqual([]);
    const byFlat = (await detail(s, id, s.coJar, "A-1")).json.people; expect(byFlat).toHaveLength(1); expect(byFlat[0].unit).toBe("A-1"); expect(byFlat[0].name).not.toContain("Asha Sample");
    expect((await detail(s, id, s.jar, "asha")).json.people.map((p: any) => p.unit)).toEqual(["A-1"]);
    expect((await detail(s, id, s.jar, "A-1")).json.people).toHaveLength(1);
  });

  // ---- the page (run on a tiny fake page, as in the earlier round tests)
  const OPEN = { id: "att_1", title: "Meeting", status: "open", startsAt: "2026-12-05T18:00", place: "Hall", modeText: "Online", mode: "online", counts: { present: 0, eligible: 2 } };
  async function pageAt(role: "organizer" | "co-organizer", view?: string) {
    const pg = runPage("public/assets/attendance.js", async (_m, p) => {
      if (p === "/api/attendance/lists") return { email: "o@x.com", countries: ["India"], lists: [{ id: "soc_1", name: "L", kind: "voter_list", role, link: "/attend/x" }] };
      if (p.includes("/attendance/sessions/att_1")) return { session: OPEN, people: [{ voterId: "v1", unit: "A-1", name: "Asa", email: "a", present: false }], ...(view ? { view } : {}) };
      if (p.endsWith("/attendance/sessions")) return { sessions: [OPEN] };
      return {};
    });
    await tick(); await tick();
    await pg.find((n) => n.tag === "button" && n.kids.join("") === "Open")[0].attrs.on.click(); await tick();
    return pg;
  }
  test("the page shows the limited view to a co-organizer, and the find box asks for a flat or member ID only", async () => {
    const pg = await pageAt("co-organizer", "limited");
    expect(pg.text()).toContain(LIMITED_LINE); expect(pg.text()).not.toContain(FULL_LINE);
    expect(pg.find((n) => n.tag === "input" && n.attrs.id === "fd")[0].attrs.placeholder).toBe("Flat / House / Member ID");
  });
  test("the page shows the full view to the Organizer, and the find box also takes a name", async () => {
    const pg = await pageAt("organizer", "full");
    expect(pg.text()).toContain(FULL_LINE); expect(pg.text()).not.toContain(LIMITED_LINE);
    expect(pg.find((n) => n.tag === "input" && n.attrs.id === "fd")[0].attrs.placeholder).toBe("Flat / House / Member ID or Name");
  });
  test("when the answer has no view, the page follows the role (a co-organizer is shown the limited view)", async () => {
    expect((await pageAt("co-organizer")).text()).toContain(LIMITED_LINE);
    expect((await pageAt("organizer")).text()).toContain(FULL_LINE);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 4
const win: any = {}; new Function("window", read("public/assets/lang/hi.js"))(win);
const hi = win.VL_LANGS.hi;
const hasHindi = (s: string) => Object.prototype.hasOwnProperty.call(hi.words, s.trim()) || hi.patterns.some(([re]: [RegExp]) => re.test(s.trim()));
const hindiOf = (s: string): string => { const t = s.trim(); if (Object.prototype.hasOwnProperty.call(hi.words, t)) return hi.words[t]; for (const [re, fn] of hi.patterns as [RegExp, (...a: string[]) => string][]) { const m = re.exec(t); if (m) return fn(...m.slice(1)); } return ""; };
win.VL = { tr: (s: string) => hindiOf(s) || s }; // the country-list pattern turns each name into Hindi through the page's own helper

/** The page texts this round adds (the pages are checked against these exact words in the tests above and below). */
const LIMITED_LINE = "Limited view: names and e-mail IDs are partly hidden, here and in the downloaded sheet. Only the Organizer sees them in full.";
const FULL_LINE = "Full view: names and e-mail IDs are shown in full, here and in the downloaded sheet.";
const MANY_FLATS_LINE = "This e-mail ID is on more than one flat. It counts as one person, so it can mark one person present in each session. To mark someone else, please ask the Organizer or a co-organizer.";
const LOAD_FAILED = "This page could not be opened just now. Nothing was changed. Please try again.";
const TRY_AGAIN = "Try again";
const PAGE_TEXTS_ADDED = [LIMITED_LINE, FULL_LINE, MANY_FLATS_LINE, LOAD_FAILED, TRY_AGAIN];
/** Messages that were built in other files (the sign-in code and the signed log) and had no Hindi line. */
const CODE_LIMIT_HOUR = "Several codes were sent to this e-mail ID already. Please check the inbox (and the spam folder), or try again in an hour.";
const CODE_LIMIT_DAY = "This e-mail ID has had all its codes for today. Please try again tomorrow.";
const CONFLICT = "Someone else changed this at the same moment. Please look again and try once more.";
const SOMETHING_WRONG = "Something went wrong on our side. Nothing was lost; please try again.";
const RECORD_FIXED = "That record is fixed and cannot be changed.";

describe("4. Hindi for the texts the server builds", () => {
  test("the one list of server-built texts holds the modes, the upload reasons, the country names and every message, and each has Hindi", () => {
    const texts = EM.SERVER_TEXTS as readonly string[];
    expect(Array.isArray(texts)).toBe(true);
    for (const t of [...Object.values(EM.MODE_WORDS), ...Object.values(EM.ROSTER_WHY), ...Object.keys(EM.COUNTRY_TZ), ...EM.UPLOAD_ERRORS, ...EM.NO_CONTACT, ...EM.ERROR_MESSAGES]) expect(texts, t).toContain(t);
    expect(texts.length).toBeGreaterThan(80);
    expect(texts.filter((t) => !hasHindi(t))).toEqual([]);
  });

  test("the mode texts the session views carry (modeText) are the ones in the list, each with its own Hindi", async () => {
    const s = await society();
    for (const mode of ["in_person", "online", "offline"] as const) {
      const made = await mk(s, mode); expect(made.json.session.modeText).toBe(EM.MODE_WORDS[mode]);
      expect(hasHindi(EM.MODE_WORDS[mode]), mode).toBe(true); expect(hindiOf(EM.MODE_WORDS[mode])).toMatch(/[ऀ-ॿ]/);
    }
  });

  test("a server message that is built in another file cannot slip in without Hindi: upload errors, code limits, conflicts, guards", () => {
    const upload = ["src/importer.ts", "src/xlsx.ts", "src/csv.ts"].flatMap((f) => sentences(callLiterals(read(f), /new Error/, true)));
    expect(upload.length).toBeGreaterThan(10);
    for (const m of upload) { expect(EM.SERVER_TEXTS, m).toContain(m); expect(hasHindi(m), m).toBe(true); }
    const limits = sentences(callLiterals(read("src/auth.ts"), /rateLimit/)); expect(limits).toEqual([CODE_LIMIT_HOUR, CODE_LIMIT_DAY]);
    const signedLog = sentences(callLiterals(read("src/audit.ts"), /new HttpError/)); expect(signedLog).toContain(CONFLICT);
    for (const m of [...limits, ...signedLog]) { expect(EM.SERVER_TEXTS, m).toContain(m); expect(hasHindi(m), m).toBe(true); }
    // the entry point builds two messages itself (not through HttpError): a failure on our side, which the retry screen shows, and a fixed record
    const own = sentences(callLiterals(read("src/handler.ts"), /json/)).filter((m) => m !== "Please say true or false."); /* a Voter List organizer page message, which the attendance pages never show (it has its own Hindi line) */ expect(own).toEqual(expect.arrayContaining([SOMETHING_WRONG, RECORD_FIXED]));
    for (const m of own) { expect(EM.SERVER_TEXTS, m).toContain(m); expect(hasHindi(m), m).toBe(true); }
  });

  test("the messages a person meets when a title, place or list name holds a phone number have Hindi", async () => {
    const s = await society(); const post = (b: object) => s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { startsAt: "2026-12-05T18:00", mode: "online", title: "Meeting", ...b }, s.jar);
    const bad = [(await post({ title: "Call 9876543210" })).json.error, (await post({ place: "Ring 9876543210" })).json.error];
    const jar = await s.h.staff("solo@sample.example");
    bad.push((await s.h.call("POST", "/api/attendance/rosters", { title: "List 9876543210", format: "paste", text: "x" }, jar)).json.error);
    expect(bad).toEqual(["the title", "the place", "the name"].map((w) => `Please do not write phone numbers or e-mail IDs in ${w}.`));
    for (const m of bad) { expect(EM.SERVER_TEXTS, m).toContain(m); expect(hasHindi(m), m).toBe(true); }
  });

  test("the count in the sessions table (3 of 10) and the country names show in Hindi", () => {
    expect(hindiOf("3 of 10")).toBe("10 में से 3");
    for (const c of Object.keys(EM.COUNTRY_TZ)) { expect(hasHindi(c), c).toBe(true); expect(hindiOf(c)).toMatch(/[ऀ-ॿ]/); }
  });

  test("the Hindi is real Hindi, not the English again", () => {
    for (const t of EM.SERVER_TEXTS as readonly string[]) if (!/^(Excel|CSV)$/.test(t)) { const h = hindiOf(t); expect(h, t).not.toBe(t); expect(h, t).toMatch(/[ऀ-ॿ]/); }
    for (const t of PAGE_TEXTS_ADDED) { expect(hasHindi(t), t).toBe(true); expect(hindiOf(t)).toMatch(/[ऀ-ॿ]/); }
  });

  test("no Hindi on a consent line: none of the added lines is about the Terms, agreeing or consent, and the notice still has none", () => {
    const added = [...PAGE_TEXTS_ADDED, ...(EM.SERVER_TEXTS as readonly string[])];
    for (const t of added) { expect(/terms|agree|accept|consent|By pressing/i.test(t), t).toBe(false); expect(/सहमति|सहमत|शर्त|नियम और शर्तें/.test(hindiOf(t)), t).toBe(false); }
    for (const t of ["By pressing Mark present, the entry is recorded under the", "By pressing Mark present, this e-mail ID is recorded as present under the", "Terms and Conditions"]) expect(hasHindi(t), t).toBe(false);
  });

  test("every Hindi line added this round is in the list of lines that need a native Hindi reader", () => {
    const src = read("public/assets/lang/hi.js");
    const block = /NEEDS NATIVE REVIEW[^\n]*\n([\s\S]*?)END NEEDS NATIVE REVIEW/.exec(src)?.[1] ?? "";
    const listed = [...block.matchAll(/^\s*\/\/\s+\d+\.\s+(".*")\s*$/gm)].map((m) => JSON.parse(m[1]!) as string);
    expect(listed.length).toBeGreaterThan(38);
    for (const t of listed) expect(hasHindi(t), "listed but no Hindi: " + t).toBe(true);
    const added = [...PAGE_TEXTS_ADDED, EM.ERR.onePerEmail, EM.ERR.closedMeanwhile, EM.ERR.alreadyClosed, CODE_LIMIT_HOUR, CODE_LIMIT_DAY, CONFLICT, SOMETHING_WRONG, RECORD_FIXED, ...EM.UPLOAD_ERRORS, ...EM.NO_CONTACT, ...Object.keys(EM.COUNTRY_TZ), "3 of 10"];
    expect(added.filter((t) => !listed.includes(t))).toEqual([]);
    expect(/native/i.test(block)).toBe(true);
  });

  test("the pages use exactly the added page texts, and every one of them is in the page script", () => {
    const src = read("public/assets/attendance.js") + read("public/assets/attend.js");
    for (const t of PAGE_TEXTS_ADDED) expect(src, t).toContain(JSON.stringify(t));
  });
});

// ------------------------------------------------------------------------------------------------------------------ 5
describe("5. my / mine / your / yours in text the server builds", () => {
  test("the scanner finds each word, ignores other words, and allows only the one exact sentence", () => {
    for (const bad of ["Please give your name.", "My record", "That one is mine.", "Yours truly", "YOUR list", "text ${x ? 'your' : 'the'}"]) expect(possessivesIn(bad).length, bad).toBeGreaterThan(0);
    for (const ok of ["Determine the number.", "Mining is fine", "You can add a name.", "Their list", "A yourself-free sentence about the yourselves", ALLOWED_SENTENCE, "Please. " + ALLOWED_SENTENCE + " Thanks."]) expect(possessivesIn(ok), ok).toEqual([]);
    for (const near of ["Copy this link and paste in your AI to work", "Copy this link and paste in your AI.", "copy this link and paste in your ai to work.", ALLOWED_SENTENCE + " Then your turn."]) expect(possessivesIn(near).length, near).toBeGreaterThan(0);
  });

  test("the literal scanner reads template literals properly, so a word inside ${ } cannot hide", () => {
    expect(stringLiterals('const a = "x y"; // "your c"\n/* "mine" */ const b = `t ${ok ? "your" : "the"} u`; const c = \'z\';')).toEqual(expect.arrayContaining(["x y", "your", "the", "t   u", "z"]));
    expect(possessivesIn(stringLiterals("const m = `Hello ${ok ? 'your' : 'the'} list`;").join(" "))).toEqual(["your"]);
  });

  test("no source file or page that builds text for people has one: src, functions, dev server, scripts, scripts of the pages and the pages", () => {
    const files = [...filesUnder("src", /\.ts$/), ...filesUnder("functions", /\.ts$/), "dev.ts", ...filesUnder("scripts", /\.ts$/), ...filesUnder("public", /\.js$/).filter((f) => !f.endsWith("lang/hi.js"))];
    const found: string[] = [];
    for (const f of files) for (const lit of stringLiterals(read(f))) if (possessivesIn(lit).length) found.push(f + ": " + lit.slice(0, 80));
    for (const f of filesUnder("public", /\.html$/)) for (const t of pageTexts(read(f))) if (possessivesIn(t).length) found.push(f + ": " + t.replace(/\s+/g, " ").slice(0, 80));
    expect(found).toEqual([]);
  });

  test("the live texts have none: every message, the modes, the upload reasons, the countries, the CSV sheets, the e-mailed codes and what the API says", async () => {
    const s = await society(); const sid = (await mk(s, "in_person")).json.session.id;
    const texts: string[] = [...(EM.SERVER_TEXTS as readonly string[])];
    // e-mails: a staff code, a voter code and the invitation to a co-organizer
    for (const r of s.h.raw.query("SELECT subject, body FROM mail_outbox").all() as { subject: string; body: string }[]) texts.push(r.subject, r.body);
    // the two sheets (head and words), the session views
    for (const jar of [s.jar, s.coJar]) texts.push((await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${sid}/sheet.csv`, undefined, jar)).text);
    texts.push(JSON.stringify((await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions/${sid}`, undefined, s.coJar)).json));
    texts.push(JSON.stringify((await s.h.call("GET", "/api/attendance/lists", undefined, s.jar)).json));
    // what the API says to mistakes a person can make
    const jar = await s.h.staff("solo@sample.example");
    const tries: [string, string, unknown, object?][] = [
      ["POST", "/api/auth/start", { email: "nope" }], ["POST", "/api/auth/verify", { email: "a@b.example", code: "000000" }], ["GET", `/api/lists/${s.sid}/attendance/sessions`, undefined],
      ["POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "x" }, s.coJar], ["POST", `/api/lists/${s.sid}/attendance/sessions/${sid}/mark`, { voterId: "nobody" }, s.jar],
      ["POST", "/api/attendance/rosters", { title: "List", format: "paste", text: "nothing here" }, jar], ["POST", "/api/attendance/rosters", { title: "List", format: "paste", text: "Flat / House / Member ID,Name,E-mail ID\nA-1,Asha,\n", dryRun: true }, jar],
      ["GET", `/api/v/${s.slug}/attend/me`, undefined], ["GET", "/api/v/0123456789abcdef/attendance", undefined],
    ];
    for (const [m, p, b, j] of tries) texts.push((await s.h.call(m, p, b, j ?? (p.startsWith("/api/attendance") ? jar : undefined))).text);
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.filter((t) => possessivesIn(t).length)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 6
/** Run a page script on a tiny fake page (the same idea as in the earlier round tests). */
function runPage(file: string, api: (m: string, p: string, b?: any) => Promise<any>, path = "/attend/abc") {
  const errs: string[] = [];
  const el = (tag: string, attrs: any = {}, ...kids: any[]) => ({ tag, attrs: attrs || {}, kids: kids.flat(9), addEventListener() {}, append(...k: any[]) { (this as any).kids.push(...k.flat(9)); } });
  const root: any = { kids: [] as any[], replaceChildren(...k: any[]) { this.kids = k.flat(9); } };
  const who: any = { kids: [] as any[], replaceChildren(...k: any[]) { this.kids = k.flat(9); } };
  const VL: any = {
    el, api, toast() {}, fail: (e: any) => errs.push(e.message || String(e)), busy: async (_b: any, fn: () => Promise<void>) => fn(), captcha: () => ({ node: null, token: () => "t", reset() {} }),
    err: () => ({ clear() {}, show: (m: string) => errs.push(m) }), localTime: (s: any) => String(s), stepbar: () => null, plural: (n: number, a: string) => n + " " + a, copy() {}, focusStep() {}, fill() {}, table: (_h: any, rows: any) => el("table", {}, rows),
    confirm: async () => true,
    stepcards: (steps: any[]) => steps.map((st) => [st.title, st.state === "locked" ? st.lockedNote : typeof st.body === "function" ? st.body() : st.body]),
  };
  new Function("window", "document", "location", "fetch", read(file))({ VL }, { getElementById: (id: string) => (id === "app" ? root : who) }, { pathname: path, hash: "" }, () => { throw new Error("no fetch"); });
  const text = (n: any): string => (n == null ? "" : typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join(" ") : [...(n.kids || [])].map(text).join(" "));
  const find = (n: any, f: (x: any) => boolean, out: any[] = []): any[] => { if (n && typeof n === "object") { if (f(n)) out.push(n); (n.kids || []).forEach((k: any) => find(k, f, out)); } return out; };
  return { errs, root, text: () => text(root.kids), find: (f: (x: any) => boolean) => find({ kids: root.kids }, f) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const httpErr = (status: number, message = "Something went wrong.", code?: string) => Object.assign(new Error(message), { status, code });
const retryButtons = (pg: ReturnType<typeof runPage>) => pg.find((n) => n.tag === "button" && n.kids.join("") === TRY_AGAIN);

describe("6. a failed first load shows a kind error with a retry, not a stuck Loading", () => {
  const PAGES = [
    { name: "organizer page", file: "public/assets/attendance.js", ok: async (_m: string, p: string) => { if (p === "/api/attendance/lists") throw httpErr(401); return {}; }, drawn: "Send a code", firstPath: "/api/attendance/lists" },
    { name: "voter page", file: "public/assets/attend.js", ok: async (_m: string, p: string) => { if (p.endsWith("/attend/me")) throw httpErr(401); return { list: "Hall list", sessions: [] }; }, drawn: "Hall list", firstPath: "/api/v/abc/attendance" },
  ];
  for (const P of PAGES) for (const status of [500, 503, 404, 403, 0]) {
    test(`${P.name}: a ${status || "dropped connection"} answer shows the kind line and a Try again button; pressing it loads the page`, async () => {
      let failing = true; const calls: string[] = [];
      const pg = runPage(P.file, async (m, p) => { calls.push(m + " " + p); if (failing) throw httpErr(status, status ? "Something went wrong on our side. Nothing was lost; please try again." : "The connection dropped. Nothing was changed. Please try again."); return P.ok(m, p); });
      await tick();
      expect(pg.root.kids.length, "the page is no longer the bare Loading line").toBeGreaterThan(0);
      expect(pg.text()).toContain(LOAD_FAILED);
      expect(pg.text()).toContain(status ? "Something went wrong on our side." : "The connection dropped.");
      const retry = retryButtons(pg); expect(retry).toHaveLength(1); expect(retry[0].attrs.type).toBe("button");
      failing = false; calls.length = 0; await retry[0].attrs.on.click(); await tick();
      expect(calls[0]).toContain(P.firstPath);
      expect(pg.text()).not.toContain(LOAD_FAILED); expect(pg.text()).toContain(P.drawn);
    });
  }

  test("a retry that fails again shows the line and the button again, and a later success loads the page", async () => {
    let fails = 2;
    const pg = runPage("public/assets/attendance.js", async (_m, p) => { if (fails > 0) { fails--; throw httpErr(502); } if (p === "/api/attendance/lists") throw httpErr(401); return {}; });
    await tick(); expect(retryButtons(pg)).toHaveLength(1);
    await retryButtons(pg)[0].attrs.on.click(); await tick(); expect(pg.text()).toContain(LOAD_FAILED); expect(retryButtons(pg)).toHaveLength(1);
    await retryButtons(pg)[0].attrs.on.click(); await tick(); expect(pg.text()).toContain("Send a code");
  });

  test("organizer page: the sessions of the chosen list failing to load also shows the line and the button", async () => {
    let ok = false;
    const pg = runPage("public/assets/attendance.js", async (_m, p) => {
      if (p === "/api/attendance/lists") return { email: "o@x.com", countries: [], lists: [{ id: "soc_1", name: "L", kind: "voter_list", role: "organizer", link: "/attend/x" }] };
      if (p.endsWith("/attendance/sessions")) { if (!ok) throw httpErr(500); return { sessions: [] }; }
      return {};
    });
    await tick(); expect(pg.text()).toContain(LOAD_FAILED); expect(retryButtons(pg)).toHaveLength(1);
    ok = true; await retryButtons(pg)[0].attrs.on.click(); await tick(); expect(pg.text()).not.toContain(LOAD_FAILED); expect(pg.text()).toContain("There is no session yet.");
  });

  test("voter page: the call for this e-mail ID failing (not 401) also shows the line and the button", async () => {
    const pg = runPage("public/assets/attend.js", async (_m, p) => { if (p.endsWith("/attend/me")) throw httpErr(500); return { list: "Hall list", sessions: [] }; });
    await tick(); expect(pg.text()).toContain(LOAD_FAILED); expect(retryButtons(pg)).toHaveLength(1);
  });

  test("a fault in the page itself (not an answer from the server) shows the same kind line and button, without the script's own words", async () => {
    const a = runPage("public/assets/attendance.js", async (_m, p) => (p === "/api/attendance/lists" ? {} : {})); await tick(); // an answer with no lists: the page code trips
    expect(a.text()).toContain(LOAD_FAILED); expect(a.text()).not.toMatch(/undefined|Cannot read|TypeError|is not a function/); expect(retryButtons(a)).toHaveLength(1);
    const v = runPage("public/assets/attend.js", async (_m, p) => (p.endsWith("/attend/me") ? { email: "a@b.com" } : { list: "Hall list" })); await tick();
    expect(v.text()).toContain(LOAD_FAILED); expect(v.text()).not.toMatch(/undefined|Cannot read|TypeError|is not a function/); expect(retryButtons(v)).toHaveLength(1);
  });

  test("the answers that already had their own page are unchanged: 401 opens sign-in, 410 says the list is closed, neither shows the retry", async () => {
    const a = runPage("public/assets/attendance.js", async () => { throw httpErr(401); }); await tick();
    expect(a.text()).toContain("Send a code"); expect(retryButtons(a)).toHaveLength(0);
    const v = runPage("public/assets/attend.js", async () => { throw httpErr(410, "This list has been closed and its details erased."); }); await tick();
    expect(v.text()).toContain("This list has been closed. Nothing can be marked here."); expect(retryButtons(v)).toHaveLength(0); expect(v.errs).toEqual([]);
  });

  test("the error words are plain and kind: no my / your, and the line is in the message list", () => {
    expect(possessivesIn(LOAD_FAILED + " " + TRY_AGAIN)).toEqual([]);
    expect(EM.ERROR_MESSAGES).toContain(LOAD_FAILED);
  });

  test("the voter page explains the one-person rule to an e-mail ID that is on more than one flat, and not to one that is on a single flat", async () => {
    const api = (rows: object[]) => async (_m: string, p: string) => {
      if (p.endsWith("/attend/me")) return { email: "a@b.com", rows };
      return { list: "Hall list", sessions: [{ id: "att_1", title: "Meeting", place: "Hall", mode: "online", modeText: "Online", status: "open", startsAt: "2026-12-05T18:00" }] };
    };
    const two = runPage("public/assets/attend.js", api([{ voterId: "v1", unit: "A-1" }, { voterId: "v2", unit: "B-2" }])); await tick();
    expect(two.text()).toContain(MANY_FLATS_LINE);
    const one = runPage("public/assets/attend.js", api([{ voterId: "v1", unit: "A-1" }])); await tick();
    expect(one.text()).not.toContain(MANY_FLATS_LINE); expect(one.text()).toContain("Mark present");
  });
});
