// Vendored from AOA-RWA packages/engine/src/pdf.ts (the Doc class only). See VENDORED.md.
import type { Bytes } from "./crypto";

const W = 595, H = 842, M = 48, LEAD = 1.28;
type FontKey = "F1" | "F2" | "F3";
const CW: Record<FontKey, number> = { F1: 0.52, F2: 0.56, F3: 0.6 };

export const latin = (s: string): string => Array.from(String(s ?? "")).map((ch) => {
  const c = ch.codePointAt(0)!;
  if (c === 0x2022 || c === 0xb7) return "|"; if (c === 0x2013 || c === 0x2014) return "-"; if (c === 0x2018 || c === 0x2019) return "'"; if (c === 0x201c || c === 0x201d) return '"'; if (c === 0x2026) return "..."; if (c === 0x2714) return "pass"; if (c === 0x2718) return "FAIL";
  if (c === 0x2611 || c === 0x2610) return c === 0x2611 ? "[x]" : "[ ]";
  return c < 32 || c > 255 ? (c === 10 ? " " : "?") : ch;
}).join("");
const esc = (s: string) => latin(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export class Doc {
  pages: string[][] = [[]]; y = H - M; constructor(private footer: string, private watermark: string = "") {}
  private get cur() { return this.pages[this.pages.length - 1]!; }
  private ensure(h: number) { if (this.y - h < M + 18) { this.pages.push([]); this.y = H - M; } }
  space(n = 6) { this.y -= n; }
  text(s: string, o: { size?: number; font?: FontKey; indent?: number; gap?: number } = {}) {
    const size = o.size ?? 10, font = o.font ?? "F1", indent = o.indent ?? 0, maxChars = Math.max(10, Math.floor((W - 2 * M - indent) / (size * CW[font])));
    const words = latin(s).split(/(\s+)/); const lines: string[] = []; let line = "";
    for (const w of words) {
      if ((line + w).length <= maxChars) { line += w; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      let rest = w.trimStart(); while (rest.length > maxChars) { lines.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); } line = rest;
    }
    if (line.trim()) lines.push(line.trimEnd());
    if (!lines.length) lines.push("");
    for (const l of lines) { this.ensure(size * LEAD); this.y -= size * LEAD; this.cur.push(`BT /${font} ${size} Tf ${M + indent} ${this.y.toFixed(1)} Td (${esc(l)}) Tj ET`); }
    this.y -= o.gap ?? 2;
  }
  h(s: string, size = 13) { this.space(8); this.ensure(size * 3); this.text(s, { size, font: "F2", gap: 3 }); this.line(); }
  line() { this.ensure(6); this.cur.push(`0.6 w ${M} ${this.y.toFixed(1)} m ${W - M} ${this.y.toFixed(1)} l S`); this.y -= 5; }
  row(cols: string[], widths: number[], o: { font?: FontKey; size?: number } = {}) {
    const size = o.size ?? 9, font = o.font ?? "F1"; this.ensure(size * LEAD * 2);
    const wrapped = cols.map((c, i) => { const mc = Math.max(3, Math.floor(widths[i]! / (size * CW[font]))); const out: string[] = []; let rest = latin(c); while (rest.length > mc) { let cut = rest.lastIndexOf(" ", mc); if (cut < mc / 2) cut = mc; out.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); } out.push(rest); return out; });
    const n = Math.max(...wrapped.map((w) => w.length));
    for (let k = 0; k < n; k++) { this.ensure(size * LEAD); this.y -= size * LEAD; let x = M; wrapped.forEach((w, i) => { if (w[k]) this.cur.push(`BT /${font} ${size} Tf ${x} ${this.y.toFixed(1)} Td (${esc(w[k]!)}) Tj ET`); x += widths[i]!; }); }
    this.y -= 2;
  }
  box(h: number, label: string) { this.ensure(h + 14); this.cur.push(`0.6 w ${M} ${(this.y - h).toFixed(1)} ${W - 2 * M} ${h} re S`); this.cur.push(`BT /F1 8 Tf ${M + 4} ${(this.y - 10).toFixed(1)} Td (${esc(label)}) Tj ET`); this.y -= h + 6; }
  sig(label: string) {
    this.ensure(64); this.space(26); this.cur.push(`0.6 w ${M} ${this.y.toFixed(1)} m ${M + 230} ${this.y.toFixed(1)} l S`); this.cur.push(`0.6 w ${M + 270} ${this.y.toFixed(1)} m ${W - M} ${this.y.toFixed(1)} l S`);
    this.y -= 11; this.cur.push(`BT /F2 9 Tf ${M} ${this.y.toFixed(1)} Td (${esc(label)} - signature) Tj ET`); this.cur.push(`BT /F1 9 Tf ${M + 270} ${this.y.toFixed(1)} Td (Name, date and place) Tj ET`); this.y -= 4;
  }
  bytes(): Bytes {
    const n = this.pages.length, objs: string[] = [];
    const fonts = ["Helvetica", "Helvetica-Bold", "Courier"];
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    const kids = this.pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ");
    objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
    fonts.forEach((f, i) => { objs[3 + i] = `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`; });
    objs[0] = "";
    this.pages.forEach((ops, i) => {
      const footer = `BT /F1 7.5 Tf ${M} 28 Td (${esc(this.footer)}   Page ${i + 1} of ${n}) Tj ET`;
      // watermark first, so it sits behind the text: light grey, 45 degrees, centred, sized to fit the diagonal
      const wm = this.watermark ? latin(this.watermark) : ""; const size = Math.min(34, 700 / Math.max(1, wm.length * CW.F2)); const half = (wm.length * size * CW.F2) / 2; const k = 0.70711;
      const mark = wm ? [`q 0.86 g BT /F2 ${size.toFixed(1)} Tf ${k} ${k} ${-k} ${k} ${(W / 2 - half * k).toFixed(1)} ${(H / 2 - half * k).toFixed(1)} Tm (${esc(wm)}) Tj ET Q`] : [];
      const stream = [...mark, ...ops, footer].join("\n");
      objs[6 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
      objs[7 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let out = "%PDF-1.4\n%âãÏÓ\n"; const offs: number[] = [];
    const last = 6 + (n - 1) * 2 + 1;
    for (let id = 1; id <= last; id++) { offs[id] = out.length; out += `${id} 0 obj\n${objs[id]}\nendobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${last + 1}\n0000000000 65535 f \n`; for (let id = 1; id <= last; id++) out += String(offs[id]).padStart(10, "0") + " 00000 n \n";
    out += `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const b = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) b[i] = out.charCodeAt(i) & 255; return b;
  }
}

