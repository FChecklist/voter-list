// Writes NEW production secrets as JSON to a file OUTSIDE this repository, for:  wrangler pages secret bulk <file> --project-name voter-list
// It prints no secret. Keep the SIGNING_KEY backed up offline: it signs the audit trail and the final lists. Delete the file after the upload.
import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { generateSigningKey, randomHex } from "../src/vendor/crypto";
const out = process.argv[2];
if (!out) { console.error("Usage: bun run scripts/gen-prod-keys.ts <path outside the repo>"); process.exit(1); }
const rel = relative(resolve("."), resolve(out));
if (!rel.startsWith("..") || isAbsolute(rel)) { console.error("Refusing: the file must be outside this repository, so a secret can never be committed."); process.exit(1); }
if (existsSync(out)) { console.error("Refusing to overwrite " + out); process.exit(1); }
const k = await generateSigningKey();
writeFileSync(out, JSON.stringify({ SIGNING_KEY: k.privateKeyPkcs8, PEPPER: randomHex(32) }));
console.log("wrote " + out + " (new production secrets; not printed). Upload them, back up the file offline, then delete it.");
