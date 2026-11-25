// The slice of Cloudflare D1 this application uses. The real D1 binding satisfies it; src/db-sqlite.ts provides a bun:sqlite stand-in
// that loads the SAME migrations (so triggers and constraints under test are the real ones).
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1 { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> }

export interface Env {
  DB: D1;
  /** Ed25519 private key (PKCS8, base64url) that signs the audit chain. Generate with `bun run gen:keys`. */
  SIGNING_KEY: string;
  /** Secret mixed into session and code hashes. */
  PEPPER: string;
  /** "1" only on a developer machine: relaxes Secure cookies, exposes the test payment confirm, never sends real mail. */
  TEST_MODE?: string;
  /** Meetings (notice, agenda, motions, minutes) stay dark until this is "1": every Meetings address answers "not found" without it. */
  MEETINGS_ENABLED?: string;
  /** The older mail route (Resend). Used only when the Cloudflare Email Service secrets below are not set. */
  RESEND_API_KEY?: string;
  /** Cloudflare Email Service (sending from townhall-records.com): an API token allowed to send, and the account id. Both set = this route is used. */
  CF_EMAIL_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** E-mail IDs (comma separated) allowed to start lists as brand-new Organizers. Needed in production unless OPEN_SIGNUP is "1". */
  ORGANIZERS?: string;
  /** Cloudflare Turnstile (free). Both set = codes are sent only after the check was passed. The site key is public; the secret is not. */
  /** Set by the Pages entry file: lets a request finish its slow work (the mail) after the answer went out, so every answer takes the same time. */
  waitUntil?: (p: Promise<unknown>) => void;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Newcomer codes a list may use a day (default 25). */
  MAIL_LIST_CAP?: string;
  /** "1" lets anyone become an Organizer (a developer machine, or an owner who has put the Turnstile check in place). */
  OPEN_SIGNUP?: string;
  /** The standing Townhall Records host seat on every list. Default host@townhall-records.com. */
  PERMANENT_HOST_EMAIL?: string;
  /** Records are kept always. Only if this is set (days, at least 30) may the Organizer erase a list's personal data after that many days. Leave it unset unless a lawyer advises otherwise. */
  RETENTION_DAYS?: string;
  MAIL_FROM?: string;
  MAIL_DAILY_CAP?: string;
  /** Mails a day kept back for staff (sign-in codes and invitations): member codes may use only the rest of MAIL_DAILY_CAP. Default 20. */
  MAIL_STAFF_RESERVE?: string;
  /** Rupees for "Save as Version 1". Unset = not confirmed by the owner = saving is free. Charging also needs PAY_SERVICE_KEY and PAY_SITE (the central payment service); without them nothing real is ever charged. */
  PRICE_INR?: string;
  /** Secret. This site's key for the central payment service of IT SERVICES BY RAJAT AGARWAL (header x-site-key). Never in the repository. */
  PAY_SERVICE_KEY?: string;
  /** This site's registered host in the central ledger, for example voterlist.townhall-records.com (the central service looks a site up by that host). */
  PAY_SITE?: string;
  /** The central payment service. Default https://itservices-rajat-agarwal.pages.dev */
  PAY_SERVICE_URL?: string;
  /** Dollars for "Save as Version 1" (shown to societies outside India). Unset = not confirmed by the owner. */
  PRICE_USD?: string;
  /** "1" switches Elections on. Anything else (the default) and every Elections address answers "not found": the product stays dark until the owner decides. */
  ELECTIONS_ENABLED?: string;
  /** Results (declared results of closed meetings and elections) stay dark until this is "1": every Results address answers "not found" without it. */
  RESULTS_ENABLED?: string;
}

export const uid = (prefix: string) => `${prefix}_${[...globalThis.crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Run statements in chunks so one request never exceeds the per-batch limits of D1; the caller keeps atomicity by writing into a new draft and switching a pointer last. */
export async function batchChunked(db: D1, stmts: D1Stmt[], size = 80): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}
