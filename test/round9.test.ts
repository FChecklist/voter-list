// The owner's change of 14 Nov 2026: the first role reads "Owner / 1st Name in Registration" everywhere it is shown, and a flat may have more than one
// registered person, with the Organizer deciding (person by person) who is authorized to vote. The system never insists on one vote per flat.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enrolVoter, makeHarness, newList, waiting, type Jar } from "./harness";

const LABEL = "Owner / 1st Name in Registration";

async function twoInOneFlat() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "o@sample.example", { unit: "C-1", name: "Olga Owner", mobile: "9000000121" });
  await enrolVoter(h, slug, "co@sample.example", { unit: "C-1", name: "Ravi Coowner", capacity: "Co-owner", mobile: "9000000122" });
  await enrolVoter(h, slug, "t@sample.example", { unit: "C-2", name: "Tara Single", mobile: "9000000123" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  return { h, jar, sid, slug };
}
const flats = async (h: Awaited<ReturnType<typeof makeHarness>>, sid: string, jar: Jar) => (await h.call("GET", `/api/lists/${sid}/checks`, undefined, jar)).json;

describe("Owner / 1st Name in Registration, and several people in one flat", () => {
  test("the stored role stays 'Owner'; every page, list and export shows the new words", async () => {
    const { h, jar, sid, slug } = await twoInOneFlat();
    const c = await flats(h, sid, jar);
    expect(c.flats[0].people.map((p: { capacity: string }) => p.capacity).sort()).toEqual(["Co-owner", LABEL]);
    await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, jar);
    expect(h.raw.query("SELECT DISTINCT capacity FROM publication_rows ORDER BY capacity").all().map((r: any) => r.capacity)).toEqual(["Co-owner", "Owner"]); // the signed record keeps the key
    const csv = (await h.call("GET", `/api/v/${slug}/list.csv`)).text;
    expect(csv).toContain(LABEL); expect(csv).not.toMatch(/,Owner,/);
    const pub = (await h.call("GET", `/api/v/${slug}/list`)).json;
    expect(pub.rows.map((r: { capacity: string }) => r.capacity)).toContain(LABEL);
    expect(pub.rows.map((r: { capacity: string }) => r.capacity)).not.toContain("Owner");
  });

  test("a flat with two people: nobody is authorized until the Organizer says so; only a warning, never a block; a lone person votes by default", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const c = await flats(h, sid, jar);
    expect(c.flats).toHaveLength(1); // the lone person in C-2 is not in the "more than one person" table
    expect(c.flats[0].people.every((p: { authorized: boolean }) => !p.authorized)).toBe(true);
    expect(c.issues.some((i: { code?: string; message: string }) => /none is authorized/.test(i.message))).toBe(true);
    expect(c.summary.canVote).toBe(1); expect(c.summary.authorized).toBe(1); // C-2 only
    expect(c.canFreeze).toBe(true);
  });

  test("any number of people in a flat may be authorized, and each can be taken away again; the other people are never touched", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const ids: string[] = (await flats(h, sid, jar)).flats[0].people.map((p: { voterId: string }) => p.voterId);
    for (const id of ids) expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: id }, jar)).status).toBe(200);
    let c = await flats(h, sid, jar);
    expect(c.flats[0].people.map((p: { authorized: boolean }) => p.authorized)).toEqual([true, true]);
    expect(c.summary.authorized).toBe(3); expect(c.summary.canVote).toBe(2); // two flats may vote; three people are authorized
    await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[0], authorized: false, reason: "tenant" }, jar);
    c = await flats(h, sid, jar);
    expect(c.flats[0].people.filter((p: { authorized: boolean }) => p.authorized)).toHaveLength(1);
    // asking for what is already true changes nothing and writes nothing
    const before = h.raw.query("SELECT COUNT(*) AS n FROM audit_entries").get() as { n: number };
    await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[0], authorized: false, reason: "tenant" }, jar);
    expect(h.raw.query("SELECT COUNT(*) AS n FROM audit_entries").get()).toEqual(before);
    // the signed trail names what happened
    const kinds = h.raw.query("SELECT type FROM audit_entries").all().map((r: any) => r.type);
    expect(kinds).toContain("unit.voter_authorized"); expect(kinds).toContain("unit.voter_unauthorized");
  });

  test("the frozen list holds every authorized person of the flat, with the flat's weight, and its fingerprint is checkable", async () => {
    const { h, jar, sid, slug } = await twoInOneFlat();
    const ids: string[] = (await flats(h, sid, jar)).flats[0].people.map((p: { voterId: string }) => p.voterId);
    for (const id of ids) await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: id }, jar);
    const f = await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    expect(f.status).toBe(201);
    const rows = h.raw.query("SELECT unit, is_voter, can_vote, weight_milli FROM publication_rows ORDER BY unit, seq").all() as Array<{ unit: string; is_voter: number; can_vote: number; weight_milli: number }>;
    const c1 = rows.filter((r) => r.unit === "C-1");
    expect(c1).toHaveLength(2); expect(c1.every((r) => r.is_voter === 1 && r.can_vote === 1 && r.weight_milli === 1000)).toBe(true);
    const pub = (await h.call("GET", `/api/v/${slug}/list`)).json;
    expect(pub.rows.filter((r: { unit: string; mayVote: boolean }) => r.unit.startsWith("C-1") && r.mayVote)).toHaveLength(2);
  });

  test("an upload may mark several people in a flat as authorized; people left blank in that flat stay undecided for the Organizer", async () => {
    const { parseUpload } = await import("../src/importer");
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote (Yes or leave blank)",
      "D-1,Asha One,Owner,9000000301,a1@sample.example,Yes", "D-1,Bela Two,Co-owner,9000000302,b2@sample.example,Yes", "D-1,Chandra Three,Tenant,9000000303,c3@sample.example,",
      "D-2,Dev One,Owner,9000000304,d1@sample.example,", "D-2,Esha Two,Co-owner,9000000305,e2@sample.example,", "D-3,Farid Only,Owner,9000000306,f1@sample.example,"].join("\n");
    const p = await parseUpload({ format: "csv", text: csv }, { country: "India", ruleCode: 2 });
    const by = (n: string) => p.rows.find((r) => r.name === n)!.isVoter;
    expect([by("Asha One"), by("Bela Two"), by("Chandra Three")]).toEqual([true, true, null]);
    expect([by("Dev One"), by("Esha Two")]).toEqual([null, null]); // nobody marked: the Organizer decides later
    expect(by("Farid Only")).toBe(true);
  });

  test("the sign-up template and the page words use the new label; Hindi has it too", () => {
    const hi = readFileSync(new URL("../public/assets/lang/hi.js", import.meta.url), "utf8");
    expect(hi).toContain(`"${LABEL}": "मालिक / पंजीकरण में पहला नाम"`);
    expect(hi).toContain("Owner \\/ 1st Name in Registration|Owner|"); // the "flat, role" line
    const ui = readFileSync(new URL("../public/assets/ui.js", import.meta.url), "utf8");
    expect(ui).toContain(LABEL);
    const work = readFileSync(new URL("../public/assets/organizer-work.js", import.meta.url), "utf8");
    expect(work).not.toContain("A flat has one vote");
  });

  test("the e-mail wording and the text helper map only the first role", async () => {
    const { capLabel } = await import("../src/text");
    expect(capLabel("Owner")).toBe(LABEL);
    expect(capLabel("Co-owner")).toBe("Co-owner"); expect(capLabel("Tenant")).toBe("Tenant"); expect(capLabel("")).toBe(""); expect(capLabel(null)).toBe("");
  });

  test("authorizing is staff-only, checks the person belongs to that flat of this list, needs a real true/false, and stops when the list is frozen", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const c = await flats(h, sid, jar);
    const [a, b]: string[] = c.flats[0].people.map((p: { voterId: string }) => p.voterId);
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-2", voterId: a }, jar)).status).toBe(404); // a person of another flat
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: a, authorized: "false" }, jar)).status).toBe(400); // not a real boolean
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: a, authorized: 0 }, jar)).status).toBe(400);
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: a }, {})).status).toBe(401); // signed out
    // a person of another list
    const other = await newList(h, { email: "other-org@sample.example" } as never);
    expect((await h.call("POST", `/api/lists/${other.sid}/units/choose`, { unit: "C-1", voterId: a }, other.jar)).status).toBe(404);
    // a Host may not decide who votes
    expect((await h.call("POST", `/api/lists/${sid}/team`, { email: "hostx@sample.example" }, jar)).status).toBe(201);
    const hostJar = await h.staff("hostx@sample.example");
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: a }, hostJar)).status).toBe(403);
    const hv = (await h.call("GET", `/api/lists/${sid}/checks`, undefined, hostJar)).json;
    expect(JSON.stringify(hv.flats)).not.toContain("Olga Owner"); // a Host sees the flat's people in the short form
    expect(hv.flats[0].people).toHaveLength(2);
    // frozen: no change any more
    for (const id of [a, b]) await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: id }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar)).status).toBe(201);
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: a, authorized: false, reason: "tenant" }, jar)).status).toBe(409);
  });

  test("the frozen list with two authorized people in a flat proves itself (signature and lines match the fingerprint)", async () => {
    const { h, jar, sid, slug } = await twoInOneFlat();
    for (const p of (await flats(h, sid, jar)).flats[0].people) await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: p.voterId }, jar);
    await h.call("POST", `/api/lists/${sid}/publish/frozen`, { eventName: "AGM", eventType: "meeting", confirm: "FREEZE", closeNow: true }, jar);
    const p = await h.call("GET", `/api/v/${slug}/proof`);
    expect(p.json.ok).toBe(true); expect(p.json.signature.valid).toBe(true); expect(p.json.linesMatchFingerprint).toBe(true);
  });

  test("flats still waiting for a choice come first; the page and the add-a-person dialog use the new words", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const c = (await flats(h, sid, jar));
    expect(c.flatsMore).toBe(0);
    const work = readFileSync(new URL("../public/assets/organizer-work.js", import.meta.url), "utf8");
    expect(work).toContain("options: caps.map((c) => ({ value: c, label: window.VL.cap(c) }))");
    const csvHead = (await import("../src/register")).registerCsv({ society: "S", kind: "RWA", state: "", country: "", regNo: "", regOffice: "", title: "t", versionLabel: "v", ruleCode: 2, weightMode: "equal", duesCutoff: null, fingerprint: "f" }, [], false);
    expect(csvHead).toContain("Weight (of the flat)");
  });

  test("a Host can neither take back the Organizer's authorization (undo) nor set it through an upload sheet", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const [a]: string[] = (await flats(h, sid, jar)).flats[0].people.map((p: { voterId: string }) => p.voterId);
    await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: a }, jar);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hosty@sample.example" }, jar);
    const hostJar = await h.staff("hosty@sample.example");
    const acts = (await h.call("GET", `/api/lists/${sid}/actions`, undefined, hostJar)).json.actions;
    const chosen = acts.find((x: { kind: string }) => x.kind === "voter_chosen");
    expect(chosen.undoable).toBe(false);
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: chosen.key }, hostJar)).status).toBe(403);
    expect((await h.call("GET", `/api/lists/${sid}/actions`, undefined, jar)).json.actions.find((x: { kind: string }) => x.kind === "voter_chosen").undoable).toBe(true);
    // the Organizer can
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: chosen.key }, jar)).status).toBe(200);
    // an upload by a Host: the "Authorized to vote" column is ignored
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote", "D-9,Esha One,Owner,9000000501,e1@sample.example,Yes", "D-9,Farid Two,Co-owner,9000000502,f2@sample.example,"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, hostJar)).status).toBe(200);
    expect(h.raw.query("SELECT is_voter FROM voters WHERE unit_key = 'D9' ORDER BY email").all()).toEqual([{ is_voter: null }, { is_voter: null }]);
  });

  test("a lone person can be taken off and put back, and a lone person the rule does not allow can be un-authorized, from the same table", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h, { ruleCode: 2 });
    await enrolVoter(h, slug, "ten@sample.example", { unit: "E-1", name: "Tina Tenant", capacity: "Tenant", mobile: "9000000141" });
    await enrolVoter(h, slug, "own@sample.example", { unit: "E-2", name: "Omar Owner", mobile: "9000000142" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    expect((await h.call("PATCH", `/api/lists/${sid}`, { ruleCode: 1 }, jar)).status).toBe(200); // the society narrows who may vote after people enrolled
    let c = await flats(h, sid, jar);
    expect(c.errors).toBe(1); // the tenant is authorized by default and this rule does not allow a tenant
    expect(c.flats.map((f: { unit: string }) => f.unit)).toEqual(["E-1"]); // the flat that needs a choice is listed; the fine lone owner is not
    const tina = c.flats[0].people[0].voterId;
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "E-1", voterId: tina, authorized: false, reason: "tenant" }, jar)).status).toBe(200);
    c = await flats(h, sid, jar);
    expect(c.errors).toBe(0); expect(c.flats[0].people[0].authorized).toBe(false); // still listed, so it can be put back
    expect(c.summary.canVote).toBe(1);
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "E-1", voterId: tina }, jar)).status).toBe(200);
    expect((await flats(h, sid, jar)).errors).toBe(1);
  });

  test("authorization does not travel with a person who moves to another flat (voter's own edit, or a correction by staff)", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "asha@sample.example", { unit: "F-1", name: "Asha One", mobile: "9000000151" });
    await enrolVoter(h, slug, "dev@sample.example", { unit: "F-1", name: "Dev Four", capacity: "Co-owner", mobile: "9000000154" });
    await enrolVoter(h, slug, "bela@sample.example", { unit: "F-2", name: "Bela Two", mobile: "9000000152" });
    await enrolVoter(h, slug, "chand@sample.example", { unit: "F-2", name: "Chand Three", capacity: "Co-owner", mobile: "9000000153" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const asha = h.raw.query("SELECT id FROM voters WHERE email = 'asha@sample.example'").get() as { id: string };
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "F-1", voterId: asha.id, authorized: true }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT is_voter FROM voters WHERE id = ?").get(asha.id)).toEqual({ is_voter: 1 });
    // staff correct the flat: the choice made for F-1 does not follow her into F-2
    expect((await h.call("PATCH", `/api/lists/${sid}/records/${asha.id}`, { unit: "F-2", reason: "Moved to the right flat" }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT is_voter FROM voters WHERE id = ?").get(asha.id)).toEqual({ is_voter: null });
    const c = await flats(h, sid, jar);
    expect(c.flats[0].people.every((p: { authorized: boolean }) => !p.authorized)).toBe(true); // F-2 now has three people and none chosen
  });

  test("an invited person marked Yes by the Organizer's upload who changes the flat in their own record does not carry the mark along", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote", "G-1,Gita One,Owner,9000000161,gita@sample.example,Yes", "G-1,Hari Two,Co-owner,9000000162,hari@sample.example,"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    const g = await h.member(slug, "gita@sample.example");
    const rec = (await h.call("GET", `/api/v/${slug}/me`, undefined, g)).json.records[0];
    expect(h.raw.query("SELECT is_voter FROM voters WHERE email = 'gita@sample.example'").get()).toEqual({ is_voter: 1 });
    const r = await h.call("PATCH", `/api/v/${slug}/records/${rec.id}`, { unit: "G-2" }, g);
    expect(r.status).toBe(200);
    expect(h.raw.query("SELECT unit, is_voter FROM voters WHERE email = 'gita@sample.example'").get()).toEqual({ unit: "G-2", is_voter: null });
  });

  test("the Organizer can look up ANY flat, even one with a lone person, and say no to that person", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const r = (await h.call("GET", `/api/lists/${sid}/checks?find=c-2`, undefined, jar)).json;
    expect(r.lookup).toHaveLength(1); expect(r.lookup[0].people).toHaveLength(1); expect(r.lookup[0].people[0].authorized).toBe(true); // the lone person votes by default
    expect((await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-2", voterId: r.lookup[0].people[0].voterId, authorized: false, reason: "tenant" }, jar)).status).toBe(200);
    const c = await flats(h, sid, jar);
    expect(c.summary.canVote).toBe(0);
    expect(c.flats.map((f: { unit: string }) => f.unit).sort()).toEqual(["C-1", "C-2"]); // now it needs a decision, so it is listed
    expect((await h.call("GET", `/api/lists/${sid}/checks?find=zzz`, undefined, jar)).json.lookup).toEqual([]);
  });

  test("a Host cannot move a person the Organizer has decided about, and a person removed and re-added keeps the Organizer's mark", async () => {
    const { h, jar, sid } = await twoInOneFlat();
    const ids: string[] = (await flats(h, sid, jar)).flats[0].people.map((p: { voterId: string }) => p.voterId);
    await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-1", voterId: ids[0] }, jar);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hostz@sample.example" }, jar);
    const hostJar = await h.staff("hostz@sample.example");
    expect((await h.call("PATCH", `/api/lists/${sid}/records/${ids[0]}`, { unit: "C-9", reason: "Typing slip" }, hostJar)).status).toBe(403);
    expect(h.raw.query("SELECT unit, is_voter FROM voters WHERE id = ?").get(ids[0]!)).toEqual({ unit: "C-1", is_voter: 1 });
    // a person the Organizer said no to (a lone person) is removed and added again by a Host: still no
    const lone = (await h.call("GET", `/api/lists/${sid}/checks?find=c-2`, undefined, jar)).json.lookup[0].people[0].voterId as string;
    await h.call("POST", `/api/lists/${sid}/units/choose`, { unit: "C-2", voterId: lone, authorized: false, reason: "tenant" }, jar);
    const row = h.raw.query("SELECT email, name, mobile FROM voters WHERE id = ?").get(lone) as { email: string; name: string; mobile: string };
    expect((await h.call("POST", `/api/lists/${sid}/records/remove`, { ids: [lone], reason: "Entered twice by mistake" }, hostJar)).status).toBe(200);
    expect((await h.call("POST", `/api/lists/${sid}/records`, { unit: "C-2", name: row.name, capacity: "Owner", mobile: row.mobile, email: row.email, agreed: true }, hostJar)).status).toBe(201);
    expect(h.raw.query("SELECT is_voter FROM voters WHERE email = ?").get(row.email)).toEqual({ is_voter: 0 });
    // the Organizer may move a person; the mark is cleared and the trail says so
    expect((await h.call("PATCH", `/api/lists/${sid}/records/${ids[0]}`, { unit: "C-9", reason: "Moved to the right flat" }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT is_voter FROM voters WHERE id = ?").get(ids[0]!)).toEqual({ is_voter: null });
  });

  test("an upload does not take the default vote from someone already registered in a flat, and the new label is accepted in an upload", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "alice@sample.example", { unit: "E-1", name: "Alice Early", mobile: "9000000171" });
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote", "E-1,Bob Later,Owner / 1st Name in Registration,9000000172,bob@sample.example,", "E-2,Cara New,Owner,9000000173,cara@sample.example,"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT email, capacity, is_voter FROM voters WHERE email IN ('bob@sample.example','cara@sample.example') ORDER BY email").all())
      .toEqual([{ email: "bob@sample.example", capacity: "Owner", is_voter: null }, { email: "cara@sample.example", capacity: "Owner", is_voter: 1 }]); // Bob joins a flat that has Alice: nothing is decided for him; Cara is alone in her flat
    expect(h.raw.query("SELECT is_voter FROM voters WHERE email = 'alice@sample.example'").get()).toEqual({ is_voter: null });
  });
});
