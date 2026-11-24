// The HTTP API. One function, handle(request, env, now), used by the Cloudflare Pages Function, the dev server and the tests.
// Words: a "list" is a voter list (a row of `societies`); a "record" is one person's enrolment for one flat or house.
import { auditAll, auditEntries, auditHead, pseudonym, verifyAudit, verifySegment } from "./audit";
import { checkTurnstile, endSession, HttpError, sessionFrom, startCode, verifyCode, MEMBER_SESSION_MS, STAFF_SESSION_MS, type Session } from "./auth";
import type { Env } from "./db";
import * as attendance from "./attendance";
import { eraseList, eraseStatus } from "./erase";
import * as lists from "./lists";
import * as orders from "./orders";
import { RULES } from "./model";
import { overview } from "./overview";
import * as publish from "./publish";
import * as records from "./records";
import * as review from "./review";
import { societyBySlug, staffCtx, type StaffCtx } from "./store";
import { buildTemplateXlsx, TEMPLATE_CSV } from "./xlsx";
import { publicKeyFromPrivate } from "./vendor/crypto";

const MAX_BODY = 12_000_000;
const SEC_HEADERS = { "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cross-origin-resource-policy": "same-origin" };
const PUBLIC_CACHE = { "cache-control": "public, max-age=30" };

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...SEC_HEADERS, ...headers } });
const file = (body: Uint8Array | string, type: string, filename: string, inline = false) => new Response(body as BodyInit, { headers: { "content-type": type, "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.\-]/g, "_")}"`, "content-security-policy": "sandbox; default-src 'none'", ...SEC_HEADERS } });

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (req.headers.get("cookie") ?? "").split(/;\s*/)) { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); }
  return out;
}
const setCookie = (env: Env, name: string, value: string, maxAgeSec: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${env.TEST_MODE === "1" ? "" : "; Secure"}`;

type Params = Record<string, string>;
interface Req { req: Request; env: Env; now: number; url: URL; params: Params; ip: string; body: () => Promise<Record<string, unknown>> }
type Handler = (r: Req) => Promise<Response>;
const routes: Array<{ method: string; re: RegExp; keys: string[]; h: Handler }> = [];
function route(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/\./g, "\\.").replace(/:([a-z]+)/gi, (_m, k: string) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ method, re, keys, h });
}
/** For tests: every route the handler answers (used to check the pages' scripts only call addresses that exist). */
export const routeTable = () => routes.map((x) => ({ method: x.method, re: x.re }));

async function staffSession(r: Req): Promise<Session> {
  const s = await sessionFrom(r.env, cookies(r.req).vl ?? null, r.now);
  if (!s || s.kind !== "staff") throw new HttpError(401, "Please sign in.", "signed_out");
  return s;
}
// Attendance routes and the signed audit trail accept both kinds of list; every other staff route is for a Voter List only and answers 404 for a roster upload list
const staffAny = async (r: Req): Promise<StaffCtx> => staffCtx(r.env, r.now, (await staffSession(r)).email, r.params.sid!);
const staff = async (r: Req): Promise<StaffCtx> => { const c = await staffAny(r); if (c.society.purpose !== "voter_list") throw new HttpError(404, "Not found.", "not_found"); return c; };
// a link of a list made only for attendance (from an uploaded Excel sheet) opens attendance and sign-in, nothing of the Voter List
const anySlug = async (r: Req) => { const s = await societyBySlug(r.env, r.params.slug!); if (!s) throw new HttpError(404, "This link is not valid.", "not_found"); return s; };
const liveSlug = async (r: Req) => { const s = await anySlug(r); if (s.erased_at) throw new HttpError(410, "This list has been closed and its details erased.", "erased"); return s; }; // the same answer as /start
const slugList = async (r: Req) => { const s = await anySlug(r); if (s.purpose !== "voter_list") throw new HttpError(404, "This link is not valid.", "not_found"); return s; };
async function voter(r: Req): Promise<records.VoterCtx> {
  const society = await slugList(r);
  const s = await sessionFrom(r.env, cookies(r.req).vlm ?? null, r.now);
  if (!s || s.kind !== "member" || s.societyId !== society.id) throw new HttpError(401, "Please sign in with the code sent to the e-mail ID.", "signed_out");
  return { env: r.env, now: r.now, email: s.email, society };
}
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown) => v === true;
const intq = (v: string | null, d: number) => { if (v === null || v.trim() === "") return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const SENT = { ok: true, message: "If that e-mail ID can be reached, a six-digit code is on its way." };

// ------------------------------------------------------------------------------------------------------------------ open routes
route("GET", "/api/health", async () => json({ ok: true, service: "voter-list" }));
route("GET", "/api/config", async (r) => json({ turnstileSiteKey: r.env.TURNSTILE_SECRET && r.env.TURNSTILE_SITE_KEY ? r.env.TURNSTILE_SITE_KEY : "" }));
route("GET", "/api/public-key", async (r) => json({ algorithm: "Ed25519", publicKey: await publicKeyFromPrivate(r.env.SIGNING_KEY) }));
route("GET", "/api/template.xlsx", async () => file(buildTemplateXlsx({ rows: 300 }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "voter-list-template.xlsx"));
route("GET", "/api/template.csv", async () => file(TEMPLATE_CSV, "text/csv; charset=utf-8", "voter-list-template.csv"));

// sign-in for the Organizer and Hosts (e-mail + six-digit code; no passwords)
route("POST", "/api/auth/start", async (r) => { const b = await r.body(); await checkTurnstile(r.env, str(b.turnstileToken, 4096), r.ip); await startCode(r.env, str(b.email, 200), "staff", null, r.ip, r.now); return json(SENT); });
route("POST", "/api/auth/verify", async (r) => {
  const b = await r.body(); const { token, session } = await verifyCode(r.env, str(b.email, 200), str(b.code, 12), "staff", null, r.ip, r.now);
  return json({ ok: true, email: session.email }, 200, { "set-cookie": setCookie(r.env, "vl", token, STAFF_SESSION_MS / 1000) });
});
route("POST", "/api/auth/logout", async (r) => { await endSession(r.env, cookies(r.req).vl ?? null, r.now); return json({ ok: true }, 200, { "set-cookie": setCookie(r.env, "vl", "", 0) }); });
route("GET", "/api/me", async (r) => {
  const s = await staffSession(r);
  const rs = await r.env.DB.prepare("SELECT s.id, s.name, s.phase, m.role, m.permanent FROM memberships m JOIN societies s ON s.id = m.society_id WHERE m.email = ? AND m.status = 'active' AND s.purpose = 'voter_list' ORDER BY s.created_at DESC LIMIT 200").bind(s.email).all();
  return json({ email: s.email, lists: rs.results, countries: lists.COUNTRIES, kinds: lists.KINDS, rules: RULES.map((x) => ({ code: x.code, name: x.name, blurb: x.blurb, proxy: x.proxy })), permanentHost: lists.permanentHostEmail(r.env) });
});

// ------------------------------------------------------------------------------------------------------------------ the common link: public, voter
route("GET", "/api/v/:slug", async (r) => json(await publish.publicInfo(r.env, await slugList(r), r.now), 200, PUBLIC_CACHE));
route("GET", "/api/v/:slug/list", async (r) => { const sp = r.url.searchParams; return json(await publish.publicList(r.env, await slugList(r), { offset: intq(sp.get("offset"), 0), limit: intq(sp.get("limit"), 50), unit: sp.get("unit") ?? "", pub: sp.get("pub") ?? undefined }), 200, PUBLIC_CACHE); });
for (const fmt of ["pdf", "csv"] as const) route("GET", `/api/v/:slug/list.${fmt}`, async (r) => { const x = await publish.publicExport(r.env, await slugList(r), fmt, r.url.searchParams.get("pub") ?? undefined); return file(x.body, x.type, x.filename); });
route("GET", "/api/v/:slug/proof", async (r) => json(await publish.publicProof(r.env, await slugList(r), r.url.searchParams.get("pub") ?? undefined), 200, PUBLIC_CACHE));

route("POST", "/api/v/:slug/start", async (r) => {
  const soc = await anySlug(r); const b = await r.body();
  if (soc.erased_at) throw new HttpError(410, "This list has been closed and its details erased.", "erased");
  await checkTurnstile(r.env, str(b.turnstileToken, 4096), r.ip);
  await startCode(r.env, str(b.email, 200), "member", { id: soc.id, name: soc.name }, r.ip, r.now);
  return json(SENT); // the same words whether or not the e-mail ID is already known
});
route("POST", "/api/v/:slug/verify", async (r) => {
  const soc = await liveSlug(r); const b = await r.body();
  const { token, session } = await verifyCode(r.env, str(b.email, 200), str(b.code, 12), "member", soc.id, r.ip, r.now);
  return json({ ok: true, email: session.email }, 200, { "set-cookie": setCookie(r.env, "vlm", token, MEMBER_SESSION_MS / 1000) });
});
route("POST", "/api/v/:slug/logout", async (r) => { await endSession(r.env, cookies(r.req).vlm ?? null, r.now); return json({ ok: true }, 200, { "set-cookie": setCookie(r.env, "vlm", "", 0) }); });
route("GET", "/api/v/:slug/me", async (r) => json(await records.myRecords(await voter(r))));
route("POST", "/api/v/:slug/records", async (r) => json(await records.createRecord(await voter(r), (await r.body()) as records.RecordInput), 201));
route("PATCH", "/api/v/:slug/records/:rid", async (r) => json(await records.editRecord(await voter(r), r.params.rid!, (await r.body()) as records.RecordInput)));
route("POST", "/api/v/:slug/records/:rid/confirm", async (r) => { await r.body(); return json(await records.confirmRecord(await voter(r), r.params.rid!)); });
route("POST", "/api/v/:slug/records/:rid/withdraw", async (r) => json(await records.withdrawRecord(await voter(r), r.params.rid!)));
route("POST", "/api/v/:slug/records/:rid/docs", async (r) => { const b = await r.body(); return json(await records.addDoc(await voter(r), r.params.rid!, { docType: str(b.docType, 40), filename: str(b.filename, 120), mime: str(b.mime, 40), base64: typeof b.base64 === "string" ? b.base64 : "" }), 201); });
route("DELETE", "/api/v/:slug/records/:rid/docs/:did", async (r) => json(await records.removeDoc(await voter(r), r.params.rid!, r.params.did!)));
route("GET", "/api/v/:slug/records/:rid/docs/:did", async (r) => { const d = await records.getMyDoc(await voter(r), r.params.rid!, r.params.did!); return file(d.body, d.type, d.filename, true); });

// attendance: public counts (no personal data), and a voter who signed in marks themselves present in an online session
route("GET", "/api/v/:slug/attendance", async (r) => json(await attendance.publicSessions(r.env, await liveSlug(r)), 200, PUBLIC_CACHE));
route("GET", "/api/v/:slug/attendance/:aid", async (r) => json(await attendance.publicSession(r.env, await liveSlug(r), r.params.aid!), 200, PUBLIC_CACHE));
route("POST", "/api/v/:slug/attendance/:aid/here", async (r) => {
  const society = await liveSlug(r); const b = await r.body();
  const s = await sessionFrom(r.env, cookies(r.req).vlm ?? null, r.now);
  if (!s || s.kind !== "member" || s.societyId !== society.id) throw new HttpError(401, "Please sign in with the code sent to the e-mail ID.", "signed_out");
  return json(await attendance.markSelf(r.env, r.now, society, s.email, r.params.aid!, b.voterId));
});

// Attendance for an organizer with no Voter List: the Excel template and the upload that makes the list
route("GET", "/api/attendance/template.xlsx", async () => file(buildTemplateXlsx({ rows: 300, title: "Attendance list template" }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "attendance-list-template.xlsx"));
route("GET", "/api/attendance/template.csv", async () => file(TEMPLATE_CSV, "text/csv; charset=utf-8", "attendance-list-template.csv"));
route("POST", "/api/attendance/rosters", async (r) => { const s = await staffSession(r); const x = await attendance.uploadRoster(r.env, r.now, s.email, (await r.body()) as attendance.RosterInput); return json(x, x.dryRun ? 200 : 201); });
route("GET", "/api/attendance/rosters", async (r) => { const s = await staffSession(r); return json({ lists: (await r.env.DB.prepare("SELECT s.id, s.name, s.verify_slug FROM memberships m JOIN societies s ON s.id = m.society_id WHERE m.email = ? AND m.status = 'active' AND s.purpose = 'attendance_upload' ORDER BY s.created_at DESC LIMIT 200").bind(s.email).all<{ id: string; name: string; verify_slug: string }>()).results.map((x) => ({ id: x.id, name: x.name, link: `/v/${x.verify_slug}` })) }); });

// ------------------------------------------------------------------------------------------------------------------ the Organizer's and Hosts' page
route("POST", "/api/lists", async (r) => { const s = await staffSession(r); const b = await r.body(); const soc = await lists.createList(r.env, r.now, s.email, b as unknown as lists.ListInput); return json({ list: lists.viewList(soc) }, 201); });
route("GET", "/api/lists/:sid", async (r) => json(await overview(await staff(r))));
route("PATCH", "/api/lists/:sid", async (r) => { const c = await staff(r); const soc = await lists.updateList(c, (await r.body()) as Partial<lists.ListInput> & { closeNow?: boolean }); return json({ list: lists.viewList(soc) }); });
route("POST", "/api/lists/:sid/step/:what", async (r) => { const w = r.params.what; if (w !== "link_shared" && w !== "hosts_skipped") throw new HttpError(404, "Not found.", "not_found"); return json(await lists.markStep(await staff(r), w)); });

// records: the review queue
route("GET", "/api/lists/:sid/records", async (r) => { const c = await staff(r); const sp = r.url.searchParams; return json(await review.listRecords(c, { status: sp.get("status"), q: sp.get("q") ?? "", offset: intq(sp.get("offset"), 0), limit: intq(sp.get("limit"), 50) })); });
route("POST", "/api/lists/:sid/records", async (r) => json(await review.addRecord(await staff(r), (await r.body()) as never), 201));
route("POST", "/api/lists/:sid/records/decide", async (r) => { const b = await r.body(); const items = Array.isArray(b.items) ? (b.items as Array<{ id: unknown; rev: unknown }>).filter((i) => i && typeof i === "object").map((i) => ({ id: str(i.id, 60), rev: Number(i.rev) })) : []; return json(await review.decide(await staff(r), items, str(b.decision, 12) as review.Decision, str(b.reason, 400))); });
route("POST", "/api/lists/:sid/records/remove", async (r) => { const b = await r.body(); return json(await review.removeRecords(await staff(r), Array.isArray(b.ids) ? (b.ids as unknown[]).map((x) => str(x, 60)) : [], str(b.reason, 400))); });
route("POST", "/api/lists/:sid/records/import", async (r) => json(await review.importRecords(await staff(r), (await r.body()) as unknown as review.ImportInput)));
route("GET", "/api/lists/:sid/records/:rid", async (r) => json(await review.openRecord(await staff(r), r.params.rid!)));
route("PATCH", "/api/lists/:sid/records/:rid", async (r) => { const c = await staff(r); const b = await r.body(); const { reason, ...rest } = b as Record<string, unknown>; return json(await review.staffEdit(c, r.params.rid!, rest as review.StaffPatch, str(reason, 400))); });
route("GET", "/api/lists/:sid/records/:rid/docs/:did", async (r) => { const d = await review.getStaffDoc(await staff(r), r.params.rid!, r.params.did!); return file(d.body, d.type, d.filename, true); });

// checks, who votes for a flat, weights
route("GET", "/api/lists/:sid/checks", async (r) => json(await publish.checksView(await staff(r), r.url.searchParams.get("find") ?? "")));
route("POST", "/api/lists/:sid/units/choose", async (r) => { const b = await r.body(); return json(await review.chooseVoter(await staff(r), str(b.unit, 60), str(b.voterId, 60), typeof b.authorized === "boolean" ? b.authorized : b.authorized === undefined ? true : (() => { throw new HttpError(400, "Please say true or false."); })(), b.reason, b.note)); });
route("PUT", "/api/lists/:sid/weights", async (r) => { const b = await r.body(); return json(await review.setWeights(await staff(r), Array.isArray(b.items) ? (b.items as Array<{ unit: string; weight: string }>) : [])); });

// undo
route("GET", "/api/lists/:sid/actions", async (r) => json(await review.recentActions(await staff(r))));
route("POST", "/api/lists/:sid/undo", async (r) => { const b = await r.body(); return json(await review.undo(await staff(r), { key: str(b.key, 60) })); });

// publishing
route("POST", "/api/lists/:sid/publish/draft", async (r) => json(await publish.publishDraft(await staff(r)), 201));
route("POST", "/api/lists/:sid/publish/frozen", async (r) => { const b = await r.body(); return json(await publish.publishFrozen(await staff(r), { eventName: str(b.eventName, 200), eventType: str(b.eventType, 12), ackWarnings: bool(b.ackWarnings), ackPending: bool(b.ackPending), closeNow: bool(b.closeNow), confirm: str(b.confirm, 12) }), 201); });
route("POST", "/api/lists/:sid/reopen", async (r) => { const b = await r.body(); return json(await publish.reopen(await staff(r), { reason: str(b.reason, 300), confirm: str(b.confirm, 12) })); });
route("GET", "/api/lists/:sid/publications", async (r) => json(await publish.listPublications(await staff(r))));
for (const fmt of ["pdf", "csv"] as const) route("GET", `/api/lists/:sid/publications/:pid/export.${fmt}`, async (r) => { const x = await publish.exportPublication(await staff(r), r.params.pid!, fmt, r.url.searchParams.get("full") === "1"); return file(x.body, x.type, x.filename); });

// team: 1 Organizer, up to 10 Hosts, and the standing Townhall Records Host
route("GET", "/api/lists/:sid/team", async (r) => json(await lists.listTeam(await staff(r))));
route("POST", "/api/lists/:sid/team", async (r) => json(await lists.inviteHost(await staff(r), (await r.body()) as never), 201));
route("POST", "/api/lists/:sid/team/organizer", async (r) => { const b = await r.body(); return json(await lists.transferOrganizer(await staff(r), str(b.email, 200))); });
route("DELETE", "/api/lists/:sid/team/:email", async (r) => json(await lists.removeHost(await staff(r), (() => { try { return decodeURIComponent(r.params.email!); } catch { throw new HttpError(400, "That e-mail ID could not be read.", "bad_email"); } })())));

// attendance sessions (Voter List or uploaded list): create, list, open, mark present, close
route("POST", "/api/lists/:sid/attendance/sessions", async (r) => json(await attendance.createSession(await staffAny(r), await r.body()), 201));
route("GET", "/api/lists/:sid/attendance/sessions", async (r) => json(await attendance.listSessions(await staffAny(r))));
route("GET", "/api/lists/:sid/attendance/sessions/:aid", async (r) => json(await attendance.openSession(await staffAny(r), r.params.aid!, r.url.searchParams.get("find") ?? "")));
route("POST", "/api/lists/:sid/attendance/sessions/:aid/mark", async (r) => { const c = await staffAny(r); const b = await r.body(); return json(await attendance.markByTeam(c, r.params.aid!, b.voterId)); });
route("POST", "/api/lists/:sid/attendance/sessions/:aid/close", async (r) => { const c = await staffAny(r); await r.body(); return json(await attendance.closeSession(c, r.params.aid!)); });

// retention
route("GET", "/api/lists/:sid/erase", async (r) => json(await eraseStatus(await staff(r))));
route("POST", "/api/lists/:sid/erase", async (r) => { const b = await r.body(); return json(await eraseList(await staff(r), { confirm: str(b.confirm, 12) })); });

// the price slot (follows the Games pattern: the central payment service of IT SERVICES BY RAJAT AGARWAL; test orders only without PAY_SERVICE_KEY)
route("POST", "/api/lists/:sid/orders", async (r) => json(await orders.createOrder(await staff(r)), 201));
route("POST", "/api/lists/:sid/orders/:oid/test-pay", async (r) => json(await orders.testPay(await staff(r), r.params.oid!)));
route("POST", "/api/lists/:sid/orders/:oid/verify", async (r) => { const b = await r.body(); return json(await orders.verifyOrder(await staff(r), r.params.oid!, { razorpay_order_id: b.razorpay_order_id, razorpay_payment_id: b.razorpay_payment_id, razorpay_signature: b.razorpay_signature })); });

// the signed audit trail
route("GET", "/api/lists/:sid/audit", async (r) => {
  const c = await staffAny(r); const sp = r.url.searchParams; const head = await auditHead(r.env, c.society.id);
  const from = sp.has("from") ? Math.max(1, Number(sp.get("from")) || 1) : Math.max(1, (head?.seq ?? 1) - 99);
  // The log names people by a private code; this table lets the Organizer read it in plain words (who is who, by role).
  const team = await r.env.DB.prepare("SELECT email, role, permanent FROM memberships WHERE society_id = ? AND status = 'active'").bind(c.society.id).all<{ email: string; role: string; permanent: number }>();
  const people: Record<string, { who: string; role: string }> = {};
  for (const m of team.results) people[await pseudonym(r.env, m.email)] = { who: c.role === "organizer" || m.permanent ? m.email : m.email.replace(/^(.).*(@.*)$/, "$1****$2"), role: m.permanent ? "standing co-organizer" : m.role };
  return json({ entries: await auditEntries(r.env, c.society.id, { from, limit: 100 }), head, people, publicKey: await publicKeyFromPrivate(r.env.SIGNING_KEY) });
});
route("GET", "/api/lists/:sid/audit/verify", async (r) => { const c = await staffAny(r); const sp = r.url.searchParams; return json(await verifySegment(r.env, c.society.id, intq(sp.get("from"), 1), intq(sp.get("limit"), 100))); });
route("GET", "/api/lists/:sid/audit/head", async (r) => { const c = await staffAny(r); return json({ list: c.society.id, head: await auditHead(r.env, c.society.id), publicKey: await publicKeyFromPrivate(r.env.SIGNING_KEY) }); });
route("GET", "/api/lists/:sid/audit/export.json", async (r) => {
  const c = await staffAny(r); const entries = await auditAll(r.env, c.society.id);
  const verification = c.role === "organizer" ? await verifyAudit(r.env, c.society.id) : null;
  const body = JSON.stringify({ list: c.society.id, publicKey: await publicKeyFromPrivate(r.env.SIGNING_KEY), count: entries.length, head: entries.length ? { seq: entries[entries.length - 1]!.entry.seq, hash: entries[entries.length - 1]!.hash } : null, verified: verification ? verification.ok : null, entries });
  return file(body, "application/json", "audit-trail.json");
});

// ------------------------------------------------------------------------------------------------------------------ the entry point
export async function handle(req: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (!url.pathname.startsWith("/api/")) return json({ error: "Not found.", code: "not_found" }, 404);
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      if (req.headers.get("x-vl") !== "1") throw new HttpError(403, "This request was not made by the Voter List page.", "csrf");
      const origin = req.headers.get("origin"); if (origin && (() => { try { return new URL(origin).host !== url.host; } catch { return true; } })()) throw new HttpError(403, "This request came from another site.", "csrf");
    }
    for (const rt of routes) {
      if (rt.method !== method && !(method === "HEAD" && rt.method === "GET")) continue;
      const m = rt.re.exec(url.pathname); if (!m) continue;
      const params: Params = {}; rt.keys.forEach((k, i) => { params[k] = m[i + 1]!; });
      let cached: Record<string, unknown> | null = null;
      const body = async () => {
        if (cached) return cached;
        const len = Number(req.headers.get("content-length") ?? 0); if (len > MAX_BODY) throw new HttpError(413, "That is too large.", "too_large");
        const text = await req.text(); if (text.length > MAX_BODY) throw new HttpError(413, "That is too large.", "too_large");
        if (!text.trim()) return (cached = {});
        try { const j = JSON.parse(text); if (!j || typeof j !== "object" || Array.isArray(j)) throw 0; return (cached = j as Record<string, unknown>); } catch { throw new HttpError(400, "The request could not be read.", "bad_json"); }
      };
      return await rt.h({ req, env, now, url, params, ip: req.headers.get("cf-connecting-ip") ?? "local", body });
    }
    throw new HttpError(404, "Not found.", "not_found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    const msg = String((e as Error)?.message ?? e);
    if (/immutable|append-only/i.test(msg)) return json({ error: "That record is fixed and cannot be changed.", code: "immutable" }, 409);
    console.error("voter-list internal error:", msg.slice(0, 300));
    return json({ error: "Something went wrong on our side. Nothing was lost; please try again.", code: "internal" }, 500);
  }
}
