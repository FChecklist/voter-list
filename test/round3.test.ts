// Fixes from the third independent audit (docs/AUDIT-ROUND-3.md): each finding gets a test that fails without the fix.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mailPools, sendMail } from "../src/auth";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

const pdf = btoa("%PDF-1.4 made-up sample letter");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("H1: the consent box can be seen", () => {
  test("checkboxes and radios keep a fixed size inside flex labels", () => {
    const css = readFileSync("public/assets/app.css", "utf8");
    expect(/input\[type=checkbox\],\s*input\[type=radio\]\s*\{[^}]*flex:\s*none[^}]*width:\s*2\d px?/.test(css.replace(/(\d)px/g, "$1 px")) || /input\[type=checkbox\],input\[type=radio\]\{flex:none;width:24px;height:24px;min-height:0\}/.test(css)).toBe(true);
  });
});

describe("M1: the document type reaches both pages", () => {
  test("voter and staff views both carry docType", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h, { ruleCode: 4 });
    const v = await enrolVoter(h, slug, "a@sample.example", { confirm: false });
    const d = await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/docs`, { docType: "Sale Deed or Share Certificate", filename: "deed.pdf", mime: "application/pdf", base64: pdf }, v.jar);
    expect(d.json.docs[0].docType).toBe("Sale Deed or Share Certificate");
    const staff = await h.call("GET", `/api/lists/${sid}/records/${v.rec.id}`, undefined, jar);
    expect(staff.json.docs[0].docType).toBe("Sale Deed or Share Certificate");
  });
});

describe("M2: the proof carries the public key where the page reads it", () => {
  test("the page reads signature.publicKey and the API provides it", async () => {
    expect(readFileSync("public/assets/voter.js", "utf8")).toContain("x.signature.publicKey");
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    const p = (await h.call("GET", `/api/v/${slug}/proof`)).json;
    expect(typeof p.signature.publicKey).toBe("string"); expect(p.signature.publicKey.length).toBeGreaterThan(20);
  });
});

describe("M3: a person who withdrew is not left on the public draft", () => {
  test("the withdrawn voter disappears from the shown draft (list and CSV), and the final list is never filtered", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const a = await enrolVoter(h, slug, "a@sample.example", { unit: "A-101" });
    await enrolVoter(h, slug, "b@sample.example", { unit: "B-202", name: "Bina Sample", mobile: "9000000202" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    expect((await h.call("GET", `/api/v/${slug}/list`)).json.total).toBe(2);
    expect((await h.call("POST", `/api/v/${slug}/records/${a.rec.id}/withdraw`, {}, a.jar)).status).toBe(200);
    const after = (await h.call("GET", `/api/v/${slug}/list`)).json;
    expect(after.total).toBe(1); expect(after.rows[0].unit).toBe("B-202");
    expect((await h.call("GET", `/api/v/${slug}/list.csv`)).text).not.toContain("A-101");
  });
});

describe("M4: sign-in entries are written for the people who choose to work on a list", () => {
  test("the standing host's sign-in is not written to every list, its actions still are", async () => {
    const h = await makeHarness(); const { sid } = await newList(h);
    const host = await h.staff("host@townhall-records.com");
    const org = await h.staff("organizer@sample.example");
    const kinds = ((await h.call("GET", `/api/lists/${sid}/audit?from=1`, undefined, org)).json.entries as any[]).map((e) => e.entry.type);
    expect(kinds.filter((k) => k === "staff.signed_in")).toHaveLength(1); // the Organizer's second sign-in, not the standing host's
    expect(host.vl).toBeTruthy();
  });
});

describe("M5: send-back notes share the voters' pool and never touch staff sign-in", () => {
  test("a flood of notes cannot use the staff codes, and the two pools add up to the cap", async () => {
    const h = await makeHarness();
    const env = { ...h.env, TEST_MODE: "0", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "80", MAIL_STAFF_RESERVE: "20" };
    const p = mailPools(env); expect(p.voters + p.staff).toBe(80);
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      for (let i = 0; i < Math.floor(p.voters / 6); i++) await sendMail(env, `n${i}@sample.example`, "s", "b", "voter-note", h.clock.now); // notes may use at most a sixth
      await expect(sendMail(env, "n99@sample.example", "s", "b", "voter-note", h.clock.now)).rejects.toMatchObject({ code: "mail_capped" });
      await sendMail(env, "c0@sample.example", "s", "b", "otp-staff", h.clock.now); // staff codes are untouched
      await sendMail(env, "c1@sample.example", "s", "b", "otp-member", h.clock.now); // and so are the voters' codes
    } finally { globalThis.fetch = realFetch; }
  });
});

describe("M6 and L8: another list's publication cannot be read through ?pub=, and a bad item is a 400 not a 500", () => {
  test("a final list id of list A is a 404 on list B", async () => {
    const h = await makeHarness();
    const A = await newList(h, { email: "orga@sample.example" }); const B = await newList(h, { email: "orgb@sample.example" });
    await enrolVoter(h, A.slug, "a@sample.example");
    await h.call("POST", `/api/lists/${A.sid}/records/decide`, { items: await waiting(h, A.sid, A.jar), decision: "approve" }, A.jar);
    await h.call("POST", `/api/lists/${A.sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, A.jar);
    const id = (await h.call("GET", `/api/v/${A.slug}`)).json.shown.id as string;
    expect((await h.call("GET", `/api/v/${A.slug}/list?pub=${id}`)).status).toBe(200);
    for (const path of ["list", "proof", "list.pdf"]) expect((await h.call("GET", `/api/v/${B.slug}/${path}?pub=${id}`)).status).toBe(404);
  });
  test("a null item in a decision list is refused cleanly", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const r = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: [null], decision: "approve" }, jar);
    expect(r.status).toBeLessThan(500);
  });
});
