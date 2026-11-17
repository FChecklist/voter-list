// Sign-in by e-mail code (no passwords, no SMS: SMS is a paid service), sessions, rate limits, and the mail outbox.
import { hmacHex, randomHex, randomInt, sha256Hex, timingSafeEqual } from "./vendor/crypto";
import { commit, pseudonym } from "./audit";
import { uid, type Env } from "./db";
import { cleanEmail } from "./text";

import { HttpError } from "./errors";
export { HttpError };

export const OTP_TTL_MS = 10 * 60_000;
export const STAFF_SESSION_MS = 7 * 86_400_000;
export const MEMBER_SESSION_MS = 8 * 3_600_000;
const MAX_ATTEMPTS_TOTAL = 20; // wrong tries allowed against one code, from anywhere (a million codes: 20 guesses is a 1 in 50,000 chance)
const MAX_ATTEMPTS_PER_IP = 5; // ... of which one address may use only 5, so a stranger cannot burn the person's tries alone

/** Counts a hit against `key`; throws 429 when `limit` hits already fall inside the last `windowMs`. One statement, so two requests at once cannot both slip under the limit. */
export async function rateLimit(env: Env, key: string, limit: number, windowMs: number, now: number, message?: string): Promise<void> {
  const r = await env.DB.prepare("INSERT INTO rate_hits (k, ts) SELECT ?, ? WHERE (SELECT COUNT(*) FROM rate_hits WHERE k = ? AND ts > ?) < ?").bind(key, now, key, now - windowMs, limit).run();
  if (!r.meta?.changes) throw new HttpError(429, message ?? "Too many tries. Please wait a little and try again.", "rate_limited");
}
async function hits(env: Env, key: string, windowMs: number, now: number): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_hits WHERE k = ? AND ts > ?").bind(key, now - windowMs).first<{ n: number }>())?.n ?? 0;
}

/** Old rows nobody needs again. Cheap and run now and then (about 1 sign-in request in 20), so the free database does not fill with dead rows. */
export async function purgeStale(env: Env, now: number): Promise<void> {
  const day = 86_400_000;
  // A record the VOTER withdrew (their own choice, and still the latest thing that happened to it) is kept 30 days, in case they change their mind, then cleared for good.
  // A record the list team removed is kept, as all records are. The candidates are found once, through an index; the heavier clean-up runs only when there are any.
  const WITHDRAWN = "status = 'removed' AND updated_at < ? AND (SELECT e.kind FROM voter_events e WHERE e.society_id = voters.society_id AND e.voter_id = voters.id AND e.undone_by IS NULL AND e.kind IN ('withdrawn','removed','created','added','imported','confirmed','resubmitted','approved','sent_back') ORDER BY e.id DESC LIMIT 1) = 'withdrawn'";
  const cutoff = now - 30 * day;
  const stmts = [
    env.DB.prepare("DELETE FROM rate_hits WHERE ts < ?").bind(now - day),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now - day),
    env.DB.prepare("DELETE FROM otp_codes WHERE created_at < ?").bind(now - day),
    env.DB.prepare("DELETE FROM mail_outbox WHERE created_at < ?").bind(now - 30 * day),
  ];
  const any = await env.DB.prepare("SELECT 1 AS x FROM voters WHERE " + WITHDRAWN + " LIMIT 1").bind(cutoff).first();
  if (any) {
    const C = "(SELECT society_id, id FROM voters WHERE " + WITHDRAWN + ")";
    stmts.push(
      env.DB.prepare("DELETE FROM voter_docs WHERE voter_id IN (SELECT id FROM voters WHERE " + WITHDRAWN + ")").bind(cutoff),
      env.DB.prepare("UPDATE voter_events SET before_json = NULL, after_json = NULL, actor_email = '(erased)' WHERE (society_id, voter_id) IN " + C + " AND (before_json IS NOT NULL OR after_json IS NOT NULL OR actor_email <> '(erased)')").bind(cutoff),
      // the same people also leave the (replaceable) draft list's stored lines; a signed final list stays as it was, and the voter is told so
      env.DB.prepare("DELETE FROM publication_rows WHERE publication_id IN (SELECT id FROM publications WHERE kind = 'draft') AND (society_id, unit_key, email) IN (SELECT society_id, unit_key, email FROM voters WHERE " + WITHDRAWN + ")").bind(cutoff),
      env.DB.prepare("DELETE FROM voters WHERE " + WITHDRAWN).bind(cutoff),
    );
  }
  await env.DB.batch(stmts);
}

const codeHash = (env: Env, email: string, purpose: string, society: string | null, code: string) => hmacHex(env.PEPPER, `otp|${email}|${purpose}|${society ?? ""}|${code}`);

/** What is kept in the outbox for a message. A sign-in code is a password for ten minutes: it is mailed, never stored (only on a developer machine, TEST_MODE, where nothing is mailed and the tests must read it). */
const outboxText = (env: Env, kind: string, text: string) => (kind.startsWith("otp-") && env.TEST_MODE !== "1" ? text.replace(/\b\d{6}\b/g, "[code not stored]") : text);

export const signupOpen = (env: Env) => env.TEST_MODE === "1" || env.OPEN_SIGNUP === "1";
export const isListedOrganizer = (env: Env, email: string) => (env.ORGANIZERS ?? "").toLowerCase().split(/[\s,;]+/).filter(Boolean).includes(email.toLowerCase());

/** The free e-mail allowance, in plain terms. The whole design is these five rules:
 *  1. A new Organizer must be on the owner's list (ORGANIZERS), so strangers cannot make accounts (unless OPEN_SIGNUP is on).
 *  2. One e-mail ID gets at most 4 codes an hour and 8 a day.
 *  3. A list's newcomers (addresses not yet on it) get at most MAIL_LIST_CAP codes a day (default 25), and newcomers together at most two thirds of the voters' pool, so people already on a list can always sign in.
 *  4. Two pools a day: voters (everything minus the staff reserve; codes and send-back notes, notes at most a sixth) and staff (sign-in codes, invitations). Neither can use the other's.
 *  5. When the optional Cloudflare Turnstile check is set up (TURNSTILE_SECRET), a code is only sent after it was passed. Switch it on before the link goes public: without it a robot can use up the day's allowance.
 *  Whatever the limits say, every request for a code gets the same words and takes about the same time (the mail is sent after the answer), so nobody can learn who is on a list. */
export function mailPools(env: Env) {
  const num = (v: string | undefined, d: number) => { const n = v === undefined || String(v).trim() === "" ? d : Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; }; // a mistyped setting falls back to the default
  const cap = num(env.MAIL_DAILY_CAP, 80);
  const staff = cap <= 1 ? cap : Math.min(Math.floor(cap / 2), num(env.MAIL_STAFF_RESERVE, 20)); // the staff reserve never takes more than half the day's allowance, so voters always keep a share
  return { cap, staff, voters: Math.max(0, cap - staff), perList: num(env.MAIL_LIST_CAP, 25) };
}
const VOTER_KINDS = ["otp-member", "otp-member-new", "voter-note"];

/** The Cloudflare Turnstile check (free). Not set up = no check. Set up = no code is sent, and nothing is counted, until it was passed. */
export async function checkTurnstile(env: Env, token: string, ip: string): Promise<void> {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) return; // on only when both are set (the page cannot show the box without the site key)
  if (!token) throw new HttpError(400, "Please tick the small safety box first, then ask for your code.", "turnstile");
  let ok = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }) });
    ok = r.ok && !!((await r.json()) as { success?: boolean }).success;
  } catch { ok = false; }
  if (!ok) throw new HttpError(400, "The safety box did not pass. Please try it once more.", "turnstile");
}

/** E-mail is configured when the Cloudflare Email Service (CF_EMAIL_TOKEN and CF_ACCOUNT_ID) or, as the older route, Resend (RESEND_API_KEY) has its secrets. */
const CF_ID = /^[0-9a-f]{32}$/i; // a Cloudflare account id is 32 hex characters; anything else is treated as not set
const cfRoute = (env: Env): boolean => !!env.CF_EMAIL_TOKEN && CF_ID.test((env.CF_ACCOUNT_ID ?? "").trim());
export const mailConfigured = (env: Env): boolean => cfRoute(env) || !!env.RESEND_API_KEY;

/** The From header: a display name is always quoted ("Townhall Records" <no-reply@townhall-records.com>), so a name with a comma or other special character cannot break the header. */
export function fromHeader(env: Env): string {
  const raw = (env.MAIL_FROM ?? "").trim() || "Townhall Records <no-reply@townhall-records.com>";
  const m = /^([^<>]*?)\s*<([^<>\s]+)>$/.exec(raw);
  if (!m) return raw.replace(/[\u0000-\u001f\u007f]/g, ""); // not "Name <address>": a plain address, with no control characters
  const name = m[1]!.replace(/["\u0000-\u001f\u007f\\]/g, " ").replace(/\s+/g, " ").trim(); // no control characters or backslashes in the display name
  return name ? `"${name}" <${m[2]}>` : m[2]!;
}

/** The sender as Cloudflare's REST API wants it: a plain address, or { address, name } when there is a display name (as in its "Specify recipients" examples). */
export function fromObject(env: Env): string | { address: string; name: string } {
  const h = fromHeader(env);
  const m = /^"(.*)" <([^<>\s]+)>$/.exec(h);
  return m ? { address: m[2]!, name: m[1]! } : h;
}

/** Hands one message to the mail provider. The Cloudflare Email Service is used when its two secrets are set; otherwise Resend. True only when the provider accepted it. */
async function deliver(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  const from = fromHeader(env);
  if (cfRoute(env)) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${(env.CF_ACCOUNT_ID ?? "").trim()}/email/sending/send`, { signal: AbortSignal.timeout(10_000), method: "POST", headers: { authorization: "Bearer " + env.CF_EMAIL_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ from: fromObject(env), to: [to], subject, text }) });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null) as { success?: boolean; result?: { delivered?: unknown; queued?: unknown } } | null;
    if (j?.success !== true) return false;
    const res = j.result; // when the answer lists who was delivered or queued, at least one must be there
    return Array.isArray(res?.delivered) && Array.isArray(res?.queued) ? res.delivered.length + res.queued.length > 0 : true;
  }
  const r = await fetch("https://api.resend.com/emails", { signal: AbortSignal.timeout(10_000), method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }) });
  return r.ok;
}

export async function sendMail(env: Env, to: string, subject: string, body: string, kind: string, now: number): Promise<void> {
  const p = mailPools(env);
  const dayStart = now - (now % 86_400_000);
  const voterKind = VOTER_KINDS.includes(kind), limit = voterKind ? p.voters : p.staff;
  const KL = VOTER_KINDS.map((k) => "'" + k + "'").join(",");
  const kindLimit = kind === "otp-member-new" ? Math.floor((p.voters * 2) / 3) : kind === "voter-note" ? Math.floor(p.voters / 6) : limit; // newcomers at most two thirds, notes at most a sixth
  let status: "queued" | "sent" | "failed" | "capped" = "queued";
  if (env.TEST_MODE !== "1" && !mailConfigured(env)) throw new HttpError(503, "E-mail is not set up on this server yet.", "mail_not_configured");
  const subj = outboxText(env, kind, subject), text = outboxText(env, kind, body);
  if (env.TEST_MODE !== "1" && mailConfigured(env)) {
    // The slot is claimed and counted in ONE statement, so a burst of requests cannot overshoot the day's allowance (a row stays 'queued' until the provider answers).
    const claim = await env.DB.prepare("INSERT INTO mail_outbox (to_addr, subject, body, kind, status, created_at) SELECT ?, ?, ?, ?, 'queued', ? WHERE (SELECT COUNT(*) FROM mail_outbox WHERE (status = 'sent' OR (status = 'queued' AND created_at >= ?)) AND created_at >= ? AND kind " + (voterKind ? "IN" : "NOT IN") + " (" + KL + ")) < ? AND (SELECT COUNT(*) FROM mail_outbox WHERE (status = 'sent' OR (status = 'queued' AND created_at >= ?)) AND created_at >= ? AND kind = ?) < ?")
      .bind(to, subj, text, kind, now, now - 600_000, dayStart, limit, now - 600_000, dayStart, kind, kindLimit).run(); // a claim nobody answered for 10 minutes stops counting
    if (!claim.meta?.changes) status = "capped";
    else {
      try {
        status = (await deliver(env, to, subject, body)) ? "sent" : "failed";
      } catch { status = "failed"; }
      try { await env.DB.prepare("UPDATE mail_outbox SET status = ? WHERE id = ?").bind(status, claim.meta.last_row_id).run(); } catch { /* the row stays 'queued' and stops counting after 10 minutes */ }
    }
    if (status === "capped") await env.DB.prepare("INSERT INTO mail_outbox (to_addr, subject, body, kind, status, created_at) VALUES (?, ?, ?, ?, 'capped', ?)").bind(to, subj, text, kind, now).run();
  } else {
    await env.DB.prepare("INSERT INTO mail_outbox (to_addr, subject, body, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(to, subj, text, kind, status, now).run();
  }
  if (status === "capped") throw new HttpError(503, "E-mail is taking a short rest. Please try again a little later, or tomorrow.", "mail_capped");
  if (status === "failed") throw new HttpError(502, "The e-mail could not be sent. Please try again in a few minutes.", "mail_failed");
}

export async function startCode(env: Env, rawEmail: string, purpose: "staff" | "member", society: { id: string; name: string } | null, ip: string, now: number): Promise<void> {
  const em = cleanEmail(rawEmail);
  if (!em.ok) throw new HttpError(400, "Please type a proper e-mail ID.", "bad_email");
  const email = em.value;
  if (env.TEST_MODE !== "1" && !mailConfigured(env)) throw new HttpError(503, "E-mail is not set up on this server yet.", "mail_not_configured"); // the same for everyone, so it tells nothing
  if (randomInt(20) === 0) await purgeStale(env, now);
  await rateLimit(env, `otp-ip:${ip}`, 60, 3_600_000, now);
  await rateLimit(env, `otp-email:${email}`, 4, 3_600_000, now, "Several codes were sent to this e-mail ID already. Please check your inbox (and the spam folder), or try again in an hour.");
  await rateLimit(env, `otp-email-day:${email}`, 8, 86_400_000, now, "This e-mail ID has had all its codes for today. Please try again tomorrow.");
  let kind = "otp-" + purpose;
  const dummy = async () => { await codeHash(env, email, purpose, society?.id ?? null, "000000"); }; // the same small work whether or not a code is made, so the time tells nothing
  if (purpose === "member") {
    // rule 3: newcomers to a list share its daily allowance; people the list team has already vouched for (uploaded, added, approved or sent back by them) never wait for that; a record a stranger made for themselves does not count until the team has acted on it. A used-up allowance gives the same answer as any other (the code just does not come).
    const known = !!society && !!(await env.DB.prepare("SELECT 1 AS x FROM voters WHERE society_id = ? AND email = ? AND status <> 'removed' AND (source IN ('upload','host') OR status IN ('approved','sent_back') OR approved_json IS NOT NULL) LIMIT 1").bind(society.id, email).first());
    kind = known ? "otp-member" : "otp-member-new";
    if (society && !known) { try { await rateLimit(env, `otp-soc:${society.id}`, Math.max(1, mailPools(env).perList), 86_400_000, now); } catch (e) { if ((e as HttpError).code === "rate_limited") { await dummy(); return; } throw e; } }
  } else {
    // rule 1: strangers cannot make accounts. An unknown address gets the same answer and no mail.
    const standing = (env.PERMANENT_HOST_EMAIL ?? "host@townhall-records.com").trim().toLowerCase();
    const known = email === standing || !!(await env.DB.prepare("SELECT 1 AS x FROM users WHERE email = ? UNION ALL SELECT 1 FROM memberships WHERE email = ? AND status = 'active' LIMIT 1").bind(email, email).first());
    if (!known && !signupOpen(env) && !isListedOrganizer(env, email)) { await dummy(); return; }
  }
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  // earlier live codes stay valid (at most the 3 newest are checked), so a stranger asking for a code cannot break the real person's code
  await env.DB.prepare("INSERT INTO otp_codes (email, purpose, society_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(email, purpose, society?.id ?? null, await codeHash(env, email, purpose, society?.id ?? null, code), now, now + OTP_TTL_MS).run();
  const where = society ? `the Voter list of ${society.name}` : "Townhall Records";
  // The mail goes out after the answer (when the host allows it), and a mail that cannot go is not reported: the answer is the same for everyone.
  const deliver = async () => {
    try {
      await sendMail(env, email, `Your code for ${society ? society.name : "Townhall Records"}: ${code}`,
        `Your six-digit code for ${where} is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this message; nothing happens until the code is used.\n\nTownhall Records`, kind, now);
    } catch { /* not delivered; the outbox row says why */ }
  };
  if (env.waitUntil) env.waitUntil(deliver()); else await deliver();
}

export interface Session { kind: "staff" | "member"; email: string; societyId: string | null }

export async function verifyCode(env: Env, rawEmail: string, rawCode: string, purpose: "staff" | "member", societyId: string | null, ip: string, now: number): Promise<{ token: string; session: Session }> {
  const email = cleanEmail(rawEmail).value.toLowerCase();
  const code = String(rawCode ?? "").replace(/\s/g, "");
  await rateLimit(env, `verify-ip:${ip}`, 200, 3_600_000, now);
  const live = (await env.DB.prepare("SELECT id, code_hash, attempts FROM otp_codes WHERE email = ? AND purpose = ? AND IFNULL(society_id,'') = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 3")
    .bind(email, purpose, societyId ?? "", now).all<{ id: number; code_hash: string; attempts: number }>()).results.filter((r) => r.attempts < MAX_ATTEMPTS_TOTAL);
  const bad = new HttpError(401, "That code is not right, or it has expired. Please ask for a new one.", "bad_code");
  const row = live[0];
  if (!row) throw bad;
  const failKey = `otp-fail:${row.id}:${ip}`;
  if ((await hits(env, failKey, OTP_TTL_MS, now)) >= MAX_ATTEMPTS_PER_IP) throw bad; // this address has used its tries; others still have theirs
  const wrong = async () => { await env.DB.batch([...live.map((r) => env.DB.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").bind(r.id)), env.DB.prepare("INSERT INTO rate_hits (k, ts) VALUES (?, ?)").bind(failKey, now)]); throw bad; };
  if (!/^\d{6}$/.test(code)) await wrong();
  const ch = await codeHash(env, email, purpose, societyId, code);
  const hit = live.find((r) => timingSafeEqual(r.code_hash, ch));
  if (!hit) await wrong();
  const used = await env.DB.prepare("UPDATE otp_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, hit!.id).run();
  if (!used.meta?.changes) throw bad; // a second device raced and lost: one code, one sign-in
  if (purpose === "staff") await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(uid("usr"), email, now).run();
  const token = randomHex(32);
  // the standing Townhall Records host can open records on every list, so its sessions are short (12 hours)
  const standing = (env.PERMANENT_HOST_EMAIL ?? "host@townhall-records.com").trim().toLowerCase();
  const ttl = purpose === "staff" ? (email === standing ? 12 * 3_600_000 : STAFF_SESSION_MS) : MEMBER_SESSION_MS;
  await env.DB.prepare("INSERT INTO sessions (id, kind, email, society_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(await sha256Hex(env.PEPPER + "|" + token), purpose, email, societyId, now, now + ttl).run();
  await auditSession(env, purpose, email, societyId, "signed_in", now);
  return { token, session: { kind: purpose, email, societyId } };
}

/** Sign-in and sign-out go into the signed log of every society the person works for (staff) or looks at (member): who came in, by pseudonym only. */
async function auditSession(env: Env, kind: "staff" | "member", email: string, societyId: string | null, what: "signed_in" | "signed_out", now: number): Promise<void> {
  try {
    const pid = await pseudonym(env, email);
    if (kind === "member") return; // voter sign-ins are not logged: they add no value and a WhatsApp-sized burst of them would only queue on the chain
    const ms = await env.DB.prepare("SELECT society_id, role FROM memberships WHERE email = ? AND status = 'active' AND permanent = 0 ORDER BY created_at DESC LIMIT 25").bind(email).all<{ society_id: string; role: string }>();
    for (const m of ms.results) await commit(env, m.society_id, [], `staff.${what}`, { pid, role: m.role }, {}, now);
  } catch { /* the sign-in itself stands; the log line is best effort here because a sign-in must not fail on a busy chain */ }
}

export async function sessionFrom(env: Env, token: string | null, now: number): Promise<Session | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await env.DB.prepare("SELECT kind, email, society_id, expires_at FROM sessions WHERE id = ?").bind(await sha256Hex(env.PEPPER + "|" + token)).first<{ kind: "staff" | "member"; email: string; society_id: string | null; expires_at: number }>();
  if (!r || r.expires_at <= now) return null;
  return { kind: r.kind, email: r.email.toLowerCase(), societyId: r.society_id };
}
export async function endSession(env: Env, token: string | null, now: number = Date.now()): Promise<void> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  const id = await sha256Hex(env.PEPPER + "|" + token);
  const r = await env.DB.prepare("SELECT kind, email, society_id FROM sessions WHERE id = ?").bind(id).first<{ kind: "staff" | "member"; email: string; society_id: string | null }>();
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  if (r) await auditSession(env, r.kind, r.email.toLowerCase(), r.society_id, "signed_out", now);
}
