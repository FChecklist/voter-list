// Meetings (first chunks): the rules of each kind of meeting, the meeting, its agenda, the notice, the officers, and the run of the meeting (open, adjourn, resume, close).
// Motions and results are in meeting-motions.ts, minutes and action items in meeting-minutes.ts, the public page, calendar file and report in meeting-report.ts,
// and the shared pieces in meeting-core.ts. Meetings reads the list and Attendance only through their public functions.
import { HttpError } from "./auth";
import { commit, guardChanged, guardExists, pseudonym, staffActor } from "./audit";
import { uid, type D1Stmt } from "./db";
import { localToMs, msToLocal } from "./lists";
import { MSG } from "./meeting-messages";
import {
  DAY, ITEM_KINDS, MODES, TYPES, TYPE_WORDS, VISIBILITY, fingerprintOf, itemsOf, linkable, meetingOf, notErased, oneOf, peopleOf, person, quorumOf, ruleOf, tzText, viewItem, viewMeeting, viewPerson, whole, words,
  type ItemRow, type MeetingRow, type NoticeRow, type RuleRow,
} from "./meeting-core";
import { buildRoll, need, seesFull, type StaffCtx } from "./store";

const actorOf = (ctx: StaffCtx) => staffActor(ctx.env, ctx.email, ctx.role);
type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {});

// ------------------------------------------------------------------------------------------------------------------ the rules of each kind of meeting
const viewRule = (r: RuleRow) => ({
  type: r.meeting_type, typeText: TYPE_WORDS[r.meeting_type], set: true, noticeDays: r.notice_days, quorumPercent: r.quorum_percent, clause: r.clause, adjournClause: r.adjourn_clause, setAt: r.set_at,
  quorumText: r.quorum_percent === 0 ? MSG.quorumNone : `${r.quorum_percent} percent of the people who may attend`,
});
export const viewRuleOrNone = (r: RuleRow | null, type: string) => (r ? viewRule(r) : { type, typeText: TYPE_WORDS[type as keyof typeof TYPE_WORDS] ?? type, set: false });

export async function listRules(ctx: StaffCtx) {
  need(ctx, "view"); notErased(ctx.society);
  const rs = (await ctx.env.DB.prepare("SELECT * FROM meeting_rules WHERE society_id = ?").bind(ctx.society.id).all<RuleRow>()).results;
  return { rules: TYPES.map((t) => viewRuleOrNone(rs.find((x) => x.meeting_type === t) ?? null, t)) };
}

/** The notice period and the quorum of one kind of meeting, as the bye-laws say. Nothing is assumed: until the Organizer sets them, no notice can be sent for that kind. */
export async function setRule(ctx: StaffCtx, type: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const t = oneOf(type, TYPES, MSG.badType);
  const days = whole(input.noticeDays, 0, 365, MSG.badDays);
  const pct = whole(input.quorumPercent, 0, 100, MSG.badQuorum);
  const clause = words(input.clause, "the bye-law clause", 2, 200, true);
  const adjourn = words(input.adjournClause, "the rule for a meeting without a quorum", 2, 300, true);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("INSERT INTO meeting_rules (society_id, meeting_type, notice_days, quorum_percent, clause, adjourn_clause, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (society_id, meeting_type) DO UPDATE SET notice_days = excluded.notice_days, quorum_percent = excluded.quorum_percent, clause = excluded.clause, adjourn_clause = excluded.adjourn_clause, set_by = excluded.set_by, set_at = excluded.set_at")
      .bind(ctx.society.id, t, days, pct, clause, adjourn, await pseudonym(ctx.env, ctx.email), ctx.now),
  ], "meeting.rules_set", await actorOf(ctx), { type: t, noticeDays: days, quorumPercent: pct }, ctx.now);
  return { rule: viewRule((await ruleOf(ctx.env, ctx.society.id, t))!), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ the meeting
export async function createMeeting(ctx: StaffCtx, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const title = words(input.title, "the title", 2, 80);
  const type = oneOf(input.type, TYPES, MSG.badType);
  const mode = oneOf(input.mode, MODES, MSG.badMode);
  const place = words(input.place, "the place", 2, 120, true);
  const at = localToMs(String(input.startsAt ?? ""), ctx.society.tz_offset_min); if (at === null) throw new HttpError(400, MSG.badTime, "bad_time");
  const visibility = input.visibility === undefined ? "private" : oneOf(input.visibility, VISIBILITY, MSG.badVisibility);
  const session = input.attendanceSessionId === undefined || input.attendanceSessionId === null || input.attendanceSessionId === "" ? null : await linkable(ctx.env, ctx.society, input.attendanceSessionId);
  const pid = await pseudonym(ctx.env, ctx.email);
  for (let attempt = 0; ; attempt++) {
    const id = uid("mtg");
    try {
      const seq = await commit(ctx.env, ctx.society.id, [
        ctx.env.DB.prepare("INSERT INTO meetings (id, society_id, number, title, meeting_type, starts_at, place, mode, status, visibility, attendance_session_id, notice_version, created_by, created_at) SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, ?, ? FROM meetings WHERE society_id = ?")
          .bind(id, ctx.society.id, title, type, at, place, mode, visibility, session, pid, ctx.now, ctx.society.id),
      ], "meeting.created", await actorOf(ctx), { meeting: id, type, mode, visibility, linked: !!session }, ctx.now);
      return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, id), ctx.society.tz_offset_min), audit: seq };
    } catch (e) {
      // two people creating a meeting at the same moment can pick the same number: the loser simply takes the next one
      if (attempt < 3 && /UNIQUE/i.test(String((e as Error)?.message ?? e)) && /meetings\.(society_id|number)/i.test(String((e as Error)?.message ?? e))) continue;
      throw e;
    }
  }
}

export async function listMeetings(ctx: StaffCtx) {
  need(ctx, "view"); notErased(ctx.society);
  const rs = (await ctx.env.DB.prepare("SELECT m.*, (SELECT COUNT(*) FROM meeting_items i WHERE i.meeting_id = m.id) AS items FROM meetings m WHERE m.society_id = ? ORDER BY m.starts_at DESC, m.number DESC LIMIT 200").bind(ctx.society.id).all<MeetingRow & { items: number }>()).results;
  return { meetings: rs.map((m) => ({ ...viewMeeting(m, ctx.society.tz_offset_min), agendaItems: m.items })) };
}

const viewNotice = (n: NoticeRow, tz: number) => {
  const snap = JSON.parse(n.snapshot_json) as { agenda?: unknown };
  return { version: n.version, kind: n.kind, issuedAt: n.issued_at, startsAt: msToLocal(n.starts_at, tz), requiredDays: n.required_days, clause: n.clause, reason: n.reason, recipients: n.recipients, fingerprint: n.fingerprint, agenda: snap.agenda ?? [] };
};
const EVENT_WORDS: Record<string, string> = { opened: "Meeting opened", adjourned: "Meeting adjourned", resumed: "Meeting resumed", closed: "Meeting closed", point_of_order: "Point of order", notice_withdrawn: "Notice withdrawn" };
export const noticesOf = async (ctx: Pick<StaffCtx, "env">, meetingId: string) => (await ctx.env.DB.prepare("SELECT * FROM meeting_notices WHERE meeting_id = ? ORDER BY version").bind(meetingId).all<NoticeRow>()).results;
export const eventsOf = async (ctx: Pick<StaffCtx, "env">, meetingId: string) => (await ctx.env.DB.prepare("SELECT kind, text, ts FROM meeting_events WHERE meeting_id = ? ORDER BY id").bind(meetingId).all<{ kind: string; text: string; ts: number }>()).results;
export const viewEvents = (es: { kind: string; text: string; ts: number }[]) => es.map((e) => ({ kind: e.kind, kindText: EVENT_WORDS[e.kind] ?? e.kind, text: e.text, at: e.ts }));
export { viewNotice };

/** One meeting for the team: the facts, the rule that applies, the agenda, the officers, every notice, what happened in the room, and the quorum as it stands. */
export async function showMeeting(ctx: StaffCtx, id: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, id);
  const tz = ctx.society.tz_offset_min;
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
  const full = seesFull(ctx);
  const quorum = await quorumOf(ctx.env, ctx.society, m, rule);
  return {
    meeting: viewMeeting(m, tz), rule: viewRuleOrNone(rule, m.meeting_type),
    agenda: (await itemsOf(ctx.env, m.id)).map((i, k) => viewItem(i, k + 1)),
    people: (await peopleOf(ctx.env, m.id)).map((p) => viewPerson(p, full)),
    notices: (await noticesOf(ctx, m.id)).map((n) => viewNotice(n, tz)),
    events: viewEvents(await eventsOf(ctx, m.id)), quorum,
  };
}

/** Title, kind, date, place and mode can change only while no notice is out. Who may read the page and the linked attendance session can change until the meeting is closed. */
export async function patchMeeting(ctx: StaffCtx, id: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, id);
  const sets: string[] = [], binds: unknown[] = [], fields: string[] = [];
  const touchesFixed = ["title", "type", "mode", "place", "startsAt"].some((k) => input[k] !== undefined);
  if (touchesFixed && m.status !== "draft") throw new HttpError(409, MSG.agendaFixed, "fixed");
  if (input.title !== undefined) { sets.push("title = ?"); binds.push(words(input.title, "the title", 2, 80)); fields.push("title"); }
  if (input.type !== undefined) { sets.push("meeting_type = ?"); binds.push(oneOf(input.type, TYPES, MSG.badType)); fields.push("type"); }
  if (input.mode !== undefined) { sets.push("mode = ?"); binds.push(oneOf(input.mode, MODES, MSG.badMode)); fields.push("mode"); }
  if (input.place !== undefined) { sets.push("place = ?"); binds.push(words(input.place, "the place", 2, 120, true)); fields.push("place"); }
  if (input.startsAt !== undefined) { const at = localToMs(String(input.startsAt), ctx.society.tz_offset_min); if (at === null) throw new HttpError(400, MSG.badTime, "bad_time"); sets.push("starts_at = ?"); binds.push(at); fields.push("startsAt"); }
  if (input.visibility !== undefined) { sets.push("visibility = ?"); binds.push(oneOf(input.visibility, VISIBILITY, MSG.badVisibility)); fields.push("visibility"); }
  if (input.attendanceSessionId !== undefined) {
    if (m.status === "closed" || m.status === "cancelled") throw new HttpError(409, MSG.closedFixed, "closed");
    sets.push("attendance_session_id = ?"); binds.push(input.attendanceSessionId === null || input.attendanceSessionId === "" ? null : await linkable(ctx.env, ctx.society, input.attendanceSessionId)); fields.push("attendanceSessionId");
  }
  if (!sets.length) throw new HttpError(400, MSG.noChange, "no_change");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ? AND status = ?`).bind(...binds, m.id, m.status), guardChanged(ctx.env, MSG.conflict),
  ], "meeting.updated", await actorOf(ctx), { meeting: m.id, fields }, ctx.now);
  return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ the agenda (fixed once a notice is out)
const MAX_ITEMS = 100;
export async function addItem(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "draft") throw new HttpError(409, MSG.agendaFixed, "fixed");
  const title = words(input.title, "the title", 2, 120);
  const note = words(input.note, "the note", 2, 1000, true);
  const kind = oneOf(input.kind, ITEM_KINDS, MSG.badKind);
  const minutes = input.minutes === undefined || input.minutes === null ? null : whole(input.minutes, 1, 600, MSG.badMinutes);
  const n = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM meeting_items WHERE meeting_id = ?").bind(m.id).first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_ITEMS) throw new HttpError(409, MSG.tooManyItems, "too_many");
  const id = uid("itm");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.agendaFixed, "SELECT 1 FROM meetings WHERE id = ? AND status = 'draft'", m.id),
    ctx.env.DB.prepare("INSERT INTO meeting_items (id, society_id, meeting_id, position, title, note, kind, minutes, created_by, created_at) SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ?, ?, ? FROM meeting_items WHERE meeting_id = ?")
      .bind(id, ctx.society.id, m.id, title, note, kind, minutes, await pseudonym(ctx.env, ctx.email), ctx.now, m.id),
  ], "meeting.item_added", await actorOf(ctx), { meeting: m.id, item: id, kind }, ctx.now);
  const items = await itemsOf(ctx.env, m.id);
  return { agenda: items.map((i, k) => viewItem(i, k + 1)), audit: seq };
}

export async function editItem(ctx: StaffCtx, meetingId: string, itemId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "draft") throw new HttpError(409, MSG.agendaFixed, "fixed");
  const sets: string[] = [], binds: unknown[] = [], fields: string[] = [];
  if (input.title !== undefined) { sets.push("title = ?"); binds.push(words(input.title, "the title", 2, 120)); fields.push("title"); }
  if (input.note !== undefined) { sets.push("note = ?"); binds.push(words(input.note, "the note", 2, 1000, true)); fields.push("note"); }
  if (input.kind !== undefined) { sets.push("kind = ?"); binds.push(oneOf(input.kind, ITEM_KINDS, MSG.badKind)); fields.push("kind"); }
  if (input.minutes !== undefined) { sets.push("minutes = ?"); binds.push(input.minutes === null ? null : whole(input.minutes, 1, 600, MSG.badMinutes)); fields.push("minutes"); }
  if (!sets.length) throw new HttpError(400, MSG.noChange, "no_change");
  if (!(await ctx.env.DB.prepare("SELECT 1 AS x FROM meeting_items WHERE id = ? AND meeting_id = ?").bind(String(itemId).slice(0, 60), m.id).first())) throw new HttpError(404, MSG.notFound, "not_found");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.agendaFixed, "SELECT 1 FROM meetings WHERE id = ? AND status = 'draft'", m.id),
    ctx.env.DB.prepare(`UPDATE meeting_items SET ${sets.join(", ")} WHERE id = ? AND meeting_id = ?`).bind(...binds, String(itemId).slice(0, 60), m.id), guardChanged(ctx.env, MSG.notFound),
  ], "meeting.item_changed", await actorOf(ctx), { meeting: m.id, item: String(itemId).slice(0, 60), fields }, ctx.now);
  return { agenda: (await itemsOf(ctx.env, m.id)).map((i, k) => viewItem(i, k + 1)), audit: seq };
}

export async function removeItem(ctx: StaffCtx, meetingId: string, itemId: string) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "draft") throw new HttpError(409, MSG.agendaFixed, "fixed");
  if (!(await ctx.env.DB.prepare("SELECT 1 AS x FROM meeting_items WHERE id = ? AND meeting_id = ?").bind(String(itemId).slice(0, 60), m.id).first())) throw new HttpError(404, MSG.notFound, "not_found");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.agendaFixed, "SELECT 1 FROM meetings WHERE id = ? AND status = 'draft'", m.id),
    ctx.env.DB.prepare("DELETE FROM meeting_items WHERE id = ? AND meeting_id = ?").bind(String(itemId).slice(0, 60), m.id), guardChanged(ctx.env, MSG.notFound),
  ], "meeting.item_removed", await actorOf(ctx), { meeting: m.id, item: String(itemId).slice(0, 60) }, ctx.now);
  return { agenda: (await itemsOf(ctx.env, m.id)).map((i, k) => viewItem(i, k + 1)), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ the notice
/** Everything a notice states, exactly as sent. Its SHA-256 is the notice's fingerprint, so the agenda and date can be proven later. */
function snapshotOf(m: MeetingRow, items: ItemRow[], rule: RuleRow, version: number, startsAt: number, place: string, mode: string) {
  return {
    version, meeting: { number: m.number, title: m.title, type: m.meeting_type, startsAt, place, mode }, requiredDays: rule.notice_days, clause: rule.clause,
    agenda: items.map((i, k) => ({ n: k + 1, title: i.title, note: i.note, kind: i.kind, minutes: i.minutes })),
  };
}
const agendaKey = (items: ItemRow[]) => items.map((i) => [i.id, i.position, i.title, i.note, i.kind, i.minutes ?? ""].join("|")).join("\n");
const AGENDA_KEY_SQL = "SELECT 1 WHERE COALESCE((SELECT group_concat(x, char(10)) FROM (SELECT id || '|' || position || '|' || title || '|' || note || '|' || kind || '|' || COALESCE(minutes, '') AS x FROM meeting_items WHERE meeting_id = ? ORDER BY position, id)), '') = ?";
/** The people a notice reaches: everyone on the list now. */
const recipientsOf = async (ctx: StaffCtx) => (await buildRoll(ctx.env, ctx.society.id)).lines.filter((l) => l.row.email).length;

/** The bye-laws' notice period, counted in whole 24-hour days from the moment the notice is sent. A shorter notice is refused, with the earliest allowed time. */
function checkNoticePeriod(ctx: StaffCtx, rule: RuleRow, startsAt: number) {
  const earliest = ctx.now + rule.notice_days * DAY;
  if (earliest > startsAt) {
    const tz = ctx.society.tz_offset_min;
    throw new HttpError(409, `This notice is too short. The bye-laws need ${rule.notice_days} ${rule.notice_days === 1 ? "day" : "days"} of notice, so the meeting cannot be earlier than ${msToLocal(earliest, tz).replace("T", " ")} (${tzText(tz)}). Please move the meeting later, or send the notice sooner.`, "short_notice");
  }
}

export async function issueNotice(ctx: StaffCtx, meetingId: string) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status === "noticed") throw new HttpError(409, MSG.alreadyNoticed, "already_noticed");
  if (m.status !== "draft") throw new HttpError(409, MSG.notDraft, "not_draft");
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
  if (!rule) throw new HttpError(409, MSG.noRule, "no_rule");
  const items = await itemsOf(ctx.env, m.id);
  if (!items.length) throw new HttpError(400, MSG.noAgenda, "no_agenda");
  checkNoticePeriod(ctx, rule, m.starts_at);
  const recipients = await recipientsOf(ctx);
  if (!recipients) throw new HttpError(409, MSG.noRecipients, "no_recipients");
  const version = m.notice_version + 1;
  const snap = snapshotOf(m, items, rule, version, m.starts_at, m.place, m.mode);
  const fp = await fingerprintOf(snap);
  const id = uid("ntc");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.conflict, AGENDA_KEY_SQL, m.id, agendaKey(items)), // the agenda is exactly the one the notice states
    ctx.env.DB.prepare("UPDATE meetings SET status = 'noticed', notice_version = ? WHERE id = ? AND status = 'draft' AND notice_version = ?").bind(version, m.id, m.notice_version), guardChanged(ctx.env, MSG.conflict),
    ctx.env.DB.prepare("INSERT INTO meeting_notices (id, society_id, meeting_id, version, kind, issued_at, issued_by, starts_at, required_days, clause, reason, snapshot_json, fingerprint, recipients) VALUES (?, ?, ?, ?, 'notice', ?, ?, ?, ?, ?, '', ?, ?, ?)")
      .bind(id, ctx.society.id, m.id, version, ctx.now, await pseudonym(ctx.env, ctx.email), m.starts_at, rule.notice_days, rule.clause, JSON.stringify(snap), fp, recipients),
  ], "meeting.notice_issued", await actorOf(ctx), { meeting: m.id, version, kind: "notice", startsAt: m.starts_at, requiredDays: rule.notice_days, items: items.length, recipients, fingerprint: fp }, ctx.now);
  return { notice: viewNotice((await noticesOf(ctx, m.id)).find((n) => n.version === version)!, ctx.society.tz_offset_min), meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

/** Take the notice back so the date, place or agenda can change. The notice stays in the record, and so does the reason; the next notice is a new version. */
export async function withdrawNotice(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const reason = words(asInput(raw).reason, "the reason", 3, 200);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "noticed") throw new HttpError(409, MSG.notNoticed, "not_noticed");
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE meetings SET status = 'draft' WHERE id = ? AND status = 'noticed'").bind(m.id), guardChanged(ctx.env, MSG.conflict),
    ctx.env.DB.prepare("INSERT INTO meeting_events (society_id, meeting_id, kind, text, ts, by_pid) VALUES (?, ?, 'notice_withdrawn', ?, ?, ?)").bind(ctx.society.id, m.id, reason, ctx.now, pid),
  ], "meeting.notice_withdrawn", await actorOf(ctx), { meeting: m.id, version: m.notice_version, reason }, ctx.now);
  return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

/** A new date (and, if the Organizer says so, a new place) for a meeting whose notice is out. It is a new notice, and the notice period is checked again from now. */
export async function postponeMeeting(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const reason = words(input.reason, "the reason", 3, 200);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "noticed") throw new HttpError(409, MSG.cannotPostpone, "cannot_postpone");
  const at = localToMs(String(input.startsAt ?? ""), ctx.society.tz_offset_min); if (at === null) throw new HttpError(400, MSG.badTime, "bad_time");
  if (at === m.starts_at) throw new HttpError(400, MSG.samePostpone, "same_time");
  const place = input.place === undefined || input.place === null ? m.place : words(input.place, "the place", 2, 120, true);
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type); if (!rule) throw new HttpError(409, MSG.noRule, "no_rule");
  checkNoticePeriod(ctx, rule, at);
  const items = await itemsOf(ctx.env, m.id);
  const recipients = await recipientsOf(ctx);
  const version = m.notice_version + 1;
  const snap = snapshotOf(m, items, rule, version, at, place, m.mode);
  const fp = await fingerprintOf(snap);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE meetings SET starts_at = ?, place = ?, notice_version = ? WHERE id = ? AND status = 'noticed' AND notice_version = ?").bind(at, place, version, m.id, m.notice_version), guardChanged(ctx.env, MSG.conflict),
    ctx.env.DB.prepare("INSERT INTO meeting_notices (id, society_id, meeting_id, version, kind, issued_at, issued_by, starts_at, required_days, clause, reason, snapshot_json, fingerprint, recipients) VALUES (?, ?, ?, ?, 'postponed', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uid("ntc"), ctx.society.id, m.id, version, ctx.now, await pseudonym(ctx.env, ctx.email), at, rule.notice_days, rule.clause, reason, JSON.stringify(snap), fp, recipients),
  ], "meeting.postponed", await actorOf(ctx), { meeting: m.id, version, kind: "postponed", from: m.starts_at, startsAt: at, requiredDays: rule.notice_days, recipients, reason, fingerprint: fp }, ctx.now);
  return { notice: viewNotice((await noticesOf(ctx, m.id)).find((n) => n.version === version)!, ctx.society.tz_offset_min), meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

/** Cancel a meeting that has not started. If a notice is out, the cancellation is itself a notice with the reason; a draft is simply marked cancelled. */
export async function cancelMeeting(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const reason = words(asInput(raw).reason, "the reason", 3, 200);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "draft" && m.status !== "noticed") throw new HttpError(409, MSG.cannotCancel, "cannot_cancel");
  const stmts: D1Stmt[] = [];
  let version = m.notice_version, fp: string | null = null, recipients = 0;
  if (m.status === "noticed") {
    const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
    const items = await itemsOf(ctx.env, m.id);
    version = m.notice_version + 1; recipients = await recipientsOf(ctx);
    const snap = { ...snapshotOf(m, items, rule ?? { notice_days: 0, clause: "" } as RuleRow, version, m.starts_at, m.place, m.mode), requiredDays: null as number | null, cancelled: true };
    fp = await fingerprintOf(snap);
    stmts.push(
      ctx.env.DB.prepare("UPDATE meetings SET status = 'cancelled', notice_version = ? WHERE id = ? AND status = 'noticed' AND notice_version = ?").bind(version, m.id, m.notice_version), guardChanged(ctx.env, MSG.conflict),
      ctx.env.DB.prepare("INSERT INTO meeting_notices (id, society_id, meeting_id, version, kind, issued_at, issued_by, starts_at, required_days, clause, reason, snapshot_json, fingerprint, recipients) VALUES (?, ?, ?, ?, 'cancelled', ?, ?, ?, NULL, '', ?, ?, ?, ?)")
        .bind(uid("ntc"), ctx.society.id, m.id, version, ctx.now, await pseudonym(ctx.env, ctx.email), m.starts_at, reason, JSON.stringify(snap), fp, recipients),
    );
  } else {
    stmts.push(ctx.env.DB.prepare("UPDATE meetings SET status = 'cancelled' WHERE id = ? AND status = 'draft'").bind(m.id), guardChanged(ctx.env, MSG.conflict));
  }
  const seq = await commit(ctx.env, ctx.society.id, stmts, "meeting.cancelled", await actorOf(ctx), { meeting: m.id, from: m.status, version, recipients, reason, fingerprint: fp }, ctx.now);
  return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ the officers and the names at the end
/** The chair, the secretary and the timekeeper of one meeting. A name given again replaces the earlier one; the change stays in the signed log. */
export async function setRoles(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status === "closed" || m.status === "cancelled") throw new HttpError(409, MSG.closedFixed, "closed");
  const stmts: D1Stmt[] = [guardExists(ctx.env, MSG.closedFixed, "SELECT 1 FROM meetings WHERE id = ? AND status NOT IN ('closed','cancelled')", m.id)];
  const log: Record<string, string | null> = {};
  const pid = await pseudonym(ctx.env, ctx.email);
  for (const role of ["chair", "secretary", "timekeeper"] as const) {
    if (input[role] === undefined) continue;
    stmts.push(ctx.env.DB.prepare("DELETE FROM meeting_people WHERE meeting_id = ? AND role = ?").bind(m.id, role));
    if (input[role] === null) { if (role !== "timekeeper") throw new HttpError(400, MSG.badPeople, "bad_people"); log[role] = null; continue; }
    const p = person(input[role], role);
    stmts.push(ctx.env.DB.prepare("INSERT INTO meeting_people (society_id, meeting_id, role, name, email, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(ctx.society.id, m.id, role, p.name, p.email, pid, ctx.now));
    log[role] = await pseudonym(ctx.env, p.email);
  }
  if (Object.keys(log).length === 0) throw new HttpError(400, MSG.noChange, "no_change");
  const seq = await commit(ctx.env, ctx.society.id, stmts, "meeting.roles_set", await actorOf(ctx), { meeting: m.id, ...log }, ctx.now);
  return { people: (await peopleOf(ctx.env, m.id)).map((p) => viewPerson(p, seesFull(ctx))), audit: seq };
}

const ADDABLE = ["observer", "validated_by", "supervised_by"] as const;
/** Observers, and at the end of the meeting the names of who validated and who supervised it. Names are added, never removed. */
export async function addPerson(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const role = oneOf(input.role, ADDABLE, MSG.badRole);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status === "cancelled" || m.status === "draft") throw new HttpError(409, MSG.notRunning, "not_running");
  if (role !== "observer" && m.status !== "closed") throw new HttpError(409, MSG.signoffAfterClose, "not_closed");
  const p = person(input, role === "observer" ? "observer" : role === "validated_by" ? "person who validated the meeting" : "person who supervised the meeting");
  const n = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM meeting_people WHERE meeting_id = ? AND role = ?").bind(m.id, role).first<{ n: number }>())?.n ?? 0;
  if (n >= 20) throw new HttpError(409, MSG.tooManyPeople, "too_many");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("INSERT OR IGNORE INTO meeting_people (society_id, meeting_id, role, name, email, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(ctx.society.id, m.id, role, p.name, p.email, await pseudonym(ctx.env, ctx.email), ctx.now),
    guardChanged(ctx.env, MSG.personDone),
  ], "meeting.person_added", await actorOf(ctx), { meeting: m.id, role, person: await pseudonym(ctx.env, p.email) }, ctx.now);
  return { people: (await peopleOf(ctx.env, m.id)).map((x) => viewPerson(x, seesFull(ctx))), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ the run of the meeting
const haveRole = async (ctx: StaffCtx, meetingId: string, role: string) => !!(await ctx.env.DB.prepare("SELECT 1 AS x FROM meeting_people WHERE meeting_id = ? AND role = ?").bind(meetingId, role).first());
const eventStmt = (ctx: StaffCtx, meetingId: string, kind: string, text: string, pid: string) => ctx.env.DB.prepare("INSERT INTO meeting_events (society_id, meeting_id, kind, text, ts, by_pid) VALUES (?, ?, ?, ?, ?, ?)").bind(ctx.society.id, meetingId, kind, text, ctx.now, pid);

/** Open the meeting. Not before the time in the notice, and only once the chair and the secretary are named. The quorum gates decisions, not the opening. */
export async function startMeeting(ctx: StaffCtx, meetingId: string) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "noticed") throw new HttpError(409, MSG.notNoticed, "not_noticed");
  if (ctx.now < m.starts_at) throw new HttpError(409, MSG.tooEarlyToOpen, "too_early");
  if (!(await haveRole(ctx, m.id, "chair")) || !(await haveRole(ctx, m.id, "secretary"))) throw new HttpError(409, MSG.needOfficers, "need_officers");
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE meetings SET status = 'open', opened_at = ? WHERE id = ? AND status = 'noticed'").bind(ctx.now, m.id), guardChanged(ctx.env, MSG.conflict),
    eventStmt(ctx, m.id, "opened", "", pid),
  ], "meeting.opened", await actorOf(ctx), { meeting: m.id, version: m.notice_version }, ctx.now);
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
  const fresh = await meetingOf(ctx.env, ctx.society.id, m.id);
  return { meeting: viewMeeting(fresh, ctx.society.tz_offset_min), quorum: await quorumOf(ctx.env, ctx.society, fresh, rule), audit: seq };
}

export async function adjournMeeting(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const reason = words(asInput(raw).reason, "the reason", 3, 200);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open") throw new HttpError(409, MSG.notOpen, "not_open");
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE meetings SET status = 'adjourned' WHERE id = ? AND status = 'open'").bind(m.id), guardChanged(ctx.env, MSG.conflict), eventStmt(ctx, m.id, "adjourned", reason, pid),
  ], "meeting.adjourned", await actorOf(ctx), { meeting: m.id, reason }, ctx.now);
  return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

export async function resumeMeeting(ctx: StaffCtx, meetingId: string) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "adjourned") throw new HttpError(409, MSG.notAdjourned, "not_adjourned");
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE meetings SET status = 'open' WHERE id = ? AND status = 'adjourned'").bind(m.id), guardChanged(ctx.env, MSG.conflict), eventStmt(ctx, m.id, "resumed", "", pid),
  ], "meeting.resumed", await actorOf(ctx), { meeting: m.id }, ctx.now);
  return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

/** Close the meeting. Every motion must have its result or its withdrawal first, so nothing is left hanging. */
export async function closeMeeting(ctx: StaffCtx, meetingId: string) {
  need(ctx, "meetSetup"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open" && m.status !== "adjourned") throw new HttpError(409, MSG.notRunning, "not_running");
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.openMotions, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM motions WHERE meeting_id = ? AND status = 'moved')", m.id),
    ctx.env.DB.prepare("UPDATE meetings SET status = 'closed', closed_at = ? WHERE id = ? AND status IN ('open','adjourned')").bind(ctx.now, m.id), guardChanged(ctx.env, MSG.conflict), eventStmt(ctx, m.id, "closed", "", pid),
  ], "meeting.closed", await actorOf(ctx), { meeting: m.id }, ctx.now);
  return { meeting: viewMeeting(await meetingOf(ctx.env, ctx.society.id, m.id), ctx.society.tz_offset_min), audit: seq };
}

/** A point of order raised in the meeting, logged with the time. */
export async function pointOfOrder(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const text = words(asInput(raw).text, "the point of order", 3, 300);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open") throw new HttpError(409, MSG.notOpen, "not_open");
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.notOpen, "SELECT 1 FROM meetings WHERE id = ? AND status = 'open'", m.id), eventStmt(ctx, m.id, "point_of_order", text, pid),
  ], "meeting.point_of_order", await actorOf(ctx), { meeting: m.id, length: text.length }, ctx.now);
  return { events: viewEvents(await eventsOf(ctx, m.id)), audit: seq };
}
