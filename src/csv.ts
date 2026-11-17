// CSV / TSV reading and writing. Reading follows RFC 4180 (quotes, doubled quotes, line breaks inside quotes) and sniffs the delimiter,
// because "paste from any sheet" arrives tab-separated and Indian Excel exports often use semicolons.
// Writing defuses spreadsheet formula injection: a cell that starts with = + - @ is written with a leading apostrophe.

export const MAX_TEXT_BYTES = 3_000_000;
export const MAX_ROWS = 6000;

export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 4000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  let best = ",", bestScore = -1;
  for (const d of ["\t", ",", ";", "|"]) {
    const counts = head.map((l) => stripQuoted(l).split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.every((c) => c === counts[0]);
    const score = counts[0]! * (consistent ? 10 : 1);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}
const stripQuoted = (l: string) => l.replace(/"[^"]*"/g, "");

export function parseDelimited(input: string, delimiter?: string): string[][] {
  if (input.length > MAX_TEXT_BYTES) throw new Error("This file is larger than 3 MB. Please split the list.");
  const text = input.replace(/^﻿/, "");
  const d = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false, i = 0;
  const endRow = () => { row.push(cell); cell = ""; if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; if (rows.length > MAX_ROWS + 50) throw new Error(`More than ${MAX_ROWS} rows. Please split the list.`); };
  while (i < text.length) {
    const c = text[i]!;
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === "") { q = true; i++; continue; }
    if (c === d) { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r") { if (text[i + 1] === "\n") i++; endRow(); i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    cell += c; i++;
  }
  if (q) throw new Error("A quotation mark was opened and never closed. Please check the file.");
  if (cell !== "" || row.length) endRow();
  return rows;
}

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
