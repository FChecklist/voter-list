// Results (first chunk), the pure part: cleaning a closing that was delivered, the counting rules, the checks, the words of the rules and the fingerprint.
// Nothing here touches the database, so every rule can be tested on its own. The service (src/results.ts) does the reading and the writing.
// A "closing" is a meeting or an election that has closed, with its counts. A result is made only from one (CP-312, CP-333).
import { HttpError } from "./errors";
import { squeeze } from "./text";
import { canonical } from "./vendor/canonical";
import { sha256Hex } from "./vendor/crypto";
import { scanPublic } from "./vendor/masking";

export const KINDS = ["meeting", "election"] as const;
export type Kind = (typeof KINDS)[number];
export const VERIFY_MODES = ["in_person", "online", "offline"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];
export const THRESHOLDS = ["simple", "two_thirds", "three_quarters"] as const;
export type Threshold = (typeof THRESHOLDS)[number];
export const TIE_RULES = ["lot", "chair", "revote"] as const;
export type TieRule = (typeof TIE_RULES)[number];
export const VISIBILITIES = ["hidden", "masked", "full"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const DEFAULT_CHALLENGE_HOURS = 48;
export const MAX_CHALLENGE_HOURS = 720;
export const MAX_COUNT = 1_000_000;
export const LATE_ENTRY_MS = 7 * 86_400_000;

export const MODE_TEXT: Record<VerifyMode, string> = { in_person: "In person", online: "Online", offline: "Offline (paper)" };
export type Outcome = "passed" | "not_passed" | "no_votes";
export const OUTCOME_TEXT: Record<Outcome, string> = { passed: "Passed", not_passed: "Not passed", no_votes: "No votes for or against" };
const THRESHOLD_CLAUSE: Record<Threshold, string> = {
  simple: "when more votes are for it than against it",
  two_thirds: "when at least two thirds of the votes for and against are for it",
  three_quarters: "when at least three quarters of the votes for and against are for it",
};
const TIE_TEXT: Record<TieRule, string> = {
  lot: "A tie for the last seat is settled by drawing lots.",
  chair: "A tie for the last seat is settled by the casting vote of the person in the chair.",
  revote: "A tie for the last seat is settled by a fresh vote.",
};

/** Every message the Results API can say. They are plain, short and polite. The pages that will show them (and their Hindi lines) come with the Results screens. */
export const RES = {
  notFound: "Not found.",
  erased: "This list has been closed and its details erased.",
  badBody: "Please send the details of the meeting or election.",
  badKind: "Please say whether this is a meeting or an election.",
  badRef: "Please give a reference for this meeting or election: up to 60 letters, digits, spaces or the signs - _ / .",
  badTitle: "Please type a title of 2 to 80 letters.",
  badTime: "Please pick the closing date and time again.",
  futureClose: "A result is made only after the meeting or election has closed. The closing time is still ahead.",
  badMode: "Please choose how it was checked: in person, online or offline.",
  badWindow: "Please give the challenge window as a whole number of hours, from 0 to 720.",
  badId: "That reference to an attendance session or a final list could not be read.",
  badQuorum: "Please give the quorum as none, a number of people, or a percent from 1 to 100.",
  noMotions: "Please add 1 to 30 motions, each with its text and its votes for, against and abstain.",
  badMotionNumber: "Each motion needs its own number, 1 or more.",
  badThreshold: "Please choose how a motion passes: simple, two_thirds or three_quarters.",
  badMotionText: "Please type the text of each motion, 2 to 300 letters.",
  badCount: "Please give every count as a whole number from 0 to 1,000,000.",
  noPosts: "Please add 1 to 20 posts, each with its seats and its candidates.",
  badPostName: "Each post needs its own name of 2 to 80 letters.",
  badSeats: "Please give the seats of each post as a whole number from 1 to 50.",
  noCandidates: "Each post needs 1 to 60 candidates, each with a name and the votes.",
  badCandidate: "Each candidate needs a name of 2 to 80 letters, and no two candidates of a post can share a name.",
  badTieRule: "Please choose how a tie is settled: lot, chair or revote.",
  badTieWinners: (post: string, open: number) => `For "${post}", please name exactly ${open} of the tied candidates as the winners of the tie.`,
  noTie: (post: string) => `"${post}" has no tie, so no winners of a tie can be named.`,
  contact: (where: string) => `Please do not write phone numbers or e-mail IDs in ${where}.`,
  noFinalList: "The final voter list must be frozen before a result can be made. Please freeze the list first.",
  noSuchList: "That final voter list was not found in this list.",
  noSuchAttendance: "That attendance session was not found in this list.",
  needClosing: "A result is made from a closed meeting or election. Please give the closing it is made from.",
  closingExists: "A closing with this reference was already entered. To change a result, please make a correction with a reason.",
  resultExists: "A result for this meeting or election already exists. To change it, please make a correction with a reason.",
  badReason: "Please write why the result is corrected, 5 to 300 letters.",
  sameProcess: "A correction must be for the same meeting or election: the same kind and the same reference.",
  notDraft: "Only a draft result can be made final.",
  confirmFinal: "Please type FINAL to confirm. A final result can never be changed. It can only be put right by a correction, which is a new result.",
  failedChecks: "This result has a failed check, so it cannot be made final. Please make a correction.",
  challengeOpen: (local: string) => `The challenge window is open until ${local}. The result can be made final after that.`,
  alreadyCorrected: "This result was already corrected. Please work on the newer result.",
  badVisibility: "Please choose hidden, masked or full.",
  changedMeanwhile: "This result changed at the same moment. Please look at it again.",
  shortCode: "Please type at least 12 letters or digits of the code printed with the result.",
  tooMany: "Many results were made in the last hour. Please try again a little later.",
} as const;

// ------------------------------------------------------------------------------------------------------------------ cleaning what was delivered
type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (message: string, code: string) => new HttpError(400, message, code);
/** Control characters removed, white space folded, trimmed. Only a string is accepted: anything else becomes empty. */
export const clean = (v: unknown): string => squeeze(typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "") : "");

function text(v: unknown, min: number, max: number, message: string, code: string, where: string): string {
  const t = clean(v);
  if (t.length < min || t.length > max) throw bad(message, code);
  if (scanPublic(t).length) throw bad(RES.contact(where), "contact_details");
  return t;
}
function count(v: unknown, message: string, code: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,7}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_COUNT) throw bad(message, code);
  return n;
}
function people(v: unknown, what: string, required: boolean, code: string): string[] {
  if (v === undefined || v === null) { if (required) throw bad(`Please name ${what}.`, code); return []; }
  if (!Array.isArray(v) || v.length > 10) throw bad(`Please give ${what} as a list of up to 10 names.`, code);
  const out: string[] = [];
  for (const x of v) { const t = text(x, 2, 80, "Each name needs 2 to 80 letters.", code, "the names"); if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); }
  if (required && !out.length) throw bad(`Please name ${what}.`, code);
  return out;
}
const optId = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{3,80}$/.test(v.trim())) throw bad(RES.badId, "bad_id");
  return v.trim();
};

export interface Motion { number: number; text: string; for: number; against: number; abstain: number; threshold: Threshold }
export interface Candidate { name: string; votes: number }
export interface Post { name: string; seats: number; none: number; candidates: Candidate[]; tieWinners: string[] }
export interface Quorum { type: "none" | "count" | "percent"; value: number }
interface ClosingBase { ref: string; title: string; closedAtLocal: string; mode: VerifyMode; challengeHours: number; attendanceId: string | null; listPubId: string | null; quorum: Quorum; validatedBy: string[]; observers: string[]; supervisedBy: string[]; countedBy: string[] }
export interface MeetingClosing extends ClosingBase { kind: "meeting"; motions: Motion[] }
export interface ElectionClosing extends ClosingBase { kind: "election"; ballots: number; tieRule: TieRule; posts: Post[] }
export type Closing = MeetingClosing | ElectionClosing;

function quorumOf(v: unknown): Quorum {
  if (v === undefined || v === null) return { type: "none", value: 0 };
  if (!isObj(v)) throw bad(RES.badQuorum, "bad_quorum");
  const type = String(v.type);
  if (type === "none") return { type: "none", value: 0 };
  if (type !== "count" && type !== "percent") throw bad(RES.badQuorum, "bad_quorum");
  const value = count(v.value, RES.badQuorum, "bad_quorum");
  if (value < 1 || (type === "percent" && value > 100)) throw bad(RES.badQuorum, "bad_quorum");
  return { type, value };
}

function motionsOf(v: unknown): Motion[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 30) throw bad(RES.noMotions, "bad_motions");
  const seen = new Set<number>(); const out: Motion[] = [];
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    if (!isObj(x)) throw bad(RES.noMotions, "bad_motions");
    const no = x.number === undefined ? i + 1 : count(x.number, RES.badMotionNumber, "bad_motions");
    if (no < 1 || seen.has(no)) throw bad(RES.badMotionNumber, "bad_motions");
    seen.add(no);
    const th = x.threshold === undefined ? "simple" : String(x.threshold);
    if (!(THRESHOLDS as readonly string[]).includes(th)) throw bad(RES.badThreshold, "bad_motions");
    out.push({
      number: no, text: text(x.text, 2, 300, RES.badMotionText, "bad_motions", "the motion text"),
      for: count(x.for, RES.badCount, "bad_motions"), against: count(x.against, RES.badCount, "bad_motions"), abstain: x.abstain === undefined ? 0 : count(x.abstain, RES.badCount, "bad_motions"),
      threshold: th as Threshold,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

function postsOf(v: unknown): Post[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw bad(RES.noPosts, "bad_posts");
  const names = new Set<string>(); const out: Post[] = [];
  for (const x of v) {
    if (!isObj(x)) throw bad(RES.noPosts, "bad_posts");
    const name = text(x.name, 2, 80, RES.badPostName, "bad_posts", "the post name");
    if (names.has(name.toLowerCase())) throw bad(RES.badPostName, "bad_posts");
    names.add(name.toLowerCase());
    const seats = count(x.seats, RES.badSeats, "bad_posts");
    if (seats < 1 || seats > 50) throw bad(RES.badSeats, "bad_posts");
    if (!Array.isArray(x.candidates) || x.candidates.length < 1 || x.candidates.length > 60) throw bad(RES.noCandidates, "bad_posts");
    const seen = new Set<string>(); const candidates: Candidate[] = [];
    for (const c of x.candidates) {
      if (!isObj(c)) throw bad(RES.noCandidates, "bad_posts");
      const cname = text(c.name, 2, 80, RES.badCandidate, "bad_posts", "the candidate names");
      if (seen.has(cname.toLowerCase())) throw bad(RES.badCandidate, "bad_posts");
      seen.add(cname.toLowerCase());
      candidates.push({ name: cname, votes: count(c.votes, RES.badCount, "bad_posts") });
    }
    out.push({ name, seats, none: x.none === undefined ? 0 : count(x.none, RES.badCount, "bad_posts"), candidates, tieWinners: people(x.tieWinners, "the winners of the tie", false, "bad_tie_winners") });
  }
  return out;
}

/** Cleans and checks a closing as delivered. Throws a 400 with a plain message. The closing time stays text here (the list's own time zone); the service turns it into a moment. */
export function parseClosing(input: unknown): Closing {
  if (!isObj(input)) throw bad(RES.badBody, "bad_closing");
  const kind = input.kind;
  if (kind !== "meeting" && kind !== "election") throw bad(RES.badKind, "bad_kind");
  const ref = clean(input.ref);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _\-\/.]{0,59}$/.test(ref) || scanPublic(ref).length) throw bad(RES.badRef, "bad_ref");
  const title = text(input.title, 2, 80, RES.badTitle, "bad_title", "the title");
  const closedAtLocal = clean(input.closedAt);
  if (!closedAtLocal) throw bad(RES.badTime, "bad_time");
  const modeRaw = String(input.mode);
  if (!(VERIFY_MODES as readonly string[]).includes(modeRaw)) throw bad(RES.badMode, "bad_mode");
  const challengeHours = input.challengeHours === undefined ? DEFAULT_CHALLENGE_HOURS : count(input.challengeHours, RES.badWindow, "bad_window");
  if (challengeHours > MAX_CHALLENGE_HOURS) throw bad(RES.badWindow, "bad_window");
  const base: ClosingBase = {
    ref, title, closedAtLocal, mode: modeRaw as VerifyMode, challengeHours, attendanceId: optId(input.attendanceId), listPubId: optId(input.listPubId), quorum: quorumOf(input.quorum),
    countedBy: people(input.countedBy, "the people who counted", true, "bad_counted"), validatedBy: people(input.validatedBy, "the people who validated the result", true, "bad_validated"),
    observers: people(input.observers, "the observers", false, "bad_observers"), supervisedBy: people(input.supervisedBy, "the people who supervised", false, "bad_supervised"),
  };
  if (kind === "meeting") return { ...base, kind, motions: motionsOf(input.motions) };
  const tr = String(input.tieRule);
  if (!(TIE_RULES as readonly string[]).includes(tr)) throw bad(RES.badTieRule, "bad_tie_rule");
  const tieRule = tr as TieRule;
  const posts = postsOf(input.posts);
  for (const p of posts) postResult(p, tieRule); // refuses winners of a tie that do not fit the votes
  return { ...base, kind, ballots: count(input.ballots, RES.badCount, "bad_ballots"), tieRule, posts };
}

// ------------------------------------------------------------------------------------------------------------------ counting
/** A motion passes by its stated threshold. Abstentions count neither way. With no votes for or against, nothing passes. */
export function motionOutcome(m: Pick<Motion, "for" | "against" | "threshold">): Outcome {
  const decided = m.for + m.against;
  if (decided === 0) return "no_votes";
  const ok = m.threshold === "simple" ? m.for > m.against : m.threshold === "two_thirds" ? m.for * 3 >= decided * 2 : m.for * 4 >= decided * 3;
  return ok ? "passed" : "not_passed";
}
export interface MotionResult { number: number; text: string; for: number; against: number; abstain: number; votes: number; threshold: Threshold; rule: string; outcome: Outcome; outcomeText: string }
export function meetingResult(motions: Motion[]): MotionResult[] {
  return motions.map((m) => { const outcome = motionOutcome(m); return { number: m.number, text: m.text, for: m.for, against: m.against, abstain: m.abstain, votes: m.for + m.against + m.abstain, threshold: m.threshold, rule: `Passes ${THRESHOLD_CLAUSE[m.threshold]}.`, outcome, outcomeText: OUTCOME_TEXT[outcome] }; });
}

export interface RankedCandidate { name: string; votes: number; status: "won" | "lost" | "tied" }
export interface PostResult { name: string; seats: number; none: number; total: number; uncontested: boolean; vacant: number; ranking: RankedCandidate[]; winners: string[]; tie: { open: number; among: string[]; decidedBy: TieRule | null } | null }
const lower = (s: string) => s.toLowerCase();
const byVotes = (a: Candidate, b: Candidate) => b.votes - a.votes || (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0);

/** The winners of one post: the candidates with the most votes, up to the seats. A tie for the last seat stays open until the delivery names who won it under the stated rule. */
export function postResult(p: Post, tieRule: TieRule): PostResult {
  const total = p.candidates.reduce((s, c) => s + c.votes, 0) + p.none;
  const sorted = [...p.candidates].sort(byVotes);
  const head = { name: p.name, seats: p.seats, none: p.none, total };
  if (sorted.length <= p.seats) { // nobody to choose between: the candidates win the seats, and any empty seat is shown
    if (p.tieWinners.length) throw bad(RES.noTie(p.name), "bad_tie_winners");
    return { ...head, uncontested: true, vacant: p.seats - sorted.length, ranking: sorted.map((c) => ({ name: c.name, votes: c.votes, status: "won" as const })), winners: sorted.map((c) => c.name), tie: null };
  }
  const boundary = sorted[p.seats - 1]!.votes;
  if (boundary > sorted[p.seats]!.votes) { // a clear line between the last winner and the first who did not win
    if (p.tieWinners.length) throw bad(RES.noTie(p.name), "bad_tie_winners");
    return { ...head, uncontested: false, vacant: 0, ranking: sorted.map((c, i) => ({ name: c.name, votes: c.votes, status: (i < p.seats ? "won" : "lost") as RankedCandidate["status"] })), winners: sorted.slice(0, p.seats).map((c) => c.name), tie: null };
  }
  const clear = sorted.filter((c) => c.votes > boundary);
  const among = sorted.filter((c) => c.votes === boundary);
  const open = p.seats - clear.length;
  let settled: string[] = [];
  if (p.tieWinners.length) {
    const tiedNames = new Set(among.map((c) => lower(c.name)));
    const picked = p.tieWinners.map(lower);
    if (picked.length !== open || new Set(picked).size !== picked.length || picked.some((n) => !tiedNames.has(n))) throw bad(RES.badTieWinners(p.name, open), "bad_tie_winners");
    settled = among.filter((c) => picked.includes(lower(c.name))).map((c) => c.name);
  }
  const won = new Set([...clear.map((c) => c.name), ...settled]);
  const ranking = sorted.map((c) => ({ name: c.name, votes: c.votes, status: (won.has(c.name) ? "won" : c.votes === boundary && !settled.length ? "tied" : "lost") as RankedCandidate["status"] }));
  return { ...head, uncontested: false, vacant: 0, ranking, winners: sorted.filter((c) => won.has(c.name)).map((c) => c.name), tie: { open, among: among.map((c) => c.name), decidedBy: settled.length ? tieRule : null } };
}
export interface ElectionResult { ballots: number; turnoutBp: number; tieRule: TieRule; posts: PostResult[] }

// ------------------------------------------------------------------------------------------------------------------ facts read from the other products
export interface ListFacts { pubId: string; finalNo: number; fingerprint: string; cutoffAt: number; publishedAt: number; voters: number; limit: number; weightMode: string; event: string; eventType: string; voterRule: string }
export interface AttFacts { id: string; title: string; startsAt: string; startsAtMs: number; closedAt: number | null; status: string; eligible: number; present: number }
export interface QuorumStatus { type: Quorum["type"]; value: number; required: number | null; present: number | null; met: boolean | null }

/** The quorum, from the attendance session when there is one. With no attendance session, a quorum that is asked for cannot be checked (met stays null). */
export function quorumStatus(q: Quorum, att: AttFacts | null): QuorumStatus {
  if (q.type === "none") return { type: "none", value: 0, required: null, present: att ? att.present : null, met: true };
  if (!att) return { type: q.type, value: q.value, required: q.type === "count" ? q.value : null, present: null, met: null };
  const required = q.type === "count" ? q.value : Math.ceil((att.eligible * q.value) / 100);
  return { type: q.type, value: q.value, required, present: att.present, met: att.present >= required };
}

// ------------------------------------------------------------------------------------------------------------------ the words of the rule
export function quorumText(q: Quorum): string {
  if (q.type === "count") return `The quorum is ${q.value} ${q.value === 1 ? "person" : "people"} present.`;
  if (q.type === "percent") return `The quorum is ${q.value} percent of the people who may attend.`;
  return "No quorum is needed.";
}
/** The rule that was used, in words (CP-315). It is built from the same fields the counting uses, so the words and the numbers cannot disagree. */
export function ruleText(c: Closing): string {
  if (c.kind === "meeting") {
    const first = c.motions[0]!.threshold;
    const same = c.motions.every((m) => m.threshold === first);
    const motionRule = same ? `A motion passes ${THRESHOLD_CLAUSE[first]}.` : c.motions.map((m) => `Motion ${m.number} passes ${THRESHOLD_CLAUSE[m.threshold]}`).join("; ") + ".";
    return [quorumText(c.quorum), motionRule, "Abstentions are not counted for or against."].join(" ");
  }
  return [quorumText(c.quorum), "In each post, the candidates with the most votes win the seats. A post with no more candidates than seats is won by its candidates.", TIE_TEXT[c.tieRule]].join(" ");
}
export const percentText = (bp: number): string => (bp / 100).toFixed(2).replace(/\.?0+$/, "") + " percent";

// ------------------------------------------------------------------------------------------------------------------ the checks
export interface Check { code: string; level: "ok" | "warn" | "fail"; text: string }
export interface Basis { society: string; version: number; supersedesFp: string | null; correctionReason: string | null; closingRevision: number; source: string; closedAt: number; closedAtLocal: string; tz: number; now: number; list: ListFacts; att: AttFacts | null }

/** The checks that guard a result. A "fail" stops it from becoming final (the database refuses it too) and shows a warning to everyone who reads it (CP-290, CP-334, CP-335). */
export function makeChecks(c: Closing, b: Basis, qs: QuorumStatus, motions: MotionResult[] | null, election: ElectionResult | null): Check[] {
  const out: Check[] = [];
  const add = (level: Check["level"], code: string, t: string) => { out.push({ level, code, text: t }); };
  const noun = c.kind;
  if (b.list.cutoffAt <= b.closedAt) add("ok", "list_frozen_first", `The final voter list was frozen before the ${noun} closed.`);
  else add("fail", "list_frozen_late", `The final voter list was frozen after the ${noun} closed. A result needs a final list that was fixed first.`);
  if (b.list.eventType === c.kind) add("ok", "list_event", `The final voter list was frozen for this ${noun}.`);
  else add("warn", "list_event", `The final voter list was frozen for ${b.list.eventType ? "a " + b.list.eventType : "another event"}, and this is ${c.kind === "meeting" ? "a meeting" : "an election"}.`);
  if (!b.att) add("warn", "attendance_missing", "No attendance session is linked, so the number of people present was not checked.");
  else if (b.att.status !== "closed") add("warn", "attendance_open", "The attendance session is still open, so the number of people present may still change.");
  else add("ok", "attendance_linked", `The attendance session is linked and closed: ${b.att.present} of ${b.att.eligible} marked present.`);
  if (c.quorum.type === "none") add("ok", "quorum", "No quorum is needed.");
  else if (qs.met === null) add("fail", "quorum", "The quorum could not be checked because no attendance session is linked.");
  else if (qs.met) add("ok", "quorum", `The quorum was met: ${qs.present} present, ${qs.required} needed.`);
  else add("fail", "quorum", `The quorum was not met: ${qs.present} present, ${qs.required} needed.`);
  let broken = 0;
  if (motions) {
    for (const m of motions) {
      if (m.votes > b.list.limit) { broken++; add("fail", "votes_over_list", `Motion ${m.number} has ${m.votes} votes, more than the ${b.list.limit} votes the final list allows.`); }
      if (b.att && m.votes > b.att.present) { broken++; add("fail", "votes_over_present", `Motion ${m.number} has ${m.votes} votes, more than the ${b.att.present} people marked present.`); }
    }
    if (!broken) add("ok", "votes", b.att ? "The votes on every motion are within the final list and the people marked present." : "The votes on every motion are within the final list.");
  }
  if (election) {
    if (election.ballots > b.list.limit) { broken++; add("fail", "ballots_over_list", `${election.ballots} ballots were cast, more than the ${b.list.limit} votes the final list allows.`); }
    for (const p of election.posts) {
      if (p.total > election.ballots) { broken++; add("fail", "votes_over_ballots", `The post "${p.name}" has ${p.total} votes, more than the ${election.ballots} ballots cast.`); }
      if (p.tie && p.tie.decidedBy === null) { broken++; add("fail", "tie_unsettled", `The tie for ${p.tie.open === 1 ? "the last seat" : p.tie.open + " seats"} in "${p.name}" is not settled by the stated rule.`); }
    }
    if (!broken) add("ok", "votes", "The ballots and the votes of every post agree with the final list.");
  }
  if (b.source === "organizer") add("warn", "entered_by_hand", "The Organizer entered this closing. The Meetings or Elections system did not deliver it.");
  if (b.now - b.closedAt > LATE_ENTRY_MS) add("warn", "late_entry", `This closing was entered ${Math.floor((b.now - b.closedAt) / 86_400_000)} days after the ${noun} closed.`);
  if (!c.observers.length) add("warn", "no_observers", "No observers are named.");
  if (!c.supervisedBy.length) add("warn", "no_supervisor", "No supervisor is named.");
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ the declared content and its fingerprint
export interface Content {
  v: 1; society: string; kind: Kind; ref: string; title: string; version: number; closingRevision: number; source: string;
  closedAt: number; closedAtLocal: string; tz: number; mode: VerifyMode;
  rule: { text: string; voterRule: string };
  list: ListFacts; attendance: AttFacts | null; quorum: QuorumStatus;
  signoff: { countedBy: string[]; validatedBy: string[]; observers: string[]; supervisedBy: string[] };
  challengeHours: number; correction: { reason: string; supersedesFp: string } | null;
  motions: MotionResult[] | null; election: ElectionResult | null; checks: Check[];
}
/** The fingerprint covers everything a result says, and the list it belongs to. Counts are whole numbers only, so it is the same on every machine. */
export const fingerprintOf = (content: unknown): Promise<string> => sha256Hex("voter-list/result/v1\n" + canonical(content));

export async function buildContent(c: Closing, b: Basis): Promise<{ content: Content; fingerprint: string; failed: number }> {
  const qs = quorumStatus(c.quorum, b.att);
  const motions = c.kind === "meeting" ? meetingResult(c.motions) : null;
  const election: ElectionResult | null = c.kind === "election"
    ? { ballots: c.ballots, turnoutBp: b.list.voters > 0 ? Math.round((c.ballots * 10000) / b.list.voters) : 0, tieRule: c.tieRule, posts: c.posts.map((p) => postResult(p, c.tieRule)) }
    : null;
  const checks = makeChecks(c, b, qs, motions, election);
  const content: Content = {
    v: 1, society: b.society, kind: c.kind, ref: c.ref, title: c.title, version: b.version, closingRevision: b.closingRevision, source: b.source,
    closedAt: b.closedAt, closedAtLocal: b.closedAtLocal, tz: b.tz, mode: c.mode,
    rule: { text: ruleText(c), voterRule: b.list.voterRule },
    list: b.list, attendance: b.att, quorum: qs,
    signoff: { countedBy: c.countedBy, validatedBy: c.validatedBy, observers: c.observers, supervisedBy: c.supervisedBy },
    challengeHours: c.challengeHours, correction: b.correctionReason && b.supersedesFp ? { reason: b.correctionReason, supersedesFp: b.supersedesFp } : null,
    motions, election, checks,
  };
  return { content, fingerprint: await fingerprintOf(content), failed: checks.filter((x) => x.level === "fail").length };
}

/** The same content with every person's name passed through `f` (the public page can show names masked). Counts, rules and checks stay as they are. */
export function mapNames(content: Content, f: (name: string) => string): Content {
  const s = content.signoff;
  return {
    ...content,
    signoff: { countedBy: s.countedBy.map(f), validatedBy: s.validatedBy.map(f), observers: s.observers.map(f), supervisedBy: s.supervisedBy.map(f) },
    election: content.election ? { ...content.election, posts: content.election.posts.map((p) => ({ ...p, ranking: p.ranking.map((r) => ({ ...r, name: f(r.name) })), winners: p.winners.map(f), tie: p.tie ? { ...p.tie, among: p.tie.among.map(f) } : null })) } : null,
  };
}

/** What a person typed into the verify box, as hex letters and digits only. A code of 12 or more characters is checked against the start of the fingerprint. */
export const normalizeClaim = (v: unknown): string => String(v ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
