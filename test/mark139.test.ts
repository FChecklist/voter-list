// Guard: every page carries the small mark "१३९" exactly once, with the approved look.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const pages = walk("public").filter((p) => p.endsWith(".html"));
const MARK = '<div class="mark139" lang="hi" aria-hidden="true"><span>१३९</span></div>';
const CSS1 = '.mark139{position:absolute;top:0;left:0;right:0;margin:0;padding:1px 0 0;text-align:center;line-height:1;pointer-events:none;user-select:none;z-index:2147483647;font-family:"Noto Sans Devanagari","Mukta","Nirmala UI","Mangal","Kohinoor Devanagari","Devanagari Sangam MN",sans-serif;font-size:6px;font-weight:700;color:#0B2A6B}';
const CSS2 = ".mark139 span{display:inline-block;border-bottom:.5px solid #7A1010;padding-bottom:.5px}";

describe("mark 139", () => {
  test("pages were found", () => expect(pages.length).toBeGreaterThanOrEqual(3));
  test("every page has the mark exactly once, first in the body", () => {
    for (const p of pages) {
      const html = readFileSync(p, "utf8");
      expect(html.split('class="mark139"').length - 1, p).toBe(1);
      expect(html.includes("<body>\n" + MARK + "\n"), p).toBe(true);
    }
  });
  test("every page loads the shared stylesheet that holds the approved CSS", () => {
    for (const p of pages) expect(readFileSync(p, "utf8").includes('href="/assets/app.css"'), p).toBe(true);
    const css = readFileSync("public/assets/app.css", "utf8");
    expect(css.split(CSS1).length - 1).toBe(1);
    expect(css.split(CSS2).length - 1).toBe(1);
    for (const t of ["#0B2A6B", "#7A1010", "6px", "700", ".5px", "pointer-events:none", "user-select:none", "position:absolute"]) expect(CSS1 + CSS2).toContain(t);
  });
});
