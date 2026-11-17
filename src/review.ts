// The list team's side: the review queue (check -> approve, or not approved -> back to the voter with a reason -> resubmitted -> check again),
// corrections, adding and removing records, upload of an existing list, who votes for a flat, vote weights, and Undo.
import { HttpError, rateLimit } from "./auth";
import { looksPrivate, commit, guardChanged, pubUnit, staffActor } from "./audit";
import { uid, type D1Stmt } from "./db";
import { autoMarked, parseUpload } from "./importer";
import { noContactDetails } from "./lists";
import { chooseReason } from "./reasons";
import { allowedCapacities, checkOwned, docView, mailNote, mutation, MUT, snapshot, type Patch } from "./records";
import { need, onList, seesFull, viewVoter, type StaffCtx, type VoterRow } from "./store";
import { cleanEmail, parseDate, parseWeight, squeeze, unitKey } from "./text";
import { fromB64url } from "./vendor/crypto";
import { maskEmail, maskName } from "./vendor/masking";

const MAX_BULK = 60;
const frozenCheck = (ctx: StaffCtx) => { if (ctx.society.phase !== "open") throw new HttpError(409, "The list is frozen, so records can no longer be changed. Reopen the list first if a new round is needed.", "frozen"); };
/** After the closing time nobody new is added; the team can still check what was already sent. */
const closedCheck = (ctx: StaffCtx) => { const c = ctx.society.cutoff_at; if (c !== null && ctx.now >= c) throw new HttpError(409, "The closing time has passed, so people can no longer be added. You can still check what was already sent.", "closed"); };
const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");
const actorRole = (ctx: StaffCtx) => ctx.role;

// ------------------------------------------------------------------------------------------------------------------ looking
export async function listRecords(ctx: StaffCtx, o: { status?: string | null; q?: string; offset?: number; limit?: number }) {
  need(ctx, "view");
  const full = seesFull(ctx), db = ctx.env.DB;
  const where = ["society_id = ?", "status <> 'removed'"]; const binds: unknown[] = [ctx.society.id];
  if (o.status && o.status !== "all") { if (!["invited", "draft", "submitted", "approved", "sent_back"].includes(o.status)) throw new HttpError(400, "Unknown status."); where.push("status = ?"); binds.push(o.status); }
  const q = (o.q ?? "").trim().toLowerCase().slice(0, 60);
  if (q) { // a Host can look a flat up, but cannot search people by name, mobile or e-mail ID
    const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    if (full) { where.push("(lower(unit) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\')"); binds.push(like, like, like); }
    else { where.push("lower(unit) LIKE ? ESCAPE '\\'"); binds.push(like); }
  }
  const off = Math.max(0, Math.floor(o.offset ?? 0)), lim = Math.min(200, Math.max(1, Math.floor(o.limit ?? 50)));
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM voters WHERE ${where.join(" AND ")}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const rows = (await db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM voter_docs d WHERE d.voter_id = v.id) AS docs FROM voters v WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'sent_back' THEN 1 ELSE 2 END, IFNULL(submitted_at, created_at), unit_key LIMIT ? OFFSET ?`).bind(...binds, lim, off).all<VoterRow & { docs: number }>()).results;
  return { total, offset: off, masked: !full, records: rows.map((r) => ({ ...viewVoter(r, !full), docs: r.docs })), counts: await counts(ctx) };
}

export async function counts(ctx: StaffCtx): Promise<Record<string, number>> {
  const rs = await ctx.env.DB.prepare("SELECT status, COUNT(*) AS n FROM voters WHERE society_id = ? AND status <> 'removed' GROUP BY status").bind(ctx.society.id).all<{ status: string; n: number }>();
  const out: Record<string, number> = { invited: 0, draft: 0, submitted: 0, approved: 0, sent_back: 0 };
  for (const r of rs.results) out[r.status] = r.n;
  return out;
}

async function staffVoter(ctx: StaffCtx, id: string): Promise<VoterRow> {
  const v = await ctx.env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND id = ?").bind(ctx.society.id, id).first<VoterRow>();
  if (!v) throw new HttpError(404, "Not found.", "not_found");
  return v;
}

/** One record in full, with its documents and history. A Host's opening is rationed and written to the signed log (who, which flat, when). */
export async function openRecord(ctx: StaffCtx, id: string) {
  need(ctx, "view");
  const v = await staffVoter(ctx, id);
  if (v.status === "removed") throw new HttpError(404, "Not found.", "not_found");
  if (!seesFull(ctx)) {
    await rateLimit(ctx.env, `open:${ctx.society.id}:${ctx.email}`, 300, 3_600_000, ctx.now);
    await commit(ctx.env, ctx.society.id, [], "record.opened", await staffActor(ctx.env, ctx.email, ctx.role), { unit: pubUnit(v.unit) }, ctx.now);
  }
  const db = ctx.env.DB;
  const docs = (await db.prepare("SELECT id, doc_type, filename, mime, size, created_at FROM voter_docs WHERE voter_id = ? ORDER BY created_at, id").bind(id).all<{ id: string; doc_type: string; filename: string; mime: string; size: number; created_at: number }>()).results.map(docView);
  const perm = new Set((await db.prepare("SELECT email FROM memberships WHERE society_id = ? AND permanent = 1").bind(ctx.society.id).all<{ email: string }>()).results.map((r) => r.email.toLowerCase()));
  const events = (await db.prepare("SELECT id, ts, actor_email, actor_role, kind, from_status, to_status, reason, undone_by FROM voter_events WHERE society_id = ? AND voter_id = ? ORDER BY id").bind(ctx.society.id, id).all<{ id: number; ts: number; actor_email: string; actor_role: string; kind: string; from_status: string | null; to_status: string | null; reason: string; undone_by: number | null }>()).results;
  const live = onList(v);
  return {
    record: { ...viewVoter(v, false), proxyFor: v.proxy_for },
    onTheList: live ? { name: live.name, mobile: live.mobile, capacity: live.capacity, proxyFor: live.proxyFor } : null,
    docs,
    history: events.map((e) => ({ at: e.ts, kind: e.kind, from: e.from_status, to: e.to_status, reason: e.reason, undone: e.undone_by !== null, by: e.actor_role === "voter" ? "Voter" : perm.has(e.actor_email.toLowerCase()) ? "Townhall Records Host" : e.actor_role === "organizer" ? "Organizer" : e.actor_role === "host" ? "Host" : "System", you: e.actor_email.toLowerCase() === ctx.email })),
  };
}

export async function getStaffDoc(ctx: StaffCtx, id: string, did: string) {
  need(ctx, "view");
  const v = await staffVoter(ctx, id);
  const d = await ctx.env.DB.prepare("SELECT doc_type, filename, mime, data_b64 FROM voter_docs WHERE id = ? AND voter_id = ?").bind(did, id).first<{ doc_type: string; filename: string; mime: string; data_b64: string }>();
  if (!d) throw new HttpError(404, "Not found.", "not_found");
  await rateLimit(ctx.env, `doc-open:${ctx.society.id}:${ctx.email}`, 300, 3_600_000, ctx.now);
  await commit(ctx.env, ctx.society.id, [], "doc.opened", await staffActor(ctx.env, ctx.email, ctx.role), { unit: pubUnit(v.unit), type: d.doc_type }, ctx.now);
  return { body: Uint8Array.from(atob(d.data_b64), (ch) => ch.charCodeAt(0)), type: d.mime, filename: d.filename };
}

// ------------------------------------------------------------------------------------------------------------------ the decision
export type Decision = "approve" | "send_back";
export interface DecideItem { id: string; rev: number }

/** Approve, or send back with a reason. Each item carries the revision the checker was looking at, so a record the voter changed a moment ago is never approved by mistake. */
export async function decide(ctx: StaffCtx, items: DecideItem[], decision: Decision, rawReason = "") {
  need(ctx, "review"); frozenCheck(ctx);
  if (decision !== "approve" && decision !== "send_back") throw new HttpError(400, "Choose Approve or Not approved.");
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Please choose at least one record.");
  if (items.length > MAX_BULK) throw new HttpError(400, `Up to ${MAX_BULK} records can be decided at once.`);
  const reason = squeeze(rawReason);
  if (decision === "send_back") {
    if (reason.length < 3) throw new HttpError(400, "Please write, in a few words, what the voter should fix.", "reason");
    if (reason.length > 300) throw new HttpError(400, "Please keep the note to 300 letters.", "reason");
    noContactDetails(reason, "the note");
  }
  const ids = [...new Set(items.map((i) => String(i.id)))];
  const rows = (await ctx.env.DB.prepare(`SELECT * FROM voters WHERE society_id = ? AND id IN (${ph(ids.length)})`).bind(ctx.society.id, ...ids).all<VoterRow>()).results;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skipped: Array<{ id: string; why: string }> = []; const stmts: D1Stmt[] = []; const done: VoterRow[] = [];
  const batch = items.length > 1 ? uid("bat") : null;
  for (const it of items) {
    const v = byId.get(String(it.id));
    if (!v || v.status === "removed") { skipped.push({ id: String(it.id), why: "not_found" }); continue; }
    if (v.email.toLowerCase() === ctx.email) { skipped.push({ id: v.id, why: "own_record" }); continue; }
    if (v.status !== "submitted") { skipped.push({ id: v.id, why: "not_waiting" }); continue; }
    if (v.revision !== it.rev) { skipped.push({ id: v.id, why: "changed" }); continue; }
    const patch: Patch = decision === "approve"
      ? { status: "approved", reason: "", approved_json: null, decided_by: ctx.email, decided_at: ctx.now }
      : { status: "sent_back", reason, decided_by: ctx.email, decided_at: ctx.now };
    stmts.push(...mutation(ctx.env, ctx.now, v, patch, { kind: decision === "approve" ? "approved" : "sent_back", actorEmail: ctx.email, actorRole: actorRole(ctx), reason, batch }).stmts);
    done.push(v);
  }
  if (!done.length) {
    const first = skipped[0]!;
    if (items.length === 1) throw new HttpError(first.why === "own_record" ? 403 : 409, first.why === "own_record" ? "Your own record needs another person's check." : first.why === "changed" ? "The voter changed this record a moment ago. Please open it again and check the new details." : "This record is not waiting for a check any more.", first.why);
    return { applied: 0, skipped, batch: null };
  }
  const actor = await staffActor(ctx.env, ctx.email, ctx.role);
  if (done.length === 1) await commit(ctx.env, ctx.society.id, stmts, decision === "approve" ? "record.approved" : "record.sent_back", actor, { unit: pubUnit(done[0]!.unit), rev: done[0]!.revision }, ctx.now);
  else await commit(ctx.env, ctx.society.id, stmts, decision === "approve" ? "records.approved" : "records.sent_back", actor, { count: done.length, batch: batch! }, ctx.now);
  if (decision === "send_back") for (const v of done.slice(0, 10)) await mailNote(ctx.env, v.email, `A small fix is needed in your voter record (${ctx.society.name})`, `The list team of ${ctx.society.name} has a note for you:\n\n"${reason}"\n\nPlease open the voter list link, fix it and press Confirm and send. Your earlier details stay safe until then.\n\nTownhall Records`, ctx.now);
  return { applied: done.length, skipped, batch };
}

// ------------------------------------------------------------------------------------------------------------------ corrections, adding, removing
export interface StaffPatch { unit?: string; name?: string; capacity?: string; mobile?: string; proxyFor?: string; weight?: string | number | null; canAttend?: boolean; canVote?: boolean; notAllowedReason?: string; notAllowedNote?: string; duesPaidOn?: string | null }
/** A person stays "not allowed" while the Organizer has not authorized them (is_voter 0) or "can vote" is switched off. */
const blocked = (isVoter: number | null, canVote: number) => isVoter === 0 || canVote === 0;
const NO_REASON = { no_vote_reason: null, no_vote_note: null, no_vote_by: null } as const;

export async function staffEdit(ctx: StaffCtx, id: string, input: StaffPatch, rawReason: string) {
  need(ctx, "editRecords"); frozenCheck(ctx);
  const reason = squeeze(rawReason); if (reason.length < 3) throw new HttpError(400, "Please write why the correction is made, in a few words.", "reason");
  noContactDetails(reason, "the reason");
  const v = await staffVoter(ctx, id); if (v.status === "removed") throw new HttpError(404, "Not found.", "not_found");
  if (v.email === ctx.email) throw new HttpError(403, "You cannot change your own record. Please ask another host or the Organizer.", "own_record");
  const patch: Patch = {}; const fields: string[] = [];
  const ownedTouched = ["unit", "name", "capacity", "mobile", "proxyFor"].some((k) => (input as Record<string, unknown>)[k] !== undefined);
  if (ownedTouched) {
    const { unit, unitKey: uk, owned } = checkOwned(ctx.society, input, v);
    if (uk !== v.unit_key && v.is_voter !== null && ctx.role !== "organizer") throw new HttpError(403, "The Organizer has chosen whether this person may vote in this flat, so only the Organizer can move them to another flat.", "forbidden");
    if (unit !== v.unit) { patch.unit = unit; patch.unit_key = uk; if (uk !== v.unit_key && v.is_voter !== null) { patch.is_voter = null; Object.assign(patch, v.can_vote !== 0 ? NO_REASON : {}); fields.push("authorization"); } fields.push("unit"); }
    if (owned.name !== v.name) { patch.name = owned.name; fields.push("name"); }
    if (owned.mobile !== v.mobile) { patch.mobile = owned.mobile; fields.push("mobile"); }
    if (owned.capacity !== v.capacity) { patch.capacity = owned.capacity; fields.push("capacity"); }
    if (owned.proxyFor !== v.proxy_for) { patch.proxy_for = owned.proxyFor; fields.push("proxyFor"); }
  }
  if (input.weight !== undefined) {
    if (ctx.society.weight_mode !== "unequal") throw new HttpError(409, "Vote weight is equal for every flat on this list. Choose unequal weight in Step 1 first.", "equal_weights");
    const w = input.weight === null || input.weight === "" ? null : parseWeight(String(input.weight));
    if (w === undefined) throw new HttpError(400, "Weight should be a positive number such as 1 or 2.5.");
    if (w !== v.weight_milli) { patch.weight_milli = w; fields.push("weight"); }
  }
  if (input.canAttend !== undefined && Number(!!input.canAttend) !== v.can_attend) { patch.can_attend = input.canAttend ? 1 : 0; fields.push("canAttend"); }
  // "not allowed to vote" always carries a reason; a reason the Organizer gave can only be changed by the Organizer
  const voteTouched = input.canVote !== undefined || input.notAllowedReason !== undefined || input.notAllowedNote !== undefined;
  let noVoteAudit: Record<string, string | null> | undefined;
  if (voteTouched) {
    const newCan = input.canVote === undefined ? v.can_vote : input.canVote ? 1 : 0;
    const nowBlocked = blocked(v.is_voter, newCan);
    const by = ctx.role === "organizer" ? "organizer" : "host";
    if (newCan === 0) {
      const asked = input.notAllowedReason !== undefined || v.can_vote !== 0 || !v.no_vote_reason;
      if (asked) {
        const r = chooseReason(input.notAllowedReason, input.notAllowedNote); if (typeof r === "string") throw new HttpError(400, r, "reason_code");
        if (r.code !== v.no_vote_reason || r.note !== (v.no_vote_note ?? "") || v.can_vote !== 0) {
          if (v.no_vote_by === "organizer" && ctx.role !== "organizer") throw new HttpError(403, "The Organizer gave the reason this person may not vote, so only the Organizer can change it.", "forbidden");
          Object.assign(patch, { no_vote_reason: r.code, no_vote_note: r.note || null, no_vote_by: by }); fields.push("reason");
          noVoteAudit = { reason: r.code, by };
        }
      }
      if (v.can_vote !== 0) { patch.can_vote = 0; fields.push("canVote"); }
    } else if (input.canVote !== undefined && v.can_vote === 0) {
      if (v.no_vote_by === "organizer" && ctx.role !== "organizer") throw new HttpError(403, "The Organizer gave the reason this person may not vote, so only the Organizer can change it.", "forbidden");
      patch.can_vote = 1; fields.push("canVote");
      if (!nowBlocked) { Object.assign(patch, NO_REASON); fields.push("reason"); noVoteAudit = { reason: null, by }; }
    } else if (nowBlocked && input.canVote === undefined && input.notAllowedReason !== undefined) { // the person is "not allowed" by the Organizer's authorization choice: only the reason is changed
      const r = chooseReason(input.notAllowedReason, input.notAllowedNote); if (typeof r === "string") throw new HttpError(400, r, "reason_code");
      if (r.code !== v.no_vote_reason || r.note !== (v.no_vote_note ?? "")) {
        if (v.no_vote_by === "organizer" && ctx.role !== "organizer") throw new HttpError(403, "The Organizer gave the reason this person may not vote, so only the Organizer can change it.", "forbidden");
        Object.assign(patch, { no_vote_reason: r.code, no_vote_note: r.note || null, no_vote_by: by }); fields.push("reason"); noVoteAudit = { reason: r.code, by };
      }
    } else if (input.notAllowedReason !== undefined && !nowBlocked) throw new HttpError(400, "This person is allowed to vote, so there is no reason to give.", "reason_code");
  }
  if (input.duesPaidOn !== undefined) { const d = input.duesPaidOn ? parseDate(String(input.duesPaidOn)) : null; if (input.duesPaidOn && !d) throw new HttpError(400, "Please give the date as 15/11/2026."); if (d !== v.dues_paid_on) { patch.dues_paid_on = d; fields.push("dues"); } }
  if (!fields.length) return { id, changed: [] as string[] };
  const m = mutation(ctx.env, ctx.now, v, patch, { kind: "corrected", actorEmail: ctx.email, actorRole: actorRole(ctx), reason });
  try { await commit(ctx.env, ctx.society.id, m.stmts, "record.corrected", await staffActor(ctx.env, ctx.email, ctx.role), { unit: pubUnit(patch.unit ?? v.unit), fields, ...(noVoteAudit ? { notAllowed: noVoteAudit } : {}) }, ctx.now); }
  catch (e) { if (/UNIQUE/i.test(String((e as Error)?.message))) throw new HttpError(409, "That voter already has a record for that home.", "exists"); throw e; }
  return { id, changed: fields };
}

export async function addRecord(ctx: StaffCtx, input: StaffPatch & { email?: string; agreed?: boolean }) {
  need(ctx, "editRecords"); frozenCheck(ctx); closedCheck(ctx);
  if (input.agreed !== true) throw new HttpError(400, "Please tick the box to say this person has agreed to be on the voter list. They will also see their record when they sign in.", "need_agreed");
  if (String(input.email ?? "").trim().toLowerCase() === ctx.email) throw new HttpError(403, "You cannot add or approve your own record. Please ask another host or the Organizer.", "own_record");
  const em = cleanEmail(String(input.email ?? "")); if (!em.ok) throw new HttpError(400, "Please type the voter's e-mail ID. It is how they will see their record.");
  const { unit, unitKey: uk, owned } = checkOwned(ctx.society, input);
  const ex = await ctx.env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND unit_key = ? AND email = ?").bind(ctx.society.id, uk, em.value).first<VoterRow>();
  if (ex && ex.status !== "removed") throw new HttpError(409, "That voter already has a record for this home.", "exists");
  const a = { status: "approved" as const, decided_by: ctx.email, decided_at: ctx.now, confirmed_at: ctx.now, submitted_at: ctx.now };
  let stmts: D1Stmt[]; let id: string;
  if (ex) { id = ex.id; stmts = mutation(ctx.env, ctx.now, ex, { unit, unit_key: uk, name: owned.name, capacity: owned.capacity, mobile: owned.mobile, proxy_for: owned.proxyFor, reason: "", approved_json: null, ...a }, { kind: "added", actorEmail: ctx.email, actorRole: actorRole(ctx) }).stmts; }
  else {
    id = uid("vtr");
    const row = { unit, unit_key: uk, name: owned.name, capacity: owned.capacity, mobile: owned.mobile, proxy_for: owned.proxyFor, is_voter: null, weight_milli: null, can_attend: 1, can_vote: 1, dues_paid_on: null, reason: "", approved_json: null, ...a } as Pick<VoterRow, (typeof MUT)[number]>;
    stmts = [
      ctx.env.DB.prepare("INSERT INTO voters (id, society_id, unit, unit_key, name, capacity, mobile, email, proxy_for, status, source, revision, confirmed_at, submitted_at, decided_by, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'host', 1, ?, ?, ?, ?, ?, ?)").bind(id, ctx.society.id, unit, uk, owned.name, owned.capacity, owned.mobile, em.value, owned.proxyFor, ctx.now, ctx.now, ctx.email, ctx.now, ctx.now, ctx.now),
      ctx.env.DB.prepare("INSERT INTO voter_events (society_id, voter_id, ts, actor_email, actor_role, kind, to_status, after_json, after_rev) VALUES (?, ?, ?, ?, ?, 'added', 'approved', ?, 1)").bind(ctx.society.id, id, ctx.now, ctx.email, actorRole(ctx), snapshot(row)),
    ];
  }
  try { await commit(ctx.env, ctx.society.id, stmts, "record.added", await staffActor(ctx.env, ctx.email, ctx.role), { unit: pubUnit(unit), capacity: owned.capacity ?? "", agreedByStaffWord: 1 }, ctx.now); }
  catch (e) { if (/UNIQUE/i.test(String((e as Error)?.message))) throw new HttpError(409, "That voter already has a record for this home.", "exists"); throw e; }
  return { id };
}

export async function removeRecords(ctx: StaffCtx, ids: string[], rawReason: string) {
  need(ctx, "editRecords"); frozenCheck(ctx);
  const reason = squeeze(rawReason); if (reason.length < 3) throw new HttpError(400, "Please write why, in a few words.", "reason");
  noContactDetails(reason, "the reason");
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BULK) throw new HttpError(400, `Please choose 1 to ${MAX_BULK} records.`);
  const rows = (await ctx.env.DB.prepare(`SELECT * FROM voters WHERE society_id = ? AND status <> 'removed' AND id IN (${ph(ids.length)})`).bind(ctx.society.id, ...ids.map(String)).all<VoterRow>()).results;
  if (!rows.length) throw new HttpError(404, "Not found.", "not_found");
  const batch = rows.length > 1 ? uid("bat") : null; const stmts: D1Stmt[] = [];
  for (const v of rows) stmts.push(...mutation(ctx.env, ctx.now, v, { status: "removed" }, { kind: "removed", actorEmail: ctx.email, actorRole: actorRole(ctx), reason, batch }).stmts);
  await commit(ctx.env, ctx.society.id, stmts, "records.removed", await staffActor(ctx.env, ctx.email, ctx.role), { count: rows.length, ...(rows.length === 1 ? { unit: pubUnit(rows[0]!.unit) } : {}) }, ctx.now);
  return { removed: rows.length, batch };
}

// ------------------------------------------------------------------------------------------------------------------ bringing in an existing list
/** The reason columns of an uploaded row: kept only when the person is really marked not allowed (a Host's upload cannot mark authorization, so only "allowed to vote: No" counts there). */
function reasonCols(r: { canVote: boolean; noVoteReason?: string | null; noVoteNote?: string | null }, role: string, isVoter: boolean | null): [string | null, string | null, string | null] {
  const blockedRow = isVoter === false || !r.canVote;
  // a "no" always says who gave it, even when the sheet gave no reason (that is flagged for fixing); so a Host cannot undo or overwrite the Organizer's "no"
  return blockedRow ? [r.noVoteReason ?? null, r.noVoteNote ?? null, role === "organizer" ? "organizer" : "host"] : [null, null, null];
}

export interface ImportInput { filename?: string; format: "csv" | "xlsx" | "paste"; text?: string; base64?: string; dryRun?: boolean }

/** An uploaded list creates INVITED records: the voter signs in, finds their details ready, checks them and confirms. Nothing is on the public list until the team approves it. */
export async function importRecords(ctx: StaffCtx, input: ImportInput) {
  need(ctx, "import"); frozenCheck(ctx); closedCheck(ctx);
  if (!["csv", "xlsx", "paste"].includes(input.format)) throw new HttpError(400, "Choose a CSV file, an Excel file or paste the list.");
  await rateLimit(ctx.env, `import:${ctx.society.id}`, 20, 3_600_000, ctx.now);
  let parsed;
  try { parsed = await parseUpload({ format: input.format, text: input.text, bytes: input.base64 ? fromB64url(input.base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) : undefined }, { country: ctx.society.country, ruleCode: ctx.society.rule_code }); }
  catch (e) { throw new HttpError(400, (e as Error).message || "That file could not be read."); }
  const allowed = new Set<string>(allowedCapacities(ctx.society));
  const existing = new Set((await ctx.env.DB.prepare("SELECT unit_key || '|' || lower(email) AS k FROM voters WHERE society_id = ?").bind(ctx.society.id).all<{ k: string }>()).results.map((r) => r.k));
  const total = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE society_id = ? AND status <> 'removed'").bind(ctx.society.id).first<{ n: number }>())?.n ?? 0;
  const add: Array<{ r: (typeof parsed.rows)[number]; email: string }> = []; const skipped = { duplicate: 0, noEmail: 0, noUnit: 0, notAllowed: 0, noName: 0, badUnit: 0 }; const seen = new Set<string>();
  for (const r of parsed.rows) {
    if (!r.unitKey) { skipped.noUnit++; continue; }
    if (looksPrivate(r.unit) || r.unit.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 \-\/.,#()]*$/.test(r.unit) || (r.unit.match(/[A-Za-z]{3,}/g) ?? []).length > 2) { skipped.badUnit++; continue; } // a phone number, e-mail ID or odd text in the Flat column (a shifted sheet): never brought in
    const em = cleanEmail(r.email); if (!em.ok) { skipped.noEmail++; continue; }
    if (!r.name.trim()) { skipped.noName++; continue; }
    if (r.capacity && !allowed.has(r.capacity)) { skipped.notAllowed++; continue; }
    const k = r.unitKey + "|" + em.value; if (existing.has(k) || seen.has(k)) { skipped.duplicate++; continue; }
    seen.add(k); add.push({ r, email: em.value });
  }
  if (total + add.length > 6000) throw new HttpError(400, "A list can hold up to 6000 records.");
  const full = seesFull(ctx);
  const report = { read: parsed.rowsRead, willAdd: add.length, skipped, mends: ctx.role === "organizer" ? parsed.mends : parsed.mends.filter((m) => m.kind !== "voter_single"), problems: parsed.problems.slice(0, 50), unknownColumns: parsed.unknownColumns, mapped: parsed.mapped,
    sample: add.slice(0, 5).map(({ r, email }) => ({ unit: r.unit, name: full ? r.name : maskName(r.name), capacity: r.capacity, email: full ? email : maskEmail(email) })) };
  if (input.dryRun) {
    if (!full) await commit(ctx.env, ctx.society.id, [], "records.import_checked", await staffActor(ctx.env, ctx.email, ctx.role), { rows: parsed.rowsRead }, ctx.now); // a Host's check of a sheet is noted, counts only
    return { dryRun: true, ...report };
  }
  if (!add.length) throw new HttpError(409, "There is nothing new to bring in: every line is already on the list or could not be used.", "nothing_new");
  const flatsWithPeople = new Set((await ctx.env.DB.prepare("SELECT DISTINCT unit_key FROM voters WHERE society_id = ? AND status <> 'removed'").bind(ctx.society.id).all<{ unit_key: string }>()).results.map((r) => r.unit_key));
  const batch = uid("imp"); const stmts: D1Stmt[] = []; const reasonCounts: Record<string, number> = {};
  for (let i = 0; i < add.length; i += 250) {
    const chunk = add.slice(i, i + 250);
    const rows = chunk.map(({ r, email }) => {
      const writable = ctx.role === "organizer" && (parsed.mapped as string[]).includes("voter") && !(autoMarked.has(r) && flatsWithPeople.has(r.unitKey));
      const iv = writable ? r.isVoter : null;
      const canVote = r.canVote && !(r.noVoteReason && iv !== false); // a reason written next to a person who is not marked "No" still means "not allowed"
      const rc = reasonCols({ canVote, noVoteReason: r.noVoteReason, noVoteNote: r.noVoteNote }, ctx.role, iv); if (rc[0]) reasonCounts[rc[0]] = (reasonCounts[rc[0]] ?? 0) + 1;
      return [uid("vtr"), r.unit, r.unitKey, r.name, r.capacity, r.mobile, email, writable ? (iv === null ? null : iv ? 1 : 0) : null, r.weightMilli, r.canAttend ? 1 : 0, canVote ? 1 : 0, r.duesPaidOn, ...rc];
    });
    stmts.push(ctx.env.DB.prepare(`INSERT INTO voters (id, society_id, unit, unit_key, name, capacity, mobile, email, proxy_for, is_voter, weight_milli, can_attend, can_vote, dues_paid_on, no_vote_reason, no_vote_note, no_vote_by, status, source, revision, created_at, updated_at)
      SELECT json_extract(j.value,'$[0]'), ?, json_extract(j.value,'$[1]'), json_extract(j.value,'$[2]'), json_extract(j.value,'$[3]'), json_extract(j.value,'$[4]'), json_extract(j.value,'$[5]'), json_extract(j.value,'$[6]'), '', json_extract(j.value,'$[7]'), json_extract(j.value,'$[8]'), json_extract(j.value,'$[9]'), json_extract(j.value,'$[10]'), json_extract(j.value,'$[11]'), json_extract(j.value,'$[12]'), json_extract(j.value,'$[13]'), json_extract(j.value,'$[14]'), 'invited', 'upload', 1, ?, ? FROM json_each(?) j ORDER BY j.key`)
      .bind(ctx.society.id, ctx.now, ctx.now, JSON.stringify(rows)));
    stmts.push(ctx.env.DB.prepare(`INSERT INTO voter_events (society_id, voter_id, ts, actor_email, actor_role, kind, to_status, after_rev, batch, after_json)
      SELECT ?, json_extract(j.value,'$[0]'), ?, ?, ?, 'imported', 'invited', 1, ?, json_object('is_voter', json_extract(j.value,'$[7]'), 'can_vote', json_extract(j.value,'$[10]'), 'no_vote_reason', json_extract(j.value,'$[12]'), 'no_vote_note', json_extract(j.value,'$[13]'), 'no_vote_by', json_extract(j.value,'$[14]')) FROM json_each(?) j`).bind(ctx.society.id, ctx.now, ctx.email, actorRole(ctx), batch, JSON.stringify(rows)));
  }
  await commit(ctx.env, ctx.society.id, stmts, "records.imported", await staffActor(ctx.env, ctx.email, ctx.role), { count: add.length, batch, skipped: Object.values(skipped).reduce((a, b) => a + b, 0), format: input.format, ...(Object.keys(reasonCounts).length ? { reasons: reasonCounts } : {}) }, ctx.now);
  return { dryRun: false, batch, added: add.length, ...report };
}

// ------------------------------------------------------------------------------------------------------------------ who votes for a flat, and vote weights
/** The Organizer decides, person by person, who is authorized to vote for a flat. Any number of people in one flat may be authorized; the others in the flat are left exactly as they were. */
export async function chooseVoter(ctx: StaffCtx, rawUnit: string, voterId: string, authorized = true, rawReason?: unknown, rawNote?: unknown) {
  need(ctx, "authorize"); frozenCheck(ctx); // it is the Organizer's decision
  const why = authorized ? null : chooseReason(rawReason, rawNote); // never a silent "no": the Organizer must give a reason
  if (typeof why === "string") throw new HttpError(400, why, "reason_code");
  const uk = unitKey(rawUnit);
  const rows = (await ctx.env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND unit_key = ? AND status <> 'removed'").bind(ctx.society.id, uk).all<VoterRow>()).results.filter((v) => onList(v));
  const chosen = rows.find((v) => v.id === voterId);
  if (!chosen) throw new HttpError(404, "That person is not on the list for this flat.", "not_found");
  const batch = uid("bat"); const stmts: D1Stmt[] = [];
  const want = authorized ? 1 : 0;
  // a lone person (no choice recorded) is authorized by default, so "authorize" changes nothing there
  const same = !!why && chosen.is_voter === 0 && chosen.no_vote_reason === why.code && (chosen.no_vote_note ?? "") === why.note;
  const already = authorized ? chosen.is_voter === 1 || (chosen.is_voter === null && rows.length === 1) : same;
  const patch: Patch = why ? { is_voter: want, no_vote_reason: why.code, no_vote_note: why.note || null, no_vote_by: "organizer" } : { is_voter: want, ...(chosen.can_vote !== 0 ? NO_REASON : {}) };
  if (!already) stmts.push(...mutation(ctx.env, ctx.now, chosen, patch, { kind: "voter_chosen", actorEmail: ctx.email, actorRole: actorRole(ctx), batch }).stmts);
  if (!stmts.length) return { changed: 0 };
  await commit(ctx.env, ctx.society.id, stmts, authorized ? "unit.voter_authorized" : "unit.voter_unauthorized", await staffActor(ctx.env, ctx.email, ctx.role), { unit: pubUnit(chosen.unit), batch, ...(why ? { reason: why.code, by: "organizer" } : {}) }, ctx.now);
  return { changed: stmts.length / 3, batch };
}

export async function setWeights(ctx: StaffCtx, items: Array<{ unit: string; weight: string | number }>) {
  need(ctx, "weights"); frozenCheck(ctx);
  if (ctx.society.weight_mode !== "unequal") throw new HttpError(409, "Vote weight is equal for every flat on this list. Choose unequal weight in Step 1 first.", "equal_weights");
  if (!Array.isArray(items) || !items.length || items.length > MAX_BULK) throw new HttpError(400, `Please give 1 to ${MAX_BULK} flats at a time.`);
  if (items.some((it) => !it || typeof it !== "object" || typeof it.unit !== "string" || !it.unit.trim())) throw new HttpError(400, "Each line needs a flat and a weight.");
  const batch = uid("bat"); const stmts: D1Stmt[] = []; let n = 0;
  const keys = [...new Set(items.map((it) => unitKey(String(it.unit))))];
  const all = (await ctx.env.DB.prepare(`SELECT * FROM voters WHERE society_id = ? AND status <> 'removed' AND unit_key IN (${ph(keys.length)})`).bind(ctx.society.id, ...keys).all<VoterRow>()).results; // one read for every flat
  const seen = new Set<string>();
  for (const it of items) {
    const w = parseWeight(String(it.weight)); if (!w) throw new HttpError(400, "Weight should be a positive number such as 1 or 2.5.");
    const uk = unitKey(String(it.unit)); if (seen.has(uk)) throw new HttpError(400, "A flat appears twice in this list. Please give each flat once."); seen.add(uk);
    const rows = all.filter((v) => v.unit_key === unitKey(String(it.unit)));
    for (const v of rows) if (v.weight_milli !== w) { stmts.push(...mutation(ctx.env, ctx.now, v, { weight_milli: w }, { kind: "weight", actorEmail: ctx.email, actorRole: actorRole(ctx), batch }).stmts); n++; }
  }
  if (!n) return { changed: 0 };
  await commit(ctx.env, ctx.society.id, stmts, "records.weighted", await staffActor(ctx.env, ctx.email, ctx.role), { count: n, batch }, ctx.now);
  return { changed: n, batch };
}

// ------------------------------------------------------------------------------------------------------------------ Undo
/** An action that moved somebody's authorization mark or the reason the Organizer gave: only the Organizer may undo it. */
function touchesMark(e: { before_json: string | null; after_json: string | null }): boolean {
  const b = e.before_json ? (JSON.parse(e.before_json) as Record<string, unknown>) : null, a = e.after_json ? (JSON.parse(e.after_json) as Record<string, unknown>) : null;
  const diff = (k: string) => (b?.[k] ?? null) !== (a?.[k] ?? null);
  return diff("is_voter") || ((b?.no_vote_by === "organizer" || a?.no_vote_by === "organizer") && (diff("no_vote_reason") || diff("no_vote_note") || diff("no_vote_by") || diff("can_vote")));
}
/** The people, among those an action created, who now carry the Organizer's mark or reason: a Host may not undo the action that made them. */
async function markedNow(ctx: StaffCtx, es: Array<{ voter_id: string; before_json: string | null }>): Promise<Set<string>> {
  const ids = [...new Set(es.filter((e) => e.before_json === null).map((e) => e.voter_id))];
  if (ctx.role === "organizer" || !ids.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const rs = await ctx.env.DB.prepare(`SELECT id FROM voters WHERE society_id = ? AND id IN (${ph(part.length)}) AND (is_voter IS NOT NULL OR no_vote_by = 'organizer')`).bind(ctx.society.id, ...part).all<{ id: string }>();
    for (const r of rs.results) out.add(r.id);
  }
  return out;
}
/** For the signed trail: which reasons an undo cleared and which it brought back (codes and counts, never words). */
function reasonChanges(es: Array<{ before_json: string | null; after_json: string | null }>): Record<string, Record<string, number>> {
  const restored: Record<string, number> = {}, cleared: Record<string, number> = {};
  for (const e of es) {
    const b = e.before_json ? (JSON.parse(e.before_json) as Record<string, unknown>) : null, a = e.after_json ? (JSON.parse(e.after_json) as Record<string, unknown>) : null;
    const rb = (b?.no_vote_reason ?? null) as string | null, ra = (a?.no_vote_reason ?? null) as string | null;
    if (rb !== ra) { if (rb) restored[rb] = (restored[rb] ?? 0) + 1; if (ra) cleared[ra] = (cleared[ra] ?? 0) + 1; }
  }
  return { ...(Object.keys(restored).length ? { reasonsRestored: restored } : {}), ...(Object.keys(cleared).length ? { reasonsCleared: cleared } : {}) };
}
const UNDOABLE = ["approved", "sent_back", "corrected", "added", "imported", "removed", "voter_chosen", "weight"];
interface EvRow { id: number; voter_id: string; ts: number; actor_role: string; kind: string; before_json: string | null; after_json: string | null; after_rev: number | null; batch: string | null; cur_rev: number | null }
const eventsFor = (ctx: StaffCtx, where: string, b: unknown[] = [], limit = 5000) => ctx.env.DB.prepare(`SELECT e.id, e.voter_id, e.ts, e.actor_role, e.kind, e.before_json, e.after_json, e.after_rev, e.batch, (SELECT revision FROM voters v WHERE v.id = e.voter_id AND v.society_id = e.society_id) AS cur_rev FROM voter_events e WHERE e.society_id = ? AND e.undone_by IS NULL AND e.actor_role IN ('organizer','host') AND e.kind IN (${ph(UNDOABLE.length)}) AND ${where} ORDER BY e.id DESC LIMIT ${limit}`).bind(ctx.society.id, ...UNDOABLE, ...b).all<EvRow>();

/** The latest actions that can still be undone, one line per action (a bulk action is one line). */
export async function recentActions(ctx: StaffCtx) {
  need(ctx, "view");
  const rs = (await eventsFor(ctx, "1 = 1", [], 400)).results;
  const groups = new Map<string, EvRow[]>();
  for (const e of rs) { const k = e.batch ?? "e" + e.id; const a = groups.get(k) ?? []; a.push(e); groups.set(k, a); }
  const marked = await markedNow(ctx, rs);
  const out = [];
  for (const [key, es] of groups) {
    out.push({ key, kind: es[0]!.kind, count: es.length, at: es[0]!.ts, by: es[0]!.actor_role === "organizer" ? "Organizer" : "Host", undoable: es.every((e) => e.cur_rev === e.after_rev) && (ctx.role === "organizer" || !es.some((e) => e.kind === "voter_chosen" || touchesMark(e) || (e.before_json === null && marked.has(e.voter_id)))) });
    if (out.length >= 15) break;
  }
  return { actions: out };
}

export async function undo(ctx: StaffCtx, input: { key?: string }) {
  need(ctx, "undo"); frozenCheck(ctx);
  const key = String(input.key ?? ""); if (!key) throw new HttpError(400, "Please choose what to undo.");
  const es = (await (key.startsWith("e") && /^e\d+$/.test(key) ? eventsFor(ctx, "e.id = ?", [Number(key.slice(1))]) : eventsFor(ctx, "e.batch = ?", [key]))).results;
  if (!es.length) throw new HttpError(404, "There is nothing left to undo there.", "not_found");
  const marked = await markedNow(ctx, es);
  if (ctx.role !== "organizer" && es.some((e) => e.kind === "voter_chosen" || touchesMark(e) || (e.before_json === null && marked.has(e.voter_id)))) throw new HttpError(403, "Who may vote is the Organizer's choice, so only the Organizer can take it back.", "forbidden");
  if (es.some((e) => e.cur_rev !== e.after_rev)) throw new HttpError(409, "Something has changed since then (a voter or another host touched these records), so it cannot be undone safely. Nothing was changed.", "changed");
  const db = ctx.env.DB; const stmts: D1Stmt[] = []; const batch = es.length > 1 ? uid("bat") : null;
  for (const e of es) {
    if (e.before_json === null) { // the action created the record (an import, a record added by a host): undoing it takes the record away again
      stmts.push(db.prepare("DELETE FROM voters WHERE society_id = ? AND id = ? AND revision = ?").bind(ctx.society.id, e.voter_id, e.after_rev), guardChanged(ctx.env, "Something changed at the same moment. Nothing was undone."));
      stmts.push(db.prepare("INSERT INTO voter_events (society_id, voter_id, ts, actor_email, actor_role, kind, from_status, to_status, before_json, after_json, batch) VALUES (?, ?, ?, ?, ?, 'undone', 'approved', 'removed', ?, NULL, ?)").bind(ctx.society.id, e.voter_id, ctx.now, ctx.email, actorRole(ctx), e.after_json, batch));
    } else {
      const b = JSON.parse(e.before_json) as Record<string, unknown>;
      const set = [...MUT.map((k) => `${k} = ?`), "revision = revision + 1", "updated_at = ?"].join(", ");
      stmts.push(db.prepare(`UPDATE voters SET ${set} WHERE society_id = ? AND id = ? AND revision = ?`).bind(...MUT.map((k) => b[k] ?? null), ctx.now, ctx.society.id, e.voter_id, e.after_rev), guardChanged(ctx.env, "Something changed at the same moment. Nothing was undone."));
      stmts.push(db.prepare("INSERT INTO voter_events (society_id, voter_id, ts, actor_email, actor_role, kind, from_status, to_status, before_json, after_json, after_rev, batch) VALUES (?, ?, ?, ?, ?, 'undone', ?, ?, ?, ?, ?, ?)")
        .bind(ctx.society.id, e.voter_id, ctx.now, ctx.email, actorRole(ctx), (JSON.parse(e.after_json ?? "{}") as { status?: string }).status ?? null, (b.status as string) ?? null, e.after_json, e.before_json, (e.after_rev ?? 0) + 1, batch));
    }
    stmts.push(db.prepare("UPDATE voter_events SET undone_by = last_insert_rowid() WHERE id = ? AND undone_by IS NULL").bind(e.id), guardChanged(ctx.env, "That was already undone."));
  }
  await commit(ctx.env, ctx.society.id, stmts, es.some((e) => e.kind === "voter_chosen") ? "unit.voter_choice_undone" : "records.undone", await staffActor(ctx.env, ctx.email, ctx.role), { count: es.length, what: es[0]!.kind, ...reasonChanges(es) }, ctx.now);
  return { undone: es.length };
}
