// A voter's own side of the journey (enrol, confirm, update, documents, status) and the one mutation helper every record change goes through.
// Every change is ONE batch: the guarded UPDATE (it only applies to the revision that was read), its history event, and the signed audit entry.
// Two people at once (a voter editing while a host approves) therefore cannot both win: the loser gets a plain 409 and nothing of theirs is written.
import { HttpError, rateLimit, sendMail } from "./auth";
import { looksPrivate, commit, guardChanged, pseudonym, pubUnit } from "./audit";
import { uid, type D1Stmt, type Env } from "./db";
import { ruleOf } from "./model";
import { runChecks } from "./checks";
import { buildRoll, enrolOpen, getVoter, onList, ownedOf, settingsOf, type Owned, type SocietyRow, type VoterRow } from "./store";
import { capLabel, cleanMobile, cleanName, squeeze, unitDisplay, unitKey, parseCapacity, type Capacity } from "./text";
import { scanPublic } from "./vendor/masking";
import { sha256Hex } from "./vendor/crypto";

export const DOC_TYPES = ["Sale Deed or Share Certificate", "Allotment or Possession Letter", "Registration Paper", "Rent Agreement", "Proxy Nomination Form", "Society ID", "Others"] as const;
const MIME = ["application/pdf", "image/jpeg", "image/png"];
const MAX_DOC = 400_000;
export const MAX_DOCS = 3;
export const MAX_RECORDS_PER_PERSON = 5;
const STALE = "This record was changed a moment ago. Please look again and try once more.";

// ------------------------------------------------------------------------------------------------------------------ the mutation helper
export const MUT = ["unit", "unit_key", "name", "capacity", "mobile", "proxy_for", "is_voter", "weight_milli", "can_attend", "can_vote", "dues_paid_on", "status", "reason", "approved_json", "confirmed_at", "submitted_at", "decided_by", "decided_at", "no_vote_reason", "no_vote_note", "no_vote_by"] as const;
export type MutCol = (typeof MUT)[number];
export type Patch = Partial<Pick<VoterRow, MutCol>>;
export const snapshot = (v: Pick<VoterRow, MutCol>): string => JSON.stringify(Object.fromEntries(MUT.map((k) => [k, v[k] ?? null])));

export interface Evt { kind: string; actorEmail: string; actorRole: "voter" | "organizer" | "host" | "system"; reason?: string; batch?: string | null }

/** The guarded UPDATE + the history event for one record. The UPDATE only applies while the record is still at the revision that was read. */
export function mutation(env: Env, now: number, before: VoterRow, patch: Patch, e: Evt): { stmts: D1Stmt[]; after: VoterRow } {
  const keys = Object.keys(patch) as MutCol[];
  const after = { ...before, ...patch, revision: before.revision + 1, updated_at: now } as VoterRow;
  const set = [...keys.map((k) => `${k} = ?`), "revision = revision + 1", "updated_at = ?"].join(", ");
  return {
    after,
    stmts: [
      env.DB.prepare(`UPDATE voters SET ${set} WHERE society_id = ? AND id = ? AND revision = ?`).bind(...keys.map((k) => patch[k] ?? null), now, before.society_id, before.id, before.revision),
      guardChanged(env, STALE),
      env.DB.prepare("INSERT INTO voter_events (society_id, voter_id, ts, actor_email, actor_role, kind, from_status, to_status, reason, before_json, after_json, after_rev, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(before.society_id, before.id, now, e.actorEmail, e.actorRole, e.kind, before.status, after.status, e.reason ?? "", snapshot(before), snapshot(after), after.revision, e.batch ?? null),
    ],
  };
}

export const voterActor = async (env: Env, email: string) => ({ pid: await pseudonym(env, email), role: "voter" });
const mailNote = async (env: Env, to: string, subject: string, body: string, now: number) => { try { await sendMail(env, to, subject, body, "voter-note", now); } catch { /* a courtesy note: the record stands even if it cannot be mailed */ } };
export { mailNote };

// ------------------------------------------------------------------------------------------------------------------ validation shared by voter and staff
export function allowedCapacities(society: Pick<SocietyRow, "rule_code">): Capacity[] { return ruleOf(society.rule_code).capacities; }

export interface RecordInput { unit?: string; name?: string; capacity?: string; mobile?: string; proxyFor?: string }
/** Clean and check the voter-owned fields. `cur` supplies the values that were not sent (an edit). */
export function checkOwned(society: SocietyRow, input: RecordInput, cur?: VoterRow): { unit: string; unitKey: string; owned: Owned } {
  const rule = ruleOf(society.rule_code);
  const unitRaw = input.unit !== undefined ? input.unit : cur?.unit ?? "";
  const unit = unitDisplay(String(unitRaw)); const uk = unitKey(unit);
  if (!uk || unit.length > 40) throw new HttpError(400, "Please type your Flat / House / Member ID (up to 40 characters).");
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-\/.,#()]*$/.test(unit) || (unit.match(/[A-Za-z]{3,}/g) ?? []).length > 2) throw new HttpError(400, "Please type only the flat or house number, such as A-101 or Tower 2, 304.", "bad_unit");
  if (looksPrivate(unit) && !(cur && uk === cur.unit_key)) throw new HttpError(400, "That ID looks like a phone number or an e-mail ID. Please check it and type the flat, house or member ID instead.");
  const nm = cleanName(input.name !== undefined ? String(input.name) : cur?.name ?? "").value;
  if (nm.length < 2 || nm.length > 120) throw new HttpError(400, "Please type your full name (2 to 120 letters).");
  const mb = cleanMobile(input.mobile !== undefined ? String(input.mobile) : cur?.mobile ?? "", society.country);
  if (!mb.ok) throw new HttpError(400, "Please type a proper mobile number.");
  const capRaw = input.capacity !== undefined ? String(input.capacity) : cur?.capacity ?? "";
  const cap = parseCapacity(capRaw);
  if (!cap) throw new HttpError(400, "Please choose how you are connected to this home.");
  if (!rule.capacities.includes(cap)) throw new HttpError(400, cap === "Proxy" ? "On this list the owner or tenant enrols in person. Please choose that role instead." : `This list is for: ${rule.capacities.map(capLabel).join(", ")}.`, "capacity_not_allowed");
  let proxyFor = "";
  if (cap === "Proxy") {
    proxyFor = cleanName(input.proxyFor !== undefined ? String(input.proxyFor) : cur?.proxy_for ?? "").value;
    if (proxyFor.length < 2 || proxyFor.length > 120) throw new HttpError(400, "A proxy needs the name of the owner they act for.");
  }
  return { unit, unitKey: uk, owned: { name: nm, mobile: mb.value, capacity: cap, proxyFor } };
}

// ------------------------------------------------------------------------------------------------------------------ the voter's session
export interface VoterCtx { env: Env; now: number; email: string; society: SocietyRow }
const open = (c: VoterCtx) => { if (!enrolOpen(c.society, c.now)) throw new HttpError(409, c.society.phase === "frozen" ? "This list is final now, so details can no longer be changed." : "Enrolment has closed for this list, so details can no longer be changed.", "closed"); };
async function mine(c: VoterCtx, id: string): Promise<VoterRow> {
  const v = await getVoter(c.env, c.society.id, id);
  if (!v || v.email.toLowerCase() !== c.email || v.status === "removed") throw new HttpError(404, "Not found.", "not_found");
  return v;
}
const docCount = async (env: Env, id: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM voter_docs WHERE voter_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;

/** One shape for a document everywhere (the database column is doc_type; the pages read docType). */
export const docView = (d: { id: string; doc_type: string; filename: string; mime: string; size: number; created_at: number }) => ({ id: d.id, docType: d.doc_type, filename: d.filename, mime: d.mime, size: d.size, createdAt: d.created_at });

const NEXT: Record<string, string> = {
  invited: "Please check your details and press Confirm and send.", draft: "Please check your details and press Confirm and send.", submitted: "Your record is with the list team for a check.",
  approved: "Your record is on the list.", sent_back: "Please read the note, fix what is asked, and send it again.",
};
export async function viewMine(c: VoterCtx, v: VoterRow) {
  const docs = (await c.env.DB.prepare("SELECT id, doc_type, filename, mime, size, created_at FROM voter_docs WHERE voter_id = ? ORDER BY created_at, id").bind(v.id).all<{ id: string; doc_type: string; filename: string; mime: string; size: number; created_at: number }>()).results;
  const ev = (await c.env.DB.prepare("SELECT ts, kind, reason, actor_role FROM voter_events WHERE society_id = ? AND voter_id = ? AND undone_by IS NULL AND kind IN ('created','imported','added','confirmed','resubmitted','edited','corrected','approved','sent_back','doc_added','doc_removed') ORDER BY id").bind(c.society.id, v.id).all<{ ts: number; kind: string; reason: string; actor_role: string }>()).results;
  const live = onList(v);
  // can this person vote, and if not, why (the full reason: it is their own record)
  let vote: { allowed: boolean; reason: string } | null = null;
  if (live) {
    const roll = await buildRoll(c.env, c.society.id, v.unit_key); const line = roll.lines.find((l) => l.voterId === v.id);
    const st = line ? runChecks(roll.rows, settingsOf(c.society)).units[0]?.status.find((x) => x.rowId === line.row.id) : undefined;
    if (st) vote = { allowed: st.allowed, reason: st.reason };
  }
  return {
    vote,
    id: v.id, unit: v.unit, name: v.name, capacity: v.capacity, mobile: v.mobile, email: v.email, proxyFor: v.proxy_for, status: v.status, reason: v.status === "sent_back" ? v.reason : "",
    onTheList: !!live, whatIsOnTheList: live && v.status !== "approved" ? { name: live.name, capacity: live.capacity } : null, next: NEXT[v.status] ?? "",
    canEdit: enrolOpen(c.society, c.now) && v.status !== "removed", canWithdraw: ["invited", "draft", "submitted", "sent_back", "approved"].includes(v.status) && c.society.phase === "open" && !c.society.erased_at,
    docs: docs.map(docView), docsMax: MAX_DOCS, needsProxyLetter: v.capacity === "Proxy", revision: v.revision,
    timeline: ev.map((e) => ({ at: e.ts, what: e.kind, by: e.actor_role === "voter" ? "you" : "the list team", reason: e.kind === "sent_back" ? e.reason : "" })),
  };
}

export async function myRecords(c: VoterCtx) {
  const rs = await c.env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND email = ? AND status <> 'removed' ORDER BY created_at, id").bind(c.society.id, c.email).all<VoterRow>();
  const out = []; for (const v of rs.results) out.push(await viewMine(c, v));
  return { email: c.email, records: out };
}

export async function createRecord(c: VoterCtx, input: RecordInput) {
  open(c);
  await rateLimit(c.env, `rec-create:${c.society.id}:${c.email}`, 12, 86_400_000, c.now);
  const { unit, unitKey: uk, owned } = checkOwned(c.society, input);
  const ex = await c.env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND unit_key = ? AND email = ?").bind(c.society.id, uk, c.email).first<VoterRow>();
  const act = await voterActor(c.env, c.email);
  if (ex && ex.status !== "removed") throw new HttpError(409, "You already have a record for this home. It is shown below; please open it.", "exists");
  const active = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE society_id = ? AND email = ? AND status <> 'removed'").bind(c.society.id, c.email).first<{ n: number }>())?.n ?? 0;
  if (active >= MAX_RECORDS_PER_PERSON) throw new HttpError(409, `One e-mail ID can enrol up to ${MAX_RECORDS_PER_PERSON} homes.`, "too_many");
  const all = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE society_id = ? AND status <> 'removed'").bind(c.society.id).first<{ n: number }>())?.n ?? 0;
  if (all >= 6000) throw new HttpError(409, "This list has reached its size limit of 6000 records. Please ask the Organizer.", "list_full");
  let id: string;
  const stmts: D1Stmt[] = [];
  if (ex) { // a record this person removed earlier: reuse the row, start again as a draft
    id = ex.id;
    const m = mutation(c.env, c.now, ex, { unit, unit_key: uk, name: owned.name, capacity: owned.capacity, mobile: owned.mobile, proxy_for: owned.proxyFor, status: "draft", reason: "", approved_json: null, confirmed_at: null, submitted_at: null, decided_by: null, decided_at: null }, { kind: "created", actorEmail: c.email, actorRole: "voter" });
    stmts.push(...m.stmts);
  } else {
    id = uid("vtr");
    stmts.push(
      c.env.DB.prepare("INSERT INTO voters (id, society_id, unit, unit_key, name, capacity, mobile, email, proxy_for, status, source, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'voter', 1, ?, ?)").bind(id, c.society.id, unit, uk, owned.name, owned.capacity, owned.mobile, c.email, owned.proxyFor, c.now, c.now),
      c.env.DB.prepare("INSERT INTO voter_events (society_id, voter_id, ts, actor_email, actor_role, kind, to_status, after_rev) VALUES (?, ?, ?, ?, 'voter', 'created', 'draft', 1)").bind(c.society.id, id, c.now, c.email),
    );
  }
  try { await commit(c.env, c.society.id, stmts, "record.created", act, { unit: pubUnit(unit), capacity: owned.capacity ?? "" }, c.now); }
  catch (e) { if (/UNIQUE/i.test(String((e as Error)?.message)) && /voters/i.test(String((e as Error)?.message))) throw new HttpError(409, "You already have a record for this home.", "exists"); throw e; }
  return viewMine(c, (await getVoter(c.env, c.society.id, id))!);
}

export async function editRecord(c: VoterCtx, id: string, input: RecordInput) {
  open(c);
  await rateLimit(c.env, `rec-edit:${c.society.id}:${c.email}`, 60, 3_600_000, c.now);
  const v = await mine(c, id);
  const locked = !!v.approved_json || v.status === "approved"; // a flat, once approved, is not renamed: remove it and enrol the right one
  if (locked && input.unit !== undefined && unitKey(unitDisplay(String(input.unit))) !== v.unit_key) throw new HttpError(409, "The Flat / House ID cannot be changed once it was approved. Please ask the list team.", "unit_locked");
  const { unit, unitKey: uk, owned } = checkOwned(c.society, input, v);
  if (uk !== v.unit_key && v.no_vote_by === "organizer") throw new HttpError(409, "The Organizer has decided about your vote for this flat, so the flat cannot be changed here. Please ask the Organizer.", "unit_locked");
  const was = ownedOf(v);
  const fields: string[] = (["name", "mobile", "capacity", "proxyFor"] as const).filter((k) => was[k] !== owned[k]);
  if (unit !== v.unit) fields.push("unit");
  if (!fields.length) return viewMine(c, v);
  const patch: Patch = { unit, unit_key: uk, ...(uk !== v.unit_key ? { is_voter: null, ...(v.can_vote !== 0 ? { no_vote_reason: null, no_vote_note: null, no_vote_by: null } : {}) } : {}), name: owned.name, capacity: owned.capacity, mobile: owned.mobile, proxy_for: owned.proxyFor };
  if (v.status === "approved") Object.assign(patch, { approved_json: JSON.stringify(was), status: "submitted", reason: "", submitted_at: c.now, confirmed_at: c.now, decided_by: null, decided_at: null }); // the earlier approval stays on the list until the edit is checked
  if (v.status === "approved" || v.status === "submitted") { // a record that changes after it was sent must still meet the rules a new one meets
    const docs = await c.env.DB.prepare("SELECT doc_type FROM voter_docs WHERE voter_id = ?").bind(id).all<{ doc_type: string }>();
    if (owned.capacity === "Proxy" && !docs.results.some((d) => d.doc_type === "Proxy Nomination Form")) throw new HttpError(400, "A proxy needs to add the owner's authority letter (Proxy Nomination Form) first. Please add it in the Documents step, then save this change.", "need_proxy_letter");
  }
  const m = mutation(c.env, c.now, v, patch, { kind: "edited", actorEmail: c.email, actorRole: "voter" });
  try { await commit(c.env, c.society.id, m.stmts, "record.edited", await voterActor(c.env, c.email), { unit: pubUnit(unit), fields, resubmitted: v.status === "approved" ? 1 : 0 }, c.now); }
  catch (e) { if (/UNIQUE/i.test(String((e as Error)?.message))) throw new HttpError(409, "You already have a record for that home.", "exists"); throw e; }
  return viewMine(c, (await getVoter(c.env, c.society.id, id))!);
}

export async function confirmRecord(c: VoterCtx, id: string, consent: unknown) {
  open(c);
  if (consent !== true) throw new HttpError(400, "Please tick the box to confirm your details and agree to how they are used.", "consent");
  const v = await mine(c, id);
  if (!["invited", "draft", "sent_back"].includes(v.status)) throw new HttpError(409, v.status === "submitted" ? "This record has already been sent." : "This record is already on the list.", "bad_state");
  const { owned } = checkOwned(c.society, {}, v); // complete and allowed by this list's rule
  const docs = await c.env.DB.prepare("SELECT doc_type FROM voter_docs WHERE voter_id = ?").bind(id).all<{ doc_type: string }>();
  if (owned.capacity === "Proxy" && !docs.results.some((d) => d.doc_type === "Proxy Nomination Form")) throw new HttpError(400, "A proxy needs to add the owner's authority letter (Proxy Nomination Form) before sending.", "need_proxy_letter");
  if (c.society.docs_required && !docs.results.length) throw new HttpError(400, "This list asks for one supporting document. Please add it before sending.", "need_doc");
  const again = v.status === "sent_back";
  const m = mutation(c.env, c.now, v, { status: "submitted", reason: "", confirmed_at: c.now, submitted_at: c.now, decided_by: null, decided_at: null }, { kind: again ? "resubmitted" : "confirmed", actorEmail: c.email, actorRole: "voter", reason: "consent given" });
  await commit(c.env, c.society.id, m.stmts, again ? "record.resubmitted" : "record.confirmed", await voterActor(c.env, c.email), { unit: pubUnit(v.unit), consent: 1, docs: docs.results.length }, c.now);
  return viewMine(c, (await getVoter(c.env, c.society.id, id))!);
}

export async function withdrawRecord(c: VoterCtx, id: string) {
  // withdrawing consent stays possible after the closing time and until the list is final (editing does not)
  if (c.society.phase !== "open" || c.society.erased_at) throw new HttpError(409, "This list is final now, so a record can no longer be withdrawn here. Please ask the Organizer.", "frozen");
  const v = await mine(c, id);
  const m = mutation(c.env, c.now, v, { status: "removed", reason: "" }, { kind: "withdrawn", actorEmail: c.email, actorRole: "voter" });
  await commit(c.env, c.society.id, [...m.stmts, c.env.DB.prepare("DELETE FROM voter_docs WHERE voter_id = ?").bind(id)], "record.withdrawn", await voterActor(c.env, c.email), { unit: pubUnit(v.unit) }, c.now);
  return { id, status: "removed" };
}

// ------------------------------------------------------------------------------------------------------------------ documents
export interface DocInput { docType: string; filename?: string; mime: string; base64: string }
export async function checkDoc(d: DocInput): Promise<{ bytes: Uint8Array; sha: string; name: string }> {
  if (!(DOC_TYPES as readonly string[]).includes(d.docType)) throw new HttpError(400, "Please choose the kind of document.");
  if (!MIME.includes(d.mime)) throw new HttpError(400, "A document can be a PDF, JPG or PNG.");
  if (typeof d.base64 !== "string" || d.base64.length > Math.ceil((MAX_DOC * 4) / 3) + 8 || !/^[A-Za-z0-9+/=]+$/.test(d.base64)) throw new HttpError(400, "That document is too large (400 KB at most) or cannot be read.");
  let bin: string; try { bin = atob(d.base64); } catch { throw new HttpError(400, "That document cannot be read."); }
  if (bin.length > MAX_DOC || bin.length < 16) throw new HttpError(400, "That document is too large (400 KB at most) or empty.");
  const head = bin.slice(0, 8);
  const ok = d.mime === "application/pdf" ? head.startsWith("%PDF") : d.mime === "image/png" ? head.startsWith("\x89PNG") : head.startsWith("\xFF\xD8\xFF");
  if (!ok) throw new HttpError(400, "That file does not look like the kind of file it says it is.");
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return { bytes, sha: await sha256Hex(bytes), name: squeeze(d.filename ?? "").replace(/[^\w.\- ]/g, "_").slice(0, 80) || "document" };
}

export async function addDoc(c: VoterCtx, id: string, d: DocInput) {
  open(c);
  await rateLimit(c.env, `doc-add:${c.society.id}:${c.email}`, 15, 86_400_000, c.now);
  const v = await mine(c, id);
  // an approved record keeps its documents, with one exception: the owner's Proxy Nomination Form may be added, so an approved Owner can become a Proxy
  if (v.status === "approved" && d.docType !== "Proxy Nomination Form") throw new HttpError(409, "This record is approved, so its documents are kept as they are. To change them, change your details first so it is checked again.", "approved_docs");
  const f = await checkDoc(d);
  // the free database is small: one list may keep at most 100 MB of documents, so no single list can fill it for everybody
  const used = (await c.env.DB.prepare("SELECT IFNULL(SUM(size), 0) AS n FROM voter_docs WHERE society_id = ?").bind(c.society.id).first<{ n: number }>())?.n ?? 0;
  if (used + f.bytes.length > 100 * 1024 * 1024) throw new HttpError(409, "This list has used all of its document space. Please ask the Organizer.", "docs_full");
  const did = uid("doc");
  const touch = mutation(c.env, c.now, v, {}, { kind: "doc_added", actorEmail: c.email, actorRole: "voter", reason: d.docType });
  // the database trigger refuses a 4th document even if two uploads race
  await commit(c.env, c.society.id, [c.env.DB.prepare("INSERT INTO voter_docs (id, society_id, voter_id, doc_type, filename, mime, size, sha256, data_b64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(did, c.society.id, id, d.docType, f.name, d.mime, f.bytes.length, f.sha, d.base64, c.now), ...touch.stmts],
    "doc.added", await voterActor(c.env, c.email), { unit: pubUnit(v.unit), type: d.docType, size: f.bytes.length }, c.now);
  return viewMine(c, (await getVoter(c.env, c.society.id, id))!);
}

export async function removeDoc(c: VoterCtx, id: string, did: string) {
  open(c);
  const v = await mine(c, id);
  if (v.status === "approved") throw new HttpError(409, "This record is on the list, so its documents are kept. Please ask the list team if one must go.", "kept");
  const d = await c.env.DB.prepare("SELECT doc_type FROM voter_docs WHERE id = ? AND voter_id = ?").bind(did, id).first<{ doc_type: string }>();
  if (!d) throw new HttpError(404, "Not found.", "not_found");
  if (v.status === "submitted") { // already with the team: a swap is fine (add the new one first), but the record may not be left without what it needs
    const rest = (await c.env.DB.prepare("SELECT doc_type FROM voter_docs WHERE voter_id = ? AND id <> ?").bind(id, did).all<{ doc_type: string }>()).results;
    if ((v.capacity === "Proxy" && !rest.some((x) => x.doc_type === "Proxy Nomination Form")) || (c.society.docs_required && !rest.length))
      throw new HttpError(409, "Your record is with the list team, which needs this document. Please add the new one first, then remove this one.", "doc_needed");
  }
  const touch = mutation(c.env, c.now, v, {}, { kind: "doc_removed", actorEmail: c.email, actorRole: "voter", reason: d.doc_type });
  await commit(c.env, c.society.id, [c.env.DB.prepare("DELETE FROM voter_docs WHERE id = ? AND voter_id = ?").bind(did, id), guardChanged(c.env, "That document was already removed."), ...touch.stmts], "doc.removed", await voterActor(c.env, c.email), { unit: pubUnit(v.unit), type: d.doc_type }, c.now);
  return viewMine(c, (await getVoter(c.env, c.society.id, id))!);
}

export async function getMyDoc(c: VoterCtx, id: string, did: string) {
  await mine(c, id);
  const d = await c.env.DB.prepare("SELECT filename, mime, data_b64 FROM voter_docs WHERE id = ? AND voter_id = ?").bind(did, id).first<{ filename: string; mime: string; data_b64: string }>();
  if (!d) throw new HttpError(404, "Not found.", "not_found");
  return { body: Uint8Array.from(atob(d.data_b64), (ch) => ch.charCodeAt(0)), type: d.mime, filename: d.filename };
}
