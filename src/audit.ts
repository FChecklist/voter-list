// The signed audit chain. Every state-changing operation commits its data statements and its audit entry in ONE D1 batch, so a change
// without a log line (or a log line without a change) cannot exist. Concurrent writers collide on the (society_id, seq) primary key and retry.
//
// Two helpers make "two people at once" safe:
//   guard(env, message)   a statement that aborts the WHOLE batch (nothing is written, no audit line) when the statement just before it
//                         changed no row. Put it right after `UPDATE ... WHERE status = 'waiting'` and everything after it only runs for the winner.
//   commit(...)           retries only the audit sequence collision; a guard failure becomes a clean 409.
import type { Json } from "./vendor/canonical";
import { appendEntry, verifyChain, type Actor, type SignedEntry } from "./vendor/log";
import { hmacHex, publicKeyFromPrivate } from "./vendor/crypto";
import { scanPublic } from "./vendor/masking";
import { HttpError } from "./errors";
import type { D1Stmt, Env } from "./db";

export type { Actor };

export async function pseudonym(env: Env, email: string): Promise<string> {
  return "p_" + (await hmacHex(env.PEPPER, "actor:" + email.trim().toLowerCase())).slice(0, 12);
}
export async function staffActor(env: Env, email: string, role: string): Promise<Actor> { return { pid: await pseudonym(env, email), role }; }

/** A flat or member ID is free text typed by people. If it looks like a phone number or an e-mail ID it must not reach the signed log: digits become #. */
export function looksPrivate(unit: string): boolean { return scanPublic(unit).length > 0 || unit.replace(/\D/g, "").length >= 10; }
export function pubUnit(unit: string): string {
  return looksPrivate(unit) ? unit.replace(/\d/g, "#").replace(/@/g, "#") : unit;
}

/** Abort the whole batch with `message` (a 409 for the person) unless the statement just before this one changed exactly one row. */
export function guardChanged(env: Env, message: string): D1Stmt {
  return env.DB.prepare("INSERT INTO guard_assert (ok, why) SELECT changes() >= 1, ?").bind(message.slice(0, 200));
}
/** Abort the whole batch with `message` unless `existsSql` (with `binds`) returns a row. */
export function guardExists(env: Env, message: string, existsSql: string, ...binds: unknown[]): D1Stmt {
  return env.DB.prepare(`INSERT INTO guard_assert (ok, why) SELECT EXISTS(${existsSql}), ?`).bind(...binds, message.slice(0, 200));
}

async function head(env: Env, societyId: string): Promise<SignedEntry | null> {
  const last = await env.DB.prepare("SELECT hash, sig, entry_json FROM audit_entries WHERE society_id = ? ORDER BY seq DESC LIMIT 1").bind(societyId).first<{ hash: string; sig: string; entry_json: string }>();
  return last ? { entry: JSON.parse(last.entry_json), hash: last.hash, sig: last.sig } : null;
}

const isChainCollision = (msg: string) => /UNIQUE|PRIMARY KEY/i.test(msg) && /audit_entries/i.test(msg);

/** Runs `stmts` and appends one audit entry, atomically. Returns the entry's sequence number. */
export async function commit(env: Env, societyId: string, stmts: D1Stmt[], type: string, actor: Actor, payload: Record<string, Json>, ts: number, scanAllow?: string[]): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * Math.min(60, 4 * attempt))));
    const prev = await head(env, societyId);
    const e = await appendEntry({ eid: societyId, prev, type, actor, payload, ts, privateKey: env.SIGNING_KEY, scanAllow });
    const ins = env.DB.prepare("INSERT INTO audit_entries (society_id, seq, ts, type, hash, sig, entry_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(societyId, e.entry.seq, ts, type, e.hash, e.sig, JSON.stringify(e.entry));
    try { await env.DB.batch([...stmts, ins]); return e.entry.seq; }
    catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      const g = /guard_failed:(.*?)::end/s.exec(msg);
      if (g) throw new HttpError(409, (g[1] ?? "").trim() || "Someone else changed this at the same moment. Please look again and try once more.", "conflict");
      if (!isChainCollision(msg)) throw err;
    }
  }
  void lastErr;
  throw new HttpError(503, "Many people are saving at the same moment. Nothing was lost; please try again in a few seconds.", "busy");
}

const PAGE = 1000;
type Row = { hash: string; sig: string; entry_json: string };
const toSigned = (r: Row): SignedEntry => ({ entry: JSON.parse(r.entry_json), hash: r.hash, sig: r.sig });

/** One page of the chain (at most 2000 entries), starting at `from`. */
export async function auditEntries(env: Env, societyId: string, opts: { from?: number; limit?: number } = {}): Promise<SignedEntry[]> {
  const rs = await env.DB.prepare("SELECT hash, sig, entry_json FROM audit_entries WHERE society_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?").bind(societyId, opts.from ?? 1, Math.min(Math.max(1, opts.limit ?? PAGE), 2000)).all<Row>();
  return rs.results.map(toSigned);
}

/** The whole chain, read page by page. Not capped: an export must be complete or say that it is not. */
export async function auditAll(env: Env, societyId: string): Promise<SignedEntry[]> {
  const out: SignedEntry[] = [];
  for (let from = 1; ;) {
    const page = await auditEntries(env, societyId, { from, limit: PAGE });
    out.push(...page);
    if (page.length < PAGE) return out;
    from = page[page.length - 1]!.entry.seq + 1;
  }
}

export async function auditHead(env: Env, societyId: string): Promise<{ seq: number; hash: string; ts: number } | null> {
  const h = await head(env, societyId);
  return h ? { seq: h.entry.seq, hash: h.hash, ts: h.entry.ts } : null;
}

/** Verifies EVERY entry (page by page, so memory stays small). `expected` is a head the caller wrote down earlier: a shorter or rewritten chain is then reported. */
export async function verifyAudit(env: Env, societyId: string, expected?: { seq: number; hash: string }) {
  const pub = await publicKeyFromPrivate(env.SIGNING_KEY);
  let after: { seq: number; hash: string } | undefined;
  let seenExpected: string | null = null;
  for (;;) {
    const page = await auditEntries(env, societyId, { from: (after?.seq ?? 0) + 1, limit: PAGE });
    if (!page.length) break;
    const r = await verifyChain(page, pub, undefined, after);
    if (!r.ok) return { ...r, count: r.count, publicKey: pub };
    if (expected) { const hit = page.find((p) => p.entry.seq === expected.seq); if (hit) seenExpected = hit.hash; }
    after = r.head!;
    if (page.length < PAGE) break;
  }
  if (!after) return { ok: true, count: 0, head: null, problems: [] as never[], publicKey: pub };
  if (expected) {
    if (after.seq < expected.seq) return { ok: false, count: after.seq, head: after, problems: [{ seq: after.seq, reason: "truncated" as const }], publicKey: pub };
    if (seenExpected !== expected.hash) return { ok: false, count: after.seq, head: after, problems: [{ seq: expected.seq, reason: "head_mismatch" as const }], publicKey: pub };
  }
  return { ok: true, count: after.seq, head: after, problems: [] as never[], publicKey: pub };
}

/** Verifies ONE stretch of the chain (at most 100 entries) that continues exactly from the entry before it. The page calls this again and again, so no single request does all the signature work. */
export async function verifySegment(env: Env, societyId: string, from: number, limit = 100) {
  const pub = await publicKeyFromPrivate(env.SIGNING_KEY);
  const start = Math.max(1, Math.floor(from)); const n = Math.min(100, Math.max(1, Math.floor(limit)));
  const prev = start > 1 ? (await auditEntries(env, societyId, { from: start - 1, limit: 1 }))[0] : undefined;
  if (start > 1 && !prev) return { ok: false, from: start, to: start, next: null as number | null, problems: [{ seq: start, reason: "truncated" }] };
  const page = await auditEntries(env, societyId, { from: start, limit: n });
  if (!page.length) return { ok: true, from: start, to: start - 1, next: null as number | null, problems: [] as unknown[] };
  const r = await verifyChain(page, pub, undefined, prev ? { seq: prev.entry.seq, hash: prev.hash } : undefined);
  const last = page[page.length - 1]!.entry.seq;
  return { ok: r.ok, from: start, to: last, next: r.ok && page.length === n ? last + 1 : null, problems: r.problems };
}
