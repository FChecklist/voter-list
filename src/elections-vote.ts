// Voting. How the vote stays secret:
//   * The REGISTER (el_voted) says WHO has voted. The BALLOTS (el_ballots) say WHAT was chosen, sealed. They are written in one batch but share
//     no column: a ballot has a random id, a post, a weight and the sealed choice. No voter, no time, no counter (the table has no row number).
//   * A ballot is made for EVERY contested post of every voter (blank if nothing was chosen), so the number of ballots never tells who skipped what.
//   * The RECEIPT is a hash of a random code. It is kept in a table of its own that holds nothing else. It proves "a ballot was counted"; it shows no choice.
//   * Nothing in this file adds up the choices. Counting is in elections-count.ts and cannot run before voting has closed.
import { HttpError, rateLimit, sendMail } from "./auth";
import { commit, guardChanged, guardExists, pseudonym, pubUnit } from "./audit";
import type { D1Stmt, Env } from "./db";
import { EL } from "./election-messages";
import { gate, getElection, HOUR, nominationsOf, pickRow, postsOf, rollFor, rollRow, weightOf, type ActorRole, type ElectionRow, type MemberCtx } from "./elections";
import { presentInSession } from "./elections-links";
import { localToMs, msToLocal } from "./lists";
import type { SocietyRow } from "./store";
import { aesDecrypt, aesEncrypt, deriveKey32, hmacHex, randomHex, randomInt, sha256Hex, timingSafeEqual, type Bytes } from "./vendor/crypto";

const CODE_TTL = 10 * 60_000, TICKET_TTL = 15 * 60_000, MAX_CODE_TRIES = 10, PAD = 512;
export const NOTA = "NOTA";
const RECEIPT_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0 or 1, so a receipt is easy to read out

// ------------------------------------------------------------------------------------------------------------------ the seal
/** The key that seals this election's ballots: made from a server secret and the election's own random salt. The database holds only the salt. */
export const sealKey = (env: Env, e: Pick<ElectionRow, "id" | "seal_salt">) => deriveKey32(env.PEPPER, `election-seal/${e.id}/${e.seal_salt}`);
export interface Choice { s: string[]; n: 0 | 1 }

export async function sealChoice(env: Env, e: Pick<ElectionRow, "id" | "seal_salt">, ballotId: string, postId: string, c: Choice): Promise<string> {
  return aesEncrypt(await sealKey(env, e), JSON.stringify(c).padEnd(PAD, " "), `${e.id}|${postId}|${ballotId}`); // padded, so the length of a sealed choice tells nothing
}
/** Opens one sealed choice with a key made once by the caller (counting opens many). A damaged or moved ballot gives null. */
export async function openChoiceWith(key: Bytes, eid: string, ballotId: string, postId: string, sealed: string): Promise<Choice | null> {
  try {
    const v = JSON.parse((await aesDecrypt(key, sealed, `${eid}|${postId}|${ballotId}`)).trim()) as Choice;
    return Array.isArray(v.s) && v.s.every((x) => typeof x === "string") && (v.n === 0 || v.n === 1) ? v : null;
  } catch { return null; }
}

/** The only time kept next to a voter: the calendar day in the society's own time zone (YYYY-MM-DD), and the start of that day for the signed trail. Never the hour or the minute. */
export const dayOf = (now: number, tz: number): string => msToLocal(now, tz).slice(0, 10);
const dayStartMs = (day: string, tz: number): number => localToMs(`${day}T00:00`, tz)!;

const codeHash = (env: Env, eid: string, rollId: number, code: string) => hmacHex(env.PEPPER, `elcode|${eid}|${rollId}|${code}`);
const ticketId = (eid: string, ticket: string) => sha256Hex(`elticket|${eid}|${ticket}`);
export const receiptHash = (eid: string, code: string) => sha256Hex(`elreceipt|${eid}|${code.replace(/[^A-Z0-9]/g, "")}`);
function newReceipt(): string {
  const c = Array.from({ length: 12 }, () => RECEIPT_LETTERS[randomInt(RECEIPT_LETTERS.length)]!).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}
function shuffle<T>(xs: T[]): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }

/** Voting is open only while the election says so AND the clock is inside the voting time. */
export function assertVotingOpen(e: Pick<ElectionRow, "status" | "voting_open_at" | "voting_close_at">, now: number): void {
  if (e.status === "closed" || e.status === "counted" || e.status === "declared") throw new HttpError(409, EL.tooLate, "too_late");
  if (e.status !== "voting") throw new HttpError(409, EL.votingNotOpen, "not_open");
  if (now < e.voting_open_at) throw new HttpError(409, EL.tooEarly, "too_early");
  if (now >= e.voting_close_at) throw new HttpError(409, EL.tooLate, "too_late");
}
const registered = (env: Env, eid: string, rollId: number) => env.DB.prepare("SELECT channel FROM el_voted WHERE election_id = ? AND roll_row_id = ?").bind(eid, rollId).first<{ channel: "online" | "paper" }>();
const onlineOnly = (e: Pick<ElectionRow, "mode">) => { if (e.mode === "in_person" || e.mode === "offline") throw new HttpError(409, EL.notOnline, "not_online"); };
const uniqueIn = (err: unknown, table: string) => new RegExp(`UNIQUE constraint failed: ${table}`, "i").test(String((err as Error)?.message ?? err));

// ------------------------------------------------------------------------------------------------------------------ the ballot paper
/** What a voter sees: each post, its candidates in a new random order (or alphabetical if the rules say so), and the choices. */
export async function ballotFor(env: Env, e: ElectionRow) {
  const [posts, noms] = await Promise.all([postsOf(env, e.id), nominationsOf(env, e.id)]);
  return {
    election: { id: e.id, title: e.title, term: e.term },
    posts: posts.map((p) => {
      const cands = noms.filter((n) => n.post_id === p.id && n.status === "accepted").map((n) => ({ id: n.id, name: n.name, unit: pubUnit(n.unit), statement: n.statement }));
      const base = { id: p.id, n: p.n, title: p.title, seats: p.seats, maxVotes: p.max_votes, kind: p.kind };
      if (p.kind === "contested") return { ...base, vote: true, nota: !!e.nota, candidates: e.random_order ? shuffle(cands) : [...cands].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
      return { ...base, vote: false, nota: false, candidates: p.kind === "unopposed" ? cands : [], note: p.kind === "unopposed" ? "Elected without a vote." : "No candidate." };
    }),
    howTo: "For each post, send the ids of the candidates chosen, up to the number shown. Send an empty list to leave a post blank." + (e.nota ? ` Send ["${NOTA}"] alone for none of the above.` : ""),
  };
}

// ------------------------------------------------------------------------------------------------------------------ step 1: a second code, just before the ballot
export async function sendBallotCode(m: MemberCtx, eid: string, input: { rollId?: unknown }) {
  gate(m.env);
  if (m.society.erased_at) throw new HttpError(410, EL.erased, "erased");
  const e = await getElection(m.env, m.society.id, eid);
  assertVotingOpen(e, m.now); onlineOnly(e);
  const line = await pickRow(m.env, e, m.email, input.rollId);
  if (await registered(m.env, e.id, line.id)) throw new HttpError(409, EL.alreadyVoted, "already_voted");
  await rateLimit(m.env, `elcode:${e.id}:${line.id}`, 3, HOUR, m.now, EL.tooManyCodes);
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  await m.env.DB.prepare("INSERT INTO el_codes (election_id, roll_row_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(e.id, line.id, await codeHash(m.env, e.id, line.id, code), m.now, m.now + CODE_TTL).run();
  await sendMail(m.env, m.email, `Voting code for ${e.title}: ${code}`,
    `The six-digit voting code for ${e.title}, ${m.society.name}, is ${code}.\n\nIt works for 10 minutes and only once. If you did not ask for it, you can ignore this message; nothing happens until the code is used.\n\nTownhall Records`, "otp-vote", m.now);
  return { sent: true, minutes: CODE_TTL / 60_000 };
}

// ------------------------------------------------------------------------------------------------------------------ step 2: the code opens the ballot and gives a one-time ticket
export async function openBallot(m: MemberCtx, eid: string, input: { code?: unknown; rollId?: unknown }) {
  gate(m.env);
  if (m.society.erased_at) throw new HttpError(410, EL.erased, "erased");
  const e = await getElection(m.env, m.society.id, eid);
  assertVotingOpen(e, m.now); onlineOnly(e);
  const line = await pickRow(m.env, e, m.email, input.rollId);
  if (await registered(m.env, e.id, line.id)) throw new HttpError(409, EL.alreadyVoted, "already_voted");
  await rateLimit(m.env, `elopen:${e.id}:${line.id}`, 12, HOUR, m.now, EL.tooManyCodes);
  const code = String(input.code ?? "").replace(/\s/g, "");
  const live = (await m.env.DB.prepare("SELECT id, code_hash, attempts FROM el_codes WHERE election_id = ? AND roll_row_id = ? AND expires_at > ? ORDER BY id DESC LIMIT 3").bind(e.id, line.id, m.now).all<{ id: number; code_hash: string; attempts: number }>()).results.filter((r) => r.attempts < MAX_CODE_TRIES);
  const bad = new HttpError(401, EL.badCode, "bad_code");
  if (!live.length) throw bad;
  const ch = await codeHash(m.env, e.id, line.id, code);
  const hit = /^\d{6}$/.test(code) ? live.find((r) => timingSafeEqual(r.code_hash, ch)) : undefined;
  if (!hit) { await m.env.DB.batch(live.map((r) => m.env.DB.prepare("UPDATE el_codes SET attempts = attempts + 1 WHERE id = ?").bind(r.id))); throw bad; }
  // a used code is not kept at all (no person, no time): this one and any other code asked for by the same person are deleted, and the ticket is made, in one step
  const ticket = randomHex(16);
  try {
    await m.env.DB.batch([
      m.env.DB.prepare("DELETE FROM el_codes WHERE id = ?").bind(hit.id), guardChanged(m.env, EL.badCode), // one code, one ballot
      m.env.DB.prepare("DELETE FROM el_codes WHERE election_id = ? AND roll_row_id = ?").bind(e.id, line.id),
      m.env.DB.prepare("INSERT INTO el_tickets (id, election_id, roll_row_id, expires_at) VALUES (?, ?, ?, ?)").bind(await ticketId(e.id, ticket), e.id, line.id, m.now + TICKET_TTL),
    ]);
  } catch (err) { if (/guard_failed/.test(String((err as Error)?.message ?? err))) throw bad; throw err; }
  return { ticket, minutes: TICKET_TTL / 60_000, ballot: await ballotFor(m.env, e) };
}

// ------------------------------------------------------------------------------------------------------------------ step 3: the vote
export async function castVote(m: MemberCtx, eid: string, input: { ticket?: unknown; choices?: unknown }) {
  gate(m.env);
  if (m.society.erased_at) throw new HttpError(410, EL.erased, "erased");
  const e = await getElection(m.env, m.society.id, eid);
  assertVotingOpen(e, m.now); onlineOnly(e);
  const ticket = String(input.ticket ?? "");
  if (!/^[0-9a-f]{32}$/.test(ticket)) throw new HttpError(401, EL.badTicket, "bad_ticket");
  const tid = await ticketId(e.id, ticket);
  const t = await m.env.DB.prepare("SELECT roll_row_id, expires_at FROM el_tickets WHERE id = ? AND election_id = ?").bind(tid, e.id).first<{ roll_row_id: number; expires_at: number }>();
  if (!t || t.expires_at <= m.now) throw new HttpError(401, EL.badTicket, "bad_ticket");
  const line = await rollRow(m.env, e, t.roll_row_id);
  if (!line || line.email.trim().toLowerCase() !== m.email.trim().toLowerCase()) throw new HttpError(403, EL.notOnRoll, "not_on_roll");
  if (await registered(m.env, e.id, line.id)) throw new HttpError(409, EL.alreadyVoted, "already_voted");

  const posts = (await postsOf(m.env, e.id)).filter((p) => p.kind === "contested");
  if (!posts.length) throw new HttpError(409, EL.noPostsToVote, "nothing_to_vote");
  const noms = await nominationsOf(m.env, e.id);
  const raw = input.choices && typeof input.choices === "object" && !Array.isArray(input.choices) ? (input.choices as Record<string, unknown>) : null;
  if (!raw) throw new HttpError(400, EL.badChoices, "bad_choices");
  for (const k of Object.keys(raw)) if (!posts.some((p) => p.id === k)) throw new HttpError(400, EL.unknownPost, "unknown_post");
  const picks = posts.map((p) => {
    const v = raw[p.id];
    if (v !== undefined && !Array.isArray(v)) throw new HttpError(400, EL.badChoices, "bad_choices");
    const sel = (v ?? []) as unknown[];
    if (sel.some((x) => typeof x !== "string")) throw new HttpError(400, EL.badChoices, "bad_choices");
    const ids = sel as string[];
    if (new Set(ids).size !== ids.length) throw new HttpError(400, EL.sameCandidate, "same_candidate");
    if (ids.includes(NOTA)) {
      if (!e.nota) throw new HttpError(400, EL.notaOff, "nota_off");
      if (ids.length > 1) throw new HttpError(400, EL.notaAlone, "nota_alone");
      return { post: p, choice: { s: [], n: 1 } as Choice };
    }
    const ok = new Set(noms.filter((n) => n.post_id === p.id && n.status === "accepted").map((n) => n.id));
    if (ids.some((x) => !ok.has(x))) throw new HttpError(400, EL.unknownCandidate, "unknown_candidate");
    if (ids.length > p.max_votes) throw new HttpError(400, EL.tooManyVotes, "too_many_votes");
    return { post: p, choice: { s: [...ids].sort(), n: 0 } as Choice };
  });

  const day = dayOf(m.now, m.society.tz_offset_min), weight = weightOf(e, line), receipt = newReceipt(), pid = await pseudonym(m.env, m.email), db = m.env.DB;
  const sealed = await Promise.all(picks.map(async (x) => { const id = randomHex(16); return { id, post: x.post.id, sealed: await sealChoice(m.env, e, id, x.post.id, x.choice) }; }));
  const stmts: D1Stmt[] = [
    guardExists(m.env, EL.tooLate, "SELECT 1 FROM el_elections WHERE id = ? AND status = 'voting' AND voting_open_at <= ? AND voting_close_at > ?", e.id, m.now, m.now),
    db.prepare("DELETE FROM el_tickets WHERE id = ? AND expires_at > ?").bind(tid, m.now), guardChanged(m.env, EL.badTicket), // a used ticket is gone: no person, no time
    db.prepare("DELETE FROM el_codes WHERE election_id = ? AND roll_row_id = ?").bind(e.id, line.id),
    db.prepare("DELETE FROM rate_hits WHERE k IN (?, ?)").bind(`elcode:${e.id}:${line.id}`, `elopen:${e.id}:${line.id}`), // the exact times of this person's code requests
    db.prepare("INSERT INTO el_voted (election_id, roll_row_id, channel, by_pid, voted_at) VALUES (?, ?, 'online', ?, ?)").bind(e.id, line.id, pid, day),
    ...sealed.map((b) => db.prepare("INSERT INTO el_ballots (id, election_id, post_id, weight_milli, sealed) VALUES (?, ?, ?, ?, ?)").bind(b.id, e.id, b.post, weight, b.sealed)),
    db.prepare("INSERT INTO el_receipts (election_id, receipt_hash) VALUES (?, ?)").bind(e.id, await receiptHash(e.id, receipt)),
  ];
  // the signed entry carries the date (its time is the start of that day), never the hour or the minute
  try { await commit(m.env, m.society.id, stmts, "election.vote_cast", { pid, role: "voter" }, { election: e.id, channel: "online", date: day }, dayStartMs(day, m.society.tz_offset_min)); }
  catch (err) { if (uniqueIn(err, "el_voted")) throw new HttpError(409, EL.alreadyVoted, "already_voted"); throw err; }
  return { voted: true, receipt, note: "The vote was put in the box. Keep this receipt to check later that it is there. The receipt does not show what was chosen." };
}

/** Anyone with a receipt code can check that a ballot with that receipt is in the box. The answer shows nothing about the choice or the voter. */
export async function checkReceipt(env: Env, now: number, society: SocietyRow, eid: string, rawCode: unknown, ip: string) {
  gate(env);
  const e = await getElection(env, society.id, eid);
  if (e.status === "draft") throw new HttpError(404, EL.notFound, "not_found");
  await rateLimit(env, `elrcpt:${e.id}:${ip}`, 30, HOUR, now);
  const code = String(rawCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) throw new HttpError(400, EL.badReceipt, "bad_receipt");
  if (!(await env.DB.prepare("SELECT 1 AS x FROM el_receipts WHERE election_id = ? AND receipt_hash = ?").bind(e.id, await receiptHash(e.id, code)).first())) throw new HttpError(404, EL.noReceipts, "not_found");
  return { found: true, note: "A ballot with this receipt is in the box. The receipt does not show what was chosen." };
}

// ------------------------------------------------------------------------------------------------------------------ what a signed-in person sees about one election
export async function myElection(m: MemberCtx, eid: string) {
  gate(m.env);
  const e = await getElection(m.env, m.society.id, eid);
  if (e.status === "draft") { const own = await m.env.DB.prepare("SELECT 1 AS x FROM el_officials WHERE election_id = ? AND email = ?").bind(e.id, m.email).first(); if (!own) throw new HttpError(404, EL.notFound, "not_found"); }
  const rows = await rollFor(m.env, e, m.email);
  const units = await Promise.all(rows.map(async (r) => { const v = await registered(m.env, e.id, r.id); return { rollId: r.id, unit: pubUnit(r.unit), voted: !!v, channel: v?.channel ?? null }; }));
  const roles = (await m.env.DB.prepare("SELECT role FROM el_officials WHERE election_id = ? AND email = ?").bind(e.id, m.email).all<{ role: string }>()).results.map((x) => x.role);
  let canVoteNow = e.status === "voting" && m.now >= e.voting_open_at && m.now < e.voting_close_at;
  if (e.mode === "in_person" || e.mode === "offline") canVoteNow = false;
  return { election: { id: e.id, title: e.title, status: e.status, mode: e.mode }, onList: rows.length > 0, units, roles, canVoteNow };
}

// ------------------------------------------------------------------------------------------------------------------ paper ballots (in person)
type Actor = { role: ActorRole; email: string };
const team = (a: Actor) => { if (a.role !== "returning_officer" && a.role !== "counting_agent") throw new HttpError(403, EL.notTeam, "forbidden"); };

/** The returning officer or a counting agent finds a person on the final voter list at the desk. Shows who has already voted (not what). */
export async function findOnRoll(env: Env, society: SocietyRow, actor: Actor, eid: string, find: string) {
  gate(env); team(actor);
  const e = await getElection(env, society.id, eid);
  const q = find.trim().toLowerCase().slice(0, 60);
  if (!q || !e.roll_pub_id) return { people: [] };
  const rs = (await env.DB.prepare("SELECT id, unit, name FROM publication_rows WHERE publication_id = ? AND is_voter = 1 AND can_vote = 1 AND (instr(lower(unit), ?) > 0 OR instr(lower(name), ?) > 0) ORDER BY seq LIMIT 20").bind(e.roll_pub_id, q, q).all<{ id: number; unit: string; name: string }>()).results;
  return { people: await Promise.all(rs.map(async (r) => ({ rollId: r.id, unit: pubUnit(r.unit), name: r.name, voted: !!(await registered(env, e.id, r.id)) }))) };
}

/** A paper ballot is given to a person on the list who has not voted. It enters the register at once, so the same person cannot also vote online. */
export async function issuePaper(env: Env, now: number, society: SocietyRow, actor: Actor, eid: string, input: { rollId?: unknown }) {
  gate(env); team(actor);
  const e = await getElection(env, society.id, eid);
  if (e.mode === "online") throw new HttpError(409, EL.paperNone, "no_paper");
  if (e.weighting === "by_list") throw new HttpError(409, EL.paperWeighted, "no_paper");
  assertVotingOpen(e, now);
  const id = Number(input.rollId);
  if (!Number.isSafeInteger(id)) throw new HttpError(400, EL.badRollId, "bad_roll_id");
  const line = await rollRow(env, e, id);
  if (!line) throw new HttpError(404, EL.noPerson, "not_found");
  if (e.attendance_session_id && !(await presentInSession(env, society.id, e.attendance_session_id, line.unit_key, line.email))) throw new HttpError(409, EL.notPresent, "not_present");
  if (await registered(env, e.id, line.id)) throw new HttpError(409, EL.alreadyVoted, "already_voted");
  const pid = await pseudonym(env, actor.email), day = dayOf(now, society.tz_offset_min);
  const stmts: D1Stmt[] = [
    guardExists(env, EL.tooLate, "SELECT 1 FROM el_elections WHERE id = ? AND status = 'voting' AND voting_open_at <= ? AND voting_close_at > ?", e.id, now, now),
    env.DB.prepare("INSERT INTO el_voted (election_id, roll_row_id, channel, by_pid, voted_at) VALUES (?, ?, 'paper', ?, ?)").bind(e.id, line.id, pid, day),
  ];
  try { await commit(env, society.id, stmts, "election.paper_issued", { pid, role: actor.role }, { election: e.id }, now); }
  catch (err) { if (uniqueIn(err, "el_voted")) throw new HttpError(409, EL.alreadyVoted, "already_voted"); throw err; }
  const given = (await env.DB.prepare("SELECT COUNT(*) AS n FROM el_voted WHERE election_id = ? AND channel = 'paper'").bind(e.id).first<{ n: number }>())?.n ?? 0;
  return { issued: true, paperBallotsGiven: given };
}
