// Fixes from the sixth independent audit (docs/AUDIT-ROUND-6.md): each finding gets a test that fails without the fix.
import { describe, expect, test } from "bun:test";
import { mailPools, sendMail } from "../src/auth";
import { enrolVoter, LIST, makeHarness, newList, waiting } from "./harness";

const real = globalThis.fetch;

describe("H1 and H2: strangers cannot make accounts, so they cannot reach any pool of mail", () => {
  test("in production mode an unknown address gets the usual answer and no mail; a listed Organizer gets a code and may start a list", async () => {
    const h = await makeHarness({ TEST_MODE: "0", RESEND_API_KEY: "k", ORGANIZERS: "boss@sample.example, other@sample.example" });
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const stranger = await h.call("POST", "/api/auth/start", { email: "stranger@sample.example" });
      const boss = await h.call("POST", "/api/auth/start", { email: "boss@sample.example" });
      expect(stranger.status).toBe(200); expect(boss.status).toBe(200); expect(stranger.json).toEqual(boss.json); // the same words either way
      expect((h.raw.query("SELECT to_addr FROM mail_outbox").all() as { to_addr: string }[]).map((x) => x.to_addr)).toEqual(["boss@sample.example"]);
    } finally { globalThis.fetch = real; }
  });
  test("a person who is not listed cannot start a list even if they somehow hold a session", async () => {
    const h = await makeHarness({ ORGANIZERS: "boss@sample.example" }); // test mode keeps sign-up open, so the sign-in works; turn it off for the list call
    const jar = await h.staff("rando@sample.example");
    h.env.TEST_MODE = "0";
    const r = await h.call("POST", "/api/lists", LIST, jar);
    expect(r.status).toBe(403); expect(r.json.code).toBe("not_organizer");
    const boss = await (async () => { h.env.TEST_MODE = "1"; const j = await h.staff("boss@sample.example"); h.env.TEST_MODE = "0"; return j; })();
    expect((await h.call("POST", "/api/lists", LIST, boss)).status).toBe(201);
  });
  test("host invitations and staff codes share the staff pool and never use the voters'", async () => {
    const h = await makeHarness();
    const env = { ...h.env, TEST_MODE: "0", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "80", MAIL_STAFF_RESERVE: "20" };
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const p = mailPools(env);
      for (let i = 0; i < p.staff; i++) await sendMail(env, `i${i}@sample.example`, "s", "b", "team-invite", h.clock.now);
      await expect(sendMail(env, "i99@sample.example", "s", "b", "team-invite", h.clock.now)).rejects.toMatchObject({ code: "mail_capped" });
      await sendMail(env, "v@sample.example", "s", "b", "otp-member", h.clock.now); // voters' codes still work
    } finally { globalThis.fetch = real; }
  });
});

describe("M2: a code request tells nothing about who is on a list", () => {
  test("a person on the list and a stranger get the same answer even after the list's cap is used", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    await enrolVoter(h, slug, "real@sample.example");
    const answers = new Set<string>();
    for (let i = 0; i < 30; i++) { const r = await h.call("POST", `/api/v/${slug}/start`, { email: `s${i}@sample.example` }); answers.add(r.status + JSON.stringify(r.json)); }
    const r = await h.call("POST", `/api/v/${slug}/start`, { email: "real@sample.example" }); answers.add(r.status + JSON.stringify(r.json));
    expect(answers.size).toBe(1);
  });
});

describe("L1 and L2: withdrawing after the closing time, and who was added to the team", () => {
  test("a voter can still withdraw after the closing time while the list is not final", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("PATCH", `/api/lists/${sid}`, { closeNow: true }, jar);
    expect((await h.call("GET", `/api/v/${slug}/me`, undefined, v.jar)).json.records[0].canWithdraw).toBe(true);
    expect((await h.call("POST", `/api/v/${slug}/records/${v.rec.id}/withdraw`, {}, v.jar)).status).toBe(200);
  });
  test("adding and removing a host is signed with who it was, as a pseudonym", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "newhost@sample.example" }, jar);
    await h.call("DELETE", `/api/lists/${sid}/team/${encodeURIComponent("newhost@sample.example")}`, undefined, jar);
    const e = (await h.call("GET", `/api/lists/${sid}/audit?from=1`, undefined, jar)).json.entries as any[];
    const added = e.find((x) => x.entry.type === "team.host_added"), removed = e.find((x) => x.entry.type === "team.host_removed");
    expect(added.entry.payload.target).toBeTruthy(); expect(added.entry.payload.target).toBe(removed.entry.payload.target);
    expect(JSON.stringify(e)).not.toContain("newhost@");
  });
});
