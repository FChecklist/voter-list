// Elections: who may call which address. Every address is tried by every kind of person; each refusal comes before anything is read or changed.
import { describe, expect, test } from "bun:test";
import { newList } from "./harness";
import { AGENT, OBSERVER, RO, asMember, base, draft, emailOf, toVoting, voterUrl, type World } from "./elections-world";

type Row = [method: string, tail: string];
// the people named for one election, by what they may do
const RO_ONLY: Row[] = [["POST", "/nominations/nom_x/decide"], ["POST", "/challenges/1/answer"], ["POST", "/declare"]];
const TEAM: Row[] = [["GET", "/roll?find=a"], ["POST", "/paper/issue"], ["POST", "/count"]];
const ALL_OFFICIALS: Row[] = [["GET", "/nominations"], ["GET", "/count"]];
const SIGNED_IN: Row[] = [["GET", "/me"], ["GET", "/own-nominations"], ["POST", "/nominations"], ["POST", "/nominations/nom_x/withdraw"], ["POST", "/nominations/nom_x/appeal"], ["POST", "/ballot-code"], ["POST", "/ballot"], ["POST", "/vote"], ["POST", "/challenges"]];
const STAFF_CHANGE: Row[] = [["POST", ""], ["PATCH", "/ELECTION"], ["POST", "/ELECTION/notice"], ["POST", "/ELECTION/candidates/final"], ["POST", "/ELECTION/open"], ["POST", "/ELECTION/close"], ["POST", "/ELECTION/extend"], ["POST", "/ELECTION/nominations/nom_x/appeal/decide"]];
const STAFF_READ: Row[] = [["GET", ""], ["GET", "/ELECTION"], ["GET", "/ELECTION/nominations"]];

async function world() { const w = await base({ voters: 8 }).then((b) => draft(b)); await toVoting(w); return w; }
const call = (w: World, jar: any, [method, tail]: Row, staff = false) => {
  const url = staff ? `/api/lists/${w.sid}/elections${tail.replace("/ELECTION", "/" + w.eid)}` : voterUrl(w, tail);
  return w.h.call(method, url, method === "GET" ? undefined : {}, jar);
};
const allowed = (status: number) => status !== 401 && status !== 403 && status !== 404;
/** Turned away for who the person is: not signed in, or signed in but not allowed. Refusals of the details (a wrong code, a missing field) are not this. */
const turnedAway = (r: { status: number; json: any }) => r.json?.code === "signed_out" || r.status === 403;

describe("the people named for one election", () => {
  test("a signed-out person is turned away everywhere; a voter who is not named is turned away from every official address", async () => {
    const w = await world(); const voter = await asMember(w, emailOf(0));
    for (const row of [...RO_ONLY, ...TEAM, ...ALL_OFFICIALS, ...SIGNED_IN]) { const r = await call(w, {}, row); expect([row.join(" "), r.status, r.json.code]).toEqual([row.join(" "), 401, "signed_out"]); }
    for (const row of [...RO_ONLY, ...TEAM, ...ALL_OFFICIALS]) expect([row.join(" "), (await call(w, voter, row)).status]).toEqual([row.join(" "), 403]);
    for (const row of SIGNED_IN) expect([row.join(" "), turnedAway(await call(w, voter, row))]).toEqual([row.join(" "), false]); // a voter reaches these: the answer may refuse the details, never the person
  });

  test("an observer only reads; a counting agent works at the desk and counts but cannot decide, answer or declare; the returning officer can do all", async () => {
    const w = await world(); const observer = await asMember(w, OBSERVER), agent = await asMember(w, AGENT), ro = await asMember(w, RO);
    for (const row of [...RO_ONLY, ...TEAM]) expect([row.join(" "), (await call(w, observer, row)).status]).toEqual([row.join(" "), 403]);
    for (const row of ALL_OFFICIALS) expect([row.join(" "), allowed((await call(w, observer, row)).status)]).toEqual([row.join(" "), true]);
    for (const row of RO_ONLY) expect([row.join(" "), (await call(w, agent, row)).status]).toEqual([row.join(" "), 403]);
    for (const row of [...TEAM, ...ALL_OFFICIALS]) expect([row.join(" "), allowed((await call(w, agent, row)).status)]).toEqual([row.join(" "), true]);
    for (const row of [...RO_ONLY, ...TEAM, ...ALL_OFFICIALS]) { const s = (await call(w, ro, row)).status; expect([row.join(" "), s !== 401 && s !== 403]).toEqual([row.join(" "), true]); }
  });
});

describe("the Organizer and co-organizers", () => {
  test("a signed-out person is turned away; a co-organizer reads but changes nothing; the Organizer is not turned away", async () => {
    const w = await world();
    for (const row of [...STAFF_CHANGE, ...STAFF_READ]) { const r = await call(w, {}, row, true); expect([row.join(" "), r.status, r.json.code]).toEqual([row.join(" "), 401, "signed_out"]); }
    for (const row of STAFF_CHANGE) expect([row.join(" "), (await call(w, w.coJar, row, true)).status]).toEqual([row.join(" "), 403]);
    for (const row of STAFF_READ) expect([row.join(" "), (await call(w, w.coJar, row, true)).status]).toEqual([row.join(" "), 200]);
    for (const row of STAFF_CHANGE) { const s = (await call(w, w.jar, row, true)).status; expect([row.join(" "), s !== 401 && s !== 403]).toEqual([row.join(" "), true]); }
    for (const row of STAFF_READ) expect([row.join(" "), (await call(w, w.jar, row, true)).status]).toEqual([row.join(" "), 200]);
  });

  test("a person signed in on the common link is not staff, and a staff sign-in is not a voter sign-in", async () => {
    const w = await world(); const voter = await asMember(w, emailOf(0));
    for (const row of [...STAFF_CHANGE, ...STAFF_READ]) expect([row.join(" "), (await call(w, voter, row, true)).status]).toEqual([row.join(" "), 401]);
    for (const row of [...SIGNED_IN, ...ALL_OFFICIALS]) { const r = await call(w, w.jar, row); expect([row.join(" "), r.status, r.json.code]).toEqual([row.join(" "), 401, "signed_out"]); }
  });

  test("another list's Organizer cannot reach this election", async () => {
    const w = await world(); const other = await newList(w.h, { email: "other.organizer@sample.example" }); // a second list in the same database
    for (const row of [...STAFF_CHANGE, ...STAFF_READ].filter((x) => x[1].includes("ELECTION"))) {
      const asMember = await w.h.call(row[0], `/api/lists/${w.sid}/elections${row[1].replace("/ELECTION", "/" + w.eid)}`, row[0] === "GET" ? undefined : {}, other.jar); // the other Organizer is not on this list
      expect([row.join(" "), [401, 403, 404].includes(asMember.status)]).toEqual([row.join(" "), true]);
      const wrongList = await w.h.call(row[0], `/api/lists/${other.sid}/elections${row[1].replace("/ELECTION", "/" + w.eid)}`, row[0] === "GET" ? undefined : {}, other.jar); // this election is not on that list
      expect([row.join(" "), wrongList.status]).toEqual([row.join(" "), 404]);
    }
  });
});
