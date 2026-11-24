// Attendance Management (first chunk): a session for a list, one mark per voter per session, and a public count with no personal data.
// The list is either a Voter List, or a list made from an uploaded Excel sheet (purpose 'attendance_upload'). Both are `societies` rows with `voters`,
// so masking, roles and the signed audit trail are exactly those of the Voter List.
import { HttpError, rateLimit, signupOpen, isListedOrganizer } from "./auth";
import { commit, guardChanged, guardExists, looksPrivate, pseudonym, staffActor } from "./audit";
import { uid, type D1Stmt, type Env } from "./db";
import { localToMs, msToLocal, noContactDetails } from "./lists";
import { parseUpload } from "./importer";
import { need, seesFull, buildRoll, type SocietyRow, type StaffCtx } from "./store";
import { cleanEmail, squeeze } from "./text";
import { fromB64url, randomHex } from "./vendor/crypto";
import { maskEmail, maskName } from "./vendor/masking";

export const MODES = ["in_person", "online", "offline"] as const;
export type Mode = (typeof MODES)[number];
const SELF_MARK_LATE_MS = 12 * 3_600_000; // and until 12 hours after it starts
const SELF_MARK_EARLY_MS = 15 * 60_000; // a voter can mark themselves from 15 minutes before the start
const MODE_WORDS: Record<Mode, string> = { in_person: "In person", online: "Online", offline: "Offline" };

interface SessionRow { id: string; society_id: string; title: string; starts_at: number; place: string; mode: Mode; status: "open" | "closed"; created_by: string; created_at: number; closed_at: number | null }

const viewSession = (s: SessionRow, tz: number, eligible: number, present: number) => ({
  id: s.id, title: s.title, startsAt: msToLocal(s.starts_at, tz), place: s.place, mode: s.mode, modeText: MODE_WORDS[s.mode], status: s.status, closedAt: s.closed_at, counts: { eligible, present },
});

/** Everyone who may attend: on the list now (approved) and allowed to attend. Only these can be marked. */
async function eligibleLines(env: Env, societyId: string) {
  return (await buildRoll(env, societyId)).lines.filter((l) => l.row.canAttend);
}
async function counts(env: Env, society: SocietyRow, sessionId: string, known?: number) {
  const eligible = known ?? (society.erased_at ? 0 : (await eligibleLines(env, society.id)).length);
  const present = (await env.DB.prepare("SELECT COUNT(*) AS n FROM att_marks WHERE session_id = ?").bind(sessionId).first<{ n: number }>())?.n ?? 0;
  return { eligible, present };
}
async function sessionOf(env: Env, societyId: string, id: string): Promise<SessionRow> {
  const s = await env.DB.prepare("SELECT * FROM att_sessions WHERE society_id = ? AND id = ?").bind(societyId, id).first<SessionRow>();
  if (!s) throw new HttpError(404, "Not found.", "not_found");
  return s;
}
const notErased = (s: SocietyRow) => { if (s.erased_at) throw new HttpError(410, "This list has been closed and its details erased.", "erased"); };

/** Free text shown on public pages: control characters are removed before anything else. */
const noControls = (v: unknown) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

export interface SessionInput { title?: unknown; startsAt?: unknown; place?: unknown; mode?: unknown }

export async function createSession(ctx: StaffCtx, input: SessionInput) {
  need(ctx, "attendSetup"); notErased(ctx.society);
  const title = squeeze(noControls(input.title)); if (title.length < 2 || title.length > 80) throw new HttpError(400, "Please type a title of 2 to 80 letters.", "bad_title");
  const place = squeeze(noControls(input.place)).slice(0, 120);
  noContactDetails(title, "the title"); noContactDetails(place, "the place");
  if (!(MODES as readonly string[]).includes(String(input.mode))) throw new HttpError(400, "Please choose how people are checked: in person, online or offline.", "bad_mode");
  const at = localToMs(String(input.startsAt ?? ""), ctx.society.tz_offset_min); if (at === null) throw new HttpError(400, "Please pick the date and time again.", "bad_time");
  const id = uid("att");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("INSERT INTO att_sessions (id, society_id, title, starts_at, place, mode, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)").bind(id, ctx.society.id, title, at, place, String(input.mode), await pseudonym(ctx.env, ctx.email), ctx.now),
  ], "attendance.session_created", await staffActor(ctx.env, ctx.email, ctx.role), { session: id, mode: String(input.mode) }, ctx.now);
  return { session: viewSession((await sessionOf(ctx.env, ctx.society.id, id)), ctx.society.tz_offset_min, (await counts(ctx.env, ctx.society, id)).eligible, 0), audit: seq };
}

export async function listSessions(ctx: StaffCtx) {
  need(ctx, "view");
  const rs = await ctx.env.DB.prepare("SELECT * FROM att_sessions WHERE society_id = ? ORDER BY starts_at DESC, id LIMIT 200").bind(ctx.society.id).all<SessionRow>();
  const n = ctx.society.erased_at ? 0 : (await eligibleLines(ctx.env, ctx.society.id)).length;
  const out = []; for (const s of rs.results) { const c = await counts(ctx.env, ctx.society, s.id, n); out.push(viewSession(s, ctx.society.tz_offset_min, c.eligible, c.present)); }
  return { sessions: out };
}

/** One session for the team: counts, who is present (masked for a co-organizer), and a find box by flat / member ID or name. */
export async function openSession(ctx: StaffCtx, id: string, find = "") {
  need(ctx, "view"); notErased(ctx.society);
  const s = await sessionOf(ctx.env, ctx.society.id, id);
  const full = seesFull(ctx);
  const marks = new Map((await ctx.env.DB.prepare("SELECT voter_id, method, marked_at FROM att_marks WHERE session_id = ?").bind(id).all<{ voter_id: string; method: string; marked_at: number }>()).results.map((m) => [m.voter_id, m]));
  const q = squeeze(find).toLowerCase();
  const lines = await eligibleLines(ctx.env, ctx.society.id);
  const shown = lines.filter((l) => !q || l.row.unit.toLowerCase().includes(q) || l.row.name.toLowerCase().includes(q)).slice(0, 50)
    .map((l) => ({ voterId: l.voterId, unit: l.row.unit, name: full ? l.row.name : maskName(l.row.name), email: full ? l.row.email : maskEmail(l.row.email), present: marks.has(l.voterId), method: marks.get(l.voterId)?.method ?? null, markedAt: marks.get(l.voterId)?.marked_at ?? null }));
  return { session: viewSession(s, ctx.society.tz_offset_min, lines.length, marks.size), people: shown };
}

async function mark(env: Env, society: SocietyRow, s: SessionRow, voterId: string, method: "email" | "organizer", actorEmail: string, actorRole: string, now: number) {
  notErased(society);
  if (s.status !== "open") throw new HttpError(409, "This session is closed. Nobody can be marked now.", "closed");
  const line = (await eligibleLines(env, society.id)).find((l) => l.voterId === voterId);
  if (!line) throw new HttpError(404, "This person is not on the list for this session.", "not_on_list");
  if (await env.DB.prepare("SELECT 1 AS x FROM att_marks WHERE session_id = ? AND voter_id = ?").bind(s.id, voterId).first()) throw new HttpError(409, "This person is already marked present.", "already_present");
  const pid = await pseudonym(env, actorEmail);
  const stmts: D1Stmt[] = [
    guardExists(env, "This session was closed at the same moment.", "SELECT 1 FROM att_sessions WHERE id = ? AND status = 'open'", s.id),
    env.DB.prepare("INSERT OR IGNORE INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?)").bind(s.id, society.id, voterId, method, pid, now),
    guardChanged(env, "This person is already marked present."),
  ];
  // the signed log names the voter and the marker only by private codes, and the flat only in a form that carries no phone number or e-mail ID
  await commit(env, society.id, stmts, "attendance.marked", { pid, role: actorRole }, { session: s.id, voter: await pseudonym(env, line.row.email + "|" + voterId), unit: looksPrivate(line.row.unit) ? "#" : line.row.unit, method, mode: s.mode }, now);
  return { ok: true, present: true, unit: line.row.unit, method };
}

/** The Organizer or a co-organizer marks a person present (the way for in person and offline sessions). */
export async function markByTeam(ctx: StaffCtx, sessionId: string, voterId: unknown) {
  need(ctx, "attendMark");
  const r = await mark(ctx.env, ctx.society, await sessionOf(ctx.env, ctx.society.id, sessionId), String(voterId ?? "").slice(0, 60), "organizer", ctx.email, ctx.role, ctx.now);
  return { ...r, counts: await counts(ctx.env, ctx.society, sessionId) };
}

/** A voter who signed in with the code sent to their e-mail ID marks themselves, only in an online session. */
export async function markSelf(env: Env, now: number, society: SocietyRow, email: string, sessionId: string, voterId?: unknown) {
  notErased(society);
  const s = await sessionOf(env, society.id, sessionId);
  if (s.mode !== "online") throw new HttpError(403, "This session is not online. Please ask the Organizer or a co-organizer to mark you present.", "not_online");
  if (now < s.starts_at - SELF_MARK_EARLY_MS) throw new HttpError(403, "This session has not started yet. Please try again 15 minutes before it starts.", "too_early");
  if (now > s.starts_at + SELF_MARK_LATE_MS) throw new HttpError(403, "This session ended more than 12 hours ago. Please ask the Organizer or a co-organizer to mark you present.", "too_late");
  const mine = (await eligibleLines(env, society.id)).filter((l) => l.row.email.toLowerCase() === email.toLowerCase());
  if (!mine.length) throw new HttpError(403, "This e-mail ID is not on the list for this session.", "not_on_list");
  const want = voterId === undefined ? "" : String(voterId).slice(0, 60);
  const line = want ? mine.find((l) => l.voterId === want) : mine.length === 1 ? mine[0] : undefined;
  if (!line) throw new HttpError(400, "This e-mail ID is on the list more than once. Please say which one.", "which_one");
  const r = await mark(env, society, s, line.voterId, "email", email, "voter", now);
  return { ...r, counts: await counts(env, society, sessionId) };
}

export async function closeSession(ctx: StaffCtx, sessionId: string) {
  need(ctx, "attendSetup"); notErased(ctx.society);
  const s = await sessionOf(ctx.env, ctx.society.id, sessionId);
  await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE att_sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").bind(ctx.now, s.id), guardChanged(ctx.env, "This session is already closed."),
  ], "attendance.session_closed", await staffActor(ctx.env, ctx.email, ctx.role), { session: s.id }, ctx.now);
  const { eligible, present } = await counts(ctx.env, ctx.society, s.id);
  return { session: viewSession(await sessionOf(ctx.env, ctx.society.id, s.id), ctx.society.tz_offset_min, eligible, present) };
}

/** Public: titles, times and counts. No names, no e-mail IDs, no flat numbers. */
export async function publicSessions(env: Env, society: SocietyRow) {
  const rs = await env.DB.prepare("SELECT * FROM att_sessions WHERE society_id = ? ORDER BY starts_at DESC, id LIMIT 100").bind(society.id).all<SessionRow>();
  const n = society.erased_at ? 0 : (await eligibleLines(env, society.id)).length;
  const out = []; for (const s of rs.results) { const c = await counts(env, society, s.id, n); out.push(viewSession(s, society.tz_offset_min, c.eligible, c.present)); }
  return { list: society.name, sessions: out };
}
export async function publicSession(env: Env, society: SocietyRow, id: string) {
  const s = await sessionOf(env, society.id, id); const c = await counts(env, society, id);
  return { list: society.name, session: viewSession(s, society.tz_offset_min, c.eligible, c.present) };
}

// ------------------------------------------------------------------------------------------------------------------ Excel upload for an organizer with no Voter List
export interface RosterInput { title?: unknown; country?: unknown; format?: unknown; text?: unknown; base64?: unknown; dryRun?: unknown }
const COUNTRY_TZ: Record<string, number> = { India: 330, Bangladesh: 360, Bhutan: 360, Nepal: 345, "Sri Lanka": 330, Singapore: 480, "United Arab Emirates": 240, "United Kingdom": 0, "United States": -300 };

/** Reads the sheet, refuses rows with no e-mail ID (and says how many and why), and, unless `dryRun`, makes the list. */
export async function uploadRoster(env: Env, now: number, email: string, input: RosterInput) {
  if (!signupOpen(env) && !isListedOrganizer(env, email)) throw new HttpError(403, "New lists are started by Organizers that Townhall Records has set up. Please ask us to add the e-mail ID, and you can begin right away.", "not_organizer");
  const format = String(input.format);
  if (!["csv", "xlsx", "paste"].includes(format)) throw new HttpError(400, "Choose an Excel file, a CSV file or paste the list.", "bad_format");
  const title = squeeze(noControls(input.title)); if (title.length < 2 || title.length > 80) throw new HttpError(400, "Please type a name for this list, 2 to 80 letters.", "bad_title");
  noContactDetails(title, "the name");
  const country = squeeze(input.country) || "India";
  if (!Object.hasOwn(COUNTRY_TZ, country)) throw new HttpError(400, `Please choose a country from the list: ${Object.keys(COUNTRY_TZ).join(", ")}.`, "bad_country");
  await rateLimit(env, `roster:${email}`, 20, 3_600_000, now);
  let parsed;
  try {
    const b64 = typeof input.base64 === "string" ? input.base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";
    parsed = await parseUpload({ format: format as "csv" | "xlsx" | "paste", text: typeof input.text === "string" ? input.text : undefined, bytes: b64 ? fromB64url(b64) : undefined }, { country, ruleCode: 1 });
  } catch (e) { throw new HttpError(400, (e as Error).message || "That file could not be read.", "bad_file"); }
  const skipped = { noEmail: 0, noUnit: 0, badUnit: 0, noName: 0, duplicate: 0 }; const seen = new Set<string>();
  const add: Array<{ unit: string; unitKey: string; name: string; mobile: string; email: string }> = [];
  for (const r of parsed.rows) {
    if (!r.unitKey) { skipped.noUnit++; continue; }
    if (looksPrivate(r.unit) || r.unit.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 \-\/.,#()]*$/.test(r.unit) || (r.unit.match(/[A-Za-z]{3,}/g) ?? []).length > 2) { skipped.badUnit++; continue; }
    const em = cleanEmail(r.email); if (!em.ok) { skipped.noEmail++; continue; }
    if (!r.name.trim() || r.name.length > 120) { skipped.noName++; continue; }
    const k = r.unitKey + "|" + em.value; if (seen.has(k)) { skipped.duplicate++; continue; }
    seen.add(k); add.push({ unit: r.unit, unitKey: r.unitKey, name: r.name, mobile: r.mobile, email: em.value });
  }
  const report = {
    read: parsed.rowsRead, willAdd: add.length, skipped,
    why: { noEmail: "No e-mail ID, or the e-mail ID is not valid. The e-mail ID is how a person is verified.", noUnit: "No Flat / House / Member ID.", badUnit: "The Flat / House / Member ID looks wrong (for example a phone number or an e-mail ID).", noName: "No name, or the name is too long.", duplicate: "The same ID and e-mail ID appear earlier." },
    problems: parsed.problems.slice(0, 50), unknownColumns: parsed.unknownColumns,
    sample: add.slice(0, 5).map((a) => ({ unit: a.unit, name: maskName(a.name), email: maskEmail(a.email) })),
  };
  if (input.dryRun === true) return { dryRun: true, ...report };
  if (!add.length) throw new HttpError(409, "There is nothing to bring in: every row had a problem.", "nothing_new");
  if (add.length > 6000) throw new HttpError(400, "A list can hold up to 6000 people.", "too_many");
  const own = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE email = ? AND status = 'active' AND role = 'organizer'").bind(email).first<{ n: number }>();
  if ((own?.n ?? 0) >= 10) throw new HttpError(409, "One person can organise up to 10 lists here.", "too_many");
  const id = uid("soc"), slug = randomHex(8);
  const stmts: D1Stmt[] = [
    env.DB.prepare("INSERT INTO societies (id, name, kind, kind_other, country, tz_offset_min, purpose, verify_slug, created_by, created_at) VALUES (?, ?, 'Others', 'Attendance list', ?, ?, 'attendance_upload', ?, ?, ?)").bind(id, title, country.slice(0, 60), COUNTRY_TZ[country], slug, email, now),
    env.DB.prepare("INSERT INTO memberships (society_id, email, role, status, invited_by, created_at) VALUES (?, ?, 'organizer', 'active', ?, ?)").bind(id, email, email, now),
  ];
  for (let i = 0; i < add.length; i += 250) {
    stmts.push(env.DB.prepare(`INSERT INTO voters (id, society_id, unit, unit_key, name, mobile, email, status, source, revision, created_at, updated_at)
      SELECT json_extract(j.value,'$[0]'), ?, json_extract(j.value,'$[1]'), json_extract(j.value,'$[2]'), json_extract(j.value,'$[3]'), json_extract(j.value,'$[4]'), json_extract(j.value,'$[5]'), 'approved', 'upload', 1, ?, ? FROM json_each(?) j ORDER BY j.key`)
      .bind(id, now, now, JSON.stringify(add.slice(i, i + 250).map((a) => [uid("vtr"), a.unit, a.unitKey, a.name, a.mobile, a.email]))));
  }
  await commit(env, id, stmts, "attendance.roster_uploaded", await staffActor(env, email, "organizer"), { count: add.length, skipped: Object.values(skipped).reduce((a, b) => a + b, 0), format }, now);
  return { dryRun: false, list: { id, name: title, link: `/v/${slug}` }, added: add.length, ...report };
}
