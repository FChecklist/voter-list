// The Elections addresses. Each one only reads the request, finds out who is asking and calls one service function; the rules live in elections*.ts.
// Every address answers "not found" unless ELECTIONS_ENABLED is "1" (the product is dark until the owner decides).
//   Organizer and co-organizers:  /api/lists/:sid/elections...      (staff sign-in)
//   Voters and the people named for an election:  /api/v/:slug/elections...   (common link sign-in; an official signs in the same way as a voter)
import type { Env } from "./db";
import * as el from "./elections";
import * as cnt from "./elections-count";
import * as vote from "./elections-vote";
import type { SocietyRow, StaffCtx } from "./store";

export interface RouteReq { req: Request; env: Env; now: number; url: URL; params: Record<string, string>; ip: string; body: () => Promise<Record<string, unknown>> }
export interface Mount {
  route(method: string, path: string, h: (r: RouteReq) => Promise<Response>): void;
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
  staff(r: RouteReq): Promise<StaffCtx>;
  voter(r: RouteReq): Promise<el.MemberCtx>;
  slug(r: RouteReq): Promise<SocietyRow>;
  publicCache: Record<string, string>;
}

export function mountElections(M: Mount): void {
  const { route, json, staff, voter, slug, publicCache } = M;
  const eid = (r: RouteReq) => r.params.eid!;
  /** The role a signed-in person has in this election, if it is one of `allowed`. */
  const official = async (m: el.MemberCtx, id: string, allowed: el.ActorRole[]) => el.actorFor(m.env, m.society, await el.getElection(m.env, m.society.id, id), { staffEmail: null, memberEmail: m.email }, allowed);
  const TEAM: el.ActorRole[] = ["returning_officer", "counting_agent"], ALL: el.ActorRole[] = ["returning_officer", "counting_agent", "observer"], RO: el.ActorRole[] = ["returning_officer"];

  // ---------------------------------------------------------------------------------------------------------------- Organizer and co-organizers
  route("POST", "/api/lists/:sid/elections", async (r) => json(await el.createElection(await staff(r), await r.body()), 201));
  route("GET", "/api/lists/:sid/elections", async (r) => json(await el.listElections(await staff(r))));
  route("GET", "/api/lists/:sid/elections/:eid", async (r) => json(await el.staffView(await staff(r), eid(r))));
  route("PATCH", "/api/lists/:sid/elections/:eid", async (r) => json(await el.updateElection(await staff(r), eid(r), await r.body())));
  route("POST", "/api/lists/:sid/elections/:eid/notice", async (r) => json(await el.issueNotice(await staff(r), eid(r), await r.body())));
  route("GET", "/api/lists/:sid/elections/:eid/nominations", async (r) => json(await el.nominationsForTeam(await staff(r), eid(r))));
  route("POST", "/api/lists/:sid/elections/:eid/nominations/:nid/appeal/decide", async (r) => json(await el.decideAppeal(await staff(r), eid(r), r.params.nid!, await r.body())));
  route("POST", "/api/lists/:sid/elections/:eid/candidates/final", async (r) => json(await el.publishCandidates(await staff(r), eid(r), await r.body())));
  route("POST", "/api/lists/:sid/elections/:eid/open", async (r) => json(await el.openVoting(await staff(r), eid(r), await r.body())));
  route("POST", "/api/lists/:sid/elections/:eid/close", async (r) => json(await el.closeVoting(await staff(r), eid(r), await r.body())));
  route("POST", "/api/lists/:sid/elections/:eid/extend", async (r) => json(await el.extendVoting(await staff(r), eid(r), await r.body())));

  // ---------------------------------------------------------------------------------------------------------------- anyone with the common link (no personal data)
  route("GET", "/api/v/:slug/elections", async (r) => json(await el.publicElections(r.env, await slug(r)), 200, publicCache));
  route("GET", "/api/v/:slug/elections/:eid", async (r) => json(await el.publicElection(r.env, await slug(r), eid(r)), 200, publicCache));
  route("GET", "/api/v/:slug/elections/:eid/trail", async (r) => json(await el.publicTrail(r.env, await slug(r), eid(r)), 200, publicCache));
  route("GET", "/api/v/:slug/elections/:eid/results", async (r) => json(await cnt.publicResults(r.env, await slug(r), eid(r)), 200, publicCache));
  route("GET", "/api/v/:slug/elections/:eid/report", async (r) => json(await cnt.report(r.env, await slug(r), eid(r)), 200, publicCache));
  route("GET", "/api/v/:slug/elections/:eid/challenges", async (r) => json(await cnt.listChallenges(r.env, await slug(r), eid(r))));
  route("GET", "/api/v/:slug/elections/:eid/receipt/:code", async (r) => json(await vote.checkReceipt(r.env, r.now, await slug(r), eid(r), r.params.code, r.ip)));

  // ---------------------------------------------------------------------------------------------------------------- a signed-in voter
  route("GET", "/api/v/:slug/elections/:eid/me", async (r) => json(await vote.myElection(await voter(r), eid(r))));
  route("GET", "/api/v/:slug/elections/:eid/my-nominations", async (r) => json(await el.myNominations(await voter(r), eid(r))));
  route("POST", "/api/v/:slug/elections/:eid/nominations", async (r) => json(await el.submitNomination(await voter(r), eid(r), await r.body()), 201));
  route("POST", "/api/v/:slug/elections/:eid/nominations/:nid/withdraw", async (r) => { await r.body(); return json(await el.withdrawNomination(await voter(r), eid(r), r.params.nid!)); });
  route("POST", "/api/v/:slug/elections/:eid/nominations/:nid/appeal", async (r) => json(await el.appealNomination(await voter(r), eid(r), r.params.nid!, await r.body())));
  route("POST", "/api/v/:slug/elections/:eid/ballot-code", async (r) => json(await vote.sendBallotCode(await voter(r), eid(r), await r.body())));
  route("POST", "/api/v/:slug/elections/:eid/ballot", async (r) => json(await vote.openBallot(await voter(r), eid(r), await r.body())));
  route("POST", "/api/v/:slug/elections/:eid/vote", async (r) => json(await vote.castVote(await voter(r), eid(r), await r.body()), 201));
  route("POST", "/api/v/:slug/elections/:eid/challenges", async (r) => json(await cnt.fileChallenge(await voter(r), eid(r), await r.body()), 201));

  // ---------------------------------------------------------------------------------------------------------------- the people named for one election
  route("GET", "/api/v/:slug/elections/:eid/nominations", async (r) => { const m = await voter(r); return json(await el.nominationsForOfficial(m.env, m.society, await official(m, eid(r), ALL), eid(r))); });
  route("POST", "/api/v/:slug/elections/:eid/nominations/:nid/decide", async (r) => { const m = await voter(r); return json(await el.decideNomination(m.env, m.now, m.society, await official(m, eid(r), RO), eid(r), r.params.nid!, await r.body())); });
  route("GET", "/api/v/:slug/elections/:eid/roll", async (r) => { const m = await voter(r); return json(await vote.findOnRoll(m.env, m.society, await official(m, eid(r), TEAM), eid(r), r.url.searchParams.get("find") ?? "")); });
  route("POST", "/api/v/:slug/elections/:eid/paper/issue", async (r) => { const m = await voter(r); return json(await vote.issuePaper(m.env, m.now, m.society, await official(m, eid(r), TEAM), eid(r), await r.body()), 201); });
  route("POST", "/api/v/:slug/elections/:eid/count", async (r) => { const m = await voter(r); return json(await cnt.runCount(m.env, m.now, m.society, await official(m, eid(r), TEAM), eid(r), await r.body()), 201); });
  route("GET", "/api/v/:slug/elections/:eid/count", async (r) => { const m = await voter(r); return json(await cnt.countView(m.env, m.society, await official(m, eid(r), ALL), eid(r))); });
  route("POST", "/api/v/:slug/elections/:eid/challenges/:n/answer", async (r) => { const m = await voter(r); return json(await cnt.answerChallenge(m.env, m.now, m.society, await official(m, eid(r), RO), eid(r), Number(r.params.n), await r.body())); });
  route("POST", "/api/v/:slug/elections/:eid/declare", async (r) => { const m = await voter(r); return json(await cnt.declare(m.env, m.now, m.society, await official(m, eid(r), RO), eid(r), await r.body())); });
}
