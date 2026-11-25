// Helpers for the wording scans (not a test file). They read source files and pages and find the text people read.
// Used by test/attendance-round7.test.ts. test/wording.test.ts keeps its own copy of the first scanner so that file stays as it was.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The one sentence the owner allows to contain "your" (exact words, exact full stop). */
export const ALLOWED_SENTENCE = "Copy this link and paste in your AI to work.";
const POSSESSIVE = /\b(my|mine|your|yours)\b/gi;
/** Every my / mine / your / yours in a text, after the one allowed sentence is taken out. */
export const possessivesIn = (text: string): string[] => text.split(ALLOWED_SENTENCE).join(" ").match(POSSESSIVE) ?? [];

/**
 * The string literals of a JS or TS source, comments skipped. Unlike a plain scan, a template literal is read properly: the text parts are one literal
 * (with each ${...} replaced by a space) and any literal inside a ${...} is found too, so `${ok ? "your" : "the"}` cannot hide a word.
 */
export function stringLiterals(src: string, raw = false): string[] {
  const out: string[] = [];
  let i = 0;
  const skipComment = (): boolean => {
    if (src[i] === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; return true; }
    if (src[i] === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; return true; }
    return false;
  };
  const quoted = (q: string): void => { // at the opening quote of a ' or " string
    let j = i + 1, b = "";
    while (j < src.length && src[j] !== q) { if (src[j] === "\\") { b += src.slice(j, j + 2); j += 2; continue; } if (src[j] === "\n") break; b += src[j]; j++; }
    out.push(b); i = j + 1;
  };
  const template = (): void => { // at the opening backtick
    i++; let b = "";
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { b += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") { const from = i + 2; i = from; expression(); b += raw ? "${" + src.slice(from, i - 1) + "}" : " "; continue; }
      b += src[i]; i++;
    }
    out.push(b); i++;
  };
  const expression = (): void => { // inside ${ ... }: read until its closing brace, finding literals on the way
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (skipComment()) continue;
      const c = src[i]!;
      if (c === '"' || c === "'") { quoted(c); continue; }
      if (c === "`") { template(); continue; }
      if (c === "{") depth++; else if (c === "}") depth--;
      i++;
    }
  };
  while (i < src.length) {
    if (skipComment()) continue;
    const c = src[i]!;
    if (c === '"' || c === "'") quoted(c); else if (c === "`") template(); else i++;
  }
  return out;
}

/** Every file under `dir` whose name matches `pattern`, skipping node_modules. */
export function filesUnder(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, pattern)); else if (pattern.test(name)) out.push(p);
  }
  return out.sort();
}

/** What people read in a page: its visible text and the attributes that carry words (placeholder, title, aria-label, alt, content). Scripts and styles are left out. */
export function pageTexts(html: string): string[] {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const attrs = [...body.matchAll(/\s(?:placeholder|title|aria-label|alt|content)="([^"]*)"/gi)].map((m) => m[1]!);
  return [body.replace(/<[^>]*>/g, " "), ...attrs];
}

/** The literals inside the parentheses of every call that matches `callee` (a call may nest others). With `raw`, a ${...} in a template stays as written. */
export function callLiterals(src: string, callee: RegExp, raw = false): string[] {
  const out: string[] = [];
  const re = new RegExp(callee.source + "\\s*\\(", "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[0].length, depth = 1; const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (c === '"' || c === "'" || c === "`") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } }
      else if (c === "(") depth++; else if (c === ")") depth--;
      i++;
    }
    out.push(...stringLiterals(src.slice(start, i - 1), raw));
  }
  return out;
}

/** The sentence-like messages among some literals: they start with a capital letter, have a space and end with . ? or !  (a ${MAX_ROWS} left in a template is read as 6000). */
export const sentences = (lits: string[]): string[] => lits.map((s) => s.replace(/\$\{MAX_ROWS\}/g, "6000")).filter((s) => /^[A-Z][^]* [^]*[.?!]$/.test(s) && s.length > 12);

export const read = (p: string) => readFileSync(p, "utf8");
