// Plain cleaning of the values people type or paste. Every function is pure and returns what it did, so the import can say
// exactly what it mended ("42 mobile numbers written in a tidier form") instead of changing data silently.

export type Capacity = "Owner" | "Co-owner" | "Tenant" | "Proxy" | "Member";
export const CAPACITIES: Capacity[] = ["Owner", "Co-owner", "Tenant", "Proxy", "Member"];
/** What a person sees for a capacity (the owner's wording, 14 Nov 2026). The stored value stays "Owner"; only the words people read change, in the pages, lists, exports and e-mails. */
export const CAPACITY_LABEL: Record<Capacity, string> = { Owner: "Owner / 1st Name in Registration", "Co-owner": "Co-owner", Tenant: "Tenant", Proxy: "Proxy", Member: "Member" };
export const capLabel = (c: string | null | undefined): string => (c && (CAPACITY_LABEL as Record<string, string>)[c]) || c || "";

/** NFC, odd spaces and zero-width marks removed, runs of white space folded to one space, trimmed. */
export function squeeze(s: unknown): string {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/[  -   　\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Excel hands numbers over as 9.0000001E9 or 9000000101.0; undo that without guessing at anything else. */
export function undoSpreadsheetNumber(s: string): string {
  const t = s.trim();
  if (/^\d+\.0+$/.test(t)) return t.replace(/\.0+$/, "");
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && n < 1e16) return BigInt(Math.round(n)).toString();
  }
  return t;
}

/** Comparison key for a flat / house / member id: A-101, a 101, A/101 and A101 are the same unit. */
export function unitKey(s: string): string {
  return squeeze(s).toUpperCase().replace(/[\s\-_/.\\]+/g, "");
}

/** The display form of an id: squeezed, and the 'a 101' habit of lower case letters tidied to upper case when it is short. */
export function unitDisplay(s: string): string {
  const t = squeeze(undoSpreadsheetNumber(squeeze(s)));
  return t.length <= 12 ? t.toUpperCase() : t;
}

const SMALL = new Set(["of", "de", "da", "di", "bin", "bint", "al", "van", "von"]);
/** Title case ONLY when the whole name is upper case or lower case (shouted or lazily typed); a mixed-case name is left alone. */
export function cleanName(s: string): { value: string; mended: boolean } {
  const t = squeeze(s).replace(/^[\s.,;:'"\-_*#]+|[\s,;:'"\-_*#]+$/g, "");
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 3 && !/[^\x00-\x7F]/.test(t) && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    const v = t.toLowerCase().replace(/(^|[\s'\-.])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
    const w = v.split(" ").map((x, i) => (i > 0 && SMALL.has(x.toLowerCase()) ? x.toLowerCase() : x)).join(" ");
    return { value: w, mended: w !== t };
  }
  return { value: t, mended: t !== s };
}

export interface Cleaned<T> { value: T; ok: boolean; mended: boolean; problem?: string }

/** India: ten digits starting 6-9 (a +91 / 91 / 0 prefix is removed). Elsewhere: 7 to 15 digits, kept as digits. */
export function cleanMobile(s: string, country = "India"): Cleaned<string> {
  const raw = squeeze(undoSpreadsheetNumber(squeeze(s)));
  if (!raw) return { value: "", ok: false, mended: false, problem: "missing" };
  let d = raw.replace(/[\s().\-]/g, "");
  if (!/^\+?\d+$/.test(d)) return { value: raw, ok: false, mended: false, problem: "not a number" };
  d = d.replace(/^\+/, "").replace(/^00/, "");
  if (country === "India") {
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    const ok = /^[6-9]\d{9}$/.test(d);
    return { value: ok ? d : raw, ok, mended: ok && d !== raw, problem: ok ? undefined : "an Indian mobile number has ten digits and starts with 6, 7, 8 or 9" };
  }
  const ok = d.length >= 7 && d.length <= 15;
  return { value: ok ? d : raw, ok, mended: ok && d !== raw, problem: ok ? undefined : "a mobile number has 7 to 15 digits" };
}

const EMAIL_RE = /^[a-z0-9._%+'\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/i;
export function cleanEmail(s: string): Cleaned<string> {
  const raw = squeeze(s);
  if (!raw) return { value: "", ok: false, mended: false, problem: "missing" };
  if ((raw.match(/@/g) ?? []).length > 1) return { value: raw, ok: false, mended: false, problem: "two e-mail IDs in one box" };
  const v = raw.replace(/^mailto:/i, "").replace(/^<|>$/g, "").replace(/[.,;:]+$/g, "").toLowerCase();
  const ok = EMAIL_RE.test(v) && v.length <= 120 && !v.includes("..") && !v.startsWith(".");
  return { value: ok ? v : raw, ok, mended: ok && v !== raw, problem: ok ? undefined : "does not look like an e-mail ID" };
}

export function parseCapacity(s: string): Capacity | null {
  const t = squeeze(s).toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (["owner", "ownerstnameinregistration", "o", "own", "flatowner", "houseowner", "primaryowner", "firstowner", "landlord"].includes(t)) return "Owner";
  if (["coowner", "co", "jointowner", "secondowner", "joint", "coown"].includes(t)) return "Co-owner";
  if (["tenant", "t", "renter", "rent", "lessee", "tenants"].includes(t)) return "Tenant";
  if (["proxy", "p", "authorisedproxy", "authorizedproxy", "proxyholder", "representative"].includes(t)) return "Proxy";
  if (["member", "m", "associatemember", "shareholder", "ordinarymember"].includes(t)) return "Member";
  return null;
}

/** Yes / No in the ways people write them. null = blank, undefined = not understood. */
export function parseYesNo(s: unknown): boolean | null | undefined {
  const t = squeeze(s).toLowerCase();
  if (!t) return null;
  if (["yes", "y", "true", "1", "t", "ok", "✓", "✔", "haan", "ha"].includes(t)) return true;
  if (["no", "n", "false", "0", "f", "nahi", "nahin", "-"].includes(t)) return false;
  return undefined;
}

/** A weight such as 1, 2, 1.5, "1,000" -> thousandths. Blank -> null. Not a positive number -> undefined. */
export function parseWeight(s: unknown): number | null | undefined {
  let t = squeeze(undoSpreadsheetNumber(squeeze(s)));
  if (!t) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(",", "."); // 2,5 written the European way
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return undefined;
  const milli = Math.round(parseFloat(t) * 1000);
  if (!(milli > 0) || milli > 1_000_000_000) return undefined; // weight 1 million is the ceiling
  return milli;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const validDate = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** ISO, dd/mm/yyyy (India reads day first), dd-mm-yy, '6 Nov 2026', or an Excel serial. null = blank, undefined = not understood. */
export function parseDate(s: unknown): string | null | undefined {
  const t = squeeze(undoSpreadsheetNumber(squeeze(s)));
  if (!t) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) return validDate(+m[1]!, +m[2]!, +m[3]!) ? iso(+m[1]!, +m[2]!, +m[3]!) : undefined;
  if ((m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(t))) { const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!; return validDate(y, +m[2]!, +m[1]!) ? iso(y, +m[2]!, +m[1]!) : undefined; }
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(t))) { const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1; return mo && validDate(+m[3]!, mo, +m[1]!) ? iso(+m[3]!, mo, +m[1]!) : undefined; }
  if (/^\d{5}$/.test(t)) { const n = +t; if (n >= 30000 && n <= 60000) { const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); } }
  return undefined;
}

/** Levenshtein distance, capped (early exit above `max`). */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v); if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** For comparing people: lower case, letters and digits only, honorific words dropped, word order ignored. */
export function nameKey(s: string): string {
  return squeeze(s).toLowerCase().replace(/\b(mr|mrs|ms|miss|dr|shri|smt|sri|shrimati|prof|late)\b\.?/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).sort().join(" ");
}
