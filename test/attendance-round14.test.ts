// Round 14 fix for Attendance (version 0.3.9): no checkbox anywhere; settings are toggle buttons built by VL.toggle.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { filesUnder, read } from "./scan";
import { makeHarness, newList } from "./harness";

const BOX = /type\s*:\s*["']checkbox["']|type\s*=\s*["']?checkbox|<input[^>]*type\s*=\s*["']?checkbox/i;

describe("1. no checkbox in any file under public/ or src/", () => {
  const files = [...filesUnder("public", /\.(js|ts|html)$/), ...filesUnder("src", /\.(js|ts|html)$/)];
  test("the scan reads real files", () => { expect(files).toContain("public/assets/ui.js"); expect(files).toContain("src/review.ts"); });
  test("no file holds a checkbox input", () => { expect(files.filter((f) => BOX.test(read(f)))).toEqual([]); });
  test("the pattern is real: it catches each spelling", () => {
    for (const t of ['el("input", { type: "checkbox" })', "el('input', { type:'checkbox' })", '<input type="checkbox">', "<input id=x type=checkbox>"]) expect(BOX.test(t), t).toBe(true);
  });
  test("the three old places use the helper and never read .checked", () => {
    expect(read("public/assets/organizer-work.js").match(/VL\.toggle\(/g)?.length).toBe(2);
    expect(read("public/assets/organizer.js")).toContain("VL.toggle(");
    expect(read("public/assets/organizer.js")).toContain("docsRequired: f.docs.isOn()");
    expect(read("public/assets/organizer.js")).not.toContain(".checked");
    expect(read("public/assets/organizer-work.js")).not.toContain(".checked");
  });
});

/** A minimal fake page: just enough of Element/document/Node for ui.js to load and build a button. No other page test builds DOM, so this is local to this file. */
function loadUi() {
  class Node {}
  class Element extends Node {
    tag = ""; attrs: Record<string, string> = {}; className = ""; kids: unknown[] = []; listeners: Record<string, Array<() => void>> = {};
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    addEventListener(ev: string, fn: () => void) { (this.listeners[ev] ??= []).push(fn); }
    click() { for (const f of this.listeners.click ?? []) f(); }
    append(...k: unknown[]) { this.kids.push(...k); }
    set textContent(t: string) { this.kids = [t]; }
    get textContent() { return this.kids.map((k) => (k instanceof Text ? k.t : String(k))).join(""); }
  }
  class Text extends Node { constructor(public t: string) { super(); } }
  const document = { createElement: (tag: string) => Object.assign(new Element(), { tag }), createTextNode: (t: string) => new Text(t) };
  const window: Record<string, any> = {};
  new Function("window", "document", "Element", "Node", read("public/assets/ui.js"))(window, document, Element, Node);
  return window.VL as { toggle: (l: string, p: boolean, c?: (on: boolean) => void, w?: string[]) => any };
}

describe("2. VL.toggle is a switch button", () => {
  test("role=switch, aria-pressed flips on click, words change, onChange gets the new state, and it is a button not an input", () => {
    const VL = loadUi(); const seen: boolean[] = [];
    const b = VL.toggle("Documents", false, (on) => seen.push(on));
    expect(b.tag).toBe("button"); expect(b.attrs.type).toBe("button"); expect(b.attrs.role).toBe("switch"); expect(b.attrs["aria-label"]).toBe("Documents");
    expect(b.className).toContain("btn"); expect(b.attrs["aria-pressed"]).toBe("false"); expect(b.textContent).toBe("Off"); expect(b.isOn()).toBe(false);
    b.click(); expect(b.attrs["aria-pressed"]).toBe("true"); expect(b.textContent).toBe("On"); expect(b.isOn()).toBe(true);
    b.click(); expect(b.attrs["aria-pressed"]).toBe("false"); expect(b.textContent).toBe("Off");
    b.click(); expect(seen).toEqual([true, false, true]);
  });
  test("starts pressed, and takes its own words (Selected / Select)", () => {
    const VL = loadUi(); const b = VL.toggle("Select A-1", true, undefined, ["Selected", "Select"]);
    expect(b.attrs["aria-pressed"]).toBe("true"); expect(b.textContent).toBe("Selected"); b.click(); expect(b.textContent).toBe("Select");
  });
  test("the button keeps the 44 px touch target through .btn", () => { expect(read("public/assets/app.css")).toMatch(/\.btn\{min-height:44px/); });
});

describe("3. the documents-required value round-trips", () => {
  test("on, save, read back true; then off, read back false", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const get = async () => (await h.call("GET", `/api/lists/${sid}`, undefined, jar)).json.list.docsRequired;
    expect(await get()).toBe(false);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { docsRequired: true }, jar)).status).toBe(200); expect(await get()).toBe(true);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { docsRequired: false }, jar)).status).toBe(200); expect(await get()).toBe(false);
  });
});

describe("4. the version", () => {
  const version = JSON.parse(read("public/version.json")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string }> };
  test("the 0.3.9 entry names b69ea3da, the head it was built on", () => {
    const e = version.changes.find((x) => x.version === "0.3.9")!;
    expect(e.commit).toBe("b69ea3da");
    expect(read("CHANGELOG.md")).toContain("## 0.3.9"); expect(read("KNOWLEDGE.md")).toContain("0.3.9:"); expect(read("KNOWLEDGE.md")).toContain("There are no checkboxes left");
    expect(() => execFileSync("git", ["cat-file", "-e", "b69ea3da^{commit}"], { stdio: "ignore" })).not.toThrow();
  });
});
