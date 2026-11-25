// Shared pieces of the Meetings product: the kinds and words, the database rows, small checks on what people type, loaders, the quorum, and the way a meeting is shown.
// Meetings reads Attendance only through attendance.publicSession (its public counts). It never reads the attendance tables.
import * as attendance from "./attendance";
import { HttpError } from "./auth";
import type { Env } from "./db";
import { msToLocal, noContactDetails } from "./lists";
import { MSG } from "./meeting-messages";
import type { SocietyRow, StaffCtx } from "./store";
import { cleanEmail, squeeze } from "./text";
import { maskEmail, maskName } from "./vendor/masking";
import { canonical } from "./vendor/canonical";
import { sha256Hex } from "./vendor/crypto";

export const DAY = 86_400_000;
export const TYPES = ["annual", "special", "committee", "emergency"] as const;
export type MType = (typeof TYPES)[number];
export const TYPE_WORDS: Record<MType, string> = { annual: "Annual meeting", special: "Special meeting", committee: "Committee meeting", emergency: "Emergency meeting" };
export const MODES = ["in_person", "online", "offline"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_WORDS: Record<Mode, string> = { in_person: "In person", online: "Online", offline: "Offline" };
export const VISIBILITY = ["private", "notice", "all"] as const;
export const ITEM_KINDS = ["information", "decision"] as const;
export const MAJORITY = ["simple", "two_thirds", "three_quarters"] as const;
export type Majority = (typeof MAJORITY)[number];
export const MAJORITY_WORDS: Record<Majority, string> = { simple: "More votes for than against", two_thirds: "Two thirds of those voting", three_quarters: "Three quarters of those voting" };
export const METHODS = ["show_of_hands", "online", "secret_ballot", "by_list_rule"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_WORDS: Record<Method, string> = { show_of_hands: "Show of hands", online: "Online vote", secret_ballot: "Secret ballot", by_list_rule: "By the rule of the list" };
export type Status = "draft" | "noticed" | "open" | "adjourned" | "closed" | "cancelled";
export const STATUS_WORDS: Record<Status, string> = { draft: "Draft: no notice sent yet", noticed: "Notice sent", open: "Open", adjourned: "Adjourned", closed: "Closed", cancelled: "Cancelled" };
export const SINGLE_ROLES = ["chair", "secretary", "timekeeper"] as const;

export interface MeetingRow { id: string; society_id: string; number: number; title: string; meeting_type: MType; starts_at: number; place: string; mode: Mode; status: Status; visibility: "private" | "notice" | "all"; attendance_session_id: string | null; notice_version: number; opened_at: number | null; closed_at: number | null; created_by: string; created_at: number }
export interface RuleRow { society_id: string; meeting_type: MType; notice_days: number; quorum_percent: number; clause: string; adjourn_clause: string; set_by: string; set_at: number }
export interface ItemRow { id: string; society_id: string; meeting_id: string; position: number; title: string; note: string; kind: "information" | "decision"; minutes: number | null; created_by: string; created_at: number }
export interface NoticeRow { id: string; society_id: string; meeting_id: string; version: number; kind: "notice" | "postponed" | "cancelled"; issued_at: number; issued_by: string; starts_at: number; required_days: number | null; clause: string; reason: string; snapshot_json: string; fingerprint: string; recipients: number }
export interface PersonRow { society_id: string; meeting_id: string; role: string; name: string; email: string; added_by: string; added_at: number }
export interface Person { name: string; email: string }

/** Control characters are removed before anything else is looked at. */
export const noControls = (v: unknown) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

/** Longer text with paragraphs (minutes): line breaks stay, control characters go, no phone numbers or e-mail IDs, and more than one blank line is squeezed. */
export function longText(v: unknown, what: string, min: number, max: number): string {
  const t = noControls(v).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `Please write ${what} in ${min} to ${max} letters.`, "bad_text");
  noContactDetails(t, what);
  return t;
}
/** Free text: control characters out, white space squeezed, no phone numbers or e-mail IDs, and a length rule that says how to fix it. */
export function words(v: unknown, what: string, min: number, max: number, optional = false): string {
  const t = squeeze(noControls(v));
  if (!t && optional) return "";
  if (t.length < min || t.length > max) throw new HttpError(400, `Please write ${what} in ${min} to ${max} letters.`, "bad_text");
  noContactDetails(t, what);
  return t;
}
/** One of the allowed values, or a clear refusal. An unknown value is never turned into a default. */
export function oneOf<T extends string>(v: unknown, list: readonly T[], msg: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw new HttpError(400, msg, "bad_value");
  return v as T;
}
/** A whole number inside a range. A number written as text is refused, not guessed. */
export function whole(v: unknown, min: number, max: number, msg: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new HttpError(400, msg, "bad_number");
  return v;
}
/** A person who is not necessarily on the list (an officer, a counter, an observer): a name and an e-mail ID. */
export function person(v: unknown, what: string): Person {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const name = words(o.name, `the name of the ${what}`, 2, 60);
  const em = cleanEmail(String(o.email ?? ""));
  if (!em.ok) throw new HttpError(400, `Please type a proper e-mail ID for the ${what}.`, "bad_email");
  return { name, email: em.value };
}
export const notErased = (s: SocietyRow) => { if (s.erased_at) throw new HttpError(410, MSG.erased, "erased"); };

/** Meetings stay dark until the owner switches them on: every Meetings address answers "not found" unless MEETINGS_ENABLED is "1", exactly as an address that does not exist would. */
export const meetingsOn = (env: Env): boolean => env.MEETINGS_ENABLED === "1";
export function gate(env: Env): void { if (!meetingsOn(env)) throw new HttpError(404, MSG.notFound, "not_found"); }

/** What each role may do in Meetings. It is kept in this product's own file, so the shared permission table of the list stays as it is. The Organizer sets the rules, sends notices and approves; a co-organizer also runs the meeting. */
const MEET_CAN = { meetSetup: ["organizer"], meetRun: ["organizer", "host"] } as const;
export function needMeet(ctx: Pick<StaffCtx, "role">, action: keyof typeof MEET_CAN): void {
  if (!(MEET_CAN[action] as readonly string[]).includes(ctx.role)) throw new HttpError(403, "This role cannot do this. Please ask the Organizer.", "forbidden");
}
export const tzText = (min: number) => { const a = Math.abs(min); return `UTC${min < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`; };
export const fingerprintOf = (v: unknown): Promise<string> => sha256Hex(canonical(v));

export async function meetingOf(env: Env, societyId: string, id: string): Promise<MeetingRow> {
  const m = await env.DB.prepare("SELECT * FROM mtg_meetings WHERE society_id = ? AND id = ?").bind(societyId, String(id).slice(0, 60)).first<MeetingRow>();
  if (!m) throw new HttpError(404, MSG.notFound, "not_found");
  return m;
}
export async function ruleOf(env: Env, societyId: string, type: string): Promise<RuleRow | null> {
  return env.DB.prepare("SELECT * FROM mtg_rules WHERE society_id = ? AND meeting_type = ?").bind(societyId, type).first<RuleRow>();
}
export async function itemsOf(env: Env, meetingId: string): Promise<ItemRow[]> {
  return (await env.DB.prepare("SELECT * FROM mtg_items WHERE meeting_id = ? ORDER BY position, id").bind(meetingId).all<ItemRow>()).results;
}
export async function peopleOf(env: Env, meetingId: string): Promise<PersonRow[]> {
  return (await env.DB.prepare("SELECT * FROM mtg_people WHERE meeting_id = ? ORDER BY role, added_at, email").bind(meetingId).all<PersonRow>()).results;
}

/** An attendance session of this same list, checked through Attendance's public function. A session of another list answers "not found". */
export async function linkable(env: Env, society: SocietyRow, id: unknown): Promise<string> {
  const sid = String(id ?? "").slice(0, 60);
  try { await attendance.publicSession(env, society, sid); }
  catch (e) { if (e instanceof HttpError && e.status === 404) throw new HttpError(404, MSG.noSession, "no_session"); throw e; }
  return sid;
}

export interface Quorum { ruleSet: boolean; percent: number | null; linked: boolean; eligible: number; present: number; required: number; met: boolean; words: string }
/** The quorum for a meeting, from the rule of its kind and the public counts of its linked attendance session. Weighted quorum is not computed: people are counted. */
export async function quorumOf(env: Env, society: SocietyRow, m: MeetingRow, rule: RuleRow | null): Promise<Quorum> {
  if (!rule) return { ruleSet: false, percent: null, linked: !!m.attendance_session_id, eligible: 0, present: 0, required: 0, met: false, words: MSG.noQuorumRule };
  const p = rule.quorum_percent;
  if (!m.attendance_session_id) return { ruleSet: true, percent: p, linked: false, eligible: 0, present: 0, required: 0, met: p === 0, words: p === 0 ? MSG.quorumNone : MSG.needAttendance };
  const c = (await attendance.publicSession(env, society, m.attendance_session_id)).session.counts;
  const required = p === 0 ? 0 : Math.max(1, Math.ceil((c.eligible * p) / 100));
  const met = c.present >= required;
  const words = p === 0 ? MSG.quorumNone : `Quorum: ${p} percent of the ${c.eligible} people who may attend, which is ${required}. Present now: ${c.present}. ${met ? "The quorum is met." : "The quorum is not met."}`;
  return { ruleSet: true, percent: p, linked: true, eligible: c.eligible, present: c.present, required, met, words };
}
/** What the bye-laws allow when there is no quorum. The text is the Organizer's own, from the quorum settings; the system adds nothing. */
export const noQuorumNext = (rule: RuleRow | null) => ({
  options: [
    { action: "adjourn", text: "Adjourn the meeting and write the reason." },
    { action: "hold_again", text: rule?.adjourn_clause ? `Hold the meeting again as the bye-laws say: ${rule.adjourn_clause}` : "Hold the meeting again as the bye-laws allow. The Organizer can write that rule in the quorum settings." },
  ],
});

export const viewMeeting = (m: MeetingRow, tz: number) => ({
  id: m.id, number: m.number, title: m.title, type: m.meeting_type, typeText: TYPE_WORDS[m.meeting_type], startsAt: msToLocal(m.starts_at, tz), timeZone: tzText(tz), place: m.place,
  mode: m.mode, modeText: MODE_WORDS[m.mode], status: m.status, statusText: STATUS_WORDS[m.status], visibility: m.visibility, attendanceSessionId: m.attendance_session_id,
  noticeVersion: m.notice_version, openedAt: m.opened_at, closedAt: m.closed_at,
});
export const ROLE_WORDS: Record<string, string> = { chair: "Chair", secretary: "Secretary", timekeeper: "Timekeeper", observer: "Observer", validated_by: "Validated by", supervised_by: "Supervised by" };
/** A named person of a meeting. The Organizer sees the name and e-mail ID; a co-organizer sees them masked. */
export const viewPerson = (p: PersonRow, full: boolean) => ({ role: p.role, roleText: ROLE_WORDS[p.role] ?? p.role, name: full ? p.name : maskName(p.name), email: full ? p.email : maskEmail(p.email), addedAt: p.added_at });
export const viewItem = (i: ItemRow, n: number) => ({ id: i.id, n, title: i.title, note: i.note, kind: i.kind, kindText: i.kind === "decision" ? "For decision" : "For information", minutes: i.minutes });
