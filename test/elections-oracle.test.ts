// Elections: the count checked against a tally the test makes on its own, on random votes (the random numbers are seeded, so every run is the same).
import { describe, expect, test } from "bun:test";
import { base, cand, castAs, closeAndCount, draft, emailOf, pick, toVoting, voterUrl, type World } from "./elections-world";

/** A small seeded random number generator (mulberry32). */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const MAIL = { MAIL_DAILY_CAP: "5000", MAIL_LIST_CAP: "5000", MAIL_STAFF_RESERVE: "20" }; // each online vote sends two e-mails; the default daily limits are for a very small society
type Pick = Array<number | "NOTA">;
const by = (r: any[]) => Object.fromEntries(r.map((x) => [x.title, x])) as Record<string, any>;

/** What one voter does on one post: nothing, none of the above, or `max` or fewer different candidates. */
function choose(r: () => number, first: number, n: number, max: number): Pick {
  const x = r(); if (x < 0.1) return []; if (x < 0.2) return ["NOTA"];
  const k = 1 + Math.floor(r() * max), pool = Array.from({ length: n }, (_, i) => first + i), out: number[] = [];
  while (out.length < Math.min(k, n)) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return out;
}
/** The tally by the book, from the votes that were cast. */
function expected(votes: Array<[Pick, Pick]>, first: number, n: number, post: 0 | 1) {
  const votesFor = Array.from({ length: n }, () => 0); let blank = 0, nota = 0;
  for (const v of votes) { const p = v[post]; if (p.length === 0) blank++; else if (p[0] === "NOTA") nota++; else for (const c of p) votesFor[(c as number) - first]!++; }
  return { votesFor, blank, nota, ballots: votes.length };
}
function check(w: World, got: any, exp: ReturnType<typeof expected>, first: number, seats: number) {
  expect([got.ballots, got.blank, got.noneOfTheAbove, got.invalid]).toEqual([exp.ballots, exp.blank, exp.nota, 0]);
  exp.votesFor.forEach((v, i) => { const c = got.candidates.find((x: any) => x.id === cand(w, first + i)); expect([c.name, c.votes]).toEqual([c.name, v]); });
  // the winners: the best `seats` by votes; where a tie reaches across the last seat the count must say so and draw, and still elect exactly `seats`
  const order = exp.votesFor.map((v, i) => ({ v, id: cand(w, first + i) })).sort((a, b) => b.v - a.v);
  const cut = order[seats - 1]!.v, sure = order.filter((x) => x.v > cut).map((x) => x.id), group = order.filter((x) => x.v === cut).map((x) => x.id);
  expect(got.elected).toHaveLength(seats); for (const id of sure) expect(got.elected).toContain(id);
  for (const id of got.elected) expect([...sure, ...group]).toContain(id);
  if (sure.length + group.length === seats || group.length <= seats - sure.length) expect(got.draw).toBeNull(); else { expect(got.draw).not.toBeNull(); expect([...got.draw.tied].sort()).toEqual([...group].sort()); }
}

describe("the count equals a tally made on its own", () => {
  for (const seed of [11, 2027, 90210]) {
    test(`24 voters, random votes, seed ${seed}`, async () => {
      const VOTERS = 24, r = rng(seed);
      const w = await base({ voters: VOTERS, env: MAIL }).then((b) => draft(b)); await toVoting(w);
      const cast: Array<[Pick, Pick]> = []; const receipts: string[] = [];
      for (let i = 0; i < VOTERS; i++) {
        if (r() < 0.12) continue; // some people do not vote
        const v: [Pick, Pick] = [choose(r, 0, 3, 1), choose(r, 3, 4, 2)];
        const res = await castAs(w, emailOf(i), pick(w, { 1: v[0], 2: v[1] })); expect([i, res.vote?.status]).toEqual([i, 201]);
        cast.push(v); receipts.push(res.vote.json.receipt);
      }
      expect(cast.length).toBeGreaterThan(15);
      const { ro, count } = await closeAndCount(w); expect(count.status).toBe(201); expect(count.json.reconciled).toBe(true);
      const res = by(count.json.result);
      check(w, res["President"], expected(cast, 0, 3, 0), 0, 1);
      check(w, res["Committee member"], expected(cast, 3, 4, 1), 3, 2);
      const view = (await w.h.call("GET", voterUrl(w, "/count"), undefined, ro)).json; expect(view.turnout).toEqual({ online: cast.length, paper: 0, eligible: VOTERS });
      // every voter's receipt is in the box, and a second count of the same box gives the same fingerprint and the same draw
      for (const code of receipts) expect((await w.h.call("GET", voterUrl(w, `/receipt/${code}`))).status).toBe(200);
      const again = await w.h.call("POST", voterUrl(w, "/count"), { reason: "Counted again to compare the numbers." }, ro);
      expect(again.json.fingerprint).toBe(count.json.fingerprint); expect(by(again.json.result)["President"].draw).toEqual(res["President"].draw);
    });
  }
});
