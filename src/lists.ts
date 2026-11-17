// A voter list (one row of `societies`): create it, change its settings, and run its team (1 Organizer, up to 10 Hosts, plus the permanent Townhall Records Host).
import { HttpError, rateLimit, sendMail, signupOpen, isListedOrganizer } from "./auth";
import { commit, guardChanged, staffActor, pseudonym } from "./audit";
import { uid, type D1Stmt, type Env } from "./db";
import { RULES } from "./model";
import { need, type SocietyRow, type StaffCtx } from "./store";
import { cleanEmail, cleanMobile, parseDate, squeeze } from "./text";
import { randomHex } from "./vendor/crypto";
import { scanPublic } from "./vendor/masking";

export const KINDS = ["RWA", "AOA", "HOA", "Co-operative society", "Others"] as const;
export const COUNTRIES = ["India", "Bangladesh", "Bhutan", "Nepal", "Sri Lanka", "Singapore", "United Arab Emirates", "United Kingdom", "United States", "Other"] as const;
const TZ: Record<string, number> = { India: 330, Bangladesh: 360, Bhutan: 360, Nepal: 345, "Sri Lanka": 330, Singapore: 480, "United Arab Emirates": 240, "United Kingdom": 0, "United States": -300 };
export const MAX_HOSTS = 10;
export const permanentHostEmail = (env: Env): string => (env.PERMANENT_HOST_EMAIL ?? "host@townhall-records.com").trim().toLowerCase();

export function noContactDetails(text: string, what: string) {
  if (scanPublic(text).length) throw new HttpError(400, `Please do not write phone numbers or e-mail IDs in ${what}.`);
}

export interface ListInput { name: string; kind: string; kindOther?: string; country?: string; state?: string; regNo?: string; regOffice?: string; byeLawsNote?: string; ruleCode?: number; ruleClause?: string; weightMode?: string; reasonPublic?: string; duesEnabled?: boolean; duesCutoff?: string | null; tzOffsetMin?: number; docsRequired?: boolean; cutoff?: string | null }

/** "2026-12-05T18:00" in the list's own time zone -> UTC milliseconds. */
export function localToMs(local: string, tzOffsetMin: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return t.getTime() - tzOffsetMin * 60_000;
}
export const msToLocal = (ms: number, tzOffsetMin: number): string => new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 16);

function validate(i: Partial<ListInput>, creating: boolean, now: number, tz: number) {
  const out: Record<string, string | number | null> = {};
  if (i.name !== undefined || creating) { const n = squeeze(i.name ?? ""); if (n.length < 2 || n.length > 120) throw new HttpError(400, "Please type the name of the society (2 to 120 letters)."); if (/https?:|www\.|@|\w\.[a-z]{2,}\/|[a-z0-9-]+\.(com|in|org|net|co|io|xyz|info|me|app|link)\b/i.test(n)) throw new HttpError(400, "Please type only the name of the society, without web addresses or e-mail IDs."); out.name = n; }
  if (i.kind !== undefined || creating) { if (!(KINDS as readonly string[]).includes(String(i.kind))) throw new HttpError(400, "Please choose the kind of body."); out.kind = String(i.kind); }
  if (i.kindOther !== undefined) out.kind_other = squeeze(i.kindOther).slice(0, 60);
  if (out.kind === "Others" && !squeeze(i.kindOther ?? "")) throw new HttpError(400, "Please write the kind of body.");
  if (i.country !== undefined) { const c = squeeze(i.country).slice(0, 60); if (!c) throw new HttpError(400, "Please choose the country."); out.country = c; if (i.tzOffsetMin === undefined) out.tz_offset_min = TZ[c] ?? 0; }
  if (i.tzOffsetMin !== undefined) { if (!Number.isInteger(i.tzOffsetMin) || i.tzOffsetMin < -720 || i.tzOffsetMin > 840) throw new HttpError(400, "That time zone is not valid."); out.tz_offset_min = i.tzOffsetMin; }
  if (i.state !== undefined) out.state = squeeze(i.state).slice(0, 60);
  if (i.regNo !== undefined) out.reg_no = squeeze(i.regNo).slice(0, 40);
  if (i.regOffice !== undefined) out.reg_office = squeeze(i.regOffice).slice(0, 120);
  if (i.byeLawsNote !== undefined) out.bye_laws_note = squeeze(i.byeLawsNote).slice(0, 500);
  if (i.ruleClause !== undefined) out.rule_clause = squeeze(i.ruleClause).slice(0, 300);
  if (i.ruleCode !== undefined) { if (!RULES.some((r) => r.code === i.ruleCode)) throw new HttpError(400, "Please choose one of the five voting rules."); out.rule_code = i.ruleCode!; }
  if (i.weightMode !== undefined) { if (!["equal", "unequal"].includes(i.weightMode)) throw new HttpError(400, "Please choose equal or unequal vote weight."); out.weight_mode = i.weightMode; }
  if (i.reasonPublic !== undefined) { if (!["none", "role", "all"].includes(i.reasonPublic)) throw new HttpError(400, "Please choose what the public list may say about people who are not allowed to vote."); out.reason_public = i.reasonPublic; }
  if (i.duesEnabled !== undefined) out.dues_enabled = i.duesEnabled ? 1 : 0;
  if (i.duesCutoff !== undefined) { if (i.duesCutoff === null || i.duesCutoff === "") out.dues_cutoff = null; else { const d = parseDate(i.duesCutoff); if (!d) throw new HttpError(400, "Please pick a proper dues date."); out.dues_cutoff = d; } }
  if (i.docsRequired !== undefined) out.docs_required = i.docsRequired ? 1 : 0;
  if (i.cutoff !== undefined) {
    if (i.cutoff === null || i.cutoff === "") out.cutoff_at = null;
    else {
      const ms = localToMs(String(i.cutoff), (out.tz_offset_min as number | undefined) ?? tz);
      if (ms === null) throw new HttpError(400, "Please pick the closing date and time again.");
      if (ms <= now) throw new HttpError(400, "That closing time has already passed. Please pick a time ahead, or use \"Close enrolment now\".");
      if (ms > now + 400 * 86_400_000) throw new HttpError(400, "Please pick a closing time within the next year.");
      out.cutoff_at = ms;
    }
  }
  return out;
}

export async function createList(env: Env, now: number, email: string, input: ListInput) {
  const v = validate(input, true, now, input.tzOffsetMin ?? TZ[String(input.country ?? "India")] ?? 330);
  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE email = ? AND status = 'active' AND role = 'organizer'").bind(email).first<{ n: number }>();
  if (!signupOpen(env) && !isListedOrganizer(env, email)) throw new HttpError(403, "New voter lists are started by Organizers that Townhall Records has set up. Please ask us to add your e-mail ID, and you can begin right away.", "not_organizer");
  if ((mine?.n ?? 0) >= 10) throw new HttpError(409, "One person can organise up to 10 voter lists here.", "too_many");
  const id = uid("soc"), slug = randomHex(8);
  const cols = ["id", ...Object.keys(v), "verify_slug", "created_by", "created_at"], vals = [id, ...Object.values(v), slug, email, now];
  const stmts: D1Stmt[] = [
    env.DB.prepare(`INSERT INTO societies (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...vals),
    env.DB.prepare("INSERT INTO memberships (society_id, email, role, status, invited_by, created_at) VALUES (?, ?, 'organizer', 'active', ?, ?)").bind(id, email, email, now),
  ];
  const perm = permanentHostEmail(env);
  if (perm !== email) stmts.push(env.DB.prepare("INSERT INTO memberships (society_id, email, role, status, invited_by, created_at, permanent) VALUES (?, ?, 'host', 'active', 'system', ?, 1)").bind(id, perm, now));
  await commit(env, id, stmts, "list.created", await staffActor(env, email, "organizer"), { kind: String(v.kind), rule: Number(v.rule_code ?? 1), permanentHost: perm !== email ? 1 : 0 }, now);
  return (await env.DB.prepare("SELECT * FROM societies WHERE id = ?").bind(id).first<SocietyRow>())!;
}

export async function updateList(ctx: StaffCtx, input: Partial<ListInput> & { closeNow?: boolean }) {
  need(ctx, "settings");
  const s = ctx.society;
  if (s.phase === "frozen") throw new HttpError(409, "The list is frozen, so its settings are fixed. Reopen the list first if a new round is needed.", "frozen");
  // the form always sends the closing time it shows; one that has not been changed is not "a new time" (so a passed time does not block other edits)
  if (typeof input.cutoff === "string" && s.cutoff_at !== null && input.cutoff === msToLocal(s.cutoff_at, input.tzOffsetMin ?? s.tz_offset_min)) input = { ...input, cutoff: undefined };
  const v = validate(input, false, ctx.now, s.tz_offset_min);
  if (input.closeNow) v.cutoff_at = ctx.now;
  const keys = Object.keys(v);
  if (!keys.length) return s;
  const stmts: D1Stmt[] = [ctx.env.DB.prepare(`UPDATE societies SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ? AND phase = 'open'`).bind(...Object.values(v), s.id), guardChanged(ctx.env, "The list was frozen at the same moment, so nothing was changed.")];
  await commit(ctx.env, s.id, stmts, input.closeNow ? "enrolment.closed" : "list.updated", await staffActor(ctx.env, ctx.email, ctx.role),
    { fields: keys.filter((k) => k !== "tz_offset_min"), ...("rule_code" in v ? { rule: Number(v.rule_code) } : {}), ...("weight_mode" in v ? { weights: String(v.weight_mode) } : {}), ...("dues_enabled" in v ? { dues: Number(v.dues_enabled) } : {}), ...("cutoff_at" in v ? { cutoffAt: v.cutoff_at === null ? 0 : Number(v.cutoff_at) } : {}) }, ctx.now);
  return (await ctx.env.DB.prepare("SELECT * FROM societies WHERE id = ?").bind(s.id).first<SocietyRow>())!;
}

export const viewList = (s: SocietyRow) => ({
  id: s.id, name: s.name, kind: s.kind, kindOther: s.kind_other, country: s.country, state: s.state, regNo: s.reg_no, regOffice: s.reg_office, byeLawsNote: s.bye_laws_note,
  ruleCode: s.rule_code, ruleClause: s.rule_clause, weightMode: s.weight_mode, reasonPublic: s.reason_public ?? "role", duesEnabled: !!s.dues_enabled, duesCutoff: s.dues_cutoff, tzOffsetMin: s.tz_offset_min, docsRequired: !!s.docs_required,
  phase: s.phase, cutoffAt: s.cutoff_at, cutoffLocal: s.cutoff_at === null ? null : msToLocal(s.cutoff_at, s.tz_offset_min), link: `/v/${s.verify_slug}`, linkSharedAt: s.link_shared_at, hostsSkipped: !!s.hosts_skipped, createdAt: s.created_at,
});

/** The Organizer says "I have shared the link" or "no hosts for now": only the step bar listens; nothing else changes. */
export async function markStep(ctx: StaffCtx, what: "link_shared" | "hosts_skipped") {
  need(ctx, "shareLink");
  const sql = what === "link_shared" ? "UPDATE societies SET link_shared_at = COALESCE(link_shared_at, ?) WHERE id = ?" : "UPDATE societies SET hosts_skipped = 1 WHERE id = ?";
  const binds = what === "link_shared" ? [ctx.now, ctx.society.id] : [ctx.society.id];
  await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare(sql).bind(...binds)], "step." + what, await staffActor(ctx.env, ctx.email, ctx.role), {}, ctx.now);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------------------------ team
export async function listTeam(ctx: StaffCtx) {
  need(ctx, "view");
  const rs = await ctx.env.DB.prepare("SELECT email, role, permanent, created_at FROM memberships WHERE society_id = ? AND status = 'active' ORDER BY (role = 'organizer') DESC, permanent, created_at").bind(ctx.society.id).all<{ email: string; role: string; permanent: number; created_at: number }>();
  const full = ctx.role === "organizer";
  return {
    max: MAX_HOSTS,
    team: rs.results.map((m) => ({ email: full || m.email === ctx.email || m.permanent ? m.email : m.email.replace(/^(.).*(@.*)$/, "$1****$2"), role: m.role, permanent: !!m.permanent, you: m.email === ctx.email, since: m.created_at })),
    hostsUsed: rs.results.filter((m) => m.role === "host" && !m.permanent).length,
  };
}

export async function inviteHost(ctx: StaffCtx, input: { email: string; mobile?: string }) {
  need(ctx, "team");
  const em = cleanEmail(input.email); if (!em.ok) throw new HttpError(400, "Please type a proper e-mail ID for the new host.");
  const mob = input.mobile ? cleanMobile(input.mobile, ctx.society.country) : null; if (mob && !mob.ok) throw new HttpError(400, "That mobile number does not look right.");
  await rateLimit(ctx.env, `invite:${ctx.society.id}`, 20, 3_600_000, ctx.now);
  await rateLimit(ctx.env, `invite-acct:${ctx.email}`, 15, 86_400_000, ctx.now); // one account cannot use up the day's staff mail
  await rateLimit(ctx.env, `invite-to:${em.value}`, 3, 86_400_000, ctx.now); // one inbox is never filled with invitations
  const ex = await ctx.env.DB.prepare("SELECT role, status, permanent FROM memberships WHERE society_id = ? AND email = ?").bind(ctx.society.id, em.value).first<{ role: string; status: string; permanent: number }>();
  if (ex?.status === "active") throw new HttpError(409, ex.permanent ? "That e-mail ID is the standing Townhall Records host and is already on your team." : ex.role === "organizer" ? "That e-mail ID is the Organizer." : "That person is already a host.", "already_member");
  // the database trigger refuses an 11th host even if two invitations race; its message is what the Organizer reads
  await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare("INSERT INTO memberships (society_id, email, mobile, role, status, invited_by, created_at) VALUES (?, ?, ?, 'host', 'active', ?, ?) ON CONFLICT(society_id, email) DO UPDATE SET role = 'host', status = 'active', mobile = excluded.mobile, invited_by = excluded.invited_by")
    .bind(ctx.society.id, em.value, mob?.value ?? "", ctx.email, ctx.now)], "team.host_added", await staffActor(ctx.env, ctx.email, ctx.role), { returning: ex ? 1 : 0, target: await pseudonym(ctx.env, em.value) }, ctx.now);
  let mailed = true;
  try { await sendMail(ctx.env, em.value, `You were added as a host of the voter list of ${ctx.society.name}`, `You were added as a Host of the voter list of ${ctx.society.name}.\n\nTo begin, open Townhall Records Voter List and ask for a code for this e-mail ID. A host checks the records that voters send in.\n\nTownhall Records`, "team-invite", ctx.now); } catch { mailed = false; /* the host is added even if the courtesy note cannot be sent */ }
  return { email: em.value, role: "host", mailed };
}

export async function removeHost(ctx: StaffCtx, rawEmail: string) {
  need(ctx, "team");
  const email = cleanEmail(rawEmail).value.toLowerCase();
  const m = await ctx.env.DB.prepare("SELECT role, permanent FROM memberships WHERE society_id = ? AND email = ? AND status = 'active'").bind(ctx.society.id, email).first<{ role: string; permanent: number }>();
  if (!m) throw new HttpError(404, "Not found.", "not_found");
  if (m.permanent) throw new HttpError(409, "The Townhall Records host is a standing member of every voter list and stays on your team.", "permanent_host");
  if (m.role === "organizer") throw new HttpError(409, "The Organizer cannot be removed. Hand the list to someone else first.", "is_organizer");
  await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare("UPDATE memberships SET status = 'removed' WHERE society_id = ? AND email = ? AND role = 'host' AND status = 'active' AND permanent = 0").bind(ctx.society.id, email), guardChanged(ctx.env, "That host was already removed.")],
    "team.host_removed", await staffActor(ctx.env, ctx.email, ctx.role), { target: await pseudonym(ctx.env, email) }, ctx.now);
  return { removed: email };
}

/** Hand the list to another person: they become the one Organizer; the previous Organizer becomes a Host (a Host place must be free, or the new Organizer must be a Host already). One batch: never no Organizer, never two. */
export async function transferOrganizer(ctx: StaffCtx, rawEmail: string) {
  need(ctx, "team");
  const em = cleanEmail(rawEmail); if (!em.ok) throw new HttpError(400, "Please type a proper e-mail ID.");
  const to = em.value, db = ctx.env.DB, sid = ctx.society.id;
  if (to === ctx.email) throw new HttpError(400, "You are already the Organizer.");
  const ex = await db.prepare("SELECT role, status, permanent FROM memberships WHERE society_id = ? AND email = ?").bind(sid, to).first<{ role: string; status: string; permanent: number }>();
  if (ex?.permanent) throw new HttpError(400, "The standing Townhall Records host cannot become the Organizer.");
  const stmts: D1Stmt[] = [
    db.prepare("UPDATE memberships SET status = 'removed' WHERE society_id = ? AND email = ? AND role = 'organizer' AND status = 'active'").bind(sid, ctx.email), guardChanged(ctx.env, "The Organizer has already changed."),
    db.prepare("INSERT INTO memberships (society_id, email, role, status, invited_by, created_at) VALUES (?, ?, 'organizer', 'active', ?, ?) ON CONFLICT(society_id, email) DO UPDATE SET role = 'organizer', status = 'active'").bind(sid, to, ctx.email, ctx.now),
    db.prepare("UPDATE memberships SET role = 'host', status = 'active' WHERE society_id = ? AND email = ? AND role = 'organizer' AND status = 'removed'").bind(sid, ctx.email),
  ];
  await commit(ctx.env, sid, stmts, "team.organizer_changed", await staffActor(ctx.env, ctx.email, "organizer"), { newWasHost: ex?.role === "host" && ex.status === "active" ? 1 : 0 }, ctx.now);
  return { organizer: to };
}
