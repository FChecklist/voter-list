// Test harness: the real handler, real migrations on SQLite, a fake clock, cookie jars, and a way to read the e-mailed code from the outbox.
import { makeD1 } from "../src/db-sqlite";
import { handle } from "../src/handler";
import type { Env } from "../src/db";
import { generateSigningKey } from "../src/vendor/crypto";

export interface Harness { env: Env; raw: ReturnType<typeof makeD1>["raw"]; clock: { now: number }; call: (method: string, path: string, body?: unknown, jar?: Jar, headers?: Record<string, string>) => Promise<R>; staff: (email: string, name?: string) => Promise<Jar>; member: (slug: string, email: string) => Promise<Jar>; code: (email: string) => string }
export type Jar = { vl?: string; vlm?: string };
export interface R { status: number; json: any; headers: Headers; bytes: Uint8Array; text: string }

export async function makeHarness(opts: Partial<Env> = {}): Promise<Harness> {
  const d = makeD1(":memory:");
  const key = await generateSigningKey();
  const env: Env = { DB: d.db, SIGNING_KEY: key.privateKeyPkcs8, PEPPER: "test-pepper", TEST_MODE: "1", ...opts };
  const clock = { now: Date.UTC(2026, 10, 11, 6, 0, 0) }; // 11 Nov 2026, 11:30 IST
  let ipN = 0;
  const call: Harness["call"] = async (method, path, body, jar, headers = {}) => {
    const h: Record<string, string> = { "x-vl": "1", "cf-connecting-ip": `10.0.${Math.floor(ipN / 250)}.${ipN % 250}`, ...headers };
    ipN++;
    if (body !== undefined) h["content-type"] = "application/json";
    const ck = [jar?.vl ? `vl=${jar.vl}` : "", jar?.vlm ? `vlm=${jar.vlm}` : ""].filter(Boolean).join("; "); if (ck) h.cookie = ck;
    const res = await handle(new Request("http://t.local" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, clock.now);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let json: any = null; try { json = JSON.parse(text); } catch { /* binary */ }
    const sc = res.headers.get("set-cookie");
    if (sc && jar) { const m = /^(vl|vlm)=([0-9a-f]*);/.exec(sc); if (m) { if (m[2]) (jar as any)[m[1]!] = m[2]; else delete (jar as any)[m[1]!]; } }
    return { status: res.status, json, headers: res.headers, bytes, text };
  };
  const code = (email: string) => {
    const rows = d.raw.query("SELECT body FROM mail_outbox WHERE to_addr = ? AND kind LIKE 'otp-%' ORDER BY id DESC").all(email.toLowerCase()) as { body: string }[];
    const m = rows.map((r) => /\b(\d{6})\b/.exec(r.body)).find(Boolean); if (!m) throw new Error("no code mailed to " + email); return m[1]!;
  };
  const staff: Harness["staff"] = async (email) => {
    const jar: Jar = {};
    let r = await call("POST", "/api/auth/start", { email }, jar); if (r.status !== 200) throw new Error("start failed " + r.text);
    r = await call("POST", "/api/auth/verify", { email, code: code(email) }, jar); if (r.status !== 200) throw new Error("verify failed " + r.text);
    return jar;
  };
  const member: Harness["member"] = async (slug, email) => {
    const jar: Jar = {};
    let r = await call("POST", `/api/v/${slug}/start`, { email }, jar); if (r.status !== 200) throw new Error("member start failed " + r.text);
    r = await call("POST", `/api/v/${slug}/verify`, { email, code: code(email) }, jar); if (r.status !== 200) throw new Error("member verify failed " + r.text);
    return jar;
  };
  return { env, raw: d.raw, clock, call, staff, member, code };
}

export const LIST = { name: "Sample Heights Residents Welfare Association", kind: "RWA", country: "India", state: "Karnataka", regNo: "KA/RWA/2019/0001", regOffice: "Sample Registering Office (made up)", ruleCode: 4 };
export const PERM = "host@townhall-records.com";

/** Sign in as the Organizer and create a list. Returns the pieces most tests need. */
export async function newList(h: Harness, o: { email?: string; ruleCode?: number; extra?: Record<string, unknown> } = {}) {
  const email = o.email ?? "organizer@sample.example";
  const jar = await h.staff(email);
  const c = await h.call("POST", "/api/lists", { ...LIST, ruleCode: o.ruleCode ?? LIST.ruleCode, ...o.extra }, jar); if (c.status !== 201) throw new Error(c.text);
  const sid = c.json.list.id as string; const slug = (c.json.list.link as string).split("/").pop()!;
  return { jar, sid, slug, email };
}
/** A voter signs in on the common link and enrols one home. Returns their jar and the record. */
export async function enrolVoter(h: Harness, slug: string, email: string, o: { unit?: string; name?: string; capacity?: string; mobile?: string; proxyFor?: string; confirm?: boolean } = {}) {
  const jar = await h.member(slug, email);
  const r = await h.call("POST", `/api/v/${slug}/records`, { unit: o.unit ?? "A-101", name: o.name ?? "Asha Sample", capacity: o.capacity ?? "Owner", mobile: o.mobile ?? "9000000101", proxyFor: o.proxyFor }, jar);
  if (r.status !== 201) throw new Error("enrol failed " + r.text);
  let rec = r.json;
  if (o.confirm !== false) { const c = await h.call("POST", `/api/v/${slug}/records/${rec.id}/confirm`, { consent: true }, jar); if (c.status !== 200) throw new Error("confirm failed " + c.text); rec = c.json; }
  return { jar, rec };
}
/** The waiting records as the team sees them, as decide() items. */
export async function waiting(h: Harness, sid: string, jar: Jar) {
  const r = await h.call("GET", `/api/lists/${sid}/records?status=submitted&limit=200`, undefined, jar);
  return (r.json.records as any[]).map((x) => ({ id: x.id as string, rev: x.revision as number }));
}
