// bun:sqlite stand-in for D1 (local development, seed script, tests). Never imported by the Worker.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1, D1Stmt } from "./db";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
export const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

/** Apply every not-yet-applied migration, in order, each in one transaction, recording it in _migrations (like `wrangler d1 migrations`). */
export function migrate(raw: Database): string[] {
  raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((raw.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of migrationFiles()) {
    if (done.has(f)) continue;
    raw.exec("BEGIN");
    try { raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8")); raw.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now()); raw.exec("COMMIT"); applied.push(f); }
    catch (e) { raw.exec("ROLLBACK"); throw new Error(`migration ${f} failed: ${(e as Error).message}`); }
  }
  return applied;
}

export function makeD1(path = ":memory:"): { db: D1; raw: Database } {
  const raw = new Database(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = " + (path === ":memory:" ? "MEMORY" : "WAL") + ";");
  migrate(raw);
  type S = D1Stmt & { _sql: string; _vals: unknown[] };
  const mk = (sql: string, vals: unknown[] = []): S => ({
    _sql: sql, _vals: vals,
    bind: (...v: unknown[]) => mk(sql, v),
    run: async () => { const r = raw.query(sql).run(...(vals as never[])); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
    all: async <T = Record<string, unknown>>() => ({ results: raw.query(sql).all(...(vals as never[])) as T[] }),
    first: async <T = Record<string, unknown>>() => (raw.query(sql).get(...(vals as never[])) as T | null) ?? null,
  });
  const db: D1 = {
    prepare: (s) => mk(s),
    batch: async (xs) => { // atomic, like D1: all or nothing
      raw.exec("BEGIN");
      try { const out = xs.map((x) => { const s = x as S; const r = raw.query(s._sql).run(...(s._vals as never[])); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }); raw.exec("COMMIT"); return out; }
      catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
  return { db, raw };
}
