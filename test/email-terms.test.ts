// Owner decision of 24 Nov 2026: an e-mail ID is compulsory for every voter record, on every path; and the Terms version is written once in the code and once in the page.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enrolVoter, makeHarness, newList } from "./harness";
import { createRecord } from "../src/records";

describe("e-mail ID is compulsory for every voter", () => {
  test("a voter added by the Organizer without a valid e-mail ID is refused", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    for (const email of [undefined, "", "not-an-email"]) {
      const r = await h.call("POST", `/api/lists/${sid}/records`, { unit: "B-1", name: "No Mail", capacity: "Owner", mobile: "9000000555", email, agreed: true }, jar);
      expect(r.status).toBe(400); expect(r.text).toContain("Please type the voter's e-mail ID.");
    }
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters").get()).toEqual({ n: 0 });
  });

  test("a file import skips a row with no valid e-mail ID and keeps the others", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail", "H-1,Hema One,Owner,9000000301,h1@sample.example", "H-2,Indu Two,Owner,9000000302,", "H-3,Jai Three,Owner,9000000303,bad-address"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM voters").get()).toEqual({ n: 1 });
    expect(h.raw.query("SELECT email FROM voters").get()).toEqual({ email: "h1@sample.example" });
  });

  test("self-enrolment keeps the signed-in e-mail ID, and the code refuses a context without a valid one", async () => {
    const h = await makeHarness(); const { slug } = await newList(h);
    const { rec } = await enrolVoter(h, slug, "voter@sample.example", { confirm: false });
    expect(rec.id).toBeTruthy();
    expect(h.raw.query("SELECT email FROM voters").get()).toEqual({ email: "voter@sample.example" });
    await expect(createRecord({ env: h.env, now: h.clock.now, email: "", society: {} } as any, { unit: "A-2", name: "X Y", capacity: "Owner", mobile: "9000000999" } as any)).rejects.toThrow("Please type the voter's e-mail ID.");
  });
});

describe("the Terms version", () => {
  test("the code and the Terms page name the same version", () => {
    const code = /TERMS_VERSION = "([^"]+)"/.exec(readFileSync("src/records.ts", "utf8"))?.[1];
    const page = /version (draft-[\d-]+)/.exec(readFileSync("public/terms/index.html", "utf8"))?.[1];
    expect(code).toBeTruthy(); expect(page).toBe(code);
  });
});
