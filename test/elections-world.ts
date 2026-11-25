// Shared set-up for the Elections tests: a list with enrolled voters and a frozen voter list, then an election taken step by step to the state a test needs.
import { expect } from "bun:test";
import { localToMs } from "../src/lists";
import { enrolVoter, makeHarness, newList, waiting, type Harness, type Jar } from "./harness";

export const TZ = 330; // India: the harness list's own time zone
export const at = (local: string): number => localToMs(local, TZ)!;
export const SCHED = { nominationsOpen: "2026-11-12T10:00", nominationsClose: "2026-11-14T18:00", withdrawalClose: "2026-11-15T18:00", votingOpen: "2026-11-20T09:00", votingClose: "2026-11-20T18:00" };
const FIRST = ["Asha", "Bharat", "Chitra", "Dev", "Esha", "Farid", "Gita", "Hari", "Indu", "Jai", "Kiran", "Lata"];
export const emailOf = (i: number) => `v${i + 1}@sample.example`;
export const RO = "ro@sample.example", AGENT = "agent@sample.example", OBSERVER = "observer@sample.example";

export interface World { h: Harness; jar: Jar; coJar: Jar; sid: string; slug: string; eid: string; posts: Array<{ id: string; n: number; title: string }>; cand: Record<string, string>; voters: number }
export interface PostPlan { title: string; seats: number; maxVotes?: number; run: number[] }

/** A list with `voters` enrolled and approved people, a co-organizer, and a frozen voter list. No election yet. */
export async function base(o: { voters?: number; flag?: boolean; extra?: Record<string, unknown>; organizer?: string; env?: Record<string, string> } = {}) {
  const h = await makeHarness({ ELECTIONS_ENABLED: o.flag === false ? "0" : "1", ...o.env });
  const { jar, sid, slug } = await newList(h, { email: o.organizer, extra: o.extra });
  const n = o.voters ?? 8;
  for (let i = 0; i < n; i++) await enrolVoter(h, slug, emailOf(i), { unit: `A-${101 + i}`, name: `${FIRST[i % FIRST.length]} Sample`, mobile: `90000003${String(10 + i).padStart(2, "0")}` });
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const coJar = await h.staff("co@sample.example");
  const ok = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar); if (ok.status !== 200) throw new Error("approve failed " + ok.text);
  // the Organizer cannot approve their own record: a co-organizer approves what is left
  const left = await waiting(h, sid, coJar);
  if (left.length) { const ok2 = await h.call("POST", `/api/lists/${sid}/records/decide`, { items: left, decision: "approve" }, coJar); if (ok2.status !== 200) throw new Error("approve (co-organizer) failed " + ok2.text); }
  const f = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "Committee election", eventType: "election", confirm: "FREEZE", closeNow: true, ackWarnings: true, ackPending: true }, jar);
  if (f.status !== 201) throw new Error("freeze failed " + f.text);
  return { h, jar, coJar, sid, slug, voters: n, pubId: f.json.id as string, fingerprint: f.json.fingerprint as string };
}
export type Base = Awaited<ReturnType<typeof base>>;

export const OFFICIALS = { returningOfficer: { email: RO, name: "Ravi Officer" }, countingAgents: [{ email: AGENT, name: "Chitra Agent" }], observers: [{ email: OBSERVER, name: "Om Observer" }] };
export const DEFAULT_POSTS: PostPlan[] = [
  { title: "President", seats: 1, run: [0, 1, 2] },
  { title: "Committee member", seats: 2, maxVotes: 2, run: [3, 4, 5, 6] },
  { title: "Treasurer", seats: 1, run: [7] },
  { title: "Secretary", seats: 1, run: [] },
];

/** Make the election draft. */
export async function draft(b: Base, o: { posts?: PostPlan[]; mode?: string; nota?: boolean; weighting?: string; officials?: unknown; body?: Record<string, unknown> } = {}): Promise<World> {
  const posts = o.posts ?? DEFAULT_POSTS;
  const r = await b.h.call("POST", `/api/lists/${b.sid}/elections`, {
    title: "Committee election 2027", term: "2027 to 2029", mode: o.mode ?? "online", nota: o.nota ?? true, weighting: o.weighting ?? "equal", schedule: SCHED,
    posts: posts.map((p) => ({ title: p.title, seats: p.seats, maxVotes: p.maxVotes })), officials: o.officials ?? OFFICIALS, ...o.body,
  }, b.jar);
  if (r.status !== 201) throw new Error("draft failed " + r.text);
  return { h: b.h, jar: b.jar, coJar: b.coJar, sid: b.sid, slug: b.slug, eid: r.json.election.id, posts: r.json.election.posts.map((p: any) => ({ id: p.id, n: p.n, title: p.title })), cand: {}, voters: b.voters };
}
export const staffUrl = (w: World, tail = "") => `/api/lists/${w.sid}/elections/${w.eid}${tail}`;
export const voterUrl = (w: World, tail = "") => `/api/v/${w.slug}/elections/${w.eid}${tail}`;

export async function notice(w: World, jar: Jar = w.jar) { return w.h.call("POST", staffUrl(w, "/notice"), { confirm: "NOTICE" }, jar); }

/** Send one nomination as the candidate. Proposer and seconder are the next two other voters on the list. */
export async function nominate(w: World, who: number, postIdx: number, extra: Record<string, unknown> = {}) {
  const others = Array.from({ length: w.voters }, (_, i) => i).filter((i) => i !== who);
  const jar = await asMember(w, emailOf(who));
  return w.h.call("POST", voterUrl(w, "/nominations"), { postId: w.posts[postIdx]!.id, proposerEmail: emailOf(others[0]!), seconderEmail: emailOf(others[1]!), declaration: "I am willing to serve and I meet the rules.", statement: "I will serve the society honestly.", ...extra }, jar);
}

// A sign-in is reused for a few simulated hours, as a real person's session would be (the code limit is 4 an hour).
const sessions = new WeakMap<Harness, Map<string, { jar: Jar; at: number }>>();
export async function asMember(w: World, email: string): Promise<Jar> {
  const m = sessions.get(w.h) ?? new Map<string, { jar: Jar; at: number }>(); sessions.set(w.h, m);
  const hit = m.get(email);
  if (hit && w.h.clock.now - hit.at >= 0 && w.h.clock.now - hit.at < 6 * 3_600_000) return hit.jar;
  const jar = await w.h.member(w.slug, email); m.set(email, { jar, at: w.h.clock.now }); return jar;
}

/** Notice, nominations from the plan, the returning officer accepts them all, the final list is published. Leaves the clock after the withdrawal time. */
export async function toFinal(w: World, plan: PostPlan[] = DEFAULT_POSTS) {
  const { h } = w;
  expect((await notice(w)).status).toBe(200);
  h.clock.now = at("2026-11-12T11:00");
  for (let p = 0; p < plan.length; p++) for (const who of plan[p]!.run) { const r = await nominate(w, who, p); if (r.status !== 201) throw new Error("nomination failed " + r.text); }
  h.clock.now = at("2026-11-13T10:00");
  const ro = await asMember(w, RO);
  const list = await h.call("GET", voterUrl(w, "/nominations"), undefined, ro); if (list.status !== 200) throw new Error("official list failed " + list.text);
  for (const n of list.json.nominations as any[]) {
    const d = await h.call("POST", voterUrl(w, `/nominations/${n.id}/decide`), { decision: "accepted" }, ro); if (d.status !== 200) throw new Error("decide failed " + d.text);
    w.cand[n.name.split(" ")[0] + ""] = n.id;
  }
  h.clock.now = at("2026-11-15T19:00");
  const f = await h.call("POST", staffUrl(w, "/candidates/final"), { confirm: "FINAL" }, w.jar); if (f.status !== 200) throw new Error("final failed " + f.text);
  return f;
}
export const nameOf = (i: number) => FIRST[i % FIRST.length]!;
export const cand = (w: World, i: number) => w.cand[nameOf(i)]!;

export async function toVoting(w: World, plan: PostPlan[] = DEFAULT_POSTS) {
  await toFinal(w, plan);
  w.h.clock.now = at("2026-11-20T09:30");
  const r = await w.h.call("POST", staffUrl(w, "/open"), { confirm: "OPEN" }, w.jar); if (r.status !== 200) throw new Error("open failed " + r.text);
  return r;
}

/** One person votes online: sign in, ask for the code, open the ballot, vote. Returns every response. */
export async function castAs(w: World, email: string, choices: Record<string, string[]>) {
  const jar = await asMember(w, email);
  const sent = await w.h.call("POST", voterUrl(w, "/ballot-code"), {}, jar);
  if (sent.status !== 200) return { jar, sent, opened: null as any, vote: null as any };
  const opened = await w.h.call("POST", voterUrl(w, "/ballot"), { code: w.h.code(email) }, jar);
  if (opened.status !== 200) return { jar, sent, opened, vote: null as any };
  const vote = await w.h.call("POST", voterUrl(w, "/vote"), { ticket: opened.json.ticket, choices }, jar);
  return { jar, sent, opened, vote };
}
/** Choices by post number (1-based) and voter number (0-based) of the candidate; "NOTA" and [] allowed. */
export function pick(w: World, byPost: Record<number, Array<number | "NOTA">>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [n, who] of Object.entries(byPost)) out[w.posts[Number(n) - 1]!.id] = who.map((x) => (x === "NOTA" ? "NOTA" : cand(w, x)));
  return out;
}

/** The votes of the standard story: 7 of 8 voters vote. P1: A=2, B=3, C=0, none=1, blank=1. P2: D=4, E=3, F=2, G=1, blank=1. */
export async function standardVotes(w: World) {
  const V: Array<Record<number, Array<number | "NOTA">>> = [
    { 1: [1], 2: [3, 4] }, { 1: [1], 2: [3, 5] }, { 1: [0], 2: [4, 5] }, { 1: [0], 2: [3] }, { 1: ["NOTA"], 2: [] }, { 1: [], 2: [6, 3] }, { 1: [1], 2: [4] },
  ];
  const out = [];
  for (let i = 0; i < V.length; i++) { const r = await castAs(w, emailOf(i), pick(w, V[i]!)); if (r.vote?.status !== 201) throw new Error(`vote ${i} failed ` + JSON.stringify(r.vote?.json ?? r.opened?.json ?? r.sent?.json)); out.push(r); }
  return out;
}

export async function closeAndCount(w: World, paper?: unknown) {
  w.h.clock.now = at("2026-11-20T18:05");
  const c = await w.h.call("POST", staffUrl(w, "/close"), { confirm: "CLOSE" }, w.jar); if (c.status !== 200) throw new Error("close failed " + c.text);
  const ro = await asMember(w, RO);
  const r = await w.h.call("POST", voterUrl(w, "/count"), paper === undefined ? {} : { paper }, ro);
  return { ro, count: r };
}
