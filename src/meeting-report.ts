// What Meetings shows to others: the public page (as much as the Organizer chose), the calendar file, and the full report of one meeting for the team.
// The public page never carries a name, an e-mail ID, a flat or a record id: only the notice, the agenda, the decisions and the approved minutes.
import { HttpError } from "./auth";
import { auditHead, commit, staffActor } from "./audit";
import type { Env } from "./db";
import { msToLocal } from "./lists";
import { MSG } from "./meeting-messages";
import {
  MAJORITY_WORDS, METHOD_WORDS, MODE_WORDS, STATUS_WORDS, TYPE_WORDS, fingerprintOf, itemsOf, meetingOf, noControls, notErased, peopleOf, quorumOf, ruleOf, tzText, viewItem, viewMeeting, viewPerson,
  type ItemRow, type MeetingRow, type NoticeRow,
} from "./meeting-core";
import { actionsOfMeeting, minutesOfMeeting, viewAction, viewMinutes } from "./meeting-minutes";
import { motionsOf } from "./meeting-motions";
import { eventsOf, noticesOf, viewEvents, viewNotice, viewRuleOrNone } from "./meetings";
import { need, seesFull, type SocietyRow, type StaffCtx } from "./store";

const shownTo = (m: Pick<MeetingRow, "visibility" | "notice_version" | "status">) => m.visibility !== "private" && m.notice_version >= 1 && m.status !== "draft";
const publicFacts = (m: MeetingRow, tz: number) => ({ id: m.id, number: m.number, title: m.title, type: m.meeting_type, typeText: TYPE_WORDS[m.meeting_type], startsAt: msToLocal(m.starts_at, tz), timeZone: tzText(tz), place: m.place, mode: m.mode, modeText: MODE_WORDS[m.mode], status: m.status, statusText: STATUS_WORDS[m.status], noticeVersion: m.notice_version });

/** Meetings the Organizer chose to show, newest first. A meeting with no notice out, or kept private, is not here at all. */
export async function publicMeetings(env: Env, society: SocietyRow) {
  const rs = (await env.DB.prepare("SELECT * FROM meetings WHERE society_id = ? AND visibility <> 'private' AND notice_version >= 1 AND status <> 'draft' ORDER BY starts_at DESC, number DESC LIMIT 100").bind(society.id).all<MeetingRow>()).results;
  return { list: society.name, meetings: rs.map((m) => publicFacts(m, society.tz_offset_min)) };
}

interface PublicDecision { number: number; text: string; majority: keyof typeof MAJORITY_WORDS; status: string; withdrawn_reason: string; item_title: string; method: keyof typeof METHOD_WORDS | null; for_count: number | null; against_count: number | null; abstain_count: number | null; outcome: string | null; quorum_eligible: number | null; quorum_required: number | null; quorum_present: number | null }

export async function publicMeeting(env: Env, society: SocietyRow, id: string) {
  const m = await meetingOf(env, society.id, id);
  if (!shownTo(m)) throw new HttpError(404, MSG.notFound, "not_found");
  const tz = society.tz_offset_min;
  const notices = await noticesOf({ env }, m.id);
  const last = notices[notices.length - 1];
  const out: Record<string, unknown> = {
    list: society.name, meeting: publicFacts(m, tz),
    notice: last ? { version: last.version, kind: last.kind, issuedAt: last.issued_at, startsAt: msToLocal(last.starts_at, tz), requiredDays: last.required_days, reason: last.reason, fingerprint: last.fingerprint } : null,
    agenda: (await itemsOf(env, m.id)).map((i, k) => ({ n: k + 1, title: i.title, note: i.note, kindText: i.kind === "decision" ? "For decision" : "For information", minutes: i.minutes })),
  };
  if (m.visibility === "all") {
    const rs = (await env.DB.prepare("SELECT x.number, x.text, x.majority, x.status, x.withdrawn_reason, i.title AS item_title, r.method, r.for_count, r.against_count, r.abstain_count, r.outcome, r.quorum_eligible, r.quorum_required, r.quorum_present FROM motions x JOIN meeting_items i ON i.id = x.item_id LEFT JOIN motion_results r ON r.motion_id = x.id WHERE x.meeting_id = ? AND x.status <> 'moved' ORDER BY x.number").bind(m.id).all<PublicDecision>()).results;
    out.decisions = rs.map((x) => ({
      n: x.number, itemTitle: x.item_title, text: x.text, majorityText: MAJORITY_WORDS[x.majority], status: x.status, withdrawnReason: x.withdrawn_reason,
      result: x.outcome ? { methodText: METHOD_WORDS[x.method!], for: x.for_count, against: x.against_count, abstain: x.abstain_count, outcomeText: x.outcome === "passed" ? "Passed" : "Not passed", quorum: { eligible: x.quorum_eligible, required: x.quorum_required, present: x.quorum_present } } : null,
    }));
    const approved = [...(await minutesOfMeeting({ env }, m.id))].reverse().find((r) => r.status === "approved");
    out.minutes = approved ? { version: approved.version, body: approved.body, fingerprint: approved.fingerprint, approvedAt: approved.approved_at } : null;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ the calendar file
const icsTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsText = (s: string) => noControls(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
/** Lines longer than 75 bytes are folded as the calendar standard says, never inside a letter. */
function fold(line: string): string {
  const enc = new TextEncoder(); let out = "", used = 0, first = true;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (used + n > (first ? 75 : 74)) { out += "\r\n "; used = 0; first = false; }
    out += ch; used += n;
  }
  return out;
}
export function calendarText(m: MeetingRow, items: ItemRow[], stamp: number): string {
  const timed = items.length > 0 && items.every((i) => i.minutes !== null);
  const total = timed ? items.reduce((a, i) => a + (i.minutes ?? 0), 0) : 0;
  const description = [`${TYPE_WORDS[m.meeting_type]} number ${m.number}. ${MODE_WORDS[m.mode]}.`, "Agenda:", ...items.map((i, k) => `${k + 1}. ${i.title} (${i.kind === "decision" ? "for decision" : "for information"})`)].join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Townhall Records//Meetings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${m.id}@townhall-records.com`, `DTSTAMP:${icsTime(stamp)}`, `SEQUENCE:${m.notice_version}`, `DTSTART:${icsTime(m.starts_at)}`,
    ...(total ? [`DTEND:${icsTime(m.starts_at + total * 60_000)}`] : []),
    `SUMMARY:${icsText(m.title)}`, ...(m.place ? [`LOCATION:${icsText(m.place)}`] : []), `DESCRIPTION:${icsText(description)}`, `STATUS:${m.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
export async function publicCalendar(env: Env, society: SocietyRow, id: string, now: number) {
  const m = await meetingOf(env, society.id, id);
  if (!shownTo(m)) throw new HttpError(404, MSG.notFound, "not_found");
  return { body: calendarText(m, await itemsOf(env, m.id), now), type: "text/calendar; charset=utf-8", filename: `meeting-${m.number}.ics` };
}
export async function staffCalendar(ctx: StaffCtx, id: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, id);
  return { body: calendarText(m, await itemsOf(ctx.env, m.id), ctx.now), type: "text/calendar; charset=utf-8", filename: `meeting-${m.number}.ics` };
}

// ------------------------------------------------------------------------------------------------------------------ the report of one meeting
/**
 * Everything about one meeting in one document: the notices with their fingerprints, the agenda, the people and their roles, what happened in the room, every motion with its counts,
 * its quorum and who counted, the minutes, the action items, the names at the end, and where the signed log stood. The report has its own fingerprint. A co-organizer gets masked names and e-mail IDs.
 * Every copy taken is written to the signed log.
 */
export async function reportOf(ctx: StaffCtx, id: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, id);
  const tz = ctx.society.tz_offset_min; const full = seesFull(ctx);
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
  const minutes = await minutesOfMeeting(ctx, m.id);
  const approved = [...minutes].reverse().find((r) => r.status === "approved") ?? null;
  const head = await auditHead(ctx.env, ctx.society.id);
  const body = JSON.parse(JSON.stringify({
    list: ctx.society.name, meeting: viewMeeting(m, tz), final: m.status === "closed", rule: viewRuleOrNone(rule, m.meeting_type), attendance: await quorumOf(ctx.env, ctx.society, m, rule),
    notices: (await noticesOf(ctx, m.id)).map((n: NoticeRow) => viewNotice(n, tz)), agenda: (await itemsOf(ctx.env, m.id)).map((i, k) => viewItem(i, k + 1)),
    people: (await peopleOf(ctx.env, m.id)).map((p) => viewPerson(p, full)), events: viewEvents(await eventsOf(ctx, m.id)), motions: await motionsOf(ctx, m),
    minutes: { versions: minutes.map((r) => viewMinutes(r, false)), approved: approved ? viewMinutes(approved) : null },
    actions: (await actionsOfMeeting(ctx, m.id)).map((a) => viewAction(a, full)), trail: head ? { seq: head.seq, hash: head.hash } : null, generatedAt: ctx.now,
  }));
  const fingerprint = await fingerprintOf(body);
  await commit(ctx.env, ctx.society.id, [], "meeting.report_taken", await staffActor(ctx.env, ctx.email, ctx.role), { meeting: m.id, full, fingerprint }, ctx.now);
  return { report: body, fingerprint };
}
