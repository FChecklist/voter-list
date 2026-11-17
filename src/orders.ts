// The price slot. The price of the first frozen list is still to be confirmed by the owner (PRICE_INR unset = free; nothing is ever charged here).
// Payments follow the Games pattern, the owner's rule for every site: the site asks the CENTRAL payment service of IT SERVICES BY RAJAT AGARWAL
// (https://itservices-rajat-agarwal.pages.dev, one Razorpay ledger) to open the order and, after the buyer has paid in the payment frame
// (https://itservices-rajat-agarwal.pages.dev/payframe/), asks the same service whether it was really paid. This site has no Razorpay key,
// never calls Razorpay itself and never sees a card or UPI detail. Without PAY_SERVICE_KEY and PAY_SITE only test orders exist.
import { HttpError, rateLimit } from "./auth";
import { commit, guardChanged, staffActor } from "./audit";
import { uid } from "./db";
import { need, type StaffCtx } from "./store";
import type { Env } from "./db";

const DEFAULT_CENTRAL = "https://itservices-rajat-agarwal.pages.dev";
const PRODUCT = "voter_list";
const PLAN = "save_version_1";
/** Where the payment frame lives (the page that runs Razorpay Checkout; this site's address must be on its allow-list, a step for the owner's side). It sits on the same address as the central service. */
const frameUrl = (centralUrl: string) => `${centralUrl}/payframe/`;

/** The central service, or null when this site is not connected to it (then only test orders exist). */
export function central(env: Env): { url: string; key: string; site: string } | null {
  const key = (env.PAY_SERVICE_KEY ?? "").trim(), site = (env.PAY_SITE ?? "").trim();
  if (!key || !site) return null;
  const url = (env.PAY_SERVICE_URL ?? DEFAULT_CENTRAL).trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) return null; // a key is never sent over plain http to a real host
  return { url, key, site };
}

type Row = { id: string; amount_paise: number; status: string; test: number; rzp_order_id: string | null; rzp_key_id: string | null };

async function post(c: { url: string; key: string }, path: string, body: unknown): Promise<{ ok: boolean; status: number; d: any }> {
  try {
    // A short timeout, and no following of redirects: the site key must never follow a redirect to another host. ("manual" is what the Workers runtime accepts; a 3xx answer is not ok, so it fails.)
    const r = await fetch(`${c.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-site-key": c.key }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(8000) });
    const d: any = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d: d && typeof d === "object" ? d : {} };
  } catch { return { ok: false, status: 0, d: {} }; }
}

const view = (o: Row, reused: boolean, frame: string) => {
  const real = o.test === 0;
  return {
    id: o.id, amountPaise: o.amount_paise, status: o.status, test: !real, reused,
    gateway: real ? "central payment service" : "not connected (test mode only)",
    // Everything the payment frame needs to open Razorpay Checkout. The key id is the public one (it is shown in every checkout); there is no secret here.
    ...(real && o.status === "created" && o.rzp_order_id && o.rzp_key_id ? { checkout: { frameUrl: frame, key: o.rzp_key_id, orderId: o.rzp_order_id, amount: o.amount_paise, currency: "INR" } } : {}),
  };
};

export async function createOrder(ctx: StaffCtx) {
  need(ctx, "orders");
  if (!ctx.env.PRICE_INR) throw new HttpError(409, "No price is set, so freezing is free. Nothing to pay.", "no_price");
  const paise = Math.round(Number(ctx.env.PRICE_INR) * 100);
  if (!Number.isFinite(paise) || paise < 100 || paise > 500_000_000) throw new HttpError(500, "The price is not set correctly."); // the central service takes Rs 1 to Rs 50 lakh
  await rateLimit(ctx.env, `pay:${ctx.society.id}`, 20, 3_600_000, ctx.now); // each press may ask the central service
  const c = central(ctx.env);
  const test = c ? 0 : 1;
  const open = () => ctx.env.DB.prepare("SELECT id, amount_paise, status, test, rzp_order_id, rzp_key_id FROM orders WHERE society_id = ? AND purpose = 'save_version_1' AND used_for_version IS NULL").bind(ctx.society.id).first<Row>();
  let o = await open(); let reused = !!o;
  if (o && o.test !== test) throw new HttpError(409, "An earlier order of another kind is still open for this list. Please ask the owner's side to look at it. Nothing has been charged.", "order_kind");
  if (!o) {
    const id = uid("ord");
    try {
      await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare("INSERT INTO orders (id, society_id, purpose, amount_paise, status, test, created_by, created_at) VALUES (?, ?, 'save_version_1', ?, 'created', ?, ?, ?)").bind(id, ctx.society.id, paise, test, ctx.email, ctx.now)], "order.created", await staffActor(ctx.env, ctx.email, ctx.role), { order: id, amountPaise: paise, test }, ctx.now);
    } catch (e) {
      const again = /uq_order_open|UNIQUE/i.test(String((e as Error)?.message)) ? await open() : null;
      if (!again) throw e;
      if (c && again.status === "created" && !again.rzp_order_id) throw new HttpError(409, "The payment is being opened by another click. Please wait a moment and press the button again.", "try_again");
      return view(again, true, c ? frameUrl(c.url) : "");
    }
    o = { id, amount_paise: paise, status: "created", test, rzp_order_id: null, rzp_key_id: null };
  }
  if (c && o.status === "created" && !o.rzp_order_id) {
    // Ask the central service to open the Razorpay order. Our order id is the payment reference, so the ledger, Razorpay and this list match.
    const r = await post(c, "/api/pay/order", { site: c.site, product: PRODUCT, plan: PLAN, amount_minor: o.amount_paise, currency: "INR", payment_ref: o.id });
    if (r.status === 401 || r.status === 503) throw new HttpError(502, "The payment service could not be reached. Nothing has been charged. Please try again in a little while.", "pay_service_config"); // a wrong key or an unset service looks like an outage to the buyer, but has its own code for the owner's side
    if (!r.ok || typeof r.d.orderId !== "string" || !/^order_\w{1,40}$/.test(r.d.orderId) || typeof r.d.keyId !== "string" || !/^rzp_(test|live)_\w{1,60}$/.test(r.d.keyId) || r.d.amount_minor !== o.amount_paise || r.d.currency !== "INR")
      throw new HttpError(502, "The payment service could not be reached. Nothing has been charged. Please try again in a little while.", "pay_service");
    let set;
    try { set = await ctx.env.DB.prepare("UPDATE orders SET rzp_order_id = ?, rzp_key_id = ? WHERE id = ? AND status = 'created' AND rzp_order_id IS NULL").bind(r.d.orderId, r.d.keyId.slice(0, 80), o.id).run(); }
    catch (e) { if (/UNIQUE/i.test(String((e as Error)?.message))) throw new HttpError(502, "The payment service gave an unexpected answer. Nothing has been charged. Please try again in a little while.", "pay_service"); throw e; }
    if (!set.meta?.changes) { const now = await open(); if (now && now.rzp_order_id) return view(now, true, frameUrl(c.url)); throw new HttpError(409, "The payment is being opened by another click. Please wait a moment and press the button again.", "try_again"); }
    o = { ...o, rzp_order_id: r.d.orderId, rzp_key_id: r.d.keyId.slice(0, 80) };
  }
  return view(o, reused, c ? frameUrl(c.url) : "");
}

/** After the buyer has paid in the payment frame: ask the central service whether it was really paid, and only then mark the order paid. */
export async function verifyOrder(ctx: StaffCtx, orderId: string, input: { razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown }) {
  need(ctx, "orders");
  const c = central(ctx.env);
  if (!c) throw new HttpError(503, "The payment service is not connected yet. Nothing was charged.", "gateway_off");
  await rateLimit(ctx.env, `pay:${ctx.society.id}`, 20, 3_600_000, ctx.now);
  const o = await ctx.env.DB.prepare("SELECT id, amount_paise, status, test, rzp_order_id, rzp_key_id FROM orders WHERE id = ? AND society_id = ?").bind(orderId, ctx.society.id).first<Row>();
  if (!o || o.test !== 0 || !o.rzp_order_id) throw new HttpError(404, "Not found.", "not_found");
  if (o.status === "paid") return { id: o.id, status: "paid", test: false, already: true };
  if (typeof input.razorpay_order_id !== "string" || typeof input.razorpay_payment_id !== "string" || typeof input.razorpay_signature !== "string") throw new HttpError(400, "The payment details are incomplete.", "bad_payment");
  const oid = input.razorpay_order_id, pid = input.razorpay_payment_id, sig = input.razorpay_signature;
  if (oid !== o.rzp_order_id) throw new HttpError(400, "That payment is for a different order.", "order_mismatch");
  if (!/^pay_\w{1,60}$/.test(pid) || !sig || sig.length > 200) throw new HttpError(400, "The payment details are incomplete.", "bad_payment");
  const r = await post(c, "/api/pay/verify", { site: c.site, razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig });
  if (r.status === 0 || r.status >= 500) throw new HttpError(502, "The payment service could not be reached. If money was taken, it is safe: please press the button again in a little while.", "pay_service");
  const d = r.d;
  // Every fact must match THIS order: paid, the same amount and currency, and our own order id as the payment reference.
  if (!r.ok || d.ok !== true || d.paid !== true || d.amount_minor !== o.amount_paise || d.currency !== "INR" || d.payment_ref !== o.id || d.razorpay_order_id !== o.rzp_order_id || d.razorpay_payment_id !== pid || d.product !== PRODUCT || d.plan !== PLAN || d.stream !== "sales")
    throw new HttpError(402, "The payment could not be confirmed. Nothing has been marked as paid. If money was taken, please contact the owner's side with your order number " + o.id + ".", "not_paid");
  try {
    await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?, rzp_payment_id = ? WHERE id = ? AND status = 'created' AND test = 0 AND rzp_order_id = ?").bind(ctx.now, pid, o.id, oid), guardChanged(ctx.env, "That order is not waiting for payment.")], "order.paid", await staffActor(ctx.env, ctx.email, ctx.role), { order: o.id, amountPaise: o.amount_paise, test: 0 }, ctx.now);
  } catch (e) {
    const now = await ctx.env.DB.prepare("SELECT status FROM orders WHERE id = ? AND society_id = ?").bind(o.id, ctx.society.id).first<{ status: string }>();
    if (now?.status === "paid") return { id: o.id, status: "paid", test: false, already: true };
    throw e;
  }
  return { id: o.id, status: "paid", test: false };
}

export async function testPay(ctx: StaffCtx, orderId: string) {
  need(ctx, "orders");
  if (ctx.env.TEST_MODE !== "1") throw new HttpError(503, "The payment gateway is not connected yet. Nothing was charged.", "gateway_off");
  const o = await ctx.env.DB.prepare("SELECT id, test FROM orders WHERE id = ? AND society_id = ?").bind(orderId, ctx.society.id).first<{ id: string; test: number }>();
  if (!o || o.test !== 1) throw new HttpError(404, "Not found.", "not_found"); // a real order can only be paid through the central payment service
  await commit(ctx.env, ctx.society.id, [ctx.env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'created' AND test = 1").bind(ctx.now, orderId), guardChanged(ctx.env, "That order is not waiting for payment.")], "order.test_paid", await staffActor(ctx.env, ctx.email, ctx.role), { order: orderId, test: 1 }, ctx.now);
  return { id: orderId, status: "paid", test: true };
}
