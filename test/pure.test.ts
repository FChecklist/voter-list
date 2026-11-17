import { describe, expect, test } from "bun:test";
import { parseDelimited, toCsv, csvCell } from "../src/csv";
import { cleanEmail, cleanMobile, cleanName, parseCapacity, parseDate, parseWeight, parseYesNo, unitKey, unitDisplay, undoSpreadsheetNumber, editDistance } from "../src/text";
import { buildTemplateXlsx, readXlsx, TEMPLATE_HEADERS } from "../src/xlsx";
import { mapHeaders, parseUpload } from "../src/importer";
import { runChecks, fingerprint, shares, diffLists } from "../src/checks";
import type { ListRow, Settings } from "../src/model";
import { synthCsv, synthRows } from "../src/synthetic";
import { deflateRawSync } from "node:zlib";
import { zipStored } from "../src/vendor/zip";

const S: Settings = { ruleCode: 3, weightMode: "equal", duesEnabled: false, duesCutoff: null, country: "India" };
const toRows = (p: Awaited<ReturnType<typeof parseUpload>>): ListRow[] => p.rows.map((r, i) => ({ ...r, id: i + 1 }));

describe("text cleaning", () => {
  test("mobile: India formats are mended, bad ones are kept as typed", () => {
    expect(cleanMobile("+91 90000-00101")).toMatchObject({ value: "9000000101", ok: true, mended: true });
    expect(cleanMobile("09000000101").value).toBe("9000000101");
    expect(cleanMobile("9000000101.0")).toMatchObject({ value: "9000000101", ok: true });
    expect(cleanMobile("9.000000101E9").value).toBe("9000000101");
    expect(cleanMobile("1234567890")).toMatchObject({ ok: false, value: "1234567890" });
    expect(cleanMobile("98765")).toMatchObject({ ok: false });
    expect(cleanMobile("abc")).toMatchObject({ ok: false });
    expect(cleanMobile("")).toMatchObject({ ok: false, problem: "missing" });
    expect(cleanMobile("+971 50 123 4567", "United Arab Emirates")).toMatchObject({ ok: true, value: "971501234567" });
  });
  test("e-mail", () => {
    expect(cleanEmail("  Asha@Sample.Example ")).toMatchObject({ value: "asha@sample.example", ok: true, mended: true });
    expect(cleanEmail("mailto:a@b.co,")).toMatchObject({ value: "a@b.co", ok: true });
    expect(cleanEmail("a@b").ok).toBe(false);
    expect(cleanEmail("a@b.com; c@d.com")).toMatchObject({ ok: false, problem: "two e-mail IDs in one box" });
    expect(cleanEmail("a..b@c.com").ok).toBe(false);
    expect(cleanEmail("").ok).toBe(false);
  });
  test("names: only shouted or lazily typed names change", () => {
    expect(cleanName("RAJAT AGARWAL").value).toBe("Rajat Agarwal");
    expect(cleanName("o'brien   sean").value).toBe("O'Brien Sean");
    expect(cleanName("McDonald Ray").value).toBe("McDonald Ray");
    expect(cleanName("  Asha  ").value).toBe("Asha");
    expect(cleanName("आशा शर्मा").value).toBe("आशा शर्मा");
  });
  test("unit keys", () => {
    expect(unitKey("A-101")).toBe(unitKey("a 101"));
    expect(unitKey("A/101")).toBe("A101");
    expect(unitDisplay(" b - 7 ")).toBe("B - 7");
    expect(unitDisplay("101.0")).toBe("101");
    expect(undoSpreadsheetNumber("1.01E2")).toBe("101");
  });
  test("capacity, yes/no, weight, dates", () => {
    expect(parseCapacity("co owner")).toBe("Co-owner"); expect(parseCapacity("TENANT")).toBe("Tenant"); expect(parseCapacity("lodger")).toBeNull();
    expect(parseYesNo("Y")).toBe(true); expect(parseYesNo("")).toBeNull(); expect(parseYesNo("maybe")).toBeUndefined(); expect(parseYesNo("No")).toBe(false);
    expect(parseWeight("1")).toBe(1000); expect(parseWeight("2.5")).toBe(2500); expect(parseWeight("1,000")).toBe(1000000); expect(parseWeight("2,5")).toBe(2500);
    expect(parseWeight("0")).toBeUndefined(); expect(parseWeight("-1")).toBeUndefined(); expect(parseWeight("abc")).toBeUndefined(); expect(parseWeight("")).toBeNull();
    expect(parseDate("15/11/2026")).toBe("2026-11-15"); expect(parseDate("2026-11-15")).toBe("2026-11-15"); expect(parseDate("6 Nov 2026")).toBe("2026-11-06");
    expect(parseDate("31/02/2026")).toBeUndefined(); expect(parseDate("46000")).toBe("2025-12-09"); expect(parseDate("")).toBeNull(); expect(parseDate("soon")).toBeUndefined();
  });
  test("edit distance", () => { expect(editDistance("asha", "ashaa")).toBe(1); expect(editDistance("abc", "xyz", 1)).toBeGreaterThan(1); });
});

describe("csv", () => {
  test("quotes, embedded commas and line breaks, BOM, CRLF", () => {
    const t = '﻿a,b,c\r\n"x, y","say ""hi""","l1\nl2"\r\n\r\n1,2,3';
    expect(parseDelimited(t)).toEqual([["a", "b", "c"], ["x, y", 'say "hi"', "l1\nl2"], ["1", "2", "3"]]);
  });
  test("sniffs tab (paste from a sheet) and semicolon", () => {
    expect(parseDelimited("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseDelimited("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  test("unterminated quote is refused", () => { expect(() => parseDelimited('a,"b\n1,2')).toThrow(/quotation/); });
  test("formula injection is defused on the way out", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+91")).toBe("'+91"); expect(csvCell("@a")).toBe("'@a"); expect(csvCell("plain")).toBe("plain");
    expect(toCsv([["a", "b,c"]])).toBe('a,"b,c"\r\n');
  });
  test("round trip of the sample", () => { const rows = synthRows({ units: 10 }); expect(parseDelimited(toCsv(rows))).toEqual(rows); });
});

describe("xlsx", () => {
  test("the template reads back as its own headings (and has no people)", async () => {
    const t = await readXlsx(buildTemplateXlsx({ rows: 5 }));
    const hm = mapHeaders(t);
    expect(hm.headerIndex).toBe(3);
    expect(Object.keys(hm.map).length).toBe(TEMPLATE_HEADERS.length);
    expect(hm.unknown).toEqual([]);
  });
  test("a compressed workbook with shared strings, numbers, booleans and a date cell", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const ssx = `<sst><si><t>Flat / House / Member ID</t></si><si><t>Name</t></si><si><t>Mobile</t></si><si><t>Dues paid on (date)</t></si><si><t>A-101</t></si><si><r><t>Asha </t></r><r><t>&amp; Co</t></r></si></sst>`;
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="E1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>9.000000101E9</v></c><c r="E2" s="1"><v>46000</v></c></row></sheetData></worksheet>`;
    const styles = `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const wb = `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId9"/></sheets></workbook>`;
    const rels = `<Relationships><Relationship Id="rId9" Type="x" Target="worksheets/sheetX.xml"/></Relationships>`;
    // build a zip whose entries are really deflated, by hand: stored zip helper for the container, then patch methods is complex; instead write a tiny deflate zip builder
    const files = [["xl/workbook.xml", wb], ["xl/_rels/workbook.xml.rels", rels], ["xl/sharedStrings.xml", ssx], ["xl/styles.xml", styles], ["xl/worksheets/sheetX.xml", sheet]] as const;
    const zip = deflateZip(files.map(([n, s]) => ({ name: n, data: enc(s) })));
    const t = await readXlsx(zip);
    expect(t[0]).toEqual(["Flat / House / Member ID", "Name", "Mobile", "", "Dues paid on (date)"]);
    expect(t[1]).toEqual(["A-101", "Asha & Co", "9.000000101E9", "", "2025-12-09"]);
  });
  test("not a zip, and a zip bomb, are refused with a plain message", async () => {
    await expect(readXlsx(new TextEncoder().encode("hello, this is not a spreadsheet at all......"))).rejects.toThrow(/Excel/);
    const big = new Uint8Array(40_000_000); // 40 MB of zeros deflates to ~40 KB
    const z = deflateZip([{ name: "xl/workbook.xml", data: new TextEncoder().encode("<workbook><sheets><sheet name='a' r:id='rId1'/></sheets></workbook>") }, { name: "xl/worksheets/sheet1.xml", data: big }]);
    await expect(readXlsx(z)).rejects.toThrow(/unreasonable|expands/);
  });
});

/** test helper: a zip with really deflated entries */
function deflateZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const stored = zipStored(files); // use for crc + layout, then rebuild with deflate
  const { crc32 } = require("../src/vendor/zip") as typeof import("../src/vendor/zip");
  const u16 = (v: number) => [v & 255, (v >> 8) & 255], u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const parts: number[][] = [], central: number[][] = []; let off = 0;
  for (const f of files) {
    const name = [...new TextEncoder().encode(f.name)], comp = [...deflateRawSync(f.data)], crc = crc32(f.data);
    const lh = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(comp.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...name];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(comp.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...name]);
    parts.push(lh, comp); off += lh.length + comp.length;
  }
  const cd = central.flat(); const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cd.length), ...u32(off), ...u16(0)];
  void stored; return new Uint8Array([...parts.flat(), ...cd, ...end]);
}

describe("importer", () => {
  test("clean sample: no errors, the voter is chosen where it is obvious", async () => {
    const p = await parseUpload({ format: "csv", text: synthCsv({ units: 40 }) }, { country: "India", ruleCode: 3 });
    expect(p.rowsRead).toBeGreaterThanOrEqual(40);
    expect(p.missingColumns).toEqual([]);
    const rep = runChecks(toRows(p), S);
    expect(rep.errors).toBe(0);
    expect(rep.summary.units).toBe(40);
    expect(rep.summary.canVote).toBe(40);
    expect(rep.canPublish).toBe(true);
  });
  test("defects are found and named; mends are counted", async () => {
    const p = await parseUpload({ format: "csv", text: synthCsv({ units: 40, defects: true }) }, { country: "India", ruleCode: 3 });
    const rep = runChecks(toRows(p), S);
    const codes = Object.keys(rep.byCode);
    for (const c of ["E_EMPTY_UNIT", "E_DUP_ROW", "E_MOBILE_MISSING", "E_EMAIL_BAD", "W_SAME_MOBILE"]) expect(codes).toContain(c);
    expect(rep.canPublish).toBe(false);
    const kinds = p.mends.map((m) => m.kind);
    expect(kinds).toContain("unit_variants"); expect(kinds).toContain("mobile_format"); expect(kinds).toContain("email_format");
    // "A 101" was folded into the A-101 unit and its person kept as a second line, not lost
    expect(toRows(p).filter((r) => r.unitKey === "A101").length).toBeGreaterThanOrEqual(2);
  });
  test("a sheet in the wrong shape is refused plainly", async () => {
    await expect(parseUpload({ format: "csv", text: "foo,bar\n1,2" }, { country: "India", ruleCode: 1 })).rejects.toThrow(/heading row/);
    await expect(parseUpload({ format: "paste", text: "   " }, { country: "India", ruleCode: 1 })).rejects.toThrow(/nothing to read/);
    await expect(parseUpload({ format: "csv", text: "ID,Name\n" }, { country: "India", ruleCode: 1 })).rejects.toThrow(/no people/);
  });
  test("partial data is welcome: a column can be missing and is reported as such", async () => {
    const p = await parseUpload({ format: "paste", text: "ID\tName\nA-1\tAsha\nA-2\tBharat" }, { country: "India", ruleCode: 1 });
    expect(p.missingColumns).toEqual(["mobile", "email"]);
    const rep = runChecks(toRows(p), S);
    expect(rep.byCode.E_MOBILE_MISSING).toBe(2); expect(rep.byCode.E_EMAIL_MISSING).toBe(2); expect(rep.canPublish).toBe(false);
  });
  test("unparseable cells are kept and reported by row, not guessed", async () => {
    const p = await parseUpload({ format: "csv", text: "ID,Name,Mobile,E-mail,Weight,Voter\nA-1,Asha,9000000101,a@s.example,heavy,maybe" }, { country: "India", ruleCode: 1 });
    expect(p.problems.map((x) => x.field).sort()).toEqual(["voter", "weight"]);
  });
  test("a heading repeated halfway down is skipped", async () => {
    const p = await parseUpload({ format: "csv", text: "ID,Name\nA-1,Asha\nID,Name\nA-2,Bharat" }, { country: "India", ruleCode: 1 });
    expect(p.rowsRead).toBe(2);
  });
});

describe("rules and weights", () => {
  const mk = (over: Partial<ListRow>, id: number): ListRow => ({ noVoteReason: "tenant", id, rowNo: id, unit: "A-1", unitKey: "A1", name: "Asha", capacity: "Owner", mobile: "9000000101", email: "a@s.example", isVoter: true, weightMilli: null, canAttend: true, canVote: true, duesPaidOn: null, ...over });
  const rep = (rows: ListRow[], s: Partial<Settings> = {}) => runChecks(rows, { ...S, ...s });
  test("rule 1 owner only: a tenant voter is an error unless the unit is set to not vote", () => {
    expect(rep([mk({ capacity: "Tenant" }, 1)], { ruleCode: 1 }).byCode.E_VOTER_INELIGIBLE).toBe(1);
    expect(rep([mk({ capacity: "Tenant" }, 1)], { ruleCode: 2 }).errors).toBe(0);
    const r = rep([mk({ capacity: "Tenant", canVote: false }, 1)], { ruleCode: 1 });
    expect(r.errors).toBe(0); expect(r.summary.canVote).toBe(0);
  });
  test("rule 1: a tenant the Organizer authorized is named as ineligible; the Organizer's decision is never changed by the system", () => {
    const r = rep([mk({ capacity: "Tenant" }, 1), mk({ id: 2, name: "Bharat", capacity: "Owner", isVoter: false, mobile: "9000000102", email: "b@s.example" }, 2)], { ruleCode: 1 });
    const i = r.issues.find((x) => x.code === "E_VOTER_INELIGIBLE")!;
    expect(i.rowIds).toEqual([1]); expect(i.fix).toBeUndefined();
  });
  test("rule 5 member only", () => {
    expect(rep([mk({ capacity: "Owner" }, 1)], { ruleCode: 5 }).byCode.E_VOTER_INELIGIBLE).toBe(1);
    expect(rep([mk({ capacity: "Member" }, 1)], { ruleCode: 5 }).errors).toBe(0);
  });
  test("a lone person needs no mark; with several people the Organizer authorizes any number, and the system never insists on one", () => {
    const lone = rep([mk({ isVoter: null }, 1)]);
    expect(lone.errors).toBe(0); expect(lone.summary.canVote).toBe(1);
    const two = (a: boolean | null, b: boolean | null) => rep([mk({ isVoter: a }, 1), mk({ name: "Bharat", mobile: "9000000102", email: "b@s.example", isVoter: b }, 2)]);
    const none = two(null, null);
    expect(none.errors).toBe(0); expect(none.byCode.W_NO_VOTER).toBe(1); expect(none.summary.canVote).toBe(0);
    const both = two(true, true);
    expect(both.errors).toBe(0); expect(both.byCode.W_NO_VOTER).toBeUndefined(); expect(both.units[0]!.voters).toHaveLength(2); expect(both.summary.canVote).toBe(1); expect(both.summary.totalWeightMilli).toBe(1000);
    const one = two(true, false);
    expect(one.errors).toBe(0); expect(one.units[0]!.voters.map((p) => p.row.id)).toEqual([1]);
    const lonelyNo = rep([mk({ isVoter: false }, 1)]);
    expect(lonelyNo.byCode.W_NO_VOTER).toBe(1); expect(lonelyNo.summary.canVote).toBe(0);
  });
  test("weights: equal mode ignores, unequal mode uses; conflicts and defaults are named", () => {
    const rows = [mk({ weightMilli: 2000 }, 1), mk({ unit: "B-1", unitKey: "B1", name: "Bharat", mobile: "9000000102", email: "b@s.example", weightMilli: 1000 }, 2)];
    expect(rep(rows).summary.totalWeightMilli).toBe(2000);
    expect(rep(rows).byCode.W_WEIGHT_IGNORED).toBe(1);
    expect(rep(rows, { weightMode: "unequal" }).summary.totalWeightMilli).toBe(3000);
    const conflict = [mk({ weightMilli: 2000 }, 1), mk({ name: "Bharat", mobile: "9000000102", isVoter: false, weightMilli: 3000 }, 2)];
    expect(rep(conflict, { weightMode: "unequal" }).byCode.E_WEIGHT_CONFLICT).toBe(1);
    expect(rep([mk({}, 1)], { weightMode: "unequal" }).byCode.W_WEIGHT_DEFAULTED).toBe(1);
    expect(shares([1000, 1000, 2000]).pct).toEqual([25, 25, 50]);
    expect(shares([]).total).toBe(0);
  });
  test("dues: attend yes, vote no, when dues are not clear on the cut-off day", () => {
    const rows = [mk({ duesPaidOn: "2026-10-01" }, 1), mk({ unit: "B-1", unitKey: "B1", name: "Bharat", mobile: "9000000102", email: "b@s.example", duesPaidOn: "2026-12-01" }, 2), mk({ unit: "C-1", unitKey: "C1", name: "Chitra", mobile: "9000000103", email: "c@s.example", duesPaidOn: null }, 3)];
    const r = rep(rows, { duesEnabled: true, duesCutoff: "2026-11-15" });
    expect(r.units.map((u) => [u.unit, u.canAttend, u.canVote])).toEqual([["A-1", true, true], ["B-1", true, false], ["C-1", true, false]]);
    expect(r.summary.duesPending).toBe(2);
    expect(rep(rows, { duesEnabled: true, duesCutoff: null }).byCode.E_DUES_CUTOFF_MISSING).toBe(1);
  });
  test("warnings: same mobile on two units, same name, near-duplicate within a unit", () => {
    const rows = [mk({}, 1), mk({ unit: "B-1", unitKey: "B1", name: "Asha", email: "x@s.example" }, 2), mk({ unit: "C-1", unitKey: "C1", name: "Chitra Rao", mobile: "9000000103", email: "c@s.example" }, 3), mk({ unit: "C-1", unitKey: "C1", name: "Chitra Raao", mobile: "9000000104", email: "c2@s.example", isVoter: false }, 4)];
    const r = rep(rows);
    expect(r.byCode.W_SAME_MOBILE).toBe(1); expect(r.byCode.W_DUP_NAME).toBe(1); expect(r.byCode.W_NEAR_DUP).toBe(1);
    expect(r.errors).toBe(0); expect(r.canPublish).toBe(true);
    // co-owners sharing a family phone are NOT near-duplicates
    expect(rep([mk({}, 1), mk({ name: "Bharat Kumar", isVoter: false }, 2)]).byCode.W_NEAR_DUP).toBeUndefined();
  });
  test("empty list, and a huge messy list stays bounded", async () => {
    expect(rep([]).canPublish).toBe(false);
    const bad = Array.from({ length: 3000 }, (_, i) => mk({ unit: "U" + i, unitKey: "U" + i, mobile: "" }, i + 1));
    const r = rep(bad); expect(r.byCode.E_MOBILE_MISSING).toBe(3000); expect(r.issues.filter((i) => i.code === "E_MOBILE_MISSING").length).toBe(400);
  });
  test("fingerprint changes when anything a voter could care about changes, and is stable otherwise", async () => {
    const a = [mk({}, 1)]; const f1 = await fingerprint(a, S);
    expect(await fingerprint([mk({}, 99)], S)).toBe(f1); // ids are database detail
    expect(await fingerprint([mk({ mobile: "9000000999" }, 1)], S)).not.toBe(f1);
    expect(await fingerprint(a, { ...S, ruleCode: 1 })).not.toBe(f1);
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
  });
  test("diff between versions", () => {
    const v1 = [mk({}, 1), mk({ unit: "B-1", unitKey: "B1", name: "Bharat", mobile: "9000000102", email: "b@s.example" }, 2)];
    const v2 = [mk({ mobile: "9000000555" }, 1), mk({ unit: "C-1", unitKey: "C1", name: "Chitra", mobile: "9000000103", email: "c@s.example" }, 3)];
    const d = diffLists(v1, v2);
    expect(d.added).toEqual(["C-1"]); expect(d.removed).toEqual(["B-1"]); expect(d.changed).toEqual([{ unit: "A-1", fields: ["people"] }]);
  });
});
