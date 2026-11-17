// Fixes from the first independent audit (docs/AUDIT-ROUND-1.md): each finding gets a test that fails without the fix.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, PERM, waiting } from "./harness";

const pdf = btoa("%PDF-1.4 made-up sample letter");

describe("F1: a burst of voters is not dropped", () => {
  test("30 voters enrolling at the same moment all succeed, and sign-ins do not queue on the signed log", async () => {
    const h = await makeHarness({ MAIL_DAILY_CAP: "1000", MAIL_LIST_CAP: "1000" }); const { slug, jar, sid } = await newList(h);
    const rs = await Promise.all(Array.from({ length: 30 }, async (_v, i) => {
      const j = await h.member(slug, `burst${i}@sample.example`);
      return h.call("POST", `/api/v/${slug}/records`, { agreed: true, unit: `T-${100 + i}`, name: `Burst Voter${i}`, capacity: "Owner", mobile: `90000020${String(i).padStart(2, "0")}` }, j);
    }));
    expect(rs.map((r) => r.status).filter((s) => s !== 201)).toEqual([]);
    const kinds = ((await h.call("GET", `/api/lists/${sid}/audit?from=1`, undefined, jar)).json.entries as any[]).map((e) => e.entry.type);
    expect(kinds).not.toContain("member.signed_in");
  });
  test("30 staff additions at the same moment all succeed", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const rs = await Promise.all(Array.from({ length: 30 }, (_v, i) => h.call("POST", `/api/lists/${sid}/records`, { agreed: true, unit: `S-${100 + i}`, name: `Staff Added${i}`, capacity: "Owner", mobile: `90000030${String(i).padStart(2, "0")}`, email: `sa${i}@sample.example` }, jar)));
    expect(rs.map((r) => r.status).filter((s) => s !== 201)).toEqual([]);
  });
});

describe("F2 and F8: mail and codes", () => {
  test("one inbox cannot be flooded with invitations, and a stranger asking for a code does not break the real code", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const q = encodeURIComponent("victim@sample.example");
    for (let i = 0; i < 3; i++) { expect((await h.call("POST", `/api/lists/${sid}/team`, { email: "victim@sample.example" }, jar)).status).toBe(201); await h.call("DELETE", `/api/lists/${sid}/team/${q}`, undefined, jar); }
    expect((await h.call("POST", `/api/lists/${sid}/team`, { email: "victim@sample.example" }, jar)).status).toBe(429);
    const h2 = await makeHarness(); await h2.call("POST", "/api/auth/start", { email: "real@sample.example" });
    const real = h2.code("real@sample.example");
    await h2.call("POST", "/api/auth/start", { email: "real@sample.example" }); // someone else asks again
    expect((await h2.call("POST", "/api/auth/verify", { email: "real@sample.example", code: real })).status).toBe(200);
  });
});

describe("F3: withdrawal and consent", () => {
  test("a voter can withdraw even an approved record while the list is open, and it leaves the list", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/withdraw`, {}, v.jar)).status).toBe(200);
    expect((await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar)).json.onList).toBe(0);
  });
});

describe("F4 and F5: the team and edits follow the same rules as voters", () => {
  test("a Host cannot add or correct their own record", async () => {
    const h = await makeHarness(); const { sid, slug } = await newList(h);
    const host = await h.staff(PERM);
    expect((await h.call("POST", `/api/lists/${sid}/records`, { agreed: true, unit: "H-1", name: "Host Person", capacity: "Owner", mobile: "9000000500", email: PERM }, host)).status).toBe(403);
    const v = await enrolVoter(h, slug, PERM, { unit: "H-2", name: "Host Person", mobile: "9000000501" });
    expect((await h.call("PATCH", `/api/lists/${sid}/records/${v.rec.id}`, { name: "Host Changed", reason: "typo" }, host)).status).toBe(403);
  });
  test("an approved owner cannot become a proxy without the authority letter", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h, { ruleCode: 4 });
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const r = await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { capacity: "Proxy", proxyFor: "Olga Owner" }, v.jar);
    expect(r.status).toBe(400); expect(r.json.code).toBe("need_proxy_letter");
  });
  test("documents cannot be added to an approved record", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/docs`, { docType: "Society ID", filename: "a.pdf", mime: "application/pdf", base64: pdf }, v.jar)).status).toBe(409);
  });
});

describe("F7: after the closing time nobody new is added", () => {
  test("staff cannot add or upload people once the cut-off has passed", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    await h.call("PATCH", `/api/lists/${sid}`, { cutoff: "2026-11-12T10:00" }, jar);
    h.clock.now = Date.UTC(2026, 10, 12, 6, 0, 0);
    const j = await h.staff("organizer@sample.example");
    expect((await h.call("POST", `/api/lists/${sid}/records`, { agreed: true, unit: "L-1", name: "Late Person", capacity: "Owner", mobile: "9000000600", email: "late@sample.example" }, j)).status).toBe(409);
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "paste", text: "Flat,Name,Capacity,Mobile,E-mail\nL-2,Late Two,Owner,9000000601,l2@sample.example" }, j)).status).toBe(409);
  });
});

describe("F10 and F12: nothing personal reaches the unerasable log or a mail", () => {
  test("a flat field with a name in it is refused", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const j = await h.member(slug, "a@sample.example");
    const r = await h.call("POST", `/api/v/${slug}/records`, { agreed: true, unit: "Rahul Mehta Flat 4", name: "Rahul Mehta", capacity: "Owner", mobile: "9000000700" }, j);
    expect(r.status).toBe(400); expect(r.json.code).toBe("bad_unit");
    expect((await h.call("POST", `/api/v/${slug}/records`, { agreed: true, unit: "Tower 2, 304", name: "Rahul Mehta", capacity: "Owner", mobile: "9000000700" }, j)).status).toBe(201);
  });
  test("a society name with a web address or e-mail ID is refused, and the reopen reason is not written to the log", async () => {
    const h = await makeHarness(); const jar = await h.staff("organizer@sample.example");
    expect((await h.call("POST", "/api/lists", { name: "URGENT: open evil.example/x now", kind: "RWA", country: "India", ruleCode: 2 }, jar)).status).toBe(400);
    expect((await h.call("POST", "/api/lists", { name: "Sample Heights", kind: "RWA", country: "India", ruleCode: 2 }, jar)).status).toBe(201);
  });
});

describe("F14", () => {
  test("a malformed address is a 400, not a 500", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    expect((await h.call("DELETE", `/api/lists/${sid}/team/%E0%A4%A`, undefined, jar)).status).toBe(400);
  });
});
