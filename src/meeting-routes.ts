// The Meetings addresses. Each one only reads the request, finds out who is asking and calls one service function; the rules live in meetings.ts, meeting-motions.ts,
// meeting-minutes.ts and meeting-report.ts. Every address answers "not found" unless MEETINGS_ENABLED is "1" (the product is dark until the owner decides), and it does so
// before anything else is looked at: not even a missing sign-in is shown.
//   Organizer and co-organizers:  /api/lists/:sid/meetings...   (staff sign-in, a Voter List only, like Results and Elections)
//   Anyone with the list's link:  /api/v/:slug/meetings...      (only what the Organizer chose to show; nothing personal; kept out of search engines)
import type { Env } from "./db";
import { gate, notErased } from "./meeting-core";
import * as minutes from "./meeting-minutes";
import * as motions from "./meeting-motions";
import * as report from "./meeting-report";
import * as meetings from "./meetings";
import type { SocietyRow, StaffCtx } from "./store";

export interface RouteReq { req: Request; env: Env; now: number; url: URL; params: Record<string, string>; ip: string; body: () => Promise<Record<string, unknown>> }
export interface Mount {
  route(method: string, path: string, h: (r: RouteReq) => Promise<Response>): void;
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
  file(body: Uint8Array | string, type: string, filename: string, inline?: boolean): Response;
  /** Staff sign-in for a Voter List. */
  staff(r: RouteReq): Promise<StaffCtx>;
  /** The list behind a public link, for a Voter List only. */
  slug(r: RouteReq): Promise<SocietyRow>;
  publicCache: Record<string, string>;
}

export function mountMeetings(M: Mount): void {
  const { route, json, file } = M;
  const staff = async (r: RouteReq): Promise<StaffCtx> => { gate(r.env); return M.staff(r); };
  const slug = async (r: RouteReq): Promise<SocietyRow> => { gate(r.env); const s = await M.slug(r); notErased(s); return s; };
  const mid = (r: RouteReq) => r.params.mid!;
  const PUBLIC = { ...M.publicCache, "x-robots-tag": "noindex" };

  // the rules of each kind of meeting (this address comes first, so that "rules" is never read as a meeting)
  route("GET", "/api/lists/:sid/meetings/rules", async (r) => json(await meetings.listRules(await staff(r))));
  route("PUT", "/api/lists/:sid/meetings/rules/:type", async (r) => { const c = await staff(r); return json(await meetings.setRule(c, r.params.type!, await r.body())); });

  // the meeting, its roles and people, its agenda and its notice
  route("POST", "/api/lists/:sid/meetings", async (r) => { const c = await staff(r); return json(await meetings.createMeeting(c, await r.body()), 201); });
  route("GET", "/api/lists/:sid/meetings", async (r) => json(await meetings.listMeetings(await staff(r))));
  route("GET", "/api/lists/:sid/meetings/:mid", async (r) => json(await meetings.showMeeting(await staff(r), mid(r))));
  route("PATCH", "/api/lists/:sid/meetings/:mid", async (r) => { const c = await staff(r); return json(await meetings.patchMeeting(c, mid(r), await r.body())); });
  route("PUT", "/api/lists/:sid/meetings/:mid/roles", async (r) => { const c = await staff(r); return json(await meetings.setRoles(c, mid(r), await r.body())); });
  route("POST", "/api/lists/:sid/meetings/:mid/people", async (r) => { const c = await staff(r); return json(await meetings.addPerson(c, mid(r), await r.body()), 201); });
  route("POST", "/api/lists/:sid/meetings/:mid/agenda", async (r) => { const c = await staff(r); return json(await meetings.addItem(c, mid(r), await r.body()), 201); });
  route("PATCH", "/api/lists/:sid/meetings/:mid/agenda/:iid", async (r) => { const c = await staff(r); return json(await meetings.editItem(c, mid(r), r.params.iid!, await r.body())); });
  route("DELETE", "/api/lists/:sid/meetings/:mid/agenda/:iid", async (r) => json(await meetings.removeItem(await staff(r), mid(r), r.params.iid!)));
  route("POST", "/api/lists/:sid/meetings/:mid/notice", async (r) => { const c = await staff(r); await r.body(); return json(await meetings.issueNotice(c, mid(r)), 201); });
  route("POST", "/api/lists/:sid/meetings/:mid/revise", async (r) => { const c = await staff(r); return json(await meetings.withdrawNotice(c, mid(r), await r.body())); });
  route("POST", "/api/lists/:sid/meetings/:mid/postpone", async (r) => { const c = await staff(r); return json(await meetings.postponeMeeting(c, mid(r), await r.body()), 201); });
  route("POST", "/api/lists/:sid/meetings/:mid/cancel", async (r) => { const c = await staff(r); return json(await meetings.cancelMeeting(c, mid(r), await r.body())); });

  // the run of the meeting
  route("POST", "/api/lists/:sid/meetings/:mid/open", async (r) => { const c = await staff(r); await r.body(); return json(await meetings.startMeeting(c, mid(r))); });
  route("POST", "/api/lists/:sid/meetings/:mid/adjourn", async (r) => { const c = await staff(r); return json(await meetings.adjournMeeting(c, mid(r), await r.body())); });
  route("POST", "/api/lists/:sid/meetings/:mid/resume", async (r) => { const c = await staff(r); await r.body(); return json(await meetings.resumeMeeting(c, mid(r))); });
  route("POST", "/api/lists/:sid/meetings/:mid/close", async (r) => { const c = await staff(r); await r.body(); return json(await meetings.closeMeeting(c, mid(r))); });
  route("POST", "/api/lists/:sid/meetings/:mid/points", async (r) => { const c = await staff(r); return json(await meetings.pointOfOrder(c, mid(r), await r.body()), 201); });

  // the quorum, the motions and their counted results
  route("GET", "/api/lists/:sid/meetings/:mid/quorum", async (r) => json(await motions.quorumView(await staff(r), mid(r))));
  route("GET", "/api/lists/:sid/meetings/:mid/decisions", async (r) => json(await motions.decisions(await staff(r), mid(r))));
  route("POST", "/api/lists/:sid/meetings/:mid/motions", async (r) => { const c = await staff(r); return json(await motions.moveMotion(c, mid(r), await r.body()), 201); });
  route("POST", "/api/lists/:sid/meetings/:mid/motions/:xid/withdraw", async (r) => { const c = await staff(r); return json(await motions.withdrawMotion(c, mid(r), r.params.xid!, await r.body())); });
  route("POST", "/api/lists/:sid/meetings/:mid/motions/:xid/interests", async (r) => { const c = await staff(r); return json(await motions.declareInterest(c, mid(r), r.params.xid!, await r.body()), 201); });
  route("POST", "/api/lists/:sid/meetings/:mid/motions/:xid/result", async (r) => { const c = await staff(r); return json(await motions.recordResult(c, mid(r), r.params.xid!, await r.body()), 201); });

  // the minutes and the follow-up actions
  route("GET", "/api/lists/:sid/meetings/:mid/minutes", async (r) => json(await minutes.listMinutes(await staff(r), mid(r))));
  route("POST", "/api/lists/:sid/meetings/:mid/minutes", async (r) => { const c = await staff(r); return json(await minutes.draftMinutes(c, mid(r), await r.body()), 201); });
  route("POST", "/api/lists/:sid/meetings/:mid/minutes/:vid/accept", async (r) => { const c = await staff(r); await r.body(); return json(await minutes.acceptMinutes(c, mid(r), r.params.vid!)); });
  route("POST", "/api/lists/:sid/meetings/:mid/minutes/:vid/approve", async (r) => { const c = await staff(r); return json(await minutes.approveMinutes(c, mid(r), r.params.vid!, await r.body())); });
  route("GET", "/api/lists/:sid/meetings/:mid/actions", async (r) => json(await minutes.listActions(await staff(r), mid(r))));
  route("POST", "/api/lists/:sid/meetings/:mid/actions", async (r) => { const c = await staff(r); return json(await minutes.addAction(c, mid(r), await r.body()), 201); });
  route("PATCH", "/api/lists/:sid/meetings/:mid/actions/:aid", async (r) => { const c = await staff(r); return json(await minutes.updateAction(c, mid(r), r.params.aid!, await r.body())); });

  // the report and the calendar file for the team
  route("GET", "/api/lists/:sid/meetings/:mid/report.json", async (r) => json(await report.reportOf(await staff(r), mid(r))));
  route("GET", "/api/lists/:sid/meetings/:mid/calendar.ics", async (r) => { const x = await report.staffCalendar(await staff(r), mid(r)); return file(x.body, x.type, x.filename); });

  // public: only what the Organizer chose to show (nothing personal), kept out of search engines
  route("GET", "/api/v/:slug/meetings", async (r) => json(await report.publicMeetings(r.env, await slug(r)), 200, PUBLIC));
  route("GET", "/api/v/:slug/meetings/:mid", async (r) => json(await report.publicMeeting(r.env, await slug(r), mid(r)), 200, PUBLIC));
  route("GET", "/api/v/:slug/meetings/:mid/calendar.ics", async (r) => { const x = await report.publicCalendar(r.env, await slug(r), mid(r), r.now); return file(x.body, x.type, x.filename); });
}
