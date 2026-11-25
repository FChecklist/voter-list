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
  // The nine oldest notes name no commit because that history predates the rule (KNOWLEDGE.md; the attendance tests pin the same list).
  const PREDATES_THE_RULE = ["0.3.2", "0.3.1", "0.3.0", "0.2.4", "0.2.3", "0.2.2", "0.2.1", "0.2.0", "0.1.0"];
  test("every note names a commit (except the nine that predate the rule), and no two notes name the same one", () => {
    for (const c of v.changes) if (!PREDATES_THE_RULE.includes(c.version)) expect([c.version, /^[0-9a-f]{7,40}$/.test(c.commit ?? "")]).toEqual([c.version, true]);
    const all = v.changes.map((c) => c.commit).filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
  });
});
