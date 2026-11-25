// The plain-words guide (docs/RESULTS.md) is the contract for people and AI helpers, so it must not drift from the code:
// every check the code can raise, and every Results address the handler serves, has to be named in it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/RESULTS.md", "utf8");

describe("the guide to Results matches the code", () => {
  test("every check that can fail or warn is named in the guide", () => {
    const src = readFileSync("src/results-core.ts", "utf8");
    const codes = [...new Set([...src.matchAll(/add\("(?:warn|fail)", "([a-z_]+)"/g), ...src.matchAll(/code: "([a-z_]+)"[^}]*level: "(?:warn|fail)"/g), ...src.matchAll(/level: "(?:warn|fail)"[^}]*code: "([a-z_]+)"/g)].map((m) => m[1]!))];
    expect(codes.length).toBeGreaterThanOrEqual(13);
    for (const c of codes) expect([c, doc.includes("`" + c + "`")]).toEqual([c, true]);
  });

  test("every Results address the handler serves is in the steps for an AI helper, with its method", () => {
    const handler = readFileSync("src/handler.ts", "utf8");
    const routes = [...handler.matchAll(/route\("(GET|POST)", "(\/api\/(?:lists\/:sid|v\/:slug)\/results[^"]*)"/g)].map((m) => ({ method: m[1]!, path: m[2]! }));
    expect(routes.length).toBe(13);
    for (const { method, path } of routes) {
      const shown = path.replace(":sid", "<sid>").replace(":slug", "<link>").replace(":rid", "<result.id>");
      expect([method, shown, doc.includes(`${method} ${shown}`)]).toEqual([method, shown, true]);
    }
  });

  test("the guide names the switch, the migration and the exact sentence for an AI helper", () => {
    for (const needle of ["RESULTS_ENABLED", "migrations/0016_results.sql", "Copy this link and paste in your AI to work."]) expect([needle, doc.includes(needle)]).toEqual([needle, true]);
  });
});
