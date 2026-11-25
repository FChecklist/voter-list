// The checks on the list as it stands, and its two publications:
//   DRAFT  = a provisional list anyone can see (masked); it can be published again and again while it changes.
//   FROZEN = the final list at a date-and-time cut-off: immutable (database triggers), fingerprinted, and signed into the audit chain.
// Also the public side (masked list, proof of the signature) and the exports.
import { HttpError, rateLimit } from "./auth";
import { commit, guardChanged, pubUnit, staffActor, auditEntries } from "./audit";
import { runChecks, shortFingerprint, type CheckReport } from "./checks";
import { uid, type D1Stmt, type Env } from "./db";
import { ruleOf, RULES } from "./model";
import { noContactDetails, msToLocal } from "./lists";
import { buildRoll, enrolOpen, need, seesFull, settingsOf, type RollLine, type SocietyRow, type StaffCtx } from "./store";
import { fmtMilli } from "./checks";
import { central } from "./orders";
import { registerCsv, registerPdf, type RegisterLine, type RegisterMeta } from "./register";
import { capLabel, squeeze, unitKey } from "./text";
import { canonical } from "./vendor/canonical";
import { publicKeyFromPrivate, sha256Hex, verifyMessage } from "./vendor/crypto";
import { signingMessage, entryHash } from "./vendor/log";
import { maskEmail, maskName, maskPhone } from "./vendor/masking";

// ------------------------------------------------------------------------------------------------------------------ what the public may see
const w4 = (w: string) => { const c = Array.from(w); return c.slice(0, c.length <= 3 ? 1 : 2).join("") + "****"; };
/** Public masks (the owner's rule, 13 Nov): anyone can read these. Name: two letters of each word then ****. Mobile: only the last 4 digits. E-mail ID: only its last 4 characters, the rest ****. The number of stars never depends on the real length. */
export const pubName = (n: string) => n.trim().split(/\s+/).filter(Boolean).slice(0, 4).map(w4).join(" ") || "****";
export const pubMobile = (m: string) => { const d = m.replace(/\D/g, ""); return d.length < 6 ? "******" : "******" + d.slice(-4); };
export const pubEmail = (e: string) => { const c = Array.from(e.trim()); return c.length < 6 || !e.includes("@") ? "********" : "********" + c.slice(-4).join(""); };

// ------------------------------------------------------------------------------------------------------------------ the checks
export interface Snap { unit: string; unitKey: string; name: string; capacity: string; mobile: string; email: string; proxyFor: string; isVoter: boolean; weightMilli: number; canAttend: boolean; canVote: boolean; reasonPublic: string; reasonFull: string }

/** The list's own state: who is on it now, the report of the checks, and the one line per person a publication would hold. */
export async function rollReport(env: Env, society: SocietyRow, maskNames = false) {
  const roll = await buildRoll(env, society.id);
  const rows = maskNames ? roll.rows.map((r) => ({ ...r, name: r.name ? maskName(r.name) : "" })) : roll.rows;
  const report = runChecks(rows, settingsOf(society));
  const proxy = new Map(roll.lines.map((l) => [l.row.id, l]));
  const snaps: Snap[] = [];
  for (const u of report.units) {
    const auth = new Map(u.voters.map((p) => [p.row.id, p]));
    const why = new Map(u.status.map((x) => [x.rowId, x]));
    const rs = [...u.rows].sort((a, b) => Number(auth.has(b.id)) - Number(auth.has(a.id)) || a.rowNo - b.rowNo);
    for (const r of rs) {
      const p = auth.get(r.id), isVoter = !!p;
      snaps.push({ unit: pubUnit(u.unit), unitKey: u.unitKey, name: roll.rows[r.id - 1]!.name, capacity: r.capacity ?? "", mobile: roll.rows[r.id - 1]!.mobile, email: r.email, proxyFor: proxy.get(r.id)?.proxyFor ?? "", isVoter, weightMilli: isVoter ? u.weightMilli : 0, canAttend: !!p && p.canAttend, canVote: !!p && p.canVote, reasonPublic: why.get(r.id)?.publicReason ?? "", reasonFull: why.get(r.id)?.reason ?? "" });
    }
  }
  return { roll, report, snaps };
}

export async function checksView(ctx: StaffCtx, find = "") {
  need(ctx, "view");
  const full = seesFull(ctx);
  const { roll, report } = await rollReport(ctx.env, ctx.society, !full);
  const lineOf = (rowId: number): RollLine | undefined => roll.lines[rowId - 1];
  // Every flat with more than one registered person: all of them, and which are authorized to vote. The Organizer decides; a Host sees the same, masked.
  const FLATS_SHOWN = 400;
  const ineligible = new Set(report.issues.filter((i) => i.code === "E_VOTER_INELIGIBLE").map((i) => i.unit));
  // every flat that needs a decision: more than one person, or a lone person who is not authorized, or whose role the rule does not allow
  const multi = report.units.filter((u) => u.rows.length > 1 || u.voters.length === 0 || ineligible.has(u.unit) || u.status.some((x) => x.missing));
  if (multi.length > FLATS_SHOWN) multi.sort((a, b) => Number(!a.rows.every((r) => r.isVoter === null)) - Number(!b.rows.every((r) => r.isVoter === null)) || Number(a.voters.length > 0) - Number(b.voters.length > 0)); // only when not every flat fits: those still waiting for a choice come first (otherwise the order stays put while the Organizer works)
  const flatOf = (u: (typeof report.units)[number]) => ({
    unit: u.unit,
    people: u.rows.map((r) => lineOf(r.id)).filter(Boolean).map((l) => ({ voterId: l!.voterId, name: full ? l!.row.name : maskName(l!.row.name), capacity: capLabel(l!.row.capacity ?? ""), authorized: u.voters.some((p) => p.row.id === l!.row.id), reason: u.status.find((x) => x.rowId === l!.row.id)?.reason ?? "", reasonCode: l!.row.noVoteReason ?? "", reasonNote: l!.row.noVoteNote ?? "", reasonMissing: !!u.status.find((x) => x.rowId === l!.row.id)?.missing })),
  });
  const flats = multi.slice(0, FLATS_SHOWN).map(flatOf);
  // a look-up of any flat (also a lone person who is authorized by default), so the Organizer can always say yes or no
  const fk = unitKey(find.slice(0, 40));
  const lookup = fk ? report.units.filter((u) => u.unitKey.includes(fk)).slice(0, 10).map(flatOf) : [];
  // many flats with nobody authorized would crowd out the other warnings, so beyond a few they become one line
  const noOne = report.issues.filter((i) => i.code === "W_NO_VOTER"), others = report.issues.filter((i) => i.code !== "W_NO_VOTER");
  const noOneAll = report.byCode["W_NO_VOTER"] ?? 0; // the report keeps only the first few hundred lines of one kind, but counts them all
  const issues = (noOneAll > 10 ? [...others.slice(0, 89), ...noOne.slice(0, 10), { code: "W_NO_VOTER", severity: "warning" as const, unit: "", message: `${noOneAll - 10} more flats have nobody authorized to vote yet (the first ten are listed above).`, hint: "Authorize people in the flats table below, or leave them if nobody from those flats should vote." }] : report.issues).slice(0, 100);
  const wl = ctx.society.weight_mode === "unequal" ? report.units.slice(0, 500).map((u) => ({ unit: u.unit, weightMilli: u.weightMilli })) : [];
  return {
    summary: report.summary, errors: report.errors, warnings: report.warnings, canFreeze: report.errors === 0 && roll.rows.length > 0, onList: roll.rows.length, notIncluded: roll.notIncluded,
    issues: issues.map((i) => ({ code: i.code, severity: i.severity, unit: i.unit, message: i.message, hint: i.hint ?? "" })), flats, lookup, flatsMore: Math.max(0, multi.length - FLATS_SHOWN), weights: wl,
  };
}

// ------------------------------------------------------------------------------------------------------------------ publications
export interface PubRow { id: string; society_id: string; kind: "draft" | "frozen"; seq: number; event_name: string; event_type: string; cutoff_at: number | null; rule_code: number; weight_mode: string; dues_enabled: number; dues_cutoff: string | null; units: number; people: number; voters: number; total_weight_milli: number; not_included: number; fingerprint: string; audit_seq: number; published_by: string; published_at: number }

async function pubFingerprint(kind: string, cutoffAt: number | null, event: string, s: SocietyRow, snaps: Snap[]): Promise<string> {
  const body = snaps.map((r) => [r.unit, r.name, r.capacity, r.mobile, r.email, r.proxyFor, r.isVoter ? 1 : 0, r.weightMilli, r.canAttend ? 1 : 0, r.canVote ? 1 : 0]);
  return sha256Hex("voter-list/publication/v2\n" + canonical({ kind, cutoff: cutoffAt ?? 0, event, rule: s.rule_code, weights: s.weight_mode, dues: s.dues_enabled ? s.dues_cutoff ?? "" : "", rows: body as never }));
}

function pubStatements(env: Env, society: SocietyRow, id: string, kind: "draft" | "frozen", meta: { eventName: string; eventType: string; cutoffAt: number | null; fp: string; by: string; now: number; notIncluded: number }, snaps: Snap[], report: CheckReport): D1Stmt[] {
  const db = env.DB, sid = society.id;
  const stmts: D1Stmt[] = [db.prepare(`INSERT INTO publications (id, society_id, kind, seq, event_name, event_type, cutoff_at, rule_code, weight_mode, dues_enabled, dues_cutoff, units, people, voters, total_weight_milli, not_included, fingerprint, audit_seq, published_by, published_at)
    VALUES (?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM publications WHERE society_id = ? AND kind = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM audit_entries WHERE society_id = ?), ?, ?)`)
    .bind(id, sid, kind, sid, kind, meta.eventName, meta.eventType, meta.cutoffAt, society.rule_code, society.weight_mode, society.dues_enabled, society.dues_enabled ? society.dues_cutoff : null, report.summary.units, snaps.length, report.summary.canVote, report.summary.totalWeightMilli, meta.notIncluded, meta.fp, sid, meta.by, meta.now)];
  for (let i = 0; i < snaps.length; i += 400) {
    const chunk = snaps.slice(i, i + 400).map((r, k) => [i + k + 1, r.unit, r.unitKey, r.name, r.capacity, r.mobile, r.email, r.proxyFor, r.isVoter ? 1 : 0, r.weightMilli, r.canAttend ? 1 : 0, r.canVote ? 1 : 0, r.reasonPublic, r.reasonFull]);
    stmts.push(db.prepare(`INSERT INTO publication_rows (society_id, publication_id, seq, unit, unit_key, name, capacity, mobile, email, proxy_for, is_voter, weight_milli, can_attend, can_vote, reason_public, reason_full)
      SELECT ?, ?, json_extract(j.value,'$[0]'), json_extract(j.value,'$[1]'), json_extract(j.value,'$[2]'), json_extract(j.value,'$[3]'), json_extract(j.value,'$[4]'), json_extract(j.value,'$[5]'), json_extract(j.value,'$[6]'), json_extract(j.value,'$[7]'), json_extract(j.value,'$[8]'), json_extract(j.value,'$[9]'), json_extract(j.value,'$[10]'), json_extract(j.value,'$[11]'), json_extract(j.value,'$[12]'), json_extract(j.value,'$[13]') FROM json_each(?) j ORDER BY j.key`).bind(sid, id, JSON.stringify(chunk)));
  }
  return stmts;
}

const pubView = (p: PubRow, tz: number) => ({
  id: p.id, kind: p.kind, seq: p.seq, event: p.event_name, eventType: p.event_type, cutoffAt: p.cutoff_at, cutoffLocal: p.cutoff_at ? msToLocal(p.cutoff_at, tz) : null, units: p.units, people: p.people, voters: p.voters,
  totalWeightMilli: p.total_weight_milli, notIncluded: p.not_included, fingerprint: p.fingerprint, fingerprintShort: shortFingerprint(p.fingerprint), publishedAt: p.published_at, auditSeq: p.audit_seq,
});

/** Publish the list as it stands now as a provisional DRAFT. It can be published again later; each time replaces what the public sees. */
export async function publishDraft(ctx: StaffCtx) {
  need(ctx, "publishDraft");
  const { env, society } = ctx;
  await rateLimit(env, `draft:${society.id}`, 12, 3_600_000, ctx.now); // each press writes every line again; the free database has a daily write allowance
  if (society.phase !== "open") throw new HttpError(409, "The list is already frozen. Its final version is the one people see.", "frozen");
  const { roll, report, snaps } = await rollReport(env, society);
  if (!snaps.length) throw new HttpError(409, "No one is on the list yet. Approve at least one record first.", "empty");
  const id = uid("pub");
  const fp = await pubFingerprint("draft", null, "", society, snaps);
  const stmts = pubStatements(env, society, id, "draft", { eventName: "", eventType: "", cutoffAt: null, fp, by: ctx.email, now: ctx.now, notIncluded: roll.notIncluded }, snaps, report);
  stmts.push(env.DB.prepare("DELETE FROM publication_rows WHERE society_id = ? AND publication_id IN (SELECT id FROM publications WHERE society_id = ? AND kind = 'draft' AND id <> ?)").bind(society.id, society.id, id));
  const seq = await commit(env, society.id, stmts, "publication.draft", await staffActor(env, ctx.email, ctx.role), { pub: id, fingerprint: fp, units: report.summary.units, people: snaps.length, voters: report.summary.canVote, notIncluded: roll.notIncluded, openIssues: report.errors }, ctx.now);
  return { id, auditSeq: seq, fingerprint: fp, fingerprintShort: shortFingerprint(fp), units: report.summary.units, people: snaps.length, openIssues: report.errors, notIncluded: roll.notIncluded };
}

export interface FreezeInput { eventName?: string; eventType?: string; ackWarnings?: boolean; ackPending?: boolean; closeNow?: boolean; confirm?: string }

/** Publish the FINAL list at the cut-off. Immutable, fingerprinted, signed. */
export async function publishFrozen(ctx: StaffCtx, input: FreezeInput) {
  need(ctx, "freeze");
  const { env, society } = ctx;
  if (society.phase !== "open") throw new HttpError(409, "The list is already frozen.", "frozen");
  const eventName = squeeze(input.eventName ?? ""); if (eventName.length < 2 || eventName.length > 120) throw new HttpError(400, "Please name the meeting or election this list is for (2 to 120 letters).", "event");
  noContactDetails(eventName, "the event name");
  const eventType = input.eventType === "election" ? "election" : input.eventType === "meeting" ? "meeting" : ""; if (!eventType) throw new HttpError(400, "Please choose meeting or election.", "event");
  if (String(input.confirm ?? "").trim().toUpperCase() !== "FREEZE") throw new HttpError(400, "Please type FREEZE to confirm. A frozen list can never be changed.", "confirm");
  // the cut-off: the closing time the Organizer set, once it has passed; or "close now"
  let cutoffAt = society.cutoff_at;
  if (cutoffAt === null || cutoffAt > ctx.now) {
    if (!input.closeNow) throw new HttpError(409, cutoffAt === null ? "No closing time is set. Choose one in Step 1, or close enrolment now." : "The closing time has not come yet. Wait for it, or close enrolment now.", "before_cutoff");
    cutoffAt = ctx.now;
  }
  const stamp = async () => (await env.DB.prepare("SELECT COUNT(*) || ':' || IFNULL(SUM(revision), 0) AS s FROM voters WHERE society_id = ?").bind(society.id).first<{ s: string }>())?.s ?? "";
  const seen = await stamp(); // read before the list is built: if any record changes after this, the batch below is refused and nothing is frozen
  const { roll, report, snaps } = await rollReport(env, society);
  if (report.errors > 0) throw new HttpError(409, `The checks still show ${report.errors} thing${report.errors === 1 ? "" : "s"} to fix. Please finish Step 5 first.`, "checks");
  if (report.warnings > 0 && !input.ackWarnings) throw new HttpError(409, `The checks show ${report.warnings} thing${report.warnings === 1 ? "" : "s"} to glance at. Press Yes, freeze anyway if you have looked at them.`, "warnings");
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM voters WHERE society_id = ? AND status IN ('submitted','draft','invited','sent_back')").bind(society.id).first<{ n: number }>();
  const stuck = (pending?.n ?? 0);
  if (stuck > 0 && !input.ackPending) throw new HttpError(409, `${stuck} record${stuck === 1 ? " is" : "s are"} still waiting, with the voter, or not yet confirmed. They will not be on the frozen list (an earlier approved version stays). Press Yes, freeze anyway to go on.`, "pending");
  if (!snaps.length) throw new HttpError(409, "No one is on the list yet.", "empty");
  const gate = await paymentGate(ctx);
  const id = uid("pub");
  const fp = await pubFingerprint("frozen", cutoffAt, eventName.toLowerCase() + "|" + eventType, society, snaps);
  const stmts: D1Stmt[] = [env.DB.prepare("UPDATE societies SET phase = 'frozen', cutoff_at = ? WHERE id = ? AND phase = 'open' AND (SELECT COUNT(*) || ':' || IFNULL(SUM(revision), 0) FROM voters WHERE society_id = ?) = ?").bind(cutoffAt, society.id, society.id, seen), guardChanged(env, "A record changed while the list was being frozen. Nothing was frozen. Please look at Step 5 again and press the button once more.")];
  stmts.push(...pubStatements(env, society, id, "frozen", { eventName, eventType, cutoffAt, fp, by: ctx.email, now: ctx.now, notIncluded: roll.notIncluded + 0 }, snaps, report));
  if (gate) stmts.push(env.DB.prepare("UPDATE orders SET used_for_version = ? WHERE id = ? AND status = 'paid' AND used_for_version IS NULL").bind(id, gate), guardChanged(env, "The payment was used at the same moment."));
  const seq = await commit(env, society.id, stmts, "publication.frozen", await staffActor(env, ctx.email, ctx.role),
    { pub: id, event: eventName.slice(0, 80), eventType, cutoffAt, fingerprint: fp, units: report.summary.units, people: snaps.length, voters: report.summary.canVote, weightMilli: report.summary.totalWeightMilli, notIncluded: roll.notIncluded, pendingAcknowledged: stuck, warningsAcknowledged: report.warnings }, ctx.now);
  return { id, auditSeq: seq, fingerprint: fp, fingerprintShort: shortFingerprint(fp), units: report.summary.units, people: snaps.length, voters: report.summary.canVote, cutoffAt, cutoffLocal: msToLocal(cutoffAt, society.tz_offset_min) };
}

/** Price slot: unset PRICE_INR means free. When the owner sets a price, the FIRST frozen list needs a paid order (live Razorpay payee: IT SERVICES BY RAJAT AGARWAL; not wired here). */
async function paymentGate(ctx: StaffCtx): Promise<string | null> {
  if (!ctx.env.PRICE_INR) return null;
  const first = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM publications WHERE society_id = ? AND kind = 'frozen'").bind(ctx.society.id).first<{ n: number }>())?.n ?? 0;
  if (first > 0) return null;
  // Only an order of the kind this site runs in counts: with the central payment service connected, a leftover test order never opens the gate (and the reverse).
  const o = await ctx.env.DB.prepare("SELECT id FROM orders WHERE society_id = ? AND status = 'paid' AND used_for_version IS NULL AND test = ? LIMIT 1").bind(ctx.society.id, central(ctx.env) ? 0 : 1).first<{ id: string }>();
  if (!o) throw new HttpError(409, "The first frozen list needs its small fee to be paid first. Nothing has been charged.", "payment_required");
  return o.id;
}

/** Open the list again for a new round (a changed list, a new meeting). The earlier frozen lists stay exactly as they were. */
export async function reopen(ctx: StaffCtx, input: { reason?: string; confirm?: string }) {
  need(ctx, "reopen");
  if (ctx.society.phase !== "frozen") throw new HttpError(409, "The list is not frozen.", "not_frozen");
  if (ctx.society.erased_at) throw new HttpError(409, "This list's personal data has been erased.", "erased");
  const reason = squeeze(input.reason ?? ""); if (reason.length < 5) throw new HttpError(400, "Please write why the list is reopened, in a few words.", "reason");
  noContactDetails(reason, "the reason");
  if (String(input.confirm ?? "").trim().toUpperCase() !== "REOPEN") throw new HttpError(400, "Please type REOPEN to confirm.", "confirm");
  await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare("UPDATE societies SET phase = 'open', cutoff_at = NULL WHERE id = ? AND phase = 'frozen'").bind(ctx.society.id), guardChanged(ctx.env, "The list was already reopened.")], "list.reopened", await staffActor(ctx.env, ctx.email, ctx.role), { reasonGiven: 1 }, ctx.now); // the reason itself is free text and stays out of the log that can never be erased
  return { reopened: true };
}

export async function listPublications(ctx: StaffCtx) {
  need(ctx, "view");
  const rs = await ctx.env.DB.prepare("SELECT * FROM publications WHERE society_id = ? ORDER BY published_at DESC, seq DESC LIMIT 100").bind(ctx.society.id).all<PubRow>();
  return { publications: rs.results.map((p) => pubView(p, ctx.society.tz_offset_min)) };
}

// ------------------------------------------------------------------------------------------------------------------ exports
interface PubLine { seq: number; unit: string; name: string; capacity: string; mobile: string; email: string; proxy_for: string; is_voter: number; weight_milli: number; can_attend: number; can_vote: number; reason_public?: string; reason_full?: string }
async function loadPub(env: Env, societyId: string, pid: string) {
  const p = await env.DB.prepare("SELECT * FROM publications WHERE society_id = ? AND id = ?").bind(societyId, pid).first<PubRow>();
  if (!p) throw new HttpError(404, "Not found.", "not_found");
  return p;
}
function exportBody(society: SocietyRow, p: PubRow, rows: PubLine[], full: boolean, fmt: "pdf" | "csv") {
  const lines: RegisterLine[] = rows.map((r) => ({ unit: r.unit, name: full ? r.name : pubName(r.name), capacity: capLabel(r.capacity) + (r.proxy_for ? ` for ${full ? r.proxy_for : pubName(r.proxy_for)}` : ""), mobile: full ? r.mobile : pubMobile(r.mobile), email: full ? r.email : pubEmail(r.email), voter: !!r.is_voter, weightMilli: r.weight_milli, canVote: !!r.can_vote, canAttend: !!r.can_attend, reason: (full ? r.reason_full : r.reason_public) ?? "", note: r.is_voter ? (r.can_vote ? "" : "may attend, not vote") : "registered, not authorized to vote" }));
  const tz = society.tz_offset_min;
  const label = p.kind === "frozen" ? `Final list ${p.seq}, frozen at the cut-off of ${msToLocal(p.cutoff_at ?? p.published_at, tz).replace("T", " ")}` : `Provisional (draft) list ${p.seq}, as on ${msToLocal(p.published_at, tz).replace("T", " ")}. It may still change.`;
  const meta: RegisterMeta = { society: society.name, kind: society.kind, state: society.state, country: society.country, regNo: society.reg_no, regOffice: society.reg_office, title: p.kind === "frozen" ? "Final voter list" : "Draft voter list (provisional)", versionLabel: label, ruleCode: p.rule_code, weightMode: p.weight_mode, duesCutoff: p.dues_cutoff, fingerprint: p.fingerprint, publishedAt: p.published_at, tzOffsetMin: tz, event: p.event_name ? { name: p.event_name, type: p.event_type, date: msToLocal(p.cutoff_at ?? p.published_at, tz).slice(0, 10) } : null };
  const base = `voter-list-${p.kind}-${p.seq}${full ? "-full" : ""}`;
  if (fmt === "csv") return { body: new TextEncoder().encode(registerCsv(meta, lines, full)), type: "text/csv; charset=utf-8", filename: base + ".csv" };
  return { body: registerPdf(meta, lines, { units: p.units, voters: p.voters, canVote: p.voters, weightMilli: p.total_weight_milli }, full), type: "application/pdf", filename: base + ".pdf" };
}
const loadLines = async (env: Env, pid: string) => (await env.DB.prepare("SELECT seq, unit, name, capacity, mobile, email, proxy_for, is_voter, weight_milli, can_attend, can_vote, reason_public, reason_full FROM publication_rows WHERE publication_id = ? ORDER BY seq").bind(pid).all<PubLine>()).results;
/** A provisional (draft) list is public from the moment it is published, so a person who withdrew or was removed since then must not stay on it until the next draft: a line is shown only while someone with that flat and e-mail ID is still on the list (matched on the flat key, not the typed text, and still true after the 30-day purge of removed records). A final list is never filtered. */
const GONE = " AND EXISTS (SELECT 1 FROM voters v WHERE v.society_id = publication_rows.society_id AND v.unit_key = publication_rows.unit_key AND v.email = publication_rows.email AND v.status <> 'removed' AND (v.status = 'approved' OR v.approved_json IS NOT NULL))";
const loadShownLines = async (env: Env, p: PubRow) => p.kind === "frozen" ? loadLines(env, p.id) : (await env.DB.prepare("SELECT seq, unit, name, capacity, mobile, email, proxy_for, is_voter, weight_milli, can_attend, can_vote, reason_public, reason_full FROM publication_rows WHERE publication_id = ?" + GONE + " ORDER BY seq").bind(p.id).all<PubLine>()).results;

export async function exportPublication(ctx: StaffCtx, pid: string, fmt: "pdf" | "csv", full: boolean) {
  need(ctx, full ? "fullExport" : "view");
  const p = await loadPub(ctx.env, ctx.society.id, pid);
  const rows = await loadLines(ctx.env, pid);
  await commit(ctx.env, ctx.society.id, [], full ? "export.full" : "export.masked", await staffActor(ctx.env, ctx.email, ctx.role), { pub: pid, format: fmt, lines: rows.length }, ctx.now);
  return exportBody(ctx.society, p, rows, full, fmt);
}

// ------------------------------------------------------------------------------------------------------------------ the public side
/** What the public page shows: the final list if the list is frozen; otherwise the newest draft (or the last final list while a new round is open and no newer draft exists). */
async function shown(env: Env, society: SocietyRow, pubId?: string): Promise<PubRow | null> {
  // an earlier final list stays reachable by its own id, so reopening and publishing a new draft never hides a signed final list
  if (pubId) { const e = await env.DB.prepare("SELECT * FROM publications WHERE id = ? AND society_id = ? AND kind = 'frozen'").bind(pubId.slice(0, 80), society.id).first<PubRow>(); if (!e) throw new HttpError(404, "That list was not found.", "not_found"); return e; }
  const f = await env.DB.prepare("SELECT * FROM publications WHERE society_id = ? AND kind = 'frozen' ORDER BY seq DESC LIMIT 1").bind(society.id).first<PubRow>();
  if (society.phase === "frozen") return f;
  const d = await env.DB.prepare("SELECT * FROM publications WHERE society_id = ? AND kind = 'draft' ORDER BY seq DESC LIMIT 1").bind(society.id).first<PubRow>();
  if (d && (!f || d.published_at >= f.published_at)) return d;
  return f ?? d;
}

export async function publicInfo(env: Env, society: SocietyRow, now: number) {
  const p = await shown(env, society);
  const rule = ruleOf(society.rule_code);
  const frozen = (await env.DB.prepare("SELECT * FROM publications WHERE society_id = ? AND kind = 'frozen' ORDER BY seq DESC LIMIT 10").bind(society.id).all<PubRow>()).results;
  return {
    name: society.name, kind: society.kind, state: society.state, phase: society.phase, enrolOpen: enrolOpen(society, now) && !society.erased_at, erased: !!society.erased_at,
    cutoffAt: society.cutoff_at, cutoffLocal: society.cutoff_at ? msToLocal(society.cutoff_at, society.tz_offset_min) : null, tzOffsetMin: society.tz_offset_min,
    rule: { code: rule.code, name: rule.name, blurb: rule.blurb, capacities: rule.capacities, proxy: rule.proxy }, docsRequired: !!society.docs_required, weightMode: society.weight_mode, duesCutoff: society.dues_enabled ? society.dues_cutoff : null,
    shown: p ? { ...pubView(p, society.tz_offset_min), provisional: p.kind === "draft" } : null,
    earlierFinal: frozen.filter((f) => f.id !== p?.id).map((f) => pubView(f, society.tz_offset_min)),
    permanentNote: "Townhall Records supports every voter list and may check records to help.",
  };
}

export async function publicList(env: Env, society: SocietyRow, o: { offset?: number; limit?: number; unit?: string; pub?: string }) {
  const p = await shown(env, society, o.pub);
  if (!p) return { total: 0, rows: [], publication: null };
  const off = Math.max(0, Math.floor(o.offset ?? 0)), lim = Math.min(200, Math.max(1, Math.floor(o.limit ?? 50)));
  const uq = squeeze(o.unit ?? "").toUpperCase().replace(/[\s\-_/.\\]+/g, "").slice(0, 40);
  const where = (uq ? "publication_id = ? AND unit_key LIKE ? ESCAPE '\\' AND (instr(unit, '#') = 0 OR instr(?, '#') > 0)" : "publication_id = ?") /* a masked ID (digits shown as #) is never found by typing digits */ + (p.kind === "draft" ? GONE : "");
  const binds: unknown[] = uq ? [p.id, uq.replace(/[\\%_]/g, (m) => "\\" + m) + "%", uq] : [p.id];
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM publication_rows WHERE ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const rows = (await env.DB.prepare(`SELECT seq, unit, name, capacity, mobile, email, proxy_for, is_voter, can_vote, can_attend, reason_public FROM publication_rows WHERE ${where} ORDER BY seq LIMIT ? OFFSET ?`).bind(...binds, lim, off).all<PubLine>()).results;
  return { total, offset: off, publication: { id: p.id, kind: p.kind, seq: p.seq, fingerprintShort: shortFingerprint(p.fingerprint) },
    rows: rows.map((r) => ({ no: r.seq, unit: r.unit, name: pubName(r.name), capacity: capLabel(r.capacity), forOwner: r.proxy_for ? pubName(r.proxy_for) : "", mobile: pubMobile(r.mobile), email: pubEmail(r.email), voterForFlat: !!r.is_voter, mayVote: !!r.can_vote, mayAttend: !!r.can_attend, reason: r.reason_public ?? "" })) };
}

export async function publicExport(env: Env, society: SocietyRow, fmt: "pdf" | "csv", pubId?: string) {
  const p = await shown(env, society, pubId);
  if (!p) throw new HttpError(404, "The list has not been published yet.", "not_published");
  return exportBody(society, p, await loadShownLines(env, p), false, fmt);
}

/** Anyone can check that what they see is what was signed: the stored lines still give the stored fingerprint, and the signed audit entry carries the same fingerprint and verifies under the public key. */
export async function publicProof(env: Env, society: SocietyRow, pubId?: string) {
  const p = await shown(env, society, pubId);
  if (!p) throw new HttpError(404, "The list has not been published yet.", "not_published");
  const rows = await loadLines(env, p.id);
  const publicKey = await publicKeyFromPrivate(env.SIGNING_KEY);
  const [e] = await auditEntries(env, society.id, { from: p.audit_seq, limit: 1 });
  let linesMatch: boolean | null = null;
  if (!society.erased_at && p.kind === "frozen") { // a draft may change (a withdrawn voter's line is cleared), so only a final list can be re-checked line by line
    const snaps: Snap[] = rows.map((r) => ({ unit: r.unit, unitKey: "", name: r.name, capacity: r.capacity, mobile: r.mobile, email: r.email, proxyFor: r.proxy_for, isVoter: !!r.is_voter, weightMilli: r.weight_milli, canAttend: !!r.can_attend, canVote: !!r.can_vote, reasonPublic: "", reasonFull: "" }));
    const s = { ...society, rule_code: p.rule_code, weight_mode: p.weight_mode, dues_enabled: p.dues_enabled, dues_cutoff: p.dues_cutoff } as SocietyRow;
    linesMatch = (await pubFingerprint(p.kind, p.kind === "frozen" ? p.cutoff_at : null, p.kind === "frozen" ? p.event_name.toLowerCase() + "|" + p.event_type : "", s, snaps)) === p.fingerprint;
  }
  const entryOk = !!e && e.entry.seq === p.audit_seq && (await entryHash(e.entry)) === e.hash && (await verifyMessage(publicKey, signingMessage(e.entry.eid, e.entry.seq, e.hash), e.sig));
  const sameFp = !!e && (e.entry.payload as Record<string, unknown>).fingerprint === p.fingerprint && (e.entry.payload as Record<string, unknown>).pub === p.id;
  return { kind: p.kind, seq: p.seq, fingerprint: p.fingerprint, linesMatchFingerprint: linesMatch, signature: { valid: entryOk, entryCarriesFingerprint: sameFp, auditSeq: p.audit_seq, entry: e ?? null, publicKey, algorithm: "Ed25519" }, ok: entryOk && sameFp && linesMatch !== false };
}
export { RULES, fmtMilli, pubUnit };
