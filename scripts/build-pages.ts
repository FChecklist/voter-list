// Copies public/ to dist/ and checks that no secret-looking text is in it. Deploy itself is manual (see README).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
rmSync("dist", { recursive: true, force: true }); mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
const bad = /BEGIN (RSA |EC )?PRIVATE|re_[A-Za-z0-9]{20,}|SIGNING_KEY=|PEPPER=/;
let n = 0;
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { n++; if (!/\.(png|ico)$/.test(f) && bad.test(readFileSync(p, "utf8"))) { console.error("secret-looking text in " + p); process.exit(1); } } } };
walk("dist");
console.log(`dist/ ready: ${n} files, no secret-looking text`);
