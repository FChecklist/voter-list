// Reading an uploaded or pasted list: find the heading row, map the columns, clean every value, and report exactly what was mended.
// Nothing is guessed silently. A value that cannot be understood is kept as it was typed so the Organizer sees it in the Checks.
import { parseDelimited } from "./csv";
import { readXlsx } from "./xlsx";
import type { NewRow } from "./model";
import { reasonFromSheet } from "./reasons";
import { cleanEmail, cleanMobile, cleanName, parseCapacity, parseDate, parseWeight, parseYesNo, squeeze, unitDisplay, unitKey } from "./text";

export type Field = "unit" | "name" | "capacity" | "mobile" | "email" | "voter" | "weight" | "attend" | "vote" | "dues" | "reason";
export const FIELD_LABEL: Record<Field, string> = { unit: "Flat / House / Member ID", name: "Name", capacity: "Capacity", mobile: "Mobile", email: "E-mail", voter: "Authorized to vote", weight: "Weight", attend: "Allowed to attend", vote: "Allowed to vote", dues: "Dues paid on", reason: "Reason (if not allowed to vote)" };

/** Rows that were marked "authorized" only because they are alone in the sheet (not because the sheet said Yes). */
export const autoMarked = new WeakSet<object>();
const ALIASES: Record<Field, string[]> = {
  unit: ["id", "flatno", "flatnumber", "flat", "houseno", "housenumber", "house", "memberid", "memberno", "unit", "unitno", "unitid", "flathousememberid", "flathousememberidno", "flathouseno", "plot", "plotno", "flatid", "houseid", "apartment", "apt", "aptno", "flathouse", "unitnumber"],
  name: ["name", "ownername", "membername", "fullname", "votername", "nameofowner", "nameofmember", "resident", "residentname", "nameofvoter", "ownersname"],
  capacity: ["capacity", "type", "ownertype", "relation", "role", "occupancy", "ownership"],
  mobile: ["mobile", "mobileno", "mobilenumber", "phone", "phoneno", "phonenumber", "contact", "contactno", "contactnumber", "cell", "whatsapp", "mob"],
  email: ["email", "emailid", "emailaddress", "mail", "emailidofowner", "eid", "emailids"],
  voter: ["voter", "authorizedtovote", "authorisedtovote", "authorized", "authorised", "voterfortheunit", "isvoter", "votingmember", "voterforunit", "votes", "voterflag"],
  weight: ["weight", "weightage", "voteweightage", "votingweight", "wt", "voteweight", "weightageofvote"],
  attend: ["allowedtoattend", "attend", "canattend", "allowedattend"],
  vote: ["allowedtovote", "canvote", "votingright", "allowedvote"],
  reason: ["reason", "reasonifnotallowedtovote", "reasonnotallowed", "reasonfornotvoting", "whynotallowed", "notallowedreason", "reasonfornotallowed", "reasonwhynotallowed"],
  dues: ["duespaidon", "duespaid", "duesdate", "duespaiddate", "duespaidupto", "datedues"],
};
const LOOKUP = new Map<string, Field>();
for (const [f, as] of Object.entries(ALIASES) as [Field, string[]][]) for (const a of as) LOOKUP.set(a, f);

const norm = (h: string) => squeeze(h).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");

export interface HeaderMap { headerIndex: number; map: Partial<Record<Field, number>>; unknown: string[] }
/** Find the heading row among the first 12 rows (a template has a title and instructions above it) and map its columns. */
export function mapHeaders(rows: string[][]): HeaderMap {
  let best: HeaderMap | null = null, bestScore = 0;
  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const map: Partial<Record<Field, number>> = {}; const unknown: string[] = [];
    rows[i]!.forEach((h, c) => {
      const f = LOOKUP.get(norm(h));
      if (f && map[f] === undefined) map[f] = c; else if (squeeze(h)) unknown.push(squeeze(h));
    });
    const score = Object.keys(map).length + (map.unit !== undefined ? 1 : 0);
    if (map.unit !== undefined && score > bestScore) { best = { headerIndex: i, map, unknown }; bestScore = score; }
  }
  if (!best) throw new Error("We could not find the heading row. The first column should be called 'Flat / House / Member ID' (or 'ID'). Please use the template.");
  return best;
}

export interface RawRow { sourceRow: number; unit: string; name: string; capacity: string; mobile: string; email: string; voter: string; weight: string; attend: string; vote: string; dues: string; reason: string }

export interface Mend { kind: string; label: string; count: number }
export interface ImportProblem { row: number; field: Field; message: string }
export interface ParsedImport {
  format: "csv" | "xlsx" | "paste";
  rowsRead: number;
  rows: NewRow[];
  mapped: Field[];
  missingColumns: Field[];
  unknownColumns: string[];
  mends: Mend[];
  problems: ImportProblem[];
}

export async function readTable(input: { format: "csv" | "xlsx" | "paste"; text?: string; bytes?: Uint8Array }): Promise<string[][]> {
  if (input.format === "xlsx") {
    if (!input.bytes?.length) throw new Error("The Excel file is empty.");
    return readXlsx(input.bytes);
  }
  const text = input.text ?? "";
  if (!text.trim()) throw new Error("There is nothing to read. Please choose a file or paste the list.");
  return parseDelimited(text);
}

export function toRawRows(table: string[][], hm: HeaderMap): RawRow[] {
  const out: RawRow[] = [];
  // a leading apostrophe is the spreadsheet "this is text" mark (and what our own export writes before = + - @): not part of the value
  const g = (r: string[], f: Field) => (hm.map[f] === undefined ? "" : String(r[hm.map[f]!] ?? "").replace(/^'(?=[=+\-@\d])/, ""));
  for (let i = hm.headerIndex + 1; i < table.length; i++) {
    const r = table[i]!;
    if (!r.some((c) => squeeze(c))) continue;
    const row: RawRow = { sourceRow: i + 1, unit: g(r, "unit"), name: g(r, "name"), capacity: g(r, "capacity"), mobile: g(r, "mobile"), email: g(r, "email"), voter: g(r, "voter"), weight: g(r, "weight"), attend: g(r, "attend"), vote: g(r, "vote"), dues: g(r, "dues"), reason: g(r, "reason") };
    // a heading repeated further down (pasted twice, or at the top of each printed page)
    if (norm(row.unit) && LOOKUP.get(norm(row.unit)) === "unit" && LOOKUP.get(norm(row.name)) === "name") continue;
    out.push(row);
  }
  return out;
}

export interface NormalizeOptions { country: string; ruleCode: number }
const MAX_UNIT = 40, MAX_NAME = 120;

export function normalizeRows(raw: RawRow[], hm: HeaderMap, opt: NormalizeOptions): { rows: NewRow[]; mends: Mend[]; problems: ImportProblem[] } {
  const counts: Record<string, number> = {}; const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const problems: ImportProblem[] = [];
  const prob = (row: number, field: Field, message: string) => { if (problems.length < 200) problems.push({ row, field, message }); };
  const rows: NewRow[] = raw.map((r, i) => {
    const unit0 = squeeze(r.unit); const unit = unitDisplay(r.unit);
    if (unit.length > MAX_UNIT) prob(r.sourceRow, "unit", "The ID is too long (40 characters at most).");
    if (unit0 && unit !== unit0) bump("unit_tidy");
    const nm = cleanName(r.name); if (nm.mended && squeeze(r.name) !== nm.value && nm.value.toLowerCase() === squeeze(r.name).toLowerCase()) bump("name_case"); else if (nm.mended) bump("name_tidy");
    if (nm.value.length > MAX_NAME) prob(r.sourceRow, "name", "The name is too long (120 characters at most).");
    let capacity = parseCapacity(r.capacity);
    // a blank capacity is NOT guessed: guessing "Owner" could give a tenant a vote under an owner-only rule. It stays blank, the Checks ask for it, and one click fills them all.
    if (!squeeze(r.capacity)) { capacity = null; bump(hm.map.capacity === undefined ? "capacity_blank_nocol" : "capacity_blank"); }
    else if (!capacity) prob(r.sourceRow, "capacity", `Capacity "${squeeze(r.capacity).slice(0, 30)}" is not one of Owner / 1st Name in Registration, Co-owner, Tenant, Proxy, Member.`);
    else if (squeeze(r.capacity) !== capacity) bump("capacity_words");
    const mob = cleanMobile(r.mobile, opt.country); if (mob.mended) bump("mobile_format");
    const em = cleanEmail(r.email); if (em.mended) bump("email_format");
    let isVoter: boolean | null = null; const v = parseYesNo(r.voter);
    if (v === undefined) prob(r.sourceRow, "voter", `Authorized to vote says "${squeeze(r.voter).slice(0, 20)}". Please write Yes or leave it blank.`); else isVoter = v;
    let weightMilli: number | null = null; const w = parseWeight(r.weight);
    if (w === undefined) prob(r.sourceRow, "weight", `Weight "${squeeze(r.weight).slice(0, 20)}" is not a positive number such as 1 or 2.5.`); else weightMilli = w;
    let canAttend = true, canVote = true; const a = parseYesNo(r.attend), c = parseYesNo(r.vote);
    if (a === undefined) prob(r.sourceRow, "attend", "Allowed to attend should be Yes or No."); else if (a !== null) canAttend = a;
    if (c === undefined) prob(r.sourceRow, "vote", "Allowed to vote should be Yes or No."); else if (c !== null) canVote = c;
    // a reason for "not allowed to vote": it names the person as not allowed (said out loud in the report); it must agree with the Yes / No columns
    let noVoteReason: string | null = null, noVoteNote: string | null = null;
    const rs = reasonFromSheet(r.reason);
    if (rs) {
      if (v === true || c === true) prob(r.sourceRow, "reason", "A reason is given, but the sheet also says this person may vote. Please make the two agree.");
      else { noVoteReason = rs.code; noVoteNote = rs.note || null; if (v !== false && c !== false) { isVoter = false; bump("reason_marks"); } }
    }
    let duesPaidOn: string | null = null; const d = parseDate(r.dues);
    if (d === undefined) prob(r.sourceRow, "dues", `The date "${squeeze(r.dues).slice(0, 20)}" is not understood. Please write it as 15/11/2026.`); else { duesPaidOn = d; if (d && squeeze(r.dues) !== d) bump("date_format"); }
    return { rowNo: i + 1, unit, unitKey: unitKey(unit), name: nm.value, capacity: capacity ?? null, mobile: mob.value, email: em.value, isVoter, weightMilli, canAttend, canVote, duesPaidOn, noVoteReason, noVoteNote, sourceRow: r.sourceRow };
  });

  // one unit written two ways (A-101 / A 101): keep the commonest form
  const forms = new Map<string, Map<string, number>>();
  for (const r of rows) if (r.unitKey) { const m = forms.get(r.unitKey) ?? new Map<string, number>(); m.set(r.unit, (m.get(r.unit) ?? 0) + 1); forms.set(r.unitKey, m); }
  const canonical = new Map<string, string>();
  for (const [k, m] of forms) { let best = "", bc = -1; for (const [form, c] of m) if (c > bc) { best = form; bc = c; } canonical.set(k, best); }
  for (const r of rows) if (r.unitKey && r.unit !== canonical.get(r.unitKey)) { r.unit = canonical.get(r.unitKey)!; bump("unit_variants"); }

  // per unit: the voter and the weight
  const byUnit = new Map<string, NewRow[]>();
  for (const r of rows) if (r.unitKey) byUnit.set(r.unitKey, [...(byUnit.get(r.unitKey) ?? []), r]);
  for (const rs of byUnit.values()) {
    if (rs.length === 1) { if (rs[0]!.isVoter === null) { rs[0]!.isVoter = true; autoMarked.add(rs[0]!); bump("voter_single"); } continue; }
    const marked = rs.filter((r) => r.isVoter === true);
    // the people the sheet leaves unmarked stay undecided (the Organizer chooses); nobody is turned down without a reason
    const ws = new Set(rs.map((r) => r.weightMilli).filter((x): x is number => x !== null));
    if (ws.size === 1) { const only = [...ws][0]!; for (const r of rs) if (r.weightMilli === null) { r.weightMilli = only; bump("weight_inherit"); } }
  }

  const label: Record<string, string> = {
    unit_tidy: "IDs written in a tidier form (spaces and letter case)", unit_variants: "units that were written two ways and now read one way",
    name_case: "names written in capitals or in small letters now start with capital letters", name_tidy: "names tidied (stray spaces and marks)",
    capacity_blank: "blank capacities left blank (the Checks ask you to choose; one click can fill them all)", capacity_blank_nocol: "rows with no Capacity column left blank (the Checks ask you to choose; one click can fill them all)",
    capacity_words: "capacities written another way (such as 'owner' or 'tenant')", mobile_format: "mobile numbers written in a tidier form (no +91, spaces or dashes)",
    email_format: "e-mail IDs written in small letters and tidied", date_format: "dates read and written one way",
    reason_marks: "people with a reason written but no No in the Yes / No columns: marked not allowed to vote, with that reason",
    voter_single: "flats with one person: that person marked as authorized to vote (the Organizer's upload; the Organizer decides this)", weight_inherit: "co-owner lines given the same weight as their unit",
  };
  const mends: Mend[] = Object.entries(counts).map(([kind, count]) => ({ kind, label: label[kind] ?? kind, count })).sort((a, b) => b.count - a.count);
  return { rows, mends, problems };
}

export async function parseUpload(input: { format: "csv" | "xlsx" | "paste"; text?: string; bytes?: Uint8Array }, opt: NormalizeOptions): Promise<ParsedImport> {
  const table = await readTable(input);
  const hm = mapHeaders(table);
  const raw = toRawRows(table, hm);
  if (!raw.length) throw new Error("The heading row was found but there are no people below it.");
  if (raw.length > 6000) throw new Error("More than 6000 rows. Please split the list.");
  const { rows, mends, problems } = normalizeRows(raw, hm, opt);
  const mapped = Object.keys(hm.map) as Field[];
  const missingColumns = (["unit", "name", "mobile", "email"] as Field[]).filter((f) => hm.map[f] === undefined);
  return { format: input.format, rowsRead: raw.length, rows, mapped, missingColumns, unknownColumns: hm.unknown, mends, problems };
}
