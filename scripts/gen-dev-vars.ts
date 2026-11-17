// Writes .dev.vars with FRESH random local secrets (the file is gitignored). Never prints a secret. Run once per machine.
import { existsSync, writeFileSync } from "node:fs";
import { generateSigningKey, randomHex } from "../src/vendor/crypto";
const p = ".dev.vars";
if (existsSync(p)) { console.log(p + " already exists; leaving it alone"); process.exit(0); }
const k = await generateSigningKey();
writeFileSync(p, [`SIGNING_KEY=${k.privateKeyPkcs8}`, `PEPPER=${randomHex(32)}`, `TEST_MODE=1`, ``].join("\n"));
console.log("wrote " + p + " (local test secrets; TEST_MODE=1; not for production)");
