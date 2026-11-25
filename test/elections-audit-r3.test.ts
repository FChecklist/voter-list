// Elections: fixes after the third audit round (release 0.6.0). Each test reads the real database after the real step and asserts the stored outcome.
import { describe, expect, test } from "bun:test";
import { base, draft, staffUrl, toVoting, type World } from "./elections-world";

const q = (w: World, sql: string, ...a: unknown[]) => w.h.raw.query(sql).all(...(a as never[])) as any[];
async function story() { const w = await base({ voters: 8 }).then((b) => draft(b)); await toVoting(w); return w; }

describe("a standing candidate who joins the team while voting is open stops the closing and the extending", () => {
  test("closing and extending are refused with staff_stands, nothing changes, and both work again once the nomination is withdrawn", async () => {
    const w = await story();
    const standing = q(w, "SELECT email FROM el_nominations WHERE status = 'accepted' ORDER BY id LIMIT 1")[0].email as string;
    expect(q(w, "SELECT status FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "voting" }]);
    const closeAt = q(w, "SELECT voting_close_at FROM el_elections WHERE id = ?", w.eid)[0].voting_close_at as number;
    w.jar = await w.h.staff(w.organizer);
    const added = await w.h.call("POST", `/api/lists/${w.sid}/team`, { email: standing }, w.jar);
    expect(added.status).toBe(201);
    const c = await w.h.call("POST", staffUrl(w, "/close"), { confirm: "CLOSE", reason: "Everybody who wanted to vote has voted." }, w.jar);
    expect([c.status, c.json.code]).toEqual([409, "staff_stands"]);
    const x = await w.h.call("POST", staffUrl(w, "/extend"), { until: "2026-11-21T10:00", reason: "More people asked for more time." }, w.jar);
    expect([x.status, x.json.code]).toEqual([409, "staff_stands"]);
    expect(q(w, "SELECT status, voting_close_at FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "voting", voting_close_at: closeAt }]);
    expect(q(w, "SELECT COUNT(*) AS n FROM audit_entries WHERE type IN ('election.voting_closed','election.voting_extended')")).toEqual([{ n: 0 }]);
    // the nomination is withdrawn: the team member no longer stands
    q(w, "UPDATE el_nominations SET status = 'withdrawn' WHERE email = ?", standing);
    const ok = await w.h.call("POST", staffUrl(w, "/close"), { confirm: "CLOSE", reason: "Everybody who wanted to vote has voted." }, w.jar);
    expect(ok.status).toBe(200);
    expect(q(w, "SELECT status FROM el_elections WHERE id = ?", w.eid)).toEqual([{ status: "closed" }]);
  });
});
