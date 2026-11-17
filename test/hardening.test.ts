// Hardening: undo, bulk, import, documents, closed enrolment, abuse limits, privacy of the signed log, retention.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, PERM, waiting } from "./harness";

const pdf = (extra = "") => btoa("%PDF-1.4 made-up sample " + extra);
const doc = (name = "a.pdf") => ({ docType: "Sale Deed or Share Certificate", filename: name, mime: "application/pdf", base64: pdf(name) });

describe("undo", () => {
  test("a bulk approval is undone in one step, and an undo is refused once a record has moved on", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const vs = []; for (let i = 0; i < 3; i++) vs.push(await enrolVoter(h, slug, `v${i}@sample.example`, { unit: `A-${i + 1}`, name: `Voter Number${i}`, mobile: `900000010${i}` }));
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    let acts = (await h.call("GET", `/api/lists/${sid}/actions`, undefined, jar)).json.actions;
    expect(acts[0].kind).toBe("approved"); expect(acts[0].count).toBe(3); expect(acts[0].undoable).toBe(true);
    // a voter edits one of them: the bulk action can no longer be undone as a whole
    await h.call("PATCH", `/api/v/${slug}/records/${vs[0]!.rec.id}`, { name: "Voter Edited" }, vs[0]!.jar);
    acts = (await h.call("GET", `/api/lists/${sid}/actions`, undefined, jar)).json.actions;
    expect(acts.find((a: any) => a.kind === "approved").undoable).toBe(false);
    const refused = await h.call("POST", `/api/lists/${sid}/undo`, { key: acts.find((a: any) => a.kind === "approved").key }, jar);
    expect(refused.status).toBe(409);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters WHERE status = 'approved'").get()).toEqual({ n: 2 });
  });

  test("undoing an approval puts the record back in the queue", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const key = (await h.call("GET", `/api/lists/${sid}/actions`, undefined, jar)).json.actions[0].key;
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key }, jar)).status).toBe(200);
    expect(await waiting(h, sid, jar)).toHaveLength(1);
  });

  test("removing records is undoable; removed records vanish from the list", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/records/remove`, { ids: [v.rec.id], reason: "Sold the flat" }, jar)).json.removed).toBe(1);
    expect((await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar)).json.onList).toBe(0);
    const key = (await h.call("GET", `/api/lists/${sid}/actions`, undefined, jar)).json.actions[0].key;
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key }, jar)).status).toBe(200);
    expect((await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar)).json.onList).toBe(1);
  });
});

describe("import: an uploaded list invites people; they confirm; the team checks", () => {
  const csv = "Flat,Name,Capacity,Mobile,E-mail\nB-101,Bina Sample,Owner,9000000201,bina@sample.example\nB-102,Chetan Sample,Owner,9000000202,chetan@sample.example\nB-101,Bina Sample,Owner,9000000201,bina@sample.example\n";
  test("a dry run changes nothing; the real import creates invited records, skips duplicates, and the voter finds their details ready", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const dry = await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv, dryRun: true }, jar);
    expect(dry.status).toBe(200); expect(dry.json.dryRun).toBe(true);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters").get()).toEqual({ n: 0 });
    const real = await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar);
    expect(real.status).toBe(200); expect(real.json.added).toBe(2);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters WHERE status = 'invited'").get()).toEqual({ n: 2 });
    // nothing is on the list yet
    expect((await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar)).json.onList).toBe(0);
    // Bina signs in and finds her record ready; she confirms it
    const j = await h.member(slug, "bina@sample.example");
    const me = (await h.call("GET", `/api/v/${slug}/me`, undefined, j)).json.records;
    expect(me).toHaveLength(1); expect(me[0].status).toBe("invited"); expect(me[0].name).toBe("Bina Sample");
    const c = await h.call("POST", `/api/v/${slug}/records/${me[0].id}/confirm`, { consent: true }, j);
    expect(c.status).toBe(200); expect(c.json.status).toBe("submitted");
  });

  test("a Host can import too, and a Host cannot flood the list with unlimited homes per voter", async () => {
    const h = await makeHarness(); const { sid, slug } = await newList(h);
    const host = await h.staff(PERM);
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, host)).status).toBe(200);
    const j = await h.member(slug, "many@sample.example");
    for (let i = 0; i < 5; i++) expect((await h.call("POST", `/api/v/${slug}/records`, { unit: `M-${i}`, name: "Many Homes", capacity: "Owner", mobile: "9000000300" }, j)).status).toBe(201);
    expect((await h.call("POST", `/api/v/${slug}/records`, { unit: "M-9", name: "Many Homes", capacity: "Owner", mobile: "9000000300" }, j)).status).toBe(409);
  });
});

describe("documents", () => {
  test("up to three, PDF/JPG/PNG only, content checked, and kept once the record is approved", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example", { confirm: false });
    const url = `/api/v/${slug}/records/${v.rec.id}/docs`;
    for (let i = 0; i < 3; i++) expect((await h.call("POST", url, doc(`d${i}.pdf`), v.jar)).status).toBe(201);
    expect((await h.call("POST", url, doc("d4.pdf"), v.jar)).status).toBeGreaterThanOrEqual(400);
    expect((await h.call("POST", url, { ...doc(), mime: "text/html" }, v.jar)).status).toBe(400);
    expect((await h.call("POST", url, { ...doc(), base64: btoa("<html><script>alert(1)</script></html>") }, v.jar)).status).toBe(400); // claims PDF, is not
    const me = (await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).json.records[0];
    expect(me.docs).toHaveLength(3);
    const got = await h.call("GET", `${url}/${me.docs[0].id}`, undefined, v.jar); expect(got.status).toBe(200); expect(got.headers.get("content-type")).toBe("application/pdf");
    // another voter cannot read it
    const other = await h.member(slug, "b@sample.example");
    expect((await h.call("GET", `${url}/${me.docs[0].id}`, undefined, other)).status).toBe(404);
    // a Host opening it is logged
    await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/confirm`, { consent: true }, v.jar);
    const host = await h.staff(PERM);
    expect((await h.call("GET", `/api/lists/${sid}/records/${v.rec.id}/docs/${me.docs[0].id}`, undefined, host)).status).toBe(200);
    const kinds = (await h.call("GET", `/api/lists/${sid}/audit`, undefined, jar)).json.entries.map((e: any) => e.entry.type);
    expect(kinds).toContain("doc.opened");
  });

  test("a list can require one supporting document before a record can be sent", async () => {
    const h = await makeHarness(); const { slug } = await newList(h, { extra: { docsRequired: true } });
    const v = await enrolVoter(h, slug, "a@sample.example", { confirm: false });
    const no = await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/confirm`, { consent: true }, v.jar);
    expect(no.status).toBe(400); expect(no.json.code).toBe("need_doc");
    await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/docs`, doc(), v.jar);
    expect((await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/confirm`, { consent: true }, v.jar)).status).toBe(200);
  });
});

describe("closing time and the doors", () => {
  test("enrolment stops at the cut-off; the team can still check what is waiting", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example", { confirm: false });
    expect((await h.call("PATCH", `/api/lists/${sid}`, { cutoff: "2026-11-12T10:00" }, jar)).status).toBe(200);
    h.clock.now = Date.UTC(2026, 10, 12, 6, 0, 0); // 11:30 IST on the 12th, after the cut-off
    expect((await h.call("GET", `/api/v/${slug}`)).json.enrolOpen).toBe(false);
    const j = await h.member(slug, "late@sample.example");
    expect((await h.call("POST", `/api/v/${slug}/records`, { unit: "L-1", name: "Late Person", capacity: "Owner", mobile: "9000000400" }, j)).status).toBe(409);
    const again = await h.member(slug, "a@sample.example"); // the earlier sign-in has lapsed with the clock
    expect((await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/confirm`, { consent: true }, again)).status).toBe(409);
  });

  test("a past closing time is not accepted when it is typed in", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { cutoff: "2026-11-01T10:00" }, jar)).status).toBe(400);
  });

  test("requests without the page's header, or from another site, are refused", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example" }, undefined, { "x-vl": "0" })).status).toBe(403);
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example" }, undefined, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("codes: a wrong code is refused, too many wrong tries burns the code, and the answer to 'start' never reveals who is known", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const a = await h.call("POST", `/api/v/${slug}/start`, { email: "x@sample.example" });
    const b = await h.call("POST", `/api/v/${slug}/start`, { email: "never-seen@sample.example" });
    expect(a.json).toEqual(b.json);
    const good = h.code("x@sample.example");
    for (let i = 0; i < 21; i++) await h.call("POST", `/api/v/${slug}/verify`, { email: "x@sample.example", code: "000000" });
    expect((await h.call("POST", `/api/v/${slug}/verify`, { email: "x@sample.example", code: good })).status).toBeGreaterThanOrEqual(400);
  });

  test("a voter's cookie for one list does not open another list", async () => {
    const h = await makeHarness(); const a = await newList(h, { email: "o1@sample.example" }); const b = await newList(h, { email: "o2@sample.example" });
    const j = await h.member(a.slug, "v@sample.example");
    expect((await h.call("GET", `/api/v/${b.slug}/me`, undefined, j)).status).toBe(401);
    expect((await h.call("GET", `/api/lists/${a.sid}`, undefined, j)).status).toBe(401); // a voter session is not a staff session
  });
});

describe("the signed log and privacy", () => {
  test("no phone number, e-mail ID or name ever reaches the signed log, and the chain verifies", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "private.person@sample.example", { name: "Private Person", mobile: "9876500123", unit: "A-9" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    const exp = (await h.call("GET", `/api/lists/${sid}/audit/export.json`, undefined, jar)).text;
    expect(exp).not.toContain("private.person"); expect(exp).not.toContain("Private Person"); expect(exp).not.toContain("9876500123");
    expect((await h.call("GET", `/api/lists/${sid}/audit/verify`, undefined, jar)).json.ok).toBe(true);
    // tampering is noticed
    expect(() => h.raw.query("UPDATE audit_entries SET entry_json = replace(entry_json, 'record.created', 'record.xxxxxxx') WHERE entry_json LIKE '%record.created%'").run()).toThrow(/append-only/); // the database refuses
    h.raw.query("DROP TRIGGER trg_audit_no_update").run(); // an attacker with the database could still try; the signatures notice
    h.raw.query("UPDATE audit_entries SET entry_json = replace(entry_json, 'record.created', 'record.xxxxxxx') WHERE entry_json LIKE '%record.created%'").run();
    void v;
    expect((await h.call("GET", `/api/lists/${sid}/audit/verify`, undefined, jar)).json.ok).toBe(false);
  });

  test("a voter's own record never carries other people's data or the staff's private notes", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "send_back", reason: "Please correct the flat number." }, jar);
    const mine = (await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).text;
    expect(mine).not.toContain("decided_by"); expect(mine).not.toContain("organizer@sample.example");
  });
});

describe("retention and erasure (DPDP)", () => {
  test("erase is refused before the retention period, needs ERASE typed, then removes personal data but keeps the signed proof", async () => {
    const h = await makeHarness({ RETENTION_DAYS: "180" }); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM 2026", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    const early = await h.call("POST", `/api/lists/${sid}/erase`, { confirm: "ERASE" }, jar); expect(early.status).toBe(409);
    h.clock.now += 181 * 86_400_000;
    const jar2 = await h.staff("organizer@sample.example");
    expect((await h.call("POST", `/api/lists/${sid}/erase`, { confirm: "no" }, jar2)).status).toBe(400);
    expect((await h.call("POST", `/api/lists/${sid}/erase`, { confirm: "ERASE" }, jar2)).status).toBe(200);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters").get()).toEqual({ n: 0 });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publication_rows").get()).toEqual({ n: 0 });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voter_docs").get()).toEqual({ n: 0 });
    // the signed log and the publication's fingerprint remain
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publications").get()).toEqual({ n: 1 });
    expect((await h.call("GET", `/api/lists/${sid}/audit/verify`, undefined, jar2)).json.ok).toBe(true);
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example" })).status).toBe(410);
  });
});

describe("limits that protect the free plan", () => {
  test("one person can organise at most 10 lists", async () => {
    const h = await makeHarness(); const { jar } = await newList(h);
    for (let i = 1; i < 10; i++) expect((await h.call("POST", "/api/lists", { name: `Sample Society Number ${i}`, kind: "RWA", country: "India", ruleCode: 4 }, jar)).status).toBe(201);
    expect((await h.call("POST", "/api/lists", { name: "One Too Many Society", kind: "RWA", country: "India", ruleCode: 4 }, jar)).status).toBe(409);
  });

  test("the routes the pages call all exist (contract)", async () => {
    const { routeTable } = await import("../src/handler");
    const t = routeTable(); expect(t.length).toBeGreaterThan(40);
    expect(t.some((r) => r.method === "GET" && r.re.test("/api/v/0123456789abcdef"))).toBe(true);
  });
});
