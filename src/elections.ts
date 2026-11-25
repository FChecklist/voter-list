// Elections (first chunk): set up an election for a voter list, give the notice, take nominations, scrutinise them, publish the final candidate list,
// open and close voting. The ballot itself is in elections-vote.ts, the count and the result in elections-count.ts.
//
// The election READS the final (frozen) voter list of the same list (a row of `publications` with its `publication_rows`); it never changes it.
// Everything that changes is written in one batch with its signed audit entry and one line of the public election trail (el_events).
import { HttpError, rateLimit } from "./auth";
import { commit, guardChanged, guardExists, pseudonym, pubUnit, staffActor } from "./audit";
import { uid, type D1Stmt, type Env } from "./db";
import { EL, MODE_WORDS } from "./election-messages";
import { attendanceSessionExists } from "./elections-links";
import { localToMs, msToLocal, noContactDetails } from "./lists";
import { need, type SocietyRow, type StaffCtx } from "./store";
import { cleanEmail, squeeze } from "./text";
import { canonical } from "./vendor/canonical";
import { randomHex, sha256Hex } from "./vendor/crypto";
import { maskEmail } from "./vendor/masking";

export const MODES = ["in_person", "online", "offline", "mixed"] as const;
export type ElMode = (typeof MODES)[number];
export type ElStatus = "draft" | "notice" | "candidates_final" | "voting" | "closed" | "counted" | "declared";
export type OfficialRole = "returning_officer" | "counting_agent" | "observer";
export const MIN_WEIGHT_GROUP = 5;
export const HOUR = 3_600_000;

export interface ElectionRow {
  id: string; society_id: string; title: string; term: string; mode: ElMode; status: ElStatus; weighting: "equal" | "by_list"; nota: number; random_order: number; uncontested: string; tie_rule: string;
  appeal_hours: number; challenge_hours: number; nominations_open_at: number; nominations_close_at: number; withdrawal_close_at: number; voting_open_at: number; voting_close_at: number;
  seal_salt: string; attendance_session_id: string | null; roll_pub_id: string | null; roll_fingerprint: string | null; roll_voters: number | null; roll_weight_milli: number | null;
  candidates_fingerprint: string | null; signoff_json: string | null; created_by: string; created_at: number;
  notice_at: number | null; final_at: number | null; opened_at: number | null; closed_at: number | null; counted_at: number | null; declared_at: number | null;
}
export interface PostRow { id: string; election_id: string; n: number; title: string; seats: number; max_votes: number; kind: "pending" | "contested" | "unopposed" | "vacant" }
export interface NomRow {
  id: string; election_id: string; post_id: string; roll_row_id: number; email: string; name: string; unit: string; proposer_roll_id: number; seconder_roll_id: number; declaration: string; statement: string;
  status: "submitted" | "accepted" | "rejected" | "withdrawn"; decided_at: number | null; decided_by: string | null; decision_reason: string; appeal_text: string | null; appealed_at: number | null;
  appeal_status: "open" | "upheld" | "dismissed" | null; appeal_reason: string; appeal_decided_at: number | null; withdrawn_at: number | null; submitted_at: number;
}
export interface OfficialRow { email: string; role: OfficialRole; name: string }
/** One line of the final voter list that may vote: the election's own view of a voter. `id` is the line's id in `publication_rows`. */
export interface RollLine { id: number; unit: string; unit_key: string; name: string; email: string; weight_milli: number }

// ------------------------------------------------------------------------------------------------------------------ switch, small helpers
/** Elections are dark until the owner switches them on: every Elections address answers "not found" unless ELECTIONS_ENABLED is "1". */
export const electionsOn = (env: Env): boolean => env.ELECTIONS_ENABLED === "1";
export function gate(env: Env): void { if (!electionsOn(env)) throw new HttpError(404, EL.notFound, "not_found"); }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // plain code-point order: the same on every machine, so a fingerprint is the same everywhere
const noControls = (v: unknown) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
export const clean = (v: unknown, max: number): string => squeeze(noControls(v)).slice(0, max);
const tzLabel = (min: number) => `UTC${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}:${String(Math.abs(min) % 60).padStart(2, "0")}`;
export const confirmIs = (v: unknown, word: string) => String(v ?? "").trim().toUpperCase() === word;

export async function getElection(env: Env, societyId: string, eid: string): Promise<ElectionRow> {
  const e = await env.DB.prepare("SELECT * FROM el_elections WHERE society_id = ? AND id = ?").bind(societyId, String(eid).slice(0, 60)).first<ElectionRow>();
  if (!e) throw new HttpError(404, EL.notFound, "not_found");
  return e;
}
export const postsOf = async (env: Env, eid: string): Promise<PostRow[]> => (await env.DB.prepare("SELECT * FROM el_posts WHERE election_id = ? ORDER BY n").bind(eid).all<PostRow>()).results;
export const officialsOf = async (env: Env, eid: string): Promise<OfficialRow[]> => (await env.DB.prepare("SELECT email, role, name FROM el_officials WHERE election_id = ? ORDER BY CASE role WHEN 'returning_officer' THEN 0 WHEN 'counting_agent' THEN 1 ELSE 2 END, name").bind(eid).all<OfficialRow>()).results;
export const nominationsOf = async (env: Env, eid: string): Promise<NomRow[]> => (await env.DB.prepare("SELECT * FROM el_nominations WHERE election_id = ? ORDER BY submitted_at, id").bind(eid).all<NomRow>()).results;

const ROLL_COLS = "id, unit, unit_key, name, email, weight_milli";
/** Everyone on the final voter list who may vote (the one authorised voter of a flat or house). */
export async function rollLines(env: Env, e: Pick<ElectionRow, "roll_pub_id">): Promise<RollLine[]> {
  if (!e.roll_pub_id) return [];
  return (await env.DB.prepare(`SELECT ${ROLL_COLS} FROM publication_rows WHERE publication_id = ? AND is_voter = 1 AND can_vote = 1 ORDER BY seq`).bind(e.roll_pub_id).all<RollLine>()).results;
}
export async function rollFor(env: Env, e: Pick<ElectionRow, "roll_pub_id">, email: string): Promise<RollLine[]> {
  if (!e.roll_pub_id) return [];
  return (await env.DB.prepare(`SELECT ${ROLL_COLS} FROM publication_rows WHERE publication_id = ? AND is_voter = 1 AND can_vote = 1 AND lower(email) = ? ORDER BY seq`).bind(e.roll_pub_id, email.trim().toLowerCase()).all<RollLine>()).results;
}
export async function rollRow(env: Env, e: Pick<ElectionRow, "roll_pub_id">, id: number): Promise<RollLine | null> {
  if (!e.roll_pub_id) return null;
  return env.DB.prepare(`SELECT ${ROLL_COLS} FROM publication_rows WHERE publication_id = ? AND is_voter = 1 AND can_vote = 1 AND id = ?`).bind(e.roll_pub_id, id).first<RollLine>();
}
/** The weight a vote carries: 1 for everyone, or the flat's weight on the list. */
export const weightOf = (e: Pick<ElectionRow, "weighting">, line: Pick<RollLine, "weight_milli">): number => (e.weighting === "by_list" ? line.weight_milli : 1000);
/** Weighted votes keep a person's weight on the ballot, so each weight must be shared by at least MIN_WEIGHT_GROUP voters, or the weight could point at one person. */
export function weightGroupsOk(lines: Array<Pick<RollLine, "weight_milli">>): boolean {
  const g = new Map<number, number>(); for (const l of lines) g.set(l.weight_milli, (g.get(l.weight_milli) ?? 0) + 1);
  return [...g.values()].every((n) => n >= MIN_WEIGHT_GROUP);
}

/** One line of the public election trail, written in the same batch as the change it describes. `summary` carries no personal data. */
export function eventStmt(env: Env, societyId: string, eid: string, now: number, type: string, role: string, summary: string): D1Stmt {
  return env.DB.prepare("INSERT INTO el_events (election_id, n, ts, type, role, summary, audit_seq) VALUES (?, (SELECT IFNULL(MAX(n), 0) + 1 FROM el_events WHERE election_id = ?), ?, ?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM audit_entries WHERE society_id = ?))")
    .bind(eid, eid, now, type, role, summary.slice(0, 300), societyId);
}

// ------------------------------------------------------------------------------------------------------------------ independence
/** Everyone who can run an election of this list now: the Organizer and every active co-organizer (lower case). */
export const staffEmailsOf = async (env: Env, societyId: string, role?: "organizer"): Promise<string[]> =>
  (await env.DB.prepare(`SELECT email FROM memberships WHERE society_id = ? AND status = 'active'${role ? " AND role = 'organizer'" : ""}`).bind(societyId).all<{ email: string }>()).results.map((r) => r.email.toLowerCase());
const officerOf = async (env: Env, eid: string): Promise<string | null> => (await officialsOf(env, eid)).find((o) => o.role === "returning_officer")?.email.toLowerCase() ?? null;

// ------------------------------------------------------------------------------------------------------------------ who is acting
export type ActorRole = "organizer" | "co-organizer" | OfficialRole;
export interface Sessions { staffEmail: string | null; memberEmail: string | null }
/** The role a person acts in for one election: an official named for it, or the Organizer / a co-organizer of the list. `allowed` says which roles the action accepts. */
export async function actorFor(env: Env, society: SocietyRow, e: ElectionRow, s: Sessions, allowed: readonly ActorRole[]): Promise<{ role: ActorRole; email: string }> {
  const emails = [s.staffEmail, s.memberEmail].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  if (!emails.length) throw new HttpError(401, EL.signedOut, "signed_out");
  for (const email of emails) {
    const rs = (await env.DB.prepare("SELECT role FROM el_officials WHERE election_id = ? AND email = ?").bind(e.id, email).all<{ role: OfficialRole }>()).results;
    for (const o of rs) if (allowed.includes(o.role)) return { role: o.role, email };
  }
  if (s.staffEmail) {
    const m = await env.DB.prepare("SELECT role FROM memberships WHERE society_id = ? AND email = ? AND status = 'active'").bind(society.id, s.staffEmail.toLowerCase()).first<{ role: string }>();
    if (m) { const r: ActorRole = m.role === "organizer" ? "organizer" : "co-organizer"; if (allowed.includes(r)) return { role: r, email: s.staffEmail.toLowerCase() }; }
  }
  throw new HttpError(403, EL.forbidden, "forbidden");
}

// ------------------------------------------------------------------------------------------------------------------ the rules in plain words
const whenWords = (ms: number, tz: number) => msToLocal(ms, tz).replace("T", " ") + ` (${tzLabel(tz)})`;
export function rulesInWords(e: ElectionRow, posts: PostRow[], society: Pick<SocietyRow, "tz_offset_min" | "name">): string[] {
  const tz = society.tz_offset_min;
  const out: string[] = [];
  out.push(`Election: ${e.title}${e.term ? `, term ${e.term}` : ""}, for ${society.name}.`);
  out.push(`How people vote: ${MODE_WORDS[e.mode].toLowerCase()}.`);
  out.push(e.roll_pub_id ? `Who may vote: each person marked as the voter for a flat or house on the final voter list (${e.roll_voters ?? 0} people), fixed on ${msToLocal(e.notice_at ?? 0, tz).replace("T", " ")}.` : "Who may vote: each person marked as the voter for a flat or house on the final voter list. The list is fixed when the notice goes out.");
  out.push("Who may stand: a person who is on the final voter list as a voter. The returning officer, the counting agents, the observers, the Organizer and the co-organizers cannot stand.");
  for (const p of posts) out.push(`Post ${p.n}, ${p.title}: ${p.seats} seat${p.seats === 1 ? "" : "s"}; each voter may choose up to ${p.max_votes}.`);
  out.push(e.weighting === "equal" ? "Every vote counts the same." : "A vote counts as many parts as the voter list gives to the flat or house.");
  out.push(e.nota ? "The ballot has a \"none of the above\" choice for each post." : "The ballot has no \"none of the above\" choice.");
  out.push(e.random_order ? "Names are shown in a new random order to each voter." : "Names are shown in alphabetical order.");
  out.push("Each voter gets one ballot. The system keeps who voted apart from what was chosen, and nobody can join the two.");
  out.push("A post with no more candidates than seats is declared elected without a vote.");
  out.push("A tie for the last seat is settled by a draw. The draw is recorded with its number, so anyone can check it.");
  out.push(`Nominations open ${whenWords(e.nominations_open_at, tz)} and close ${whenWords(e.nominations_close_at, tz)}. A candidate can withdraw until ${whenWords(e.withdrawal_close_at, tz)}.`);
  out.push(`A rejected nomination can be appealed within ${e.appeal_hours} hour${e.appeal_hours === 1 ? "" : "s"} of the decision.`);
  out.push(`Voting opens ${whenWords(e.voting_open_at, tz)} and closes ${whenWords(e.voting_close_at, tz)}. A longer time needs a written reason, and everyone can read it.`);
  out.push(`After the count, anyone on the voter list can send a challenge for ${e.challenge_hours} hour${e.challenge_hours === 1 ? "" : "s"}. The result is declared after every challenge has an answer.`);
  return out;
}

const NEXT: Record<ElStatus, string> = {
  draft: "Name the returning officer, check the rules, then issue the notice.",
  notice: "Voters send nominations. The returning officer accepts or rejects each one with a reason. Then publish the final candidate list.",
  candidates_final: "Open voting when ready. Voters can vote only between the voting open and close times.",
  voting: "Voting is on. After the closing time, close voting.",
  closed: "Count the votes.",
  counted: "Wait for the challenge time to end and answer every challenge. Then declare the result.",
  declared: "The result is declared. The report can be read by anyone.",
};

// ------------------------------------------------------------------------------------------------------------------ create and change the draft
export interface ElectionInput {
  title?: unknown; term?: unknown; mode?: unknown; posts?: unknown; weighting?: unknown; nota?: unknown; randomOrder?: unknown; appealHours?: unknown; challengeHours?: unknown;
  schedule?: unknown; officials?: unknown; attendanceSessionId?: unknown;
}
interface Parsed { cols: Record<string, string | number | null>; posts?: Array<{ title: string; seats: number; maxVotes: number }>; officials?: OfficialRow[] }
const SCHED: Array<[string, string]> = [["nominationsOpen", "nominations_open_at"], ["nominationsClose", "nominations_close_at"], ["withdrawalClose", "withdrawal_close_at"], ["votingOpen", "voting_open_at"], ["votingClose", "voting_close_at"]];

async function parseDraft(ctx: StaffCtx, input: ElectionInput, base: ElectionRow | null): Promise<Parsed> {
  const tz = ctx.society.tz_offset_min;
  const out: Parsed = { cols: {} };
  if (input.title !== undefined || !base) { const t = clean(input.title, 200); if (t.length < 2 || t.length > 80) throw new HttpError(400, EL.badTitle, "bad_title"); noContactDetails(t, "the title"); out.cols.title = t; }
  if (input.term !== undefined) { const t = clean(input.term, 200); if (t.length > 60) throw new HttpError(400, EL.badTerm, "bad_term"); noContactDetails(t, "the term"); out.cols.term = t; }
  if (input.mode !== undefined || !base) { if (!(MODES as readonly string[]).includes(String(input.mode))) throw new HttpError(400, EL.badMode, "bad_mode"); out.cols.mode = String(input.mode); }
  if (input.weighting !== undefined) { if (input.weighting !== "equal" && input.weighting !== "by_list") throw new HttpError(400, EL.badWeighting, "bad_weighting"); out.cols.weighting = input.weighting; }
  if (input.nota !== undefined) out.cols.nota = input.nota === true ? 1 : 0;
  if (input.randomOrder !== undefined) out.cols.random_order = input.randomOrder === false ? 0 : 1;
  for (const [k, col] of [["appealHours", "appeal_hours"], ["challengeHours", "challenge_hours"]] as const) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]); if (!Number.isInteger(n) || n < 1 || n > 336) throw new HttpError(400, EL.badHours, "bad_hours"); out.cols[col] = n;
  }
  const mode = (out.cols.mode as string | undefined) ?? base?.mode, weighting = (out.cols.weighting as string | undefined) ?? base?.weighting ?? "equal";
  if (weighting === "by_list" && mode !== "online") throw new HttpError(400, EL.weightedOnline, "weighted_online");
  // the five times, typed in the list's own time zone
  const sch = (input.schedule && typeof input.schedule === "object" ? input.schedule : {}) as Record<string, unknown>;
  const t: Record<string, number> = {};
  for (const [k, col] of SCHED) {
    if (sch[k] !== undefined) { const ms = localToMs(String(sch[k]), tz); if (ms === null) throw new HttpError(400, EL.badTime, "bad_time"); t[col] = ms; out.cols[col] = ms; }
    else if (base) t[col] = (base as unknown as Record<string, number>)[col]!;
    else throw new HttpError(400, EL.badTime, "bad_time");
  }
  if (!(t.nominations_open_at! < t.nominations_close_at! && t.nominations_close_at! <= t.withdrawal_close_at! && t.withdrawal_close_at! <= t.voting_open_at! && t.voting_open_at! < t.voting_close_at!)) throw new HttpError(400, EL.badOrder, "bad_order");
  if (input.posts !== undefined || !base) {
    const arr = Array.isArray(input.posts) ? input.posts : [];
    if (!arr.length) throw new HttpError(400, EL.needPosts, "need_posts");
    if (arr.length > 20) throw new HttpError(400, EL.tooManyPosts, "too_many_posts");
    out.posts = arr.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>; const title = clean(o.title, 200); const seats = Number(o.seats); const mv = o.maxVotes === undefined ? seats : Number(o.maxVotes);
      if (title.length < 2 || title.length > 80 || !Number.isInteger(seats) || seats < 1 || seats > 20 || !Number.isInteger(mv) || mv < 1 || mv > seats) throw new HttpError(400, EL.badPost, "bad_post");
      noContactDetails(title, "a post title");
      return { title, seats, maxVotes: mv };
    });
  }
  if (input.officials !== undefined) {
    const o = (input.officials && typeof input.officials === "object" ? input.officials : {}) as Record<string, unknown>;
    const list: OfficialRow[] = [];
    const add = (v: unknown, role: OfficialRole) => {
      const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>; const em = cleanEmail(String(x.email ?? "")); const name = clean(x.name, 200);
      if (!em.ok || name.length > 80) throw new HttpError(400, EL.badOfficial, "bad_official");
      noContactDetails(name, "the name"); list.push({ email: em.value.toLowerCase(), role, name });
    };
    if (o.returningOfficer !== undefined && o.returningOfficer !== null) add(o.returningOfficer, "returning_officer");
    for (const a of Array.isArray(o.countingAgents) ? o.countingAgents.slice(0, 10) : []) add(a, "counting_agent");
    for (const a of Array.isArray(o.observers) ? o.observers.slice(0, 10) : []) add(a, "observer");
    if (new Set(list.map((x) => x.email)).size !== list.length) throw new HttpError(400, EL.officialTwice, "official_twice");
    const ro = list.find((x) => x.role === "returning_officer");
    if (ro && (await staffEmailsOf(ctx.env, ctx.society.id, "organizer")).includes(ro.email)) throw new HttpError(409, EL.officerIsOrganizer, "officer_is_organizer");
    out.officials = list;
  }
  if (input.attendanceSessionId !== undefined) {
    if (input.attendanceSessionId === null || input.attendanceSessionId === "") out.cols.attendance_session_id = null;
    else { const sid = String(input.attendanceSessionId).slice(0, 60); if (!(await attendanceSessionExists(ctx.env, ctx.society.id, sid))) throw new HttpError(400, EL.badAttendance, "bad_attendance"); out.cols.attendance_session_id = sid; }
  }
  return out;
}

function draftStatements(ctx: StaffCtx, id: string, p: Parsed): D1Stmt[] {
  const db = ctx.env.DB, stmts: D1Stmt[] = [];
  if (p.posts) {
    stmts.push(db.prepare("DELETE FROM el_posts WHERE election_id = ?").bind(id));
    p.posts.forEach((x, i) => stmts.push(db.prepare("INSERT INTO el_posts (id, election_id, n, title, seats, max_votes) VALUES (?, ?, ?, ?, ?, ?)").bind(uid("elp"), id, i + 1, x.title, x.seats, x.maxVotes)));
  }
  if (p.officials) {
    stmts.push(db.prepare("DELETE FROM el_officials WHERE election_id = ?").bind(id));
    for (const o of p.officials) stmts.push(db.prepare("INSERT INTO el_officials (election_id, email, role, name, added_at) VALUES (?, ?, ?, ?, ?)").bind(id, o.email, o.role, o.name, ctx.now));
  }
  return stmts;
}

export async function createElection(ctx: StaffCtx, input: ElectionInput) {
  gate(ctx.env); need(ctx, "elections");
  if (ctx.society.erased_at) throw new HttpError(410, EL.erased, "erased");
  const p = await parseDraft(ctx, input, null);
  const id = uid("elc"), by = await pseudonym(ctx.env, ctx.email);
  const cols = { ...p.cols, id, society_id: ctx.society.id, seal_salt: randomHex(16), created_by: by, created_at: ctx.now } as Record<string, string | number | null>;
  const stmts: D1Stmt[] = [ctx.env.DB.prepare(`INSERT INTO el_elections (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).bind(...Object.values(cols)), ...draftStatements(ctx, id, p)];
  stmts.push(eventStmt(ctx.env, ctx.society.id, id, ctx.now, "election.created", "organizer", "The election was set up as a draft."));
  const seq = await commit(ctx.env, ctx.society.id, stmts, "election.created", await staffActor(ctx.env, ctx.email, ctx.role), { election: id, posts: p.posts?.length ?? 0 }, ctx.now);
  return { election: await staffView(ctx, id), audit: seq };
}

export async function updateElection(ctx: StaffCtx, eid: string, input: ElectionInput) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "draft") throw new HttpError(409, EL.notDraft, "frozen");
  const p = await parseDraft(ctx, input, e);
  const stmts: D1Stmt[] = [guardExists(ctx.env, EL.notDraft, "SELECT 1 FROM el_elections WHERE id = ? AND status = 'draft'", e.id)];
  const keys = Object.keys(p.cols);
  if (keys.length) stmts.push(ctx.env.DB.prepare(`UPDATE el_elections SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ? AND status = 'draft'`).bind(...Object.values(p.cols), e.id), guardChanged(ctx.env, EL.notDraft));
  stmts.push(...draftStatements(ctx, e.id, p));
  stmts.push(eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.updated", "organizer", "The draft was changed."));
  const seq = await commit(ctx.env, ctx.society.id, stmts, "election.updated", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id, fields: keys.length + (p.posts ? 1 : 0) + (p.officials ? 1 : 0) }, ctx.now);
  return { election: await staffView(ctx, e.id), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ views
export async function listElections(ctx: StaffCtx) {
  gate(ctx.env); need(ctx, "electView");
  const rs = (await ctx.env.DB.prepare("SELECT * FROM el_elections WHERE society_id = ? ORDER BY created_at DESC, id LIMIT 100").bind(ctx.society.id).all<ElectionRow>()).results;
  return { elections: rs.map((e) => ({ id: e.id, title: e.title, term: e.term, status: e.status, mode: e.mode, votingOpens: msToLocal(e.voting_open_at, ctx.society.tz_offset_min), votingCloses: msToLocal(e.voting_close_at, ctx.society.tz_offset_min) })) };
}

const nomView = (n: NomRow, full: boolean) => ({
  id: n.id, post: n.post_id, name: n.name, unit: pubUnit(n.unit), statement: n.statement, status: n.status, submittedAt: n.submitted_at,
  ...(full ? { email: n.email, declaration: n.declaration, decidedAt: n.decided_at, decisionReason: n.decision_reason, appeal: n.appeal_status ? { status: n.appeal_status, text: n.appeal_text, at: n.appealed_at, reason: n.appeal_reason } : null, withdrawnAt: n.withdrawn_at } : {}),
});

async function counts(env: Env, e: ElectionRow) {
  const voted = (await env.DB.prepare("SELECT COUNT(*) AS n FROM el_voted WHERE election_id = ?").bind(e.id).first<{ n: number }>())?.n ?? 0;
  return { voted, eligible: e.roll_voters ?? 0 };
}

/** The whole election for the Organizer and co-organizers. A co-organizer sees the officials' e-mail IDs masked. */
export async function staffView(ctx: StaffCtx, eid: string) {
  gate(ctx.env); need(ctx, "electView");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  const [posts, officials, noms] = await Promise.all([postsOf(ctx.env, e.id), officialsOf(ctx.env, e.id), nominationsOf(ctx.env, e.id)]);
  return {
    ...baseView(e, posts, ctx.society), next: NEXT[e.status],
    officials: officials.map((o) => ({ role: o.role, name: o.name, email: ctx.role === "organizer" ? o.email : maskEmail(o.email) })),
    nominations: noms.map((n) => nomView(n, true)),
    turnout: e.status === "draft" || e.status === "notice" || e.status === "candidates_final" ? null : await counts(ctx.env, e),
  };
}

function baseView(e: ElectionRow, posts: PostRow[], society: Pick<SocietyRow, "tz_offset_min" | "name">) {
  const tz = society.tz_offset_min, L = (ms: number | null) => (ms === null ? null : msToLocal(ms, tz));
  return {
    id: e.id, title: e.title, term: e.term, mode: e.mode, modeText: MODE_WORDS[e.mode], status: e.status,
    schedule: { timeZone: tzLabel(tz), nominationsOpen: L(e.nominations_open_at), nominationsClose: L(e.nominations_close_at), withdrawalClose: L(e.withdrawal_close_at), votingOpen: L(e.voting_open_at), votingClose: L(e.voting_close_at) },
    rules: { weighting: e.weighting, nota: !!e.nota, randomOrder: !!e.random_order, uncontested: e.uncontested, tieRule: e.tie_rule, appealHours: e.appeal_hours, challengeHours: e.challenge_hours, fixed: e.status !== "draft", words: rulesInWords(e, posts, society) },
    posts: posts.map((p) => ({ id: p.id, n: p.n, title: p.title, seats: p.seats, maxVotes: p.max_votes, kind: p.kind })),
    roll: e.roll_pub_id ? { fingerprint: e.roll_fingerprint, voters: e.roll_voters, weightMilli: e.roll_weight_milli, publication: e.roll_pub_id } : null,
    attendanceSessionId: e.attendance_session_id, candidatesFingerprint: e.candidates_fingerprint,
    dates: { noticeAt: e.notice_at, finalAt: e.final_at, openedAt: e.opened_at, closedAt: e.closed_at, countedAt: e.counted_at, declaredAt: e.declared_at },
  };
}

/** What anyone with the common link may read: the rules, the dates, the final candidates (after they are published), the turnout as a number, and the result once declared. */
export async function publicElections(env: Env, society: SocietyRow) {
  gate(env);
  const rs = (await env.DB.prepare("SELECT * FROM el_elections WHERE society_id = ? AND status <> 'draft' ORDER BY created_at DESC, id LIMIT 50").bind(society.id).all<ElectionRow>()).results;
  return { list: society.name, elections: rs.map((e) => ({ id: e.id, title: e.title, term: e.term, status: e.status, modeText: MODE_WORDS[e.mode], votingOpens: msToLocal(e.voting_open_at, society.tz_offset_min), votingCloses: msToLocal(e.voting_close_at, society.tz_offset_min), timeZone: tzLabel(society.tz_offset_min) })) };
}
export async function publicElection(env: Env, society: SocietyRow, eid: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status === "draft") throw new HttpError(404, EL.notFound, "not_found"); // a draft is not public
  const [posts, officials, noms] = await Promise.all([postsOf(env, e.id), officialsOf(env, e.id), nominationsOf(env, e.id)]);
  const final = ["candidates_final", "voting", "closed", "counted", "declared"].includes(e.status);
  const accepted = noms.filter((n) => n.status === "accepted");
  return {
    ...baseView(e, posts, society), next: NEXT[e.status],
    officials: officials.map((o) => ({ role: o.role, name: o.name })),
    nominationsReceived: noms.length,
    candidates: final ? accepted.map((n) => nomView(n, false)) : [],
    turnout: ["voting", "closed", "counted", "declared"].includes(e.status) ? await counts(env, e) : null,
    signoff: e.signoff_json ? JSON.parse(e.signoff_json) : null,
  };
}
export async function publicTrail(env: Env, society: SocietyRow, eid: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status === "draft") throw new HttpError(404, EL.notFound, "not_found");
  const rs = (await env.DB.prepare("SELECT n, ts, type, role, summary, audit_seq FROM el_events WHERE election_id = ? ORDER BY n").bind(e.id).all<{ n: number; ts: number; type: string; role: string; summary: string; audit_seq: number }>()).results;
  return { election: e.id, events: rs.map((x) => ({ n: x.n, at: msToLocal(x.ts, society.tz_offset_min), type: x.type, by: x.role, summary: x.summary, auditSeq: x.audit_seq })) };
}

// ------------------------------------------------------------------------------------------------------------------ the notice: the rules are fixed and the final voter list is linked
export async function issueNotice(ctx: StaffCtx, eid: string, input: { confirm?: unknown; rollPublicationId?: unknown }) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "draft") throw new HttpError(409, EL.notDraft, "frozen");
  if (!confirmIs(input.confirm, "NOTICE")) throw new HttpError(400, EL.confirmNotice, "confirm");
  const [posts, officials] = await Promise.all([postsOf(ctx.env, e.id), officialsOf(ctx.env, e.id)]);
  if (!posts.length) throw new HttpError(400, EL.needPosts, "need_posts");
  if (!officials.some((o) => o.role === "returning_officer")) throw new HttpError(400, EL.needOfficer, "need_officer");
  if ((await officerOf(ctx.env, e.id)) && (await staffEmailsOf(ctx.env, ctx.society.id, "organizer")).includes((await officerOf(ctx.env, e.id))!)) throw new HttpError(409, EL.officerIsOrganizer, "officer_is_organizer");
  if (e.weighting === "by_list" && e.mode !== "online") throw new HttpError(400, EL.weightedOnline, "weighted_online");
  const want = input.rollPublicationId === undefined || input.rollPublicationId === null || input.rollPublicationId === "" ? null : String(input.rollPublicationId).slice(0, 80);
  const pub = await (want
    ? ctx.env.DB.prepare("SELECT id, fingerprint FROM publications WHERE society_id = ? AND kind = 'frozen' AND id = ?").bind(ctx.society.id, want)
    : ctx.env.DB.prepare("SELECT id, fingerprint FROM publications WHERE society_id = ? AND kind = 'frozen' ORDER BY seq DESC LIMIT 1").bind(ctx.society.id)).first<{ id: string; fingerprint: string }>();
  if (!pub) throw new HttpError(409, want ? EL.badRoll : EL.noRoll, want ? "bad_roll" : "no_roll");
  const roll = await rollLines(ctx.env, { roll_pub_id: pub.id });
  if (!roll.length) throw new HttpError(409, EL.emptyRoll, "empty_roll");
  if (e.weighting === "by_list" && !weightGroupsOk(roll)) throw new HttpError(409, EL.weightGroup, "weight_group");
  const weight = roll.reduce((a, l) => a + weightOf(e, l), 0);
  const stmts: D1Stmt[] = [
    ctx.env.DB.prepare("UPDATE el_elections SET status = 'notice', notice_at = ?, roll_pub_id = ?, roll_fingerprint = ?, roll_voters = ?, roll_weight_milli = ? WHERE id = ? AND status = 'draft'").bind(ctx.now, pub.id, pub.fingerprint, roll.length, weight, e.id),
    guardChanged(ctx.env, EL.notDraft),
    eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.notice", "organizer", `The notice was issued. The rules and the final voter list are fixed. ${roll.length} people may vote.`),
  ];
  const seq = await commit(ctx.env, ctx.society.id, stmts, "election.notice", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id, roll: pub.id, rollFingerprint: pub.fingerprint, voters: roll.length, weightMilli: weight }, ctx.now);
  return { election: await staffView(ctx, e.id), audit: seq, mailed: false, note: "The notice is public on the common link. E-mail to every voter is not part of this version." };
}

// ------------------------------------------------------------------------------------------------------------------ nominations
export interface NominationInput { postId?: unknown; rollId?: unknown; proposerEmail?: unknown; seconderEmail?: unknown; declaration?: unknown; statement?: unknown }
export interface MemberCtx { env: Env; now: number; society: SocietyRow; email: string }

/** The voter-list line a signed-in person acts for. One e-mail ID may stand for several flats; then `rollId` says which. */
export async function pickRow(env: Env, e: ElectionRow, email: string, rollId: unknown): Promise<RollLine> {
  const rows = await rollFor(env, e, email);
  if (!rows.length) throw new HttpError(403, EL.notOnRoll, "not_on_roll");
  if (rollId !== undefined && rollId !== null && rollId !== "") { const r = rows.find((x) => x.id === Number(rollId)); if (!r) throw new HttpError(400, EL.badRollId, "bad_roll_id"); return r; }
  if (rows.length > 1) throw new HttpError(400, EL.whichOne, "which_one");
  return rows[0]!;
}

export async function submitNomination(m: MemberCtx, eid: string, input: NominationInput) {
  gate(m.env);
  if (m.society.erased_at) throw new HttpError(410, EL.erased, "erased");
  const e = await getElection(m.env, m.society.id, eid);
  if (e.status !== "notice" || m.now < e.nominations_open_at || m.now >= e.nominations_close_at) throw new HttpError(409, EL.notNominationTime, "not_nomination_time");
  const post = (await postsOf(m.env, e.id)).find((p) => p.id === String(input.postId ?? ""));
  if (!post) throw new HttpError(404, EL.badPost2, "bad_post");
  await rateLimit(m.env, `elnom:${e.id}:${m.email}`, 10, HOUR, m.now);
  const cand = await pickRow(m.env, e, m.email, input.rollId);
  const pe = cleanEmail(String(input.proposerEmail ?? "")), se = cleanEmail(String(input.seconderEmail ?? ""));
  if (!pe.ok || !se.ok || pe.value === se.value || pe.value === m.email.toLowerCase() || se.value === m.email.toLowerCase()) throw new HttpError(400, EL.proposerNeeded, "need_proposer");
  const [prop] = await rollFor(m.env, e, pe.value), [sec] = await rollFor(m.env, e, se.value);
  if (!prop || !sec) throw new HttpError(400, EL.proposerNotOnRoll, "proposer_not_on_roll");
  const declaration = clean(input.declaration, 400); if (declaration.length < 10 || declaration.length > 300) throw new HttpError(400, EL.badDeclaration, "bad_declaration");
  const statement = clean(input.statement, 1000); if (statement.length > 400) throw new HttpError(400, EL.badStatement, "bad_statement");
  noContactDetails(declaration, "the declaration"); noContactDetails(statement, "the statement");
  const email = m.email.toLowerCase();
  if ((await officialsOf(m.env, e.id)).some((o) => o.email.toLowerCase() === email)) throw new HttpError(409, EL.isOfficial, "is_official");
  if ((await pseudonym(m.env, email)) === e.created_by) throw new HttpError(409, EL.isCreator, "is_creator");
  if ((await staffEmailsOf(m.env, m.society.id)).includes(email)) throw new HttpError(409, EL.isStaff, "is_staff"); // the Organizer and every co-organizer, also one added after the election was made
  if (await m.env.DB.prepare("SELECT 1 AS x FROM el_nominations WHERE election_id = ? AND post_id = ? AND roll_row_id = ?").bind(e.id, post.id, cand.id).first()) throw new HttpError(409, EL.stands, "stands");
  const id = uid("nom");
  const seq = await commit(m.env, m.society.id, [
    m.env.DB.prepare("INSERT INTO el_nominations (id, election_id, post_id, roll_row_id, email, name, unit, proposer_roll_id, seconder_roll_id, declaration, statement, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, e.id, post.id, cand.id, email, cand.name, cand.unit, prop.id, sec.id, declaration, statement, m.now),
    guardExists(m.env, EL.notNominationTime, "SELECT 1 FROM el_elections WHERE id = ? AND status = 'notice' AND nominations_open_at <= ? AND nominations_close_at > ?", e.id, m.now, m.now),
    eventStmt(m.env, m.society.id, e.id, m.now, "election.nomination_received", "voter", `A nomination was received for ${post.title}.`),
  ], "election.nomination_received", { pid: await pseudonym(m.env, email), role: "voter" }, { election: e.id, post: post.id, nomination: id }, m.now);
  return { nomination: { id, post: post.id, status: "submitted" }, audit: seq };
}

export async function myNominations(m: MemberCtx, eid: string) {
  gate(m.env);
  const e = await getElection(m.env, m.society.id, eid);
  const rs = (await m.env.DB.prepare("SELECT * FROM el_nominations WHERE election_id = ? AND email = ? ORDER BY submitted_at").bind(e.id, m.email.toLowerCase()).all<NomRow>()).results;
  return { nominations: rs.map((n) => ({ ...nomView(n, true), appealUntil: n.status === "rejected" && n.decided_at ? n.decided_at + e.appeal_hours * HOUR : null })) };
}

/** The returning officer accepts or rejects a nomination. A rejection needs a written reason that the candidate can read. */
export async function decideNomination(env: Env, now: number, society: SocietyRow, actor: { role: ActorRole; email: string }, eid: string, nid: string, input: { decision?: unknown; reason?: unknown }) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (actor.role !== "returning_officer") throw new HttpError(403, EL.forbidden, "forbidden");
  if (e.status !== "notice") throw new HttpError(409, EL.notStatus, "bad_status");
  const n = await env.DB.prepare("SELECT * FROM el_nominations WHERE election_id = ? AND id = ?").bind(e.id, String(nid).slice(0, 60)).first<NomRow>();
  if (!n) throw new HttpError(404, EL.badNomination, "not_found");
  if (n.status !== "submitted") throw new HttpError(409, EL.decided, "decided");
  const decision = String(input.decision); if (decision !== "accepted" && decision !== "rejected") throw new HttpError(400, EL.notStatus, "bad_decision");
  const reason = clean(input.reason, 400); if (decision === "rejected" && reason.length < 5) throw new HttpError(400, EL.needReason, "need_reason");
  noContactDetails(reason, "the reason");
  const post = (await postsOf(env, e.id)).find((p) => p.id === n.post_id);
  const pid = await pseudonym(env, actor.email);
  const seq = await commit(env, society.id, [
    env.DB.prepare("UPDATE el_nominations SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ? AND status = 'submitted'").bind(decision, now, pid, reason, n.id),
    guardChanged(env, EL.decided),
    eventStmt(env, society.id, e.id, now, "election.nomination_decided", "returning officer", `A nomination for ${post?.title ?? "a post"} was ${decision}.${decision === "rejected" ? ` Reason: ${reason}` : ""}`),
  ], "election.nomination_decided", { pid, role: actor.role }, { election: e.id, nomination: n.id, decision }, now);
  return { nomination: { id: n.id, status: decision }, audit: seq };
}

export async function withdrawNomination(m: MemberCtx, eid: string, nid: string) {
  gate(m.env);
  const e = await getElection(m.env, m.society.id, eid);
  if (e.status !== "notice" || m.now >= e.withdrawal_close_at) throw new HttpError(409, EL.withdrawn, "withdrawal_closed");
  const n = await m.env.DB.prepare("SELECT * FROM el_nominations WHERE election_id = ? AND id = ? AND email = ?").bind(e.id, String(nid).slice(0, 60), m.email.toLowerCase()).first<NomRow>();
  if (!n) throw new HttpError(404, EL.badNomination, "not_found");
  if (n.status !== "submitted" && n.status !== "accepted") throw new HttpError(409, EL.decided, "decided");
  const post = (await postsOf(m.env, e.id)).find((p) => p.id === n.post_id);
  const pid = await pseudonym(m.env, m.email);
  const seq = await commit(m.env, m.society.id, [
    m.env.DB.prepare("UPDATE el_nominations SET status = 'withdrawn', withdrawn_at = ? WHERE id = ? AND status IN ('submitted','accepted')").bind(m.now, n.id), guardChanged(m.env, EL.decided),
    eventStmt(m.env, m.society.id, e.id, m.now, "election.nomination_withdrawn", "voter", `A candidate withdrew from ${post?.title ?? "a post"}.`),
  ], "election.nomination_withdrawn", { pid, role: "voter" }, { election: e.id, nomination: n.id }, m.now);
  return { nomination: { id: n.id, status: "withdrawn" }, audit: seq };
}

export async function appealNomination(m: MemberCtx, eid: string, nid: string, input: { text?: unknown }) {
  gate(m.env);
  const e = await getElection(m.env, m.society.id, eid);
  if (e.status !== "notice") throw new HttpError(409, EL.notStatus, "bad_status");
  const n = await m.env.DB.prepare("SELECT * FROM el_nominations WHERE election_id = ? AND id = ? AND email = ?").bind(e.id, String(nid).slice(0, 60), m.email.toLowerCase()).first<NomRow>();
  if (!n) throw new HttpError(404, EL.badNomination, "not_found");
  if (n.status !== "rejected") throw new HttpError(409, EL.notStatus, "bad_status");
  if (n.appeal_status) throw new HttpError(409, EL.appealOnce, "appeal_once");
  if (m.now > (n.decided_at ?? 0) + e.appeal_hours * HOUR) throw new HttpError(409, EL.appealClosed, "appeal_closed");
  const text = clean(input.text, 800); if (text.length < 10 || text.length > 500) throw new HttpError(400, EL.tooShort, "bad_text");
  noContactDetails(text, "the appeal");
  const pid = await pseudonym(m.env, m.email);
  const seq = await commit(m.env, m.society.id, [
    m.env.DB.prepare("UPDATE el_nominations SET appeal_text = ?, appealed_at = ?, appeal_status = 'open' WHERE id = ? AND status = 'rejected' AND appeal_status IS NULL").bind(text, m.now, n.id), guardChanged(m.env, EL.appealOnce),
    eventStmt(m.env, m.society.id, e.id, m.now, "election.appeal_filed", "voter", "A rejected candidate filed an appeal."),
  ], "election.appeal_filed", { pid, role: "voter" }, { election: e.id, nomination: n.id }, m.now);
  return { nomination: { id: n.id, appeal: "open" }, audit: seq };
}

/** The Organizer decides an appeal (the returning officer made the first decision, so a different person decides the second). */
export async function decideAppeal(ctx: StaffCtx, eid: string, nid: string, input: { decision?: unknown; reason?: unknown }) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "notice") throw new HttpError(409, EL.notStatus, "bad_status");
  const n = await ctx.env.DB.prepare("SELECT * FROM el_nominations WHERE election_id = ? AND id = ?").bind(e.id, String(nid).slice(0, 60)).first<NomRow>();
  if (!n) throw new HttpError(404, EL.badNomination, "not_found");
  if (n.appeal_status !== "open") throw new HttpError(409, EL.noAppeal, "no_appeal");
  if (n.decided_by && n.decided_by === (await pseudonym(ctx.env, ctx.email))) throw new HttpError(409, EL.sameDecider, "same_decider");
  if ((await officerOf(ctx.env, e.id)) === ctx.email.toLowerCase()) throw new HttpError(409, EL.officerAppeal, "officer_appeal"); // whoever the returning officer is, under any role
  const decision = String(input.decision); if (decision !== "upheld" && decision !== "dismissed") throw new HttpError(400, EL.notStatus, "bad_decision");
  const reason = clean(input.reason, 400); if (reason.length < 5) throw new HttpError(400, EL.needReason, "need_reason");
  noContactDetails(reason, "the reason");
  const post = (await postsOf(ctx.env, e.id)).find((p) => p.id === n.post_id);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE el_nominations SET appeal_status = ?, appeal_reason = ?, appeal_decided_at = ?, status = CASE WHEN ? = 'upheld' THEN 'accepted' ELSE status END WHERE id = ? AND appeal_status = 'open'").bind(decision, reason, ctx.now, decision, n.id),
    guardChanged(ctx.env, EL.noAppeal),
    eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.appeal_decided", "organizer", `An appeal for ${post?.title ?? "a post"} was ${decision}. Reason: ${reason}`),
  ], "election.appeal_decided", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id, nomination: n.id, decision }, ctx.now);
  return { nomination: { id: n.id, appeal: decision, status: decision === "upheld" ? "accepted" : n.status }, audit: seq };
}

/** The Organizer's and co-organizers' view of every nomination, with the reasons. A co-organizer sees e-mail IDs masked. */
export async function nominationsForTeam(ctx: StaffCtx, eid: string) {
  gate(ctx.env); need(ctx, "electView");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  return { nominations: (await nominationsOf(ctx.env, e.id)).map((n) => ({ ...nomView(n, true), ...(ctx.role === "organizer" ? {} : { email: maskEmail(n.email) }) })) };
}

/** The people named for the election see every nomination. Only the returning officer sees the e-mail IDs in full. */
export async function nominationsForOfficial(env: Env, society: SocietyRow, actor: { role: ActorRole; email: string }, eid: string) {
  gate(env);
  if (actor.role !== "returning_officer" && actor.role !== "counting_agent" && actor.role !== "observer") throw new HttpError(403, EL.notOfficial, "forbidden");
  const e = await getElection(env, society.id, eid);
  return { nominations: (await nominationsOf(env, e.id)).map((n) => ({ ...nomView(n, true), ...(actor.role === "returning_officer" ? {} : { email: maskEmail(n.email) }) })) };
}

// ------------------------------------------------------------------------------------------------------------------ the final candidate list
const candidateFingerprint = async (e: ElectionRow, posts: Array<PostRow & { candidates: NomRow[] }>) =>
  sha256Hex("election-candidates/v1\n" + canonical({ election: e.id, roll: e.roll_fingerprint ?? "", posts: posts.map((p) => ({ post: p.id, seats: p.seats, kind: p.kind, candidates: p.candidates.map((c) => [c.id, c.name, c.unit, c.statement]) })) }));

export async function publishCandidates(ctx: StaffCtx, eid: string, input: { confirm?: unknown }) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "notice") throw new HttpError(409, EL.notStatus, "bad_status");
  if (!confirmIs(input.confirm, "FINAL")) throw new HttpError(400, EL.confirmFinal, "confirm");
  if (ctx.now < e.withdrawal_close_at) throw new HttpError(409, EL.tooEarlyFinal, "too_early");
  const noms = await nominationsOf(ctx.env, e.id);
  if (noms.some((n) => n.status === "submitted")) throw new HttpError(409, EL.undecided, "undecided");
  if (noms.some((n) => n.appeal_status === "open")) throw new HttpError(409, EL.openAppeals, "open_appeals");
  if (noms.some((n) => n.status === "rejected" && !n.appeal_status && ctx.now <= (n.decided_at ?? 0) + e.appeal_hours * HOUR)) throw new HttpError(409, EL.appealTime, "appeal_time");
  const posts = (await postsOf(ctx.env, e.id)).map((p) => {
    const candidates = noms.filter((n) => n.post_id === p.id && n.status === "accepted").sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    const kind: PostRow["kind"] = candidates.length === 0 ? "vacant" : candidates.length <= p.seats ? "unopposed" : "contested";
    return { ...p, kind, candidates };
  });
  const fp = await candidateFingerprint(e, posts);
  const stmts: D1Stmt[] = [
    ctx.env.DB.prepare("UPDATE el_elections SET status = 'candidates_final', final_at = ?, candidates_fingerprint = ? WHERE id = ? AND status = 'notice'").bind(ctx.now, fp, e.id), guardChanged(ctx.env, EL.notStatus),
    ...posts.map((p) => ctx.env.DB.prepare("UPDATE el_posts SET kind = ? WHERE id = ?").bind(p.kind, p.id)),
    eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.candidates_final", "organizer", `The final candidate list was published and fixed: ${posts.filter((p) => p.kind === "contested").length} post(s) to vote on, ${posts.filter((p) => p.kind === "unopposed").length} elected without a vote, ${posts.filter((p) => p.kind === "vacant").length} with no candidate.`),
  ];
  const seq = await commit(ctx.env, ctx.society.id, stmts, "election.candidates_final", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id, fingerprint: fp, contested: posts.filter((p) => p.kind === "contested").length }, ctx.now);
  return { election: await staffView(ctx, e.id), fingerprint: fp, audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ open, extend and close voting
/** Nobody who can run the election may stand: the Organizer and every active co-organizer against everyone whose nomination still stands. Checked when voting opens and again when it is made longer or closed, because a co-organizer can be added in between. */
async function assertNoStaffStands(env: Env, societyId: string, eid: string): Promise<void> {
  const staff = await staffEmailsOf(env, societyId);
  const standing = (await env.DB.prepare("SELECT email FROM el_nominations WHERE election_id = ? AND status IN ('submitted','accepted')").bind(eid).all<{ email: string }>()).results;
  if (standing.some((n) => staff.includes(n.email.toLowerCase()))) throw new HttpError(409, EL.staffStands, "staff_stands");
}

export async function openVoting(ctx: StaffCtx, eid: string, input: { confirm?: unknown }) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "candidates_final") throw new HttpError(409, EL.notStatus, "bad_status");
  if (!confirmIs(input.confirm, "OPEN")) throw new HttpError(400, EL.confirmOpen, "confirm");
  if (ctx.now >= e.voting_close_at) throw new HttpError(409, EL.tooLate, "too_late");
  // the person who opens the election cannot be a candidate
  if (await ctx.env.DB.prepare("SELECT 1 AS x FROM el_nominations WHERE election_id = ? AND email = ? AND status IN ('submitted','accepted')").bind(e.id, ctx.email.toLowerCase()).first()) throw new HttpError(409, EL.creatorOpens, "opener_is_candidate");
  // nobody who can run the election may stand, checked again now (a co-organizer may have been added after the nomination), and the returning officer does not open the voting
  await assertNoStaffStands(ctx.env, ctx.society.id, e.id);
  if ((await officerOf(ctx.env, e.id)) === ctx.email.toLowerCase()) throw new HttpError(409, EL.openerIsOfficer, "opener_is_officer");
  const roll = await rollLines(ctx.env, e);
  if (e.weighting === "by_list" && !weightGroupsOk(roll)) throw new HttpError(409, EL.weightGroup, "weight_group");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE el_elections SET status = 'voting', opened_at = ? WHERE id = ? AND status = 'candidates_final'").bind(ctx.now, e.id), guardChanged(ctx.env, EL.notStatus),
    eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.voting_opened", "organizer", "Voting was opened. Votes are accepted between the voting open and close times."),
  ], "election.voting_opened", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id }, ctx.now);
  return { election: await staffView(ctx, e.id), audit: seq };
}

export async function closeVoting(ctx: StaffCtx, eid: string, input: { confirm?: unknown; reason?: unknown }) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "voting") throw new HttpError(409, EL.notStatus, "bad_status");
  if (!confirmIs(input.confirm, "CLOSE")) throw new HttpError(400, EL.confirmClose, "confirm");
  await assertNoStaffStands(ctx.env, ctx.society.id, e.id);
  const early = ctx.now < e.voting_close_at;
  const reason = clean(input.reason, 300);
  if (early && reason.length < 10) throw new HttpError(400, EL.tooEarlyClose, "need_reason");
  noContactDetails(reason, "the reason");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE el_elections SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'voting'").bind(ctx.now, e.id), guardChanged(ctx.env, EL.notStatus),
    eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.voting_closed", "organizer", early ? `Voting was closed before the stated time. Reason: ${reason}` : "Voting was closed."),
  ], "election.voting_closed", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id, early: early ? 1 : 0 }, ctx.now);
  return { election: await staffView(ctx, e.id), audit: seq };
}

/** A longer voting time needs a written reason that everyone can read. The time can only move later, by at most 48 hours each time. */
export async function extendVoting(ctx: StaffCtx, eid: string, input: { until?: unknown; reason?: unknown }) {
  gate(ctx.env); need(ctx, "elections");
  const e = await getElection(ctx.env, ctx.society.id, eid);
  if (e.status !== "voting" || ctx.now >= e.voting_close_at) throw new HttpError(409, EL.notStatus, "bad_status");
  await assertNoStaffStands(ctx.env, ctx.society.id, e.id);
  const until = localToMs(String(input.until ?? ""), ctx.society.tz_offset_min);
  if (until === null || until <= e.voting_close_at || until > e.voting_close_at + 48 * HOUR) throw new HttpError(400, EL.badUntil, "bad_until");
  const reason = clean(input.reason, 300); if (reason.length < 10) throw new HttpError(400, EL.tooShort, "need_reason");
  noContactDetails(reason, "the reason");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE el_elections SET voting_close_at = ? WHERE id = ? AND status = 'voting' AND voting_close_at = ?").bind(until, e.id, e.voting_close_at), guardChanged(ctx.env, EL.notStatus),
    eventStmt(ctx.env, ctx.society.id, e.id, ctx.now, "election.voting_extended", "organizer", `The voting time was made longer, to ${whenWords(until, ctx.society.tz_offset_min)}. Reason: ${reason}`),
  ], "election.voting_extended", await staffActor(ctx.env, ctx.email, ctx.role), { election: e.id, until }, ctx.now);
  return { election: await staffView(ctx, e.id), audit: seq, mailed: false, note: "The new time is on the public page and in the election trail. E-mail to every voter is not part of this version." };
}
