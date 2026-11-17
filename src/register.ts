// The printable register (PDF) and the CSV export. Names, mobiles and e-mail IDs are shown in the short, masked form unless the caller is an
// organizer who asked for the full export (which the application records in the signed log). Pure functions: rows in, bytes out.
import { toCsv } from "./csv";
import { fmtMilli, shortFingerprint, type UnitResult } from "./checks";
import { ruleOf, type ListRow } from "./model";
import { Doc } from "./vendor/pdfdoc";
import { capLabel } from "./text";
import { maskEmail, maskName, maskPhone } from "./vendor/masking";

export interface RegisterMeta {
  society: string; kind: string; state: string; country: string; regNo: string; regOffice: string;
  title: string; versionLabel: string; ruleCode: number; weightMode: string; duesCutoff: string | null;
  fingerprint: string; publishedAt?: number | null; correctionDeadline?: string | null; tzOffsetMin?: number; event?: { name: string; type: string; date: string } | null;
}
export interface RegisterLine { unit: string; name: string; capacity: string; mobile: string; email: string; voter: boolean; weightMilli: number; canVote: boolean; canAttend: boolean; note: string; reason: string }

export const fmtDate = (ms: number, tz = 330) => { const d = new Date(ms + tz * 60_000); return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const fmtIso = (iso: string) => { const [y, m, d] = iso.split("-").map(Number) as [number, number, number]; return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`; };


export function registerCsv(meta: RegisterMeta, lines: RegisterLine[], full: boolean): string {
  const head = [["Register of voters", meta.society, meta.versionLabel, full ? "FULL DETAILS: for the society's own use" : "Names, mobiles and e-mail IDs are shown in a short form to keep them private"], ["Fingerprint", meta.fingerprint], []];
  const rows = lines.map((l, i) => [i + 1, l.unit, l.name, l.capacity, l.mobile, l.email, l.voter ? "Yes" : "No", l.voter ? fmtMilli(l.weightMilli) : "", l.voter ? (l.canVote ? "Yes" : "No") : "", l.voter ? (l.canAttend ? "Yes" : "No") : "", l.reason, l.note]);
  return toCsv([...head, ["No", "Flat / House / Member ID", "Name", "Capacity", "Mobile", "E-mail", "Authorized to vote", "Weight (of the flat)", "May vote", "May attend", "Reason (if not allowed to vote)", "Note"], ...rows]);
}

export function registerPdf(meta: RegisterMeta, lines: RegisterLine[], totals: { units: number; voters: number; canVote: number; weightMilli: number }, full: boolean): Uint8Array {
  const doc = new Doc(`${meta.society} | ${meta.versionLabel} | fingerprint ${shortFingerprint(meta.fingerprint)} | ${full ? "full details" : "masked"}`);
  doc.text(meta.title, { size: 16, font: "F2", gap: 4 });
  doc.text(`${meta.society}  |  ${meta.kind}  |  ${[meta.state, meta.country].filter(Boolean).join(", ")}`, { size: 10 });
  if (meta.regNo) doc.text(`Registration number: ${meta.regNo}${meta.regOffice ? "  |  Registered with: " + meta.regOffice : ""}   (recorded as given by the society; not checked with the authority)`, { size: 8.5 });
  doc.text(`${meta.versionLabel}${meta.publishedAt ? "  |  published " + fmtDate(meta.publishedAt, meta.tzOffsetMin) : ""}`, { size: 10 });
  if (meta.event) doc.text(`Frozen for: ${meta.event.name} (${meta.event.type}) on ${fmtIso(meta.event.date)}`, { size: 10, font: "F2" });
  if (meta.correctionDeadline) doc.text(`Last date for correction requests: ${fmtIso(meta.correctionDeadline)}`, { size: 11, font: "F2" });
  doc.text(`Who may vote: ${ruleOf(meta.ruleCode).name}.  Weightage: ${meta.weightMode === "equal" ? "equal, 1 for each unit" : "unequal, each unit its own weight"}.${meta.duesCutoff ? "  Dues cleared on or before " + fmtIso(meta.duesCutoff) + "." : ""}`, { size: 9 });
  doc.text(`Units ${totals.units}  |  flats that may vote ${totals.canVote}  |  total weight of the flats that may vote ${fmtMilli(totals.weightMilli)} (Wt is the flat's weight, shown for each person authorized to vote)`, { size: 9 });
  doc.text(`Fingerprint: ${meta.fingerprint}`, { size: 7 });
  if (!full) doc.text("Names, mobile numbers and e-mail IDs are shown in a short form to keep them private. The full list is held by the society.", { size: 8 });
  doc.space(4);
  const hasReason = lines.some((l) => l.reason);
  const W = hasReason ? [20, 44, 86, 50, 62, 90, 22, 22, 100] : [24, 62, 118, 52, 74, 112, 28, 26];
  doc.row(hasReason ? ["No", "Unit", "Name", "Capacity", "Mobile", "E-mail", "Wt", "Vote", "Reason"] : ["No", "Unit", "Name", "Capacity", "Mobile", "E-mail", "Wt", "Vote"], W, { font: "F2", size: 8 }); doc.line();
  lines.forEach((l, i) => doc.row([String(i + 1), l.unit, l.name + (l.voter ? "" : " (not voting)"), l.capacity, l.mobile, l.email, l.voter ? fmtMilli(l.weightMilli) : "", l.voter ? (l.canVote ? "Yes" : "No") : "", ...(hasReason ? [l.reason] : [])], W, { size: 8 }));
  doc.space(10);
  doc.text("Prepared with Townhall Records. The signed record of every change to this list can be checked by anyone the society shares it with.", { size: 7.5 });
  return doc.bytes();
}

