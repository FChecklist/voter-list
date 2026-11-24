// Owner decision of 24 Nov 2026: the registration number / ID is mandatory, on create and on every later save.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LIST, makeHarness, newList } from "./harness";

const MSG = "Please type the registration number / ID of the society or association.";
const { regNo: _omit, ...NO_REG } = LIST;

describe("registration number / ID is mandatory", () => {
  for (const [label, extra] of [["missing", {}], ["empty", { regNo: "" }], ["spaces only", { regNo: "   " }]] as const) {
    test(`creating a list with the number ${label} is refused`, async () => {
      const h = await makeHarness(); const jar = await h.staff("organizer@sample.example");
      const r = await h.call("POST", "/api/lists", { ...NO_REG, ...extra }, jar);
      expect(r.status).toBe(400); expect(r.json.error ?? r.json.message ?? r.text).toContain(MSG);
    });
  }

  test("a valid number is accepted and kept", async () => {
    const h = await makeHarness(); const jar = await h.staff("organizer@sample.example");
    const r = await h.call("POST", "/api/lists", { ...NO_REG, regNo: " KA/RWA/2019/0042 " }, jar);
    expect(r.status).toBe(201); expect(r.json.list.regNo).toBe("KA/RWA/2019/0042");
  });

  test("a later save cannot blank the number, and leaving it out of a save keeps it", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    for (const regNo of ["", "   "]) {
      const r = await h.call("PATCH", `/api/lists/${sid}`, { regNo }, jar);
      expect(r.status).toBe(400); expect(r.text).toContain(MSG);
    }
    expect((await h.call("PATCH", `/api/lists/${sid}`, { state: "Kerala" }, jar)).status).toBe(200);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { regNo: "KA/RWA/2019/0099" }, jar)).json.list.regNo).toBe("KA/RWA/2019/0099");
  });

  test("the set-up page labels the field plainly, requires it and explains an empty one", () => {
    const js = readFileSync("public/assets/organizer.js", "utf8");
    expect(js).toContain('"Registration number / ID"');
    expect(js).not.toContain("Registration number (optional)");
    expect(js).toMatch(/id: "lr"[^}]*required/);
    expect(js).toContain(MSG);
  });
});

describe("no tick box on the voter confirm step", () => {
  test("the page has a plain notice with a link to the Terms and no checkbox", () => {
    const js = readFileSync("public/assets/voter.js", "utf8");
    expect(js).not.toMatch(/type: "checkbox"|I agree|Please tick the box/);
    expect(js).toContain('href: "/terms/"');
    expect(readFileSync("public/terms/index.html", "utf8")).toContain("draft");
    for (const p of ["public/index.html", "public/v/index.html"]) expect(readFileSync(p, "utf8")).toContain('href="/terms/"');
  });
});
