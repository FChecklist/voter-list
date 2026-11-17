// The price slot follows the Games pattern: the central payment service of IT SERVICES BY RAJAT AGARWAL opens and checks every payment.
// The central service is replaced here by a fake. These tests also prove the site never calls Razorpay itself and never holds a Razorpay key.
import { afterEach, describe, expect, test } from "bun:test";
import { enrolVoter, makeHarness, newList, waiting } from "./harness";

let lastRef = ""; // the payment reference the fake last saw, so a fresh fake still answers for the same order
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const CENTRAL = "https://itservices-rajat-agarwal.pages.dev";
type Call = { url: string; key: string | null; body: any };
/** A fake central service. `paid` decides what /api/pay/verify answers. */
function fakeCentral(o: { down?: boolean; paid?: boolean; amount?: number; ref?: string | null; plan?: string; currency?: string; rzpOrder?: string; rzpPay?: string } = {}) {
  const calls: Call[] = []; let n = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input); const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, key: init?.headers?.["x-site-key"] ?? null, body });
    if (init?.redirect && !["follow", "manual"].includes(init.redirect)) throw new TypeError("Invalid redirect value, must be one of follow or manual"); // what the Workers runtime does
    if (o.down) throw new Error("network down");
    if (url === `${CENTRAL}/api/pay/order`) { lastRef = body.payment_ref; return new Response(JSON.stringify({ ok: true, keyId: "rzp_test_PUBLICKEYID", orderId: "order_Test" + ++n, amount_minor: body.amount_minor, currency: body.currency }), { status: 200 }); }
    if (url === `${CENTRAL}/api/pay/verify`) return new Response(JSON.stringify({ ok: true, paid: o.paid ?? true, status: "captured", amount_minor: o.amount ?? 49900, currency: o.currency ?? "INR", stream: "sales", product: "voter_list", plan: o.plan ?? "save_version_1", payment_ref: o.ref === undefined ? lastRef : o.ref, razorpay_order_id: o.rzpOrder ?? body.razorpay_order_id, razorpay_payment_id: o.rzpPay ?? body.razorpay_payment_id }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}
const PAY = { PRICE_INR: "499", PAY_SERVICE_KEY: "site-key-for-tests", PAY_SITE: "voterlist.example" };

async function listWithOnePerson(env: Record<string, string>) {
  const h = await makeHarness(env); const { jar, sid, slug } = await newList(h);
  await enrolVoter(h, slug, "o@sample.example", { unit: "C-1", name: "Olga Owner", mobile: "9000000121" });
  await h.call("POST", `/api/lists/${sid}/records/decide`, { items: await waiting(h, sid, jar), decision: "approve" }, jar);
  return { h, jar, sid, slug };
}
const FREEZE = { eventName: "Pay Test Meeting", eventType: "meeting", confirm: "FREEZE", closeNow: true, ackWarnings: true, ackPending: true };
const verifyBody = (orderId: string) => ({ razorpay_order_id: orderId, razorpay_payment_id: "pay_Test1", razorpay_signature: "sig" });

describe("price slot: the central payment service", () => {
  test("without the key only test orders exist and the central service is never called", async () => {
    const calls = fakeCentral();
    const { h, jar, sid } = await listWithOnePerson({ PRICE_INR: "499" });
    const o = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(o.status).toBe(201); expect(o.json.test).toBe(true); expect(o.json.checkout).toBeUndefined();
    expect((await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/verify`, verifyBody("order_x"), jar)).status).toBe(503);
    expect(calls.length).toBe(0);
  });

  test("a real order is opened by the central service with the site key, and nothing talks to Razorpay", async () => {
    const calls = fakeCentral();
    const { h, jar, sid } = await listWithOnePerson(PAY);
    const o = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(o.status).toBe(201);
    expect(o.json.test).toBe(false);
    expect(o.json.checkout).toEqual({ frameUrl: `${CENTRAL}/payframe/`, key: "rzp_test_PUBLICKEYID", orderId: "order_Test1", amount: 49900, currency: "INR" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${CENTRAL}/api/pay/order`); expect(calls[0]!.key).toBe("site-key-for-tests");
    expect(calls[0]!.body).toEqual({ site: "voterlist.example", product: "voter_list", plan: "save_version_1", amount_minor: 49900, currency: "INR", payment_ref: o.json.id });
    expect(JSON.stringify(o.json)).not.toContain("site-key-for-tests"); // the site key never goes to the browser
    expect(calls.every((c) => c.url.startsWith(CENTRAL) && !/razorpay\.com/.test(c.url))).toBe(true);
    // asking again gives the same order and no second Razorpay order
    const again = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(again.json.id).toBe(o.json.id); expect(again.json.reused).toBe(true); expect(again.json.checkout.orderId).toBe("order_Test1"); expect(calls.length).toBe(1);
    // the test shortcut can never pay a real order
    expect((await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/test-pay`, undefined, jar)).status).toBe(404);
  });

  test("a key is never sent over plain http to a real host", async () => {
    const calls = fakeCentral();
    const { h, jar, sid } = await listWithOnePerson({ ...PAY, PAY_SERVICE_URL: "http://central.example" });
    const o = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(o.json.test).toBe(true); expect(calls.length).toBe(0);
  });

  test("central service down: nothing is charged, and trying again reuses the same order", async () => {
    fakeCentral({ down: true });
    const { h, jar, sid } = await listWithOnePerson(PAY);
    const bad = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(bad.status).toBe(502); expect(bad.json.message ?? bad.text).toContain("Nothing has been charged");
    const row = h.raw.query("SELECT id, rzp_order_id FROM orders").get() as { id: string; rzp_order_id: string | null };
    expect(row.rzp_order_id).toBeNull();
    const calls = fakeCentral();
    const ok = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(ok.status).toBe(201); expect(ok.json.id).toBe(row.id); expect(calls[0]!.body.payment_ref).toBe(row.id);
  });

  test("verify marks the order paid only when the central service confirms every fact, then the first freeze may go", async () => {
    fakeCentral();
    const { h, jar, sid } = await listWithOnePerson(PAY);
    const blocked = await h.call("POST", `/api/lists/${sid}/publish/frozen`, FREEZE, jar);
    expect(blocked.status).toBe(409); expect(blocked.json.code ?? blocked.json.error).toBeDefined();
    const o = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    // the wrong Razorpay order id
    expect((await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/verify`, verifyBody("order_Other"), jar)).status).toBe(400);
    for (const bad of [{ paid: false }, { amount: 100 }, { currency: "USD" }, { ref: "ord_someoneelse" }, { ref: null }, { plan: "other_plan" }, { rzpOrder: "order_Different" }, { rzpPay: "pay_Different" }]) {
      fakeCentral(bad);
      const r = await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/verify`, verifyBody(o.json.checkout.orderId), jar);
      expect(r.status).toBe(402);
      expect((h.raw.query("SELECT status FROM orders WHERE id = ?").get(o.json.id) as { status: string }).status).toBe("created");
    }
    expect((await h.call("POST", `/api/lists/${sid}/publish/frozen`, FREEZE, jar)).status).toBe(409); // still blocked
    fakeCentral();
    const good = await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/verify`, verifyBody(o.json.checkout.orderId), jar);
    expect(good.status).toBe(200); expect(good.json.status).toBe("paid");
    expect((await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/verify`, verifyBody(o.json.checkout.orderId), jar)).json.already).toBe(true); // safe to repeat
    const fr = await h.call("POST", `/api/lists/${sid}/publish/frozen`, FREEZE, jar);
    expect(fr.status).toBe(201);
    expect(h.raw.query("SELECT used_for_version FROM orders").get()).not.toEqual({ used_for_version: null });
    // the signed trail names the order and the amount, never a payment detail
    const trail = (h.raw.query("SELECT entry_json AS payload FROM audit_entries WHERE type = 'order.paid'").all() as { payload: string }[]).map((r) => r.payload).join("");
    expect(trail).toContain(o.json.id); expect(trail).not.toContain("pay_Test1"); expect(trail).not.toContain("sig");
  });

  test("a Host cannot open or confirm an order", async () => {
    fakeCentral();
    const { h, jar, sid } = await listWithOnePerson(PAY);
    await h.call("POST", `/api/lists/${sid}/team`, { email: "hostp@sample.example" }, jar);
    const hostJar = await h.staff("hostp@sample.example");
    expect((await h.call("POST", `/api/lists/${sid}/orders`, undefined, hostJar)).status).toBe(403);
  });

  test("the code holds no Razorpay key and never names Razorpay's own address", () => {
    const src = ["orders.ts", "handler.ts", "publish.ts", "db.ts"].map((f) => require("node:fs").readFileSync(`${import.meta.dir}/../src/${f}`, "utf8")).join("\n");
    expect(src).not.toMatch(/RAZORPAY_KEY|rzp_live|api\.razorpay\.com|checkout\.razorpay\.com/);
  });
});

describe("price slot: second audit round fixes", () => {
  test("a leftover paid TEST order never opens the gate once the central service is connected", async () => {
    fakeCentral();
    const { h, jar, sid } = await listWithOnePerson({ PRICE_INR: "499" });
    const t = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar); expect(t.json.test).toBe(true);
    expect((await h.call("POST", `/api/lists/${sid}/orders/${t.json.id}/test-pay`, undefined, jar)).status).toBe(200);
    Object.assign(h.env, PAY); // the owner connects the service later
    expect((await h.call("POST", `/api/lists/${sid}/publish/frozen`, FREEZE, jar)).status).toBe(409);
  });
  test("a wrong site key or an unset service gets its own code and the redirect/timeout guards are on", async () => {
    let init: any = null;
    globalThis.fetch = (async (_u: any, i: any) => { init = i; return new Response("{}", { status: 401 }); }) as unknown as typeof fetch;
    const { h, jar, sid } = await listWithOnePerson(PAY);
    const r = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    expect(r.status).toBe(502); expect(r.json.code).toBe("pay_service_config");
    expect(init.redirect).toBe("manual"); expect(init.signal).toBeDefined();
  });
  test("the migration keeps existing orders and refuses a paid real order without its Razorpay ids", async () => {
    const { h, sid } = await listWithOnePerson(PAY);
    expect(() => h.raw.query("INSERT INTO orders (id, society_id, purpose, amount_paise, status, test, created_by, created_at) VALUES ('ord_bad', ?, 'save_version_1', 100, 'paid', 0, 'x', 1)").run(sid)).toThrow();
  });
});

describe("price slot: round 31 fixes", () => {
  test("odd answers from the central service are refused, and odd verify input is a 400, not a 500", async () => {
    const mk = (extra: Record<string, unknown>) => { globalThis.fetch = (async (_u: any, i: any) => { const b = JSON.parse(i.body); return new Response(JSON.stringify({ ok: true, keyId: "rzp_test_K", orderId: "order_A1", amount_minor: b.amount_minor, currency: "INR", ...extra }), { status: 200 }); }) as unknown as typeof fetch; };
    for (const bad of [{ keyId: "" }, { keyId: "x" }, { orderId: "order_" + "a".repeat(300) }]) {
      mk(bad);
      const { h, jar, sid } = await listWithOnePerson(PAY);
      expect((await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar)).status).toBe(502);
      expect((h.raw.query("SELECT rzp_order_id FROM orders").get() as any).rzp_order_id).toBeNull();
    }
    mk({});
    const { h, jar, sid } = await listWithOnePerson(PAY);
    const o = await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar);
    for (const body of [{ razorpay_order_id: o.json.checkout.orderId, razorpay_payment_id: { toString: 1 }, razorpay_signature: "s" }, { razorpay_order_id: [o.json.checkout.orderId], razorpay_payment_id: "pay_1", razorpay_signature: "s" }])
      expect((await h.call("POST", `/api/lists/${sid}/orders/${o.json.id}/verify`, body, jar)).status).toBe(400);
  });
  test("a price outside the central service's range is refused before any call", async () => {
    const calls = fakeCentral();
    for (const p of ["0.5", "5000000.5"]) { const { h, jar, sid } = await listWithOnePerson({ ...PAY, PRICE_INR: p }); expect((await h.call("POST", `/api/lists/${sid}/orders`, undefined, jar)).status).toBe(500); }
    expect(calls.length).toBe(0);
  });
});
