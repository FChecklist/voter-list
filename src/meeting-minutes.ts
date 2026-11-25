// Minutes and action items of a meeting. Minutes are drafted by a person or by an AI helper and are always called a draft until a later meeting approves them.
// Every version is kept; a version never changes; approved minutes are frozen with their fingerprint, and a correction is a new linked version with its reason.
import { HttpError } from "./auth";
import { commit, guardChanged, guardExists, pseudonym, staffActor } from "./audit";
import { uid } from "./db";
import { MSG } from "./meeting-messages";
import { fingerprintOf, longText, meetingOf, needMeet, noControls, notErased, oneOf, person, words, type MeetingRow } from "./meeting-core";
import { need, seesFull, type StaffCtx } from "./store";
import { maskEmail, maskName } from "./vendor/masking";
import { squeeze } from "./text";

export interface MinutesRow { id: string; society_id: string; meeting_id: string; version: number; body: string; source: "human" | "ai"; status: "draft" | "approved"; supersedes_id: string | null; reason: string; fingerprint: string; created_by: string; created_at: number; accepted_by: string | null; accepted_at: number | null; approved_by: string | null; approved_at: number | null; approved_in_meeting_id: string | null }
interface ActionRow { id: string; society_id: string; meeting_id: string; motion_id: string | null; text: string; owner_name: string; owner_email: string; due_date: string; status: "open" | "done" | "dropped"; created_by: string; created_at: number; updated_at: number }
type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {});
const actorOf = (ctx: StaffCtx) => staffActor(ctx.env, ctx.email, ctx.role);
const SOURCES = ["human", "ai"] as const;

export const minutesStatusText = (r: MinutesRow) => (r.status === "approved" ? "Approved" : r.source === "ai" && !r.accepted_at ? "Draft written by an AI helper, not yet accepted by a person" : "Draft");
export const viewMinutes = (r: MinutesRow, withBody = true) => ({
  id: r.id, version: r.version, source: r.source, sourceText: r.source === "ai" ? "Written by an AI helper" : "Written by a person", status: r.status, statusText: minutesStatusText(r), reason: r.reason, fingerprint: r.fingerprint,
  createdAt: r.created_at, acceptedAt: r.accepted_at, approvedAt: r.approved_at, approvedInMeetingId: r.approved_in_meeting_id, supersedesId: r.supersedes_id, ...(withBody ? { body: r.body } : {}),
});
export const minutesOfMeeting = async (ctx: Pick<StaffCtx, "env">, meetingId: string) => (await ctx.env.DB.prepare("SELECT * FROM mtg_minutes WHERE meeting_id = ? ORDER BY version").bind(meetingId).all<MinutesRow>()).results;

export async function listMinutes(ctx: StaffCtx, meetingId: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  const rows = await minutesOfMeeting(ctx, m.id);
  const approved = [...rows].reverse().find((r) => r.status === "approved") ?? null;
  const latest = rows[rows.length - 1] ?? null;
  return { versions: rows.map((r) => viewMinutes(r, false)), latest: latest ? viewMinutes(latest) : null, approved: approved ? viewMinutes(approved) : null };
}

/** A new draft. After the meeting is closed, by a person or an AI helper (the source is recorded). The second and later versions are corrections: they need a reason. */
export async function draftMinutes(ctx: StaffCtx, meetingId: string, raw: unknown) {
  needMeet(ctx, "meetRun"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "closed") throw new HttpError(409, MSG.notClosed, "not_closed");
  const body = longText(input.body, "the minutes", 10, 20000);
  const source = oneOf(input.source, SOURCES, MSG.badSource);
  const rows = await minutesOfMeeting(ctx, m.id);
  const last = rows[rows.length - 1] ?? null;
  const said = squeeze(noControls(input.reason));
  if (last && !said) throw new HttpError(400, MSG.needReason, "need_reason");
  const reason = said ? words(said, "the reason", 3, 300) : "";
  const version = (last?.version ?? 0) + 1;
  const fp = await fingerprintOf({ meeting: m.id, version, body, source });
  const id = uid("min");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.conflict, "SELECT 1 WHERE (SELECT COALESCE(MAX(version), 0) FROM mtg_minutes WHERE meeting_id = ?) = ?", m.id, version - 1),
    ctx.env.DB.prepare("INSERT INTO mtg_minutes (id, society_id, meeting_id, version, body, source, status, supersedes_id, reason, fingerprint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
      .bind(id, ctx.society.id, m.id, version, body, source, last?.id ?? null, reason, fp, await pseudonym(ctx.env, ctx.email), ctx.now),
  ], "minutes.drafted", await actorOf(ctx), { meeting: m.id, version, source, supersedes: last?.id ?? null, fingerprint: fp }, ctx.now);
  return { minutes: viewMinutes((await minutesOfMeeting(ctx, m.id)).find((r) => r.id === id)!), audit: seq };
}

const oneMinutes = async (ctx: StaffCtx, m: MeetingRow, id: string) => {
  const r = await ctx.env.DB.prepare("SELECT * FROM mtg_minutes WHERE id = ? AND meeting_id = ?").bind(String(id).slice(0, 60), m.id).first<MinutesRow>();
  if (!r) throw new HttpError(404, MSG.minutesNotFound, "not_found");
  return r;
};

/** A person reads a draft written by an AI helper and accepts it as a draft worth approving. This step is the person's, never the AI helper's. */
export async function acceptMinutes(ctx: StaffCtx, meetingId: string, minutesId: string) {
  needMeet(ctx, "meetRun"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  const r = await oneMinutes(ctx, m, minutesId);
  if (r.source !== "ai") throw new HttpError(409, MSG.notAi, "not_ai");
  if (r.status === "approved") throw new HttpError(409, MSG.minutesDone, "done");
  if (r.accepted_at) throw new HttpError(409, MSG.alreadyAccepted, "already_accepted");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE mtg_minutes SET accepted_by = ?, accepted_at = ? WHERE id = ? AND status = 'draft' AND source = 'ai' AND accepted_at IS NULL").bind(await pseudonym(ctx.env, ctx.email), ctx.now, r.id), guardChanged(ctx.env, MSG.alreadyAccepted),
  ], "minutes.accepted", await actorOf(ctx), { meeting: m.id, version: r.version, fingerprint: r.fingerprint }, ctx.now);
  return { minutes: viewMinutes((await minutesOfMeeting(ctx, m.id)).find((x) => x.id === r.id)!), audit: seq };
}

/** The Organizer records that a LATER meeting approved these minutes. From then they are frozen with their fingerprint; a correction is a new version. */
export async function approveMinutes(ctx: StaffCtx, meetingId: string, minutesId: string, raw: unknown) {
  needMeet(ctx, "meetSetup"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  const r = await oneMinutes(ctx, m, minutesId);
  if (r.status === "approved") throw new HttpError(409, MSG.minutesDone, "done");
  const latest = (await minutesOfMeeting(ctx, m.id)).reduce((a, x) => Math.max(a, x.version), 0);
  if (r.version !== latest) throw new HttpError(409, MSG.minutesNotLatest, "not_latest");
  if (r.source === "ai" && !r.accepted_at) throw new HttpError(409, MSG.needAccept, "need_accept");
  const other = await meetingOf(ctx.env, ctx.society.id, String(input.approvedInMeetingId ?? ""));
  if (other.id === m.id || other.starts_at <= m.starts_at || !["open", "adjourned", "closed"].includes(other.status)) throw new HttpError(409, MSG.needLater, "need_later");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.minutesNotLatest, "SELECT 1 WHERE (SELECT MAX(version) FROM mtg_minutes WHERE meeting_id = ?) = ?", m.id, r.version),
    ctx.env.DB.prepare("UPDATE mtg_minutes SET status = 'approved', approved_by = ?, approved_at = ?, approved_in_meeting_id = ? WHERE id = ? AND status = 'draft'").bind(await pseudonym(ctx.env, ctx.email), ctx.now, other.id, r.id), guardChanged(ctx.env, MSG.minutesDone),
  ], "minutes.approved", await actorOf(ctx), { meeting: m.id, version: r.version, inMeeting: other.id, fingerprint: r.fingerprint }, ctx.now);
  return { minutes: viewMinutes((await minutesOfMeeting(ctx, m.id)).find((x) => x.id === r.id)!), audit: seq };
}

// ------------------------------------------------------------------------------------------------------------------ action items
const ACTION_STATES = ["open", "done", "dropped"] as const;
const ACTION_WORDS = { open: "Open", done: "Done", dropped: "Dropped" } as const;
const validDate = (s: string) => {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!p) return false;
  const [y, mo, d] = [Number(p[1]), Number(p[2]), Number(p[3])]; const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2200 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};
export const viewAction = (a: ActionRow, full: boolean) => ({
  id: a.id, text: a.text, owner: { name: full ? a.owner_name : maskName(a.owner_name), email: full ? a.owner_email : maskEmail(a.owner_email) }, dueDate: a.due_date, status: a.status, statusText: ACTION_WORDS[a.status], motionId: a.motion_id, createdAt: a.created_at, updatedAt: a.updated_at,
});
export const actionsOfMeeting = async (ctx: Pick<StaffCtx, "env">, meetingId: string) => (await ctx.env.DB.prepare("SELECT * FROM mtg_actions WHERE meeting_id = ? ORDER BY due_date, created_at, id").bind(meetingId).all<ActionRow>()).results;

export async function listActions(ctx: StaffCtx, meetingId: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  return { actions: (await actionsOfMeeting(ctx, m.id)).map((a) => viewAction(a, seesFull(ctx))) };
}

/** What someone will do after the meeting: the task, the owner, the date. The owner's e-mail ID stays with the Organizer and is masked for a co-organizer. */
export async function addAction(ctx: StaffCtx, meetingId: string, raw: unknown) {
  needMeet(ctx, "meetRun"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (!["open", "adjourned", "closed"].includes(m.status)) throw new HttpError(409, MSG.notStarted, "not_started");
  const text = words(input.text, "the action", 2, 300);
  const owner = person({ name: input.ownerName, email: input.ownerEmail }, "owner");
  const due = String(input.dueDate ?? "").trim(); if (!validDate(due)) throw new HttpError(400, MSG.badDate, "bad_date");
  let motionId: string | null = null;
  if (input.motionId !== undefined && input.motionId !== null && input.motionId !== "") {
    const x = await ctx.env.DB.prepare("SELECT id FROM mtg_motions WHERE id = ? AND meeting_id = ?").bind(String(input.motionId).slice(0, 60), m.id).first<{ id: string }>();
    if (!x) throw new HttpError(404, MSG.motionNotFound, "not_found");
    motionId = x.id;
  }
  const n = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM mtg_actions WHERE meeting_id = ?").bind(m.id).first<{ n: number }>())?.n ?? 0;
  if (n >= 200) throw new HttpError(409, MSG.tooManyActions, "too_many");
  const id = uid("act");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("INSERT INTO mtg_actions (id, society_id, meeting_id, motion_id, text, owner_name, owner_email, due_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)")
      .bind(id, ctx.society.id, m.id, motionId, text, owner.name, owner.email, due, await pseudonym(ctx.env, ctx.email), ctx.now, ctx.now),
  ], "action.added", await actorOf(ctx), { meeting: m.id, action: id, due, motion: motionId, owner: await pseudonym(ctx.env, owner.email) }, ctx.now);
  return { actions: (await actionsOfMeeting(ctx, m.id)).map((a) => viewAction(a, seesFull(ctx))), audit: seq };
}

export async function updateAction(ctx: StaffCtx, meetingId: string, actionId: string, raw: unknown) {
  needMeet(ctx, "meetRun"); notErased(ctx.society);
  const status = oneOf(asInput(raw).status, ACTION_STATES, MSG.badStatus);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (!(await ctx.env.DB.prepare("SELECT 1 AS x FROM mtg_actions WHERE id = ? AND meeting_id = ?").bind(String(actionId).slice(0, 60), m.id).first())) throw new HttpError(404, MSG.actionNotFound, "not_found");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE mtg_actions SET status = ?, updated_at = ? WHERE id = ? AND meeting_id = ?").bind(status, ctx.now, String(actionId).slice(0, 60), m.id), guardChanged(ctx.env, MSG.actionNotFound),
  ], "action.updated", await actorOf(ctx), { meeting: m.id, action: String(actionId).slice(0, 60), status }, ctx.now);
  return { actions: (await actionsOfMeeting(ctx, m.id)).map((a) => viewAction(a, seesFull(ctx))), audit: seq };
}
