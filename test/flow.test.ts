// The whole journey through the real handler: one common link, e-mail + code, enrol, confirm, check (approve / not approved / resubmit),
// draft publication, frozen publication at a cut-off, the public masked page and its proof.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, PERM, waiting } from "./harness";

describe("the list, the common link and the standing host", () => {
  test("a new list gets ONE common link at once, one Organizer and the standing Townhall Records host", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    expect(slug).toMatch(/^[0-9a-f]{16}$/);
    const t = await h.call("GET", `/api/lists/${sid}/team`, undefined, jar);
    expect(t.json.team.map((m: any) => [m.role, m.permanent])).toEqual([["organizer", false], ["host", true]]);
    expect(t.json.team[1].email).toBe(PERM);
    const o = await h.call("GET", `/api/lists/${sid}`, undefined, jar);
    expect(o.json.list.link).toBe(`/v/${slug}`);
    expect(o.json.steps.current).toBe("share");
  });

  test("the public page needs no sign-in and shows no personal data", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const r = await h.call("GET", `/api/v/${slug}`);
    expect(r.status).toBe(200);
    expect(r.json.name).toContain("Sample Heights");
    expect(r.json.enrolOpen).toBe(true);
    expect(r.json.rule.capacities).toContain("Proxy");
    expect(r.json.shown).toBeNull();
    expect((await h.call("GET", "/api/v/0000000000000000")).status).toBe(404);
  });
});

describe("the voter's journey", () => {
  test("sign in with e-mail + six-digit code, enrol, confirm, see status", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const { jar, rec } = await enrolVoter(h, slug, "asha@sample.example");
    expect(rec.status).toBe("submitted");
    const me = await h.call("GET", `/api/v/${slug}/me`, undefined, jar);
    expect(me.json.records).toHaveLength(1);
    expect(me.json.records[0].timeline.map((t: any) => t.what)).toEqual(["created", "confirmed"]);
    expect(me.json.records[0].next).toContain("list team");
  });

  test("no consent, no confirmation", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const { jar, rec } = await enrolVoter(h, slug, "asha@sample.example", { confirm: false });
    const c = await h.call("POST", `/api/v/${slug}/records/${rec.id}/confirm`, { consent: false }, jar);
    expect(c.status).toBe(400); expect(c.json.code).toBe("consent");
  });

  test("Proxy only where the list allows it, and a proxy needs the owner's name and the authority letter", async () => {
    const h = await makeHarness();
    const a = await newList(h, { ruleCode: 2, email: "o1@sample.example" }); // owner or tenant: no proxy
    const j1 = await h.member(a.slug, "p@sample.example");
    const no = await h.call("POST", `/api/v/${a.slug}/records`, { unit: "B-1", name: "Pia Proxy", capacity: "Proxy", mobile: "9000000111", proxyFor: "Owner Name" }, j1);
    expect(no.status).toBe(400); expect(no.json.code).toBe("capacity_not_allowed");
    const b = await newList(h, { ruleCode: 3, email: "o2@sample.example" }); // owner or proxy
    const j2 = await h.member(b.slug, "p@sample.example");
    const noOwner = await h.call("POST", `/api/v/${b.slug}/records`, { unit: "B-1", name: "Pia Proxy", capacity: "Proxy", mobile: "9000000111" }, j2);
    expect(noOwner.status).toBe(400);
    const ok = await h.call("POST", `/api/v/${b.slug}/records`, { unit: "B-1", name: "Pia Proxy", capacity: "Proxy", mobile: "9000000111", proxyFor: "Olga Owner" }, j2);
    expect(ok.status).toBe(201);
    const noLetter = await h.call("POST", `/api/v/${b.slug}/records/${ok.json.id}/confirm`, { consent: true }, j2);
    expect(noLetter.status).toBe(400); expect(noLetter.json.code).toBe("need_proxy_letter");
    const pdf = btoa("%PDF-1.4 sample authority letter, made up");
    const d = await h.call("POST", `/api/v/${b.slug}/records/${ok.json.id}/docs`, { docType: "Proxy Nomination Form", filename: "letter.pdf", mime: "application/pdf", base64: pdf }, j2);
    expect(d.status).toBe(201);
    expect((await h.call("POST", `/api/v/${b.slug}/records/${ok.json.id}/confirm`, { consent: true }, j2)).status).toBe(200);
  });

  test("a tenant cannot enrol on an owner-only list", async () => {
    const h = await makeHarness(); const { slug } = await newList(h, { ruleCode: 1 });
    const j = await h.member(slug, "t@sample.example");
    const r = await h.call("POST", `/api/v/${slug}/records`, { unit: "A-1", name: "Tia Tenant", capacity: "Tenant", mobile: "9000000112" }, j);
    expect(r.status).toBe(400);
  });

  test("a voter sees only their own records", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const a = await enrolVoter(h, slug, "a@sample.example", { unit: "A-1" });
    const b = await enrolVoter(h, slug, "b@sample.example", { unit: "A-2", mobile: "9000000102" });
    const me = await h.call("GET", `/api/v/${slug}/me`, undefined, b.jar);
    expect(me.json.records.map((x: any) => x.unit)).toEqual(["A-2"]);
    expect((await h.call("PATCH", `/api/v/${slug}/records/${a.rec.id}`, { name: "Hacked Name" }, b.jar)).status).toBe(404);
  });
});

describe("the check loop: approve, or not approved -> back with a reason -> resubmitted -> checked again", () => {
  test("send back, fix, resubmit, approve", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "asha@sample.example");
    let w = await waiting(h, sid, jar);
    const sb = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "send_back", reason: "Please give the full name as on the sale deed." }, jar);
    expect(sb.json.applied).toBe(1);
    let me = (await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).json.records[0];
    expect(me.status).toBe("sent_back"); expect(me.reason).toContain("sale deed");
    // the voter fixes it and sends it again
    const fix = await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { name: "Asha Kumari Sample" }, v.jar); expect(fix.status).toBe(200);
    expect(fix.json.status).toBe("sent_back");
    const again = await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/confirm`, { consent: true }, v.jar);
    expect(again.json.status).toBe("submitted");
    w = await waiting(h, sid, jar); expect(w).toHaveLength(1);
    const ok = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "approve" }, jar);
    expect(ok.json.applied).toBe(1);
    me = (await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).json.records[0];
    expect(me.status).toBe("approved"); expect(me.onTheList).toBe(true);
    expect(me.timeline.map((t: any) => t.what)).toEqual(["created", "confirmed", "sent_back", "edited", "resubmitted", "approved"]);
  });

  test("a send-back needs a reason, and no phone number or e-mail ID in it", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "asha@sample.example");
    const w = await waiting(h, sid, jar);
    expect((await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "send_back", reason: "" }, jar)).status).toBe(400);
    expect((await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "send_back", reason: "call me on 9876543210 please" }, jar)).status).toBe(400);
  });

  test("a record the voter changed while the checker was looking is never approved by mistake", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "asha@sample.example");
    const w = await waiting(h, sid, jar);
    await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { name: "Asha Changed Name" }, v.jar);
    const r = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "approve" }, jar);
    expect(r.status).toBe(409); expect(r.json.code).toBe("changed");
  });

  test("nobody approves their own record", async () => {
    const h = await makeHarness(); const { jar, sid, slug, email } = await newList(h);
    await enrolVoter(h, slug, email, { unit: "O-1" });
    const w = await waiting(h, sid, jar);
    const r = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "approve" }, jar);
    expect(r.status).toBe(403);
  });

  test("bulk approve, and an edit to an approved record keeps the earlier approval on the list until re-checked", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const vs = []; for (let i = 0; i < 5; i++) vs.push(await enrolVoter(h, slug, `v${i}@sample.example`, { unit: `A-${100 + i}`, name: `Voter Number${i}`, mobile: `90000001${10 + i}` }));
    const w = await waiting(h, sid, jar); expect(w).toHaveLength(5);
    const r = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "approve" }, jar);
    expect(r.json.applied).toBe(5);
    await h.call("PATCH", `/api/v/${slug}/records/${vs[0]!.rec.id}`, { name: "Voter Renamed" }, vs[0]!.jar);
    const c = await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar);
    expect(c.json.onList).toBe(5); // the earlier approval still counts
    const me = (await h.call("GET", `/api/v/${slug}/me`, undefined, vs[0]!.jar)).json.records[0];
    expect(me.status).toBe("submitted"); expect(me.whatIsOnTheList.name).toBe("Voter Number0");
  });
});

describe("publishing: draft first, then frozen at a date-and-time cut-off", () => {
  async function approvedList(n = 3) {
    const h = await makeHarness(); const l = await newList(h);
    for (let i = 0; i < n; i++) await enrolVoter(h, l.slug, `v${i}@sample.example`, { unit: `A-${101 + i}`, name: `Voter Number${i}`, mobile: `90000001${10 + i}` });
    await h.call("POST", `/api/lists/${l.sid}/records/decide`, { items: await waiting(h, l.sid, l.jar), decision: "approve" }, l.jar);
    return { h, ...l };
  }

  test("the draft is public, masked, and marked provisional; publishing again replaces it", async () => {
    const { h, jar, sid, slug } = await approvedList();
    const d = await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar); expect(d.status).toBe(201);
    const info = await h.call("GET", `/api/v/${slug}`); expect(info.json.shown.provisional).toBe(true);
    const list = await h.call("GET", `/api/v/${slug}/list`);
    expect(list.json.total).toBe(3);
    const row = list.json.rows[0];
    expect(row.name).toMatch(/^Vo\*{4} Nu\*{4}$/); expect(row.mobile).toMatch(/^\*{6}\d{4}$/); expect(row.email).toMatch(/^\*{8}.{4}$/);
    expect(JSON.stringify(list.json)).not.toContain("sample.example");
    expect(JSON.stringify(list.json)).not.toContain("Voter Number");
    expect(JSON.stringify(list.json)).not.toContain("9000000110");
    const d2 = await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar); expect(d2.status).toBe(201);
    expect((await h.call("GET", `/api/v/${slug}/list`)).json.publication.seq).toBe(2);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publication_rows").get()).toEqual({ n: 3 }); // the older draft's lines were swept away
  });

  test("a Host cannot publish; the Organizer can", async () => {
    const { h, sid } = await approvedList();
    const host = await h.staff(PERM);
    expect((await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, host)).status).toBe(403);
  });

  test("frozen needs the cut-off, FREEZE typed, an acknowledgement of anything pending, and then it is immutable and signed", async () => {
    const { h, jar, sid, slug } = await approvedList();
    const stuck = await enrolVoter(h, slug, "late@sample.example", { unit: "Z-9", name: "Late Voter", mobile: "9000000199" }); void stuck;
    const body = { eventName: "Annual General Meeting 2026", eventType: "meeting", confirm: "FREEZE" };
    const noCut = await h.call("POST", `/api/lists/${sid}/publish/frozen`, body, jar);
    expect(noCut.status).toBe(409); expect(noCut.json.code).toBe("before_cutoff");
    const set = await h.call("PATCH", `/api/lists/${sid}`, { cutoff: "2026-11-15T18:00" }, jar); expect(set.status).toBe(200);
    expect(set.json.list.cutoffLocal).toBe("2026-11-15T18:00");
    const early = await h.call("POST", `/api/lists/${sid}/publish/frozen`, body, jar); expect(early.json.code).toBe("before_cutoff");
    h.clock.now = Date.UTC(2026, 10, 15, 13, 0, 0); // 18:30 IST on the 15th: after the cut-off
    const noType = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { ...body, confirm: "" }, jar); expect(noType.json.code).toBe("confirm");
    const pend = await h.call("POST", `/api/lists/${sid}/publish/frozen`, body, jar); expect(pend.status).toBe(409); expect(pend.json.code).toBe("pending");
    const f = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { ...body, ackPending: true }, jar);
    expect(f.status).toBe(201); expect(f.json.people).toBe(3); expect(f.json.cutoffLocal).toBe("2026-11-15T18:00");
    // immutable: the database itself refuses
    expect(() => h.raw.query("UPDATE publication_rows SET name = 'x'").run()).toThrow(/immutable/);
    expect(() => h.raw.query("DELETE FROM publication_rows").run()).toThrow(/immutable/);
    expect(() => h.raw.query("UPDATE publications SET fingerprint = 'x'").run()).toThrow(/immutable/);
    // the list is closed: voters and the team can no longer change records
    const v = await h.call("GET", `/api/v/${slug}`); expect(v.json.shown.provisional).toBe(false); expect(v.json.enrolOpen).toBe(false);
    const late = await h.member(slug, "later@sample.example");
    expect((await h.call("POST", `/api/v/${slug}/records`, { unit: "Q-1", name: "Quite Late", capacity: "Owner", mobile: "9000000188" }, late)).status).toBe(409);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { name: "Renamed" }, jar)).status).toBe(409);
    // anyone can check the proof
    const p = await h.call("GET", `/api/v/${slug}/proof`);
    expect(p.json.ok).toBe(true); expect(p.json.signature.valid).toBe(true); expect(p.json.linesMatchFingerprint).toBe(true);
    expect(p.json.signature.entry.entry.payload.cutoffAt).toBe(Date.UTC(2026, 10, 15, 12, 30, 0));
  });

  test("close now: the cut-off becomes this moment", async () => {
    const { h, jar, sid } = await approvedList();
    const f = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "Committee election 2026", eventType: "election", confirm: "freeze", closeNow: true }, jar);
    expect(f.status).toBe(201);
    expect(f.json.cutoffAt).toBe(h.clock.now);
  });

  test("a flat may have several registered people; the Organizer authorizes any of them, and the system never forces one vote per flat", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "o@sample.example", { unit: "C-1", name: "Olga Owner", mobile: "9000000121" });
    await enrolVoter(h, slug, "co@sample.example", { unit: "C-1", name: "Ravi Coowner", capacity: "Co-owner", mobile: "9000000122" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const c = await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar);
    expect(c.json.flats).toHaveLength(1); expect(c.json.flats[0].people).toHaveLength(2);
    expect(c.json.flats[0].people.map((p: { authorized: boolean }) => p.authorized)).toEqual([false, false]); // nobody is authorized until the Organizer says so
    expect(c.json.flats[0].people.map((p: { capacity: string }) => p.capacity)).toContain("Owner / 1st Name in Registration");
    const ids = c.json.flats[0].people.map((p: { voterId: string }) => p.voterId);
    const pick = await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[0] }, jar); expect(pick.status).toBe(200);
    const pick2 = await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[1] }, jar); expect(pick2.status).toBe(200); // a second person in the same flat: allowed
    const c2 = await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar);
    expect(c2.json.flats[0].people.map((p: { authorized: boolean }) => p.authorized)).toEqual([true, true]);
    const off = await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[1], authorized: false, reason: "tenant" }, jar); expect(off.status).toBe(200);
    const c3 = await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar);
    expect(c3.json.flats[0].people.map((p: { authorized: boolean }) => p.authorized)).toEqual([true, false]);
    await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[1] }, jar);
    const body = { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true };
    expect((await h.call("POST", `/api/lists/${sid}/publish/frozen`, body, jar)).status).toBe(201);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publication_rows WHERE is_voter = 1 AND unit = 'C-1'").get()).toEqual({ n: 2 });
  });

  test("reopen for a new round keeps the earlier final list exactly as it was", async () => {
    const { h, jar, sid, slug } = await approvedList(2);
    await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM 2026", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/reopen`, { reason: "A new meeting", confirm: "no" }, jar)).status).toBe(400);
    expect((await h.call("POST", `/api/lists/${sid}/reopen`, { reason: "Special general meeting in January", confirm: "REOPEN" }, jar)).status).toBe(200);
    const info = await h.call("GET", `/api/v/${slug}`);
    expect(info.json.enrolOpen).toBe(true); expect(info.json.shown.kind).toBe("frozen"); // still the earlier final list until something newer is published
    expect((await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar)).status).toBe(201);
    expect((await h.call("GET", `/api/v/${slug}`)).json.shown.kind).toBe("draft");
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publications WHERE kind = 'frozen'").get()).toEqual({ n: 1 });
  });
});
