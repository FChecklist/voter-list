// Roles: exactly 1 Organizer, up to 10 Hosts, and the standing Townhall Records host who sits outside the 10.
import { describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, PERM, waiting } from "./harness";

describe("the team", () => {
  test("ten hosts fit; the eleventh is refused; the standing host does not use a seat", async () => {
    const h = await makeHarness(); const { jar, sid } = await newList(h);
    for (let i = 1; i <= 10; i++) { const r = await h.call("POST", `/api/lists/${sid}/team`, { email: `host${i}@sample.example` }, jar); expect(r.status).toBe(201); }
    const eleven = await h.call("POST", `/api/lists/${sid}/team`, { email: "host11@sample.example" }, jar);
    expect(eleven.status).toBeGreaterThanOrEqual(400); expect(eleven.status).toBeLessThan(500);
    const t = (await h.call("GET", `/api/lists/${sid}/team`, undefined, jar)).json;
    expect(t.hostsUsed).toBe(10); expect(t.team).toHaveLength(12); // organizer + standing host + 10
    expect(t.team.filter((m: any) => m.role === "organizer")).toHaveLength(1);
    // the database itself refuses an eleventh, even around the code
    expect(() => h.raw.query("INSERT INTO memberships (society_id, email, role, status, created_at) VALUES (?, 'x@sample.example', 'host', 'active', 1)").run(sid)).toThrow();
  });

  test("removing a host frees a seat; the standing host and the Organizer cannot be removed", async () => {
    const h = await makeHarness(); const { jar, sid, email } = await newList(h);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "host1@sample.example" }, jar);
    expect((await h.call("DELETE", `/api/lists/${sid}/team/${encodeURIComponent("host1@sample.example")}`, undefined, jar)).status).toBe(200);
    expect((await h.call("GET", `/api/lists/${sid}/team`, undefined, jar)).json.hostsUsed).toBe(0);
    expect((await h.call("DELETE", `/api/lists/${sid}/team/${encodeURIComponent(PERM)}`, undefined, jar)).status).toBe(409);
    expect((await h.call("DELETE", `/api/lists/${sid}/team/${encodeURIComponent(email)}`, undefined, jar)).status).toBe(409);
    expect(() => h.raw.query("DELETE FROM memberships WHERE email = ?").run(PERM)).toThrow();
    expect(() => h.raw.query("UPDATE memberships SET status = 'removed' WHERE email = ?").run(PERM)).toThrow();
  });

  test("the Organizer role can be handed over, and there is still exactly one", async () => {
    const h = await makeHarness(); const { jar, sid, email } = await newList(h);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "next@sample.example" }, jar);
    expect((await h.call("POST", `/api/lists/${sid}/team/organizer`, { email: PERM }, jar)).status).toBe(400);
    expect((await h.call("POST", `/api/lists/${sid}/team/organizer`, { email: "next@sample.example" }, jar)).status).toBe(200);
    const t = (await h.call("GET", `/api/lists/${sid}/team`, undefined, await h.staff("next@sample.example"))).json.team;
    expect(t.filter((m: any) => m.role === "organizer").map((m: any) => m.email)).toEqual(["next@sample.example"]);
    expect(t.find((m: any) => m.email === email).role).toBe("host");
    expect(() => h.raw.query("UPDATE memberships SET role = 'organizer' WHERE email = ?").run(email)).toThrow(); // a second organizer is refused
  });

  test("a stranger cannot even tell the list exists", async () => {
    const h = await makeHarness(); const { sid } = await newList(h);
    const s = await h.staff("stranger@sample.example");
    expect((await h.call("GET", `/api/lists/${sid}`, undefined, s)).status).toBe(404);
    expect((await h.call("GET", `/api/lists/${sid}/records`, undefined, s)).status).toBe(404);
    expect((await h.call("GET", `/api/lists/${sid}`)).status).toBe(401);
  });

  test("the standing host works on the Organizer's behalf, sees records masked, and every opening is on the signed log", async () => {
    const h = await makeHarness(); const { jar, sid, slug } = await newList(h);
    await enrolVoter(h, slug, "asha@sample.example", { name: "Asha Sample" });
    const host = await h.staff(PERM);
    const list = (await h.call("GET", `/api/lists/${sid}/records`, undefined, host)).json;
    expect(list.masked).toBe(true); expect(list.records[0].name).not.toContain("Sample"); expect(list.records[0].email).not.toContain("asha@");
    const w = list.records.map((x: any) => ({ id: x.id, rev: x.revision }));
    const open = await h.call("GET", `/api/lists/${sid}/records/${w[0].id}`, undefined, host);
    expect(open.status).toBe(200); expect(JSON.stringify(open.json)).toContain("Asha Sample");
    expect((await h.call("POST", `/api/lists/${sid}/records/decide`, { items: w, decision: "approve" }, host)).json.applied).toBe(1);
    // what a host may NOT do
    expect((await h.call("PATCH", `/api/lists/${sid}`, { name: "Renamed Association" }, host)).status).toBe(403);
    expect((await h.call("POST", `/api/lists/${sid}/publish/draft`, {}, host)).status).toBe(403);
    expect((await h.call("POST", `/api/lists/${sid}/team`, { email: "z@sample.example" }, host)).status).toBe(403);
    expect((await h.call("POST", `/api/lists/${sid}/erase`, { confirm: "ERASE" }, host)).status).toBe(403);
    // the audit trail names the identity for each action
    const a = (await h.call("GET", `/api/lists/${sid}/audit`, undefined, jar)).json;
    const kinds = (a.entries as any[]).map((e) => e.entry.type);
    expect(kinds).toContain("record.opened"); expect(kinds.some((k) => k.startsWith("record") && k !== "record.opened")).toBe(true);
    const opened = a.entries.find((e: any) => e.entry.type === "record.opened");
    expect(a.people[opened.entry.actor.pid]).toEqual({ who: PERM, role: "standing host" });
    // the signed trail is intact
    const v = (await h.call("GET", `/api/lists/${sid}/audit/verify`, undefined, jar)).json;
    expect(v.ok).toBe(true);
    void waiting;
  });

  test("a host can be configured away: with a different standing host address the list gets that one", async () => {
    const h = await makeHarness({ PERMANENT_HOST_EMAIL: "ops@sample.example" }); const { jar, sid } = await newList(h);
    const t = (await h.call("GET", `/api/lists/${sid}/team`, undefined, jar)).json.team;
    expect(t.find((m: any) => m.permanent).email).toBe("ops@sample.example");
  });
});
