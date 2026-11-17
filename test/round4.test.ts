// Fixes from the fourth independent audit (docs/AUDIT-ROUND-4.md): each finding gets a test that fails without the fix.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

async function twoSpellings() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "ravi@sample.example", { unit: "A-101", name: "Ravi Sample", mobile: "9000000101" });
  const sita = await enrolVoter(h, slug, "sita@sample.example", { unit: "a 101", name: "Sita Sample", capacity: "Co-owner", mobile: "9000000102" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  expect((await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar)).status).toBe(201);
  return { h, jar, sid, slug, sita };
}

describe("H1: a withdrawn person leaves the public draft whatever way the flat was typed", () => {
  test("the same flat typed two ways: the withdrawn person is gone from the list and the CSV", async () => {
    const { h, slug, sita } = await twoSpellings();
    expect((await h.call("GET", `/api/v/${slug}/list`)).json.total).toBe(2);
    await h.call("POST", `/api/v/${slug}/records/${sita.rec.id}/withdraw`, {}, sita.jar);
    const l = (await h.call("GET", `/api/v/${slug}/list`)).json;
    expect(l.total).toBe(1); expect(JSON.stringify(l.rows)).not.toContain("Si**");
    expect((await h.call("GET", `/api/v/${slug}/list.csv`)).text).not.toContain("Si**");
  });
  test("a person who withdrew and enrolled again (not yet approved) does not reappear on the old draft", async () => {
    const { h, slug, sita } = await twoSpellings();
    await h.call("POST", `/api/v/${slug}/records/${sita.rec.id}/withdraw`, {}, sita.jar);
    const again = await h.call("POST", `/api/v/${slug}/records`, { unit: "a 101", name: "Someone Else", capacity: "Co-owner", mobile: "9000000103" }, sita.jar);
    expect(again.status).toBe(201);
    expect((await h.call("GET", `/api/v/${slug}/list`)).json.total).toBe(1);
  });
  test("it still holds after the removed record was purged for good", async () => {
    const { h, slug, sita } = await twoSpellings();
    await h.call("POST", `/api/v/${slug}/records/${sita.rec.id}/withdraw`, {}, sita.jar);
    h.raw.query("DELETE FROM voters WHERE id = ?").run(sita.rec.id);
    expect((await h.call("GET", `/api/v/${slug}/list`)).json.total).toBe(1);
  });
  test("a person whose change is being checked stays on the list with the earlier approved details", async () => {
    const { h, slug, sita } = await twoSpellings();
    await h.call("PATCH", `/api/v/${slug}/records/${sita.rec.id}`, { name: "Sita Changed" }, sita.jar);
    expect((await h.call("GET", `/api/v/${slug}/list`)).json.total).toBe(2);
  });
});

describe("M2: staff add only with the person's agreement", () => {
  test("adding without the tick is refused, with it works", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const body = { unit: "Z-1", name: "Zed Person", capacity: "Owner", mobile: "9000000401", email: "zed@sample.example" };
    const no = await h.call("POST", `/api/lists/${sid}/records`, body, jar); expect(no.status).toBe(400); expect(no.json.code).toBe("need_agreed");
    expect((await h.call("POST", `/api/lists/${sid}/records`, { ...body, agreed: true }, jar)).status).toBe(201);
  });
});

describe("H2 and M4: strangers cannot lock the list's own people out, and drafts cannot be pressed without end", () => {
  test("after strangers use up the list's daily codes, an enrolled person can still sign in", async () => {
    const h = await makeHarness(); const { slug, jar, sid } = await newList(h);
    await enrolVoter(h, slug, "real@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar); // the team has vouched for this person
    for (let i = 0; i < 40; i++) expect((await h.call("POST", `/api/v/${slug}/start`, { email: `stranger${i}@sample.example` })).status).toBe(200);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE kind LIKE 'otp-member%'").get()).toEqual({ n: 25 }); // strangers got 25 codes, then no more
    const before = (h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'real@sample.example'").get() as { n: number }).n;
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "real@sample.example" })).status).toBe(200);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'real@sample.example'").get() as { n: number }).n).toBe(before + 1); // the enrolled person still gets theirs
  });
  test("a draft can be published a limited number of times an hour", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const s: number[] = []; for (let i = 0; i < 14; i++) s.push((await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar)).status);
    expect(s.filter((x) => x === 201)).toHaveLength(12); expect(s[13]).toBe(429);
  });
});

describe("M5: the standing host signs in for 12 hours, others for 7 days", () => {
  test("session lengths", async () => {
    const h = await makeHarness();
    await h.staff("host@townhall-records.com"); await h.staff("organizer@sample.example");
    const rows = h.raw.query("SELECT email, expires_at - created_at AS ttl FROM sessions WHERE kind = 'staff'").all() as { email: string; ttl: number }[];
    expect(rows.find((r) => r.email === "host@townhall-records.com")!.ttl).toBe(12 * 3_600_000);
    expect(rows.find((r) => r.email === "organizer@sample.example")!.ttl).toBe(7 * 86_400_000);
  });
});
