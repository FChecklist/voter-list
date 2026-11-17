// Fill a local database with ONE made-up society, through the real handler, so the audit trail and fingerprints are genuine.
// Synthetic voters only (names, flats, mobiles and e-mail IDs below are invented; the .example domain is reserved and cannot receive mail).
// Usage: bun run scripts/seed.ts [file]   (default .local/voter-list.sqlite).  Organizer: organizer@sample.example.
// The demo link is printed at the end. Sign-in codes appear at /dev/code?to=<e-mail> in the dev server.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeD1 } from "../src/db-sqlite";
import { handle } from "../src/handler";
import { synthCsv } from "../src/synthetic";
import type { Env } from "../src/db";

const vars: Record<string, string> = {};
if (existsSync(".dev.vars")) for (const l of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) vars[m[1]!] = m[2]!; }
if (!vars.SIGNING_KEY || !vars.PEPPER) { console.error("No .dev.vars yet. Run:  bun run gen:keys"); process.exit(1); }

const file = process.argv[2] ?? ".local/voter-list.sqlite";
mkdirSync(dirname(file), { recursive: true });
const { db, raw } = makeD1(file);
if ((raw.query("SELECT COUNT(*) AS n FROM societies").get() as { n: number }).n > 0) { console.log("already seeded; leaving it alone"); process.exit(0); }
const env: Env = { DB: db, SIGNING_KEY: vars.SIGNING_KEY, PEPPER: vars.PEPPER, TEST_MODE: "1", MAIL_DAILY_CAP: "5000", MAIL_LIST_CAP: "5000" }; // the demo signs in many made-up people at once
let ip = 0;
type Jar = { vl?: string; vlm?: string };
const call = async (m: string, path: string, jar: Jar, body?: unknown) => {
  const ck = [jar.vl ? `vl=${jar.vl}` : "", jar.vlm ? `vlm=${jar.vlm}` : ""].filter(Boolean).join("; ");
  const res = await handle(new Request("http://seed.local" + path, { method: m, headers: { "x-vl": "1", "content-type": "application/json", "cf-connecting-ip": "10.9." + Math.floor(ip / 250) + "." + (ip++ % 250), ...(ck ? { cookie: ck } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const sc = res.headers.get("set-cookie"); const mm = sc && /^(vl|vlm)=([0-9a-f]+)/.exec(sc); if (mm) (jar as Record<string, string>)[mm[1]!] = mm[2]!;
  const text = await res.text(); if (res.status >= 400) throw new Error(m + " " + path + " -> " + res.status + " " + text); return JSON.parse(text);
};
const code = (e: string) => (raw.query("SELECT body FROM mail_outbox WHERE to_addr = ? AND kind LIKE 'otp-%' ORDER BY id DESC").get(e) as { body: string }).body.match(/\b(\d{6})\b/)![1];
const staff = async (e: string) => { const j: Jar = {}; await call("POST", "/api/auth/start", j, { email: e }); await call("POST", "/api/auth/verify", j, { email: e, code: code(e) }); return j; };
const voter = async (slug: string, e: string) => { const j: Jar = {}; await call("POST", `/api/v/${slug}/start`, j, { email: e }); await call("POST", `/api/v/${slug}/verify`, j, { email: e, code: code(e) }); return j; };

const org = await staff("organizer@sample.example");
const made = await call("POST", "/api/lists", org, { name: "Sample Heights Residents Welfare Association", kind: "RWA", country: "India", state: "Karnataka", regNo: "KA/RWA/2019/0001", regOffice: "Sample Registering Office (made up)", ruleCode: 4 });
const sid = made.list.id as string, slug = (made.list.link as string).split("/").pop()!;
await call("POST", `/api/lists/${sid}/team`, org, { email: "host1@sample.example" });
await call("POST", `/api/lists/${sid}/records/import`, org, { format: "csv", text: synthCsv({ units: 24, seed: 7 }), filename: "sample.csv" });
// about half of the invited people sign in, check and send
const invited = raw.query("SELECT id, email, name FROM voters WHERE status = 'invited' ORDER BY unit_key LIMIT 16").all() as { id: string; email: string }[];
for (const v of invited) { if (!v.email) continue; const j = await voter(slug, v.email); await call("POST", `/api/v/${slug}/records/${v.id}/confirm`, j, { consent: true }); }
// the team approves most, sends one back
const w = ((await call("GET", `/api/lists/${sid}/records?status=submitted&limit=200`, org)).records as { id: string; revision: number }[]).map((r) => ({ id: r.id, rev: r.revision }));
if (w.length) {
  await call("POST", `/api/lists/${sid}/records/decide`, org, { items: w.slice(1), decision: "approve" });
  await call("POST", `/api/lists/${sid}/records/decide`, org, { items: w.slice(0, 1), decision: "send_back", reason: "Please give your name as it is in the sale deed." });
}
await call("POST", `/api/lists/${sid}/publish/draft`, org, {});
raw.query("DELETE FROM rate_hits").run(); // the demo signed many people in at once; the dev server starts with clean limits
console.log(`Seeded. Organizer page: http://localhost:8787/   sign in as organizer@sample.example\nVoter link: http://localhost:8787/v/${slug}`);
