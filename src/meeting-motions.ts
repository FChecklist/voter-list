// Motions of a meeting: moved by one person and seconded by another, voted by a stated method, decided only with a quorum and a named counter,
// amended by linked motions, withdrawn in the open, and never deleted. The vote counts and who counted are part of the result; the quorum as it stood is kept with it.
import { HttpError } from "./auth";
import { commit, guardChanged, guardExists, pseudonym, staffActor } from "./audit";
import { uid } from "./db";
import { MSG } from "./meeting-messages";
import {
  MAJORITY, MAJORITY_WORDS, METHODS, METHOD_WORDS, fingerprintOf, meetingOf, noQuorumNext, notErased, oneOf, person, quorumOf, ruleOf, whole, words,
  type ItemRow, type Majority, type MeetingRow, type Method, type Person,
} from "./meeting-core";
import { buildRoll, need, seesFull, type RollLine, type StaffCtx } from "./store";
import { maskEmail, maskName } from "./vendor/masking";

interface MotionRow { id: string; society_id: string; meeting_id: string; item_id: string; number: number; text: string; mover_voter_id: string; seconder_voter_id: string; majority: Majority; amends_motion_id: string | null; status: "moved" | "withdrawn" | "decided"; withdrawn_reason: string; created_by: string; created_at: number; closed_at: number | null; item_title?: string }
interface ResultRow { motion_id: string; method: Method; for_count: number; against_count: number; abstain_count: number; counted_by_json: string; quorum_eligible: number; quorum_required: number; quorum_present: number; outcome: "passed" | "not_passed"; note: string; decided_at: number }
interface InterestRow { motion_id: string; voter_id: string; note: string; declared_at: number }
type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {});
const actorOf = (ctx: StaffCtx) => staffActor(ctx.env, ctx.email, ctx.role);
const STATUS_WORDS = { moved: "Waiting for a result", withdrawn: "Withdrawn", decided: "Decided" } as const;
const OUTCOME_WORDS = { passed: "Passed", not_passed: "Not passed" } as const;

/** Does a vote carry? Only the votes for and against count; abstentions are shown but are not in the sum. Nothing carries on no votes at all. */
export function passes(majority: Majority, forCount: number, againstCount: number): boolean {
  const d = forCount + againstCount;
  if (d === 0) return false;
  if (majority === "simple") return forCount > againstCount;
  if (majority === "two_thirds") return 3 * forCount >= 2 * d;
  return 4 * forCount >= 3 * d;
}

/** Everyone on the list now, by record id. */
export const rollOf = async (ctx: Pick<StaffCtx, "env" | "society">): Promise<Map<string, RollLine>> => new Map((await buildRoll(ctx.env, ctx.society.id)).lines.map((l) => [l.voterId, l]));
const shownName = (roll: Map<string, RollLine>, id: string, full: boolean) => { const l = roll.get(id); return l ? (full ? l.row.name : maskName(l.row.name)) : "(no longer on the list)"; };
const voterCode = (ctx: Pick<StaffCtx, "env">, l: RollLine) => pseudonym(ctx.env, l.row.email + "|" + l.voterId);

/** The motions of a meeting with their results and declared interests. A co-organizer sees names and e-mail IDs masked. */
export async function motionsOf(ctx: Pick<StaffCtx, "env" | "society" | "role">, m: MeetingRow) {
  const db = ctx.env.DB;
  const xs = (await db.prepare("SELECT x.*, i.title AS item_title FROM motions x JOIN meeting_items i ON i.id = x.item_id WHERE x.meeting_id = ? ORDER BY x.number").bind(m.id).all<MotionRow>()).results;
  const rs = new Map((await db.prepare("SELECT * FROM motion_results WHERE meeting_id = ?").bind(m.id).all<ResultRow>()).results.map((r) => [r.motion_id, r]));
  const ins = (await db.prepare("SELECT motion_id, voter_id, note, declared_at FROM motion_interests WHERE motion_id IN (SELECT id FROM motions WHERE meeting_id = ?) ORDER BY declared_at, voter_id").bind(m.id).all<InterestRow>()).results;
  const roll = await rollOf(ctx); const full = seesFull(ctx);
  const numberOf = new Map(xs.map((x) => [x.id, x.number]));
  return xs.map((x) => {
    const r = rs.get(x.id);
    const counted = r ? (JSON.parse(r.counted_by_json) as Person[]).map((p) => ({ name: full ? p.name : maskName(p.name), email: full ? p.email : maskEmail(p.email) })) : [];
    return {
      id: x.id, n: x.number, itemId: x.item_id, itemTitle: x.item_title ?? "", text: x.text, majority: x.majority, majorityText: MAJORITY_WORDS[x.majority], status: x.status, statusText: STATUS_WORDS[x.status],
      mover: { voterId: x.mover_voter_id, name: shownName(roll, x.mover_voter_id, full) }, seconder: { voterId: x.seconder_voter_id, name: shownName(roll, x.seconder_voter_id, full) },
      amends: x.amends_motion_id ? numberOf.get(x.amends_motion_id) ?? null : null, withdrawnReason: x.withdrawn_reason, movedAt: x.created_at, closedAt: x.closed_at,
      interests: ins.filter((i) => i.motion_id === x.id).map((i) => ({ name: shownName(roll, i.voter_id, full), note: i.note, declaredAt: i.declared_at })),
      result: r ? {
        method: r.method, methodText: METHOD_WORDS[r.method], for: r.for_count, against: r.against_count, abstain: r.abstain_count, outcome: r.outcome, outcomeText: OUTCOME_WORDS[r.outcome],
        quorum: { eligible: r.quorum_eligible, required: r.quorum_required, present: r.quorum_present }, countedBy: counted, note: r.note, decidedAt: r.decided_at,
      } : null,
    };
  });
}

export async function decisions(ctx: StaffCtx, meetingId: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  return { meeting: { id: m.id, number: m.number, title: m.title, status: m.status }, motions: await motionsOf(ctx, m) };
}

/** The quorum as it stands now, and when it is not met, the next steps the bye-laws allow (adjourn, or hold again as the Organizer wrote it). */
export async function quorumView(ctx: StaffCtx, meetingId: string) {
  need(ctx, "view"); notErased(ctx.society);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
  const quorum = await quorumOf(ctx.env, ctx.society, m, rule);
  return { quorum, next: quorum.ruleSet && quorum.linked && !quorum.met ? noQuorumNext(rule) : null };
}

const oneMotion = async (ctx: StaffCtx, m: MeetingRow, id: string) => {
  const x = await ctx.env.DB.prepare("SELECT * FROM motions WHERE id = ? AND meeting_id = ?").bind(String(id).slice(0, 60), m.id).first<MotionRow>();
  if (!x) throw new HttpError(404, MSG.motionNotFound, "not_found");
  return x;
};
const viewOne = async (ctx: StaffCtx, m: MeetingRow, id: string) => (await motionsOf(ctx, m)).find((x) => x.id === id) ?? null;

export async function moveMotion(ctx: StaffCtx, meetingId: string, raw: unknown) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open") throw new HttpError(409, MSG.needMotionOpen, "not_open");
  const item = await ctx.env.DB.prepare("SELECT * FROM meeting_items WHERE id = ? AND meeting_id = ?").bind(String(input.itemId ?? "").slice(0, 60), m.id).first<ItemRow>();
  if (!item) throw new HttpError(404, MSG.notFound, "not_found");
  if (item.kind !== "decision") throw new HttpError(409, MSG.notDecision, "not_decision");
  const text = words(input.text, "the motion", 2, 1000);
  const majority = oneOf(input.majority, MAJORITY, MSG.badMajority);
  const roll = await rollOf(ctx);
  const moverId = String(input.moverVoterId ?? "").slice(0, 60), seconderId = String(input.seconderVoterId ?? "").slice(0, 60);
  const mover = roll.get(moverId), seconder = roll.get(seconderId);
  if (!mover || !seconder) throw new HttpError(404, MSG.notOnList, "not_on_list");
  if (moverId === seconderId) throw new HttpError(400, MSG.sameMoverSeconder, "same_person");
  if (!mover.row.canVote || !seconder.row.canVote) throw new HttpError(409, MSG.notVoter, "not_voter");
  let amends: MotionRow | null = null;
  if (input.amendsMotionId !== undefined && input.amendsMotionId !== null && input.amendsMotionId !== "") {
    amends = await oneMotion(ctx, m, String(input.amendsMotionId));
    if (amends.status !== "moved") throw new HttpError(409, MSG.amendDone, "amend_done");
    if (amends.amends_motion_id) throw new HttpError(409, MSG.oneLevel, "one_level");
    if (amends.item_id !== item.id) throw new HttpError(409, MSG.amendOther, "amend_other");
  }
  const fp = await fingerprintOf({ text, item: item.id, majority, mover: moverId, seconder: seconderId, amends: amends?.id ?? null });
  const pid = await pseudonym(ctx.env, ctx.email);
  for (let attempt = 0; ; attempt++) {
    const id = uid("mot");
    try {
      await commit(ctx.env, ctx.society.id, [
        guardExists(ctx.env, MSG.needMotionOpen, "SELECT 1 FROM meetings WHERE id = ? AND status = 'open'", m.id),
        ...(amends ? [guardExists(ctx.env, MSG.amendDone, "SELECT 1 FROM motions WHERE id = ? AND status = 'moved'", amends.id)] : []),
        ctx.env.DB.prepare("INSERT INTO motions (id, society_id, meeting_id, item_id, number, text, mover_voter_id, seconder_voter_id, majority, amends_motion_id, status, withdrawn_reason, created_by, created_at) SELECT ?, ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, 'moved', '', ?, ? FROM motions WHERE meeting_id = ?")
          .bind(id, ctx.society.id, m.id, item.id, text, moverId, seconderId, majority, amends?.id ?? null, pid, ctx.now, m.id),
      ], "motion.moved", await actorOf(ctx), { meeting: m.id, motion: id, item: item.id, majority, amends: amends?.id ?? null, mover: await voterCode(ctx, mover), seconder: await voterCode(ctx, seconder), fingerprint: fp }, ctx.now);
      return { motion: await viewOne(ctx, m, id) };
    } catch (e) {
      // two motions moved at the same moment can pick the same number: the loser takes the next one
      if (attempt < 3 && /UNIQUE/i.test(String((e as Error)?.message ?? e)) && /motions\.(meeting_id|number)/i.test(String((e as Error)?.message ?? e))) continue;
      throw e;
    }
  }
}

/** A motion is withdrawn in the open: the reason is kept and shown, the motion stays. Its pending amendments go with it. */
export async function withdrawMotion(ctx: StaffCtx, meetingId: string, motionId: string, raw: unknown) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const reason = words(asInput(raw).reason, "the reason", 3, 200);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open" && m.status !== "adjourned") throw new HttpError(409, MSG.notRunning, "not_running");
  const x = await oneMotion(ctx, m, motionId);
  if (x.status !== "moved") throw new HttpError(409, MSG.motionDone, "motion_done");
  const seq = await commit(ctx.env, ctx.society.id, [
    ctx.env.DB.prepare("UPDATE motions SET status = 'withdrawn', withdrawn_reason = ?, closed_at = ? WHERE id = ? AND status = 'moved'").bind(reason, ctx.now, x.id), guardChanged(ctx.env, MSG.motionDone),
    ctx.env.DB.prepare("UPDATE motions SET status = 'withdrawn', withdrawn_reason = ?, closed_at = ? WHERE amends_motion_id = ? AND status = 'moved'").bind("The motion it amends was withdrawn.", ctx.now, x.id),
  ], "motion.withdrawn", await actorOf(ctx), { meeting: m.id, motion: x.id, n: x.number, reason }, ctx.now);
  return { motion: await viewOne(ctx, m, x.id), audit: seq };
}

/** A person who has an interest in a motion is named on it and kept out of that vote: the votes recorded cannot exceed the people present less those named. */
export async function declareInterest(ctx: StaffCtx, meetingId: string, motionId: string, raw: unknown) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const input = asInput(raw);
  const note = words(input.note, "the note", 2, 200, true);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open" && m.status !== "adjourned") throw new HttpError(409, MSG.notRunning, "not_running");
  const x = await oneMotion(ctx, m, motionId);
  if (x.status !== "moved") throw new HttpError(409, MSG.motionDone, "motion_done");
  const voterId = String(input.voterId ?? "").slice(0, 60);
  const line = (await rollOf(ctx)).get(voterId);
  if (!line) throw new HttpError(404, MSG.notOnList, "not_on_list");
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.motionDone, "SELECT 1 FROM motions WHERE id = ? AND status = 'moved'", x.id),
    ctx.env.DB.prepare("INSERT OR IGNORE INTO motion_interests (motion_id, society_id, voter_id, note, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?)").bind(x.id, ctx.society.id, voterId, note, await pseudonym(ctx.env, ctx.email), ctx.now),
    guardChanged(ctx.env, MSG.interestDone),
  ], "motion.interest_declared", await actorOf(ctx), { meeting: m.id, motion: x.id, voter: await voterCode(ctx, line) }, ctx.now);
  return { motion: await viewOne(ctx, m, x.id), audit: seq };
}

const counted = (v: unknown): number => whole(v, 0, 1_000_000, MSG.badCount);

/**
 * The result of a motion: the counts and who counted. It is recorded only while the meeting is open, with the quorum met, with at least one counter who is not the chair,
 * and with the motion's amendments already decided. The quorum as it stood is kept with the result. A result is final.
 */
export async function recordResult(ctx: StaffCtx, meetingId: string, motionId: string, raw: unknown) {
  need(ctx, "meetRun"); notErased(ctx.society);
  const input = asInput(raw);
  const m = await meetingOf(ctx.env, ctx.society.id, meetingId);
  if (m.status !== "open") throw new HttpError(409, MSG.needMotionOpen, "not_open");
  const x = await oneMotion(ctx, m, motionId);
  if (x.status !== "moved") throw new HttpError(409, MSG.motionDone, "motion_done");
  const pending = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM motions WHERE amends_motion_id = ? AND status = 'moved'").bind(x.id).first<{ n: number }>())?.n ?? 0;
  if (pending) throw new HttpError(409, MSG.amendmentsFirst, "amendments_first");
  const method = oneOf(input.method, METHODS, MSG.badMethod);
  const forCount = counted(input.for), againstCount = counted(input.against), abstainCount = counted(input.abstain === undefined ? 0 : input.abstain);
  const note = words(input.note, "the note", 2, 200, true);
  const list = Array.isArray(input.countedBy) ? input.countedBy.slice(0, 5) : [];
  const counters = list.map((c) => person(c, "counter"));
  const chair = await ctx.env.DB.prepare("SELECT email FROM meeting_people WHERE meeting_id = ? AND role = 'chair'").bind(m.id).first<{ email: string }>();
  if (!counters.length || !counters.some((c) => c.email.toLowerCase() !== (chair?.email ?? "").toLowerCase())) throw new HttpError(400, MSG.needCounter, "need_counter");
  const rule = await ruleOf(ctx.env, ctx.society.id, m.meeting_type);
  const q = await quorumOf(ctx.env, ctx.society, m, rule);
  if (!q.met) throw new HttpError(409, !q.ruleSet ? MSG.noQuorumRule : !q.linked ? MSG.needAttendance : MSG.noQuorum, "no_quorum");
  const interests = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM motion_interests WHERE motion_id = ?").bind(x.id).first<{ n: number }>())?.n ?? 0;
  if (q.linked && forCount + againstCount + abstainCount > Math.max(0, q.present - interests)) throw new HttpError(400, MSG.tooManyVotes, "too_many_votes");
  const outcome = passes(x.majority, forCount, againstCount) ? "passed" : "not_passed";
  const pid = await pseudonym(ctx.env, ctx.email);
  const seq = await commit(ctx.env, ctx.society.id, [
    guardExists(ctx.env, MSG.needMotionOpen, "SELECT 1 FROM meetings WHERE id = ? AND status = 'open'", m.id),
    guardExists(ctx.env, MSG.amendmentsFirst, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM motions WHERE amends_motion_id = ? AND status = 'moved')", x.id),
    ctx.env.DB.prepare("UPDATE motions SET status = 'decided', closed_at = ? WHERE id = ? AND status = 'moved'").bind(ctx.now, x.id), guardChanged(ctx.env, MSG.motionDone),
    ctx.env.DB.prepare("INSERT INTO motion_results (motion_id, society_id, meeting_id, method, for_count, against_count, abstain_count, counted_by_json, quorum_eligible, quorum_required, quorum_present, outcome, note, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(x.id, ctx.society.id, m.id, method, forCount, againstCount, abstainCount, JSON.stringify(counters.map((c) => ({ name: c.name, email: c.email }))), q.eligible, q.required, q.present, outcome, note, ctx.now, pid),
  ], "motion.decided", await actorOf(ctx), {
    meeting: m.id, motion: x.id, n: x.number, method, for: forCount, against: againstCount, abstain: abstainCount, majority: x.majority, outcome,
    quorum: { eligible: q.eligible, required: q.required, present: q.present }, counters: counters.length, interests,
  }, ctx.now);
  return { motion: await viewOne(ctx, m, x.id), quorum: q, audit: seq };
}
