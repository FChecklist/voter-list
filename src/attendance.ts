// Attendance Management (first chunk): a session for a list, one mark per voter per session, and a public count with no personal data.
// The list is either a Voter List, or a list made from an uploaded Excel sheet (purpose 'attendance_upload'). Both are `societies` rows with `voters`,
// so masking, roles and the signed audit trail are exactly those of the Voter List.
import { ERR, badCountry, COUNTRY_TZ, MODE_WORDS, ROSTER_WHY, UPLOAD_ERRORS } from "./error-messages";
import { HttpError, rateLimit, signupOpen, isListedOrganizer } from "./auth";
import { commit, guardChanged, guardExists, guardMissing, looksPrivate, pseudonym, staffActor } from "./audit";
import { uid, type D1Stmt, type Env } from "./db";
import { localToMs, msToLocal, noContactDetails } from "./lists";
import { parseUpload } from "./importer";
import { toCsv } from "./csv";
import { need, seesFull, buildRoll, type SocietyRow, type StaffCtx } from "./store";
import { cleanEmail, squeeze } from "./text";
import { fromB64url, randomHex } from "./vendor/crypto";
import { maskEmail, maskName } from "./vendor/masking";

export const MODES = ["in_person", "online", "offline"] as const;
export type Mode = (typeof MODES)[number];
const SELF_MARK_LATE_MS = 12 * 3_600_000; // and until 12 hours after it starts
const SELF_MARK_EARLY_MS = 15 * 60_000; // a voter can mark themselves from 15 minutes before the start

interface SessionRow { id: string; society_id: string; title: string; starts_at: number; place: string; mode: Mode; status: "open" | "closed"; created_by: string; created_at: number; closed_at: number | null }

/** One session as a page reads it. The title and the place are free text typed by the Organizer, so `withText` false leaves both out (the time, how, state and counts stay). */
const viewSession = (s: SessionRow, tz: number, eligible: number, present: number, withText = true) => ({
  id: s.id, ...(withText ? { title: s.title } : {}), startsAt: msToLocal(s.starts_at, tz), ...(withText ? { place: s.place } : {}), mode: s.mode, modeText: MODE_WORDS[s.mode], status: s.status, closedAt: s.closed_at, counts: { eligible, present },
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
  if (!s) throw new HttpError(404, ERR.notFound, "not_found");
  return s;
}
const notErased = (s: SocietyRow) => { if (s.erased_at) throw new HttpError(410, ERR.erased, "erased"); };

/** Free text shown on public pages: control characters are removed before anything else. */
const noControls = (v: unknown) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

export interface SessionInput { title?: unknown; startsAt?: unknown; place?: unknown; mode?: unknown }

export async function createSession(ctx: StaffCtx, input: SessionInput) {
  need(ctx, "attendSetup"); notErased(ctx.society);
  const title = squeeze(noControls(input.title)); if (title.length < 2 || title.length > 80) throw new HttpError(400, ERR.badTitle, "bad_title");
  const place = squeeze(noControls(input.place)).slice(0, 120);
  noContactDetails(title, "the title"); noContactDetails(place, "the place");
  if (!(MODES as readonly string[]).includes(String(input.mode))) throw new HttpError(400, ERR.badMode, "bad_mode");
  const at = localToMs(String(input.startsAt ?? ""), ctx.society.tz_offset_min); if (at === null) throw new HttpError(400, ERR.badTime, "bad_time");
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

/** The one form of an e-mail ID that is compared and turned into a private code: the same tidy-up the sign-in and the uploads use (spaces, capitals, mailto:, < >, a trailing dot or comma), then small letters. */
const idOf = (email: string) => cleanEmail(email).value.toLowerCase();
const sameId = (a: string, b: string) => { const x = idOf(a); return x !== "" && x === idOf(b); };

/** Which view a team member has: the Organizer sees names and e-mail IDs in full, a co-organizer sees them partly hidden (the rule of the Voter List, `seesFull`). The page and the sheet both follow it. */
const viewOf = (ctx: Pick<StaffCtx, "role">): "full" | "limited" => (seesFull(ctx) ? "full" : "limited");

/** One session for the team: counts, who is present (masked for a co-organizer), which view this is, and a find box. The Organizer finds a person by flat / member ID or name; a co-organizer by flat / member ID only, because a name typed into the box must not show which row holds it. */
export async function openSession(ctx: StaffCtx, id: string, find = "") {
  need(ctx, "view"); notErased(ctx.society);
  const s = await sessionOf(ctx.env, ctx.society.id, id);
  const full = seesFull(ctx);
  const marks = new Map((await ctx.env.DB.prepare("SELECT voter_id, method, marked_at FROM att_marks WHERE session_id = ?").bind(id).all<{ voter_id: string; method: string; marked_at: number }>()).results.map((m) => [m.voter_id, m]));
  const q = squeeze(find).toLowerCase();
  const lines = await eligibleLines(ctx.env, ctx.society.id);
  const shown = lines.filter((l) => !q || l.row.unit.toLowerCase().includes(q) || (full && l.row.name.toLowerCase().includes(q))).slice(0, 50)
    .map((l) => ({ voterId: l.voterId, unit: l.row.unit, name: full ? l.row.name : maskName(l.row.name), email: full ? l.row.email : maskEmail(l.row.email), present: marks.has(l.voterId), method: marks.get(l.voterId)?.method ?? null, markedAt: marks.get(l.voterId)?.marked_at ?? null }));
  return { session: viewSession(s, ctx.society.tz_offset_min, lines.length, marks.size), people: shown, view: viewOf(ctx) };
}

/** A simple attendance sheet for one session, as CSV: everyone who may attend, present or not. A co-organizer gets the limited view: names and e-mail IDs partly hidden, said in the column names and in the file name. Every download leaves a row in the signed log. */
export async function sheetCsv(ctx: StaffCtx, id: string) {
  need(ctx, "view"); notErased(ctx.society);
  const s = await sessionOf(ctx.env, ctx.society.id, id);
  const full = seesFull(ctx);
  const marks = new Map((await ctx.env.DB.prepare("SELECT voter_id, method, marked_at FROM att_marks WHERE session_id = ?").bind(id).all<{ voter_id: string; method: string; marked_at: number }>()).results.map((m) => [m.voter_id, m]));
  const lines = await eligibleLines(ctx.env, ctx.society.id);
  const rows: unknown[][] = [["Flat / House / Member ID", full ? "Name" : "Name (partly hidden)", full ? "E-mail ID" : "E-mail ID (partly hidden)", "Present", "Marked how", "Marked at"]];
  for (const l of lines) {
    const m = marks.get(l.voterId);
    rows.push([l.row.unit, full ? l.row.name : maskName(l.row.name), full ? l.row.email : maskEmail(l.row.email), m ? "Yes" : "No", m ? (m.method === "email" ? "E-mail code" : "Organizer or co-organizer") : "", m ? msToLocal(m.marked_at, ctx.society.tz_offset_min) : ""]);
  }
  await commit(ctx.env, ctx.society.id, [], "attendance.sheet_exported", await staffActor(ctx.env, ctx.email, ctx.role), { session: s.id, lines: lines.length, full }, ctx.now);
  return { body: toCsv(rows), type: "text/csv; charset=utf-8", filename: full ? "attendance-sheet.csv" : "attendance-sheet-limited.csv", view: viewOf(ctx) };
}

/** For a signed-in voter: where this e-mail ID is on the list (flat / member ID only), so the page can ask which one when there is more than one. */
export async function myRows(env: Env, society: SocietyRow, email: string) {
  notErased(society);
  const mine = (await eligibleLines(env, society.id)).filter((l) => sameId(l.row.email, email));
  return { email, list: society.name, rows: mine.map((l) => ({ voterId: l.voterId, unit: l.row.unit })) };
}

/** The lists an Organizer or co-organizer can run attendance for: Voter Lists and lists made from an uploaded sheet. `link` is the voter page for attendance. */
export async function myLists(env: Env, email: string) {
  const rs = await env.DB.prepare("SELECT s.id, s.name, s.purpose, s.verify_slug, m.role FROM memberships m JOIN societies s ON s.id = m.society_id WHERE m.email = ? AND m.status = 'active' AND s.erased_at IS NULL ORDER BY s.created_at DESC LIMIT 200").bind(email).all<{ id: string; name: string; purpose: string; verify_slug: string; role: string }>();
  return { email, countries: Object.keys(COUNTRY_TZ), lists: rs.results.map((x) => ({ id: x.id, name: x.name, kind: x.purpose === "attendance_upload" ? "sheet" : "voter_list", role: x.role === "organizer" ? "organizer" : "co-organizer", link: `/attend/${x.verify_slug}` })) };
}

async function mark(env: Env, society: SocietyRow, s: SessionRow, voterId: string, method: "email" | "organizer", actorEmail: string, actorRole: string, now: number) {
  notErased(society);
  if (s.status !== "open") throw new HttpError(409, ERR.closed, "closed");
  const line = (await eligibleLines(env, society.id)).find((l) => l.voterId === voterId);
  if (!line) throw new HttpError(404, ERR.personNotOnList, "not_on_list");
  if (await env.DB.prepare("SELECT 1 AS x FROM att_marks WHERE session_id = ? AND voter_id = ?").bind(s.id, voterId).first()) throw new HttpError(409, ERR.alreadyPresent, "already_present");
  const pid = await pseudonym(env, idOf(actorEmail));
  // An e-mail ID counts as one person, even when it is on more than one flat: it can mark one person in a session. (The team marks by flat and is not held to this;
  // the database holds the same rule for every mark made by e-mail code, so two requests at the same moment still give one mark.)
  const byThisEmail = "SELECT 1 FROM att_marks WHERE session_id = ? AND method = 'email' AND marked_by = ? AND voter_id <> ?"; // another person: the same one twice is "already marked present"
  if (method === "email" && (await env.DB.prepare(byThisEmail).bind(s.id, pid, voterId).first())) throw new HttpError(409, ERR.onePerEmail, "one_per_email");
  const stmts: D1Stmt[] = [
    guardExists(env, ERR.closedMeanwhile, "SELECT 1 FROM att_sessions WHERE id = ? AND status = 'open'", s.id),
    ...(method === "email" ? [guardMissing(env, ERR.onePerEmail, byThisEmail, s.id, pid, voterId)] : []),
    env.DB.prepare("INSERT OR IGNORE INTO att_marks (session_id, society_id, voter_id, method, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?)").bind(s.id, society.id, voterId, method, pid, now),
    guardChanged(env, ERR.alreadyPresent),
  ];
  // the signed log names the voter and the marker only by private codes, and the flat only in a form that carries no phone number or e-mail ID
  await commit(env, society.id, stmts, "attendance.marked", { pid, role: actorRole }, { session: s.id, voter: await pseudonym(env, idOf(line.row.email) + "|" + voterId), unit: looksPrivate(line.row.unit) ? "#" : line.row.unit, method, mode: s.mode }, now);
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
  if (s.mode !== "online") throw new HttpError(403, ERR.notOnline, "not_online");
  if (now < s.starts_at - SELF_MARK_EARLY_MS) throw new HttpError(403, ERR.tooEarly, "too_early");
  if (now > s.starts_at + SELF_MARK_LATE_MS) throw new HttpError(403, ERR.tooLate, "too_late");
  const mine = (await eligibleLines(env, society.id)).filter((l) => sameId(l.row.email, email));
  if (!mine.length) throw new HttpError(403, ERR.emailNotOnList, "not_on_list");
  const want = voterId === undefined ? "" : String(voterId).slice(0, 60);
  const line = want ? mine.find((l) => l.voterId === want) : mine.length === 1 ? mine[0] : undefined;
  if (!line) throw new HttpError(400, ERR.whichOne, "which_one");
  const r = await mark(env, society, s, line.voterId, "email", email, "voter", now);
  return { ...r, counts: await counts(env, society, sessionId) };
}

export async function closeSession(ctx: StaffCtx, sessionId: string) {
  need(ctx, "attendSetup"); notErased(ctx.society);
  const s = await sessionOf(ctx.env, ctx.society.id, sessionId);
  await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE att_sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").bind(ctx.now, s.id), guardChanged(ctx.env, ERR.alreadyClosed),
  ], "attendance.session_closed", await staffActor(ctx.env, ctx.email, ctx.role), { session: s.id }, ctx.now);
  const { eligible, present } = await counts(ctx.env, ctx.society, s.id);
  return { session: viewSession(await sessionOf(ctx.env, ctx.society.id, s.id), ctx.society.tz_offset_min, eligible, present) };
}

/** Is this e-mail ID one of the people on the list now (approved and allowed to attend)? */
const onTheList = (lines: Array<{ row: { email: string } }>, email: string | null) => !!email && lines.some((l) => sameId(l.row.email, email));

/**
 * Public: times, how, state and counts. No names, no e-mail IDs, no flat numbers.
 * The title and the place are free text typed by the Organizer. On a link that anyone can reach they are shown only to a voter who signed in with the e-mail code
 * for this link and is on its list: `viewer` is that e-mail ID, or null. This holds for every kind of list, a Voter List and a list made from an uploaded sheet alike.
 * `personal` says the answer holds text for this voter only, so the caller must not let it be cached or shared.
 */
export async function publicSessions(env: Env, society: SocietyRow, viewer: string | null = null) {
  const rs = await env.DB.prepare("SELECT * FROM att_sessions WHERE society_id = ? ORDER BY starts_at DESC, id LIMIT 100").bind(society.id).all<SessionRow>();
  const lines = society.erased_at ? [] : await eligibleLines(env, society.id);
  const personal = onTheList(lines, viewer);
  const out = []; for (const s of rs.results) { const c = await counts(env, society, s.id, lines.length); out.push(viewSession(s, society.tz_offset_min, c.eligible, c.present, personal)); }
  return { body: { list: society.name, sessions: out }, personal };
}
export async function publicSession(env: Env, society: SocietyRow, id: string, viewer: string | null = null) {
  const s = await sessionOf(env, society.id, id);
  const lines = society.erased_at ? [] : await eligibleLines(env, society.id);
  const personal = onTheList(lines, viewer);
  const c = await counts(env, society, id, lines.length);
  return { body: { list: society.name, session: viewSession(s, society.tz_offset_min, c.eligible, c.present, personal) }, personal };
}

// ------------------------------------------------------------------------------------------------------------------ Excel upload for an organizer with no Voter List
export interface RosterInput { title?: unknown; country?: unknown; format?: unknown; text?: unknown; base64?: unknown; dryRun?: unknown }

/** Reads the sheet, refuses rows with no e-mail ID (and says how many and why), and, unless `dryRun`, makes the list. */
export async function uploadRoster(env: Env, now: number, email: string, input: RosterInput) {
  if (!signupOpen(env) && !isListedOrganizer(env, email)) throw new HttpError(403, ERR.notOrganizer, "not_organizer");
  const format = String(input.format);
  if (!["csv", "xlsx", "paste"].includes(format)) throw new HttpError(400, ERR.badFormat, "bad_format");
  const title = squeeze(noControls(input.title)); if (title.length < 2 || title.length > 80) throw new HttpError(400, ERR.badListName, "bad_title");
  noContactDetails(title, "the name");
  const country = squeeze(input.country) || "India";
  if (!Object.hasOwn(COUNTRY_TZ, country)) throw new HttpError(400, badCountry(Object.keys(COUNTRY_TZ)), "bad_country");
  await rateLimit(env, `roster:${email}`, 20, 3_600_000, now);
  let parsed;
  try {
    const b64 = typeof input.base64 === "string" ? input.base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";
    parsed = await parseUpload({ format: format as "csv" | "xlsx" | "paste", text: typeof input.text === "string" ? input.text : undefined, bytes: b64 ? fromB64url(b64) : undefined }, { country, ruleCode: 1 });
  } catch (e) { // only the sheet reader's own messages (they have Hindi lines) reach the person; a fault inside the reader or the decoder is "That file could not be read."
    const m = String((e as Error)?.message ?? ""); throw new HttpError(400, UPLOAD_ERRORS.includes(m) ? m : ERR.badFile, "bad_file");
  }
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
    why: ROSTER_WHY,
    problems: parsed.problems.slice(0, 50), unknownColumns: parsed.unknownColumns,
    sample: add.slice(0, 5).map((a) => ({ unit: a.unit, name: maskName(a.name), email: maskEmail(a.email) })),
  };
  if (input.dryRun === true) return { dryRun: true, ...report };
  if (!add.length) throw new HttpError(409, ERR.nothingNew, "nothing_new");
  if (add.length > 6000) throw new HttpError(400, ERR.tooMany, "too_many");
  const own = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE email = ? AND status = 'active' AND role = 'organizer'").bind(email).first<{ n: number }>();
  if ((own?.n ?? 0) >= 10) throw new HttpError(409, ERR.tooManyLists, "too_many");
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
