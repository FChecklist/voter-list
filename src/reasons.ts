// Why a person is not allowed to vote: the short list the Organizer or a Host chooses from, the person's own words, and what each one may show publicly.
import { capLabel } from "./text";
import { scanPublic } from "./vendor/masking";

/** Phone numbers, e-mail IDs and links (also written with spaces, Hindi digits or "(at)") have no place in a reason. */
export const hasContact = (t: string): boolean => {
  if (scanPublic(t).length > 0) return true;
  if (/\S@\S|\(at\)|\[at\]|https?:|www\.|\b[\w-]+\.(com|in|org|net|co|me|io|ly|gl|app)\b/i.test(t)) return true;
  // a run of digits in any script, even with spaces, dashes, dots or brackets between them (a phone number); dates and amounts are far shorter
  const digits = t.replace(/\p{Nd}/gu, "0").replace(/(?<=0)[\s.\-()+]+(?=0)/g, "");
  return /0{10,}/.test(digits); // 10 or more digits: a mobile number (a landline written with a short code can slip through; accepted and documented)
};

export interface ReasonDef { code: string; label: string; text: string; role: boolean }
/** The list offered when someone is marked "not allowed". `role` reasons follow from who the person is (already shown in the Role column), so they may be shown publicly by default. */
export const REASONS: ReasonDef[] = [
  { code: "dues", label: "Dues unpaid", text: "Dues unpaid - not allowed to vote", role: false },
  { code: "tenant", label: "Tenant", text: "Tenant - not allowed to vote", role: true },
  { code: "coowner", label: "Co-owner, or not the 1st name", text: "Co-owner - not allowed to vote. Only the Owner / 1st name may vote", role: true },
  { code: "not_member", label: "Not a member of the society", text: "Not a member of the society - not allowed to vote", role: true },
  { code: "proxy_papers", label: "Proxy papers awaited", text: "Proxy papers awaited - not allowed to vote for now", role: false },
  { code: "other", label: "Another reason (I will write it)", text: "Not allowed to vote", role: false },
];
export const REASON_CODES = REASONS.map((r) => r.code);
export const NOTE_MAX = 120;

export type PublicMode = "none" | "role" | "all";
export const PUBLIC_MODES: PublicMode[] = ["none", "role", "all"];

/** What the person reads: the chosen reason, with their own words added (or alone for "another reason"). */
export function reasonText(code: string | null | undefined, note: string | null | undefined): string {
  const def = REASONS.find((r) => r.code === code);
  const n = (note ?? "").trim();
  if (!def) return n ? `${n} - not allowed to vote` : "";
  if (def.code === "other") return n ? `${n} - not allowed to vote` : def.text;
  return n ? `${def.text} (${n})` : def.text;
}

/** Kinds of "not allowed": the Organizer's or a Host's chosen reason, the voting rule, unpaid dues, or only waiting for the Organizer's choice. */
export type ReasonKind = "manual" | "rule" | "dues" | "pending";

/** Whether this reason may appear on the public list under the society's setting. */
export function publicOk(kind: ReasonKind, code: string | null | undefined, mode: PublicMode): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  if (kind === "rule" || kind === "pending") return true;
  if (kind === "dues") return false;
  return !!REASONS.find((r) => r.code === code)?.role; // a chosen reason: only the ones that follow from the role
}

/** Reason for a role the voting rule does not allow. */
export const ruleReason = (capacity: string | null | undefined): string => `${capLabel(capacity ?? "") || "This role"} - not allowed to vote under this list's rule`;
export const DUES_REASON = "Dues unpaid - not allowed to vote";
export const OTHER_CHOSEN = "Not chosen to vote for this flat - the Organizer has authorized another person of the flat";
export const PENDING_REASON = "Waiting for the Organizer to choose who may vote for this flat";

/** Reads a chosen reason from request fields: a known code, and the person's own words (needed for "another reason"). */
export function chooseReason(code: unknown, note: unknown): { code: string; note: string } | string {
  const c = typeof code === "string" ? code.trim() : "";
  if (!REASON_CODES.includes(c)) return "Please choose a reason from the list.";
  const n = typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";
  if (c === "other" && n.length < 3) return "Please write the reason in a few words.";
  if (hasContact(n)) return "This looks like a phone number, an e-mail ID or a link. Please leave those out of the reason (write long numbers with words between them).";
  return { code: c, note: n };
}

/** Maps what a sheet says (for example "dues unpaid" or "Tenant") to the list; anything else becomes "another reason" in the sheet's own words. */
export function reasonFromSheet(text: string): { code: string; note: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const k = t.toLowerCase().replace(/[^a-z]/g, "");
  // filler such as "na", "n/a", "nil", "none", "-", "ok" or anything under 3 letters says nothing: it is no reason
  if (t.replace(/[^\p{L}]/gu, "").length < 3 || /^(nil|none|null|nothing|noissue|notapplicable|blank|empty|okay|nope|unknown)$/.test(k)) return null;
  if (/^(dues|duesunpaid|unpaiddues|defaulter|arrears|maintenanceunpaid)/.test(k)) return { code: "dues", note: "" };
  if (/^tenant/.test(k)) return { code: "tenant", note: "" };
  if (/^(coowner|notfirstname|not1stname|secondname|jointowner)/.test(k)) return { code: "coowner", note: "" };
  if (/^(notmember|notamember|nonmember)/.test(k)) return { code: "not_member", note: "" };
  if (/^proxypapers/.test(k)) return { code: "proxy_papers", note: "" };
  const n = t.slice(0, NOTE_MAX);
  if (hasContact(n)) return { code: "other", note: "reason not given" }; // never keep contact details
  return { code: "other", note: n };
}
