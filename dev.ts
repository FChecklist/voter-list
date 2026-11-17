// Local development server: the real API handler on a local SQLite file, static files from public/. TEST_MODE only. Never deploy this.
//   bun run gen:keys && bun run dev   (then open http://localhost:8787 )   Codes that would be e-mailed appear at /dev/code?to=<email>
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { makeD1 } from "./src/db-sqlite";
import { handle } from "./src/handler";
import type { Env } from "./src/db";

const vars: Record<string, string> = {};
if (existsSync(".dev.vars")) for (const l of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) vars[m[1]!] = m[2]!; }
if (!vars.SIGNING_KEY || !vars.PEPPER) { console.error("No .dev.vars yet. Run:  bun run gen:keys"); process.exit(1); }
const file = process.env.VL_DB ?? ".local/voter-list.sqlite";
mkdirSync(dirname(file), { recursive: true });
const { db, raw } = makeD1(file);
const env: Env = { DB: db, SIGNING_KEY: vars.SIGNING_KEY, PEPPER: vars.PEPPER, TEST_MODE: "1", PRICE_INR: vars.PRICE_INR };
const port = Number(process.env.PORT ?? 8787);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/dev/code") { // dev only: the latest sign-in code that would have been e-mailed
      const to = (url.searchParams.get("to") ?? "").toLowerCase();
      const r = raw.query("SELECT body FROM mail_outbox WHERE to_addr = ? AND kind LIKE 'otp-%' ORDER BY id DESC").get(to) as { body: string } | null;
      return Response.json({ code: r ? /\b(\d{6})\b/.exec(r.body)?.[1] ?? null : null });
    }
    if (url.pathname.startsWith("/api/")) return handle(req, env);
    let p = url.pathname;
    if (/^\/v\/[0-9a-f]{16}\/?$/.test(p)) p = "/v/index.html";
    if (p.endsWith("/")) p += "index.html";
    const full = normalize(join("public", p));
    if (!full.startsWith("public") || !existsSync(full)) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(full), { headers: { "content-type": TYPES[extname(full)] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});
console.log(`Voter List (TEST_MODE) on http://localhost:${port}  database: ${file}`);
