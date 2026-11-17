// Fixes from the second independent audit (docs/AUDIT-ROUND-2.md): each finding gets a test that fails without the fix.
import { afterEach, describe, expect, test } from "bun:test";
import { sendMail } from "../src/auth";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

const pdf = btoa("%PDF-1.4 made-up sample letter");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("H1: an approved voter can see and use Withdraw", () => {
  test("canWithdraw is true for approved, and for an approved record sent again after a change", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).json.records[0].canWithdraw).toBe(true);
    await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { name: "Asha Changed" }, v.jar);
    const me = (await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).json.records[0];
    expect(me.status).toBe("submitted"); expect(me.canWithdraw).toBe(true);
  });
});

describe("H2: the mail allowance has two pools, so voters and staff never lock each other out", () => {
  test("each pool fills on its own and the other keeps working", async () => {
    const h = await makeHarness();
    const env = { ...h.env, TEST_MODE: "0", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "8" }; // voters 12, staff 8
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const now = h.clock.now; let n = 0;
      const fill = async (kinds: string[], count: number) => { for (let i = 0; i < count; i++) await sendMail(env, `x${n++}@sample.example`, "s", "b", kinds[i % kinds.length]!, now); await expect(sendMail(env, `x${n++}@sample.example`, "s", "b", kinds[0]!, now)).rejects.toMatchObject({ code: "mail_capped" }); };
      await fill(["otp-member-new"], 8); // newcomers may use two thirds of the voters' pool
      await fill(["otp-member"], 4); // people already on a list can still use the rest
      await expect(sendMail(env, "nn@sample.example", "s", "b", "voter-note", h.clock.now)).rejects.toMatchObject({ code: "mail_capped" }); // and the pool is now spent for notes too
      await fill(["otp-staff", "team-invite"], 8); // staff codes and invitations share the other
    } finally { globalThis.fetch = realFetch; }
  });
  test("one list's newcomers get a limited number of codes a day, and every answer is the same", async () => {
    const h = await makeHarness({ MAIL_LIST_CAP: "8" });
    const { slug } = await newList(h);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await h.call("POST", `/api/v/${slug}/start`, { email: `v${i}@sample.example` })).status);
    expect(codes.every((s) => s === 200)).toBe(true); // so nobody can tell who is on the list
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE kind LIKE 'otp-member%'").get()).toEqual({ n: 8 }); // but only 8 codes were mailed
  });
});

describe("M1: a passed closing time does not block other edits, and enrolment can be closed from Step 1", () => {
  test("saving the same closing time again after it passed is fine; closeNow closes", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    await h.call("PATCH", `/api/lists/${sid}`, { cutoff: "2026-11-12T10:00" }, jar);
    h.clock.now = Date.UTC(2026, 10, 12, 6, 0, 0);
    const j = await h.staff("organizer@sample.example");
    const r = await h.call("PATCH", `/api/lists/${sid}`, { name: "Sample Heights Renamed", cutoff: "2026-11-12T10:00" }, j);
    expect(r.status).toBe(200); expect(r.json.list.name).toBe("Sample Heights Renamed");
    expect((await h.call("PATCH", `/api/lists/${sid}`, { cutoff: "2026-11-12T10:30" }, j)).status).toBe(400); // a new time in the past is still refused
  });
  test("closeNow works on an open list", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { closeNow: true }, jar)).status).toBe(200);
    expect((await h.call("GET", `/api/v/${slug}`)).json.enrolOpen).toBe(false);
  });
});

describe("M2: reopening never hides an earlier final list", () => {
  test("the earlier final list, its rows and its proof stay reachable by id", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar)).status).toBe(201);
    await h.call("POST", `/api/lists/${sid}/reopen`, { reason: "A new round", confirm: "REOPEN" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    const info = (await h.call("GET", `/api/v/${slug}`)).json;
    expect(info.shown.kind).toBe("draft"); expect(info.earlierFinal).toHaveLength(1);
    const id = info.earlierFinal[0].id as string;
    expect((await h.call("GET", `/api/v/${slug}/list?pub=${id}`)).json.rows).toHaveLength(1);
    const proof = (await h.call("GET", `/api/v/${slug}/proof?pub=${id}`)).json; expect(proof.kind).toBe("frozen"); expect(proof.ok).toBe(true);
    expect((await h.call("GET", `/api/v/${slug}/list.pdf?pub=${id}`)).status).toBe(200);
    expect((await h.call("GET", `/api/v/${slug}/proof?pub=not-a-list`)).status).toBe(404);
  });
});

describe("M3: rules are kept after a record was sent", () => {
  test("a sent owner record cannot turn into a proxy without the letter, and a needed document cannot be removed", async () => {
    const h = await makeHarness(); const { slug } = await newList(h, { ruleCode: 4, extra: { docsRequired: true } });
    const j = await h.member(slug, "a@sample.example");
    const rec = (await h.call("POST", `/api/v/${slug}/records`, { unit: "A-1", name: "Asha Sample", capacity: "Owner", mobile: "9000000101" }, j)).json;
    const doc = await h.call("POST", `/api/v/${slug}/records/${rec.id}/docs`, { docType: "Society ID", filename: "a.pdf", mime: "application/pdf", base64: pdf }, j);
    expect(doc.status).toBe(201); const did = doc.json.docs[0].id as string;
    expect((await h.call("POST", `/api/v/${slug}/records/${rec.id}/confirm`, { consent: true }, j)).status).toBe(200);
    const p = await h.call("PATCH", `/api/v/${slug}/records/${rec.id}`, { capacity: "Proxy", proxyFor: "Olga Owner" }, j);
    expect(p.status).toBe(400); expect(p.json.code).toBe("need_proxy_letter");
    const rm = await h.call("DELETE", `/api/v/${slug}/records/${rec.id}/docs/${did}`, undefined, j);
    expect(rm.status).toBe(409); expect(rm.json.code).toBe("doc_needed");
  });
});

describe("M5 and L1", () => {
  test("Government ID is not an accepted document type", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const e = await enrolVoter(h, slug, "a@sample.example", { confirm: false });
    expect((await h.call("POST", `/api/v/${slug}/records/${e.rec.id}/docs`, { docType: "Government ID", filename: "a.pdf", mime: "application/pdf", base64: pdf }, e.jar)).status).toBe(400);
  });
  test("an Origin of null is refused cleanly, not with a server error", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const r = await h.call("PATCH", `/api/lists/${sid}`, { name: "Sample Heights Again" }, jar, { origin: "null" });
    expect(r.status).toBe(403);
  });
});
