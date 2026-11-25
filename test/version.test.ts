// Every version note names its own commit (the parent of the commit that bumped the version, see KNOWLEDGE.md), and the top-level commit is the newest note's commit.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const v = JSON.parse(readFileSync("public/version.json", "utf8")) as { version: string; commit: string; changes: Array<{ version: string; commit?: string }> };

describe("public/version.json", () => {
  test("the top-level version and commit are the newest note's version and commit", () => {
    expect(v.changes[0]!.version).toBe(v.version);
    expect(v.commit).toBe(v.changes[0]!.commit as string);
    expect(JSON.parse(readFileSync("package.json", "utf8")).version).toBe(v.version);
  });
  test("every note names a commit, and no two notes name the same one", () => {
    for (const c of v.changes) expect([c.version, /^[0-9a-f]{7,40}$/.test(c.commit ?? "")]).toEqual([c.version, true]);
    const all = v.changes.map((c) => c.commit);
    expect(new Set(all).size).toBe(all.length);
  });
});
