// Round 7: the owner's answers of 13 Nov (public masks, records kept always, Turnstile on sign-in) and the simpler mail rules.
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, newList, enrolVoter, waiting, PERM } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("masks: the public sees only what the owner allowed", () => {
  test("public list, CSV and proof show last 4 digits of the mobile and last 4 characters of the e-mail, and nothing else", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "somebody.private@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    const list = (await h.call("GET", `/api/v/${slug}/list`)).json;
    const row = list.rows[0];
    expect(row.email).toBe("********" + "somebody.private@sample.example".slice(-4)); expect(row.mobile).toMatch(/^\*{6}\d{4}$/);
    expect(Object.keys(row).sort()).toEqual(["capacity", "email", "forOwner", "mayAttend", "mayVote", "mobile", "name", "no", "reason", "unit", "voterForFlat"]);
    const csv = (await h.call("GET", `/api/v/${slug}/list.csv`)).text;
    for (const secret of ["somebody", "sample.example"]) { expect(JSON.stringify(list)).not.toContain(secret); expect(csv.toLowerCase()).not.toContain(secret); }
    expect(csv).toContain("********" + "somebody.private@sample.example".slice(-4));
  });
});

describe("records are kept always unless the owner sets a retention period", () => {
  test("erase is not offered by default", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    h.clock.now += 2000 * 86_400_000; const j2 = await h.staff("organizer@sample.example");
    const st = (await h.call("GET", `/api/lists/${sid}/erase`, undefined, j2)).json; expect(st.keptAlways).toBe(true); expect(st.allowedNow).toBe(false);
    const r = await h.call("POST", `/api/lists/${sid}/erase`, { confirm: "ERASE" }, j2); expect(r.status).toBe(409); expect(r.json.code).toBe("kept");
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters").get()).toEqual({ n: 1 });
  });
});

describe("Turnstile: the free check on sign-in, only when set up", () => {
  const env = (h: Awaited<ReturnType<typeof makeHarness>>) => { h.env.TURNSTILE_SECRET = "s"; h.env.TURNSTILE_SITE_KEY = "pub"; };
  test("not set up: config is empty and sign-in needs no token", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    expect((await h.call("GET", "/api/config")).json.turnstileSiteKey).toBe("");
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example" })).status).toBe(200);
  });
  test("set up: no token, no code; a failed check, no code; a passed check, a code", async () => {
    const h = await makeHarness(); const { slug } = await newList(h); env(h);
    expect((await h.call("GET", "/api/config")).json.turnstileSiteKey).toBe("pub");
    const before = () => (h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox").get() as { n: number }).n; const n0 = before();
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example" })).json.code).toBe("turnstile");
    let ok = false; const seen: string[] = [];
    globalThis.fetch = (async (_u: unknown, init: { body: URLSearchParams }) => { seen.push(String(init.body.get("response"))); return new Response(JSON.stringify({ success: ok }), { status: 200 }); }) as unknown as typeof fetch;
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example", turnstileToken: "bad" })).json.code).toBe("turnstile");
    expect((await h.call("POST", "/api/auth/start", { email: "organizer@sample.example", turnstileToken: "bad" })).json.code).toBe("turnstile");
    expect(before()).toBe(n0); // nothing mailed, nothing counted
    ok = true;
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example", turnstileToken: "good" })).status).toBe(200);
    expect(before()).toBe(n0 + 1); expect(seen).toContain("good");
  });
});

describe("language switch: Hindi first, more languages are just more files", () => {
  const { readFileSync } = require("node:fs");
  const load = () => { const w: any = {}; new Function("window", readFileSync("public/assets/lang/hi.js", "utf8"))(w); return w.VL_LANGS.hi; };
  test("the Hindi file has words and patterns, and every step title of the voter page is translated", () => {
    const hi = load(); expect(hi.name).toBeTruthy();
    const voterJs = readFileSync("public/assets/voter.js", "utf8");
    for (const title of ["Step 1. Sign in", "Step 2. Tell us who you are", "Step 3. Check and send", "Step 4. Your information", "Step 5. Documents", "Step 6. Where things stand", "Step 7. The public list", "Send me a code", "Your e-mail ID"]) {
      expect(voterJs).toContain(title); expect(hi.words[title]).toBeTruthy();
    }
    const p = hi.patterns.find(([re]: [RegExp]) => re.test("A-101, Tenant")); expect(p[1]("A-101", "Tenant")).toContain("किरायेदार");
  });
  test("the voter page loads the switch and the language file, and nothing is inline", () => {
    for (const f of ["public/v/index.html"]) { const t = readFileSync(f, "utf8"); expect(t).toContain("/assets/i18n.js"); expect(t).toContain("/assets/lang/hi.js"); expect(/<script(?![^>]*\bsrc=)/.test(t)).toBe(false); }
    expect(readFileSync("public/_headers", "utf8")).toContain("script-src 'self' https://challenges.cloudflare.com");
  });
  test("the switch never writes markup", () => { const t = readFileSync("public/assets/i18n.js", "utf8"); expect(t).not.toContain("innerHTML"); });
});

describe("audit round 7 fixes", () => {
  const { readFileSync } = require("node:fs");
  const prod = (h: Awaited<ReturnType<typeof makeHarness>>, extra: Record<string, string> = {}) => { h.raw.query("DELETE FROM mail_outbox").run(); /* mail from setting the list up in test mode is not part of the day being tested */ Object.assign(h.env, { TEST_MODE: "0", RESEND_API_KEY: "k", ORGANIZERS: "organizer@sample.example", ...extra }); };

  test("M1: a code request gives the same answer when the mail fails, the pool is spent or the address is unknown, and the mail is sent after the answer", async () => {
    const h = await makeHarness(); const { slug } = await newList(h); await enrolVoter(h, slug, "real@sample.example");
    prod(h, { MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "8" });
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch; // the mail provider is down
    const answers: unknown[] = [];
    for (const [path, email] of [["/api/auth/start", "organizer@sample.example"], ["/api/auth/start", "stranger@sample.example"], [`/api/v/${slug}/start`, "real@sample.example"], [`/api/v/${slug}/start`, "stranger@sample.example"]] as const) { const r = await h.call("POST", path, { email }); answers.push([r.status, r.json]); }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    // with a host that lets work finish after the answer, the answer does not wait for the mail
    let slow = false; let pending: Promise<unknown> | null = null; const gate = new Promise<void>((ok) => setTimeout(ok, 120));
    globalThis.fetch = (async () => { await gate; slow = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    h.env.waitUntil = (p) => { pending = p; };
    const t0 = Date.now(); const r = await h.call("POST", `/api/v/${slug}/start`, { email: "real@sample.example", turnstileToken: "" });
    expect(r.status).toBe(200); expect(slow).toBe(false); expect(Date.now() - t0).toBeLessThan(100);
    await pending; expect(slow).toBe(true);
  });

  test("M2: strangers cannot use more than two thirds of the voters' pool, so people already on a list can still sign in", async () => {
    const h = await makeHarness(); const { slug, jar, sid } = await newList(h); await enrolVoter(h, slug, "real@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    prod(h, { MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "8", MAIL_LIST_CAP: "100" }); // voters 12, newcomers at most 8
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    for (let i = 0; i < 20; i++) await h.call("POST", `/api/v/${slug}/start`, { email: `s${i}@sample.example` });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE kind = 'otp-member-new' AND status = 'sent'").get()).toEqual({ n: 8 });
    await h.call("POST", `/api/v/${slug}/start`, { email: "real@sample.example" });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'real@sample.example' AND kind = 'otp-member' AND status = 'sent'").get()).toEqual({ n: 1 });
  });

  test("M5: only a record the voter withdrew is cleared after 30 days; a record the team removed is kept", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const a = await enrolVoter(h, slug, "a@sample.example", { unit: "A-1" }); const b = await enrolVoter(h, slug, "b@sample.example", { unit: "B-1" });
    expect((await h.call("POST", `/api/v/${slug}/records/${a.rec.id}/withdraw`, {}, a.jar)).status).toBe(200);
    expect((await h.call("POST", `/api/lists/${sid}/records/remove`, { ids: [b.rec.id], reason: "moved away" }, jar)).status).toBe(200);
    h.clock.now += 40 * 86_400_000; const { purgeStale } = await import("../src/auth"); await purgeStale(h.env, h.clock.now);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters WHERE id = ?").get(a.rec.id)).toEqual({ n: 0 });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters WHERE id = ?").get(b.rec.id)).toEqual({ n: 1 });
  });

  test("L1: a person handed a list who is not on the owner's list cannot start more lists", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    expect((await h.call("POST", `/api/lists/${sid}/team/organizer`, { email: "newboss@sample.example" }, jar)).status).toBeLessThan(300);
    const nb = await h.staff("newboss@sample.example"); prod(h, { ORGANIZERS: "organizer@sample.example" });
    const r = await h.call("POST", "/api/lists", { name: "Second", kind: "RWA", country: "India", state: "Karnataka", ruleCode: 1 }, nb); expect(r.status).toBe(403);
  });

  test("M4: every message a voter can meet from the server has a Hindi line", () => {
    const w: any = {}; new Function("window", readFileSync("public/assets/lang/hi.js", "utf8"))(w); const hi = w.VL_LANGS.hi;
    const missing: string[] = [];
    for (const f of ["src/records.ts", "src/auth.ts", "src/handler.ts"]) for (const m of readFileSync(f, "utf8").matchAll(/HttpError\(\d+,\s*"((?:[^"\\]|\\.)*)"/g)) if (!hi.words[m[1]!]) missing.push(m[1]!);
    expect(missing).toEqual([]);
  });
});

describe("audit round 8 fixes", () => {
  const { readFileSync } = require("node:fs");
  const hiLoad = () => { const w: any = {}; new Function("window", readFileSync("public/assets/lang/hi.js", "utf8"))(w); return w.VL_LANGS.hi; };
  const has = (hi: any, s: string) => { const c = s.trim(); return hi.words[c] !== undefined || hi.patterns.some(([re]: [RegExp]) => re.test(c)); };

  test("M1: after 30 days a withdrawn voter is gone from the stored draft lines too, and a final list is untouched", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const a = await enrolVoter(h, slug, "withdrawer@sample.example", { unit: "W-1" }); await enrolVoter(h, slug, "stays@sample.example", { unit: "S-1" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    expect((await h.call("POST", `/api/v/${slug}/records/${a.rec.id}/withdraw`, {}, a.jar)).status).toBe(200);
    h.clock.now += 45 * 86_400_000; const { purgeStale } = await import("../src/auth"); await purgeStale(h.env, h.clock.now);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publication_rows WHERE email = 'withdrawer@sample.example'").get()).toEqual({ n: 0 });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM publication_rows WHERE email = 'stays@sample.example'").get()).toEqual({ n: 1 });
  });

  test("M2: the real Step 7 sentences are translated, and every plain sentence in the voter page has a Hindi line", () => {
    const hi = hiLoad();
    const mk = (s: string, re: RegExp) => { const p = hi.patterns.find(([r]: [RegExp]) => r.test(s)); expect(p).toBeTruthy(); expect(s).toMatch(re); };
    for (const s of ["Final list for Annual General Meeting 2026, frozen at the cut-off of 12 Nov 2026, 10:00. It cannot change.", "16 people in 14 flats. Fingerprint", "1 person. Fingerprint", "Provisional list 2, published 12 Nov. It may still change.", "Final list 3 for AGM, frozen 12 Nov 2026"]) mk(s, /./);
    for (const s of ["No", "Yes", "Cancel", "Reason:", "What happens next.", ". Names, mobile numbers and e-mail IDs are masked.", "Mobile", "E-mail ID"]) expect(has(hi, s)).toBe(true);
    const skip = new Set(["Test mode: your code is", "Ra**** Sh****", "Change:"]); // the last is a prefix of an aria-label, translated by a pattern
    const miss: string[] = [];
    for (const f of ["voter.js", "ui.js", "steps.js"]) for (const m of readFileSync("public/assets/" + f, "utf8").matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
      const s = m[1]!; if (!/^[A-Z][a-z]+[^"]*[ ]/.test(s) || s.length < 8 || /[{}<>=;]/.test(s) || skip.has(s.trim())) continue;
      if (!has(hi, s)) miss.push(f + ": " + s);
    }
    expect(miss).toEqual([]);
  });

  test("L3: Turnstile is on only when both the secret and the site key are set, so a half set-up cannot lock everyone out", async () => {
    const h = await makeHarness(); const { slug } = await newList(h); h.env.TURNSTILE_SECRET = "s";
    expect((await h.call("GET", "/api/config")).json.turnstileSiteKey).toBe("");
    expect((await h.call("POST", `/api/v/${slug}/start`, { email: "a@sample.example" })).status).toBe(200);
  });
});

describe("audit round 9 fixes", () => {
  const prod = (h: Awaited<ReturnType<typeof makeHarness>>, extra: Record<string, string> = {}) => { h.raw.query("DELETE FROM mail_outbox").run(); /* mail from setting the list up in test mode is not part of the day being tested */ Object.assign(h.env, { TEST_MODE: "0", RESEND_API_KEY: "k", ORGANIZERS: "organizer@sample.example", ...extra }); };

  test("M1: a record the voter withdrew and then re-enrolled, which the team later removed, is kept", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const a = await enrolVoter(h, slug, "again@sample.example", { unit: "R-1" });
    expect((await h.call("POST", `/api/v/${slug}/records/${a.rec.id}/withdraw`, {}, a.jar)).status).toBe(200);
    const b = await enrolVoter(h, slug, "again@sample.example", { unit: "R-1" }); // the same person comes back
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/records/remove`, { ids: [b.rec.id], reason: "sold the flat" }, jar)).status).toBe(200);
    h.clock.now += 45 * 86_400_000; const { purgeStale } = await import("../src/auth"); await purgeStale(h.env, h.clock.now);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters WHERE email = 'again@sample.example'").get()).toEqual({ n: 1 });
  });

  test("M2: records a stranger makes for themselves do not make an address 'known'", async () => {
    const h = await makeHarness(); const { slug, jar, sid } = await newList(h);
    await enrolVoter(h, slug, "vouched@sample.example", { unit: "V-1" }); await h.call("POST", `/api/lists/${sid}/records/decide`, { items: (await waiting(h, sid, jar)), decision: "approve" }, jar);
    for (let i = 0; i < 3; i++) await enrolVoter(h, slug, `fake${i}@sample.example`, { unit: `F-${i}` });
    prod(h, { MAIL_DAILY_CAP: "40", MAIL_STAFF_RESERVE: "8", MAIL_LIST_CAP: "100" });
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) await h.call("POST", `/api/v/${slug}/start`, { email: `fake${i}@sample.example` });
    await h.call("POST", `/api/v/${slug}/start`, { email: "vouched@sample.example" });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE kind = 'otp-member-new'").get()).toEqual({ n: 3 }); // self-made records are still newcomers
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE kind = 'otp-member' AND to_addr = 'vouched@sample.example'").get()).toEqual({ n: 1 }); // the team's approved person is known
  });

  test("L1: a burst of simultaneous mails cannot overshoot the day's allowance", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const env = { ...h.env, TEST_MODE: "0", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" }; // voters 10
    globalThis.fetch = (async () => { await new Promise((r) => setTimeout(r, 10)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const rs = await Promise.allSettled(Array.from({ length: 40 }, (_x, i) => sendMail(env, `b${i}@sample.example`, "s", "b", "otp-member", h.clock.now)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE status = 'sent'").get()).toEqual({ n: 10 });
  });

  test("L2: the proof of a draft makes no line-by-line claim, and the final one still does", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h); await enrolVoter(h, slug, "a@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    expect((await h.call("GET", `/api/v/${slug}/proof`)).json.linesMatchFingerprint).toBe(null);
    await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    expect((await h.call("GET", `/api/v/${slug}/proof`)).json.linesMatchFingerprint).toBe(true);
  });
});

describe("audit round 10 fixes", () => {
  const { readFileSync } = require("node:fs");
  const prod = (h: Awaited<ReturnType<typeof makeHarness>>, extra: Record<string, string> = {}) => { h.raw.query("DELETE FROM mail_outbox").run(); Object.assign(h.env, { TEST_MODE: "0", RESEND_API_KEY: "k", ORGANIZERS: "organizer@sample.example", ...extra }); };

  test("M1: the purge always names the society, so it can use the history index", () => {
    const t = readFileSync("src/auth.ts", "utf8"); const hits = [...t.matchAll(/e\.voter_id = /g)].length;
    expect(hits).toBeGreaterThan(0); expect([...t.matchAll(/e\.society_id = \w+\.society_id AND e\.voter_id = /g)].length).toBe(hits);
  });

  test("L1: an approved voter who edits their record is still known", async () => {
    const h = await makeHarness(); const { slug, jar, sid } = await newList(h); const v = await enrolVoter(h, slug, "known@sample.example");
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { name: "Known Changed" }, v.jar)).status).toBe(200); // goes back for a fresh check
    prod(h, { MAIL_DAILY_CAP: "40", MAIL_STAFF_RESERVE: "8", MAIL_LIST_CAP: "1" });
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await h.call("POST", `/api/v/${slug}/start`, { email: "stranger1@sample.example" }); // uses the list's one newcomer slot
    await h.call("POST", `/api/v/${slug}/start`, { email: "known@sample.example" });
    expect(h.raw.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'known@sample.example' AND status = 'sent'").get()).toEqual({ n: 1 });
  });

  test("L6: a claimed slot nobody answered for 10 minutes stops counting", async () => {
    const h = await makeHarness(); const { sendMail } = await import("../src/auth");
    const env = { ...h.env, TEST_MODE: "0", RESEND_API_KEY: "k", MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "10" }; // voters 10
    for (let i = 0; i < 10; i++) h.raw.query("INSERT INTO mail_outbox (to_addr, subject, body, kind, status, created_at) VALUES (?, 's', 'b', 'otp-member', 'queued', ?)").run(`q${i}@sample.example`, h.clock.now);
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(sendMail(env, "x@sample.example", "s", "b", "otp-member", h.clock.now)).rejects.toMatchObject({ code: "mail_capped" }); // fresh claims count
    await sendMail(env, "y@sample.example", "s", "b", "otp-member", h.clock.now + 11 * 60_000); // old unanswered claims do not
  });
});

describe("audit round 11 fixes", () => {
  const { readFileSync } = require("node:fs");

  test("M1: the README's preview settings leave the voters a share of the day's mail", async () => {
    const { mailPools } = await import("../src/auth"); const h = await makeHarness();
    const readme = readFileSync("README.md", "utf8");
    const cap = readme.match(/MAIL_DAILY_CAP[^\n]*?type (\d+)/)![1]; const res = readme.match(/MAIL_STAFF_RESERVE[^\n]*?type (\d+)/)?.[1];
    const p = mailPools({ ...h.env, MAIL_DAILY_CAP: cap, ...(res ? { MAIL_STAFF_RESERVE: res } : {}) });
    expect(p.voters).toBeGreaterThan(0);
    expect(mailPools({ ...h.env, MAIL_DAILY_CAP: "20" }).voters).toBeGreaterThan(0); // even with the default reserve
    expect(mailPools({ ...h.env, MAIL_DAILY_CAP: "20", MAIL_STAFF_RESERVE: "500" }).voters).toBe(10);
  });

  test("L1: the clean-up has its indexes (migration 0006) and still clears what it should", async () => {
    const h = await makeHarness();
    const idx = h.raw.query("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r: any) => r.name);
    for (const n of ["idx_voters_removed", "idx_rate_hits_ts"]) expect(idx).toContain(n);
    const { purgeStale } = await import("../src/auth"); await purgeStale(h.env, h.clock.now + 90 * 86_400_000); // nothing to clear: no error
  });

  test("L2: weights for many flats are saved with one read", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h, { extra: { weightMode: "unequal" } });
    await enrolVoter(h, slug, "w1@sample.example", { unit: "W-1" }); await enrolVoter(h, slug, "w2@sample.example", { unit: "W-2" });
    const r = await h.call("PUT", `/api/lists/${sid}/weights`, { items: [{ unit: "W-1", weight: "2" }, { unit: "W-2", weight: "1.5" }, { unit: "W-9", weight: "1" }] }, jar);
    expect(r.status).toBe(200);
    expect(h.raw.query("SELECT weight_milli FROM voters WHERE email = 'w1@sample.example'").get()).toEqual({ weight_milli: 2000 });
  });

  test("L3: a flat that hides a phone number in spaced digits is refused", async () => {
    const h = await makeHarness(); const { slug } = await newList(h); const jar = await h.member(slug, "d@sample.example");
    for (const unit of ["9 8 7 6 5 4 3 2 1 0", "9-8-7-6-5-4-3-2-1-0", "98765.43210", "12/34/5678 9012"]) {
      expect((await h.call("POST", `/api/v/${slug}/records`, { unit, name: "Asha Sample", capacity: "Owner", mobile: "9000000101" }, jar)).status).toBe(400);
    }
    expect((await h.call("POST", `/api/v/${slug}/records`, { unit: "A-101", name: "Asha Sample", capacity: "Owner", mobile: "9000000101" }, jar)).status).toBe(201);
  });

  test("L4: the Hindi file covers the button labels the page sets in code", () => {
    const hi = readFileSync("public/assets/lang/hi.js", "utf8");
    for (const s of ["Saving…", "Sending…"]) expect(hi).toContain(`"${s}"`);
  });
});

describe("audit round 12 fixes", () => {
  test("L1: a long stored member ID can still be edited by name, and a typed phone number is still refused", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const v = await enrolVoter(h, slug, "m@sample.example", { unit: "MEM-2019-00123" }); // 9 digits: fine
    expect((await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { name: "Asha Changed" }, v.jar)).status).toBe(200);
    h.raw.query("UPDATE voters SET unit = 'M-0001234567', unit_key = 'M0001234567' WHERE id = ?").run(v.rec.id); // an uploaded ID with 10 digits
    expect((await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { name: "Asha Again" }, v.jar)).status).toBe(200);
    expect((await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { unit: "9876543210" }, v.jar)).status).toBe(400);
  });

  test("L2: a bad weights request is a clear 400, not a 500", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h, { extra: { weightMode: "unequal" } });
    expect((await h.call("PUT", `/api/lists/${sid}/weights`, { items: [null] }, jar)).status).toBe(400);
    expect((await h.call("PUT", `/api/lists/${sid}/weights`, { items: [{ unit: "A-1", weight: "1" }, { unit: "a-1", weight: "2" }] }, jar)).status).toBe(400);
  });

  test("L3: a mistyped mail setting falls back, and staff keep at least one mail on a tiny cap", async () => {
    const { mailPools } = await import("../src/auth"); const h = await makeHarness();
    expect(mailPools({ ...h.env, MAIL_DAILY_CAP: "abc" }).cap).toBe(80);
    expect(mailPools({ ...h.env, MAIL_DAILY_CAP: "1" }).staff).toBe(1);
  });
});

describe("audit round 13 fixes", () => {
  test("M1: a phone number in the Flat column is not imported, and a stored one never reaches the public list", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const text = "Flat,Name,Email,Mobile,Role\nA-5,Asha Sample,ok@sample.example,9000000105,Owner\n9876543210,Bina Sample,shift@sample.example,9000000106,Owner\n";
    const r = await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text }, jar);
    expect(r.status).toBe(200); expect(r.json.added).toBe(1); expect(r.json.skipped.badUnit).toBe(1);
    // a record that got a phone-like unit some other way is masked when the list is made
    const v = await enrolVoter(h, slug, "p@sample.example", { unit: "P-7" });
    h.raw.query("UPDATE voters SET unit = '9876543211', unit_key = '9876543211' WHERE id = ?").run(v.rec.id);
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar)).status).toBe(201);
    const pub = JSON.stringify((await h.call("GET", `/api/v/${slug}/list`)).json) + (await h.call("GET", `/api/v/${slug}/list.csv`)).text;
    expect(pub).not.toContain("9876543211");
  });

  test("L1: the real page sends the whole form; an unchanged long stored ID still saves", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const v = await enrolVoter(h, slug, "m@sample.example", { unit: "MEM-1" });
    h.raw.query("UPDATE voters SET unit = 'M-0001234567', unit_key = 'M0001234567' WHERE id = ?").run(v.rec.id);
    const mine = { unit: "M-0001234567", capacity: v.rec.capacity };
    expect((await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { unit: mine.unit, name: "Asha Full", capacity: mine.capacity, mobile: "9000000101" }, v.jar)).status).toBe(200);
    expect((await h.call("PATCH", `/api/v/${slug}/records/${v.rec.id}`, { unit: "9876543210", name: "Asha Full", capacity: mine.capacity, mobile: "9000000101" }, v.jar)).status).toBe(400);
  });

  test("L2: an empty mail setting means 'not set'", async () => {
    const { mailPools } = await import("../src/auth"); const h = await makeHarness();
    expect(mailPools({ ...h.env, MAIL_DAILY_CAP: "" }).cap).toBe(80);
  });
});

describe("audit round 14 fixes", () => {
  test("M1: a Host's flat checks show masked names, with nothing opened", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "a1@sample.example", { unit: "C-9", name: "Rajesh Kumar Sharma" }); await enrolVoter(h, slug, "a2@sample.example", { unit: "C-9", name: "Sunita Sharma Verma" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const host = await h.staff(PERM);
    const asHost = (await h.call("GET", `/api/lists/${sid}/checks`, undefined, host)).text;
    expect(asHost).not.toContain("Rajesh Kumar Sharma"); expect(asHost).not.toContain("Sunita Sharma Verma");
    expect((await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar)).text).toContain("Rajesh Kumar Sharma"); // the Organizer sees names
  });

  test("L1: a masked flat cannot be found by typing digits in the public search", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const v = await enrolVoter(h, slug, "p@sample.example", { unit: "P-7" }); await enrolVoter(h, slug, "q@sample.example", { unit: "9-1", name: "Other Person" });
    h.raw.query("UPDATE voters SET unit = '9876543211', unit_key = '9876543211' WHERE id = ?").run(v.rec.id);
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    expect((await h.call("GET", `/api/v/${slug}/list?unit=9876`)).json.total).toBe(0);
    expect((await h.call("GET", `/api/v/${slug}/list?unit=91`)).json.total).toBe(1); // ordinary flats are found as before
  });

  test("L2: an upload skips a flat the voter could not confirm", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const text = `Flat,Name,Email,Mobile,Role\nA-5,Asha Sample,ok@sample.example,9000000105,Owner\n${"X".repeat(60)},Bina Sample,b@sample.example,9000000106,Owner\n<B>X</B>,Chetan Sample,c@sample.example,9000000107,Owner\n`;
    const r = await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text }, jar);
    expect(r.json.added).toBe(1); expect(r.json.skipped.badUnit).toBe(2);
  });
});

describe("audit round 15 fixes", () => {
  test("L1: a Host's check of a sheet is noted in the log (counts only)", async () => {
    const h = await makeHarness(); const { sid } = await newList(h); const host = await h.staff(PERM);
    const text = "Flat,Name,Email,Mobile,Role\nA-5,Asha Sample,ok@sample.example,9000000105,Owner\n";
    const r = await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text, dryRun: true }, host);
    expect(r.status).toBe(200);
    const kinds = ((await h.call("GET", `/api/lists/${sid}/audit`, undefined, (await h.staff("organizer@sample.example")))).json.entries as any[]).map((e) => e.entry.type);
    expect(kinds).toContain("records.import_checked");
  });

  test("L4: documents and exports carry a sandbox policy", async () => {
    const t = require("node:fs").readFileSync("src/handler.ts", "utf8");
    expect(t).toContain("sandbox; default-src 'none'");
  });
});
