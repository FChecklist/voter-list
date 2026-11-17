// Hash-chained, Ed25519-signed event log. Format: docs/design/LOG-FORMAT.md
import { canonical, type Json } from "./canonical";
import { sha256Hex, signMessage, verifyMessage } from "./crypto";
import { scanPublic } from "./masking";

export type Actor = { pid: string; role: string } | { flat: string } | { system: true };
export interface LogEntry { v: 1; eid: string; seq: number; ts: number; type: string; actor: Actor; payload: Record<string, Json>; prev: string }
export interface SignedEntry { entry: LogEntry; hash: string; sig: string }

export const genesisHash = (eid: string) => sha256Hex("voter-list/genesis/v1\n" + eid);
export const entryHash = (e: LogEntry) => sha256Hex("voter-list/entry/v1\n" + canonical(e));
export const signingMessage = (eid: string, seq: number, hash: string) => `voter-list/sig/v1\n${eid}\n${seq}\n${hash}`;

export interface AppendArgs {
  eid: string; prev: SignedEntry | null; type: string; actor: Actor; payload: Record<string, Json>; ts: number; privateKey: string;
  /** Exact public strings (such as a registration number) that the privacy guard may let through. */
  scanAllow?: string[];
}
/** Builds the next entry, refuses payloads that contain a complete e-mail or phone number, signs it. */
export async function appendEntry(a: AppendArgs): Promise<SignedEntry> {
  const bad = scanPublic(canonical(a.payload), { allow: a.scanAllow }).filter((f) => f.kind !== "forbidden");
  if (bad.length) throw new Error(`log payload not masked (${bad[0]!.kind})`);
  if (a.prev && (a.prev.entry.eid !== a.eid)) throw new Error("log: prev belongs to another event");
  const entry: LogEntry = {
    v: 1, eid: a.eid, seq: a.prev ? a.prev.entry.seq + 1 : 1, ts: a.ts, type: a.type, actor: a.actor, payload: a.payload,
    prev: a.prev ? a.prev.hash : await genesisHash(a.eid),
  };
  const hash = await entryHash(entry);
  const sig = await signMessage(a.privateKey, signingMessage(a.eid, entry.seq, hash));
  return { entry, hash, sig };
}

export interface VerifyProblem { seq: number; reason: "empty" | "genesis" | "seq_gap" | "eid_mismatch" | "hash_mismatch" | "prev_mismatch" | "bad_signature" | "head_mismatch" | "truncated" }
export interface ChainResult { ok: boolean; count: number; head: { seq: number; hash: string } | null; problems: VerifyProblem[] }

/** The verifier. Used by the Worker (tests), the report and the browser. Stops at the first failure. */
export async function verifyChain(entries: SignedEntry[], publicKey: string, expectedHead?: { seq: number; hash: string }, after?: { seq: number; hash: string }): Promise<ChainResult> {
  const fail = (seq: number, reason: VerifyProblem["reason"], count = 0): ChainResult => ({ ok: false, count, head: null, problems: [{ seq, reason }] });
  if (!entries.length) return fail(0, "empty");
  // a damaged or hostile file may contain anything: never throw, always answer "not verified"
  const wellFormed = (x: any) => !!x && typeof x === "object" && !!x.entry && typeof x.entry === "object" && typeof x.entry.eid === "string" && Number.isSafeInteger(x.entry.seq) && typeof x.hash === "string" && typeof x.sig === "string" && typeof x.entry.prev === "string" && typeof x.entry.type === "string";
  if (!Array.isArray(entries) || entries.some((x) => !wellFormed(x))) return fail(0, "hash_mismatch");
  const eid = entries[0]!.entry.eid;
  // `after` lets a long chain be checked page by page: the page must continue exactly from that entry
  const base = after?.seq ?? 0;
  let prevHash = after ? after.hash : await genesisHash(eid);
  for (let i = 0; i < entries.length; i++) {
    const s = entries[i]!, e = s.entry;
    if (e.eid !== eid) return fail(e.seq, "eid_mismatch", i);
    if (e.seq !== base + i + 1) return fail(e.seq, "seq_gap", i);
    if (e.prev !== prevHash) return fail(e.seq, i === 0 ? "genesis" : "prev_mismatch", i);
    let h: string;
    try { h = await entryHash(e); } catch { return fail(e.seq, "hash_mismatch", i); }
    if (h !== s.hash) return fail(e.seq, "hash_mismatch", i);
    if (!(await verifyMessage(publicKey, signingMessage(eid, e.seq, s.hash), s.sig))) return fail(e.seq, "bad_signature", i);
    prevHash = s.hash;
  }
  const head = { seq: base + entries.length, hash: entries[entries.length - 1]!.hash };
  if (expectedHead) {
    if (head.seq < expectedHead.seq) return { ok: false, count: base + entries.length, head, problems: [{ seq: head.seq, reason: "truncated" }] };
    const at = entries[expectedHead.seq - base - 1];
    if (at && at.hash !== expectedHead.hash) return { ok: false, count: base + entries.length, head, problems: [{ seq: expectedHead.seq, reason: "head_mismatch" }] };
  }
  return { ok: true, count: base + entries.length, head, problems: [] };
}
