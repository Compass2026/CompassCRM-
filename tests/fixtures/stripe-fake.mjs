// A fake Stripe for the billing tests (B2, B3): an in-memory object store
// behind the same StripeApi interface the sync layer and stripe-billing use
// (get / list, with `expand` and cursor-free listing; customer search; the
// creates stripe-billing makes, with Stripe's idempotency-key semantics),
// injectable failures, and signed webhook events. Objects are written in the pinned "basil" API shapes (the
// subscription period on its items, invoice.parent.subscription_details,
// invoice.payments, line.pricing). Fictional ids and addresses only.
import { StripeApiError } from "../../supabase/functions/_shared/stripe/api.ts";
import { stripeSignature } from "../../supabase/functions/_shared/stripe/signature.ts";

const clone = (o) => JSON.parse(JSON.stringify(o));
export const T0 = 1790000000; // 2026-09-21T14:13:20Z

// searchLag: customers created through the API stay out of search results
// (Stripe's search index lags writes by up to a minute).
export function fakeStripe({ mode = "test", achAvailable = true, searchLag = false } = {}) {
  const objects = new Map();
  const failures = [];
  const calls = [];
  const idempotency = new Map();
  const unindexed = new Set();
  let eventN = 0;
  let seq = 0;
  const livemode = mode === "live";
  const rand = () => `${(++seq).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const now = () => Math.floor(Date.now() / 1000);
  const subscriptionsOf = (cus) => ({ object: "list", data: [...objects.values()].filter((o) => o.object === "subscription" && o.customer === cus).map(clone) });
  const bad = (path, message, extra = {}) => new StripeApiError(400, { error: { type: "invalid_request_error", message, ...extra } }, path);

  // The creates stripe-billing makes. Each returns the stored object.
  function create(path, params) {
    if (path === "/v1/customers") {
      return { id: `cus_${rand()}`, object: "customer", livemode, name: params.name ?? null, email: params.email ?? null,
        currency: null, invoice_settings: { default_payment_method: null }, metadata: params.metadata ?? {}, created: now() };
    }
    if (path === "/v1/prices") {
      const product = objects.get(params.product);
      if (!product) throw bad(path, `No such product: '${params.product}'`, { param: "product" });
      return { id: `price_${rand()}`, object: "price", livemode, product: params.product, active: true, type: params.recurring ? "recurring" : "one_time",
        currency: params.currency, unit_amount: Number(params.unit_amount), billing_scheme: "per_unit",
        recurring: params.recurring ? { interval: params.recurring.interval, interval_count: Number(params.recurring.interval_count ?? 1), usage_type: "licensed" } : null,
        nickname: params.nickname ?? null, metadata: params.metadata ?? {}, created: now() };
    }
    if (path === "/v1/checkout/sessions") {
      if (!achAvailable && params.payment_method_types?.includes("us_bank_account")) {
        throw bad(path, "The payment method type `us_bank_account` is invalid. Please ensure the provided type is activated in your dashboard.",
          { param: "payment_method_types" });
      }
      for (const li of params.line_items ?? []) if (!objects.has(li.price)) throw bad(path, `No such price: '${li.price}'`, { param: "line_items[0][price]" });
      const id = `cs_${mode}_${rand()}`;
      return { id, object: "checkout.session", livemode, mode: params.mode, customer: params.customer, client_reference_id: params.client_reference_id ?? null,
        status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: now() + 86400,
        metadata: params.metadata ?? {}, subscription: null, invoice: null, payment_intent: null, created: now(),
        payment_method_types: params.payment_method_types, success_url: params.success_url, cancel_url: params.cancel_url,
        line_items_requested: params.line_items, subscription_data: params.subscription_data ?? null };
    }
    const expire = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
    if (expire) {
      const cs = objects.get(expire[1]);
      if (!cs) throw new StripeApiError(404, { error: { code: "resource_missing", message: "No such session" } }, path);
      if (cs.status !== "open") throw bad(path, `This Checkout Session is already in a terminal state: ${cs.status}`);
      return { ...cs, status: "expired", url: null };
    }
    if (path === "/v1/billing_portal/configurations") {
      return { id: `bpc_${rand()}`, object: "billing_portal.configuration", livemode, active: true, is_default: false,
        business_profile: params.business_profile ?? {}, default_return_url: params.default_return_url ?? null,
        features: {
          customer_update: { enabled: !!params.features?.customer_update?.enabled, allowed_updates: params.features?.customer_update?.allowed_updates ?? [] },
          invoice_history: { enabled: !!params.features?.invoice_history?.enabled },
          payment_method_update: { enabled: !!params.features?.payment_method_update?.enabled },
          subscription_cancel: { enabled: !!params.features?.subscription_cancel?.enabled },
          subscription_update: { enabled: !!params.features?.subscription_update?.enabled },
        },
        metadata: params.metadata ?? {}, created: now() };
    }
    if (path === "/v1/billing_portal/sessions") {
      if (!objects.has(params.customer)) throw bad(path, `No such customer: '${params.customer}'`, { param: "customer" });
      if (params.configuration && !objects.has(params.configuration)) throw bad(path, "No such configuration", { param: "configuration" });
      const id = `bps_${rand()}`;
      return { id, object: "billing_portal.session", livemode, customer: params.customer, configuration: params.configuration,
        return_url: params.return_url, url: `https://billing.stripe.com/p/session/${mode}_${rand()}`, created: now() };
    }
    throw new Error(`fake Stripe: no POST ${path}`);
  }

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
      if (o.object === "customer" && (params.expand ?? []).includes("subscriptions")) o.subscriptions = subscriptionsOf(o.id);
      for (const e of params.expand ?? []) expandInto(o, e.split("."));
      return o;
    },
    // Stripe's search: exact email, name substring, or a metadata value.
    async search(path, query, opts = {}) {
      calls.push(`${path}?query=${query}`);
      maybeFail(path);
      if (path !== "/v1/customers/search") throw new Error(`fake Stripe: no search ${path}`);
      const unq = (v) => v.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      let m;
      let pred;
      if ((m = query.match(/^email:'(.*)'$/))) pred = (c) => (c.email ?? "").toLowerCase() === unq(m[1]).toLowerCase();
      else if ((m = query.match(/^name~'(.*)'$/))) pred = (c) => (c.name ?? "").toLowerCase().includes(unq(m[1]).toLowerCase());
      else if ((m = query.match(/^metadata\['([a-z_]+)'\]:'(.*)'$/))) pred = (c) => c.metadata?.[m[1]] === unq(m[2]);
      else throw new StripeApiError(400, { error: { type: "invalid_request_error", message: `bad query ${query}` } }, path);
      return byKind("customer").filter((c) => !c.deleted && !unindexed.has(c.id) && pred(c)).slice(0, opts.limit ?? 10).map((c) => {
        const o = clone(c);
        if ((opts.expand ?? []).includes("data.subscriptions")) o.subscriptions = subscriptionsOf(c.id);
        return o;
      });
    },
    // Creates, with Stripe's idempotency: the same key and parameters return
    // the first answer; the same key with other parameters is refused.
    async post(path, params = {}, opts = {}) {
      calls.push(`POST ${path}`);
      maybeFail(path);
      const key = opts.idempotencyKey;
      const sig = JSON.stringify([path, params]);
      if (key && idempotency.has(key)) {
        const prior = idempotency.get(key);
        if (prior.sig !== sig) {
          throw new StripeApiError(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } }, path);
        }
        return clone(prior.result);
      }
      const o = create(path, params);
      objects.set(o.id, clone(o));
      if (searchLag && o.object === "customer") unindexed.add(o.id);
      if (key) idempotency.set(key, { sig, result: clone(o) });
      return clone(o);
    },
    async list(path, params = {}) {
      calls.push(`${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => !Array.isArray(v))).toString()}`);
      maybeFail(path);
      const lines = path.match(/^\/v1\/invoices\/([^/]+)\/lines$/);
      if (lines) return clone(objects.get(lines[1])?.lines_data ?? []);
      if (path === "/v1/prices") return byKind("price").filter((p) => p.product === params.product).map(clone);
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
    all(kind) { return byKind(kind).map(clone); },
    // The customer pays a Checkout Session: Stripe creates the subscription,
    // its first invoice and the payment, and completes the session.
    complete(sessionId, { status = "active", paymentStatus = "paid" } = {}) {
      const cs = objects.get(sessionId);
      const li = cs.line_items_requested[0];
      const price = objects.get(li.price);
      const n = rand();
      const t = now();
      const sub = { id: `sub_${n}`, object: "subscription", livemode, customer: cs.customer, status, collection_method: "charge_automatically",
        currency: price.currency, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, pause_collection: null,
        cancellation_details: { reason: null, feedback: null, comment: null }, start_date: t, billing_cycle_anchor: t,
        latest_invoice: `in_${n}`, default_payment_method: null, metadata: cs.subscription_data?.metadata ?? {}, created: t,
        items: { object: "list", data: [{ id: `si_${n}`, object: "subscription_item", price: price.id, quantity: li.quantity,
          current_period_start: t, current_period_end: t + 30 * 86400, created: t }] } };
      const amount = price.unit_amount * li.quantity;
      const paid = paymentStatus === "paid";
      const pi = { id: `pi_${n}`, object: "payment_intent", livemode, customer: cs.customer, status: paid ? "succeeded" : "processing", amount,
        currency: price.currency, latest_charge: paid ? `ch_${n}` : null, payment_method_types: ["card"], last_payment_error: null, created: t };
      const ch = { id: `ch_${n}`, object: "charge", livemode, payment_intent: pi.id, amount, amount_refunded: 0, created: t, payment_method_details: { type: "card" } };
      const inv = { id: `in_${n}`, object: "invoice", livemode, customer: cs.customer, number: `C-${n}`, status: paid ? "paid" : "open",
        billing_reason: "subscription_create", collection_method: "charge_automatically", currency: price.currency, subtotal: amount, total: amount,
        amount_due: amount, amount_paid: paid ? amount : 0, amount_remaining: paid ? 0 : amount, attempt_count: 1, attempted: true,
        next_payment_attempt: null, due_date: null, period_start: t, period_end: t + 30 * 86400,
        hosted_invoice_url: `https://invoice.stripe.com/i/in_${n}`, invoice_pdf: `https://pay.stripe.com/invoice/in_${n}/pdf`,
        paid_out_of_band: false, created: t, status_transitions: { finalized_at: t, paid_at: paid ? t : null },
        parent: { type: "subscription_details", subscription_details: { subscription: sub.id } },
        payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: pi.id } }] },
        lines_data: [{ id: `il_${n}`, object: "line_item", amount, currency: price.currency, quantity: li.quantity, description: price.nickname ?? "Package",
          period: { start: t, end: t + 30 * 86400 }, pricing: { price_details: { price: price.id, product: price.product } },
          parent: { type: "subscription_item_details", subscription_item_details: { subscription_item: `si_${n}`, proration: false } } }] };
      for (const o of [sub, pi, ch, inv]) objects.set(o.id, o);
      if (!paid) objects.delete(ch.id);
      objects.set(sessionId, { ...cs, status: "complete", payment_status: paymentStatus === "paid" ? "paid" : "unpaid", url: null,
        subscription: sub.id, invoice: inv.id });
      return { subscription: sub.id, invoice: inv.id, payment_intent: pi.id };
    },
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
