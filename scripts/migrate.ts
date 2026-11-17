// Apply every pending migration to a local SQLite file:  bun run scripts/migrate.ts [file]   (default .local/voter-list.sqlite)
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeD1 } from "../src/db-sqlite";
const file = process.argv[2] ?? ".local/voter-list.sqlite";
mkdirSync(dirname(file), { recursive: true });
const { raw } = makeD1(file); // makeD1 runs the migrations
console.log("migrated " + file + ": " + (raw.query("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }).n + " migration(s) recorded");
