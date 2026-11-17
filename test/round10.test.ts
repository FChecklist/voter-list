// The owner's requirement of 14 Nov 2026 ("its very important"): whenever someone is NOT allowed to vote, a reason is chosen (a short list, or the
// person's own words), it is shown to the Organizer, the Hosts and the person, the public list shows it only as the Organizer allows (by default
// only reasons that follow from the role), it is in the signed trail with who and when, and a Host cannot change a reason the Organizer gave.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enrolVoter, makeHarness, newList, waiting, type Jar } from "./harness";

async function society() {
  const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "o@sample.example", { unit: "C-1", name: "Olga Owner", mobile: "9000000121" });
  await enrolVoter(h, slug, "co@sample.example", { unit: "C-1", name: "Ravi Coowner", capacity: "Co-owner", mobile: "9000000122" });
  await enrolVoter(h, slug, "t@sample.example", { unit: "C-2", name: "Tara Single", mobile: "9000000123" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  await h.call("POST", `/api/lists/${sid}/team`, { email: "hostz@sample.example" }, jar);
  const hostJar = await h.staff("hostz@sample.example");
  const idOf = (email: string) => (h.raw.query("SELECT id FROM voters WHERE email = ?").get(email) as { id: string }).id;
  return { h, jar, sid, slug, hostJar, olga: idOf("o@sample.example"), ravi: idOf("co@sample.example"), tara: idOf("t@sample.example") };
}
type S = Awaited<ReturnType<typeof society>>;
const choose = (s: S, jar: Jar, unit: string, voterId: string, body: Record<string, unknown>) => s.h.call("POST", `/api/lists/${s.sid}/units/choose`, { unit, voterId, ...body }, jar);
const checks = async (s: S, jar: Jar, q = "") => (await s.h.call("GET", `/api/lists/${s.sid}/checks${q}`, undefined, jar)).json;
const approveAll = (h: S["h"]) => h.raw.query("UPDATE voters SET status = 'approved', confirmed_at = 1, submitted_at = 1, decided_at = 1, decided_by = 'check@sample.example' WHERE status = 'invited'").run(); // as if each invited person had confirmed and the team had approved
const COOWNER = "Co-owner - not allowed to vote. Only the Owner / 1st name may vote";

describe("reasons for 'not allowed to vote'", () => {
  test("the Organizer can never say no silently: a reason from the list, or their own words, is needed", async () => {
    const s = await society();
    for (const bad of [{}, { reason: "" }, { reason: "because" }, { reason: "other" }, { reason: "other", note: "x" }, { reason: "tenant", note: "call me on 9876543210" }])
      expect((await choose(s, s.jar, "C-1", s.ravi, { authorized: false, ...bad })).status).toBe(400);
    expect(s.h.raw.query("SELECT is_voter, no_vote_reason FROM voters WHERE id = ?").get(s.ravi)).toEqual({ is_voter: null, no_vote_reason: null }); // nothing was written
    expect((await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "coowner" })).status).toBe(200);
    expect((await choose(s, s.jar, "C-2", s.tara, { authorized: false, reason: "other", note: "Left the society" })).status).toBe(200);
    expect(s.h.raw.query("SELECT no_vote_reason, no_vote_note, no_vote_by, is_voter FROM voters WHERE id = ?").get(s.tara)).toEqual({ no_vote_reason: "other", no_vote_note: "Left the society", no_vote_by: "organizer", is_voter: 0 });
    // giving the person their vote back clears the reason
    expect((await choose(s, s.jar, "C-2", s.tara, { authorized: true })).status).toBe(200);
    expect(s.h.raw.query("SELECT no_vote_reason, no_vote_note, no_vote_by, is_voter FROM voters WHERE id = ?").get(s.tara)).toEqual({ no_vote_reason: null, no_vote_note: null, no_vote_by: null, is_voter: 1 });
  });

  test("the reason reads in plain words for the Organizer and for a Host (the Host sees masked names but the whole reason)", async () => {
    const s = await society();
    await choose(s, s.jar, "C-1", s.olga, { authorized: true });
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "coowner" });
    for (const jar of [s.jar, s.hostJar]) {
      const c = await checks(s, jar);
      const ravi = c.flats.find((f: { unit: string }) => f.unit === "C-1").people.find((p: { voterId: string }) => p.voterId === s.ravi);
      expect(ravi.authorized).toBe(false); expect(ravi.reason).toBe(COOWNER); expect(ravi.reasonCode).toBe("coowner"); expect(ravi.reasonMissing).toBe(false);
    }
    // someone who is simply not chosen yet is told so, in words
    const pending = await society();
    const c = await checks(pending, pending.jar);
    expect(c.flats[0].people[0].reason).toBe("Waiting for the Organizer to choose who may vote for this flat");
  });

  test("the person sees their own reason, and a person who may vote is told so", async () => {
    const s = await society();
    await choose(s, s.jar, "C-1", s.olga, { authorized: true });
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "tenant", note: "Lives upstairs" });
    const ravi = (await s.h.call("GET", `/api/v/${s.slug}/me`, undefined, await s.h.member(s.slug, "co@sample.example"))).json.records[0];
    expect(ravi.vote).toEqual({ allowed: false, reason: "Tenant - not allowed to vote (Lives upstairs)" });
    const olga = (await s.h.call("GET", `/api/v/${s.slug}/me`, undefined, await s.h.member(s.slug, "o@sample.example"))).json.records[0];
    expect(olga.vote).toEqual({ allowed: true, reason: "" });
    const tara = (await s.h.call("GET", `/api/v/${s.slug}/me`, undefined, await s.h.member(s.slug, "t@sample.example"))).json.records[0];
    expect(tara.vote.allowed).toBe(true);
  });

  test("the rule is a reason too, in words", async () => {
    const s = await society();
    await enrolVoter(s.h, s.slug, "tina@sample.example", { unit: "C-5", name: "Tina Tenant", capacity: "Tenant", mobile: "9000000125" });
    await s.h.call("POST", `/api/lists/${s.sid}/records/decide`, { items: await waiting(s.h, s.sid, s.jar), decision: "approve" }, s.jar);
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}`, { ruleCode: 1 }, s.jar)).status).toBe(200); // the society narrows who may vote after people enrolled
    const c = await checks(s, s.jar, "?find=c-5");
    expect(c.lookup[0].people[0].authorized).toBe(true); expect(c.lookup[0].people[0].reason).toMatch(/^Tenant - not allowed to vote under this list's rule$/);
    const mine = (await s.h.call("GET", `/api/v/${s.slug}/me`, undefined, await s.h.member(s.slug, "tina@sample.example"))).json.records[0];
    expect(mine.vote.allowed).toBe(false); expect(mine.vote.reason).toMatch(/under this list's rule/);
  });

  test("public list: by default only reasons that follow from the role show; dues and own words stay private; the Organizer can show all or none", async () => {
    const s = await society();
    await choose(s, s.jar, "C-1", s.olga, { authorized: true });
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "coowner" });
    await s.h.call("POST", `/api/lists/${s.sid}/records`, { unit: "C-3", name: "Dev Dues", capacity: "Owner", mobile: "9000000124", email: "dev@sample.example", agreed: true }, s.jar);
    const dev = (s.h.raw.query("SELECT id FROM voters WHERE email = 'dev@sample.example'").get() as { id: string }).id;
    await choose(s, s.jar, "C-3", dev, { authorized: false, reason: "dues" });
    await choose(s, s.jar, "C-2", s.tara, { authorized: false, reason: "other", note: "Disputed membership" });
    const rowsOf = async () => ((await s.h.call("GET", `/api/v/${s.slug}/list`)).json.rows as Array<{ name: string; reason: string; mayVote: boolean }>);
    const reasonOf = (rows: Array<{ name: string; reason: string }>, who: string) => rows.find((r) => r.name.startsWith(who))!.reason;
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}`, { reasonPublic: "everything" }, s.jar)).status).toBe(400);
    await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    let rows = await rowsOf();
    expect(reasonOf(rows, "Ra")).toBe(COOWNER); expect(reasonOf(rows, "D*")).toBe(""); expect(reasonOf(rows, "Ta")).toBe("");
    expect(rows.find((r) => r.name.startsWith("D*"))!.mayVote).toBe(false); // the "No" is still public; only the why is private
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}`, { reasonPublic: "all" }, s.jar)).status).toBe(200);
    await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    rows = await rowsOf();
    expect(reasonOf(rows, "D*")).toBe("Dues unpaid - not allowed to vote"); expect(reasonOf(rows, "Ta")).toBe("Disputed membership - not allowed to vote");
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}`, { reasonPublic: "none" }, s.jar)).status).toBe(200);
    await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    rows = await rowsOf(); expect(rows.every((r) => r.reason === "")).toBe(true);
    // a Host cannot change the setting
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}`, { reasonPublic: "all" }, s.hostJar)).status).toBe(403);
    // the full reason is in the staff export, the public CSV carries only what is public
    const d = await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    const fullCsv = (await s.h.call("GET", `/api/lists/${s.sid}/publications/${d.json.id}/export.csv?full=1`, undefined, s.jar)).text;
    expect(fullCsv).toContain("Reason (if not allowed to vote)"); expect(fullCsv).toContain("Dues unpaid - not allowed to vote"); expect(fullCsv).toContain("Disputed membership - not allowed to vote"); // the Organizer's full register carries every reason
    const maskedCsv = (await s.h.call("GET", `/api/lists/${s.sid}/publications/${d.json.id}/export.csv`, undefined, s.jar)).text;
    expect(maskedCsv).not.toContain("Dues unpaid"); // the masked copy follows what is public
    const pubCsv = (await s.h.call("GET", `/api/v/${s.slug}/list.csv`)).text;
    expect(pubCsv).not.toContain("Dues unpaid"); expect(pubCsv).not.toContain("Disputed");
  });

  test("a Host can give a reason of their own, but cannot change or clear a reason the Organizer gave", async () => {
    const s = await society();
    const edit = (jar: Jar, id: string, body: Record<string, unknown>) => s.h.call("PATCH", `/api/lists/${s.sid}/records/${id}`, { reason: "Correction after checking the register", ...body }, jar);
    // no silent no, for a Host either
    expect((await edit(s.hostJar, s.tara, { canVote: false })).status).toBe(400);
    expect((await edit(s.hostJar, s.tara, { canVote: false, notAllowedReason: "dues" })).status).toBe(200);
    expect(s.h.raw.query("SELECT can_vote, no_vote_reason, no_vote_by FROM voters WHERE id = ?").get(s.tara)).toEqual({ can_vote: 0, no_vote_reason: "dues", no_vote_by: "host" });
    // the Host changes their own reason, and clears it again
    expect((await edit(s.hostJar, s.tara, { notAllowedReason: "tenant" })).status).toBe(200);
    expect((await edit(s.hostJar, s.tara, { canVote: true })).status).toBe(200);
    expect(s.h.raw.query("SELECT can_vote, no_vote_reason, no_vote_by FROM voters WHERE id = ?").get(s.tara)).toEqual({ can_vote: 1, no_vote_reason: null, no_vote_by: null });
    // the Organizer gives a reason through the record form: the Host cannot touch it
    expect((await edit(s.jar, s.tara, { canVote: false, notAllowedReason: "proxy_papers" })).status).toBe(200);
    expect(s.h.raw.query("SELECT no_vote_by FROM voters WHERE id = ?").get(s.tara)).toEqual({ no_vote_by: "organizer" });
    expect((await edit(s.hostJar, s.tara, { canVote: true })).status).toBe(403);
    expect((await edit(s.hostJar, s.tara, { notAllowedReason: "dues" })).status).toBe(403);
    expect((await edit(s.hostJar, s.tara, { canVote: false, notAllowedReason: "dues" })).status).toBe(403);
    expect(s.h.raw.query("SELECT can_vote, no_vote_reason, no_vote_by FROM voters WHERE id = ?").get(s.tara)).toEqual({ can_vote: 0, no_vote_reason: "proxy_papers", no_vote_by: "organizer" });
    // ... nor the reason the Organizer gave with the authorization choice
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "coowner" });
    expect((await edit(s.hostJar, s.ravi, { canVote: false, notAllowedReason: "dues" })).status).toBe(403);
    expect(s.h.raw.query("SELECT no_vote_reason FROM voters WHERE id = ?").get(s.ravi)).toEqual({ no_vote_reason: "coowner" });
    // the Organizer can still change it
    expect((await edit(s.jar, s.tara, { notAllowedReason: "other", notAllowedNote: "Papers lost" })).status).toBe(200);
    expect((await edit(s.jar, s.tara, { canVote: true })).status).toBe(200);
    expect(s.h.raw.query("SELECT can_vote, no_vote_reason FROM voters WHERE id = ?").get(s.tara)).toEqual({ can_vote: 1, no_vote_reason: null });
  });

  test("a Host cannot undo what discards the Organizer's reason either", async () => {
    const s = await society();
    await s.h.call("PATCH", `/api/lists/${s.sid}/records/${s.tara}`, { canVote: false, notAllowedReason: "tenant", reason: "Checked the register" }, s.jar);
    const acts = (await s.h.call("GET", `/api/lists/${s.sid}/actions`, undefined, s.hostJar));
    const list = (acts.json.actions ?? []) as Array<{ key: string; kind: string; undoable: boolean }>;
    const mine = list.find((a) => a.kind === "corrected");
    if (mine) { expect(mine.undoable).toBe(false); expect((await s.h.call("POST", `/api/lists/${s.sid}/undo`, { key: mine.key }, s.hostJar)).status).toBe(403); }
    expect(s.h.raw.query("SELECT can_vote, no_vote_reason FROM voters WHERE id = ?").get(s.tara)).toEqual({ can_vote: 0, no_vote_reason: "tenant" });
    // the Organizer can
    const orgActs = ((await s.h.call("GET", `/api/lists/${s.sid}/actions`, undefined, s.jar)).json.actions as Array<{ key: string; kind: string }>).find((a) => a.kind === "corrected")!;
    expect((await s.h.call("POST", `/api/lists/${s.sid}/undo`, { key: orgActs.key }, s.jar)).status).toBe(200);
    expect(s.h.raw.query("SELECT can_vote, no_vote_reason, no_vote_by FROM voters WHERE id = ?").get(s.tara)).toEqual({ can_vote: 1, no_vote_reason: null, no_vote_by: null });
  });

  test("the signed trail and the record history say which reason, who set it and when", async () => {
    const s = await society();
    s.h.clock.now += 60_000;
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "coowner", note: "Second name in the deed" });
    const entry = s.h.raw.query("SELECT ts, entry_json FROM audit_entries WHERE type = 'unit.voter_unauthorized'").get() as { ts: number; entry_json: string };
    expect(entry.ts).toBe(s.h.clock.now);
    const json = entry.entry_json;
    expect(json).toContain('"reason":"coowner"'); expect(json).toContain('"by":"organizer"');
    expect(json).not.toContain("Second name in the deed"); // the signed trail can never be erased, so it keeps the code, who and when, never the free text
    expect(JSON.stringify(s.h.raw.query("SELECT after_json FROM voter_events WHERE voter_id = ? AND kind = 'voter_chosen'").get(s.ravi))).toContain("Second name in the deed"); // the note stays with the record, which is erased with it
    const ev = s.h.raw.query("SELECT actor_role, ts, before_json, after_json FROM voter_events WHERE voter_id = ? AND kind = 'voter_chosen'").get(s.ravi) as { actor_role: string; ts: number; before_json: string; after_json: string };
    expect(ev.actor_role).toBe("organizer"); expect(ev.ts).toBe(s.h.clock.now);
    expect(JSON.parse(ev.before_json).no_vote_reason).toBeNull(); expect(JSON.parse(ev.after_json).no_vote_reason).toBe("coowner");
    // a Host's correction is in the trail the same way
    await s.h.call("PATCH", `/api/lists/${s.sid}/records/${s.tara}`, { canVote: false, notAllowedReason: "dues", reason: "Dues register checked" }, s.hostJar);
    const e2 = (s.h.raw.query("SELECT entry_json FROM audit_entries WHERE type = 'record.corrected' ORDER BY seq DESC").get() as { entry_json: string }).entry_json;
    expect(e2).toContain('"notAllowed"'); expect(e2).toContain('"reason":"dues"'); expect(e2).toContain('"by":"host"');
    const v = (await s.h.call("GET", `/api/lists/${s.sid}/audit/verify`, undefined, s.jar)).json; expect(v.ok ?? v.valid).toBe(true);
  });

  test("upload: a reason column carries the reason; a No without a reason is flagged and blocks the freeze until the Organizer fixes it", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote,Allowed to vote,Reason (if not allowed to vote)",
      "H-1,Hema One,Owner,9000000301,h1@sample.example,Yes,,", "H-1,Indu Two,Co-owner,9000000302,i2@sample.example,No,,Co-owner",
      "H-2,Jai One,Owner,9000000303,j1@sample.example,,,Dues unpaid", "H-3,Kiran One,Owner,9000000304,k1@sample.example,,No,",
      "H-4,Lata One,Owner,9000000305,l1@sample.example,,,Out of station for a year"].join("\n");
    const dry = (await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv, dryRun: true }, jar)).json;
    expect(dry.mapped).toContain("reason");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    const row = (e: string) => h.raw.query("SELECT is_voter, can_vote, no_vote_reason, no_vote_note, no_vote_by FROM voters WHERE email = ?").get(e);
    expect(row("i2@sample.example")).toEqual({ is_voter: 0, can_vote: 1, no_vote_reason: "coowner", no_vote_note: null, no_vote_by: "organizer" });
    expect(row("j1@sample.example")).toEqual({ is_voter: 0, can_vote: 1, no_vote_reason: "dues", no_vote_note: null, no_vote_by: "organizer" }); // a reason alone names the person as not allowed (the report says so)
    expect(row("k1@sample.example")).toEqual({ is_voter: 1, can_vote: 0, no_vote_reason: null, no_vote_note: null, no_vote_by: "organizer" }); // No without a reason: still the Organizer's no, so a Host cannot undo or override it
    expect(row("l1@sample.example")).toEqual({ is_voter: 0, can_vote: 1, no_vote_reason: "other", no_vote_note: "Out of station for a year", no_vote_by: "organizer" });
    approveAll(h);
    const c = await checks({ h, jar, sid } as unknown as S, jar);
    expect(c.canFreeze).toBe(false); expect(c.issues.some((i: { code: string; message: string }) => i.code === "E_REASON_MISSING" && /Kiran/.test(i.message))).toBe(true);
    const kiran = (h.raw.query("SELECT id FROM voters WHERE email = 'k1@sample.example'").get() as { id: string }).id;
    expect((await h.call("PATCH", `/api/lists/${sid}/records/${kiran}`, { canVote: false, notAllowedReason: "tenant", reason: "Reason added after the upload" }, jar)).status).toBe(200);
    const c2 = await checks({ h, jar, sid } as unknown as S, jar);
    expect(c2.canFreeze).toBe(true); void slug;
  });

  test("a reason written next to 'Yes' is a problem the Organizer must settle; a Host's upload cannot mark authorization or carry a reason for it", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const bad = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote,Reason", "M-1,Mona One,Owner,9000000311,m1@sample.example,Yes,Tenant"].join("\n");
    const d = (await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: bad, dryRun: true }, jar)).json;
    expect(d.problems.some((p: { field: string }) => p.field === "reason")).toBe(true);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hostq@sample.example" }, jar);
    const hostJar = await h.staff("hostq@sample.example");
    const hostCsv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote,Allowed to vote,Reason", "N-1,Nita One,Owner,9000000312,n1@sample.example,No,No,Tenant", "N-2,Omi One,Owner,9000000313,o1@sample.example,,,Tenant"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: hostCsv }, hostJar)).status).toBe(200);
    expect(h.raw.query("SELECT is_voter, can_vote, no_vote_reason, no_vote_by FROM voters WHERE email = 'n1@sample.example'").get()).toEqual({ is_voter: null, can_vote: 0, no_vote_reason: "tenant", no_vote_by: "host" });
    expect(h.raw.query("SELECT is_voter, can_vote, no_vote_reason, no_vote_by FROM voters WHERE email = 'o1@sample.example'").get()).toEqual({ is_voter: null, can_vote: 0, no_vote_reason: "tenant", no_vote_by: "host" }); // a Host's sheet cannot mark authorization, so the reason switches "allowed to vote" off instead: the sheet said no, the list says no
  });

  test("the frozen list keeps every reason as it was, the proof stays valid, and the template has a Reason column", async () => {
    const s = await society();
    await choose(s, s.jar, "C-1", s.olga, { authorized: true });
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "coowner" });
    await s.h.call("PATCH", `/api/lists/${s.sid}`, { cutoff: "2026-11-15T18:00" }, s.jar);
    s.h.clock.now = Date.UTC(2026, 10, 15, 13, 0, 0);
    const f = await s.h.call("POST", `/api/lists/${s.sid}/publish/frozen`, { eventName: "AGM 2026", eventType: "meeting", confirm: "FREEZE", ackPending: true, ackWarnings: true }, s.jar);
    expect(f.status).toBe(201);
    const stored = s.h.raw.query("SELECT name, reason_public, reason_full FROM publication_rows WHERE reason_full <> '' ORDER BY name").all() as Array<{ name: string; reason_public: string; reason_full: string }>;
    expect(stored.map((r) => r.reason_full)).toEqual([COOWNER]);
    expect(stored[0]!.reason_public).toBe(COOWNER);
    expect((await s.h.call("GET", `/api/v/${s.slug}/proof`)).json.ok).toBe(true);
    expect(() => s.h.raw.query("UPDATE publication_rows SET reason_full = 'x'").run()).toThrow(/immutable/);
    const tpl = readFileSync(new URL("../src/xlsx.ts", import.meta.url), "utf8");
    expect(tpl).toContain("Reason (if not allowed to vote)");
  });

  test("the front end asks for the reason and the Step 5 look-up re-reads the page after a change", () => {
    const work = readFileSync(new URL("../public/assets/organizer-work.js", import.meta.url), "utf8");
    expect(work).toContain("askReason"); expect(work).toContain('OR.reload("checks")'); expect(work).toContain("S.lookupQ");
    expect(work).toContain('org ? (o.authorized ? "Authorized ✓ (tap to take away)"'); // a Host reads plain words, not an invitation to tap
    const ui = readFileSync(new URL("../public/assets/ui.js", import.meta.url), "utf8");
    expect(ui).toContain("VL.askReason"); expect(ui).toContain("Dues unpaid");
  });

  test("a reason in a sheet without an Authorized column still means 'not allowed to vote'", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Mobile,E-mail,Reason", "R-1,Ria One,9000000321,r1@sample.example,Dues unpaid", "R-2,Sunil Two,9000000322,s2@sample.example,"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT is_voter, can_vote, no_vote_reason, no_vote_by FROM voters WHERE email = 'r1@sample.example'").get()).toEqual({ is_voter: null, can_vote: 0, no_vote_reason: "dues", no_vote_by: "organizer" });
    expect(h.raw.query("SELECT can_vote, no_vote_reason FROM voters WHERE email = 's2@sample.example'").get()).toEqual({ can_vote: 1, no_vote_reason: null });
  });

  test("the public wording never carries the person's own words, except when the Organizer chose to show every reason", async () => {
    const s = await society();
    await choose(s, s.jar, "C-1", s.olga, { authorized: true });
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "tenant", note: "owes four months of dues" });
    await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    let pub = (await s.h.call("GET", `/api/v/${s.slug}/list`)).json.rows.find((r: { name: string }) => r.name.startsWith("Ra")).reason;
    expect(pub).toBe("Tenant - not allowed to vote"); // the note is for the Organizer, the Hosts and the person
    const mine = (await s.h.call("GET", `/api/v/${s.slug}/me`, undefined, await s.h.member(s.slug, "co@sample.example"))).json.records[0].vote.reason;
    expect(mine).toBe("Tenant - not allowed to vote (owes four months of dues)");
    await s.h.call("PATCH", `/api/lists/${s.sid}`, { reasonPublic: "all" }, s.jar);
    await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    pub = (await s.h.call("GET", `/api/v/${s.slug}/list`)).json.rows.find((r: { name: string }) => r.name.startsWith("Ra")).reason;
    expect(pub).toBe("Tenant - not allowed to vote (owes four months of dues)");
  });

  test("contact details are refused in a reason in every way they are written, with a plain 400 (never a server error); a sheet's reason is kept without them", async () => {
    const s = await society();
    for (const note of ["call 98765 43210", "98765-43210", "+91 98765 43210", "9 8 7 6 5 4 3 2 1 0", "ravi(at)example.com", "mail me ravi@example.com", "see www.example.com", "९८७६५४३२१०"])
      expect((await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "tenant", note })).status).toBe(400);
    expect((await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "tenant", note: "Flat 3 rented since 2024" })).status).toBe(200);
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote,Reason", "K-1,Kala One,Owner,9000000331,k1@sample.example,No,call 98765 43210"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    expect(h.raw.query("SELECT no_vote_reason, no_vote_note FROM voters WHERE email = 'k1@sample.example'").get()).toEqual({ no_vote_reason: "other", no_vote_note: "reason not given" });
  });

  test("a person the Organizer said no to cannot change their own flat to get out of it; a Host's harmless action stays undoable", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote,Reason", "Z-1,Zoya One,Owner,9000000341,z1@sample.example,No,Tenant"].join("\n");
    await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar);
    const z = await h.member(slug, "z1@sample.example");
    const rec = (await h.call("GET", `/api/v/${slug}/me`, undefined, z)).json.records[0];
    expect((await h.call("PATCH", `/api/v/${slug}/records/${rec.id}`, { unit: "Z-2" }, z)).status).toBe(409);
    expect(h.raw.query("SELECT unit, is_voter, no_vote_reason FROM voters WHERE email = 'z1@sample.example'").get()).toEqual({ unit: "Z-1", is_voter: 0, no_vote_reason: "tenant" });
    // a Host's own approval of that record can be undone by the Host (it did not touch the reason)
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hostw@sample.example" }, jar);
    const hostJar = await h.staff("hostw@sample.example");
    await h.call("POST", `/api/v/${slug}/records/${rec.id}/confirm`, { consent: true }, z);
    await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, hostJar), decision: "approve" }, hostJar);
    const acts = (await h.call("GET", `/api/lists/${sid}/actions`, undefined, hostJar)).json.actions as Array<{ kind: string; undoable: boolean }>;
    expect(acts.find((a) => a.kind === "approved")!.undoable).toBe(true);
  });

  test("a Host cannot undo the Organizer's upload to wipe a 'no' and then add the person again", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote,Reason", "Y-1,Yash One,Owner,9000000351,y1@sample.example,No,Dues unpaid"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hosty@sample.example" }, jar);
    const hostJar = await h.staff("hosty@sample.example");
    const act = ((await h.call("GET", `/api/lists/${sid}/actions`, undefined, hostJar)).json.actions as Array<{ key: string; kind: string; undoable: boolean }>).find((a) => a.kind === "imported")!;
    expect(act.undoable).toBe(false);
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: act.key }, hostJar)).status).toBe(403);
    expect(h.raw.query("SELECT is_voter, no_vote_reason FROM voters WHERE email = 'y1@sample.example'").get()).toEqual({ is_voter: 0, no_vote_reason: "dues" });
    // the Organizer may undo it; an upload with no marks stays undoable by a Host
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: act.key }, jar)).status).toBe(200);
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: "Flat / House / Member ID,Name,Capacity,Mobile,E-mail\nY-2,Yami Two,Owner,9000000352,y2@sample.example" }, hostJar)).status).toBe(200);
    const a2 = ((await h.call("GET", `/api/lists/${sid}/actions`, undefined, hostJar)).json.actions as Array<{ key: string; kind: string; undoable: boolean }>).find((a) => a.kind === "imported")!;
    expect(a2.undoable).toBe(true);
  });

  test("ordinary notes are accepted (dates, amounts, flat numbers); phone numbers in any script or spacing and links are refused", async () => {
    const { hasContact } = await import("../src/reasons");
    for (const ok of ["Dues Rs 15000 pending since 2024-03", "Flat 1204 and 1205", "rate 500 @ month", "Paid up to 15-03-2024", "Moved out in March"]) expect(hasContact(ok)).toBe(false);
    for (const bad of ["98765 43210", "+91 98765-43210", "9 8 7 6 5 4 3 2 1 0", "९८७६५४३२१०", "９８７６５４３２１０", "ravi@example.com", "ravi(at)example", "t.me/ravi", "bit.ly/x", "www.x.com", "https://x.com/a"]) expect(hasContact(bad)).toBe(true);
  });

  test("filler in a sheet's Reason column ('na', '-', 'nil') is no reason; real words are kept", async () => {
    const { reasonFromSheet } = await import("../src/reasons");
    for (const f of ["na", "N/A", "-", "—", "nil", "None", "no", "ok", "x", "null", "nothing", "no issue"]) expect(reasonFromSheet(f)).toBeNull();
    expect(reasonFromSheet("Tenant")).toEqual({ code: "tenant", note: "" });
    expect(reasonFromSheet("Out of station")).toEqual({ code: "other", note: "Out of station" });
  });

  test("a Host cannot undo an Organizer's upload whose only mark is 'Allowed: No' (no reason), cannot override it, and the person cannot retype their flat; the signed trail counts the reasons", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Allowed to vote,Reason", "P-1,Pia One,Owner,9000000361,p1@sample.example,No,", "P-2,Quin One,Owner,9000000362,q1@sample.example,,Tenant"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    const imp = (h.raw.query("SELECT entry_json FROM audit_entries WHERE type = 'records.imported' ORDER BY seq DESC").get() as { entry_json: string } | null);
    expect(imp!.entry_json).toContain(String.raw`"reasons"`); expect(imp!.entry_json).toContain(String.raw`"tenant":1`); expect(imp!.entry_json).not.toContain("Tenant");
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hostp@sample.example" }, jar);
    const hostJar = await h.staff("hostp@sample.example");
    const act = ((await h.call("GET", `/api/lists/${sid}/actions`, undefined, hostJar)).json.actions as Array<{ key: string; kind: string; undoable: boolean }>).find((a) => a.kind === "imported")!;
    expect(act.undoable).toBe(false);
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: act.key }, hostJar)).status).toBe(403);
    const pia = (h.raw.query("SELECT id FROM voters WHERE email = 'p1@sample.example'").get() as { id: string }).id;
    expect((await h.call("PATCH", `/api/lists/${sid}/records/${pia}`, { canVote: true, reason: "Host tries to allow" }, hostJar)).status).toBe(403);
    const p = await h.member(slug, "p1@sample.example");
    const rec = (await h.call("GET", `/api/v/${slug}/me`, undefined, p)).json.records[0];
    expect((await h.call("PATCH", `/api/v/${slug}/records/${rec.id}`, { unit: "P-9" }, p)).status).toBe(409);
  });

  test("an Organizer's undo of an upload that carried a reason says in the trail which reasons it cleared", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Allowed to vote,Reason", "R-1,Rina One,Owner,9000000371,r1@sample.example,,Tenant"].join("\n");
    await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar);
    const act = ((await h.call("GET", `/api/lists/${sid}/actions`, undefined, jar)).json.actions as Array<{ key: string; kind: string }>).find((a) => a.kind === "imported")!;
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: act.key }, jar)).status).toBe(200);
    const all = (h.raw.query("SELECT entry_json FROM audit_entries ORDER BY seq").all() as Array<{ entry_json: string }>).map((e) => e.entry_json).join("\n");
    expect(all).toContain('"reasonsCleared":{"tenant":1}');
  });

  test("the sender name cannot carry quotes or control characters into the mail provider's request", async () => {
    const { fromHeader } = await import("../src/auth");
    expect(fromHeader({ MAIL_FROM: 'Town "Hall" <a@b.co>' } as never)).toBe('"Town Hall" <a@b.co>');
    expect(fromHeader({ MAIL_FROM: "a@b.co\r\nBcc: x@y.co" } as never)).not.toMatch(/[\r\n]/);
  });

  test("the mail provider is sent the sender in its documented form: { address, name }", async () => {
    const { fromObject } = await import("../src/auth");
    expect(fromObject({ MAIL_FROM: "Townhall Records <no-reply@townhall-records.com>" } as never)).toEqual({ address: "no-reply@townhall-records.com", name: "Townhall Records" });
    expect(fromObject({ MAIL_FROM: "no-reply@townhall-records.com" } as never)).toBe("no-reply@townhall-records.com");
  });

  test("a reason alone can be changed on a person the Organizer took off in Step 5; dues from the society's dues check stay private by default; the reason goes when the person moves flat", async () => {
    const s = await society();
    await choose(s, s.jar, "C-1", s.olga, { authorized: true });
    await choose(s, s.jar, "C-1", s.ravi, { authorized: false, reason: "tenant" });
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}/records/${s.ravi}`, { notAllowedReason: "coowner", reason: "Checked the deed" }, s.jar)).json.changed).toEqual(["reason"]);
    expect(s.h.raw.query("SELECT is_voter, no_vote_reason FROM voters WHERE id = ?").get(s.ravi)).toEqual({ is_voter: 0, no_vote_reason: "coowner" });
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}/records/${s.ravi}`, { notAllowedReason: "dues", reason: "Host trying" }, s.hostJar)).status).toBe(403);
    // moving the person to another flat clears the mark and the reason
    expect((await s.h.call("PATCH", `/api/lists/${s.sid}/records/${s.ravi}`, { unit: "C-7", reason: "Moved to the right flat" }, s.jar)).status).toBe(200);
    expect(s.h.raw.query("SELECT is_voter, no_vote_reason, no_vote_by FROM voters WHERE id = ?").get(s.ravi)).toEqual({ is_voter: null, no_vote_reason: null, no_vote_by: null });
    // unpaid dues found by the society's dues check: in words for staff and the person, not on the public list by default
    await s.h.call("PATCH", `/api/lists/${s.sid}`, { duesEnabled: true, duesCutoff: "2026-04-01" }, s.jar);
    await s.h.call("POST", `/api/lists/${s.sid}/publish/draft`, {}, s.jar);
    const c = await checks(s, s.jar, "?find=c-2");
    expect(c.lookup[0].people[0].reason).toBe("Dues unpaid - not allowed to vote");
    const pub = (await s.h.call("GET", `/api/v/${s.slug}/list`)).json.rows.find((r: { name: string }) => r.name.startsWith("Ta"));
    expect(pub.mayVote).toBe(false); expect(pub.reason).toBe("");
  });

  test("more flats with nobody authorized than fit: the count in the summary line is the true count", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const lines = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail"];
    for (let i = 1; i <= 25; i++) { lines.push(`P-${i},Person A${i},Owner,98${String(10000000 + i * 2).slice(0, 8)},a${i}@sample.example`); lines.push(`P-${i},Person B${i},Co-owner,98${String(10000000 + i * 2 + 1).slice(0, 8)},b${i}@sample.example`); }
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: lines.join("\n") }, jar)).status).toBe(200);
    approveAll(h);
    const c = await checks({ h, jar, sid } as unknown as S, jar);
    const line = c.issues.find((i: { message: string }) => /more flats have nobody authorized/.test(i.message));
    expect(line.message).toMatch(/^15 more flats/);
  });
});

describe("round 26: undo guard covers both kinds of mark", () => {
  test("a Host cannot undo an Organizer's upload whose only mark is 'Authorized: Yes'", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    const csv = ["Flat / House / Member ID,Name,Capacity,Mobile,E-mail,Authorized to vote", "S-1,Sia One,Owner,9000000381,s1@sample.example,Yes"].join("\n");
    expect((await h.call("POST", `/api/lists/${sid}/records/import`, { format: "csv", text: csv }, jar)).status).toBe(200);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hosts@sample.example" }, jar);
    const hostJar = await h.staff("hosts@sample.example");
    const act = ((await h.call("GET", `/api/lists/${sid}/actions`, undefined, hostJar)).json.actions as Array<{ key: string; kind: string; undoable: boolean }>).find((a) => a.kind === "imported")!;
    expect(act.undoable).toBe(false);
    expect((await h.call("POST", `/api/lists/${sid}/undo`, { key: act.key }, hostJar)).status).toBe(403);
  });
});
