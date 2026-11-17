// The pages are plain files. These tests keep them honest: every address a page calls exists, no inline scripts (the CSP forbids them),
// no innerHTML (so a name like <script> is only ever shown), and every file a page loads is there.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { routeTable } from "../src/handler";

const read = (p: string) => readFileSync(p, "utf8");
const pages = ["public/index.html", "public/v/index.html"];
const scripts = readdirSync("public/assets").filter((f) => f.endsWith(".js")).map((f) => "public/assets/" + f);

describe("the pages", () => {
  test("every script and stylesheet a page loads exists, and no page has inline script or inline event handlers", () => {
    for (const p of pages) {
      const html = read(p);
      for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) expect(existsSync("public" + m[1]), `${p} loads ${m[1]}`).toBe(true);
      expect(/<script(?![^>]*\bsrc=)/i.test(html), `${p} has an inline script`).toBe(false);
      expect(/\son[a-z]+\s*=/i.test(html), `${p} has an inline handler`).toBe(false);
    }
  });

  test("no script uses innerHTML, outerHTML, document.write, eval or a string timer", () => {
    for (const f of scripts) {
      const t = read(f);
      expect(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(t), f).toBe(false);
      expect(/set(Timeout|Interval)\(\s*["'`]/.test(t), f).toBe(false);
    }
  });

  test("every API address the pages call is a real route", () => {
    const table = routeTable(); const missing: string[] = [];
    for (const f of scripts) {
      const t = read(f);
      for (const m of t.matchAll(/api\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*(A\()?([`"])([^`"]*?)\3/g)) {
        let path = m[4]!.replace(/\$\{[^}]*\}/g, "x1").replace(/\?.*$/, "");
        if (m[2]) path = "/api/v/0123456789abcdef" + path;
        if (!table.some((r) => r.method === m[1] && r.re.test(path))) missing.push(`${f}: ${m[1]} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("links to files the API serves (templates, exports) are real routes", () => {
    const table = routeTable(); const bad: string[] = [];
    for (const f of scripts) for (const m of read(f).matchAll(/(?:href:\s*|a\(")\s*[`"](\/api\/[^`"?]*)/g)) {
      const path = m[1]!.replace(/\$\{[^}]*\}/g, "x1"); if (!table.some((r) => r.method === "GET" && r.re.test(path))) bad.push(f + " " + path);
    }
    expect(bad).toEqual([]);
  });

  test("the voter page and the organizer page each move top to bottom in seven steps", () => {
    expect((read("public/assets/voter.js").match(/mk\("/g) ?? []).length).toBe(7);
    expect((read("public/assets/organizer.js").match(/mk\("(setup|share|team|review|checks|draft|frozen)"/g) ?? []).length).toBe(7);
  });
});
