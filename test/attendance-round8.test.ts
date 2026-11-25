// Round 8 fixes for Attendance chunks 1-2 (version 0.3.4). One block per audit finding.
//   1 the public session list shows no title or place for any kind of list     3 a request that carries a cookie is never cached
//   2 an e-mail ID is one person however it is typed                            4 the version, the commit fields and the notes agree
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { pseudonym } from "../src/audit";
import * as attendance from "../src/attendance";
import { getSociety } from "../src/store";
import { enrolVoter, makeHarness, newList, waiting, type Harness, type Jar } from "./harness";
import { read } from "./scan";

const START = Date.UTC(2026, 11, 5, 12, 30); // 2026-12-05T18:00 in India
const SELF_MARK_TIME = START - 10 * 60_000;

const SHEET = "Flat / House / Member ID,Name,E-mail ID\nA-1,Asha Sample,asha@sample.example\nB-2,Bharat Sample,bharat@sample.example\n";
/** A list made from an uploaded sheet, with one online session. */
async function sheetList(h: Harness) {
  const jar = await h.staff("solo@sample.example");
  const up = await h.call("POST", "/api/attendance/rosters", { title: "Spring list", format: "paste", text: SHEET }, jar);
  expect(up.status).toBe(201);
  const sid = up.json.list.id as string, slug = (up.json.list.link as string).split("/").pop()!;
  const made = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Spring meeting", startsAt: "2026-12-05T18:00", place: "Hall", mode: "online" }, jar);
  expect(made.status).toBe(201);
  return { jar, sid, slug, aid: made.json.session.id as string };
}
/** A Voter List with one approved voter (Asha, flat A-1) and one online session. */
async function voterList(h: Harness) {
  const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  const made = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode: "online" }, jar);
  expect(made.status).toBe(201);
  return { jar, sid, slug, aid: made.json.session.id as string };
}
const publicUrls = (slug: string, aid: string) => [`/api/v/${slug}/attendance`, `/api/v/${slug}/attendance/${aid}`];
const oneOf = (r: { json: any }) => (r.json.sessions ? r.json.sessions[0] : r.json.session);

// ------------------------------------------------------------------------------------------------------------------ 1
describe("1. the public session list shows no title or place for any kind of list", () => {
  test("a list made from an uploaded sheet: a stranger sees no title and no place, on both routes; time, how, state and counts stay", async () => {
    const h = await makeHarness(); const s = await sheetList(h);
    for (const url of publicUrls(s.slug, s.aid)) {
      const r = await h.call("GET", url); expect(r.status, url).toBe(200);
      for (const word of ["Spring meeting", "Hall"]) expect(r.text, url).not.toContain(word);
      expect(oneOf(r), url).toMatchObject({ id: s.aid, startsAt: "2026-12-05T18:00", mode: "online", modeText: "Online", status: "open", counts: { eligible: 2, present: 0 } });
      expect(oneOf(r)).not.toHaveProperty("title"); expect(oneOf(r)).not.toHaveProperty("place");
    }
  });

  test("a list made from an uploaded sheet: signed in with a code but not on the list still sees neither", async () => {
    const h = await makeHarness(); const s = await sheetList(h);
    const stranger = await h.member(s.slug, "stranger@sample.example");
    for (const url of publicUrls(s.slug, s.aid)) { const r = await h.call("GET", url, undefined, stranger); expect(r.status).toBe(200); expect(r.text, url).not.toContain("Spring meeting"); expect(r.text, url).not.toContain("Hall"); }
  });

  test("a list made from an uploaded sheet: a voter who is on it and signed in for its link sees the title and place, and that answer is never cached", async () => {
    const h = await makeHarness(); const s = await sheetList(h);
    const asha = await h.member(s.slug, "asha@sample.example");
    for (const url of publicUrls(s.slug, s.aid)) {
      const r = await h.call("GET", url, undefined, asha);
      expect(oneOf(r), url).toMatchObject({ id: s.aid, title: "Spring meeting", place: "Hall" });
      const cc = String(r.headers.get("cache-control")); expect(cc).toContain("no-store"); expect(cc).not.toContain("public"); expect(String(r.headers.get("vary")).toLowerCase()).toContain("cookie");
    }
  });

  test("the team's own page of a list made from an uploaded sheet still shows the title and the place", async () => {
    const h = await makeHarness(); const s = await sheetList(h);
    const r = await h.call("GET", `/api/lists/${s.sid}/attendance/sessions`, undefined, s.jar);
    expect(r.json.sessions[0]).toMatchObject({ title: "Spring meeting", place: "Hall" });
  });

  test("a Voter List is unchanged: a stranger sees neither, a voter who is on it and signed in sees both, the team sees both", async () => {
    const h = await makeHarness(); const s = await voterList(h);
    for (const url of publicUrls(s.slug, s.aid)) { const r = await h.call("GET", url); expect(r.text, url).not.toContain("Annual meeting"); expect(r.text, url).not.toContain("Club house"); }
    const asha = await h.member(s.slug, "asha@sample.example");
    for (const url of publicUrls(s.slug, s.aid)) expect(oneOf(await h.call("GET", url, undefined, asha)), url).toMatchObject({ title: "Annual meeting", place: "Club house" });
    expect((await h.call("GET", `/api/lists/${s.sid}/attendance/sessions`, undefined, s.jar)).json.sessions[0]).toMatchObject({ title: "Annual meeting", place: "Club house" });
  });
});

// ------------------------------------------------------------------------------------------------------------------ 2
describe("2. an e-mail ID is one person however it is typed", () => {
  /** A Voter List where one e-mail ID (written in a messy way each time) is on two flats, and another is on one flat. */
  async function family() {
    const h = await makeHarness(); const s = await voterList(h);
    const add = (unit: string, email: string, name: string) => h.call("POST", `/api/lists/${s.sid}/records`, { unit, name, capacity: "Owner", mobile: "9000000" + String(300 + unit.charCodeAt(0)), email, agreed: true }, s.jar);
    expect((await add("C-3", "  Family+Tag@Sample.Example ", "Chitra Family")).status).toBe(201);
    expect((await add("D-4", "mailto:FAMILY+TAG@SAMPLE.EXAMPLE,", "Dev Family")).status).toBe(201);
    const idOf = (unit: string) => (h.raw.query("SELECT id FROM voters WHERE unit = ?").get(unit) as { id: string }).id;
    const society = (await getSociety(h.env, s.sid))!;
    return { h, ...s, society, c3: idOf("C-3"), d4: idOf("D-4"), a1: idOf("A-1") };
  }
  type F = Awaited<ReturnType<typeof family>>;
  const marked = (f: F) => f.h.raw.query("SELECT voter_id, marked_by FROM att_marks").all() as { voter_id: string; marked_by: string }[];

  test("the e-mail ID is stored tidied by the enrol and upload paths: a staff add, a file import, a sheet upload and a voter's own enrolment", async () => {
    const f = await family();
    expect(f.h.raw.query("SELECT email FROM voters WHERE unit IN ('C-3', 'D-4') ORDER BY unit").all()).toEqual([{ email: "family+tag@sample.example" }, { email: "family+tag@sample.example" }]);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail", "E-5,Esha Import,Owner,9000000405,  ESHA+Tag@Sample.Example  "].join("\n");
    expect((await f.h.call("POST", `/api/lists/${f.sid}/records/import`, { format: "csv", text: csv }, f.jar)).status).toBe(200);
    expect(f.h.raw.query("SELECT email FROM voters WHERE unit = 'E-5'").get()).toEqual({ email: "esha+tag@sample.example" });
    const sheet = await sheetList(f.h);
    const text = "Flat / House / Member ID,Name,E-mail ID\nF-6,Fatima Sheet, FATIMA+Tag@Sample.Example \n";
    expect((await f.h.call("POST", "/api/attendance/rosters", { title: "Another list", format: "paste", text }, sheet.jar)).status).toBe(201);
    expect(f.h.raw.query("SELECT email FROM voters WHERE unit = 'F-6'").get()).toEqual({ email: "fatima+tag@sample.example" });
    await enrolVoter(f.h, f.slug, "gita+tag@sample.example", { unit: "G-7", name: "Gita Own", mobile: "9000000407" });
    expect(f.h.raw.query("SELECT email FROM voters WHERE unit = 'G-7'").get()).toEqual({ email: "gita+tag@sample.example" });
  });

  test("however the e-mail ID is typed (spaces, capitals, mailto:, a trailing comma, a +tag), it finds both of its flats", async () => {
    const f = await family();
    for (const typed of ["family+tag@sample.example", "  Family+Tag@Sample.Example ", "FAMILY+TAG@SAMPLE.EXAMPLE", "mailto:family+tag@sample.example", "family+tag@sample.example,"]) {
      const mine = await attendance.myRows(f.h.env, f.society, typed);
      expect(mine.rows.map((r) => r.unit).sort(), typed).toEqual(["C-3", "D-4"]);
    }
    // another e-mail ID is another person
    expect((await attendance.myRows(f.h.env, f.society, " ASHA@sample.example ")).rows.map((r) => r.unit)).toEqual(["A-1"]);
  });

  test("a +tag is part of the e-mail ID: the same address without it is another person and is not on the list", async () => {
    const f = await family();
    expect((await attendance.myRows(f.h.env, f.society, "family@sample.example")).rows).toEqual([]);
    await expect(attendance.markSelf(f.h.env, SELF_MARK_TIME, f.society, "family@sample.example", f.aid, f.c3)).rejects.toMatchObject({ status: 403, code: "not_on_list" });
    expect(marked(f)).toEqual([]);
  });

  test("one e-mail ID marks one person in a session, however each try is typed; the same flat again is 'already present'; nothing is counted twice", async () => {
    const f = await family();
    const first = await attendance.markSelf(f.h.env, SELF_MARK_TIME, f.society, "  FAMILY+Tag@Sample.Example ", f.aid, f.c3);
    expect(first).toMatchObject({ ok: true, present: true, unit: "C-3", method: "email" });
    await expect(attendance.markSelf(f.h.env, SELF_MARK_TIME, f.society, "mailto:family+tag@sample.example", f.aid, f.d4)).rejects.toMatchObject({ status: 409, code: "one_per_email" });
    await expect(attendance.markSelf(f.h.env, SELF_MARK_TIME, f.society, "Family+Tag@Sample.Example,", f.aid, f.c3)).rejects.toMatchObject({ status: 409, code: "already_present" });
    const rows = marked(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ voter_id: f.c3, marked_by: await pseudonym(f.h.env, "family+tag@sample.example") }); // the private code is the same whichever way the e-mail ID was typed
    expect((await attendance.publicSession(f.h.env, f.society, f.aid)).body.session.counts).toEqual({ eligible: 3, present: 1 });
    // a second session starts again
    const two = (await f.h.call("POST", `/api/lists/${f.sid}/attendance/sessions`, { title: "Second", startsAt: "2026-12-05T18:00", place: "Hall", mode: "online" }, f.jar)).json.session.id as string;
    expect((await attendance.markSelf(f.h.env, SELF_MARK_TIME, f.society, "FAMILY+TAG@sample.example", two, f.d4)).unit).toBe("D-4");
  });

  test("a row saved with spaces and capitals (an older row) still belongs to the signed-in voter: both flats show, and the second flat is refused", async () => {
    const f = await family();
    f.h.raw.query("UPDATE voters SET email = ' FAMILY+Tag@Sample.Example ' WHERE unit = 'C-3'").run();
    f.h.clock.now = SELF_MARK_TIME;
    const jar = await f.h.member(f.slug, "family+tag@sample.example");
    const me = await f.h.call("GET", `/api/v/${f.slug}/attend/me`, undefined, jar);
    expect(me.json.rows.map((r: { unit: string }) => r.unit).sort()).toEqual(["C-3", "D-4"]);
    const here = (voterId: string) => f.h.call("POST", `/api/v/${f.slug}/attendance/${f.aid}/here`, { voterId }, jar);
    expect((await here(f.c3)).status).toBe(200);
    const second = await here(f.d4); expect(second.status).toBe(409); expect(second.json.code).toBe("one_per_email");
    expect(marked(f)).toHaveLength(1);
  });

  test("the team marks by flat: a team member's own e-mail ID is tidied for the private code too", async () => {
    const f = await family();
    expect((await f.h.call("POST", `/api/lists/${f.sid}/attendance/sessions/${f.aid}/mark`, { voterId: f.c3 }, f.jar)).status).toBe(200);
    expect(marked(f)).toEqual([{ voter_id: f.c3, marked_by: await pseudonym(f.h.env, "organizer@sample.example") }]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 3
describe("3. the public session list is cached only for a request with no cookie", () => {
  const cacheOf = (r: { headers: Headers }) => String(r.headers.get("cache-control"));
  const lists = async (h: Harness) => [{ kind: "Voter List", ...(await voterList(h)) }, { kind: "list made from a sheet", ...(await sheetList(h)) }];

  test("a request with no cookie at all may be cached for 30 seconds, and the answer varies by cookie", async () => {
    const h = await makeHarness();
    for (const l of await lists(h)) for (const url of publicUrls(l.slug, l.aid)) {
      const r = await h.call("GET", url); expect(r.status, l.kind + " " + url).toBe(200);
      expect(cacheOf(r), l.kind + " " + url).toBe("public, max-age=30"); expect(String(r.headers.get("vary")).toLowerCase()).toContain("cookie");
    }
  });

  test("a request that carries any cookie is answered private, no-store (an unrelated cookie, an old or wrong code cookie, a staff cookie, a voter who is not on the list)", async () => {
    const h = await makeHarness();
    for (const l of await lists(h)) {
      const stranger = await h.member(l.slug, "stranger@sample.example");
      const askers: [string, Jar, Record<string, string>][] = [["an unrelated cookie", {}, { cookie: "theme=dark" }], ["a wrong code cookie", { vlm: "00ff" }, {}], ["a staff cookie", l.jar, {}], ["a voter not on the list", stranger, {}]];
      for (const [who, jar, headers] of askers) for (const url of publicUrls(l.slug, l.aid)) {
        const r = await h.call("GET", url, undefined, jar, headers); expect(r.status, `${l.kind} ${who} ${url}`).toBe(200);
        expect(cacheOf(r), `${l.kind} ${who} ${url}`).toBe("private, no-store"); expect(String(r.headers.get("vary")).toLowerCase()).toContain("cookie");
      }
    }
  });

  test("a voter on the list, signed in, is answered private, no-store as before, and the cookie-less answer after it is still the public one", async () => {
    const h = await makeHarness(); const s = await voterList(h);
    const asha = await h.member(s.slug, "asha@sample.example");
    expect(cacheOf(await h.call("GET", `/api/v/${s.slug}/attendance`, undefined, asha))).toBe("private, no-store");
    expect(cacheOf(await h.call("GET", `/api/v/${s.slug}/attendance`))).toBe("public, max-age=30");
  });
});

// ------------------------------------------------------------------------------------------------------------------ 4
describe("4. the version, the commit fields and the notes agree", () => {
  const version = JSON.parse(read("public/version.json")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string; notes: string }> };
  const pkg = JSON.parse(read("package.json")) as { version: string };

  test("package.json, version.json (top and newest entry), CHANGELOG.md and KNOWLEDGE.md name the same version", () => {
    expect(version.version).toBe(pkg.version);
    expect(version.changes[0]!.version).toBe(pkg.version);
    expect(/^## (\d+\.\d+\.\d+) /m.exec(read("CHANGELOG.md"))![1]).toBe(pkg.version);
    expect(/Current version: \*\*(\d+\.\d+\.\d+)\*\*/.exec(read("KNOWLEDGE.md"))![1]).toBe(pkg.version);
  });

  test("the commit fields are commits, the top one is the newest entry's, and no two releases name the same commit (0.3.3 and 0.3.2 did)", () => {
    expect(version.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(version.commit).toBe(version.changes[0]!.commit!);
    const named = version.changes.filter((c) => c.commit);
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const c of named) expect(c.commit, c.version).toMatch(/^[0-9a-f]{7,40}$/);
    expect(new Set(named.map((c) => c.commit)).size).toBe(named.length);
    expect(version.changes.find((c) => c.version === "0.3.3")!.commit).toBe("2bd234f"); // the commit 0.3.3 was built on (the parent of the commit that bumped it)
    for (const sha of named.map((c) => c.commit!)) expect(read("KNOWLEDGE.md"), sha).toContain(sha);
  });

  test("each commit field is a commit of this branch's history (checked whenever the history is there)", () => {
    const git = (...args: string[]) => execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    expect(() => git("rev-parse", "--git-dir"), "git and the history must be there").not.toThrow(); // a missing history fails, it is never skipped
    for (const sha of version.changes.filter((c) => c.commit).map((c) => c.commit!)) {
      expect(() => git("cat-file", "-e", sha + "^{commit}"), "commit " + sha + " must be found").not.toThrow();
      expect(() => git("merge-base", "--is-ancestor", sha, "HEAD"), sha).not.toThrow();
    }
  });

  test("the newest entry names the parent of the commit that bumped the version (or the current HEAD while the bump is not committed yet)", () => {
    const git = (...args: string[]) => execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const want = version.changes[0]!.commit!;
    const bumps = git("log", "--format=%H", "-S" + `"version": "${pkg.version}"`, "--", "public/version.json").split("\n").filter(Boolean);
    const parent = bumps.length ? git("rev-parse", bumps[bumps.length - 1] + "^") : git("rev-parse", "HEAD");
    expect(parent.startsWith(want), `commit field ${want} against ${parent}`).toBe(true);
  });

  test("ASSUMPTIONS.md records the round 8 decision on the public list", () => {
    const text = read("ASSUMPTIONS.md");
    expect(text).toContain("round 8");
    expect(text).toContain("public attendance list shows no title or place for any list kind; the owner can change this");
  });
});
