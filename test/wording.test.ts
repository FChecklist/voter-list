// Owner decisions of 24 Nov 2026: no "my / mine / your / yours" in any text people read, and "host" reads "co-organizer".
// The scan reads the string literals of the page scripts and the server (labels, errors, mail templates, PDF/CSV text), skipping comments.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/** The string literals of a JS/TS source, with comments skipped. */
export function literals(src: string): string[] {
  const out: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1; let buf = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { buf += src.slice(j, j + 2); j += 2; continue; } if (c !== "`" && src[j] === "\n") break; buf += src[j]; j++; }
      out.push(c === "`" ? buf.replace(/\$\{[^}]*\}/g, " ") : buf); i = j + 1; continue;
    }
    i++;
  }
  return out;
}

/** Each string literal with the few characters just before its opening quote (to see a `label:` or `text:` field name). */
export function literalsWithContext(src: string): { text: string; before: string }[] {
  const all = literals(src); const out: { text: string; before: string }[] = []; let from = 0;
  for (const t of all) {
    // find this literal in the source after the previous one; fall back to no context if it cannot be found
    const raw = t.replace(/\$\{[^}]*\}/g, "");
    const at = raw ? src.indexOf(raw, from) : -1;
    if (at < 0) { out.push({ text: t, before: "" }); continue; }
    out.push({ text: t, before: src.slice(Math.max(0, at - 30), at - 1) }); from = at + raw.length;
  }
  return out;
}
/** A one-word "host" used as the value of a field that people read. */
export const SHOWN_FIELD = /\b(label|title|text|placeholder)\s*:\s*$/;

/** Every .js/.ts file under a folder, skipping vendor and node_modules. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "vendor" || e.name === "node_modules") continue;
    const p = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...walk(p)); else if (/\.(js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}
const HINDI_FILE = "public/assets/lang/hi.js";
// English rules apply to every English file; the Hindi file has its own rule below.
export const files = [...walk("public/assets"), ...walk("src")].filter((f) => f !== HINDI_FILE);

const POSSESSIVE = /\b(my|mine|your|yours)\b/i;
// Allow-list: literal text that is not shown to people. Each entry needs a reason.
const ALLOW_POSSESSIVE: { file: string; text: RegExp; why: string }[] = [];
// Allow-list for "host": stored role values, SQL, internal names and the configured standing address are not read by people.
const HOST_WORD = /\bhosts?\b/i;
const INTERNAL_TOKENS = new Set(["host", "hosts", "permanentHostEmail", "hostsUsed", "hosts_skipped", "actor_role", "PERMANENT_HOST", "host@townhall-records.com"]);
export const isInternalHost = (s: string) => INTERNAL_TOKENS.has(s) || /^team\.host_\w+$/.test(s) || /^(SELECT|INSERT|UPDATE|DELETE) /.test(s);

describe("wording: neutral, short, imperative", () => {
  test("the scan itself finds literals and skips comments", () => {
    expect(literals('const a = "your x"; // "my y"\n/* "mine" */ const b = `z ${q} yours`;')).toEqual(["your x", "z   yours"]);
  });

  test("no my / mine / your / yours in any user-facing string literal", () => {
    const found: string[] = [];
    for (const f of files) for (const s of literals(readFileSync(f, "utf8"))) {
      if (POSSESSIVE.test(s) && !ALLOW_POSSESSIVE.some((a) => a.file === f && a.text.test(s))) found.push(f + ": " + s.slice(0, 90));
    }
    expect(found).toEqual([]);
  });

  test("the page HTML has no my / mine / your / yours either", () => {
    for (const f of ["public/index.html", "public/v/index.html", "public/terms/index.html"]) expect(POSSESSIVE.test(readFileSync(f, "utf8").replace(/<[^>]*>/g, " ")), f).toBe(false);
  });

  test("the word host reads co-organizer wherever people read it", () => {
    const found: string[] = [];
    for (const f of files) for (const { text: s, before } of literalsWithContext(readFileSync(f, "utf8"))) if (HOST_WORD.test(s) && (!isInternalHost(s) || SHOWN_FIELD.test(before))) found.push(f + ": " + s.slice(0, 90));
    expect(found).toEqual([]);
  });

  test("the scan covers sub-folders and skips vendor", () => {
    expect(files).toContain("public/assets/steps.js");
    expect(files.some((f) => f.startsWith("src/"))).toBe(true);
    expect(files.some((f) => /vendor|node_modules/.test(f))).toBe(false);
    expect(walk("public/assets")).toContain(HINDI_FILE);
  });

  test("the host check exempts only internal tokens and SQL", () => {
    for (const ok of ["host", "team.host_added", "permanentHostEmail", "hostsUsed", "PERMANENT_HOST", "SELECT * FROM hosts"]) expect(isInternalHost(ok), ok).toBe(true);
    for (const bad of ["Please select a host", "Ask the host", "the host UPDATE", "hosts can see it", "Select the host"]) expect(isInternalHost(bad), bad).toBe(false);
  });

  test("a one-word host in a label, title, text or placeholder field is not exempt", () => {
    const ctx = (src: string) => literalsWithContext(src).map((l) => HOST_WORD.test(l.text) && (!isInternalHost(l.text) || SHOWN_FIELD.test(l.before)));
    expect(ctx('const a = { label: "Host" };')).toEqual([true]);
    expect(ctx("const a = { title: 'host' };")).toEqual([true]);
    expect(ctx('x({ placeholder : "host", text: "hosts" })')).toEqual([true, true]);
    expect(ctx('const r = { role: "host" }; if (m.role === "host") {}')).toEqual([false, false]);
  });

  test("the Hindi file has no personal possessives", () => {
    const hi = readFileSync(HINDI_FILE, "utf8");
    expect(/(मेरा|मेरी|मेरे|आपका|आपकी|आपके|तुम्हारा|तुम्हारी|अपना|अपनी|अपने)/.test(hi)).toBe(false);
    expect(POSSESSIVE.test(hi.split("\n").filter((l) => /^\s*"/.test(l)).map((l) => l.slice(0, l.indexOf('": "'))).join("\n"))).toBe(false);
  });
});
