// Minimal .xlsx reader and template writer, no dependencies. An .xlsx is a zip of XML files.
// Reader: central directory, stored or deflate entries (inflate via the platform's DecompressionStream, present in Workers and Bun),
// shared strings, inline strings, booleans, numbers, and date-formatted cells turned into ISO dates. Zip-bomb guard on inflated size.
import { zipStored } from "./vendor/zip";
import { MAX_ROWS } from "./csv";

const td = new TextDecoder("utf-8");
const te = new TextEncoder();
const MAX_INFLATED = 30_000_000;
const MAX_ZIP = 8_000_000;

interface Entry { name: string; method: number; csize: number; usize: number; off: number }

function readEntries(b: Uint8Array): Entry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("This does not look like an Excel (.xlsx) file.");
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  if (n > 2000) throw new Error("This Excel file has too many parts.");
  const out: Entry[] = [];
  for (let i = 0; i < n; i++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("The Excel file is damaged.");
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    out.push({ name: td.decode(b.subarray(p + 46, p + 46 + nl)), method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), off: dv.getUint32(p + 42, true) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, cap: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter(); void w.write(data as unknown as BufferSource).then(() => w.close()).catch(() => {});
  const r = ds.readable.getReader(); const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await r.read(); if (done) break;
    total += value.length; if (total > cap) { try { await r.cancel(); } catch { /* ignore */ } throw new Error("This Excel file expands to an unreasonable size."); }
    parts.push(value);
  }
  const out = new Uint8Array(total); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out;
}

async function readFile(b: Uint8Array, ents: Entry[], name: string): Promise<string | null> {
  const ent = ents.find((x) => x.name === name); if (!ent) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (ent.off + 30 > b.length || dv.getUint32(ent.off, true) !== 0x04034b50) throw new Error("The Excel file is damaged.");
  const start = ent.off + 30 + dv.getUint16(ent.off + 26, true) + dv.getUint16(ent.off + 28, true);
  const raw = b.subarray(start, start + ent.csize);
  if (ent.method === 0) return td.decode(raw);
  if (ent.method === 8) { if (ent.usize > MAX_INFLATED) throw new Error("This Excel file expands to an unreasonable size."); return td.decode(await inflateRaw(raw, MAX_INFLATED)); }
  throw new Error("This Excel file uses a compression this reader does not know.");
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
const textOf = (xml: string) => { let s = ""; for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += unesc(m[1]!); return s; };
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function dateStyles(styles: string | null): Set<number> {
  const out = new Set<number>(); if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(+m[1]!, unesc(m[2]!));
  const xfs = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(styles)?.[0] ?? "";
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)) {
    const id = +m[1]!; const code = custom.get(id);
    if (BUILTIN_DATE.has(id) || (code !== undefined && /[dmyh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")) && !/^(0|#)/.test(code))) out.add(i);
    i++;
  }
  return out;
}
const serialToIso = (n: number) => { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000); return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; };

/** The first worksheet of an .xlsx as rows of strings (blank cells are ""). Dates come back as YYYY-MM-DD. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  if (bytes.length > MAX_ZIP) throw new Error("This Excel file is larger than 8 MB. Please split the list.");
  const ents = readEntries(bytes);
  const wb = await readFile(bytes, ents, "xl/workbook.xml");
  if (!wb) throw new Error("This does not look like an Excel (.xlsx) file.");
  let target = "xl/worksheets/sheet1.xml";
  const first = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const rels = await readFile(bytes, ents, "xl/_rels/workbook.xml.rels");
  if (first && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (new RegExp(`Id="${first}"`).test(m[0])) { const t = /Target="([^"]+)"/.exec(m[0])?.[1]; if (t) target = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""); }
    }
  }
  const sheet = await readFile(bytes, ents, target);
  if (!sheet) throw new Error("The first sheet of the Excel file could not be found.");
  const sst: string[] = [];
  const sstXml = await readFile(bytes, ents, "xl/sharedStrings.xml");
  if (sstXml) for (const m of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) sst.push(textOf(m[1]!));
  const dates = dateStyles(await readFile(bytes, ents, "xl/styles.xml"));
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rn = +(/\br="(\d+)"/.exec(rm[1]!)?.[1] ?? rows.length + 1);
    if (rn > MAX_ROWS + 60) throw new Error(`More than ${MAX_ROWS} rows. Please split the list.`);
    const cells: string[] = [];
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!, inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]; const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n"; const s = /\bs="(\d+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = "";
      if (t === "s") val = sst[+(v ?? -1)] ?? "";
      else if (t === "inlineStr") val = textOf(inner);
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (t === "e") val = "";
      else if (v !== undefined) {
        val = unesc(v);
        if (t === "n" && s !== undefined && dates.has(+s) && /^\d+(\.\d+)?$/.test(val)) val = serialToIso(parseFloat(val));
      }
      const ci = ref ? colIndex(ref) : cells.length;
      if (ci > 60) continue;
      while (cells.length < ci) cells.push("");
      cells[ci] = val;
    }
    while (rows.length < rn - 1) rows.push([]);
    rows[rn - 1] = cells;
  }
  while (rows.length && rows[rows.length - 1]!.every((c) => !c)) rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------------
export const TEMPLATE_HEADERS = [
  "Flat / House / Member ID", "Name", "Capacity (Owner / 1st Name in Registration, Co-owner, Tenant, Member)", "Mobile", "E-mail",
  "Authorized to vote (Yes, or leave blank)", "Weight", "Allowed to attend (Yes / No)", "Allowed to vote (Yes / No)", "Dues paid on (date)", "Reason (if not allowed to vote)",
] as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colL = (i: number) => String.fromCharCode(65 + i);
const is = (r: number, c: number, text: string, style: number) => `<c r="${colL(c)}${r}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

/** An empty, ready-to-fill sheet for the Organizer: instructions, grey headings, drop-downs, a few hundred formatted rows. */
export function buildTemplateXlsx(opts: { rows?: number; societyName?: string } = {}): Uint8Array {
  const n = Math.max(1, Math.min(3000, Math.floor(opts.rows ?? 200)));
  const first = 4, last = first + n;
  const how = "HOW TO FILL: one person per row. A flat with several people gets one row each, with the same ID; write Yes under 'Authorized to vote' for each person the Organizer authorizes to vote (a flat with one person needs no mark; any number of people in a flat may be authorized). Name, Mobile and E-mail are needed for every row. Weight is optional (blank = 1). Write No under 'Authorized to vote' or 'Allowed to vote' only for a person who may not vote, and give the reason in the last column (for example Dues unpaid, Tenant, Co-owner); a No with no reason has to be fixed before the list can be published. Do not change the headings. Save as .xlsx or .csv and upload it.";
  const rows: string[] = [];
  rows.push(`<row r="1" ht="22" customHeight="1">${is(1, 0, `Townhall Records | Voter list template${opts.societyName ? " | " + opts.societyName : ""}`, 1)}</row>`);
  rows.push(`<row r="2" ht="64" customHeight="1">${is(2, 0, how, 2)}</row>`);
  rows.push(`<row r="3" ht="6" customHeight="1"/>`);
  rows.push(`<row r="4" ht="42" customHeight="1">${TEMPLATE_HEADERS.map((h, i) => is(4, i, h, 3)).join("")}</row>`);
  const widths = [18, 28, 26, 16, 32, 22, 10, 16, 16, 16, 32];
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.join("")}</sheetData>` +
    `<mergeCells count="1"><mergeCell ref="A2:K2"/></mergeCells>` +
    `<dataValidations count="4"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="C${first + 1}:C${last}"><formula1>"Owner / 1st Name in Registration,Co-owner,Tenant,Member"</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="F${first + 1}:F${last}"><formula1>"Yes,No"</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="H${first + 1}:I${last}"><formula1>"Yes,No"</formula1></dataValidation><dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="K${first + 1}:K${last}"><formula1>"Dues unpaid,Tenant,Co-owner,Not a member of the society,Proxy papers awaited"</formula1></dataValidation></dataValidations></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs></styleSheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Voter list" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const f = (name: string, s: string) => ({ name, data: te.encode(s) });
  return zipStored([f("[Content_Types].xml", ct), f("_rels/.rels", rels), f("xl/workbook.xml", wb), f("xl/_rels/workbook.xml.rels", wbRels), f("xl/styles.xml", styles), f("xl/worksheets/sheet1.xml", sheet)]);
}

export const TEMPLATE_CSV = TEMPLATE_HEADERS.map((h) => (h.includes(",") || h.includes("/") ? `"${h}"` : h)).join(",") + "\r\n";
