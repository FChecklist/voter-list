// The Cloudflare Email Service sender (14 Nov 2026): same five mail rules and caps, only the provider call changed.
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Seen = { url: string; auth: string | null; body: Record<string, unknown> };
const capture = (reply: () => Response = () => new Response(JSON.stringify({ success: true, result: { delivered: ["x"], queued: [], permanent_bounces: [] } }), { status: 200 })) => {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return reply();
  }) as unknown as typeof fetch;
  return seen;
};

describe("Cloudflare Email Service sender", () => {
  test("the From header always quotes the display name", async () => {
    const { fromHeader } = await import("../src/auth");
    const env = (MAIL_FROM?: string) => ({ MAIL_FROM }) as never;
    expect(fromHeader(env())).toBe('"Townhall Records" <no-reply@townhall-records.com>');
    expect(fromHeader(env("Townhall Records <no-reply@townhall-records.com>"))).toBe('"Townhall Records" <no-reply@townhall-records.com>');
    expect(fromHeader(env('"Townhall Records" <no-reply@townhall-records.com>'))).toBe('"Townhall Records" <no-reply@townhall-records.com>');
    expect(fromHeader(env("Records, Townhall <no-reply@townhall-records.com>"))).toBe('"Records, Townhall" <no-reply@townhall-records.com>');
    expect(fromHeader(env("no-reply@townhall-records.com"))).toBe("no-reply@townhall-records.com");
    expect(fromHeader(env("<no-reply@townhall-records.com>"))).toBe("no-reply@townhall-records.com");
    expect(fromHeader(env("  "))).toBe('"Townhall Records" <no-reply@townhall-records.com>');
  });

  test("mail is configured by either route, and by neither it is not", async () => {
    const { mailConfigured } = await import("../src/auth");
    expect(mailConfigured({} as never)).toBe(false);
    expect(mailConfigured({ CF_EMAIL_TOKEN: "t" } as never)).toBe(false); // the token alone is not enough
    expect(mailConfigured({ CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" } as never)).toBe(false);
    expect(mailConfigured({ CF_EMAIL_TOKEN: "t", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" } as never)).toBe(true);
    expect(mailConfigured({ CF_EMAIL_TOKEN: "t", CF_ACCOUNT_ID: " 0123456789abcdef0123456789abcdef " } as never)).toBe(true);
    for (const bad of ["a", "..", "../x?y=1", "acc123", "0123456789abcdef0123456789abcdef0"]) expect(mailConfigured({ CF_EMAIL_TOKEN: "t", CF_ACCOUNT_ID: bad } as never)).toBe(false); // not an account id, so the route is not used
    expect(mailConfigured({ RESEND_API_KEY: "k" } as never)).toBe(true);
  });

  test("a code is sent through the Cloudflare route: right address, bearer token, quoted From, one recipient", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const seen = capture();
    const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", MAIL_FROM: "Townhall Records <no-reply@townhall-records.com>", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" };
    await sendMail(env, "a@sample.example", "Your code", "Your code is 123456", "otp-member", h.clock.now);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/email/sending/send");
    expect(seen[0]!.auth).toBe("Bearer tok");
    expect(seen[0]!.body).toEqual({ from: { address: "no-reply@townhall-records.com", name: "Townhall Records" }, to: ["a@sample.example"], subject: "Your code", text: "Your code is 123456" });
    expect(h.raw.query("SELECT status FROM mail_outbox").all()).toEqual([{ status: "sent" }]);
  });

  test("an account id that is not 32 hex characters is never put in the address: no call, same 503", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const seen = capture();
    for (const bad of ["../x?y=1", "..", "a/b"]) {
      const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: bad, MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" };
      await expect(sendMail(env, "a@sample.example", "s", "b", "otp-member", h.clock.now)).rejects.toMatchObject({ status: 503, code: "mail_not_configured" });
    }
    expect(seen).toHaveLength(0);
  });

  test("the display name loses control characters and backslashes", async () => {
    const { fromHeader } = await import("../src/auth");
    const env = (MAIL_FROM?: string) => ({ MAIL_FROM }) as never;
    expect(fromHeader(env("A\r\nBcc: x <a@b.co>"))).toBe('"A Bcc: x" <a@b.co>');
    expect(fromHeader(env("A\\ <a@b.co>"))).toBe('"A" <a@b.co>');
  });

  test("success with nobody delivered or queued counts as failed; delivered or queued counts as sent", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", MAIL_DAILY_CAP: "80", MAIL_STAFF_RESERVE: "20" };
    capture(() => new Response(JSON.stringify({ success: true, result: { delivered: [], queued: [], permanent_bounces: ["a@sample.example"] } }), { status: 200 }));
    await expect(sendMail(env, "a@sample.example", "s", "b", "otp-member", h.clock.now)).rejects.toMatchObject({ code: "mail_failed" });
    capture(() => new Response(JSON.stringify({ success: true, result: { delivered: [], queued: ["a@sample.example"], permanent_bounces: [] } }), { status: 200 }));
    await sendMail(env, "a@sample.example", "s", "b", "otp-member", h.clock.now);
    expect(h.raw.query("SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status ORDER BY status").all()).toEqual([{ status: "failed", n: 1 }, { status: "sent", n: 1 }]);
  });

  test("a request for a code goes out by the Cloudflare route and the answer is the same as for an unknown address", async () => {
    const h = await makeHarness(); const { startCode } = await import("../src/auth");
    const seen = capture();
    const tasks: Promise<unknown>[] = [];
    const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10", PERMANENT_HOST_EMAIL: "host@sample.example", waitUntil: (p: Promise<unknown>) => { tasks.push(p); } };
    await startCode(env as never, "host@sample.example", "staff", null, "1.1.1.1", h.clock.now);
    await startCode(env as never, "stranger@sample.example", "staff", null, "1.1.1.2", h.clock.now);
    await Promise.all(tasks);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.to).toEqual(["host@sample.example"]);
    // only one of the two Cloudflare secrets: the same 503 as no secrets
    await expect(startCode({ ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok" } as never, "host@sample.example", "staff", null, "1.1.1.3", h.clock.now)).rejects.toMatchObject({ status: 503, code: "mail_not_configured" });
  });

  test("when both routes are set, Cloudflare is used and Resend is not", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const seen = capture();
    const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" };
    await sendMail(env, "a@sample.example", "s", "b", "otp-member", h.clock.now);
    expect(seen.map((x) => new URL(x.url).host)).toEqual(["api.cloudflare.com"]);
  });

  test("with only the older key, Resend is still used (quoted From too)", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const seen = capture();
    const env = { ...h.env, TEST_MODE: "0", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" };
    await sendMail(env, "a@sample.example", "s", "b", "otp-member", h.clock.now);
    expect(seen[0]!.url).toBe("https://api.resend.com/emails");
    expect(seen[0]!.auth).toBe("Bearer k");
    expect(seen[0]!.body.from).toBe('"Townhall Records" <no-reply@townhall-records.com>');
  });

  test("a refusal, an error answer, a success:false answer and a network failure all end as a clean 502 and a 'failed' row", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", MAIL_DAILY_CAP: "80", MAIL_STAFF_RESERVE: "20" };
    const replies: Array<() => Response | never> = [
      () => new Response("{}", { status: 403 }),
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] }), { status: 200 }),
      () => new Response("not json", { status: 200 }),
      () => { throw new Error("network down"); },
    ];
    for (const rep of replies) {
      globalThis.fetch = (async () => rep()) as unknown as typeof fetch;
      await expect(sendMail(env, "a@sample.example", "s", "b", "otp-member", h.clock.now)).rejects.toMatchObject({ status: 502, code: "mail_failed" });
    }
    expect(h.raw.query("SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status").all()).toEqual([{ status: "failed", n: 4 }]);
  });

  test("the day's caps hold on the Cloudflare route: a burst of 40 sends exactly the voters' share", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    globalThis.fetch = (async () => { await new Promise((r) => setTimeout(r, 10)); return new Response(JSON.stringify({ success: true }), { status: 200 }); }) as unknown as typeof fetch;
    const env = { ...h.env, TEST_MODE: "0", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" };
    const rs = await Promise.allSettled(Array.from({ length: 40 }, (_x, i) => sendMail(env, `b${i}@sample.example`, "s", "b", "otp-member", h.clock.now)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE status = 'sent'").get()).toEqual({ n: 10 });
  });

  test("without any mail secret, asking for a code gives the same 503 as before, and TEST_MODE never calls a provider", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const seen = capture();
    const prod = { ...h.env, TEST_MODE: "0" };
    await expect(sendMail(prod, "a@sample.example", "s", "b", "otp-member", h.clock.now)).rejects.toMatchObject({ status: 503, code: "mail_not_configured" });
    await sendMail({ ...h.env, TEST_MODE: "1", CF_EMAIL_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" }, "a@sample.example", "s", "b", "otp-member", h.clock.now);
    expect(seen).toHaveLength(0);
  });
});
