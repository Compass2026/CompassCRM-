// A fake Stripe for the billing sync tests (B2): an in-memory object store
// behind the same StripeApi interface the sync layer uses (get / list, with
// `expand` and cursor-free listing), injectable failures, and signed webhook
// events. Objects are written in the pinned "basil" API shapes (the
// subscription period on its items, invoice.parent.subscription_details,
// invoice.payments, line.pricing). Fictional ids and addresses only.
import { StripeApiError } from "../../supabase/functions/_shared/stripe/api.ts";
import { stripeSignature } from "../../supabase/functions/_shared/stripe/signature.ts";

const clone = (o) => JSON.parse(JSON.stringify(o));
export const T0 = 1790000000; // 2026-09-21T14:13:20Z

export function fakeStripe({ mode = "test" } = {}) {
  const objects = new Map();
  const failures = [];
  const calls = [];
  let eventN = 0;

  function expandInto(o, parts) {
    if (!o || parts.length === 0) return;
    const [k, ...rest] = parts;
    if (k === "data" && Array.isArray(o.data)) {
      for (const x of o.data) expandInto(x, rest);
      return;
    }
    if (typeof o[k] === "string" && objects.has(o[k])) o[k] = clone(objects.get(o[k]));
    if (o[k] && typeof o[k] === "object") expandInto(o[k], rest);
  }
  function maybeFail(path) {
    const f = failures.find((x) => path.includes(x.match) && x.times > 0);
    if (f) {
      f.times -= 1;
      throw new StripeApiError(f.status, { error: { message: `injected ${f.status}`, type: "api_error" } }, path);
    }
  }
  const byKind = (kind) => [...objects.values()].filter((o) => o.object === kind);

  const api = {
    mode,
    async get(path, params = {}) {
      calls.push(path);
      maybeFail(path);
      const id = path.split("/").pop();
      if (!objects.has(id)) throw new StripeApiError(404, { error: { code: "resource_missing", message: `No such object: ${id}` } }, path);
      const o = clone(objects.get(id));
      for (const e of params.expand ?? []) expandInto(o, e.split("."));
      return o;
    },
    async list(path, params = {}) {
      calls.push(`${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => !Array.isArray(v))).toString()}`);
      maybeFail(path);
      const lines = path.match(/^\/v1\/invoices\/([^/]+)\/lines$/);
      if (lines) return clone(objects.get(lines[1])?.lines_data ?? []);
      if (path === "/v1/refunds") return byKind("refund").filter((r) => r.payment_intent === params.payment_intent).map(clone);
      if (path === "/v1/subscriptions") return byKind("subscription").filter((s) => s.customer === params.customer).map(clone);
      if (path === "/v1/invoices") return byKind("invoice").filter((s) => s.customer === params.customer).map(clone);
      if (path === "/v1/payment_intents") return byKind("payment_intent").filter((s) => s.customer === params.customer).map(clone);
      throw new Error(`fake Stripe: no list ${path}`);
    },
  };

  return {
    api,
    calls,
    put(o) { objects.set(o.id, clone(o)); return o; },
    patch(id, fields) { const o = { ...objects.get(id), ...fields }; objects.set(id, o); return clone(o); },
    remove(id) { objects.delete(id); },
    get(id) { return clone(objects.get(id)); },
    fail(match, times = 1, status = 500) { failures.push({ match, times, status }); },
    // An event carrying a snapshot of the object (possibly stale by delivery time).
    event(type, obj, { livemode = mode === "live", created = T0 + ++eventN } = {}) {
      return { id: `evt_${type.replace(/[^A-Za-z0-9]/g, "")}${eventN}${Math.random().toString(36).slice(2, 8)}`, object: "event", type,
        livemode, created, api_version: "2025-03-31.basil", data: { object: clone(obj) } };
    },
  };
}

// A signed webhook request, as Stripe sends it.
export async function signedRequest(event, secret, { t = Math.floor(Date.now() / 1000), tamper = false } = {}) {
  const body = JSON.stringify(event);
  const sig = await stripeSignature(secret, t, body);
  return new Request("http://x/stripe-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${tamper ? sig.replace(/.$/, (c) => (c === "0" ? "1" : "0")) : sig}` },
    body,
  });
}

// One customer's Stripe state: a standard package on a monthly price, two
// seats, an ACH-paid first invoice with two partial refunds.
export function seedCustomer(s, { cus = "cus_A", sub = "sub_A", inv = "in_A1", pi = "pi_A1", py = "py_A1", livemode = false, prefix = "A" } = {}) {
  s.put({ id: "prod_Std", object: "product", livemode, name: "Compass Marketing Package", active: true, metadata: {}, created: T0 });
  s.put({ id: "price_StdM", object: "price", livemode, product: "prod_Std", active: true, type: "recurring", currency: "usd",
    unit_amount: 150000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    metadata: {}, created: T0 });
  s.put({ id: `pm_${prefix}`, object: "payment_method", type: "us_bank_account", us_bank_account: { bank_name: "STRIPE TEST BANK", last4: "6789" } });
  s.put({ id: cus, object: "customer", livemode, email: `owner-${prefix.toLowerCase()}@example.test`, name: `Client ${prefix}`,
    currency: "usd", invoice_settings: { default_payment_method: `pm_${prefix}` }, metadata: {}, created: T0 });
  s.put({ id: sub, object: "subscription", livemode, customer: cus, status: "active", collection_method: "charge_automatically",
    currency: "usd", cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, pause_collection: null,
    cancellation_details: { reason: null, feedback: null, comment: null }, start_date: T0, billing_cycle_anchor: T0,
    latest_invoice: inv, default_payment_method: `pm_${prefix}`, metadata: {}, created: T0,
    items: { object: "list", data: [{ id: `si_${prefix}`, object: "subscription_item", price: "price_StdM", quantity: 2,
      current_period_start: T0, current_period_end: T0 + 30 * 86400, created: T0 }] } });
  s.put({ id: py, object: "charge", livemode, payment_intent: pi, amount: 300000, amount_refunded: 150000, created: T0 + 3 * 86400,
    payment_method_details: { type: "us_bank_account" } });
  s.put({ id: pi, object: "payment_intent", livemode, customer: cus, status: "succeeded", amount: 300000, currency: "usd",
    latest_charge: py, payment_method_types: ["us_bank_account"], last_payment_error: null, created: T0 });
  s.put({ id: `pyr_${prefix}1`, object: "refund", payment_intent: pi, charge: py, amount: 100000, currency: "usd", status: "succeeded",
    reason: "requested_by_customer", failure_reason: null, created: T0 + 5 * 86400 });
  s.put({ id: `pyr_${prefix}2`, object: "refund", payment_intent: pi, charge: py, amount: 50000, currency: "usd", status: "succeeded",
    reason: null, failure_reason: null, created: T0 + 6 * 86400 });
  s.put({ id: inv, object: "invoice", livemode, customer: cus, number: `${prefix}-0001`, status: "paid", billing_reason: "subscription_create",
    collection_method: "charge_automatically", currency: "usd", subtotal: 300000, total: 300000, amount_due: 300000, amount_paid: 300000,
    amount_remaining: 0, attempt_count: 1, attempted: true, next_payment_attempt: null, due_date: null,
    period_start: T0, period_end: T0 + 30 * 86400, hosted_invoice_url: `https://invoice.stripe.com/i/${inv}`, invoice_pdf: null,
    paid_out_of_band: false, created: T0, status_transitions: { finalized_at: T0, paid_at: T0 + 3 * 86400 },
    parent: { type: "subscription_details", subscription_details: { subscription: sub } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: pi } }] },
    lines_data: [{ id: `il_${prefix}1`, object: "line_item", amount: 300000, currency: "usd", quantity: 2, description: "2 × Compass Marketing Package",
      period: { start: T0, end: T0 + 30 * 86400 },
      pricing: { price_details: { price: "price_StdM", product: "prod_Std" } },
      parent: { type: "subscription_item_details", subscription_item_details: { subscription_item: `si_${prefix}`, proration: false } } }] });
}
