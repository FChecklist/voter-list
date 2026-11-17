// The checks: the whole rule book in one pure function. Errors stop a publish; warnings do not (they need one tick).
// Also computes who may vote, weights and shares, and the fingerprint of a list. No I/O here, so it is tested exhaustively.
import { canonical } from "./vendor/canonical";
import { sha256Hex } from "./vendor/crypto";
import { maskPhone } from "./vendor/masking";
import { EQUAL_WEIGHT, ruleOf, type ListRow, type Settings } from "./model";
import { DUES_REASON, OTHER_CHOSEN, PENDING_REASON, publicOk, reasonText, ruleReason, type PublicMode, type ReasonKind } from "./reasons";
import { capLabel, cleanEmail, cleanMobile, editDistance, nameKey } from "./text";

export type Severity = "error" | "warning";
export interface Issue {
  key: string;
  code: string;
  severity: Severity;
  unit: string;
  rowIds: number[];
  message: string;
  hint?: string;
  /** an action the application can offer as one button */
  fix?: { type: "remove_rows"; rowIds: number[] };
}

/** Whether one registered person may vote and, if not, why (the full reason, and the part the public list may show). */
export interface PersonStatus { rowId: number; allowed: boolean; kind: ReasonKind | ""; code: string; reason: string; publicReason: string; missing: boolean }
export interface UnitVoter { row: ListRow; canVote: boolean; canAttend: boolean; duesClear: boolean; reasons: string[] }
export interface UnitResult {
  unit: string;
  unitKey: string;
  rows: ListRow[];
  /** the people the Organizer has authorized to vote for this unit (none, one or several), each with their own rights */
  voters: UnitVoter[];
  /** every registered person of the unit: may vote or not, and why not */
  status: PersonStatus[];
  weightMilli: number;
  canAttend: boolean;
  canVote: boolean;
  why: string[];
  duesClear: boolean;
}

export interface Summary {
  rows: number;
  units: number;
  voters: number; // units with at least one person authorized to vote
  authorized: number; // people authorized to vote, in all units (a flat may have several)
  canVote: number; // units whose voter may vote under the rule, dues check and unit settings
  cannotVote: number;
  totalWeightMilli: number; // of the units that may vote
  allWeightMilli: number; // of every unit
  duesPending: number;
}
export interface CheckReport { issues: Issue[]; errors: number; warnings: number; byCode: Record<string, number>; summary: Summary; units: UnitResult[]; canPublish: boolean }

const MAX_PER_CODE = 400; // a 6000-row sheet with one wrong column must not produce 6000 lines of text

function dupKey(r: ListRow): string { return `${r.unitKey}|${nameKey(r.name)}|${r.mobile}|${r.email}`; }

export function runChecks(rows: ListRow[], s: Settings): CheckReport {
  const issues: Issue[] = []; const per: Record<string, number> = {};
  const add = (i: Omit<Issue, "key">) => { per[i.code] = (per[i.code] ?? 0) + 1; if (per[i.code]! <= MAX_PER_CODE) issues.push({ ...i, key: `${i.code}:${i.rowIds[0] ?? i.unit}` }); };
  const rule = ruleOf(s.ruleCode);
  const nonEmpty = rows.filter((r) => r.unitKey);

  if (!rows.length) add({ code: "E_EMPTY_LIST", severity: "error", unit: "", rowIds: [], message: "The list has no people yet. Share the voter link, or upload a list, and approve at least one record first." });
  if (s.duesEnabled && !s.duesCutoff) add({ code: "E_DUES_CUTOFF_MISSING", severity: "error", unit: "", rowIds: [], message: "The dues check is on but no cut-off date is chosen.", hint: "Pick the cut-off date, or switch the dues check off." });

  // ---- row level
  const seenDup = new Map<string, number>();
  for (const r of rows) {
    const here = r.unit ? `Unit ${r.unit}` : `Row ${r.rowNo}`;
    if (!r.unitKey) { add({ code: "E_EMPTY_UNIT", severity: "error", unit: "", rowIds: [r.id], message: `Row ${r.rowNo}${r.name ? " (" + shortName(r.name) + ")" : ""} has no Flat / House / Member ID.`, hint: "Type the ID, or delete the row." }); continue; }
    if (!r.name.trim()) add({ code: "E_NAME_MISSING", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: the name is missing.` });
    const m = cleanMobile(r.mobile, s.country);
    if (!r.mobile.trim()) add({ code: "E_MOBILE_MISSING", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: the mobile number is missing.` });
    else if (!m.ok) add({ code: "E_MOBILE_BAD", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: the mobile number does not look right.`, hint: m.problem });
    const e = cleanEmail(r.email);
    if (!r.email.trim()) add({ code: "E_EMAIL_MISSING", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: the e-mail ID is missing.` });
    else if (!e.ok) add({ code: "E_EMAIL_BAD", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: the e-mail ID does not look right.`, hint: e.problem });
    if (!r.capacity) add({ code: "E_CAPACITY_BAD", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: the capacity is blank. Choose ${capLabel("Owner")}, Co-owner, Tenant or Member.`, hint: "The voting rule needs to know who this person is." });
    const dk = dupKey(r);
    if (seenDup.has(dk)) add({ code: "E_DUP_ROW", severity: "error", unit: r.unit, rowIds: [r.id], message: `${here}: this line repeats row ${seenDup.get(dk)} exactly.`, hint: "Delete the repeated line.", fix: { type: "remove_rows", rowIds: [r.id] } });
    else seenDup.set(dk, r.rowNo);
  }

  // ---- unit level
  const byUnit = new Map<string, ListRow[]>();
  for (const r of nonEmpty) { const a = byUnit.get(r.unitKey); if (a) a.push(r); else byUnit.set(r.unitKey, [r]); }
  const units: UnitResult[] = [];
  for (const [key, rs] of byUnit) {
    const unit = rs[0]!.unit;
    // Who may vote is the Organizer's decision, person by person. A flat may have any number of registered people, and any number of them may be authorized:
    // the checks never insist on one voter per flat. A lone person is authorized unless the Organizer said no; where several people share a flat, nobody is authorized until the Organizer says so.
    const authorized = (r: ListRow) => r.isVoter === true || (r.isVoter === null && rs.length === 1);
    const vs = rs.filter(authorized);
    if (!vs.length) add({ code: "W_NO_VOTER", severity: "warning", unit, rowIds: rs.map((r) => r.id), message: rs.length === 1 ? `Flat ${unit}: its only person is not authorized to vote, so nobody votes for this flat.` : `Flat ${unit} has ${rs.length} people and none is authorized to vote yet, so nobody votes for this flat.`, hint: "The Organizer chooses who may vote for this flat; leave it if nobody from it should." });

    // weight of the unit
    let weight = EQUAL_WEIGHT;
    const given = [...new Set(rs.map((r) => r.weightMilli).filter((x): x is number => x !== null))];
    if (s.weightMode === "unequal") {
      if (given.length > 1) add({ code: "E_WEIGHT_CONFLICT", severity: "error", unit, rowIds: rs.map((r) => r.id), message: `Unit ${unit}: its lines carry different weights (${given.map(fmtMilli).join(", ")}). A unit has one weight.` });
      else if (given.length === 1) weight = given[0]!;
      else add({ code: "W_WEIGHT_DEFAULTED", severity: "warning", unit, rowIds: [rs[0]!.id], message: `Unit ${unit}: no weight was given, so it counts as 1.` });
    } else if (given.some((w) => w !== EQUAL_WEIGHT)) add({ code: "W_WEIGHT_IGNORED", severity: "warning", unit, rowIds: rs.map((r) => r.id), message: `Unit ${unit} carries a weight other than 1, but the society chose equal weight, so it counts as 1.`, hint: "Choose 'Unequal' in Weightage if the weights should count." });

    // rights, person by person (the weight and the dues date belong to the unit)
    const unitDues = rs.map((r) => r.duesPaidOn).filter(Boolean).sort().pop() ?? null;
    const people: UnitVoter[] = vs.map((v) => {
      let ok = true; const reasons: string[] = [];
      if (!v.canVote) { ok = false; reasons.push("set to not vote"); }
      if (v.capacity && !rule.capacities.includes(v.capacity)) {
        if (v.canVote) add({ code: "E_VOTER_INELIGIBLE", severity: "error", unit, rowIds: [v.id], message: `Unit ${unit}: ${shortName(v.name) || "a person"} (${capLabel(v.capacity)}) is authorized to vote, and the rule "${rule.name}" does not allow that.`, hint: "Choose another person for this flat, remove this record, or change who may vote in Step 1." });
        ok = false; reasons.push("rule");
      }
      let dues = true;
      if (s.duesEnabled && s.duesCutoff) { const date = v.duesPaidOn ?? unitDues; dues = !!date && date <= s.duesCutoff; if (!dues) { ok = false; reasons.push("dues"); } }
      return { row: v, canVote: ok, canAttend: v.canAttend, duesClear: dues, reasons };
    });
    // why not, person by person: the reason the Organizer or a Host chose, the voting rule, unpaid dues, or only "waiting for the Organizer"
    const mode = (s.reasonPublic ?? "role") as PublicMode;
    const byId = new Map(people.map((p) => [p.row.id, p] as const));
    const status: PersonStatus[] = rs.map((r) => {
      const p = byId.get(r.id);
      const parts: Array<{ kind: ReasonKind; code: string; text: string; plain?: string }> = []; let missing = false;
      const manual = () => { const t = reasonText(r.noVoteReason, r.noVoteNote); if (t) parts.push({ kind: "manual", code: r.noVoteReason ?? "other", text: t, plain: reasonText(r.noVoteReason, "") }); else { missing = true; parts.push({ kind: "manual", code: "", text: "Not allowed to vote (the reason has not been chosen yet)" }); } };
      if (!p) { if (r.isVoter === false) manual(); else parts.push({ kind: "pending", code: "", text: people.length ? OTHER_CHOSEN : PENDING_REASON }); }
      else if (!p.canVote) {
        if (p.reasons.includes("set to not vote")) manual();
        if (p.reasons.includes("rule")) parts.push({ kind: "rule", code: "", text: ruleReason(r.capacity) });
        if (p.reasons.includes("dues")) parts.push({ kind: "dues", code: "", text: DUES_REASON });
      }
      if (missing) add({ code: "E_REASON_MISSING", severity: "error", unit, rowIds: [r.id], message: `Flat ${unit}: ${shortName(r.name) || "a person"} is marked not allowed to vote, but no reason is given.`, hint: "Please choose a reason (for example dues unpaid, tenant, or co-owner), or write your own." });
      const allowed = !!p && p.canVote;
      return { rowId: r.id, allowed, kind: allowed ? "" : parts[0]!.kind, code: allowed ? "" : parts[0]!.code, reason: allowed ? "" : parts.map((x) => x.text).join("; "), publicReason: allowed ? "" : parts.filter((x) => publicOk(x.kind, x.code, mode)).map((x) => (mode === "all" ? x.text : x.plain ?? x.text)).join("; "), missing };
    });
    const canVote = people.some((p) => p.canVote);
    const why = canVote ? [] : people.length ? [...new Set(people.flatMap((p) => p.reasons))] : ["no voter"];
    units.push({ unit, unitKey: key, rows: rs, voters: people, status, weightMilli: weight, canAttend: people.some((p) => p.canAttend), canVote, why, duesClear: !people.length || people.some((p) => p.duesClear) });
  }

  // ---- across units (warnings)
  const mobileUnits = new Map<string, Set<string>>();
  for (const u of units) for (const p of u.voters) if (cleanMobile(p.row.mobile, s.country).ok) { const k = p.row.mobile; const a = mobileUnits.get(k) ?? new Set<string>(); a.add(u.unit); mobileUnits.set(k, a); }
  for (const [mob, us] of mobileUnits) if (us.size > 1) add({ code: "W_SAME_MOBILE", severity: "warning", unit: [...us][0]!, rowIds: units.filter((u) => us.has(u.unit)).flatMap((u) => u.voters.filter((p) => p.row.mobile === mob).map((p) => p.row.id)), message: `The mobile number ending ${maskPhone(mob).slice(-4)} is the voter for ${us.size} units (${[...us].slice(0, 6).join(", ")}): one person would hold ${us.size} votes.`, hint: "Please confirm this is right." });
  const nameUnits = new Map<string, Set<string>>();
  for (const u of units) for (const p of u.voters) if (p.row.name.trim()) { const k = nameKey(p.row.name); const a = nameUnits.get(k) ?? new Set<string>(); a.add(u.unit); nameUnits.set(k, a); }
  for (const [nk, us] of nameUnits) if (us.size > 1) add({ code: "W_DUP_NAME", severity: "warning", unit: [...us][0]!, rowIds: units.filter((u) => us.has(u.unit)).flatMap((u) => u.voters.filter((p) => nameKey(p.row.name) === nk).map((p) => p.row.id)), message: `The same voter name appears for ${us.size} units (${[...us].slice(0, 6).join(", ")}). Different people can share a name; please glance at it.` });
  for (const u of units) {
    const rs = u.rows; if (rs.length < 2) continue;
    outer: for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = nameKey(rs[i]!.name), b = nameKey(rs[j]!.name);
      if (a && b && editDistance(a, b, 2) <= 1 && dupKey(rs[i]!) !== dupKey(rs[j]!)) {
        add({ code: "W_NEAR_DUP", severity: "warning", unit: u.unit, rowIds: [rs[i]!.id, rs[j]!.id], message: `Unit ${u.unit}: two lines look like the same person (${shortName(rs[i]!.name)} and ${shortName(rs[j]!.name)}).` }); break outer;
      }
    }
  }

  const duesPending = s.duesEnabled ? units.filter((u) => !u.duesClear).length : 0;
  const summary: Summary = {
    rows: rows.length, units: units.length, voters: units.filter((u) => u.voters.length).length, authorized: units.reduce((a, u) => a + u.voters.length, 0),
    canVote: units.filter((u) => u.canVote).length, cannotVote: units.filter((u) => !u.canVote).length,
    totalWeightMilli: units.filter((u) => u.canVote).reduce((a, u) => a + u.weightMilli, 0), allWeightMilli: units.reduce((a, u) => a + u.weightMilli, 0), duesPending,
  };
  const errors = Object.entries(per).filter(([c]) => c.startsWith("E_")).reduce((a, [, n]) => a + n, 0);
  const warnings = Object.entries(per).filter(([c]) => c.startsWith("W_")).reduce((a, [, n]) => a + n, 0);
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.code.localeCompare(b.code));
  return { issues, errors, warnings, byCode: per, summary, units, canPublish: errors === 0 && rows.length > 0 };
}

export const shortName = (n: string) => (n.length > 24 ? n.slice(0, 22) + "..." : n);
export const fmtMilli = (m: number) => { const s = (m / 1000).toFixed(3).replace(/\.?0+$/, ""); return s; };

/** Percent shares of the units' weights, to three decimals, summing within rounding. */
export function shares(weights: number[]): { total: number; pct: number[] } {
  const total = weights.reduce((a, b) => a + b, 0);
  return { total, pct: weights.map((w) => (total ? Math.round((w / total) * 100000) / 1000 : 0)) };
}

/** What the list says, in one fixed shape. Two lists with the same fingerprint are the same list. */
export async function fingerprint(rows: ListRow[], s: Settings): Promise<string> {
  const body = [...rows].sort((a, b) => a.rowNo - b.rowNo).map((r) => [r.unit, r.name, r.capacity ?? "", r.mobile, r.email, r.isVoter === null ? -1 : r.isVoter ? 1 : 0, r.weightMilli ?? 0, r.canAttend ? 1 : 0, r.canVote ? 1 : 0, r.duesPaidOn ?? ""]);
  return sha256Hex("voter-list/fingerprint/v1\n" + canonical({ rule: s.ruleCode, weights: s.weightMode, dues: s.duesEnabled ? s.duesCutoff ?? "" : "", rows: body as never }));
}
export const shortFingerprint = (h: string) => h.slice(0, 16).toUpperCase().replace(/(.{4})/g, "$1-").replace(/-$/, "");

/** A person-friendly diff between two row sets (by unit). */
export interface RowDiff { added: string[]; removed: string[]; changed: Array<{ unit: string; fields: string[] }>; same: number }
export function diffLists(before: ListRow[], after: ListRow[]): RowDiff {
  const sig = (r: ListRow) => ({ name: r.name, capacity: r.capacity ?? "", mobile: r.mobile, email: r.email, voter: r.isVoter ? "yes" : "no", weight: String(r.weightMilli ?? ""), vote: r.canVote ? "yes" : "no", attend: r.canAttend ? "yes" : "no" });
  const group = (rows: ListRow[]) => { const m = new Map<string, ListRow[]>(); for (const r of rows) { const a = m.get(r.unitKey) ?? []; a.push(r); m.set(r.unitKey, a); } return m; };
  const A = group(before), B = group(after); const d: RowDiff = { added: [], removed: [], changed: [], same: 0 };
  for (const [k, rs] of B) {
    const old = A.get(k); if (!old) { d.added.push(rs[0]!.unit); continue; }
    const fields = new Set<string>();
    const key = (r: ListRow) => nameKey(r.name) + "|" + r.mobile;
    const oldBy = new Map(old.map((r) => [key(r), r])), newBy = new Map(rs.map((r) => [key(r), r]));
    for (const [kk, r] of newBy) { const o = oldBy.get(kk); if (!o) { fields.add("people"); continue; } const a = sig(o), b = sig(r); for (const f of Object.keys(a) as (keyof typeof a)[]) if (a[f] !== b[f]) fields.add(f); }
    for (const kk of oldBy.keys()) if (!newBy.has(kk)) fields.add("people");
    if (fields.size) d.changed.push({ unit: rs[0]!.unit, fields: [...fields] }); else d.same++;
  }
  for (const [k, rs] of A) if (!B.has(k)) d.removed.push(rs[0]!.unit);
  return d;
}
