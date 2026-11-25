// Results (first chunk), the service: take a closed meeting or election (a "closing"), make a declared result from it, keep it fixed, and let it be
// made final, corrected, shown to the public, exported and checked. It is built the way Attendance was: its own tables, its own routes, dark until
// RESULTS_ENABLED is "1", and connected to the other products only by reading their public facts (the final voter list and the attendance count).
//
// How a result is made (nobody types a result in; the server copies every number from one closing):
//   closing (fixed) -> DRAFT result (the outcomes, the checks, a fingerprint, a challenge window) -> FINAL (the Organizer types FINAL, after the window, with no failed check)
//   A mistake is put right by a CORRECTION: a new result that points at the old one. The old one stays, marked as replaced, and is still shown.
// Every step writes one signed entry into the list's audit trail, with ids, counts and the fingerprint only (never a name, an e-mail ID or a phone number).
import { rateLimit } from "./auth";
import { auditEntries, commit, guardChanged, pseudonym, staffActor } from "./audit";
import { shortFingerprint } from "./checks";
import { toCsv } from "./csv";
import { uid, type Env } from "./db";
import { HttpError } from "./errors";
import { localToMs, msToLocal } from "./lists";
import { ruleOf } from "./model";
import { pubName } from "./publish";
import { buildRoll, need, seesFull, type SocietyRow, type StaffCtx } from "./store";
import { publicKeyFromPrivate, verifyMessage } from "./vendor/crypto";
import { entryHash, signingMessage } from "./vendor/log";
import { maskName, scanPublic } from "./vendor/masking";
import {
  buildContent, clean, fingerprintOf, mapNames, MODE_TEXT, normalizeClaim, parseClosing, RES, VISIBILITIES, type AttFacts, type Closing, type Content, type Kind, type ListFacts, type Visibility,
} from "./results-core";

// ------------------------------------------------------------------------------------------------------------------ the switch
/** The whole product is dark: every Results address answers "not found" unless RESULTS_ENABLED is "1". */
export const resultsOn = (env: Env): boolean => env.RESULTS_ENABLED === "1";
export function requireOn(env: Env): void { if (!resultsOn(env)) throw new HttpError(404, RES.notFound, "not_found"); }
export function notErased(s: SocietyRow): void { if (s.erased_at) throw new HttpError(410, RES.erased, "erased"); }

// ------------------------------------------------------------------------------------------------------------------ rows
type Status = "draft" | "final" | "superseded";
interface ClosingRow { id: string; society_id: string; kind: Kind; ref: string; revision: number; source: string; title: string; closed_at: number; payload_json: string; created_by: string; created_at: number }
interface ResultRow {
  id: string; society_id: string; closing_id: string; kind: Kind; ref: string; version: number; supersedes: string | null; status: Status; visibility: Visibility; content_json: string; fingerprint: string;
  failed_checks: number; challenge_ends_at: number; audit_seq: number; created_by: string; created_at: number; finalized_at: number | null; finalized_by: string | null; final_audit_seq: number | null; superseded_at: number | null;
}
const STATUS_TEXT: Record<Status, string> = { draft: "Draft", final: "Final", superseded: "Replaced by a correction" };
const KIND_TEXT: Record<Kind, string> = { meeting: "Meeting", election: "Election" };
const RATE = { limit: 30, windowMs: 3_600_000 };

const resultOf = async (env: Env, societyId: string, id: string): Promise<ResultRow> => {
  const r = await env.DB.prepare("SELECT * FROM res_results WHERE society_id = ? AND id = ?").bind(societyId, String(id).slice(0, 80)).first<ResultRow>();
  if (!r) throw new HttpError(404, RES.notFound, "not_found");
  return r;
};
const closingOf = async (env: Env, societyId: string, id: string): Promise<ClosingRow> => {
  const r = await env.DB.prepare("SELECT * FROM res_closings WHERE society_id = ? AND id = ?").bind(societyId, String(id).slice(0, 80)).first<ClosingRow>();
  if (!r) throw new HttpError(404, RES.notFound, "not_found");
  return r;
};

/** Runs a write. A second live result, or a second delivery of the same closing, meets a UNIQUE rule in the database: that is a clean 409, not a crash. */
async function write<T>(f: () => Promise<T>, onUnique: { message: string; code: string }): Promise<T> {
  try { return await f(); } catch (e) {
    if (e instanceof HttpError) throw e;
    const m = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed/i.test(m) && /res_(closings|results)|uq_res_live/i.test(m)) throw new HttpError(409, onUnique.message, onUnique.code);
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------------------------ facts read from the other products
interface PubRow { id: string; seq: number; event_name: string; event_type: string; cutoff_at: number | null; rule_code: number; weight_mode: string; voters: number; fingerprint: string; published_at: number }
const PUB_COLS = "id, seq, event_name, event_type, cutoff_at, rule_code, weight_mode, voters, fingerprint, published_at";

/** The final (frozen) voter list a result stands on. Named by the closing, or else the newest one that was frozen before the closing; with none at all the result cannot be made. */
async function frozenList(env: Env, society: SocietyRow, wanted: string | null, closedAt: number): Promise<ListFacts> {
  let p: PubRow | null;
  if (wanted) {
    p = await env.DB.prepare(`SELECT ${PUB_COLS} FROM publications WHERE society_id = ? AND id = ? AND kind = 'frozen'`).bind(society.id, wanted).first<PubRow>();
    if (!p) throw new HttpError(404, RES.noSuchList, "no_such_list");
  } else {
    p = (await env.DB.prepare(`SELECT ${PUB_COLS} FROM publications WHERE society_id = ? AND kind = 'frozen' AND cutoff_at <= ? ORDER BY seq DESC LIMIT 1`).bind(society.id, closedAt).first<PubRow>())
      ?? (await env.DB.prepare(`SELECT ${PUB_COLS} FROM publications WHERE society_id = ? AND kind = 'frozen' ORDER BY seq DESC LIMIT 1`).bind(society.id).first<PubRow>());
    if (!p) throw new HttpError(409, RES.noFinalList, "no_final_list");
  }
  return { pubId: p.id, finalNo: p.seq, fingerprint: p.fingerprint, cutoffAt: p.cutoff_at ?? 0, publishedAt: p.published_at, voters: p.voters, limit: p.voters, weightMode: p.weight_mode, event: p.event_name, eventType: p.event_type, voterRule: ruleOf(p.rule_code).name };
}

/** The attendance count of one session, read the way the Attendance product shows it (who may attend now; who is marked present). Attendance code is not touched. */
async function attendanceFacts(env: Env, society: SocietyRow, id: string): Promise<AttFacts> {
  const s = await env.DB.prepare("SELECT id, title, starts_at, status, closed_at FROM att_sessions WHERE society_id = ? AND id = ?").bind(society.id, id).first<{ id: string; title: string; starts_at: number; status: "open" | "closed"; closed_at: number | null }>();
  if (!s) throw new HttpError(404, RES.noSuchAttendance, "no_such_attendance");
  const present = (await env.DB.prepare("SELECT COUNT(*) AS n FROM att_marks WHERE session_id = ?").bind(s.id).first<{ n: number }>())?.n ?? 0;
  const eligible = (await buildRoll(env, society.id)).lines.filter((l) => l.row.canAttend).length;
  return { id: s.id, title: s.title, startsAt: msToLocal(s.starts_at, society.tz_offset_min), startsAtMs: s.starts_at, closedAt: s.closed_at, status: s.status, eligible, present };
}

/** The closing time in the list's own time zone as a moment. A result is made only after the meeting or election has closed. */
function closedAtOf(ctx: StaffCtx, c: Closing): number {
  const at = localToMs(c.closedAtLocal, ctx.society.tz_offset_min);
  if (at === null) throw new HttpError(400, RES.badTime, "bad_time");
  if (at > ctx.now) throw new HttpError(400, RES.futureClose, "future_close");
  return at;
}

/** The content of a result, its fingerprint and its failed checks, made from one closing and the facts of the other products. */
async function build(env: Env, society: SocietyRow, c: Closing, meta: { revision: number; source: string; closedAt: number }, version: number, now: number, sup: { fp: string; reason: string } | null) {
  const list = await frozenList(env, society, c.listPubId, meta.closedAt);
  const att = c.attendanceId ? await attendanceFacts(env, society, c.attendanceId) : null;
  return buildContent(c, { society: society.id, version, supersedesFp: sup?.fp ?? null, correctionReason: sup?.reason ?? null, closingRevision: meta.revision, source: meta.source, closedAt: meta.closedAt, closedAtLocal: c.closedAtLocal, tz: society.tz_offset_min, now, list, att });
}

// ------------------------------------------------------------------------------------------------------------------ views
const viewClosing = (r: ClosingRow, tz: number) => ({ id: r.id, kind: r.kind, ref: r.ref, revision: r.revision, source: r.source, title: r.title, closedAt: r.closed_at, closedAtLocal: msToLocal(r.closed_at, tz), createdAt: r.created_at });

function viewOf(r: ResultRow, tz: number, now: number, supersededBy: string | null) {
  return {
    id: r.id, closingId: r.closing_id, kind: r.kind, ref: r.ref, version: r.version, status: r.status, statusText: STATUS_TEXT[r.status], visibility: r.visibility, supersedes: r.supersedes, supersededBy,
    failedChecks: r.failed_checks, fingerprint: r.fingerprint, fingerprintShort: shortFingerprint(r.fingerprint), createdAt: r.created_at,
    challengeEndsAt: r.challenge_ends_at, challengeEndsLocal: msToLocal(r.challenge_ends_at, tz), challengeOpen: r.status === "draft" && now < r.challenge_ends_at,
    canFinalize: r.status === "draft" && r.failed_checks === 0 && now >= r.challenge_ends_at,
    finalizedAt: r.finalized_at, supersededAt: r.superseded_at, auditSeq: r.audit_seq, finalAuditSeq: r.final_audit_seq,
  };
}

/** A few numbers that say what a result decided, with no names. */
function headlineOf(c: Content) {
  if (c.motions) return { motions: c.motions.length, passed: c.motions.filter((m) => m.outcome === "passed").length, notPassed: c.motions.filter((m) => m.outcome === "not_passed").length, noVotes: c.motions.filter((m) => m.outcome === "no_votes").length };
  const e = c.election;
  return { posts: e ? e.posts.length : 0, seats: e ? e.posts.reduce((s, p) => s + p.seats, 0) : 0, ballots: e ? e.ballots : 0 };
}

interface Step { at: number; local: string; code: string; text: string }
/** Everything that happened to a result, in the order it happened (CP-337). */
function timelineOf(r: ResultRow, c: Content, tz: number): Step[] {
  const out: Step[] = [];
  const add = (at: number, code: string, text: string) => { out.push({ at, local: msToLocal(at, tz), code, text }); };
  add(c.list.publishedAt, "list_frozen", `The final voter list was frozen (final list ${c.list.finalNo}).`);
  if (c.attendance) {
    add(c.attendance.startsAtMs, "attendance_start", "The attendance session was set to start.");
    if (c.attendance.closedAt !== null) add(c.attendance.closedAt, "attendance_closed", "The attendance session was closed.");
  }
  add(c.closedAt, "process_closed", c.kind === "meeting" ? "The meeting closed." : "The election closed.");
  add(r.created_at, "result_made", r.version > 1 ? "A corrected result was made as a draft." : "The result was made as a draft.");
  add(r.challenge_ends_at, "challenge_ends", "The challenge window ends.");
  if (r.finalized_at !== null) add(r.finalized_at, "finalized", "The result was made final.");
  if (r.superseded_at !== null) add(r.superseded_at, "superseded", "The result was replaced by a correction.");
  return out.sort((a, b) => a.at - b.at);
}

/** A plain sentence that says where a result stands, shown above it on every page. */
function noticeOf(r: ResultRow, tz: number, now: number): string {
  if (r.status === "superseded") return "This result was replaced by a correction. Please read the newer result.";
  if (r.status === "final") return "This result is final.";
  const failed = r.failed_checks > 0 ? " One or more checks failed, so it cannot be made final until it is corrected." : "";
  if (now < r.challenge_ends_at) return `This result is a draft. The challenge window is open until ${msToLocal(r.challenge_ends_at, tz)}. It can be made final after that.${failed}`;
  return `This result is a draft. The challenge window has ended.${failed}`;
}

async function supersededByMap(env: Env, societyId: string): Promise<Map<string, string>> {
  const rs = await env.DB.prepare("SELECT id, supersedes FROM res_results WHERE society_id = ? AND supersedes IS NOT NULL").bind(societyId).all<{ id: string; supersedes: string }>();
  return new Map(rs.results.map((x) => [x.supersedes, x.id]));
}

/** One result with everything about it. `names` decides how the names of people are shown (full, or passed through a mask). */
async function fullView(env: Env, society: SocietyRow, row: ResultRow, names: ((n: string) => string) | null, now: number) {
  const content = JSON.parse(row.content_json) as Content;
  const by = (await supersededByMap(env, society.id)).get(row.id) ?? null;
  const cl = await env.DB.prepare("SELECT * FROM res_closings WHERE society_id = ? AND id = ?").bind(society.id, row.closing_id).first<ClosingRow>();
  return {
    result: viewOf(row, society.tz_offset_min, now, by), notice: noticeOf(row, society.tz_offset_min, now), content: names ? mapNames(content, names) : content,
    timeline: timelineOf(row, content, society.tz_offset_min), closing: cl ? viewClosing(cl, society.tz_offset_min) : null, headline: headlineOf(content),
  };
}
const namesFor = (ctx: StaffCtx): ((n: string) => string) | null => (seesFull(ctx) ? null : maskName);

// ------------------------------------------------------------------------------------------------------------------ the closed meeting or election (CP-311, CP-333)
async function checkLinks(ctx: StaffCtx, c: Closing, closedAt: number): Promise<void> {
  if (c.listPubId) await frozenList(ctx.env, ctx.society, c.listPubId, closedAt);
  if (c.attendanceId) await attendanceFacts(ctx.env, ctx.society, c.attendanceId);
}

/** The Organizer enters a meeting or election that has closed, with its counts. Today this is the only way in; the Meetings and Elections products will deliver theirs the same way later. */
export async function enterClosing(ctx: StaffCtx, input: unknown) {
  need(ctx, "results"); notErased(ctx.society);
  const c = parseClosing(input);
  const closedAt = closedAtOf(ctx, c);
  await rateLimit(ctx.env, `res:${ctx.society.id}`, RATE.limit, RATE.windowMs, ctx.now, RES.tooMany);
  await checkLinks(ctx, c, closedAt);
  const id = uid("rcl");
  const seq = await write(async () => commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("INSERT INTO res_closings (id, society_id, kind, ref, revision, source, title, closed_at, payload_json, created_by, created_at) VALUES (?, ?, ?, ?, 1, 'organizer', ?, ?, ?, ?, ?)")
      .bind(id, ctx.society.id, c.kind, c.ref, c.title, closedAt, JSON.stringify(c), await pseudonym(ctx.env, ctx.email), ctx.now),
  ], "results.closing_entered", await staffActor(ctx.env, ctx.email, ctx.role), { closing: id, kind: c.kind, revision: 1 }, ctx.now), { message: RES.closingExists, code: "closing_exists" });
  return { closing: viewClosing(await closingOf(ctx.env, ctx.society.id, id), ctx.society.tz_offset_min), audit: seq };
}

export async function listClosings(ctx: StaffCtx) {
  need(ctx, "view"); notErased(ctx.society);
  const rs = await ctx.env.DB.prepare("SELECT * FROM res_closings WHERE society_id = ? ORDER BY created_at DESC, id LIMIT 200").bind(ctx.society.id).all<ClosingRow>();
  const made = await ctx.env.DB.prepare("SELECT id, closing_id, version, status FROM res_results WHERE society_id = ? ORDER BY version").bind(ctx.society.id).all<{ id: string; closing_id: string; version: number; status: Status }>();
  return { closings: rs.results.map((r) => ({ ...viewClosing(r, ctx.society.tz_offset_min), results: made.results.filter((m) => m.closing_id === r.id).map((m) => ({ id: m.id, version: m.version, status: m.status })) })) };
}

// ------------------------------------------------------------------------------------------------------------------ making a result (CP-312 to CP-320)
const INSERT_RESULT = `INSERT INTO res_results (id, society_id, closing_id, kind, ref, version, supersedes, status, visibility, content_json, fingerprint, failed_checks, challenge_ends_at, audit_seq, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM audit_entries WHERE society_id = ?), ?, ?)`;

/** The draft result of a closing: the outcomes, the checks and the fingerprint are all computed here from the closing; none of it can be typed in. */
export async function makeResult(ctx: StaffCtx, input: { closingId?: unknown }) {
  need(ctx, "results"); notErased(ctx.society);
  const cid = typeof input.closingId === "string" ? input.closingId.trim() : "";
  if (!cid) throw new HttpError(400, RES.needClosing, "need_closing");
  const cl = await closingOf(ctx.env, ctx.society.id, cid);
  if (await ctx.env.DB.prepare("SELECT 1 AS x FROM res_results WHERE society_id = ? AND kind = ? AND ref = ? LIMIT 1").bind(ctx.society.id, cl.kind, cl.ref).first()) throw new HttpError(409, RES.resultExists, "result_exists");
  await rateLimit(ctx.env, `res:${ctx.society.id}`, RATE.limit, RATE.windowMs, ctx.now, RES.tooMany);
  const c = JSON.parse(cl.payload_json) as Closing;
  const { content, fingerprint, failed } = await build(ctx.env, ctx.society, c, { revision: cl.revision, source: cl.source, closedAt: cl.closed_at }, 1, ctx.now, null);
  const id = uid("res"), endsAt = ctx.now + c.challengeHours * 3_600_000;
  const seq = await write(async () => commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare(INSERT_RESULT).bind(id, ctx.society.id, cl.id, cl.kind, cl.ref, 1, null, "hidden", JSON.stringify(content), fingerprint, failed, endsAt, ctx.society.id, await pseudonym(ctx.env, ctx.email), ctx.now),
  ], "results.declared", await staffActor(ctx.env, ctx.email, ctx.role), { result: id, closing: cl.id, kind: cl.kind, version: 1, fingerprint, failed, challengeEndsAt: endsAt }, ctx.now), { message: RES.resultExists, code: "result_exists" });
  return { ...(await fullView(ctx.env, ctx.society, await resultOf(ctx.env, ctx.society.id, id), namesFor(ctx), ctx.now)), audit: seq };
}

export async function listResults(ctx: StaffCtx) {
  need(ctx, "view"); notErased(ctx.society);
  const rs = await ctx.env.DB.prepare("SELECT * FROM res_results WHERE society_id = ? ORDER BY created_at DESC, version DESC, id LIMIT 200").bind(ctx.society.id).all<ResultRow>();
  const by = await supersededByMap(ctx.env, ctx.society.id);
  return { results: rs.results.map((r) => { const c = JSON.parse(r.content_json) as Content; return { ...viewOf(r, ctx.society.tz_offset_min, ctx.now, by.get(r.id) ?? null), title: c.title, closedAtLocal: msToLocal(c.closedAt, ctx.society.tz_offset_min), headline: headlineOf(c) }; }) };
}

export async function openResult(ctx: StaffCtx, rid: string) {
  need(ctx, "view"); notErased(ctx.society);
  return fullView(ctx.env, ctx.society, await resultOf(ctx.env, ctx.society.id, rid), namesFor(ctx), ctx.now);
}

// ------------------------------------------------------------------------------------------------------------------ final, correction, visibility
/** The Organizer makes a draft final: after the challenge window, with no failed check, by typing FINAL. A final result can never change; only a correction can follow it. */
export async function finalize(ctx: StaffCtx, rid: string, input: { confirm?: unknown }) {
  need(ctx, "results"); notErased(ctx.society);
  const row = await resultOf(ctx.env, ctx.society.id, rid);
  if (row.status !== "draft") throw new HttpError(409, RES.notDraft, "not_draft");
  if (String(input.confirm ?? "").trim().toUpperCase() !== "FINAL") throw new HttpError(400, RES.confirmFinal, "confirm");
  if (row.failed_checks > 0) throw new HttpError(409, RES.failedChecks, "failed_checks");
  if (ctx.now < row.challenge_ends_at) throw new HttpError(409, RES.challengeOpen(msToLocal(row.challenge_ends_at, ctx.society.tz_offset_min)), "challenge_open");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE res_results SET status = 'final', finalized_at = ?, finalized_by = ?, final_audit_seq = (SELECT IFNULL(MAX(seq), 0) + 1 FROM audit_entries WHERE society_id = ?) WHERE society_id = ? AND id = ? AND status = 'draft'")
      .bind(ctx.now, await pseudonym(ctx.env, ctx.email), ctx.society.id, ctx.society.id, row.id),
    guardChanged(ctx.env, RES.changedMeanwhile),
  ], "results.finalized", await staffActor(ctx.env, ctx.email, ctx.role), { result: row.id, version: row.version, fingerprint: row.fingerprint }, ctx.now);
  return { ...(await fullView(ctx.env, ctx.society, await resultOf(ctx.env, ctx.society.id, row.id), namesFor(ctx), ctx.now)), audit: seq };
}

/** A correction: a corrected closing and a reason make a NEW result that replaces the old one. The old result stays, marked as replaced, and the whole chain stays visible. */
export async function correct(ctx: StaffCtx, rid: string, input: { reason?: unknown; closing?: unknown }) {
  need(ctx, "results"); notErased(ctx.society);
  const old = await resultOf(ctx.env, ctx.society.id, rid);
  if (old.status === "superseded") throw new HttpError(409, RES.alreadyCorrected, "already_corrected");
  const reason = clean(input.reason);
  if (reason.length < 5 || reason.length > 300) throw new HttpError(400, RES.badReason, "bad_reason");
  if (scanPublic(reason).length) throw new HttpError(400, RES.contact("the reason"), "contact_details");
  const c = parseClosing(input.closing);
  if (c.kind !== old.kind || c.ref !== old.ref) throw new HttpError(400, RES.sameProcess, "same_process");
  const closedAt = closedAtOf(ctx, c);
  await rateLimit(ctx.env, `res:${ctx.society.id}`, RATE.limit, RATE.windowMs, ctx.now, RES.tooMany);
  const newest = (await ctx.env.DB.prepare("SELECT IFNULL(MAX(revision), 0) AS n FROM res_closings WHERE society_id = ? AND kind = ? AND ref = ?").bind(ctx.society.id, old.kind, old.ref).first<{ n: number }>())?.n ?? 0;
  const revision = newest + 1, version = old.version + 1;
  const { content, fingerprint, failed } = await build(ctx.env, ctx.society, c, { revision, source: "organizer", closedAt }, version, ctx.now, { fp: old.fingerprint, reason });
  const cid = uid("rcl"), id = uid("res"), endsAt = ctx.now + c.challengeHours * 3_600_000, pid = await pseudonym(ctx.env, ctx.email);
  const seq = await write(async () => commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("INSERT INTO res_closings (id, society_id, kind, ref, revision, source, title, closed_at, payload_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'organizer', ?, ?, ?, ?, ?)").bind(cid, ctx.society.id, c.kind, c.ref, revision, c.title, closedAt, JSON.stringify(c), pid, ctx.now),
    // the old result is replaced first: the database allows only one live result for one meeting or election
    ctx.env.DB.prepare("UPDATE res_results SET status = 'superseded', superseded_at = ? WHERE society_id = ? AND id = ? AND status <> 'superseded'").bind(ctx.now, ctx.society.id, old.id),
    guardChanged(ctx.env, RES.alreadyCorrected),
    ctx.env.DB.prepare(INSERT_RESULT).bind(id, ctx.society.id, cid, old.kind, old.ref, version, old.id, old.visibility, JSON.stringify(content), fingerprint, failed, endsAt, ctx.society.id, pid, ctx.now),
  ], "results.corrected", await staffActor(ctx.env, ctx.email, ctx.role), { result: id, supersedes: old.id, closing: cid, kind: old.kind, version, fingerprint, failed, challengeEndsAt: endsAt }, ctx.now), { message: RES.alreadyCorrected, code: "already_corrected" });
  return { ...(await fullView(ctx.env, ctx.society, await resultOf(ctx.env, ctx.society.id, id), namesFor(ctx), ctx.now)), audit: seq };
}

/** Who may see a result: hidden (the team only), masked (the public sees names in a masked form) or full. A new result starts hidden; a correction keeps what the old one had. */
export async function setVisibility(ctx: StaffCtx, rid: string, input: { visibility?: unknown }) {
  need(ctx, "results"); notErased(ctx.society);
  const row = await resultOf(ctx.env, ctx.society.id, rid);
  const v = String(input.visibility);
  if (!(VISIBILITIES as readonly string[]).includes(v)) throw new HttpError(400, RES.badVisibility, "bad_visibility");
  if (row.status === "superseded") throw new HttpError(409, RES.alreadyCorrected, "already_corrected");
  if (row.visibility === v) return { ...(await fullView(ctx.env, ctx.society, row, namesFor(ctx), ctx.now)), changed: false };
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE res_results SET visibility = ? WHERE society_id = ? AND id = ? AND status <> 'superseded' AND visibility <> ?").bind(v, ctx.society.id, row.id, v), guardChanged(ctx.env, RES.changedMeanwhile),
  ], "results.visibility", await staffActor(ctx.env, ctx.email, ctx.role), { result: row.id, visibility: v }, ctx.now);
  return { ...(await fullView(ctx.env, ctx.society, await resultOf(ctx.env, ctx.society.id, row.id), namesFor(ctx), ctx.now)), changed: true, audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ the sheet (CP-327)
/** One result as a sheet that opens in any spreadsheet program: what was decided, the rule, the checks and the fingerprint. Every download leaves a signed line in the audit trail. */
export async function exportCsv(ctx: StaffCtx, rid: string) {
  need(ctx, "view"); notErased(ctx.society);
  const row = await resultOf(ctx.env, ctx.society.id, rid);
  const full = seesFull(ctx);
  const raw = JSON.parse(row.content_json) as Content;
  const c = full ? raw : mapNames(raw, maskName);
  const tz = ctx.society.tz_offset_min;
  const out: unknown[][] = [
    ["Result", c.title], ["Kind", KIND_TEXT[c.kind]], ["Reference", c.ref], ["Version", row.version], ["Status", STATUS_TEXT[row.status]], ["Closed", msToLocal(c.closedAt, tz)],
    ["How it was checked", MODE_TEXT[c.mode]], ["Rule", c.rule.text], ["Who may vote", c.rule.voterRule],
    ["Final voter list", `Final list ${c.list.finalNo}, fingerprint ${c.list.fingerprint}`], ["Fingerprint of this result", row.fingerprint],
    ["Counted by", c.signoff.countedBy.join("; ")], ["Validated by", c.signoff.validatedBy.join("; ")], ["Observers", c.signoff.observers.join("; ")], ["Supervised by", c.signoff.supervisedBy.join("; ")],
    [],
  ];
  if (c.motions) {
    out.push(["Motion", "Text", "For", "Against", "Abstain", "Rule", "Outcome"]);
    for (const m of c.motions) out.push([m.number, m.text, m.for, m.against, m.abstain, m.rule, m.outcomeText]);
  }
  if (c.election) {
    out.push(["Post", "Seats", "Candidate", "Votes", "Result"]);
    for (const p of c.election.posts) {
      for (const r of p.ranking) out.push([p.name, p.seats, r.name, r.votes, r.status === "won" ? "Won" : r.status === "tied" ? "Tied" : "Not elected"]);
      if (p.none) out.push([p.name, p.seats, "None of the above", p.none, ""]);
      if (p.vacant) out.push([p.name, p.seats, "Seats with no candidate", p.vacant, ""]);
    }
    out.push([], ["Ballots cast", c.election.ballots]);
  }
  out.push([], ["Check", "Result", "What it says"]);
  for (const k of c.checks) out.push([k.code, k.level === "ok" ? "Passed" : k.level === "warn" ? "Please note" : "Failed", k.text]);
  await commit(ctx.env, ctx.society.id, [], "results.exported", await staffActor(ctx.env, ctx.email, ctx.role), { result: row.id, format: "csv", full }, ctx.now);
  return { body: toCsv(out), type: "text/csv; charset=utf-8", filename: `result-${row.kind}-v${row.version}.csv` };
}

// ------------------------------------------------------------------------------------------------------------------ checking a result (CP-336)
async function entryCheck(env: Env, societyId: string, seq: number | null, row: ResultRow, publicKey: string) {
  if (seq === null) return null;
  const [e] = await auditEntries(env, societyId, { from: seq, limit: 1 });
  const valid = !!e && e.entry.seq === seq && (await entryHash(e.entry)) === e.hash && (await verifyMessage(publicKey, signingMessage(e.entry.eid, e.entry.seq, e.hash), e.sig));
  const p = (e?.entry.payload ?? {}) as Record<string, unknown>;
  const carries = !!e && p.result === row.id && p.fingerprint === row.fingerprint;
  return { valid, carries, auditSeq: seq };
}

/** Anyone can check a result: what is stored still gives its fingerprint, and the signed audit entries that recorded it carry the same fingerprint. A code read from a paper or a screen can be compared too. */
export async function verifyResult(env: Env, society: SocietyRow, row: ResultRow, code?: unknown) {
  const given = normalizeClaim(code);
  const asked = typeof code === "string" && code.trim() !== "";
  if (asked && given.length < 12) throw new HttpError(400, RES.shortCode, "short_code");
  let intact = false;
  try { intact = (await fingerprintOf(JSON.parse(row.content_json))) === row.fingerprint; } catch { intact = false; }
  const publicKey = await publicKeyFromPrivate(env.SIGNING_KEY);
  const declared = await entryCheck(env, society.id, row.audit_seq, row, publicKey);
  const final = await entryCheck(env, society.id, row.final_audit_seq, row, publicKey);
  const claim = asked ? { given: true, matches: row.fingerprint.startsWith(given) } : null;
  const ok = intact && !!declared && declared.valid && declared.carries && (!final || (final.valid && final.carries));
  return { result: row.id, status: row.status, fingerprint: row.fingerprint, fingerprintShort: shortFingerprint(row.fingerprint), intact, declared, final, claim, ok, publicKey, algorithm: "Ed25519" };
}

export async function verifyForTeam(ctx: StaffCtx, rid: string, code?: unknown) {
  need(ctx, "view"); notErased(ctx.society);
  return verifyResult(ctx.env, ctx.society, await resultOf(ctx.env, ctx.society.id, rid), code);
}

// ------------------------------------------------------------------------------------------------------------------ the public side (CP-323 to CP-325)
async function visibleRow(env: Env, society: SocietyRow, rid: string): Promise<ResultRow> {
  const r = await resultOf(env, society.id, rid);
  if (r.visibility === "hidden") throw new HttpError(404, RES.notFound, "not_found"); // the same answer as for a result that does not exist
  return r;
}

/** Public: the results the Organizer chose to show. Titles, times, outcomes in numbers, and the fingerprint. No names. */
export async function publicList(env: Env, society: SocietyRow, now: number) {
  notErased(society);
  const rs = await env.DB.prepare("SELECT * FROM res_results WHERE society_id = ? AND visibility <> 'hidden' ORDER BY created_at DESC, version DESC, id LIMIT 100").bind(society.id).all<ResultRow>();
  const by = await supersededByMap(env, society.id);
  return { list: society.name, results: rs.results.map((r) => { const c = JSON.parse(r.content_json) as Content; return { ...viewOf(r, society.tz_offset_min, now, by.get(r.id) ?? null), title: c.title, closedAtLocal: msToLocal(c.closedAt, society.tz_offset_min), headline: headlineOf(c), notice: noticeOf(r, society.tz_offset_min, now) }; }) };
}

/** Public: one result. Names are shown in the form the Organizer chose: masked, or full. Never an e-mail ID or a phone number: none is ever stored in a result. */
export async function publicResult(env: Env, society: SocietyRow, rid: string, now: number) {
  notErased(society);
  const row = await visibleRow(env, society, rid);
  const v = await fullView(env, society, row, row.visibility === "masked" ? pubName : null, now);
  return { list: society.name, result: v.result, notice: v.notice, content: v.content, timeline: v.timeline, headline: v.headline };
}

export async function publicVerify(env: Env, society: SocietyRow, rid: string, code?: unknown) {
  notErased(society);
  return verifyResult(env, society, await visibleRow(env, society, rid), code);
}
