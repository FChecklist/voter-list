// Meetings, first chunks: rules, meeting, agenda, notice (with the notice-period check), officers, quorum, motions and results, interests,
// minutes with approval at a later meeting, action items, the public page, the calendar file, the report, erasure, and the database's own refusals.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { routeTable } from "../src/handler";
import { passes } from "../src/meeting-motions";
import { MEETING_MESSAGES } from "../src/meeting-messages";
import { canonical } from "../src/vendor/canonical";
import { sha256Hex } from "../src/vendor/crypto";
import type { Env } from "../src/db";
import { enrolVoter, makeHarness, newList, waiting, type Harness, type Jar } from "./harness";

const START = Date.UTC(2026, 11, 5, 12, 30); // 2026-12-05T18:00 in India
const LATER = Date.UTC(2026, 11, 20, 12, 30); // 2026-12-20T18:00 in India
const FIRST = ["asha", "bharat", "chitra", "dev", "esha", "farid"];

async function world(n = 4, opts: Partial<Env> = {}) {
  const h = await makeHarness({ MEETINGS_ENABLED: "1", ...opts }); const { jar, sid, slug } = await newList(h);
  for (let i = 0; i < n; i++) await enrolVoter(h, slug, `${FIRST[i]}@sample.example`, { unit: `${"ABCDEF"[i]}-${i + 1}`, name: `${FIRST[i]![0]!.toUpperCase()}${FIRST[i]!.slice(1)} Sample`, mobile: `9000000${400 + i}` });
  if (n) await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "co@sample.example" }, jar);
  const coJar = await h.staff("co@sample.example");
  const v: Record<string, string> = {};
  for (let i = 0; i < n; i++) v[FIRST[i]!] = (h.raw.query("SELECT id FROM voters WHERE email = ?").get(`${FIRST[i]}@sample.example`) as { id: string }).id;
  return { h, jar, coJar, sid, slug, base: `/api/lists/${sid}/meetings`, v };
}
type W = Awaited<ReturnType<typeof world>>;
const need = (r: { status: number; json: any; text: string }, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
const rule = (w: W, type = "annual", days = 21, pct = 50, more: Record<string, unknown> = {}) => w.h.call("PUT", `${w.base}/rules/${type}`, { noticeDays: days, quorumPercent: pct, clause: "Bye-law 12", adjournClause: "Meet again after seven days, at the same time and place.", ...more }, w.jar);
const meeting = (w: W, o: Record<string, unknown> = {}) => w.h.call("POST", w.base, { title: "Annual General Meeting", type: "annual", startsAt: "2026-12-05T18:00", place: "Club house", mode: "in_person", ...o }, w.jar);
const item = (w: W, mid: string, o: Record<string, unknown>) => w.h.call("POST", `${w.base}/${mid}/agenda`, o, w.jar);
const CHAIR = { name: "Mr Chair Person", email: "chair@sample.example" }, SECRETARY = { name: "Ms Secretary Person", email: "secretary@sample.example" };
const COUNTER = [{ name: "Mr Counter One", email: "counter1@sample.example" }];

/** Moves the clock; a staff sign-in lasts hours, not weeks, so the team signs in again at the new time (the same cookie objects are refreshed). */
async function goTo(w: W, ms: number) {
  w.h.clock.now = ms;
  w.jar.vl = (await w.h.staff("organizer@sample.example")).vl;
  w.coJar.vl = (await w.h.staff("co@sample.example")).vl;
}
/** A meeting with a rule, an attendance session linked, three agenda items and the notice sent. */
async function noticed(w: W, o: { days?: number; pct?: number; startsAt?: string; link?: boolean; visibility?: string; type?: string; title?: string } = {}) {
  need(await rule(w, o.type ?? "annual", o.days ?? 21, o.pct ?? 50), 200);
  let aid: string | null = null;
  if (o.link !== false) aid = need(await w.h.call("POST", `/api/lists/${w.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: o.startsAt ?? "2026-12-05T18:00", place: "Club house", mode: "in_person" }, w.jar), 201).session.id;
  const m = need(await meeting(w, { startsAt: o.startsAt ?? "2026-12-05T18:00", type: o.type ?? "annual", title: o.title ?? "Annual General Meeting", visibility: o.visibility ?? "private", ...(aid ? { attendanceSessionId: aid } : {}) }), 201).meeting;
  const items: string[] = [];
  for (const it of [{ title: "Welcome and apologies", kind: "information", minutes: 5 }, { title: "Approve the budget", kind: "decision", minutes: 20, note: "Budget paper circulated with the notice." }, { title: "Elect the committee", kind: "decision", minutes: 30 }])
    items.push(need(await item(w, m.id, it), 201).agenda.at(-1).id);
  const n = need(await w.h.call("POST", `${w.base}/${m.id}/notice`, {}, w.jar), 201);
  return { mid: m.id as string, aid, items, notice: n.notice };
}
/** Names the officers, moves the clock to the start and opens the meeting. */
async function opened(w: W, m: { mid: string }, at = START) {
  need(await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { chair: CHAIR, secretary: SECRETARY }, w.jar), 200);
  await goTo(w, at);
  return need(await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.jar), 200);
}
const mark = (w: W, aid: string, voterId: string) => w.h.call("POST", `/api/lists/${w.sid}/attendance/sessions/${aid}/mark`, { voterId }, w.jar);
const present = async (w: W, aid: string, ...who: string[]) => { for (const x of who) need(await mark(w, aid, w.v[x]!), 200); };
const motion = (w: W, mid: string, itemId: string, o: Record<string, unknown> = {}) => w.h.call("POST", `${w.base}/${mid}/motions`, { itemId, text: "That the budget for the year is approved as circulated.", majority: "simple", moverVoterId: w.v.asha, seconderVoterId: w.v.bharat, ...o }, w.jar);
const result = (w: W, mid: string, xid: string, o: Record<string, unknown> = {}) => w.h.call("POST", `${w.base}/${mid}/motions/${xid}/result`, { method: "show_of_hands", for: 3, against: 1, abstain: 0, countedBy: COUNTER, ...o }, w.jar);
const count = (h: Harness, sql: string, ...a: unknown[]) => (h.raw.query(sql).get(...(a as any[])) as { n: number }).n;
const audits = (h: Harness, type?: string) => count(h, type ? "SELECT COUNT(*) AS n FROM audit_entries WHERE type = ?" : "SELECT COUNT(*) AS n FROM audit_entries", ...(type ? [type] : []));

describe("meeting rules", () => {
  test("only the Organizer sets the notice period and the quorum; wrong values are refused, not guessed", async () => {
    const w = await world(2);
    const before = (await w.h.call("GET", `${w.base}/rules`, undefined, w.coJar)).json.rules;
    expect(before.map((r: any) => [r.type, r.set])).toEqual([["annual", false], ["special", false], ["committee", false], ["emergency", false]]);
    expect((await rule(w)).status).toBe(200);
    expect((await w.h.call("PUT", `${w.base}/rules/annual`, { noticeDays: 21, quorumPercent: 50 }, w.coJar)).status).toBe(403);
    for (const bad of [{ noticeDays: -1 }, { noticeDays: 366 }, { noticeDays: "21" }, { noticeDays: 2.5 }, { quorumPercent: 101 }, { quorumPercent: -5 }, { quorumPercent: "50" }, { clause: "Call 9876543210" }, { adjournClause: "x" }])
      expect((await rule(w, "annual", 21, 50, bad as any)).status, JSON.stringify(bad)).toBe(400);
    expect((await rule(w, "yearly")).status).toBe(400);
    const r = (await w.h.call("GET", `${w.base}/rules`, undefined, w.jar)).json.rules;
    expect(r[0]).toMatchObject({ type: "annual", set: true, noticeDays: 21, quorumPercent: 50, clause: "Bye-law 12" });
    expect((await rule(w, "annual", 7, 0)).json.rule).toMatchObject({ noticeDays: 7, quorumPercent: 0, quorumText: "The bye-laws need no quorum for this kind of meeting." });
    expect(audits(w.h, "meeting.rules_set")).toBe(2);
  });
});

describe("a meeting and its agenda", () => {
  test("create, number, list and read; bad input and other roles are refused", async () => {
    const w = await world(2);
    expect((await w.h.call("POST", w.base, { title: "x", type: "annual", startsAt: "2026-12-05T18:00", mode: "online" }, w.jar)).status).toBe(400);
    for (const bad of [{ type: "weekly" }, { mode: "mixed" }, { startsAt: "soon" }, { title: "Call 9876543210" }, { visibility: "world" }]) expect((await meeting(w, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await meeting(w, {})).status).toBe(201);
    expect((await w.h.call("POST", w.base, { title: "Annual General Meeting", type: "annual", startsAt: "2026-12-05T18:00", mode: "online" }, w.coJar)).status).toBe(403);
    const two = need(await meeting(w, { title: "Special meeting on repairs", type: "special" }), 201).meeting;
    expect(two).toMatchObject({ number: 2, status: "draft", visibility: "private", typeText: "Special meeting", startsAt: "2026-12-05T18:00", timeZone: "UTC+05:30" });
    const list = (await w.h.call("GET", w.base, undefined, w.coJar)).json.meetings;
    expect(list.map((x: any) => x.number).sort()).toEqual([1, 2]);
    expect((await w.h.call("GET", `${w.base}/${two.id}`, undefined, w.coJar)).json.meeting.title).toBe("Special meeting on repairs");
    expect((await w.h.call("GET", `${w.base}/nope`, undefined, w.jar)).status).toBe(404);
  });

  test("two people creating meetings at the same moment get different numbers", async () => {
    const w = await world(1);
    const rs = await Promise.all([meeting(w, { title: "Meeting one" }), meeting(w, { title: "Meeting two" }), meeting(w, { title: "Meeting three" })]);
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(rs.map((r) => r.json.meeting.number).sort()).toEqual([1, 2, 3]);
  });

  test("an attendance session of another list cannot be linked (a stranger's id answers not found)", async () => {
    const a = await world(1); const b = await newList(a.h, { email: "other@sample.example" }); // a second list in the same database
    const other = need(await a.h.call("POST", `/api/lists/${b.sid}/attendance/sessions`, { title: "Other", startsAt: "2026-12-05T18:00", mode: "online" }, b.jar), 201).session.id;
    const own = need(await a.h.call("POST", `/api/lists/${a.sid}/attendance/sessions`, { title: "Own session", startsAt: "2026-12-05T18:00", mode: "online" }, a.jar), 201).session.id;
    expect(own).not.toBe(other);
    const r = await meeting(a, { attendanceSessionId: other }); // the other list's session id, tried on this list, is not found
    expect(r.status).toBe(404); expect(r.json.code).toBe("no_session");
    expect((await meeting(a, { attendanceSessionId: own })).json.meeting.attendanceSessionId).toBe(own);
  });

  test("agenda items: for information or for decision, numbered, changeable only until the notice", async () => {
    const w = await world(2); const mid = need(await meeting(w), 201).meeting.id;
    for (const bad of [{ title: "x", kind: "decision" }, { title: "Approve the budget", kind: "maybe" }, { title: "Approve the budget" }, { title: "Approve the budget", kind: "decision", minutes: 0 }, { title: "Approve the budget", kind: "decision", minutes: "5" }, { title: "Call 9876543210 now", kind: "decision" }])
      expect((await item(w, mid, bad)).status, JSON.stringify(bad)).toBe(400);
    const a = need(await item(w, mid, { title: "Welcome", kind: "information", minutes: 5 }), 201).agenda;
    const b = need(await item(w, mid, { title: "Approve the budget", kind: "decision", note: "Paper attached." }), 201).agenda;
    expect(b.map((x: any) => [x.n, x.title, x.kind])).toEqual([[1, "Welcome", "information"], [2, "Approve the budget", "decision"]]);
    expect(b[1].kindText).toBe("For decision");
    const edited = need(await w.h.call("PATCH", `${w.base}/${mid}/agenda/${a[0].id}`, { title: "Welcome and apologies", minutes: 10 }, w.jar), 200).agenda;
    expect(edited[0]).toMatchObject({ title: "Welcome and apologies", minutes: 10 });
    expect((await w.h.call("PATCH", `${w.base}/${mid}/agenda/${a[0].id}`, {}, w.jar)).status).toBe(400);
    expect((await w.h.call("PATCH", `${w.base}/${mid}/agenda/${a[0].id}`, { title: "Edit" }, w.coJar)).status).toBe(403);
    const left = need(await w.h.call("DELETE", `${w.base}/${mid}/agenda/${a[0].id}`, undefined, w.jar), 200).agenda;
    expect(left.map((x: any) => [x.n, x.title])).toEqual([[1, "Approve the budget"]]); // numbers follow the list, not the history
    expect((await w.h.call("DELETE", `${w.base}/${mid}/agenda/${a[0].id}`, undefined, w.jar)).status).toBe(404);
  });

  test("an agenda holds up to 100 items", async () => {
    const w = await world(1); const mid = need(await meeting(w), 201).meeting.id;
    for (let i = 0; i < 99; i++) w.h.raw.query("INSERT INTO mtg_items (id, society_id, meeting_id, position, title, note, kind, minutes, created_by, created_at) VALUES (?, ?, ?, ?, ?, '', 'information', NULL, 'p', 1)").run(`itm_x${i}`, w.sid, mid, i + 1, `Item ${i + 1}`);
    expect((await item(w, mid, { title: "The hundredth", kind: "information" })).status).toBe(201);
    const r = await item(w, mid, { title: "One too many", kind: "information" }); expect(r.status).toBe(409); expect(r.json.code).toBe("too_many");
  });
});

describe("the notice", () => {
  test("no notice without the rule of its kind, without an agenda, or with nobody on the list", async () => {
    const w = await world(2); const mid = need(await meeting(w), 201).meeting.id;
    let r = await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar); expect(r.status).toBe(409); expect(r.json.code).toBe("no_rule");
    await rule(w);
    r = await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar); expect(r.status).toBe(400); expect(r.json.code).toBe("no_agenda");
    expect((await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.coJar)).status).toBe(403);
    const e = await world(0); await rule(e);
    const m2 = need(await meeting(e), 201).meeting.id; need(await item(e, m2, { title: "Welcome", kind: "information" }), 201);
    r = await e.h.call("POST", `${e.base}/${m2}/notice`, {}, e.jar); expect(r.status).toBe(409); expect(r.json.code).toBe("no_recipients");
    expect(count(w.h, "SELECT COUNT(*) AS n FROM mtg_notices")).toBe(0);
  });

  test("a notice shorter than the bye-laws allow is refused and nothing is written (CP-247)", async () => {
    const w = await world(2); await rule(w, "annual", 30);
    const mid = need(await meeting(w), 201).meeting.id; need(await item(w, mid, { title: "Welcome", kind: "information" }), 201);
    const trail = audits(w.h);
    const r = await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar);
    expect(r.status).toBe(409); expect(r.json.code).toBe("short_notice");
    expect(r.json.error).toContain("30 days"); expect(r.json.error).toContain("2026-12-11 11:30"); expect(r.json.error).toContain("UTC+05:30");
    expect(count(w.h, "SELECT COUNT(*) AS n FROM mtg_notices")).toBe(0);
    expect(w.h.raw.query("SELECT status, notice_version FROM mtg_meetings WHERE id = ?").get(mid)).toEqual({ status: "draft", notice_version: 0 });
    expect(audits(w.h)).toBe(trail);
  });

  test("the notice period counts whole days from the moment of sending: exactly on the line is allowed, a minute short is not", async () => {
    for (const [days, status] of [[24, 201], [25, 409]] as const) {
      const w = await world(2); await rule(w, "annual", days);
      const mid = need(await meeting(w), 201).meeting.id; need(await item(w, mid, { title: "Welcome", kind: "information" }), 201);
      await goTo(w, START - 24 * 86_400_000); // exactly 24 days before the start
      expect((await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar)).status, `${days} days`).toBe(status);
    }
    const w = await world(2); await rule(w, "annual", 24);
    const mid = need(await meeting(w), 201).meeting.id; need(await item(w, mid, { title: "Welcome", kind: "information" }), 201);
    await goTo(w, START - 24 * 86_400_000 + 60_000); // one minute short of 24 days
    expect((await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar)).json.code).toBe("short_notice");
  });

  test("each kind of meeting has its own period: an emergency meeting can have a short one", async () => {
    const w = await world(2); await rule(w, "annual", 30); await rule(w, "emergency", 1);
    const a = need(await meeting(w), 201).meeting.id, e = need(await meeting(w, { type: "emergency", title: "Emergency meeting" }), 201).meeting.id;
    for (const id of [a, e]) need(await item(w, id, { title: "Welcome", kind: "information" }), 201);
    expect((await w.h.call("POST", `${w.base}/${a}/notice`, {}, w.jar)).json.code).toBe("short_notice");
    expect((await w.h.call("POST", `${w.base}/${e}/notice`, {}, w.jar)).status).toBe(201);
  });

  test("the notice carries the agenda exactly as sent, with a fingerprint anyone can recompute, and fixes the agenda in the database too", async () => {
    const w = await world(3); const m = await noticed(w);
    const n = m.notice;
    expect(n).toMatchObject({ version: 1, kind: "notice", requiredDays: 21, clause: "Bye-law 12", recipients: 3 });
    expect(n.agenda.map((x: any) => [x.n, x.title, x.kind, x.minutes])).toEqual([[1, "Welcome and apologies", "information", 5], [2, "Approve the budget", "decision", 20], [3, "Elect the committee", "decision", 30]]);
    const row = w.h.raw.query("SELECT snapshot_json, fingerprint FROM mtg_notices WHERE meeting_id = ?").get(m.mid) as { snapshot_json: string; fingerprint: string };
    expect(row.fingerprint).toBe(await sha256Hex(canonical(JSON.parse(row.snapshot_json))));
    expect(row.fingerprint).toBe(n.fingerprint);
    const entry = JSON.parse((w.h.raw.query("SELECT entry_json FROM audit_entries WHERE type = 'meeting.notice_issued'").get() as { entry_json: string }).entry_json);
    expect(entry.payload).toMatchObject({ meeting: m.mid, version: 1, fingerprint: n.fingerprint, requiredDays: 21, recipients: 3, items: 3 });
    // the agenda is fixed: the API refuses, and so does the database
    const r = await item(w, m.mid, { title: "A late item", kind: "decision" }); expect(r.status).toBe(409); expect(r.json.code).toBe("fixed");
    expect((await w.h.call("PATCH", `${w.base}/${m.mid}/agenda/${m.items[0]}`, { title: "Changed" }, w.jar)).status).toBe(409);
    expect((await w.h.call("DELETE", `${w.base}/${m.mid}/agenda/${m.items[0]}`, undefined, w.jar)).status).toBe(409);
    expect((await w.h.call("PATCH", `${w.base}/${m.mid}`, { title: "A new title" }, w.jar)).json.code).toBe("fixed");
    expect((await w.h.call("PATCH", `${w.base}/${m.mid}`, { startsAt: "2026-12-06T18:00" }, w.jar)).json.code).toBe("fixed");
    expect(() => w.h.raw.query("INSERT INTO mtg_items (id, society_id, meeting_id, position, title, kind, created_by, created_at) VALUES ('x', ?, ?, 9, 'Sneaked in', 'decision', 'p', 1)").run(w.sid, m.mid)).toThrow(/immutable/);
    expect(() => w.h.raw.query("UPDATE mtg_items SET title = 'Changed' WHERE meeting_id = ?").run(m.mid)).toThrow(/immutable/);
    expect(() => w.h.raw.query("DELETE FROM mtg_items WHERE meeting_id = ?").run(m.mid)).toThrow(/immutable/);
    expect(() => w.h.raw.query("UPDATE mtg_notices SET fingerprint = 'x'").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("DELETE FROM mtg_notices").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("UPDATE mtg_meetings SET place = 'Somewhere else' WHERE id = ?").run(m.mid)).toThrow(/immutable/); // a changed place needs a new notice version
    expect(() => w.h.raw.query("DELETE FROM mtg_meetings WHERE id = ?").run(m.mid)).toThrow(/append-only/);
    expect(count(w.h, "SELECT COUNT(*) AS n FROM mtg_items")).toBe(3);
    const again = await w.h.call("POST", `${w.base}/${m.mid}/notice`, {}, w.jar); expect(again.status).toBe(409); expect(again.json.code).toBe("already_noticed");
    expect((await w.h.call("GET", `/api/lists/${w.sid}/audit/verify`, undefined, w.jar)).json.ok).toBe(true);
  });

  test("two notices sent at the same moment: one goes, the other is told someone else did it", async () => {
    const w = await world(2); await rule(w);
    const mid = need(await meeting(w), 201).meeting.id; need(await item(w, mid, { title: "Welcome", kind: "information" }), 201);
    const rs = await Promise.all([w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar), w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(count(w.h, "SELECT COUNT(*) AS n FROM mtg_notices")).toBe(1);
  });

  test("withdrawing a notice opens the agenda again; the next notice is version 2 with another fingerprint, and the first stays on record", async () => {
    const w = await world(3); const m = await noticed(w);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/revise`, {}, w.jar)).status).toBe(400); // a reason is needed
    expect((await w.h.call("POST", `${w.base}/${m.mid}/revise`, { reason: "Add the audit report" }, w.coJar)).status).toBe(403);
    const r = need(await w.h.call("POST", `${w.base}/${m.mid}/revise`, { reason: "Add the audit report" }, w.jar), 200);
    expect(r.meeting.status).toBe("draft");
    need(await item(w, m.mid, { title: "Receive the audit report", kind: "decision" }), 201);
    const second = need(await w.h.call("POST", `${w.base}/${m.mid}/notice`, {}, w.jar), 201).notice;
    expect(second.version).toBe(2); expect(second.agenda.length).toBe(4); expect(second.fingerprint).not.toBe(m.notice.fingerprint);
    const shown = (await w.h.call("GET", `${w.base}/${m.mid}`, undefined, w.jar)).json;
    expect(shown.notices.map((x: any) => x.version)).toEqual([1, 2]);
    expect(shown.events.map((e: any) => [e.kind, e.text])).toEqual([["notice_withdrawn", "Add the audit report"]]);
    need(await w.h.call("POST", `${w.base}/${m.mid}/revise`, { reason: "Wrong room" }, w.jar), 200); // a second notice can be withdrawn as well
    expect((await w.h.call("POST", `${w.base}/${m.mid}/revise`, { reason: "Again" }, w.jar)).json.code).toBe("not_noticed"); // but not when none is out
  });

  test("postponing is a new notice: the new date must meet the notice period from now; cancelling after a notice is a notice with its reason", async () => {
    const w = await world(3); const m = await noticed(w, { days: 21 });
    expect((await w.h.call("POST", `${w.base}/${m.mid}/postpone`, { startsAt: "2026-12-12T18:00" }, w.jar)).status).toBe(400); // reason
    expect((await w.h.call("POST", `${w.base}/${m.mid}/postpone`, { startsAt: "2026-12-05T18:00", reason: "Hall not free" }, w.jar)).json.code).toBe("same_time");
    expect((await w.h.call("POST", `${w.base}/${m.mid}/postpone`, { startsAt: "2026-11-20T18:00", reason: "Hall not free" }, w.jar)).json.code).toBe("short_notice"); // 9 days from now, 21 needed
    const p = need(await w.h.call("POST", `${w.base}/${m.mid}/postpone`, { startsAt: "2026-12-12T18:00", place: "Community hall", reason: "Hall not free" }, w.jar), 201);
    expect(p.notice).toMatchObject({ version: 2, kind: "postponed", startsAt: "2026-12-12T18:00", reason: "Hall not free", requiredDays: 21 });
    expect(p.meeting).toMatchObject({ startsAt: "2026-12-12T18:00", place: "Community hall", status: "noticed", noticeVersion: 2 });
    expect(p.notice.fingerprint).not.toBe(m.notice.fingerprint);
    const c = need(await w.h.call("POST", `${w.base}/${m.mid}/cancel`, { reason: "No quorum is expected" }, w.jar), 200);
    expect(c.meeting.status).toBe("cancelled");
    const notices = (await w.h.call("GET", `${w.base}/${m.mid}`, undefined, w.jar)).json.notices;
    expect(notices.map((x: any) => [x.version, x.kind])).toEqual([[1, "notice"], [2, "postponed"], [3, "cancelled"]]);
    expect(notices[2].reason).toBe("No quorum is expected");
    expect((await w.h.call("POST", `${w.base}/${m.mid}/cancel`, { reason: "Again" }, w.jar)).json.code).toBe("cannot_cancel");
    // a draft is simply marked cancelled, and a meeting that has started cannot be cancelled
    const d = need(await meeting(w, { title: "A draft to drop" }), 201).meeting.id;
    expect(need(await w.h.call("POST", `${w.base}/${d}/cancel`, { reason: "Not needed" }, w.jar), 200).meeting.status).toBe("cancelled");
  });
});

describe("officers, opening and the run of the meeting", () => {
  test("a meeting opens only at its time, with a chair and a secretary named; the officers are set by the Organizer", async () => {
    const w = await world(3); const m = await noticed(w);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.jar)).json.code).toBe("too_early");
    await goTo(w, START - 1); expect((await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.jar)).json.code).toBe("too_early");
    await goTo(w, START); expect((await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.jar)).json.code).toBe("need_officers");
    expect((await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { chair: CHAIR }, w.coJar)).status).toBe(403);
    expect((await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { chair: { name: "A", email: "x" } }, w.jar)).status).toBe(400);
    expect((await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { chair: null }, w.jar)).status).toBe(400);
    expect((await w.h.call("PUT", `${w.base}/${m.mid}/roles`, {}, w.jar)).status).toBe(400);
    need(await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { chair: CHAIR }, w.jar), 200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.jar)).json.code).toBe("need_officers"); // the secretary is still missing
    need(await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { secretary: SECRETARY, timekeeper: { name: "Mr Timekeeper", email: "time@sample.example" } }, w.jar), 200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.coJar)).status).toBe(200); // a co-organizer may run the meeting
    expect((await w.h.call("POST", `${w.base}/${m.mid}/open`, {}, w.jar)).json.code).toBe("not_noticed");
    const shown = (await w.h.call("GET", `${w.base}/${m.mid}`, undefined, w.coJar)).json;
    expect(shown.meeting.status).toBe("open"); expect(shown.events[0].kind).toBe("opened");
    // an Organizer sees the officers' e-mail IDs; a co-organizer sees them masked
    const full = (await w.h.call("GET", `${w.base}/${m.mid}`, undefined, w.jar)).json.people.find((p: any) => p.role === "chair");
    expect(full.email).toBe("chair@sample.example");
    const masked = shown.people.find((p: any) => p.role === "chair");
    expect(masked.email).not.toBe("chair@sample.example"); expect(masked.name).not.toBe("Mr Chair Person");
    // a draft cannot be opened
    const d = need(await meeting(w, { title: "Another meeting" }), 201).meeting.id;
    expect((await w.h.call("POST", `${w.base}/${d}/open`, {}, w.jar)).json.code).toBe("not_noticed");
  });

  test("adjourn needs a reason, no decision is taken while adjourned, resume continues; points of order are logged with the time", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m);
    await present(w, m.aid!, "asha", "bharat");
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    expect((await w.h.call("POST", `${w.base}/${m.mid}/adjourn`, {}, w.jar)).status).toBe(400);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/points`, { text: "Please keep to the agenda." }, w.coJar)).status).toBe(201);
    w.h.clock.now += 5 * 60_000;
    need(await w.h.call("POST", `${w.base}/${m.mid}/adjourn`, { reason: "Tea break" }, w.jar), 200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/points`, { text: "Not now." }, w.jar)).json.code).toBe("not_open");
    expect((await result(w, m.mid, x.id)).json.code).toBe("not_open");
    expect((await motion(w, m.mid, m.items[2]!)).json.code).toBe("not_open");
    expect((await w.h.call("POST", `${w.base}/${m.mid}/resume`, {}, w.jar)).status).toBe(200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/resume`, {}, w.jar)).json.code).toBe("not_adjourned");
    const ev = (await w.h.call("GET", `${w.base}/${m.mid}`, undefined, w.jar)).json.events;
    expect(ev.map((e: any) => e.kind)).toEqual(["opened", "point_of_order", "adjourned", "resumed"]);
    expect(ev[2].at - ev[1].at).toBe(5 * 60_000); expect(ev[2].text).toBe("Tea break");
    expect(() => w.h.raw.query("UPDATE mtg_events SET text = 'x'").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("DELETE FROM mtg_events").run()).toThrow(/append-only/);
  });

  test("closing needs every motion decided or withdrawn; a closed meeting is fixed", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m);
    await present(w, m.aid!, "asha", "bharat", "chitra");
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    expect((await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.coJar)).status).toBe(403); // closing is the Organizer's
    const r = await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar); expect(r.status).toBe(409);
    expect(r.json.error).toContain("no result yet");
    need(await w.h.call("POST", `${w.base}/${m.mid}/motions/${x.id}/withdraw`, { reason: "Moved to the next meeting" }, w.jar), 200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar)).status).toBe(200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar)).json.code).toBe("not_running");
    expect((await w.h.call("POST", `${w.base}/${m.mid}/adjourn`, { reason: "Late" }, w.jar)).json.code).toBe("not_open");
    expect((await w.h.call("PUT", `${w.base}/${m.mid}/roles`, { chair: CHAIR }, w.jar)).json.code).toBe("closed");
    expect((await w.h.call("POST", `${w.base}/${m.mid}/cancel`, { reason: "Oops" }, w.jar)).json.code).toBe("cannot_cancel");
    expect((await w.h.call("PATCH", `${w.base}/${m.mid}`, { attendanceSessionId: null }, w.jar)).json.code).toBe("closed");
    expect(() => w.h.raw.query("UPDATE mtg_meetings SET title = 'Another title' WHERE id = ?").run(m.mid)).toThrow(/immutable/);
  });
});

describe("quorum (CP-212, CP-213, CP-248)", () => {
  test("the quorum is the percent of the people who may attend, rounded up, read from Attendance only through its public counts", async () => {
    for (const [pct, required] of [[50, 2], [51, 3], [100, 4], [1, 1], [25, 1], [26, 2]] as const) {
      const w = await world(4); const m = await noticed(w, { pct });
      const q = (await w.h.call("GET", `${w.base}/${m.mid}/quorum`, undefined, w.coJar)).json;
      expect(q.quorum, `${pct}%`).toMatchObject({ ruleSet: true, percent: pct, linked: true, eligible: 4, present: 0, required, met: false });
      expect(q.next.options.map((o: any) => o.action)).toEqual(["adjourn", "hold_again"]);
      expect(q.next.options[1].text).toContain("Meet again after seven days, at the same time and place.");
      await present(w, m.aid!, "asha", "bharat");
      expect((await w.h.call("GET", `${w.base}/${m.mid}/quorum`, undefined, w.jar)).json.quorum.met, `${pct}%`).toBe(2 >= required);
    }
    const w = await world(4); const m = await noticed(w, { pct: 0 });
    const q = (await w.h.call("GET", `${w.base}/${m.mid}/quorum`, undefined, w.jar)).json.quorum;
    expect(q).toMatchObject({ percent: 0, required: 0, met: true }); expect(q.words).toContain("need no quorum");
  });

  test("no quorum, no decision: the result is refused with the way forward, and nothing is written (CP-248)", async () => {
    const w = await world(4); const m = await noticed(w, { pct: 50 }); await opened(w, m);
    await present(w, m.aid!, "asha"); // 1 of 4 is present, 2 are needed
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    const trail = audits(w.h);
    const r = await result(w, m.mid, x.id, { for: 1, against: 0 });
    expect(r.status).toBe(409); expect(r.json.code).toBe("no_quorum"); expect(r.json.error).toContain("quorum is not met"); expect(r.json.error).toContain("adjourned");
    expect(count(w.h, "SELECT COUNT(*) AS n FROM mtg_results")).toBe(0);
    expect(w.h.raw.query("SELECT status FROM mtg_motions WHERE id = ?").get(x.id)).toEqual({ status: "moved" });
    expect(audits(w.h)).toBe(trail);
    await present(w, m.aid!, "bharat"); // now 2 of 4
    const ok = need(await result(w, m.mid, x.id, { for: 2, against: 0 }), 201);
    expect(ok.motion.status).toBe("decided"); expect(ok.motion.result.quorum).toEqual({ eligible: 4, required: 2, present: 2 });
  });

  test("a quorum above zero cannot be checked without a linked attendance session, so no decision is taken", async () => {
    const w = await world(4); const m = await noticed(w, { pct: 50, link: false }); await opened(w, m);
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    const r = await result(w, m.mid, x.id, { for: 1, against: 0 });
    expect(r.status).toBe(409); expect(r.json.error).toContain("no attendance session is linked");
    // linking one later is allowed while the meeting runs
    const aid = need(await w.h.call("POST", `/api/lists/${w.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", mode: "in_person" }, w.jar), 201).session.id;
    need(await w.h.call("PATCH", `${w.base}/${m.mid}`, { attendanceSessionId: aid }, w.jar), 200);
    await present(w, aid, "asha", "bharat");
    expect((await result(w, m.mid, x.id, { for: 1, against: 0 })).status).toBe(201);
  });

  test("a rule of no quorum lets a decision be taken without an attendance session", async () => {
    const w = await world(4); const m = await noticed(w, { pct: 0, link: false }); await opened(w, m);
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    expect((await result(w, m.mid, x.id, { for: 3, against: 1 })).status).toBe(201);
  });
});

describe("motions and results (CP-214 to CP-219, CP-235, CP-236)", () => {
  test("a motion needs two different people on the list who may vote, an item marked for decision, and a stated majority", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m);
    const ok = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    expect(ok).toMatchObject({ n: 1, status: "moved", majority: "simple", majorityText: "More votes for than against" });
    expect((await motion(w, m.mid, m.items[0]!)).json.code).toBe("not_decision"); // an item for information
    expect((await motion(w, m.mid, "itm_nope")).status).toBe(404);
    expect((await motion(w, m.mid, m.items[1]!, { moverVoterId: w.v.asha, seconderVoterId: w.v.asha })).json.code).toBe("same_person");
    expect((await motion(w, m.mid, m.items[1]!, { moverVoterId: "nobody" })).status).toBe(404);
    expect((await motion(w, m.mid, m.items[1]!, { majority: "most" })).status).toBe(400);
    expect((await motion(w, m.mid, m.items[1]!, { majority: undefined })).status).toBe(400);
    expect((await motion(w, m.mid, m.items[1]!, { text: "x" })).status).toBe(400);
    expect((await motion(w, m.mid, m.items[1]!, { text: "Call 9876543210 to agree" })).status).toBe(400);
    w.h.raw.query("UPDATE voters SET can_vote = 0 WHERE id = ?").run(w.v.chitra!);
    expect((await motion(w, m.mid, m.items[1]!, { seconderVoterId: w.v.chitra })).json.code).toBe("not_voter");
    expect((await w.h.call("POST", `${w.base}/${m.mid}/motions`, { itemId: m.items[1], text: "That the budget is approved.", majority: "simple", moverVoterId: w.v.asha, seconderVoterId: w.v.bharat }, w.coJar)).status).toBe(201);
    const two = (await w.h.call("GET", `${w.base}/${m.mid}/decisions`, undefined, w.coJar)).json.motions;
    expect(two.map((x: any) => x.n)).toEqual([1, 2]);
    expect(two[0].mover.name).not.toBe("Asha Sample"); // masked for a co-organizer
    expect((await w.h.call("GET", `${w.base}/${m.mid}/decisions`, undefined, w.jar)).json.motions[0].mover.name).toBe("Asha Sample");
    expect(() => w.h.raw.query("INSERT INTO mtg_motions (id, society_id, meeting_id, item_id, number, text, mover_voter_id, seconder_voter_id, majority, created_by, created_at) VALUES ('z', ?, ?, ?, 9, 'Same two', 'a', 'a', 'simple', 'p', 1)").run(w.sid, m.mid, m.items[1]!)).toThrow(/CHECK constraint failed/); // the database refuses mover = seconder as well
  });

  test("motions can be moved only while the meeting is open", async () => {
    const w = await world(4); const m = await noticed(w);
    expect((await motion(w, m.mid, m.items[1]!)).json.code).toBe("not_open"); // noticed, not yet open
  });

  test("an amendment is a separate linked motion, one level deep, on the same item; the main motion waits for its amendments", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m); await present(w, m.aid!, "asha", "bharat", "chitra");
    const main = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    const am = need(await motion(w, m.mid, m.items[1]!, { text: "That the budget is approved with the repair fund raised.", amendsMotionId: main.id, moverVoterId: w.v.chitra, seconderVoterId: w.v.bharat }), 201).motion;
    expect(am.amends).toBe(main.n);
    expect((await motion(w, m.mid, m.items[1]!, { amendsMotionId: am.id })).json.code).toBe("one_level");
    expect((await motion(w, m.mid, m.items[2]!, { amendsMotionId: main.id })).json.code).toBe("amend_other");
    expect((await motion(w, m.mid, m.items[1]!, { amendsMotionId: "mot_nope" })).status).toBe(404);
    const early = await result(w, m.mid, main.id, { for: 2, against: 1 }); expect(early.status).toBe(409); expect(early.json.code).toBe("amendments_first");
    need(await result(w, m.mid, am.id, { for: 2, against: 1 }), 201);
    expect((await result(w, m.mid, main.id, { for: 2, against: 1 })).status).toBe(201);
    expect((await motion(w, m.mid, m.items[1]!, { amendsMotionId: main.id })).json.code).toBe("amend_done"); // the main motion is decided
  });

  test("withdrawing keeps the motion and its reason in view, takes pending amendments with it, and a motion can never be deleted or reworded", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m);
    const main = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    const am = need(await motion(w, m.mid, m.items[1]!, { amendsMotionId: main.id, text: "That the budget is approved with changes." }), 201).motion;
    expect((await w.h.call("POST", `${w.base}/${m.mid}/motions/${main.id}/withdraw`, {}, w.jar)).status).toBe(400);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/motions/${main.id}/withdraw`, { reason: "Needs the audit report first" }, w.jar)).status).toBe(200);
    expect((await w.h.call("POST", `${w.base}/${m.mid}/motions/${main.id}/withdraw`, { reason: "Again" }, w.jar)).json.code).toBe("motion_done");
    const d = (await w.h.call("GET", `${w.base}/${m.mid}/decisions`, undefined, w.jar)).json.motions;
    expect(d.map((x: any) => [x.n, x.status, x.withdrawnReason])).toEqual([[1, "withdrawn", "Needs the audit report first"], [2, "withdrawn", "The motion it amends was withdrawn."]]);
    expect(am.id).toBe(d[1].id);
    expect((await result(w, m.mid, main.id)).json.code).toBe("motion_done");
    expect(() => w.h.raw.query("DELETE FROM mtg_motions").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("UPDATE mtg_motions SET text = 'Reworded after the fact' WHERE id = ?").run(main.id)).toThrow(/immutable/);
    expect(() => w.h.raw.query("UPDATE mtg_motions SET status = 'moved' WHERE id = ?").run(main.id)).toThrow(/immutable/); // a withdrawn motion cannot be revived
    expect(audits(w.h, "motion.withdrawn")).toBe(1);
  });

  test("the majority rules: simple, two thirds and three quarters of those voting for or against, abstentions shown but not counted", () => {
    const cases: Array<[any, number, number, boolean]> = [
      ["simple", 5, 4, true], ["simple", 4, 4, false], ["simple", 1, 0, true], ["simple", 0, 0, false], ["simple", 0, 3, false],
      ["two_thirds", 2, 1, true], ["two_thirds", 3, 2, false], ["two_thirds", 4, 2, true], ["two_thirds", 7, 4, false], ["two_thirds", 1, 0, true], ["two_thirds", 0, 0, false],
      ["three_quarters", 3, 1, true], ["three_quarters", 5, 2, false], ["three_quarters", 6, 2, true], ["three_quarters", 2, 1, false], ["three_quarters", 9, 3, true],
    ];
    for (const [maj, f, a, want] of cases) expect(passes(maj, f, a), `${maj} ${f}-${a}`).toBe(want);
  });

  test("the result needs counts and a counter other than the chair; it is final; the quorum as it stood is kept with it", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m); await present(w, m.aid!, "asha", "bharat", "chitra");
    const x = need(await motion(w, m.mid, m.items[1]!, { majority: "two_thirds" }), 201).motion;
    for (const bad of [{ countedBy: [] }, { countedBy: undefined }, { countedBy: [{ name: "Mr Chair Person", email: "CHAIR@sample.example" }] }, { countedBy: [{ name: "No mail", email: "nope" }] }, { for: -1 }, { for: "3" }, { for: 1.5 }, { against: 2_000_000 }, { method: "shout" }, { for: undefined }])
      expect((await result(w, m.mid, x.id, bad as any)).status, JSON.stringify(bad)).toBe(400);
    expect((await result(w, m.mid, x.id, { for: 3, against: 1, abstain: 1 })).json.code).toBe("too_many_votes"); // 5 votes, 3 people present
    expect((await w.h.call("POST", `${w.base}/${m.mid}/motions/${x.id}/result`, { method: "show_of_hands", for: 2, against: 1, countedBy: COUNTER }, w.coJar)).status).toBe(201); // a co-organizer may record it
    const d = (await w.h.call("GET", `${w.base}/${m.mid}/decisions`, undefined, w.jar)).json.motions[0];
    expect(d).toMatchObject({ status: "decided" });
    expect(d.result).toMatchObject({ method: "show_of_hands", methodText: "Show of hands", for: 2, against: 1, abstain: 0, outcome: "passed", outcomeText: "Passed", quorum: { eligible: 4, required: 2, present: 3 } });
    expect(d.result.countedBy).toEqual([{ name: "Mr Counter One", email: "counter1@sample.example" }]);
    const masked = (await w.h.call("GET", `${w.base}/${m.mid}/decisions`, undefined, w.coJar)).json.motions[0].result.countedBy[0];
    expect(masked.email).not.toContain("counter1@sample.example"); expect(masked.name).not.toBe("Mr Counter One");
    expect((await result(w, m.mid, x.id)).json.code).toBe("motion_done");
    expect(() => w.h.raw.query("UPDATE mtg_results SET outcome = 'not_passed'").run()).toThrow(/append-only/);
    expect(() => w.h.raw.query("DELETE FROM mtg_results").run()).toThrow(/append-only/);
    // two thirds: 2 for and 1 against is exactly two thirds, so it passed; a failing count is recorded as not passed
    const y = need(await motion(w, m.mid, m.items[2]!, { majority: "two_thirds" }), 201).motion;
    expect(need(await result(w, m.mid, y.id, { for: 1, against: 2 }), 201).motion.result.outcome).toBe("not_passed");
  });

  test("two results for one motion at the same moment: one is recorded, the other is told it is decided", async () => {
    const w = await world(4); const m = await noticed(w); await opened(w, m); await present(w, m.aid!, "asha", "bharat", "chitra");
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    const rs = await Promise.all([result(w, m.mid, x.id, { for: 2, against: 0 }), result(w, m.mid, x.id, { for: 0, against: 2 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(count(w.h, "SELECT COUNT(*) AS n FROM mtg_results")).toBe(1);
  });

  test("a person with an interest is named on the motion and kept out of that vote", async () => {
    const w = await world(4); const m = await noticed(w, { pct: 50 }); await opened(w, m); await present(w, m.aid!, "asha", "bharat", "chitra", "dev");
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion;
    const dec = (b: any) => w.h.call("POST", `${w.base}/${m.mid}/motions/${x.id}/interests`, b, w.jar);
    expect((await dec({ voterId: "nobody" })).status).toBe(404);
    const r = need(await dec({ voterId: w.v.dev, note: "Contractor for the repair work" }), 201);
    expect(r.motion.interests).toEqual([{ name: "Dev Sample", note: "Contractor for the repair work", declaredAt: w.h.clock.now }]);
    const dup = await dec({ voterId: w.v.dev }); expect(dup.status).toBe(409); expect(dup.json.error).toContain("already declared");
    expect((await result(w, m.mid, x.id, { for: 3, against: 1 })).json.code).toBe("too_many_votes"); // four people are present, one of them kept out: three may vote
    expect((await result(w, m.mid, x.id, { for: 2, against: 1 })).status).toBe(201);
    expect(() => w.h.raw.query("DELETE FROM mtg_interests").run()).toThrow(/append-only/);
    expect((await dec({ voterId: w.v.asha })).json.code).toBe("motion_done"); // after the result nothing more is declared
  });
});

describe("minutes (CP-221 to CP-224)", () => {
  /** Meeting one is held and closed; meeting two, later, is noticed. */
  async function twoMeetings(w: W) {
    const m1 = await noticed(w, { pct: 50 }); await opened(w, m1); await present(w, m1.aid!, "asha", "bharat", "chitra");
    const x = need(await motion(w, m1.mid, m1.items[1]!), 201).motion; need(await result(w, m1.mid, x.id, { for: 3, against: 0 }), 201);
    need(await w.h.call("POST", `${w.base}/${m1.mid}/close`, {}, w.jar), 200);
    await goTo(w, Date.UTC(2026, 11, 6));
    const m2 = need(await meeting(w, { title: "Special meeting on repairs", type: "special", startsAt: "2026-12-20T18:00" }), 201).meeting.id;
    need(await rule(w, "special", 7, 0), 200);
    need(await item(w, m2, { title: "Approve the minutes", kind: "decision" }), 201);
    need(await w.h.call("POST", `${w.base}/${m2}/notice`, {}, w.jar), 201);
    return { m1: m1.mid, m2 };
  }
  const BODY = "Minutes of the Annual General Meeting.\n\nPresent: 3 members. The budget was approved by 3 votes to 0.\n\n\n\nThe meeting closed.";

  test("minutes are drafts until a later meeting approves them; an AI draft must first be accepted by a person", async () => {
    const w = await world(4); const { m1, m2 } = await twoMeetings(w);
    expect((await w.h.call("POST", `${w.base}/${m2}/minutes`, { body: BODY, source: "human" }, w.jar)).json.code).toBe("not_closed"); // not closed yet
    for (const bad of [{ body: "short", source: "human" }, { body: BODY }, { body: BODY, source: "robot" }, { body: "Please phone 9876543210 for the draft minutes.", source: "human" }])
      expect((await w.h.call("POST", `${w.base}/${m1}/minutes`, bad, w.jar)).status, JSON.stringify(bad)).toBe(400);
    const d = need(await w.h.call("POST", `${w.base}/${m1}/minutes`, { body: BODY, source: "ai" }, w.coJar), 201).minutes;
    expect(d).toMatchObject({ version: 1, source: "ai", status: "draft", sourceText: "Written by an AI helper", statusText: "Draft written by an AI helper, not yet accepted by a person" });
    expect(d.body).toBe("Minutes of the Annual General Meeting.\n\nPresent: 3 members. The budget was approved by 3 votes to 0.\n\nThe meeting closed."); // paragraphs kept, blank lines squeezed
    expect(d.fingerprint).toBe(await sha256Hex(canonical({ meeting: m1, version: 1, body: d.body, source: "ai" })));
    const approve = (id: string, b: any, jar: Jar = w.jar) => w.h.call("POST", `${w.base}/${m1}/minutes/${id}/approve`, b, jar);
    expect((await approve(d.id, { approvedInMeetingId: m2 })).json.code).toBe("need_accept");
    expect((await w.h.call("POST", `${w.base}/${m1}/minutes/${d.id}/accept`, {}, w.coJar)).status).toBe(200);
    expect((await w.h.call("POST", `${w.base}/${m1}/minutes/${d.id}/accept`, {}, w.jar)).json.code).toBe("already_accepted");
    // approved at a LATER meeting that has started: not the same meeting, not a meeting that has not started
    expect((await approve(d.id, { approvedInMeetingId: m1 })).json.code).toBe("need_later");
    expect((await approve(d.id, { approvedInMeetingId: m2 })).json.code).toBe("need_later"); // meeting two is only noticed
    expect((await approve(d.id, { approvedInMeetingId: "nope" })).status).toBe(404);
    expect((await approve(d.id, { approvedInMeetingId: m2 }, w.coJar)).status).toBe(403);
    await goTo(w, LATER);
    need(await w.h.call("PUT", `${w.base}/${m2}/roles`, { chair: CHAIR, secretary: SECRETARY }, w.jar), 200);
    need(await w.h.call("POST", `${w.base}/${m2}/open`, {}, w.jar), 200);
    const ok = need(await approve(d.id, { approvedInMeetingId: m2 }), 200).minutes;
    expect(ok).toMatchObject({ status: "approved", statusText: "Approved", approvedInMeetingId: m2 });
    expect((await approve(d.id, { approvedInMeetingId: m2 })).json.code).toBe("done");
    // approved minutes are frozen in the database
    expect(() => w.h.raw.query("UPDATE mtg_minutes SET body = 'Rewritten' WHERE id = ?").run(d.id)).toThrow(/immutable/);
    expect(() => w.h.raw.query("UPDATE mtg_minutes SET status = 'draft' WHERE id = ?").run(d.id)).toThrow(/immutable/);
    expect(() => w.h.raw.query("DELETE FROM mtg_minutes").run()).toThrow(/immutable/);
    expect(JSON.parse((w.h.raw.query("SELECT entry_json FROM audit_entries WHERE type = 'minutes.approved'").get() as any).entry_json).payload).toMatchObject({ meeting: m1, version: 1, inMeeting: m2, fingerprint: ok.fingerprint });
  });

  test("a correction is a new linked version with its reason; only the newest version can be approved; drafts are never altered", async () => {
    const w = await world(4); const { m1, m2 } = await twoMeetings(w);
    const v1 = need(await w.h.call("POST", `${w.base}/${m1}/minutes`, { body: BODY, source: "human" }, w.jar), 201).minutes;
    expect((await w.h.call("POST", `${w.base}/${m1}/minutes`, { body: BODY + " Added line.", source: "human" }, w.jar)).json.code).toBe("need_reason");
    const v2 = need(await w.h.call("POST", `${w.base}/${m1}/minutes`, { body: BODY + " The chair thanked all.", source: "human", reason: "The vote of thanks was left out" }, w.jar), 201).minutes;
    expect(v2).toMatchObject({ version: 2, supersedesId: v1.id, reason: "The vote of thanks was left out" });
    expect(v2.fingerprint).not.toBe(v1.fingerprint);
    await goTo(w, LATER); need(await w.h.call("PUT", `${w.base}/${m2}/roles`, { chair: CHAIR, secretary: SECRETARY }, w.jar), 200); need(await w.h.call("POST", `${w.base}/${m2}/open`, {}, w.jar), 200);
    expect((await w.h.call("POST", `${w.base}/${m1}/minutes/${v1.id}/approve`, { approvedInMeetingId: m2 }, w.jar)).json.code).toBe("not_latest");
    need(await w.h.call("POST", `${w.base}/${m1}/minutes/${v2.id}/approve`, { approvedInMeetingId: m2 }, w.jar), 200);
    // after approval, a correction is again a new version with a reason, and the approved text stays what it was
    const v3 = need(await w.h.call("POST", `${w.base}/${m1}/minutes`, { body: BODY + " The chair thanked all and the hall staff.", source: "human", reason: "A name was missing" }, w.jar), 201).minutes;
    const list = (await w.h.call("GET", `${w.base}/${m1}/minutes`, undefined, w.coJar)).json;
    expect(list.versions.map((x: any) => [x.version, x.status])).toEqual([[1, "draft"], [2, "approved"], [3, "draft"]]);
    expect(list.approved.version).toBe(2); expect(list.latest.id).toBe(v3.id);
    expect(list.versions[0].body).toBeUndefined(); // the list is light; the latest and the approved carry the text
  });
});

describe("action items", () => {
  test("an action has a task, an owner and a date; it is added once the meeting has started; the owner's address is private to the Organizer", async () => {
    const w = await world(4); const m = await noticed(w);
    const add = (b: any, jar: Jar = w.jar) => w.h.call("POST", `${w.base}/${m.mid}/actions`, { text: "Get three quotes for the roof repair", ownerName: "Mr Owner Person", ownerEmail: "owner@sample.example", dueDate: "2026-12-31", ...b }, jar);
    expect((await add({})).json.code).toBe("not_started");
    await opened(w, m);
    for (const bad of [{ text: "x" }, { dueDate: "2026-02-30" }, { dueDate: "31-12-2026" }, { dueDate: "" }, { ownerEmail: "nope" }, { ownerName: "" }, { motionId: "mot_nope" }, { text: "Phone 9876543210 tomorrow" }])
      expect((await add(bad)).status, JSON.stringify(bad)).toBe(bad.motionId ? 404 : 400);
    const r = need(await add({}, w.coJar), 201);
    expect(r.actions[0]).toMatchObject({ text: "Get three quotes for the roof repair", dueDate: "2026-12-31", status: "open", statusText: "Open" });
    expect(r.actions[0].owner.email).not.toBe("owner@sample.example"); // a co-organizer sees it masked
    const full = (await w.h.call("GET", `${w.base}/${m.mid}/actions`, undefined, w.jar)).json.actions[0];
    expect(full.owner).toEqual({ name: "Mr Owner Person", email: "owner@sample.example" });
    expect((await w.h.call("PATCH", `${w.base}/${m.mid}/actions/${full.id}`, { status: "finished" }, w.jar)).status).toBe(400);
    expect((await w.h.call("PATCH", `${w.base}/${m.mid}/actions/nope`, { status: "done" }, w.jar)).status).toBe(404);
    expect(need(await w.h.call("PATCH", `${w.base}/${m.mid}/actions/${full.id}`, { status: "done" }, w.coJar), 200).actions[0].statusText).toBe("Done");
    const e = JSON.parse((w.h.raw.query("SELECT entry_json FROM audit_entries WHERE type = 'action.added'").get() as any).entry_json).payload;
    expect(JSON.stringify(e)).not.toContain("owner@sample.example");
  });
});

describe("the end of the meeting: names, report and the public page", () => {
  async function held(w: W, visibility = "all") {
    const m = await noticed(w, { pct: 50, visibility }); await opened(w, m); await present(w, m.aid!, "asha", "bharat", "chitra");
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion; need(await result(w, m.mid, x.id, { for: 3, against: 0 }), 201);
    need(await w.h.call("POST", `${w.base}/${m.mid}/actions`, { text: "Pay the contractor", ownerName: "Mr Owner Person", ownerEmail: "owner@sample.example", dueDate: "2026-12-31" }, w.jar), 201);
    return { ...m, x };
  }

  test("observers, validated-by and supervised-by are named; the last two only after closing; names are added, never removed", async () => {
    const w = await world(4); const m = await held(w);
    const add = (b: any, jar: Jar = w.jar) => w.h.call("POST", `${w.base}/${m.mid}/people`, b, jar);
    need(await add({ role: "observer", name: "Ms Observer", email: "observer@sample.example" }), 201);
    const dup = await add({ role: "observer", name: "Ms Observer", email: "observer@sample.example" }); expect(dup.status).toBe(409); expect(dup.json.error).toContain("already named");
    expect((await add({ role: "validated_by", name: "Mr Validator", email: "validator@sample.example" })).json.code).toBe("not_closed");
    expect((await add({ role: "chair", name: "Mr Other", email: "other@sample.example" })).status).toBe(400);
    expect((await add({ role: "observer", name: "Ms Observer", email: "observer@sample.example" }, w.coJar)).status).toBe(403);
    need(await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar), 200);
    need(await add({ role: "validated_by", name: "Mr Validator", email: "validator@sample.example" }), 201);
    const people = need(await add({ role: "supervised_by", name: "Ms Supervisor", email: "supervisor@sample.example" }), 201).people;
    expect(people.map((p: any) => p.role).sort()).toEqual(["chair", "observer", "secretary", "supervised_by", "validated_by"]);
    expect(people.find((p: any) => p.role === "validated_by").roleText).toBe("Validated by");
  });

  test("the report holds everything with a fingerprint anyone can recompute; each copy is written to the signed log; a co-organizer's copy is masked", async () => {
    const w = await world(4); const m = await held(w);
    need(await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar), 200);
    need(await w.h.call("POST", `${w.base}/${m.mid}/people`, { role: "validated_by", name: "Mr Validator", email: "validator@sample.example" }, w.jar), 201);
    need(await w.h.call("POST", `${w.base}/${m.mid}/minutes`, { body: "Minutes of the meeting. The budget was approved.", source: "human" }, w.jar), 201);
    const r = need(await w.h.call("GET", `${w.base}/${m.mid}/report.json`, undefined, w.jar), 200);
    expect(r.fingerprint).toBe(await sha256Hex(canonical(r.report)));
    expect(r.report).toMatchObject({ final: true, list: "Sample Heights Residents Welfare Association" });
    expect(r.report.notices[0].fingerprint).toBe(m.notice.fingerprint);
    expect(r.report.motions[0].result).toMatchObject({ for: 3, against: 0, outcome: "passed", countedBy: [{ name: "Mr Counter One", email: "counter1@sample.example" }] });
    expect(r.report.people.map((p: any) => p.role)).toEqual(["chair", "secretary", "validated_by"]);
    expect(r.report.actions[0].owner.email).toBe("owner@sample.example");
    expect(r.report.minutes.versions.length).toBe(1); expect(r.report.trail.seq).toBeGreaterThan(10);
    expect(audits(w.h, "meeting.report_taken")).toBe(1);
    const co = need(await w.h.call("GET", `${w.base}/${m.mid}/report.json`, undefined, w.coJar), 200);
    expect(JSON.stringify(co.report)).not.toContain("counter1@sample.example"); expect(JSON.stringify(co.report)).not.toContain("owner@sample.example");
    expect(co.fingerprint).not.toBe(r.fingerprint); expect(audits(w.h, "meeting.report_taken")).toBe(2);
    expect((await w.h.call("GET", `/api/lists/${w.sid}/audit/verify`, undefined, w.jar)).json.ok).toBe(true);
  });

  test("the public page shows only what the Organizer chose, nothing personal, and stays out of search engines (CP-227)", async () => {
    const w = await world(4); const m = await held(w, "private");
    const pub = (p: string) => w.h.call("GET", `/api/v/${w.slug}/meetings${p}`);
    expect((await pub("")).json.meetings).toEqual([]); // private: not listed
    expect((await pub(`/${m.mid}`)).status).toBe(404);
    need(await w.h.call("PATCH", `${w.base}/${m.mid}`, { visibility: "notice" }, w.jar), 200);
    const list = await pub(""); expect(list.json.meetings.length).toBe(1); expect(list.json.meetings[0]).toMatchObject({ title: "Annual General Meeting", status: "open", statusText: "Open" });
    expect(list.headers.get("x-robots-tag")).toBe("noindex");
    const n = await pub(`/${m.mid}`); expect(n.status).toBe(200);
    expect(n.json.agenda.length).toBe(3); expect(n.json.notice).toMatchObject({ version: 1, requiredDays: 21 }); expect(n.json.decisions).toBeUndefined(); expect(n.json.minutes).toBeUndefined();
    expect(n.headers.get("x-robots-tag")).toBe("noindex");
    // the whole meeting: decisions and approved minutes, still with no name, e-mail ID, flat or id of a person
    need(await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar), 200);
    need(await w.h.call("PATCH", `${w.base}/${m.mid}`, { visibility: "all" }, w.jar), 200);
    const all = (await pub(`/${m.mid}`)).json;
    expect(all.decisions).toHaveLength(1);
    expect(all.decisions[0]).toMatchObject({ n: 1, itemTitle: "Approve the budget", status: "decided", result: { for: 3, against: 0, outcomeText: "Passed", quorum: { eligible: 4, required: 2, present: 3 } } });
    expect(all.minutes).toBeNull();
    const text = JSON.stringify([all, list.json, n.json]);
    for (const secret of ["sample.example", "Asha", "Bharat", "Chitra", "A-1", "Mr Counter", "Chair Person", "Owner Person", w.v.asha, w.v.bharat, "9000000400", "9000000401", "9000000402", "9000000403"]) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain(w.sid); // nor the id of the list
    expect((await w.h.call("GET", `/api/v/0000000000000000/meetings`)).status).toBe(404);
  });

  test("a meeting with no notice out is not public, and a withdrawn notice takes the meeting off the public page", async () => {
    const w = await world(3); need(await rule(w), 200);
    const mid = need(await meeting(w, { visibility: "all" }), 201).meeting.id; need(await item(w, mid, { title: "Welcome", kind: "information" }), 201);
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings`)).json.meetings).toEqual([]);
    need(await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar), 201);
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings`)).json.meetings.length).toBe(1);
    need(await w.h.call("POST", `${w.base}/${mid}/revise`, { reason: "Wrong time" }, w.jar), 200);
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings`)).json.meetings).toEqual([]);
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings/${mid}`)).status).toBe(404);
  });

  test("the calendar file is a valid event with the notice's time, escaped and folded; cancelled meetings say so", async () => {
    const w = await world(3); need(await rule(w), 200);
    const title = "Annual General Meeting, budget; elections, repair fund; and the accounts for 2026".slice(0, 80);
    const mid = need(await meeting(w, { title, visibility: "notice", place: "Club house, Block A" }), 201).meeting.id;
    need(await item(w, mid, { title: "Welcome", kind: "information", minutes: 10 }), 201); need(await item(w, mid, { title: "Budget", kind: "decision", minutes: 20 }), 201);
    need(await w.h.call("POST", `${w.base}/${mid}/notice`, {}, w.jar), 201);
    const r = await w.h.call("GET", `/api/v/${w.slug}/meetings/${mid}/calendar.ics`);
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toContain("text/calendar");
    const lines = r.text.split("\r\n"); expect(lines.at(-1)).toBe("");
    expect(lines.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const flat = r.text.replace(/\r\n /g, "");
    expect(flat).toContain("BEGIN:VCALENDAR\r\nVERSION:2.0"); expect(flat).toContain(`UID:${mid}@townhall-records.com`);
    expect(flat).toContain("DTSTART:20261205T123000Z"); expect(flat).toContain("DTEND:20261205T130000Z"); // 18:00 India time, 30 minutes of agenda
    expect(flat).toContain("SUMMARY:Annual General Meeting\\, budget\\; elections\\, repair fund\\;"); expect(flat).toContain("LOCATION:Club house\\, Block A");
    expect(flat).toContain("STATUS:CONFIRMED"); expect(flat).toContain("SEQUENCE:1"); expect(flat).toContain("2. Budget (for decision)");
    expect((await w.h.call("GET", `${w.base}/${mid}/calendar.ics`, undefined, w.coJar)).status).toBe(200);
    need(await w.h.call("POST", `${w.base}/${mid}/cancel`, { reason: "Not needed" }, w.jar), 200);
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings/${mid}/calendar.ics`)).text).toContain("STATUS:CANCELLED");
    const priv = need(await meeting(w, { title: "A private one" }), 201).meeting.id;
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings/${priv}/calendar.ics`)).status).toBe(404);
  });
});

describe("the whole story (CP-246) and the trail", () => {
  test("create, send the notice, hold with a quorum, pass a motion, approve the minutes at the next meeting, read it all through the API; the signed log verifies and holds no personal data", async () => {
    const w = await world(4); const { jar } = w;
    need(await rule(w, "annual", 21, 50), 200);
    const aid = need(await w.h.call("POST", `/api/lists/${w.sid}/attendance/sessions`, { title: "Annual meeting", startsAt: "2026-12-05T18:00", mode: "in_person" }, jar), 201).session.id;
    const mid = need(await meeting(w, { visibility: "all", attendanceSessionId: aid }), 201).meeting.id;
    const budget = need(await item(w, mid, { title: "Approve the budget", kind: "decision", minutes: 20 }), 201).agenda[0].id;
    expect(need(await w.h.call("POST", `${w.base}/${mid}/notice`, {}, jar), 201).notice.recipients).toBe(4);
    need(await w.h.call("PUT", `${w.base}/${mid}/roles`, { chair: CHAIR, secretary: SECRETARY }, jar), 200);
    await goTo(w, START); need(await w.h.call("POST", `${w.base}/${mid}/open`, {}, jar), 200);
    await present(w, aid, "asha", "bharat", "chitra");
    const x = need(await motion(w, mid, budget), 201).motion;
    expect(need(await result(w, mid, x.id, { for: 3, against: 0 }), 201).motion.result.outcome).toBe("passed");
    need(await w.h.call("POST", `${w.base}/${mid}/close`, {}, jar), 200);
    const min = need(await w.h.call("POST", `${w.base}/${mid}/minutes`, { body: "The budget was approved by 3 votes to 0.", source: "human" }, jar), 201).minutes;
    need(await rule(w, "special", 7, 0), 200); await goTo(w, Date.UTC(2026, 11, 6));
    const next = need(await meeting(w, { title: "Next meeting", type: "special", startsAt: "2026-12-20T18:00" }), 201).meeting.id;
    need(await item(w, next, { title: "Approve the minutes", kind: "decision" }), 201); need(await w.h.call("POST", `${w.base}/${next}/notice`, {}, jar), 201);
    await goTo(w, LATER); need(await w.h.call("PUT", `${w.base}/${next}/roles`, { chair: CHAIR, secretary: SECRETARY }, jar), 200); need(await w.h.call("POST", `${w.base}/${next}/open`, {}, jar), 200);
    need(await w.h.call("POST", `${w.base}/${mid}/minutes/${min.id}/approve`, { approvedInMeetingId: next }, jar), 200);
    // read it all back through the API
    expect((await w.h.call("GET", `${w.base}/${mid}/decisions`, undefined, jar)).json.motions[0].result.outcome).toBe("passed");
    expect((await w.h.call("GET", `${w.base}/${mid}/minutes`, undefined, jar)).json.approved).toMatchObject({ version: 1, status: "approved" });
    const pub = (await w.h.call("GET", `/api/v/${w.slug}/meetings/${mid}`)).json;
    expect(pub.minutes).toMatchObject({ version: 1, body: "The budget was approved by 3 votes to 0.", fingerprint: min.fingerprint });
    expect(pub.decisions[0].result.outcomeText).toBe("Passed");
    // the signed log
    expect((await w.h.call("GET", `/api/lists/${w.sid}/audit/verify`, undefined, jar)).json.ok).toBe(true);
    const all = (w.h.raw.query("SELECT type, entry_json FROM audit_entries").all() as { type: string; entry_json: string }[]);
    const mine = all.filter((e) => /^(meeting|motion|minutes|action)\./.test(e.type));
    expect(mine.map((e) => e.type)).toEqual(expect.arrayContaining(["meeting.rules_set", "meeting.created", "meeting.item_added", "meeting.notice_issued", "meeting.roles_set", "meeting.opened", "motion.moved", "motion.decided", "meeting.closed", "minutes.drafted", "minutes.approved"]));
    for (const e of mine) for (const secret of ["sample.example", "9000000400", "9000000401", "9000000402", "Asha", "Counter One", "Chair Person"]) expect(e.entry_json, `${e.type} ${secret}`).not.toContain(secret);
    expect(JSON.parse(all.find((e) => e.type === "motion.decided")!.entry_json).payload).toMatchObject({ for: 3, against: 0, outcome: "passed", quorum: { eligible: 4, required: 2, present: 3 }, counters: 1 });
  });
});

describe("access, boundaries and erasure", () => {
  test("nobody signed out, and no stranger, reaches any meeting address; the team's roles are as stated", async () => {
    const w = await world(2); const m = await noticed(w); const outsider = await w.h.staff("stranger@sample.example");
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/rules"], ["PUT", "/rules/annual", { noticeDays: 1, quorumPercent: 1 }], ["POST", "", {}], ["GET", ""], ["GET", `/${m.mid}`], ["PATCH", `/${m.mid}`, { visibility: "all" }], ["PUT", `/${m.mid}/roles`, { chair: CHAIR }],
      ["POST", `/${m.mid}/people`, {}], ["POST", `/${m.mid}/agenda`, {}], ["POST", `/${m.mid}/notice`, {}], ["POST", `/${m.mid}/revise`, {}], ["POST", `/${m.mid}/postpone`, {}], ["POST", `/${m.mid}/cancel`, {}],
      ["POST", `/${m.mid}/open`, {}], ["POST", `/${m.mid}/adjourn`, {}], ["POST", `/${m.mid}/resume`, {}], ["POST", `/${m.mid}/close`, {}], ["POST", `/${m.mid}/points`, {}], ["GET", `/${m.mid}/quorum`], ["GET", `/${m.mid}/decisions`],
      ["POST", `/${m.mid}/motions`, {}], ["GET", `/${m.mid}/minutes`], ["POST", `/${m.mid}/minutes`, {}], ["GET", `/${m.mid}/actions`], ["POST", `/${m.mid}/actions`, {}], ["GET", `/${m.mid}/report.json`], ["GET", `/${m.mid}/calendar.ics`],
    ];
    for (const [method, path, body] of routes) {
      expect((await w.h.call(method, w.base + path, body)).status, `signed out ${method} ${path}`).toBe(401);
      // a signed-in Organizer of another list gets "not found" on this list, never a hint that it exists
      const stranger = await w.h.call(method, w.base + path, body, outsider);
      expect(stranger.status, `stranger ${method} ${path}`).toBe(404);
    }
    // the co-organizer: refused on every setup address, allowed on the run addresses
    for (const [method, path, body] of [["PUT", "/rules/annual", { noticeDays: 1, quorumPercent: 1 }], ["POST", "", {}], ["PATCH", `/${m.mid}`, { visibility: "all" }], ["PUT", `/${m.mid}/roles`, { chair: CHAIR }], ["POST", `/${m.mid}/agenda`, {}], ["POST", `/${m.mid}/notice`, {}], ["POST", `/${m.mid}/revise`, {}], ["POST", `/${m.mid}/postpone`, {}], ["POST", `/${m.mid}/cancel`, {}], ["POST", `/${m.mid}/close`, {}]] as const)
      expect((await w.h.call(method, w.base + path, body, w.coJar)).status, `co-organizer ${method} ${path}`).toBe(403);
    for (const path of ["/rules", "", `/${m.mid}`, `/${m.mid}/quorum`, `/${m.mid}/decisions`, `/${m.mid}/minutes`, `/${m.mid}/actions`, `/${m.mid}/report.json`, `/${m.mid}/calendar.ics`])
      expect((await w.h.call("GET", w.base + path, undefined, w.coJar)).status, `co-organizer GET ${path}`).toBe(200);
  });

  test("Meetings is dark: without MEETINGS_ENABLED set to 1 every Meetings address answers not found, signed in or not, and nothing is written", async () => {
    const table = routeTable().filter((r) => /meetings/.test(r.re.source));
    expect(table.length, "the Meetings addresses are in the route table").toBeGreaterThan(30);
    const concrete = (re: RegExp) => re.source.replace(/\\\//g, "/").replace(/^\^|\$$/g, "").replace(/\(\[\^\\?\/\]\+\)/g, "x").replace(/\\\./g, ".");
    for (const flag of [undefined, "0", "", "true", "yes", " 1", "11"]) {
      const h = await makeHarness(flag === undefined ? {} : { MEETINGS_ENABLED: flag }); const { jar, sid, slug } = await newList(h);
      const unknown = await h.call("GET", `/api/lists/${sid}/nothing-here`, undefined, jar); expect(unknown.status).toBe(404);
      const auditBefore = audits(h);
      for (const r of table) {
        const path = concrete(r.re).replace("/api/lists/x/", `/api/lists/${sid}/`).replace("/api/v/x/", `/api/v/${slug}/`);
        for (const who of [undefined, jar]) {
          const got = await h.call(r.method, path, r.method === "GET" || r.method === "DELETE" ? undefined : {}, who);
          expect(got.status, `${r.method} ${path} flag=${JSON.stringify(flag)} signedIn=${!!who}`).toBe(404);
          expect(got.json, `${r.method} ${path}`).toEqual(unknown.json); // the same answer as an address that does not exist
        }
      }
      for (const t of ["mtg_meetings", "mtg_rules", "mtg_items", "mtg_notices", "mtg_people", "mtg_events", "mtg_motions", "mtg_interests", "mtg_results", "mtg_minutes", "mtg_actions"]) expect(count(h, `SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
      expect(audits(h), "no audit entry was written").toBe(auditBefore);
    }
  });

  test("a list made only for attendance from an uploaded sheet never gets Meetings, even when Meetings is switched on", async () => {
    const h = await makeHarness({ MEETINGS_ENABLED: "1" }); const jar = await h.staff("organizer@sample.example");
    const up = await h.call("POST", "/api/attendance/rosters", { title: "Sheet list", format: "paste", text: "Flat / House / Member ID,Name,E-mail\nA-1,Asha,asha@sample.example\n", country: "India" }, jar);
    expect(up.status).toBe(201);
    const id = up.json.list.id as string, slug = String(up.json.list.link).replace("/v/", "");
    for (const [method, path, body] of [["GET", `/api/lists/${id}/meetings`], ["GET", `/api/lists/${id}/meetings/rules`], ["POST", `/api/lists/${id}/meetings`, { title: "x" }], ["GET", `/api/v/${slug}/meetings`]] as const) {
      const r = await h.call(method, path, body, jar); expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect(count(h, "SELECT COUNT(*) AS n FROM mtg_meetings")).toBe(0);
  });

  test("a mutating request without the page header is refused, as for every other address", async () => {
    const w = await world(1);
    const r = await w.h.call("POST", w.base, { title: "x" }, w.jar, { "x-vl": "0" }); expect(r.status).toBe(403);
  });

  test("erasing a list removes every meeting record in one step, and the meeting addresses then say the list is closed", async () => {
    const w = await world(4, { RETENTION_DAYS: "30" }); const m = await noticed(w, { pct: 50 }); await opened(w, m); await present(w, m.aid!, "asha", "bharat", "chitra");
    const x = need(await motion(w, m.mid, m.items[1]!), 201).motion; need(await result(w, m.mid, x.id, { for: 3, against: 0 }), 201);
    need(await w.h.call("POST", `${w.base}/${m.mid}/close`, {}, w.jar), 200);
    need(await w.h.call("POST", `${w.base}/${m.mid}/minutes`, { body: "The budget was approved by 3 votes to 0.", source: "human" }, w.jar), 201);
    need(await w.h.call("POST", `${w.base}/${m.mid}/actions`, { text: "Pay the contractor", ownerName: "Mr Owner Person", ownerEmail: "owner@sample.example", dueDate: "2026-12-31" }, w.jar), 201);
    need(await w.h.call("POST", `${w.base}/${m.mid}/people`, { role: "validated_by", name: "Mr Validator", email: "validator@sample.example" }, w.jar), 201);
    need(await w.h.call("POST", `/api/lists/${w.sid}/erase`, { confirm: "ERASE" }, w.jar), 200);
    for (const t of ["mtg_meetings", "mtg_rules", "mtg_items", "mtg_notices", "mtg_people", "mtg_events", "mtg_motions", "mtg_interests", "mtg_results", "mtg_minutes", "mtg_actions"]) expect(count(w.h, `SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    expect((await w.h.call("GET", w.base, undefined, w.jar)).status).toBe(410);
    expect((await w.h.call("GET", `/api/v/${w.slug}/meetings`)).status).toBe(410);
    expect((await w.h.call("GET", `/api/lists/${w.sid}/audit/verify`, undefined, w.jar)).json.ok).toBe(true); // the signed log stays and still verifies
  });
});

describe("wording and boundaries of the code", () => {
  test("every message people can read follows the owner's wording rules", () => {
    expect(MEETING_MESSAGES.length).toBeGreaterThan(40);
    for (const m of MEETING_MESSAGES) {
      expect(m, m).not.toMatch(/\b(my|mine|your|yours)\b/i);
      expect(m, m).not.toMatch(/\bhosts?\b/i);
      expect(m, m).not.toMatch(/\bWe (do not|don't)\b/);
      expect(m, m).not.toMatch(/nickname/i);
      expect(m.length, m).toBeLessThan(260);
      expect(m.endsWith("."), m).toBe(true);
    }
  });

  test("Meetings reads Attendance and the list only through their public functions: no attendance table and no direct read of voters", () => {
    for (const f of ["meetings", "meeting-core", "meeting-motions", "meeting-minutes", "meeting-report", "meeting-messages"]) {
      const src = readFileSync(`src/${f}.ts`, "utf8").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\batt_(sessions|marks)\b/);
      expect(src, f).not.toMatch(/\b(FROM|JOIN|INTO|UPDATE)\s+voters\b/i);
    }
    const name = readdirSync("migrations").find((f) => f.endsWith("_meetings.sql")); // found by its ending, so renumbering the migration at merge time breaks nothing
    expect(name, "the Meetings migration file").toBeDefined();
    const sql = readFileSync(`migrations/${name!}`, "utf8");
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/REFERENCES\s+(voters|att_sessions|att_marks)\b/i);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)(?:\s+IF\s+NOT\s+EXISTS)?\s+(?!mtg_|idx_mtg_|trg_mtg_|uq_mtg_)\w+/i); // every table, index and trigger of this product carries the mtg_ prefix, as Attendance carries att_
  });
});
