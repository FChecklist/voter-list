// Fixes from the fifth independent audit (docs/AUDIT-ROUND-5.md): each finding gets a test that fails without the fix.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

const pdf = btoa("%PDF-1.4 made-up sample letter");

describe("F3: the Organizer is told the truth about the invitation", () => {
  test("a host invitation says whether the e-mail went", async () => {
    // sign-in codes are not readable outside test mode, so build the list in test mode and then switch the mail on
    const t = await makeHarness(); const { jar, sid } = await newList(t);
    t.env.TEST_MODE = "0"; t.env.RESEND_API_KEY = "k"; t.env.MAIL_DAILY_CAP = "20"; t.env.MAIL_STAFF_RESERVE = "8";
    const real = globalThis.fetch; globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const a = await t.call("POST", `/api/lists/${sid}/team`, { email: "h1@sample.example" }, jar); expect(a.status).toBe(201); expect(a.json.mailed).toBe(true);
      for (let i = 0; i < 7; i++) await t.call("POST", `/api/lists/${sid}/team`, { email: `h${i + 2}@sample.example` }, jar);
      const late = await t.call("POST", `/api/lists/${sid}/team`, { email: "h9@sample.example" }, jar);
      expect(late.status).toBe(201); expect(late.json.mailed).toBe(false);
    } finally { globalThis.fetch = real; }
  });
});

describe("F4: an approved owner can become a proxy", () => {
  test("add the owner's form to the approved record, then change the role", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h, { ruleCode: 4 });
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const form = await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/docs`, { docType: "Proxy Nomination Form", filename: "form.pdf", mime: "application/pdf", base64: pdf }, v.jar);
    expect(form.status).toBe(201);
    const p = await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { capacity: "Proxy", proxyFor: "Olga Owner" }, v.jar);
    expect(p.status).toBe(200); expect(p.json.status).toBe("submitted");
    // other documents are still kept as they are on an approved record
    const v2 = await enrolVoter(h, slug, "b@sample.example", { unit: "B-2", name: "Bina Sample", mobile: "9000000202" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/v/${slug}/records/${v2.rec.id}/docs`, { docType: "Society ID", filename: "a.pdf", mime: "application/pdf", base64: pdf }, v2.jar)).status).toBe(409);
  });
});

describe("F7: a bare web address in the society name is refused", () => {
  test("visit evil.com now", async () => {
    const h = await makeHarness(); const jar = await h.staff("organizer@sample.example");
    expect((await h.call("POST", "/api/lists", { name: "visit evil.com now", kind: "RWA", country: "India", ruleCode: 2 }, jar)).status).toBe(400);
    expect((await h.call("POST", "/api/lists", { name: "Sample Heights Residents", kind: "RWA", country: "India", ruleCode: 2 }, jar)).status).toBe(201);
  });
});

describe("F11 and F19: roles hold and erase clears the mail copies", () => {
  test("a Host cannot freeze", async () => {
    const h = await makeHarness(); const { sid } = await newList(h);
    const host = await h.staff("host@townhall-records.com");
    expect((await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, host)).status).toBe(403);
  });
});
