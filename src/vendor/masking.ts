// Masking of personal data (Amendment A6) and the scanner that proves no complete e-mail or phone number is left in public output.
const stars = (n: number) => "*".repeat(Math.max(1, n));

/** The owner's rules for what anyone but the Organizer/Hosts may see. The number of stars never depends on the real length, so the length leaks nothing. */
const STARS = "*".repeat(6);

/** jane.example@example.com -> ********mple@example.com (the last 4 letters of the part before @, then the whole domain). Short names show fewer letters. */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1 || /\s/.test(e)) return "********@****";
  const local = Array.from(e.slice(0, at)), domain = e.slice(at + 1);
  const show = Math.min(4, Math.max(1, Math.floor(local.length / 2)));
  return "********" + local.slice(local.length - show).join("") + "@" + domain;
}

/** 9876543210 -> ******3210 (only the last 4 digits; a leading 91 on a 12-digit number is dropped) */
export function maskPhone(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length < 6) return "******";
  return "*".repeat(d.length - 4) + d.slice(-4);
}

/** Rajat Agarwal -> Raj****** Aga****** (first 3 letters of the first name, of the middle name if any, and of the last name; a part of 3 letters or fewer shows 1 letter). */
export function maskName(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "*";
  const pick = w.length <= 2 ? w : [w[0]!, w[1]!, w[w.length - 1]!]; // first, middle (the second word), last
  return pick.map((x) => { const c = Array.from(x); return c.slice(0, c.length <= 3 ? 1 : 3).join("") + STARS; }).join(" ");
}

export interface ScanOptions {
  /** Exact public strings (e.g. a 10-digit registration number) that are allowed to appear. */
  allow?: string[];
  /** Known private values (full e-mails, phones, names). None of them may appear, case-insensitively. */
  forbidden?: string[];
}
export interface ScanFinding { kind: "email" | "phone" | "forbidden"; sample: string }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_SHAPES: RegExp[] = [
  /(?<![\w])\+?91[\s-]?\d{5}[\s-]?\d{5}(?![\w])/g, // +91 98765 43210
  /(?<![\w-])\d{5}[\s-]\d{5}(?![\w-])/g, // 98765 43210
  /(?<![\w-])\d{3}[\s-]\d{3}[\s-]\d{4}(?![\w-])/g, // 987-654-3210
  /(?<!\d)91\d{10}(?!\d)/g, // 919876543210
  /(?<!\d)0\d{10}(?!\d)/g, // 09876543210 (trunk prefix)
  /(?<!\d)\d{10}(?!\d)/g, // 9876543210
];
/** Hashes, signatures and ids are long opaque tokens; they can contain runs of digits by chance, so they are not phone numbers. */
const OPAQUE = /[A-Za-z0-9_-]{14,}/g;
/** A run of 11+ hex characters / digits that includes at least one hex LETTER (an id or hash fragment). Real phone numbers have no letters. */
const HEXID = /(?<![A-Za-z0-9_-])(?=[0-9a-fA-F_-]*[a-fA-F])[0-9a-fA-F_-]{11,}(?![A-Za-z0-9_-])/g;

export function scanPublic(text: string, opt: ScanOptions = {}): ScanFinding[] {
  const out: ScanFinding[] = [];
  let t = text;
  for (const a of opt.allow ?? []) if (a) t = t.split(a).join(" ");
  for (const m of t.matchAll(EMAIL)) if (t[(m.index ?? 0) - 1] !== "*") out.push({ kind: "email", sample: m[0] }); // ********mple@example.com is the masked form
  // opaque tokens that contain a letter are ids/hashes; pure digit tokens (13-digit timestamps) are numbers, kept visible only if exactly 10 or 12 digits
  const stripped = t.replace(OPAQUE, (tok) => (/[A-Za-z]/.test(tok) || /^\d{13,}$/.test(tok) ? " " : tok));
  const strippedHex = stripped.replace(HEXID, " "); // short id fragments such as 1234567890ed (digits then hex letters) are ids, not phone numbers
  for (const re of PHONE_SHAPES) for (const m of strippedHex.match(re) ?? []) out.push({ kind: "phone", sample: m });
  const low = text.toLowerCase();
  for (const f of opt.forbidden ?? []) if (f && low.includes(f.toLowerCase())) out.push({ kind: "forbidden", sample: f });
  return out;
}
