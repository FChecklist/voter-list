// Counting, recounts, challenges, the declaration and the report.
//   * The count can run only after voting has closed. Before that no function here, and no address, adds up a single choice.
//   * Before the count is stored, the register, the ballots, the receipts and the signed trail are checked against each other ("reconciliation").
//   * A recount is a new count that keeps the old one. The result can be declared only when the count reconciles, every challenge has an answer,
//     the challenge time is over, and a fresh count of the same ballots gives the same fingerprint as the stored count.
import { HttpError, rateLimit } from "./auth";
import { auditHead, commit, guardChanged, guardExists, pseudonym, pubUnit } from "./audit";
import type { D1Stmt, Env } from "./db";
import { EL } from "./election-messages";
import { clean, confirmIs, eventStmt, gate, getElection, HOUR, nominationsOf, officialsOf, postsOf, publicElection, publicTrail, rollFor, type ActorRole, type ElectionRow, type MemberCtx, type NomRow, type PostRow } from "./elections";
import { openChoiceWith, sealKey } from "./elections-vote";
import { msToLocal, noContactDetails } from "./lists";
import type { SocietyRow } from "./store";
import { canonical } from "./vendor/canonical";
import { sha256Hex } from "./vendor/crypto";

type Actor = { role: ActorRole; email: string };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // plain code-point order: the same on every machine, so a fingerprint is the same everywhere
const ROLE_WORDS: Record<string, string> = { returning_officer: "returning officer", counting_agent: "counting agent", observer: "observer", organizer: "organizer", "co-organizer": "co-organizer" };

export interface PaperPost { ballots: number; blank: number; invalid: number; nota: number; candidates: Record<string, number> }
export type Paper = Record<string, PaperPost>;
export interface CandResult { id: string; name: string; unit: string; votesMilli: number; elected: boolean; tied: boolean; rank: number }
export interface PostResult { post: string; n: number; title: string; seats: number; kind: PostRow["kind"]; ballots: number; blank: number; invalid: number; notaMilli: number; candidates: CandResult[]; elected: string[]; draw: null | { seed: string; tied: string[]; order: string[]; places: number } }
export interface Reconciliation { ok: boolean; problems: string[]; facts: { onlineVoters: number; paperVoters: number; rollVoters: number; receipts: number; ballotsPerPost: Record<string, number>; chainVotes: number; chainPaper: number } }

const num = async (env: Env, sql: string, ...b: unknown[]): Promise<number> => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
const uniqueIn = (err: unknown, table: string) => new RegExp(`UNIQUE constraint failed: ${table}`, "i").test(String((err as Error)?.message ?? err));

// ------------------------------------------------------------------------------------------------------------------ paper counts (typed in by the counting team)
function parsePaper(input: unknown, e: ElectionRow, contested: PostRow[], accepted: Map<string, NomRow[]>, paperVoters: number): Paper {
  if (paperVoters === 0) {
    if (input !== undefined && input !== null && !(typeof input === "object" && Object.keys(input as object).length === 0)) throw new HttpError(400, EL.noPaperIssued, "no_paper");
    return {};
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, EL.badPaper, "bad_paper");
  const raw = input as Record<string, unknown>;
  const whole = (v: unknown) => { const n = Number(v); if (v === undefined || v === null || !Number.isSafeInteger(n) || n < 0) throw new HttpError(400, EL.badPaper, "bad_paper"); return n; };
  const out: Paper = {};
  for (const k of Object.keys(raw)) if (!contested.some((p) => p.id === k)) throw new HttpError(400, EL.unknownPost, "unknown_post");
  for (const p of contested) {
    const x = raw[p.id];
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(400, EL.badPaper, "bad_paper");
    const o = x as Record<string, unknown>;
    const ids = new Set((accepted.get(p.id) ?? []).map((n) => n.id));
    const candRaw = o.candidates && typeof o.candidates === "object" && !Array.isArray(o.candidates) ? (o.candidates as Record<string, unknown>) : {};
    for (const k of Object.keys(candRaw)) if (!ids.has(k)) throw new HttpError(400, EL.unknownCandidate, "unknown_candidate");
    const candidates: Record<string, number> = {};
    for (const id of [...ids].sort(cmp)) candidates[id] = whole(candRaw[id] ?? 0);
    const post: PaperPost = { ballots: whole(o.ballots), blank: whole(o.blank ?? 0), invalid: whole(o.invalid ?? 0), nota: whole(o.nota ?? 0), candidates };
    if (post.nota > 0 && !e.nota) throw new HttpError(400, EL.notaOff, "nota_off");
    if (post.ballots !== paperVoters) throw new HttpError(400, EL.paperTotals, "paper_totals");
    const valid = post.ballots - post.blank - post.invalid, marks = Object.values(candidates).reduce((a, b) => a + b, 0) + post.nota;
    if (valid < 0 || (p.max_votes === 1 ? marks !== valid : marks > valid * p.max_votes)) throw new HttpError(400, EL.paperInner, "paper_inner");
    out[p.id] = post;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ the check that register, box, receipts and the signed trail agree
export async function reconcile(env: Env, e: ElectionRow, posts: PostRow[], paper: Paper): Promise<Reconciliation> {
  const contested = posts.filter((p) => p.kind === "contested");
  const onlineVoters = await num(env, "SELECT COUNT(*) AS n FROM el_voted WHERE election_id = ? AND channel = 'online'", e.id);
  const paperVoters = await num(env, "SELECT COUNT(*) AS n FROM el_voted WHERE election_id = ? AND channel = 'paper'", e.id);
  const receipts = await num(env, "SELECT COUNT(*) AS n FROM el_receipts WHERE election_id = ?", e.id);
  const problems: string[] = [];
  const ballotsPerPost: Record<string, number> = {};
  const needle = `"election":"${e.id}"`;
  const chainVotes = await num(env, "SELECT COUNT(*) AS n FROM audit_entries WHERE society_id = ? AND type = 'election.vote_cast' AND instr(entry_json, ?) > 0", e.society_id, needle);
  const chainPaper = await num(env, "SELECT COUNT(*) AS n FROM audit_entries WHERE society_id = ? AND type = 'election.paper_issued' AND instr(entry_json, ?) > 0", e.society_id, needle);
  const weightOfVoters = e.weighting === "by_list"
    ? await num(env, "SELECT IFNULL(SUM(r.weight_milli), 0) AS n FROM el_voted v JOIN publication_rows r ON r.id = v.roll_row_id WHERE v.election_id = ? AND v.channel = 'online'", e.id)
    : onlineVoters * 1000;
  for (const p of contested) {
    ballotsPerPost[p.id] = await num(env, "SELECT COUNT(*) AS n FROM el_ballots WHERE election_id = ? AND post_id = ?", e.id, p.id);
    if (ballotsPerPost[p.id] !== onlineVoters) problems.push(`Post ${p.n}: the box holds ${ballotsPerPost[p.id]} ballots but ${onlineVoters} people voted online.`);
    const w = await num(env, "SELECT IFNULL(SUM(weight_milli), 0) AS n FROM el_ballots WHERE election_id = ? AND post_id = ?", e.id, p.id);
    if (w !== weightOfVoters) problems.push(`Post ${p.n}: the weight of the ballots does not match the weight of the people who voted online.`);
    if (paperVoters > 0 && paper[p.id]?.ballots !== paperVoters) problems.push(`Post ${p.n}: the paper count does not match the number of paper ballots given out.`);
  }
  const strays = await num(env, `SELECT COUNT(*) AS n FROM el_ballots WHERE election_id = ? AND post_id NOT IN (${contested.map(() => "?").join(",") || "''"})`, e.id, ...contested.map((p) => p.id));
  if (strays) problems.push("The box holds ballots for a post that is not voted on.");
  if (receipts !== onlineVoters) problems.push(`There are ${receipts} receipts but ${onlineVoters} people voted online.`);
  if (e.roll_pub_id) {
    const off = await num(env, "SELECT COUNT(*) AS n FROM el_voted v WHERE v.election_id = ? AND NOT EXISTS (SELECT 1 FROM publication_rows r WHERE r.publication_id = ? AND r.id = v.roll_row_id AND r.is_voter = 1 AND r.can_vote = 1)", e.id, e.roll_pub_id);
    if (off) problems.push("The register has a person who is not on the final voter list.");
  }
  if (onlineVoters + paperVoters > (e.roll_voters ?? 0)) problems.push("More people voted than the final voter list has.");
  if (chainVotes !== onlineVoters) problems.push(`The signed trail has ${chainVotes} online votes but the register has ${onlineVoters}.`);
  if (chainPaper !== paperVoters) problems.push(`The signed trail has ${chainPaper} paper ballots given out but the register has ${paperVoters}.`);
  return { ok: problems.length === 0, problems, facts: { onlineVoters, paperVoters, rollVoters: e.roll_voters ?? 0, receipts, ballotsPerPost, chainVotes, chainPaper } };
}

// ------------------------------------------------------------------------------------------------------------------ the count itself
interface PostTally { ballots: number; blank: number; invalid: number; notaMilli: number; votes: Map<string, number> }

/** Opens every sealed ballot and adds up the choices. Used only after voting has closed (the callers check the status first). */
async function computeResult(env: Env, e: ElectionRow, posts: PostRow[], accepted: Map<string, NomRow[]>, paper: Paper) {
  const contested = posts.filter((p) => p.kind === "contested");
  const per = new Map<string, PostTally>(contested.map((p) => [p.id, { ballots: 0, blank: 0, invalid: 0, notaMilli: 0, votes: new Map((accepted.get(p.id) ?? []).map((n) => [n.id, 0])) }]));
  const rows = (await env.DB.prepare("SELECT id, post_id, weight_milli, sealed FROM el_ballots WHERE election_id = ?").bind(e.id).all<{ id: string; post_id: string; weight_milli: number; sealed: string }>()).results;
  const key = await sealKey(env, e);
  for (const b of rows) {
    const t = per.get(b.post_id); if (!t) continue; // a ballot for a post that is not voted on is reported by the reconciliation
    t.ballots++;
    const c = await openChoiceWith(key, e.id, b.id, b.post_id, b.sealed);
    if (!c || c.s.some((id) => !t.votes.has(id))) { t.invalid++; continue; }
    if (c.n === 1) { t.notaMilli += b.weight_milli; continue; }
    if (!c.s.length) { t.blank++; continue; }
    for (const id of c.s) t.votes.set(id, t.votes.get(id)! + b.weight_milli);
  }
  for (const p of contested) { // paper counts are typed in by the counting team; a paper vote is one whole vote
    const pp = paper[p.id], t = per.get(p.id)!; if (!pp) continue;
    t.ballots += pp.ballots; t.blank += pp.blank; t.invalid += pp.invalid; t.notaMilli += pp.nota * 1000;
    for (const [id, n] of Object.entries(pp.candidates)) t.votes.set(id, (t.votes.get(id) ?? 0) + n * 1000);
  }
  // the box fingerprint: every ballot id and every register line. Ballot ids are random and fixed once voting has closed, so nobody can know the draw seed before the close.
  const reg = (await env.DB.prepare("SELECT roll_row_id, channel FROM el_voted WHERE election_id = ? ORDER BY roll_row_id").bind(e.id).all<{ roll_row_id: number; channel: string }>()).results;
  const box = await sha256Hex("election-box/v1\n" + rows.map((r) => r.id).sort(cmp).join(",") + "\n" + reg.map((r) => `${r.roll_row_id}:${r.channel}`).join(","));
  const results: PostResult[] = [];
  for (const p of posts) {
    const cands = (accepted.get(p.id) ?? []).map((n) => ({ id: n.id, name: n.name, unit: pubUnit(n.unit) }));
    if (p.kind !== "contested") {
      results.push({ post: p.id, n: p.n, title: p.title, seats: p.seats, kind: p.kind, ballots: 0, blank: 0, invalid: 0, notaMilli: 0, candidates: [...cands].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)).map((c, i) => ({ ...c, votesMilli: 0, elected: p.kind === "unopposed", tied: false, rank: i + 1 })), elected: p.kind === "unopposed" ? cands.map((c) => c.id).sort(cmp) : [], draw: null });
      continue;
    }
    const t = per.get(p.id)!;
    const sorted = cands.map((c) => ({ ...c, votesMilli: t.votes.get(c.id) ?? 0 })).sort((a, b) => b.votesMilli - a.votesMilli || cmp(a.name, b.name) || cmp(a.id, b.id));
    let draw: PostResult["draw"] = null; const winners = new Set<string>(); const tiedIds = new Set<string>();
    if (sorted.length <= p.seats) sorted.forEach((c) => winners.add(c.id));
    else {
      const cut = sorted[p.seats - 1]!.votesMilli;
      const sure = sorted.filter((c) => c.votesMilli > cut), group = sorted.filter((c) => c.votesMilli === cut), places = p.seats - sure.length;
      sure.forEach((c) => winners.add(c.id));
      if (group.length <= places) group.forEach((c) => winners.add(c.id));
      else {
        const seed = await sha256Hex(["election-draw/v1", e.id, e.candidates_fingerprint ?? "", box, p.id].join("|"));
        const keyed = await Promise.all(group.map(async (c) => ({ id: c.id, k: await sha256Hex(`${seed}|${c.id}`) })));
        keyed.sort((a, b) => cmp(a.k, b.k));
        keyed.slice(0, places).forEach((x) => winners.add(x.id)); group.forEach((c) => tiedIds.add(c.id));
        draw = { seed, tied: group.map((c) => c.id).sort(cmp), order: keyed.map((x) => x.id), places };
      }
    }
    results.push({ post: p.id, n: p.n, title: p.title, seats: p.seats, kind: p.kind, ballots: t.ballots, blank: t.blank, invalid: t.invalid, notaMilli: t.notaMilli, candidates: sorted.map((c, i) => ({ ...c, elected: winners.has(c.id), tied: tiedIds.has(c.id), rank: i + 1 })), elected: [...winners].sort(cmp), draw });
  }
  const core = { v: 1, election: e.id, candidatesFingerprint: e.candidates_fingerprint ?? "", box, posts: results };
  return { core, box, results, fingerprint: await sha256Hex("election-count/v1\n" + canonical(core as never)) };
}

const acceptedMap = (noms: NomRow[]) => { const m = new Map<string, NomRow[]>(); for (const n of noms) if (n.status === "accepted") { const l = m.get(n.post_id) ?? []; l.push(n); m.set(n.post_id, l); } return m; };
interface CountRow { count_no: number; kind: "first" | "recount"; reason: string; paper_json: string; result_json: string; fingerprint: string; reconciled: number; counted_at: number }
const latestCount = (env: Env, eid: string) => env.DB.prepare("SELECT count_no, kind, reason, paper_json, result_json, fingerprint, reconciled, counted_at FROM el_counts WHERE election_id = ? ORDER BY count_no DESC LIMIT 1").bind(eid).first<CountRow>();
const teamOnly = (a: Actor) => { if (a.role !== "returning_officer" && a.role !== "counting_agent") throw new HttpError(403, EL.notTeam, "forbidden"); };

/** The returning officer or a counting agent counts the votes (first count) or counts again with a written reason (recount). */
export async function runCount(env: Env, now: number, society: SocietyRow, actor: Actor, eid: string, input: { paper?: unknown; reason?: unknown }) {
  gate(env); teamOnly(actor);
  const e = await getElection(env, society.id, eid);
  if (e.status === "declared") throw new HttpError(409, EL.declared, "declared");
  if (e.status !== "closed" && e.status !== "counted") throw new HttpError(409, EL.notClosed, "not_closed");
  const recount = e.status === "counted", prev = await latestCount(env, e.id);
  const reason = clean(input.reason, 400);
  if (recount && reason.length < 10) throw new HttpError(400, EL.needRecountReason, "need_reason");
  noContactDetails(reason, "the reason");
  const [posts, noms] = await Promise.all([postsOf(env, e.id), nominationsOf(env, e.id)]);
  const accepted = acceptedMap(noms), contested = posts.filter((p) => p.kind === "contested");
  const paperVoters = await num(env, "SELECT COUNT(*) AS n FROM el_voted WHERE election_id = ? AND channel = 'paper'", e.id);
  const paper = recount && input.paper === undefined && prev ? (JSON.parse(prev.paper_json) as Paper) : parsePaper(input.paper, e, contested, accepted, paperVoters);
  const { core, results, fingerprint } = await computeResult(env, e, posts, accepted, paper);
  const rec = await reconcile(env, e, posts, paper);
  const no = (prev?.count_no ?? 0) + 1, by = await pseudonym(env, actor.email), db = env.DB;
  const result = { ...core, reconciliation: rec, turnout: { online: rec.facts.onlineVoters, paper: rec.facts.paperVoters, eligible: rec.facts.rollVoters } };
  const stmts: D1Stmt[] = [
    recount ? db.prepare("UPDATE el_elections SET counted_at = ? WHERE id = ? AND status = 'counted'").bind(now, e.id) : db.prepare("UPDATE el_elections SET status = 'counted', counted_at = ? WHERE id = ? AND status = 'closed'").bind(now, e.id),
    guardChanged(env, EL.notStatus),
    db.prepare("INSERT INTO el_counts (election_id, count_no, kind, reason, paper_json, result_json, fingerprint, reconciled, counted_by, counted_at, audit_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM audit_entries WHERE society_id = ?))")
      .bind(e.id, no, recount ? "recount" : "first", reason, JSON.stringify(paper), JSON.stringify(result), fingerprint, rec.ok ? 1 : 0, by, now, society.id),
    eventStmt(env, society.id, e.id, now, recount ? "election.recounted" : "election.counted", ROLE_WORDS[actor.role] ?? actor.role, recount ? `The votes were counted again (count ${no}). Reason: ${reason}` : "The votes were counted (count 1)."),
  ];
  try { await commit(env, society.id, stmts, recount ? "election.recounted" : "election.counted", { pid: by, role: actor.role }, { election: e.id, count: no, fingerprint, reconciled: rec.ok ? 1 : 0 }, now); }
  catch (err) { if (uniqueIn(err, "el_counts")) throw new HttpError(409, EL.alreadyCounted, "conflict"); throw err; }
  return { count: no, kind: recount ? "recount" : "first", fingerprint, reconciled: rec.ok, problems: rec.problems, result: viewResults(results) };
}

const viewResults = (results: PostResult[]) => results.map((r) => ({
  post: r.post, n: r.n, title: r.title, seats: r.seats, kind: r.kind, ballots: r.ballots, blank: r.blank, invalid: r.invalid, noneOfTheAbove: r.notaMilli / 1000,
  candidates: r.candidates.map((c) => ({ id: c.id, name: c.name, unit: c.unit, votes: c.votesMilli / 1000, elected: c.elected, tied: c.tied, rank: c.rank })),
  elected: r.elected, draw: r.draw,
}));

/** What the people named for the election may read after the count: the numbers, the checks and the fingerprint. Nothing before the count. */
export async function countView(env: Env, society: SocietyRow, actor: Actor, eid: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status === "draft" || e.status === "notice" || e.status === "candidates_final" || e.status === "voting") throw new HttpError(409, EL.resultsLocked, "results_locked");
  const c = await latestCount(env, e.id);
  if (!c) throw new HttpError(409, EL.noCounts, "no_count");
  const r = JSON.parse(c.result_json) as { posts: PostResult[]; reconciliation: Reconciliation; turnout: unknown; box: string };
  const all = (await env.DB.prepare("SELECT count_no, kind, reason, fingerprint, reconciled, counted_at FROM el_counts WHERE election_id = ? ORDER BY count_no").bind(e.id).all<{ count_no: number; kind: string; reason: string; fingerprint: string; reconciled: number; counted_at: number }>()).results;
  void actor;
  return { count: c.count_no, kind: c.kind, fingerprint: c.fingerprint, reconciled: !!c.reconciled, reconciliation: r.reconciliation, turnout: r.turnout, box: r.box, result: viewResults(r.posts), counts: all.map((x) => ({ count: x.count_no, kind: x.kind, reason: x.reason, fingerprint: x.fingerprint, reconciled: !!x.reconciled, at: msToLocal(x.counted_at, society.tz_offset_min) })), challengeUntil: msToLocal(c.counted_at + e.challenge_hours * HOUR, society.tz_offset_min) };
}

// ------------------------------------------------------------------------------------------------------------------ challenges
export async function fileChallenge(m: MemberCtx, eid: string, input: { text?: unknown }) {
  gate(m.env);
  if (m.society.erased_at) throw new HttpError(410, EL.erased, "erased");
  const e = await getElection(m.env, m.society.id, eid);
  if (e.status === "declared") throw new HttpError(409, EL.challengeClosed, "challenge_closed");
  if (e.status !== "counted") throw new HttpError(409, EL.notStatus, "bad_status");
  const c = await latestCount(m.env, e.id);
  if (!c) throw new HttpError(409, EL.noCounts, "no_count");
  if (m.now > c.counted_at + e.challenge_hours * HOUR) throw new HttpError(409, EL.challengeClosed, "challenge_closed");
  const rows = await rollFor(m.env, e, m.email);
  if (!rows.length) throw new HttpError(403, EL.notOnRoll, "not_on_roll");
  const text = clean(input.text, 800);
  if (text.length < 10 || text.length > 600) throw new HttpError(400, EL.challengeNeeds, "bad_text");
  noContactDetails(text, "the challenge");
  await rateLimit(m.env, `elchal:${e.id}:${m.email}`, 3, HOUR, m.now);
  const pid = await pseudonym(m.env, m.email);
  try {
    await commit(m.env, m.society.id, [
      guardExists(m.env, EL.challengeClosed, "SELECT 1 FROM el_elections WHERE id = ? AND status = 'counted'", e.id),
      m.env.DB.prepare("INSERT INTO el_challenges (election_id, n, roll_row_id, text, filed_at) VALUES (?, (SELECT IFNULL(MAX(n), 0) + 1 FROM el_challenges WHERE election_id = ?), ?, ?, ?)").bind(e.id, e.id, rows[0]!.id, text, m.now),
      eventStmt(m.env, m.society.id, e.id, m.now, "election.challenge_filed", "voter", "A challenge was filed."),
    ], "election.challenge_filed", { pid, role: "voter" }, { election: e.id }, m.now);
  } catch (err) { if (uniqueIn(err, "el_challenges")) throw new HttpError(409, EL.alreadyCounted, "conflict"); throw err; }
  return { filed: true };
}

export async function listChallenges(env: Env, society: SocietyRow, eid: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status !== "counted" && e.status !== "declared") throw new HttpError(409, EL.resultsLocked, "results_locked");
  const rs = (await env.DB.prepare("SELECT n, text, filed_at, status, answer, answered_at FROM el_challenges WHERE election_id = ? ORDER BY n").bind(e.id).all<{ n: number; text: string; filed_at: number; status: string; answer: string; answered_at: number | null }>()).results;
  return { challenges: rs.map((x) => ({ n: x.n, text: x.text, status: x.status, answer: x.answer, filedAt: msToLocal(x.filed_at, society.tz_offset_min), answeredAt: x.answered_at === null ? null : msToLocal(x.answered_at, society.tz_offset_min) })) };
}

export async function answerChallenge(env: Env, now: number, society: SocietyRow, actor: Actor, eid: string, n: number, input: { answer?: unknown }) {
  gate(env);
  if (actor.role !== "returning_officer") throw new HttpError(403, EL.notReturningOfficer, "forbidden");
  const e = await getElection(env, society.id, eid);
  if (e.status !== "counted") throw new HttpError(409, EL.notStatus, "bad_status");
  if (!Number.isSafeInteger(n)) throw new HttpError(404, EL.noChallenge, "not_found");
  const ch = await env.DB.prepare("SELECT status FROM el_challenges WHERE election_id = ? AND n = ?").bind(e.id, n).first<{ status: string }>();
  if (!ch) throw new HttpError(404, EL.noChallenge, "not_found");
  if (ch.status !== "open") throw new HttpError(409, EL.answeredAlready, "answered");
  const answer = clean(input.answer, 800);
  if (answer.length < 10 || answer.length > 600) throw new HttpError(400, EL.challengeNeeds, "bad_text");
  noContactDetails(answer, "the answer");
  const pid = await pseudonym(env, actor.email);
  await commit(env, society.id, [
    env.DB.prepare("UPDATE el_challenges SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE election_id = ? AND n = ? AND status = 'open'").bind(answer, pid, now, e.id, n),
    guardChanged(env, EL.answeredAlready),
    eventStmt(env, society.id, e.id, now, "election.challenge_answered", "returning officer", `Challenge ${n} was answered.`),
  ], "election.challenge_answered", { pid, role: actor.role }, { election: e.id, challenge: n }, now);
  return { answered: true };
}

// ------------------------------------------------------------------------------------------------------------------ the declaration
export async function declare(env: Env, now: number, society: SocietyRow, actor: Actor, eid: string, input: { confirm?: unknown }) {
  gate(env);
  if (actor.role !== "returning_officer") throw new HttpError(403, EL.notReturningOfficer, "forbidden");
  const e = await getElection(env, society.id, eid);
  if (e.status === "declared") throw new HttpError(409, EL.declared, "declared");
  if (e.status !== "counted") throw new HttpError(409, EL.needCount, "need_count");
  if (!confirmIs(input.confirm, "DECLARE")) throw new HttpError(400, EL.confirmDeclare, "confirm");
  const last = await latestCount(env, e.id);
  if (!last) throw new HttpError(409, EL.needCount, "need_count");
  if (now < last.counted_at + e.challenge_hours * HOUR) throw new HttpError(409, EL.challengeWindow, "challenge_window");
  if (await num(env, "SELECT COUNT(*) AS n FROM el_challenges WHERE election_id = ? AND status = 'open'", e.id)) throw new HttpError(409, EL.openChallenges, "open_challenges");
  // a fresh look at the box, not only the stored count: the register, the box, the receipts and the signed trail must agree, and the same ballots must still give the same count
  const [posts, noms] = await Promise.all([postsOf(env, e.id), nominationsOf(env, e.id)]);
  const paper = JSON.parse(last.paper_json) as Paper;
  const live = await computeResult(env, e, posts, acceptedMap(noms), paper);
  const rec = await reconcile(env, e, posts, paper);
  if (!last.reconciled || !rec.ok || live.fingerprint !== last.fingerprint) throw new HttpError(409, EL.mismatch, "mismatch");
  const by = await pseudonym(env, actor.email);
  const signoff = JSON.stringify({ by: "returning officer", count: last.count_no, fingerprint: last.fingerprint, at: now });
  await commit(env, society.id, [
    guardExists(env, EL.openChallenges, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM el_challenges WHERE election_id = ? AND status = 'open')", e.id),
    guardExists(env, EL.notStatus, "SELECT 1 FROM el_counts WHERE election_id = ? AND count_no = ? AND count_no = (SELECT MAX(count_no) FROM el_counts WHERE election_id = ?)", e.id, last.count_no, e.id),
    env.DB.prepare("UPDATE el_elections SET status = 'declared', declared_at = ?, signoff_json = ? WHERE id = ? AND status = 'counted'").bind(now, signoff, e.id),
    guardChanged(env, EL.declared),
    eventStmt(env, society.id, e.id, now, "election.declared", "returning officer", "The result was declared."),
  ], "election.declared", { pid: by, role: actor.role }, { election: e.id, count: last.count_no, fingerprint: last.fingerprint }, now);
  return { declared: true, result: await publicResults(env, society, e.id) };
}

// ------------------------------------------------------------------------------------------------------------------ what anyone may read
export async function publicResults(env: Env, society: SocietyRow, eid: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status !== "declared") throw new HttpError(409, EL.resultsLocked, "results_locked");
  const c = await latestCount(env, e.id);
  if (!c) throw new HttpError(409, EL.noCounts, "no_count");
  const r = JSON.parse(c.result_json) as { posts: PostResult[]; turnout: unknown; box: string };
  return { election: { id: e.id, title: e.title, term: e.term }, declaredAt: msToLocal(e.declared_at ?? 0, society.tz_offset_min), turnout: r.turnout, result: viewResults(r.posts), countFingerprint: c.fingerprint, signoff: e.signoff_json ? JSON.parse(e.signoff_json) : null };
}

/** One page that holds the whole story, for the notice board and for anyone who wants to check: rules, dates, candidates, trail, counts, challenges, result. */
export async function report(env: Env, society: SocietyRow, eid: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status !== "declared") throw new HttpError(409, EL.resultsLocked, "results_locked");
  const [pub, trail, results, chal, head, officials] = await Promise.all([publicElection(env, society, e.id), publicTrail(env, society, e.id), publicResults(env, society, e.id), listChallenges(env, society, e.id), auditHead(env, society.id), officialsOf(env, e.id)]);
  const counts = (await env.DB.prepare("SELECT count_no, kind, reason, fingerprint, reconciled, counted_at FROM el_counts WHERE election_id = ? ORDER BY count_no").bind(e.id).all<{ count_no: number; kind: string; reason: string; fingerprint: string; reconciled: number; counted_at: number }>()).results;
  return {
    election: pub, trail: trail.events, challenges: chal.challenges, result: results,
    counts: counts.map((x) => ({ count: x.count_no, kind: x.kind, reason: x.reason, fingerprint: x.fingerprint, reconciled: !!x.reconciled, at: msToLocal(x.counted_at, society.tz_offset_min) })),
    officials: officials.map((o) => ({ role: o.role, name: o.name })),
    signedTrail: { head, note: "The signed trail of this list is at the audit address; its public key is at /api/public-key." },
    secrecy: "Who voted is in the register. What was chosen is in sealed ballots that carry no name, no time and no number. The two cannot be joined. A receipt shows that a ballot is in the box and nothing else.",
  };
}
