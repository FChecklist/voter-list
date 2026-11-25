// Results, the pure part: how a delivered closing is cleaned, how outcomes are counted, which checks guard a result, and the fingerprint.
// Nothing here touches a database; test/results.test.ts runs the same rules through the API.
import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/errors";
import {
  buildContent, clean, fingerprintOf, mapNames, meetingResult, motionOutcome, normalizeClaim, parseClosing, postResult, quorumStatus, ruleText,
  type AttFacts, type Basis, type Closing, type ListFacts, type Post,
} from "../src/results-core";

const LIST: ListFacts = { pubId: "pub_1", finalNo: 1, fingerprint: "f".repeat(64), cutoffAt: 1000, publishedAt: 1000, voters: 10, limit: 10, weightMode: "equal", event: "Annual meeting", eventType: "meeting", voterRule: "Owner only" };
const ATT: AttFacts = { id: "att_1", title: "Club house", startsAt: "2026-12-05T18:00", startsAtMs: 5000, closedAt: 6000, status: "closed", eligible: 10, present: 8 };
const base = (over: Partial<Basis> = {}): Basis => ({ society: "soc_1", version: 1, supersedesFp: null, correctionReason: null, closingRevision: 1, source: "organizer", closedAt: 7000, closedAtLocal: "2026-12-05T20:00", tz: 330, now: 8000, list: LIST, att: ATT, ...over });
const who = { countedBy: ["A Counter"], validatedBy: ["V Person"] };
const meeting = (over: Record<string, unknown> = {}) => parseClosing({ kind: "meeting", ref: "AGM-2026", title: "Annual meeting", closedAt: "2026-12-05T20:00", mode: "in_person", ...who, motions: [{ text: "Approve the accounts", for: 5, against: 2, abstain: 1 }], ...over });
const election = (over: Record<string, unknown> = {}) => parseClosing({
  kind: "election", ref: "EC-2026", title: "Committee election", closedAt: "2026-12-05T20:00", mode: "online", ballots: 8, tieRule: "lot", ...who, observers: ["O Server"], supervisedBy: ["S Visor"],
  posts: [{ name: "President", seats: 1, candidates: [{ name: "Asha Rao", votes: 5 }, { name: "Bharat Nair", votes: 3 }] }], ...over,
});
const codeOf = (f: () => unknown): string => { try { f(); } catch (e) { return e instanceof HttpError ? e.code : "other:" + String(e); } return "none"; };
const post = (over: Partial<Post> = {}): Post => ({ name: "President", seats: 1, none: 0, candidates: [{ name: "Asha Rao", votes: 4 }, { name: "Bharat Nair", votes: 4 }, { name: "Chitra Iyer", votes: 1 }], tieWinners: [], ...over });

describe("a motion passes by its stated threshold", () => {
  test("simple: more for than against; a tie does not pass; abstentions count neither way", () => {
    expect(motionOutcome({ for: 5, against: 4, threshold: "simple" })).toBe("passed");
    expect(motionOutcome({ for: 4, against: 4, threshold: "simple" })).toBe("not_passed");
    expect(motionOutcome({ for: 1, against: 0, threshold: "simple" })).toBe("passed");
  });
  test("two thirds and three quarters sit exactly on the line", () => {
    expect(motionOutcome({ for: 2, against: 1, threshold: "two_thirds" })).toBe("passed");
    expect(motionOutcome({ for: 66, against: 34, threshold: "two_thirds" })).toBe("not_passed");
    expect(motionOutcome({ for: 67, against: 33, threshold: "two_thirds" })).toBe("passed");
    expect(motionOutcome({ for: 3, against: 1, threshold: "three_quarters" })).toBe("passed");
    expect(motionOutcome({ for: 74, against: 26, threshold: "three_quarters" })).toBe("not_passed");
    expect(motionOutcome({ for: 75, against: 25, threshold: "three_quarters" })).toBe("passed");
  });
  test("with no votes for or against nothing passes", () => {
    expect(motionOutcome({ for: 0, against: 0, threshold: "simple" })).toBe("no_votes");
    const r = meetingResult([{ number: 1, text: "Only abstentions", for: 0, against: 0, abstain: 7, threshold: "simple" }]);
    expect(r[0]).toMatchObject({ outcome: "no_votes", outcomeText: "No votes for or against", votes: 7 });
  });
  test("each motion carries its rule in words, built from the same threshold the count used", () => {
    const [a, b] = meetingResult([
      { number: 1, text: "First", for: 2, against: 1, abstain: 0, threshold: "two_thirds" },
      { number: 2, text: "Second", for: 2, against: 1, abstain: 0, threshold: "simple" },
    ]);
    expect(a!.rule).toContain("two thirds"); expect(b!.rule).toContain("more votes are for it than against it");
  });
});

describe("the winners of a post", () => {
  test("a clear line between the last winner and the first who did not win", () => {
    const r = postResult(post({ candidates: [{ name: "Asha Rao", votes: 5 }, { name: "Bharat Nair", votes: 3 }] }), "lot");
    expect(r.winners).toEqual(["Asha Rao"]); expect(r.tie).toBeNull(); expect(r.uncontested).toBe(false);
    expect(r.ranking.map((x) => x.status)).toEqual(["won", "lost"]); expect(r.total).toBe(8);
  });
  test("a tie for the last seat stays open until the delivery names the winners of the tie", () => {
    const open = postResult(post(), "lot");
    expect(open.winners).toEqual([]); expect(open.tie).toEqual({ open: 1, among: ["Asha Rao", "Bharat Nair"], decidedBy: null });
    expect(open.ranking.map((x) => x.status)).toEqual(["tied", "tied", "lost"]);
    const settled = postResult(post({ tieWinners: ["Bharat Nair"] }), "chair");
    expect(settled.winners).toEqual(["Bharat Nair"]); expect(settled.tie?.decidedBy).toBe("chair");
    expect(settled.ranking.map((x) => `${x.name}:${x.status}`)).toEqual(["Asha Rao:lost", "Bharat Nair:won", "Chitra Iyer:lost"]);
  });
  test("with two seats the clear winners keep their seats and only the open seats are decided", () => {
    const p = post({ seats: 2, candidates: [{ name: "Asha Rao", votes: 5 }, { name: "Bharat Nair", votes: 3 }, { name: "Chitra Iyer", votes: 3 }, { name: "Dev Menon", votes: 1 }] });
    const open = postResult(p, "revote"); expect(open.tie?.open).toBe(1); expect(open.winners).toEqual(["Asha Rao"]);
    const settled = postResult({ ...p, tieWinners: ["Chitra Iyer"] }, "revote"); expect(settled.winners).toEqual(["Asha Rao", "Chitra Iyer"]);
  });
  test("winners of a tie that do not fit the votes are refused", () => {
    expect(codeOf(() => postResult(post({ tieWinners: ["Asha Rao", "Bharat Nair"] }), "lot"))).toBe("bad_tie_winners"); // too many
    expect(codeOf(() => postResult(post({ tieWinners: ["Chitra Iyer"] }), "lot"))).toBe("bad_tie_winners"); // not one of the tied
    expect(codeOf(() => postResult(post({ tieWinners: ["Asha Rao", "Asha Rao"] }), "lot"))).toBe("bad_tie_winners");
    expect(codeOf(() => postResult(post({ candidates: [{ name: "Asha Rao", votes: 5 }, { name: "Bharat Nair", votes: 3 }], tieWinners: ["Asha Rao"] }), "lot"))).toBe("bad_tie_winners"); // no tie at all
  });
  test("a post with no more candidates than seats is won by its candidates, and an empty seat is shown", () => {
    const r = postResult(post({ seats: 3, candidates: [{ name: "Asha Rao", votes: 2 }, { name: "Bharat Nair", votes: 0 }] }), "lot");
    expect(r).toMatchObject({ uncontested: true, vacant: 1, winners: ["Asha Rao", "Bharat Nair"] });
    expect(postResult(post({ seats: 2, candidates: [{ name: "Asha Rao", votes: 2 }, { name: "Bharat Nair", votes: 2 }] }), "lot")).toMatchObject({ uncontested: true, vacant: 0 });
    expect(codeOf(() => postResult(post({ seats: 3, candidates: [{ name: "Asha Rao", votes: 2 }], tieWinners: ["Asha Rao"] }), "lot"))).toBe("bad_tie_winners");
  });
  test("the order of candidates in the delivery never changes the result", () => {
    const a = postResult(post(), "lot"), b = postResult(post({ candidates: [...post().candidates].reverse() }), "lot");
    expect(b).toEqual(a);
  });
});

describe("the quorum", () => {
  test("a count, a percent of those who may attend, or none", () => {
    expect(quorumStatus({ type: "count", value: 9 }, ATT)).toMatchObject({ required: 9, present: 8, met: false });
    expect(quorumStatus({ type: "count", value: 8 }, ATT)).toMatchObject({ required: 8, met: true });
    expect(quorumStatus({ type: "percent", value: 50 }, ATT)).toMatchObject({ required: 5, met: true });
    expect(quorumStatus({ type: "percent", value: 81 }, ATT)).toMatchObject({ required: 9, met: false }); // 8.1 people rounds up to 9
    expect(quorumStatus({ type: "none", value: 0 }, ATT)).toMatchObject({ met: true, required: null });
  });
  test("a quorum that is asked for cannot be checked without an attendance session", () => {
    expect(quorumStatus({ type: "count", value: 3 }, null)).toMatchObject({ met: null, present: null });
    expect(quorumStatus({ type: "none", value: 0 }, null).met).toBe(true);
  });
});

describe("cleaning a closing as delivered", () => {
  test("a good meeting and a good election come back clean, with defaults", () => {
    const m = meeting(); expect(m).toMatchObject({ kind: "meeting", ref: "AGM-2026", challengeHours: 48, attendanceId: null, listPubId: null, quorum: { type: "none", value: 0 }, observers: [], supervisedBy: [] });
    expect(m.kind === "meeting" && m.motions[0]).toMatchObject({ number: 1, threshold: "simple", abstain: 1, for: 5, against: 2 });
    const e = election(); expect(e).toMatchObject({ kind: "election", ballots: 8, tieRule: "lot" });
  });
  test("every refusal has its own code", () => {
    expect(codeOf(() => parseClosing(null))).toBe("bad_closing");
    expect(codeOf(() => parseClosing([]))).toBe("bad_closing");
    expect(codeOf(() => meeting({ kind: "vote" }))).toBe("bad_kind");
    expect(codeOf(() => meeting({ ref: "" }))).toBe("bad_ref");
    expect(codeOf(() => meeting({ ref: "a@b.example" }))).toBe("bad_ref");
    expect(codeOf(() => meeting({ ref: "x".repeat(61) }))).toBe("bad_ref");
    expect(codeOf(() => meeting({ title: "x" }))).toBe("bad_title");
    expect(codeOf(() => meeting({ title: "Call 9876543210" }))).toBe("contact_details");
    expect(codeOf(() => meeting({ title: "Write to a@b.example" }))).toBe("contact_details");
    expect(codeOf(() => meeting({ closedAt: "" }))).toBe("bad_time");
    expect(codeOf(() => meeting({ mode: "hybrid" }))).toBe("bad_mode");
    expect(codeOf(() => meeting({ challengeHours: 721 }))).toBe("bad_window");
    expect(codeOf(() => meeting({ challengeHours: "soon" }))).toBe("bad_window");
    expect(codeOf(() => meeting({ attendanceId: "no way" }))).toBe("bad_id");
    expect(codeOf(() => meeting({ quorum: { type: "percent", value: 101 } }))).toBe("bad_quorum");
    expect(codeOf(() => meeting({ quorum: { type: "count", value: 0 } }))).toBe("bad_quorum");
    expect(codeOf(() => meeting({ quorum: { type: "half" } }))).toBe("bad_quorum");
    expect(codeOf(() => meeting({ countedBy: undefined }))).toBe("bad_counted");
    expect(codeOf(() => meeting({ validatedBy: [] }))).toBe("bad_validated");
    expect(codeOf(() => meeting({ observers: "everyone" }))).toBe("bad_observers");
  });
  test("motions: 1 to 30, own numbers, whole counts, a known threshold", () => {
    const one = { text: "Approve the accounts", for: 1, against: 0 };
    expect(codeOf(() => meeting({ motions: [] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: Array.from({ length: 31 }, (_, i) => ({ ...one, number: i + 1 })) }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, number: 2 }, { ...one, number: 2 }] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, threshold: "half" }] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, for: -1 }] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, for: 1.5 }] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, for: 1_000_001 }] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, text: "x" }] }))).toBe("bad_motions");
    expect(codeOf(() => meeting({ motions: [{ ...one, text: "Call 9876543210 now" }] }))).toBe("contact_details");
    const strings = meeting({ motions: [{ ...one, for: "12", against: " 3 " }] }); // a count that arrives as text from a sheet is read as a number
    expect(strings.kind === "meeting" && strings.motions[0]).toMatchObject({ for: 12, against: 3 });
    const sorted = meeting({ motions: [{ ...one, number: 3 }, { ...one, number: 1 }] }); expect(sorted.kind === "meeting" && sorted.motions.map((m) => m.number)).toEqual([1, 3]);
  });
  test("elections: posts, seats, candidates, the tie rule and the ballots", () => {
    const c = (name: string, votes: number) => ({ name, votes });
    expect(codeOf(() => election({ tieRule: undefined }))).toBe("bad_tie_rule");
    expect(codeOf(() => election({ posts: [] }))).toBe("bad_posts");
    expect(codeOf(() => election({ ballots: undefined }))).toBe("bad_ballots");
    expect(codeOf(() => election({ posts: [{ name: "P", seats: 1, candidates: [c("Asha Rao", 1)] }] }))).toBe("bad_posts"); // post name too short
    expect(codeOf(() => election({ posts: [{ name: "President", seats: 0, candidates: [c("Asha Rao", 1)] }] }))).toBe("bad_posts");
    expect(codeOf(() => election({ posts: [{ name: "President", seats: 51, candidates: [c("Asha Rao", 1)] }] }))).toBe("bad_posts");
    expect(codeOf(() => election({ posts: [{ name: "President", seats: 1, candidates: [] }] }))).toBe("bad_posts");
    expect(codeOf(() => election({ posts: [{ name: "President", seats: 1, candidates: [c("Asha Rao", 1), c("asha rao", 2)] }] }))).toBe("bad_posts");
    expect(codeOf(() => election({ posts: [{ name: "President", seats: 1, candidates: [c("Asha Rao", 1)] }, { name: "president", seats: 1, candidates: [c("Bharat Nair", 1)] }] }))).toBe("bad_posts");
    expect(codeOf(() => election({ posts: [{ name: "President", seats: 1, candidates: [c("Asha Rao", 4), c("Bharat Nair", 4)], tieWinners: ["Asha Rao", "Bharat Nair"] }] }))).toBe("bad_tie_winners");
  });
  test("names of people are listed once, and control characters never get through", () => {
    const m = meeting({ countedBy: ["A Counter", "a  counter", "B Counter"] });
    expect(m.countedBy).toEqual(["A Counter", "B Counter"]);
    expect(clean("a\u0007b")).toBe("ab"); expect(clean(123)).toBe(""); expect(clean("  two   words ")).toBe("two words");
  });
});

describe("the declared content and its fingerprint", () => {
  test("the same delivery always gives the same fingerprint, and any change gives another", async () => {
    const a = await buildContent(meeting(), base()), b = await buildContent(meeting(), base());
    expect(a.fingerprint).toBe(b.fingerprint); expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await buildContent(meeting({ motions: [{ text: "Approve the accounts", for: 4, against: 2, abstain: 1 }] }), base())).fingerprint).not.toBe(a.fingerprint);
    expect((await buildContent(meeting(), base({ version: 2 }))).fingerprint).not.toBe(a.fingerprint);
    expect((await buildContent(meeting(), base({ list: { ...LIST, fingerprint: "a".repeat(64) } }))).fingerprint).not.toBe(a.fingerprint);
    expect((await buildContent(meeting({ title: "Annual meeting 2" }), base())).fingerprint).not.toBe(a.fingerprint);
  });
  test("the fingerprint covers exactly the content it is stored with", async () => {
    const a = await buildContent(meeting(), base());
    expect(await fingerprintOf(a.content)).toBe(a.fingerprint);
    expect(await fingerprintOf(JSON.parse(JSON.stringify(a.content)))).toBe(a.fingerprint); // as stored and read back
    expect(await fingerprintOf({ b: 1, a: 2 })).toBe(await fingerprintOf({ a: 2, b: 1 }));
    expect(await fingerprintOf({ a: 2 })).not.toBe(await fingerprintOf({ a: 3 }));
  });
  test("a correction carries the fingerprint it replaces and its reason", async () => {
    const first = await buildContent(meeting(), base());
    const next = await buildContent(meeting(), base({ version: 2, supersedesFp: first.fingerprint, correctionReason: "A count was copied wrongly" }));
    expect(next.content.correction).toEqual({ reason: "A count was copied wrongly", supersedesFp: first.fingerprint }); expect(first.content.correction).toBeNull();
  });
  test("the words of the rule are built from the same fields the count used", () => {
    const m = meeting({ quorum: { type: "percent", value: 50 }, motions: [{ text: "Change the by-laws", for: 1, against: 0, threshold: "two_thirds" }] });
    expect(ruleText(m)).toContain("The quorum is 50 percent"); expect(ruleText(m)).toContain("two thirds"); expect(ruleText(m)).toContain("Abstentions are not counted");
    expect(ruleText(meeting())).toContain("No quorum is needed");
    expect(ruleText(election())).toContain("drawing lots");
    expect(ruleText(election({ tieRule: "chair" }))).toContain("casting vote");
    expect(ruleText(election({ tieRule: "revote" }))).toContain("fresh vote");
  });
  test("names can be passed through a mask; counts, rules and checks stay as they are", async () => {
    const a = await buildContent(election({ posts: [{ name: "President", seats: 1, candidates: [{ name: "Asha Rao", votes: 5 }, { name: "Bharat Nair", votes: 3 }] }] }), base({ list: { ...LIST, eventType: "election" } }));
    const m = mapNames(a.content, (n) => n.toUpperCase());
    expect(m.signoff.countedBy).toEqual(["A COUNTER"]); expect(m.election?.posts[0]?.winners).toEqual(["ASHA RAO"]);
    expect(m.election?.posts[0]?.ranking.map((r) => r.name)).toEqual(["ASHA RAO", "BHARAT NAIR"]);
    expect(m.election?.ballots).toBe(8); expect(m.checks).toEqual(a.content.checks); expect(m.rule).toEqual(a.content.rule);
    expect(a.content.signoff.countedBy).toEqual(["A Counter"]); // the original is not changed
  });
  test("a code typed from paper is reduced to letters and digits of a fingerprint", () => {
    expect(normalizeClaim("ABCD-EF01 2345-6789")).toBe("abcdef0123456789"); expect(normalizeClaim("xyz")).toBe(""); expect(normalizeClaim(undefined)).toBe("");
  });
});

describe("the checks that guard a result", () => {
  const checks = async (c: Closing, b: Basis) => { const r = await buildContent(c, b); return { codes: r.content.checks.map((k) => `${k.code}:${k.level}`), failed: r.failed }; };
  test("a clean meeting with an attendance session passes, with notes only for what was entered by hand and who is not named", async () => {
    expect(await checks(meeting(), base())).toEqual({ failed: 0, codes: ["list_frozen_first:ok", "list_event:ok", "attendance_linked:ok", "quorum:ok", "votes:ok", "entered_by_hand:warn", "no_observers:warn", "no_supervisor:warn"] });
  });
  test("a list frozen after the closing, votes beyond the list or beyond the people present, and an unmet quorum all fail", async () => {
    expect((await checks(meeting(), base({ list: { ...LIST, cutoffAt: 7001, publishedAt: 7001 } }))).codes).toContain("list_frozen_late:fail");
    expect((await checks(meeting({ motions: [{ text: "Approve the accounts", for: 9, against: 2 }] }), base())).codes).toContain("votes_over_present:fail");
    expect((await checks(meeting({ motions: [{ text: "Approve the accounts", for: 9, against: 2 }] }), base({ att: null }))).codes).toContain("votes_over_list:fail");
    expect((await checks(meeting({ quorum: { type: "count", value: 9 } }), base())).codes).toContain("quorum:fail");
    const noAtt = await checks(meeting({ quorum: { type: "percent", value: 10 } }), base({ att: null }));
    expect(noAtt.codes).toContain("quorum:fail"); expect(noAtt.codes).toContain("attendance_missing:warn"); expect(noAtt.failed).toBe(1);
  });
  test("an open attendance session, a list for another event, a late entry and missing observers are notes, not failures", async () => {
    const r = await checks(meeting(), base({ att: { ...ATT, status: "open", closedAt: null }, list: { ...LIST, eventType: "election" }, now: 7000 + 8 * 86_400_000 }));
    expect(r.failed).toBe(0); expect(r.codes).toEqual(expect.arrayContaining(["attendance_open:warn", "list_event:warn", "late_entry:warn", "no_observers:warn", "no_supervisor:warn"]));
  });
  test("an election fails on more ballots than the list allows, more votes in a post than ballots, and an unsettled tie", async () => {
    const e = (over: Record<string, unknown>) => election(over);
    const b = base({ list: { ...LIST, eventType: "election" } });
    expect((await checks(e({}), b)).codes).toEqual(["list_frozen_first:ok", "list_event:ok", "attendance_linked:ok", "quorum:ok", "votes:ok", "entered_by_hand:warn"]);
    expect((await checks(e({ ballots: 11 }), b)).codes).toContain("ballots_over_list:fail");
    expect((await checks(e({ ballots: 7 }), b)).codes).toContain("votes_over_ballots:fail"); // 8 votes in the post, 7 ballots
    const tie = await checks(e({ posts: [{ name: "President", seats: 1, candidates: [{ name: "Asha Rao", votes: 4 }, { name: "Bharat Nair", votes: 4 }] }] }), b);
    expect(tie.codes).toContain("tie_unsettled:fail"); expect(tie.failed).toBe(1);
    const settled = await checks(e({ posts: [{ name: "President", seats: 1, candidates: [{ name: "Asha Rao", votes: 4 }, { name: "Bharat Nair", votes: 4 }], tieWinners: ["Bharat Nair"] }] }), b);
    expect(settled.failed).toBe(0);
    // a post with two seats may carry two votes on each ballot: 6 votes on 3 ballots is fine, 7 is not
    const two = (votes: number) => e({ ballots: 3, posts: [{ name: "Committee", seats: 2, candidates: [{ name: "Asha Rao", votes }, { name: "Bharat Nair", votes: 3 }, { name: "Chitra Iyer", votes: 0 }] }] });
    expect((await checks(two(3), b)).codes).not.toContain("votes_over_ballots:fail");
    expect((await checks(two(4), b)).codes).toContain("votes_over_ballots:fail");
  });
  test("turnout is a whole number of basis points of the voters on the list", async () => {
    const r = await buildContent(election(), base({ list: { ...LIST, voters: 10, eventType: "election" } }));
    expect(r.content.election?.turnoutBp).toBe(8000);
    expect((await buildContent(election({ ballots: 1 }), base({ list: { ...LIST, voters: 3, eventType: "election" } }))).content.election?.turnoutBp).toBe(3333);
  });
});

describe("the counting keeps its promises for any votes (seeded, so every run is the same)", () => {
  test("a motion passes exactly when for is at least 2 or 3 times against, and more votes for never turn a pass into a fail", () => {
    for (let f = 0; f <= 60; f++) for (let a = 0; a <= 60; a++) {
      expect(motionOutcome({ for: f, against: a, threshold: "simple" })).toBe(f + a === 0 ? "no_votes" : f > a ? "passed" : "not_passed");
      expect(motionOutcome({ for: f, against: a, threshold: "two_thirds" })).toBe(f + a === 0 ? "no_votes" : f >= 2 * a ? "passed" : "not_passed");
      expect(motionOutcome({ for: f, against: a, threshold: "three_quarters" })).toBe(f + a === 0 ? "no_votes" : f >= 3 * a ? "passed" : "not_passed");
      if (motionOutcome({ for: f, against: a, threshold: "two_thirds" }) === "passed") expect(motionOutcome({ for: f + 1, against: a, threshold: "two_thirds" })).toBe("passed");
    }
  });
  test("for any post: winners never exceed the seats, a clear line leaves no open tie, a tie is open for exactly the seats left, and naming the tied winners settles it", () => {
    let seed = 20261125;
    const next = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    let ties = 0, clear = 0, open = 0;
    for (let round = 0; round < 3000; round++) {
      const n = 1 + next(8), seats = 1 + next(5);
      const candidates = Array.from({ length: n }, (_, k) => ({ name: `Candidate ${k + 1}`, votes: next(5) }));
      const p: Post = { name: "Post", seats, none: next(3), candidates, tieWinners: [] };
      const r = postResult(p, "lot");
      const votesOf = new Map(candidates.map((c) => [c.name, c.votes]));
      const won = new Set(r.winners);
      expect(r.winners.length).toBeLessThanOrEqual(seats);
      expect(r.total).toBe(candidates.reduce((sum, c) => sum + c.votes, 0) + p.none);
      for (let k = 1; k < r.ranking.length; k++) expect(r.ranking[k - 1]!.votes).toBeGreaterThanOrEqual(r.ranking[k]!.votes);
      if (!r.tie) {
        clear++;
        expect(r.winners.length).toBe(Math.min(seats, n)); expect(r.vacant).toBe(Math.max(0, seats - n));
        const fewest = Math.min(...r.winners.map((w) => votesOf.get(w)!));
        for (const c of candidates) if (!won.has(c.name)) expect(c.votes).toBeLessThan(fewest);
      } else {
        ties++; open += r.tie.open;
        expect(r.uncontested).toBe(false); expect(r.tie.decidedBy).toBeNull();
        expect(r.tie.open).toBe(seats - r.winners.length); expect(r.tie.among.length).toBeGreaterThan(r.tie.open);
        const edge = votesOf.get(r.tie.among[0]!)!;
        for (const a of r.tie.among) expect(votesOf.get(a)).toBe(edge);
        for (const w of r.winners) expect(votesOf.get(w)!).toBeGreaterThan(edge);
        const settled = postResult({ ...p, tieWinners: r.tie.among.slice(0, r.tie.open) }, "chair");
        expect(settled.winners.length).toBe(seats); expect(settled.tie?.decidedBy).toBe("chair");
        for (const w of r.winners) expect(settled.winners).toContain(w);
        expect(codeOf(() => postResult({ ...p, tieWinners: r.tie!.among.slice(0, r.tie!.open + 1) }, "chair"))).toBe("bad_tie_winners");
      }
    }
    expect(ties).toBeGreaterThan(100); expect(clear).toBeGreaterThan(100); expect(open).toBeGreaterThan(ties - 1); // both kinds of post were really tried
  });
});
