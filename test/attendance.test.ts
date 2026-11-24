// Attendance Management, first chunk: sessions, one mark per voter per session, modes, audit, public count without personal data,
// and the Excel template + upload path for an organizer with no Voter List.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

async function society() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "asha@sample.example", { unit: "A-1", name: "Asha Sample", mobile: "9000000201" });
  await enrolVoter(h, slug, "bharat@sample.example", { unit: "B-2", name: "Bharat Sample", mobile: "9000000202" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const coJar = await h.staff("co@sample.example");
  const idOf = (e: string) => (h.raw.query("SELECT id FROM voters WHERE email = ?").get(e) as { id: string }).id;
  return { h, jar, coJar, sid, slug, asha: idOf("asha@sample.example"), bharat: idOf("bharat@sample.example") };
}
const START = Date.UTC(2026, 11, 5, 12, 30); // 2026-12-05T18:00 in India
const mk = (s: Awaited<ReturnType<typeof society>>, mode: string) => s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", place: "Club house", mode }, s.jar);

describe("attendance sessions", () => {
  test("only the Organizer creates a session; bad input is refused", async () => {
    const s = await society();
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "x", startsAt: "2026-12-05T18:00", mode: "online" }, s.jar)).status).toBe(400);
    expect((await mk(s, "mixed")).status).toBe(400);
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "Call 9876543210", startsAt: "2026-12-05T18:00", mode: "online" }, s.jar)).status).toBe(400);
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "nope", mode: "online" }, s.jar)).status).toBe(400);
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", mode: "online" }, s.coJar)).status).toBe(403);
    const r = await mk(s, "in_person"); expect(r.status).toBe(201);
    expect(r.json.session).toMatchObject({ mode: "in_person", status: "open", startsAt: "2026-12-05T18:00", counts: { eligible: 2, present: 0 } });
  });

  test("a co-organizer marks present; a second mark for the same voter is refused, in the API and in the database", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    const url = `/api/lists/${s.sid}/attendance/sessions/${id}/mark`;
    const a = await s.h.call("POST", url, { voterId: s.asha }, s.coJar); expect(a.status).toBe(200); expect(a.json.counts).toEqual({ eligible: 2, present: 1 });
    const b = await s.h.call("POST", url, { voterId: s.asha }, s.jar); expect(b.status).toBe(409); expect(b.json.code).toBe("already_present");
    expect((await s.h.call("POST", url, { voterId: "nobody" }, s.jar)).status).toBe(404);
    expect(() => s.h.raw.query("INSERT INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, 'organizer', 'p', 1)").run(id, s.sid, s.asha)).toThrow();
    expect(() => s.h.raw.query("DELETE FROM att_marks").run()).toThrow();
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM att_marks").get()).toEqual({ n: 1 });
  });

  test("a voter marks themselves only in an online session, with a verified e-mail ID", async () => {
    const s = await society();
    const online = (await mk(s, "online")).json.session.id, person = (await mk(s, "in_person")).json.session.id;
    s.h.clock.now = START - 2 * 3_600_000;
    const v = await s.h.member(s.slug, "asha@sample.example");
    expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${online}/here`, {}, v)).json.code).toBe("too_early"); // two hours before the start
    s.h.clock.now = START - 16 * 60_000; expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${online}/here`, {}, v)).json.code).toBe("too_early");
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM att_marks").get()).toEqual({ n: 0 });
    s.h.clock.now = START - 14 * 60_000; // inside the 15 minutes before the start
    expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${person}/here`, {}, v)).json.code).toBe("not_online");
    expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${online}/here`, {})).status).toBe(401); // not signed in
    const ok = await s.h.call("POST", `/api/v/${s.slug}/attendance/${online}/here`, {}, v); expect(ok.status).toBe(200);
    expect(s.h.raw.query("SELECT method FROM att_marks WHERE session_id = ? AND voter_id = ?").get(online, s.asha)).toEqual({ method: "email" });
    expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${online}/here`, {}, v)).status).toBe(409);
    const stranger = await s.h.member(s.slug, "stranger@sample.example"); // signed in, but not on the list
    expect((await s.h.call("POST", `/api/v/${s.slug}/attendance/${online}/here`, {}, stranger)).json.code).toBe("not_on_list");
  });

  test("a closed session takes no more marks; closing is written to the trail", async () => {
    const s = await society(); const id = (await mk(s, "offline")).json.session.id;
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/close`, {}, s.coJar)).status).toBe(403);
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/close`, {}, s.jar)).json.session.status).toBe("closed");
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/mark`, { voterId: s.asha }, s.jar)).json.code).toBe("closed");
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/close`, {}, s.jar)).status).toBe(409);
  });

  test("masking for a co-organizer; the public count carries no personal data; the audit trail has codes only and still verifies", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/mark`, { voterId: s.asha }, s.coJar);
    const open = `/api/lists/${s.sid}/attendance/sessions/${id}`;
    const host = (await s.h.call("GET", open, undefined, s.coJar)).json, org = (await s.h.call("GET", open, undefined, s.jar)).json;
    expect(org.people.find((p: any) => p.unit === "A-1")).toMatchObject({ name: "Asha Sample", email: "asha@sample.example", present: true });
    const hp = host.people.find((p: any) => p.unit === "A-1"); expect(hp.name).not.toBe("Asha Sample"); expect(hp.email).not.toBe("asha@sample.example"); expect(hp.present).toBe(true);
    const pub = await s.h.call("GET", `/api/v/${s.slug}/attendance`);
    expect(pub.status).toBe(200); expect(pub.json.sessions[0].counts).toEqual({ eligible: 2, present: 1 });
    for (const t of [pub.text, (await s.h.call("GET", `/api/v/${s.slug}/attendance/${id}`)).text]) for (const bad of ["Asha", "Bharat", "sample.example", "A-1", "9000000201", "voterId"]) expect(t).not.toContain(bad);
    const trail = (await s.h.call("GET", `/api/lists/${s.sid}/audit/export.json`, undefined, s.jar)); expect(trail.json.verified).toBe(true);
    for (const bad of ["asha@", "Asha", "9000000201"]) expect(trail.text).not.toContain(bad);
    const types = trail.json.entries.map((e: any) => e.entry.type); expect(types).toContain("attendance.session_created"); expect(types).toContain("attendance.marked");
  });

  test("only people on the list who may attend can be marked", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    s.h.raw.query("UPDATE voters SET can_attend = 0 WHERE id = ?").run(s.bharat);
    expect((await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/mark`, { voterId: s.bharat }, s.jar)).json.code).toBe("not_on_list");
    expect((await s.h.call("GET", `/api/lists/${s.sid}/attendance/sessions`, undefined, s.jar)).json.sessions[0].counts.eligible).toBe(1);
  });
});

describe("Excel path for an organizer with no Voter List", () => {
  const SHEET = "Flat / House / Member ID,Name,Mobile,E-mail\nA-1,Asha Sample,9000000201,asha@sample.example\nA-2,No Mail,9000000203,\nB-2,Bharat Sample,9000000202,bharat@sample.example\nB-2,Bharat Again,9000000202,bharat@sample.example\n";
  test("the template downloads as .xlsx and .csv with the voter list columns including the e-mail ID", async () => {
    const h = await makeHarness();
    const x = await h.call("GET", "/api/attendance/template.xlsx"); expect(x.status).toBe(200); expect(x.headers.get("content-disposition")).toContain("attendance-list-template.xlsx"); expect([...x.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    expect((await h.call("GET", "/api/attendance/template.csv")).text).toContain("E-mail");
  });

  test("preview refuses rows with no e-mail ID and says why; upload makes a list that works for sessions and marks", async () => {
    const h = await makeHarness(); const jar = await h.staff("solo@sample.example");
    const pre = await h.call("POST", "/api/attendance/rosters", { title: "Spring meeting list", format: "paste", text: SHEET, dryRun: true }, jar);
    expect(pre.status).toBe(200); expect(pre.json).toMatchObject({ read: 4, willAdd: 2, skipped: { noEmail: 1, duplicate: 1 } }); expect(pre.json.why.noEmail).toContain("e-mail ID");
    expect(h.raw.query("SELECT COUNT(*) AS n FROM societies").get()).toEqual({ n: 0 }); // a preview writes nothing
    const up = await h.call("POST", "/api/attendance/rosters", { title: "Spring meeting list", format: "paste", text: SHEET }, jar); expect(up.status).toBe(201);
    const sid = up.json.list.id as string, slug = (up.json.list.link as string).split("/").pop()!;
    expect((await h.call("GET", "/api/attendance/rosters", undefined, jar)).json.lists).toHaveLength(1);
    expect((await h.call("GET", "/api/me", undefined, jar)).json.lists).toHaveLength(0); // it is not a Voter List
    const ses = await h.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Spring meeting", startsAt: "2026-12-05T18:00", mode: "online" }, jar); expect(ses.status).toBe(201);
    h.clock.now = START;
    const v = await h.member(slug, "asha@sample.example");
    expect((await h.call("POST", `/api/v/${slug}/attendance/${ses.json.session.id}/here`, {}, v)).status).toBe(200);
    expect((await h.call("GET", `/api/v/${slug}/attendance`)).json.sessions[0].counts).toEqual({ eligible: 2, present: 1 });
    // none of the Voter List pages open on this link, and a voter cannot enrol themselves into it
    expect((await h.call("GET", `/api/v/${slug}`)).status).toBe(404);
    expect((await h.call("POST", `/api/v/${slug}/records`, { unit: "Z-9", name: "Zed", capacity: "Owner", mobile: "9000000299" }, v)).status).toBe(404);
    expect((await h.call("GET", `/api/lists/${sid}/audit/export.json`, undefined, await h.staff("solo@sample.example"))).json.verified).toBe(true); // a new sign-in: the clock moved on
  });

  test("a sheet where no row has an e-mail ID is refused; a stranger cannot upload; a bad file is a clear error", async () => {
    const h = await makeHarness(); const jar = await h.staff("solo@sample.example");
    const bad = await h.call("POST", "/api/attendance/rosters", { title: "List", format: "paste", text: "Flat / House / Member ID,Name,E-mail\nA-1,Asha,\n" }, jar); expect(bad.status).toBe(409);
    expect((await h.call("POST", "/api/attendance/rosters", { title: "List", format: "paste", text: SHEET })).status).toBe(401);
    expect((await h.call("POST", "/api/attendance/rosters", { title: "List", format: "xlsx", base64: "AAAA" }, jar)).status).toBe(400);
  });
});

describe("attendance audit fixes (0.2.1)", () => {
  test("erasing a list with sessions and marks works; a plain delete or update of a mark is still refused", async () => {
    const s = await society(); const id = (await mk(s, "in_person")).json.session.id;
    await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions/${id}/mark`, { voterId: s.asha }, s.jar);
    expect(() => s.h.raw.query("DELETE FROM att_marks").run()).toThrow();
    expect(() => s.h.raw.query("UPDATE att_marks SET marked_by = 'x'").run()).toThrow();
    expect(s.h.raw.query("SELECT COUNT(*) AS n FROM att_marks").get()).toEqual({ n: 1 });
    const e = await makeHarness({ RETENTION_DAYS: "30" }); const { jar, sid, slug } = await newList(e);
    await enrolVoter(e, slug, "a@sample.example");
    await e.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(e, sid, jar), decision: "approve" }, jar);
    const sess = (await e.call("POST", `/api/lists/${sid}/attendance/sessions`, { title: "Meeting", startsAt: "2026-12-05T18:00", mode: "in_person" }, jar)).json.session.id;
    const vid = (e.raw.query("SELECT id FROM voters").get() as { id: string }).id;
    await e.call("POST", `/api/lists/${sid}/attendance/sessions/${sess}/mark`, { voterId: vid }, jar);
    e.clock.now += 400 * 86_400_000;
    const j2 = await e.staff("organizer@sample.example");
    expect((await e.call("POST", `/api/lists/${sid}/erase`, { confirm: "ERASE" }, j2)).status).toBe(200);
    expect(e.raw.query("SELECT COUNT(*) AS n FROM att_marks").get()).toEqual({ n: 0 });
    expect(e.raw.query("SELECT COUNT(*) AS n FROM att_sessions").get()).toEqual({ n: 0 });
  });

  test("public attendance routes answer 410 for an erased list", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    expect((await s.h.call("GET", `/api/v/${s.slug}/attendance`)).status).toBe(200);
    s.h.raw.query("UPDATE societies SET erased_at = 1").run();
    for (const u of [`/api/v/${s.slug}/attendance`, `/api/v/${s.slug}/attendance/${id}`]) { const r = await s.h.call("GET", u); expect(r.status).toBe(410); expect(r.json.code).toBe("erased"); }
  });

  test("title and place are capped and lose control characters", async () => {
    const s = await society(); const post = (b: object) => s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { startsAt: "2026-12-05T18:00", mode: "online", ...b }, s.jar);
    expect((await post({ title: "T".repeat(81) })).status).toBe(400);
    const r = await post({ title: "Annual\u0007 meet\u0000ing", place: "Hall\u001b" + "p".repeat(300) }); expect(r.status).toBe(201);
    expect(r.json.session.title).toBe("Annual meeting"); expect(r.json.session.place.length).toBe(120); expect(r.json.session.place).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("attendance audit fixes (0.2.2)", () => {
  test("sign-in and self-mark answer 410 for an erased list", async () => {
    const s = await society(); const id = (await mk(s, "online")).json.session.id;
    const v = await s.h.member(s.slug, "asha@sample.example");
    s.h.raw.query("UPDATE societies SET erased_at = 1").run();
    const code = s.h.code("asha@sample.example");
    const a = await s.h.call("POST", `/api/v/${s.slug}/verify`, { email: "asha@sample.example", code }); expect(a.status).toBe(410); expect(a.json.code).toBe("erased");
    const b = await s.h.call("POST", `/api/v/${s.slug}/attendance/${id}/here`, {}, v); expect(b.status).toBe(410); expect(b.json.code).toBe("erased");
  });

  test("a title of 81 letters is refused by the code, and by the database", async () => {
    const s = await society();
    const r = await s.h.call("POST", `/api/lists/${s.sid}/attendance/sessions`, { title: "T".repeat(81), startsAt: "2026-12-05T18:00", mode: "online" }, s.jar); expect(r.status).toBe(400); expect(r.json.code).toBe("bad_title");
    const ins = (title: string) => s.h.raw.query("INSERT INTO att_sessions (id, society_id, title, starts_at, mode, created_by, created_at) VALUES (?, ?, ?, 1, 'online', 'p', 1)").run("x" + title.length, s.sid, title);
    expect(() => ins("T".repeat(81))).toThrow(); expect(() => ins("T".repeat(80))).not.toThrow();
  });

  test("the roster preview needs a listed Organizer, like the upload", async () => {
    const h = await makeHarness(); const jar = await h.staff("solo@sample.example");
    h.env.TEST_MODE = "0"; h.env.ORGANIZERS = "someone.else@sample.example"; // sign-up is closed and this e-mail ID is not listed
    for (const dryRun of [true, false]) {
      const r = await h.call("POST", "/api/attendance/rosters", { title: "List", format: "paste", text: "Flat / House / Member ID,Name,E-mail\nA-1,Asha,asha@sample.example\n", dryRun }, jar);
      expect(r.status).toBe(403); expect(r.json.code).toBe("not_organizer"); expect(r.text).not.toContain("willAdd");
    }
    h.env.ORGANIZERS = "solo@sample.example";
    expect((await h.call("POST", "/api/attendance/rosters", { title: "List", format: "paste", text: "Flat / House / Member ID,Name,E-mail\nA-1,Asha,asha@sample.example\n", dryRun: true }, jar)).status).toBe(200);
  });
});
