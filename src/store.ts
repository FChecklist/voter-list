// Loading things from the database and the access rules (who may do what). No business decisions live here.
import { HttpError } from "./errors";
import type { Env } from "./db";
import type { ListRow, Settings } from "./model";
import type { Capacity } from "./text";
import { reasonText } from "./reasons";
import { maskEmail, maskName, maskPhone } from "./vendor/masking";

export interface SocietyRow {
  id: string; name: string; kind: string; kind_other: string; country: string; state: string; reg_no: string; reg_office: string; bye_laws_note: string;
  rule_code: 1 | 2 | 3 | 4 | 5; rule_clause: string; weight_mode: "equal" | "unequal"; dues_enabled: number; dues_cutoff: string | null; reason_public: "none" | "role" | "all"; tz_offset_min: number;
  verify_slug: string | null; created_by: string; created_at: number;
  phase: "open" | "frozen"; cutoff_at: number | null; docs_required: number; link_shared_at: number | null; hosts_skipped: number; erased_at: number | null;
}

export type Role = "organizer" | "host";
export interface StaffCtx { env: Env; now: number; email: string; role: Role; permanent: boolean; society: SocietyRow }

/** What each role may do. The Organizer may do everything. A Host checks and corrects records on the Organizer's behalf; settings, publishing, the team and full exports stay with the Organizer. */
export const CAN: Record<string, Role[]> = {
  view: ["organizer", "host"], review: ["organizer", "host"], import: ["organizer", "host"], editRecords: ["organizer", "host"], undo: ["organizer", "host"], weights: ["organizer", "host"], authorize: ["organizer"],
  settings: ["organizer"], publishDraft: ["organizer"], freeze: ["organizer"], team: ["organizer"], fullExport: ["organizer"], orders: ["organizer"], reopen: ["organizer"], shareLink: ["organizer"],
};
export function need(ctx: Pick<StaffCtx, "role">, action: keyof typeof CAN): void {
  if (!CAN[action]!.includes(ctx.role)) throw new HttpError(403, "Your role cannot do this. Please ask the Organizer.", "forbidden");
}
/** Only the Organizer sees names, mobiles and e-mail IDs unmasked in lists. A Host sees them masked and opens one record at a time (each opening is written to the signed log). */
export const seesFull = (ctx: Pick<StaffCtx, "role">): boolean => CAN.fullExport!.includes(ctx.role);

export function maskValue(field: string, v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (field === "name") return maskName(v);
  if (field === "mobile") return maskPhone(v);
  if (field === "email") return maskEmail(v);
  return v;
}

export const settingsOf = (s: SocietyRow): Settings => ({ ruleCode: s.rule_code, weightMode: s.weight_mode, duesEnabled: !!s.dues_enabled, duesCutoff: s.dues_cutoff, country: s.country, reasonPublic: s.reason_public });

export async function getSociety(env: Env, id: string): Promise<SocietyRow | null> {
  return env.DB.prepare("SELECT * FROM societies WHERE id = ?").bind(id).first<SocietyRow>();
}
export async function societyBySlug(env: Env, slug: string): Promise<SocietyRow | null> {
  if (!/^[0-9a-f]{16}$/.test(slug)) return null;
  return env.DB.prepare("SELECT * FROM societies WHERE verify_slug = ?").bind(slug).first<SocietyRow>();
}

/** The staff member's role in a list, or a 404 (not 403: a stranger must not learn which list ids exist). */
export async function staffCtx(env: Env, now: number, email: string, societyId: string): Promise<StaffCtx> {
  const m = await env.DB.prepare("SELECT role, permanent FROM memberships WHERE society_id = ? AND email = ? AND status = 'active'").bind(societyId, email).first<{ role: Role; permanent: number }>();
  const society = m ? await getSociety(env, societyId) : null;
  if (!m || !society) throw new HttpError(404, "Not found.", "not_found");
  return { env, now, email, role: m.role, permanent: !!m.permanent, society };
}

// ------------------------------------------------------------------------------------------------------------------ voter records
export type Status = "invited" | "draft" | "submitted" | "approved" | "sent_back" | "removed";
export interface VoterRow {
  id: string; society_id: string; unit: string; unit_key: string; name: string; capacity: Capacity | null; mobile: string; email: string; proxy_for: string;
  is_voter: number | null; weight_milli: number | null; can_attend: number; can_vote: number; dues_paid_on: string | null; status: Status; reason: string; approved_json: string | null; no_vote_reason: string | null; no_vote_note: string | null; no_vote_by: string | null;
  source: "voter" | "upload" | "host"; revision: number; confirmed_at: number | null; submitted_at: number | null; decided_by: string | null; decided_at: number | null; created_at: number; updated_at: number;
}
export interface Owned { name: string; mobile: string; capacity: Capacity | null; proxyFor: string }
export const ownedOf = (v: VoterRow): Owned => ({ name: v.name, mobile: v.mobile, capacity: v.capacity, proxyFor: v.proxy_for });

/** What the record says on the list right now: its own values once approved; the LAST approved values while a later edit waits for its check; nothing if it was never approved. */
export function onList(v: VoterRow): Owned | null {
  if (v.status === "removed") return null;
  if (v.status === "approved") return ownedOf(v);
  if (v.approved_json) { try { return JSON.parse(v.approved_json) as Owned; } catch { return null; } }
  return null;
}

export async function getVoter(env: Env, societyId: string, id: string): Promise<VoterRow | null> {
  return env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND id = ?").bind(societyId, id).first<VoterRow>();
}

export interface RollLine { voterId: string; row: ListRow; proxyFor: string }
/** Everyone who is on the list right now (approved, or approved earlier and re-submitted), as the rows the checks engine reads. Sorted by flat then name; row numbers and ids are 1.. in that order. */
export async function buildRoll(env: Env, societyId: string, onlyUnitKey?: string): Promise<{ lines: RollLine[]; rows: ListRow[]; notIncluded: number }> {
  const rs = await (onlyUnitKey === undefined ? env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND status <> 'removed' ORDER BY unit_key, lower(name), id").bind(societyId) : env.DB.prepare("SELECT * FROM voters WHERE society_id = ? AND unit_key = ? AND status <> 'removed' ORDER BY unit_key, lower(name), id").bind(societyId, onlyUnitKey)).all<VoterRow>();
  const lines: RollLine[] = []; let notIncluded = 0;
  for (const v of rs.results) {
    const o = onList(v);
    if (!o) { notIncluded++; continue; }
    if (v.status !== "approved") notIncluded++; // an edit is waiting: the earlier approved version is on the list, the edit is not
    const n = lines.length + 1;
    lines.push({ voterId: v.id, proxyFor: o.proxyFor, row: { id: n, rowNo: n, unit: v.unit, unitKey: v.unit_key, name: o.name, capacity: o.capacity, mobile: o.mobile, email: v.email, isVoter: v.is_voter === null ? null : !!v.is_voter, weightMilli: v.weight_milli, canAttend: !!v.can_attend, canVote: !!v.can_vote, duesPaidOn: v.dues_paid_on, sourceRow: null, noVoteReason: v.no_vote_reason, noVoteNote: v.no_vote_note } });
  }
  return { lines, rows: lines.map((l) => l.row), notIncluded };
}

/** The way a record is shown to the Organizer; to a Host everything personal is masked until the record is opened. */
export function viewVoter(v: VoterRow, masked: boolean) {
  const pick = (f: "name" | "mobile" | "email", x: string) => (masked && x ? maskValue(f, x) : x);
  return {
    id: v.id, unit: v.unit, name: pick("name", v.name), capacity: v.capacity, mobile: pick("mobile", v.mobile), email: pick("email", v.email), proxyFor: masked && v.proxy_for ? maskName(v.proxy_for) : v.proxy_for,
    isVoter: v.is_voter === null ? null : !!v.is_voter, weightMilli: v.weight_milli, canAttend: !!v.can_attend, canVote: !!v.can_vote, duesPaidOn: v.dues_paid_on,
    noVoteReason: v.no_vote_reason, noVoteNote: v.no_vote_note ?? "", noVoteBy: v.no_vote_by, noVoteText: reasonText(v.no_vote_reason, v.no_vote_note),
    status: v.status, reason: v.reason, source: v.source, revision: v.revision, hasEarlierApproval: !!v.approved_json, confirmedAt: v.confirmed_at, submittedAt: v.submitted_at, decidedAt: v.decided_at, updatedAt: v.updated_at,
  };
}

/** The last instant an action is accepted in the list's own time zone. Dates people type are YYYY-MM-DD; the cut-off is a moment. */
export const localToday = (now: number, tzOffsetMin: number): string => new Date(now + tzOffsetMin * 60_000).toISOString().slice(0, 10);
/** Enrolment is open while the list is not frozen and the cut-off moment (if any) has not passed. */
export const enrolOpen = (s: Pick<SocietyRow, "phase" | "cutoff_at">, now: number): boolean => s.phase === "open" && (s.cutoff_at === null || now < s.cutoff_at);
