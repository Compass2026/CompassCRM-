// The shared Stripe sync layer (B2): webhook signatures, the Stripe → mirror
// mappers (the pinned "basil" shapes and the older field locations), and the
// sync orchestrator over a fake Stripe (fetch-on-event, deleted objects,
// refunds, resync). The database side (billing_sync_apply) is the sandbox's
// billing_sync.test.sql; end to end: tests/stripe-webhook-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripeSignature, verifyStripeSignature } from "../supabase/functions/_shared/stripe/signature.ts";
import { createStripeApi, keyMode, STRIPE_API_VERSION } from "../supabase/functions/_shared/stripe/api.ts";
import {
  customerRow, invoiceLineRows, invoicePaymentIntentIds, invoiceRow, invoiceSubscriptionId, paymentRow, priceRow,
  refundRow, subscriptionItemRows, subscriptionRow,
} from "../supabase/functions/_shared/stripe/map.ts";
import { createStripeSync, outcome, STRIPE_WEBHOOK_EVENTS } from "../supabase/functions/_shared/stripe/sync.ts";
import { fakeStripe, seedCustomer, T0 } from "./fixtures/stripe-fake.mjs";

const AT = "2026-09-29T12:00:00.000Z";

test("signatures: valid, tampered, expired, missing, several v1 values", async () => {
  const body = '{"id":"evt_1"}';
  const t = 1790000000;
  const sig = await stripeSignature("whsec_test", t, body);
  assert.deepEqual(await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test", { now: t + 10 }), { ok: true });
  assert.deepEqual(await verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, "whsec_test", { now: t }), { ok: true });
  assert.equal((await verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, "whsec_test", { now: t })).reason, "mismatch");
  assert.equal((await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", { now: t })).reason, "mismatch");
  assert.equal((await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test", { now: t + 301 })).reason, "expired");
  assert.equal((await verifyStripeSignature(body, null, "whsec_test")).reason, "missing");
  assert.equal((await verifyStripeSignature(body, "v1=abc", "whsec_test")).reason, "malformed");
});

test("api: pinned version, key mode, expand and pagination through fetch", async () => {
  assert.equal(keyMode("sk_test_x"), "test");
  assert.equal(keyMode("rk_live_x"), "live");
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    const u = new URL(url);
    if (u.pathname === "/v1/customers/cus_1") return new Response(JSON.stringify({ id: "cus_1" }));
    if (u.pathname === "/v1/refunds") {
      const after = u.searchParams.get("starting_after");
      return new Response(JSON.stringify(after ? { data: [{ id: "re_3" }], has_more: false } : { data: [{ id: "re_1" }, { id: "re_2" }], has_more: true }));
    }
    return new Response(JSON.stringify({ error: { code: "resource_missing", message: "nope" } }), { status: 404 });
  };
  const api = createStripeApi({ secretKey: "sk_test_x", fetch });
  await api.get("/v1/customers/cus_1", { expand: ["invoice_settings.default_payment_method"] });
  assert.equal(seen[0].init.headers["stripe-version"], STRIPE_API_VERSION);
  assert.equal(seen[0].init.headers.authorization, "Bearer sk_test_x");
  assert.match(seen[0].url, /expand%5B%5D=invoice_settings.default_payment_method/);
  assert.deepEqual((await api.list("/v1/refunds", { payment_intent: "pi_1" })).map((r) => r.id), ["re_1", "re_2", "re_3"]);
  await assert.rejects(api.get("/v1/customers/cus_nope"), (e) => e.missing === true && e.status === 404);
});

test("map: subscription period from its items (basil) or the subscription (older), cancellation and pause", () => {
  const s = fakeStripe(); seedCustomer(s);
  const sub = s.get("sub_A");
  const row = subscriptionRow(sub, AT);
  assert.equal(row.current_period_end, new Date((T0 + 30 * 86400) * 1000).toISOString());
  assert.equal(row.stripe_customer_id, "cus_A");
  assert.equal(row.latest_stripe_invoice_id, "in_A1");
  assert.equal(row.stripe_synced_at, AT);
  const legacy = subscriptionRow({ ...sub, current_period_end: T0 + 99, cancel_at_period_end: true, pause_collection: { behavior: "keep_as_draft", resumes_at: null },
    cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: null } }, AT);
  assert.equal(legacy.current_period_end, new Date((T0 + 99) * 1000).toISOString());
  assert.equal(legacy.cancel_at_period_end, true);
  assert.equal(legacy.pause_collection_behavior, "keep_as_draft");
  assert.equal(legacy.cancellation_feedback, "too_expensive");
  assert.deepEqual(subscriptionItemRows(sub, AT), [{ stripe_subscription_item_id: "si_A", stripe_price_id: "price_StdM", quantity: 2,
    stripe_created_at: new Date(T0 * 1000).toISOString(), stripe_synced_at: AT }]);
});

test("map: invoice subscription, payments and lines in both shapes", () => {
  const s = fakeStripe(); seedCustomer(s);
  const inv = s.get("in_A1");
  assert.equal(invoiceSubscriptionId(inv), "sub_A");
  assert.equal(invoiceSubscriptionId({ subscription: "sub_Old" }), "sub_Old");
  assert.deepEqual(invoicePaymentIntentIds(inv), ["pi_A1"]);
  assert.deepEqual(invoicePaymentIntentIds({ payment_intent: "pi_Old" }), ["pi_Old"]);
  const row = invoiceRow(inv, AT);
  assert.equal(row.status, "paid");
  assert.equal(row.amount_remaining_cents, 0);
  assert.equal(row.paid_at, new Date((T0 + 3 * 86400) * 1000).toISOString());
  const [line] = invoiceLineRows(inv.lines_data, AT);
  assert.deepEqual([line.stripe_price_id, line.stripe_product_id, line.stripe_subscription_item_id, line.proration, line.amount_cents],
    ["price_StdM", "prod_Std", "si_A", false, 300000]);
  const [old] = invoiceLineRows([{ id: "il_old", amount: -500, currency: "usd", price: { id: "price_X", product: "prod_X" },
    subscription_item: "si_X", proration: true, period: { start: T0, end: T0 } }], AT);
  assert.deepEqual([old.stripe_price_id, old.stripe_product_id, old.stripe_subscription_item_id, old.proration, old.amount_cents],
    ["price_X", "prod_X", "si_X", true, -500]);
});

test("map: payment, refund (mode from the PaymentIntent), customer payment method, price", () => {
  const s = fakeStripe(); seedCustomer(s);
  const pi = s.get("pi_A1");
  const charge = s.get("py_A1");
  const row = paymentRow(pi, charge, AT, "in_A1");
  assert.deepEqual([row.stripe_charge_id, row.payment_method_type, row.amount_cents, row.amount_refunded_cents, row.stripe_invoice_id, row.status],
    ["py_A1", "us_bank_account", 300000, 150000, "in_A1", "succeeded"]);
  assert.equal("stripe_invoice_id" in paymentRow(pi, charge, AT), false, "an unknown invoice is left out, never nulled");
  const failed = paymentRow({ ...pi, status: "requires_payment_method", last_payment_error: { code: "card_declined", message: "Declined" } }, null, AT);
  assert.deepEqual([failed.failure_code, failed.paid_at], ["card_declined", null]);
  const r = refundRow(s.get("pyr_A1"), false, AT);
  assert.deepEqual([r.livemode, r.amount_cents, r.status, r.stripe_payment_intent_id], [false, 100000, "succeeded", "pi_A1"]);
  const c = customerRow({ ...s.get("cus_A"), invoice_settings: { default_payment_method: s.get("pm_A") } }, AT);
  assert.deepEqual([c.default_payment_method_type, c.default_payment_method_last4], ["us_bank_account", "6789"]);
  assert.equal("default_payment_method_type" in customerRow(s.get("cus_A"), AT), false, "an unexpanded method is left out");
  const p = priceRow(s.get("price_StdM"), AT);
  assert.deepEqual([p.recurring_interval, p.unit_amount_cents, p.stripe_product_id], ["month", 150000, "prod_Std"]);
});

function recordingStore() {
  const batches = [];
  return {
    batches,
    async apply(ops) { batches.push(ops); return ops.map((o) => ({ op: o.op, id: o.id ?? null, result: o.op === "checkout_session" ? "missing" : "written" })); },
    async linkCustomer(p) { batches.push([{ op: "link", ...p }]); },
  };
}

test("sync: a subscription event reads Stripe now, not the event's payload", async () => {
  const s = fakeStripe(); seedCustomer(s);
  const stale = s.get("sub_A");
  s.patch("sub_A", { status: "past_due" });
  const store = recordingStore();
  const sync = createStripeSync({ api: s.api, store, now: () => new Date(AT) });
  await sync.syncEvent(s.event("customer.subscription.updated", stale));
  const ops = store.batches.flat();
  assert.deepEqual(ops.map((o) => o.op), ["product", "price", "subscription"]);
  assert.equal(ops[2].row.status, "past_due");
  assert.equal(ops[2].items.length, 1);
});

test("sync: an invoice brings its subscription first, then its lines, then its payment with every refund", async () => {
  const s = fakeStripe(); seedCustomer(s);
  const store = recordingStore();
  const sync = createStripeSync({ api: s.api, store });
  await sync.syncEvent(s.event("invoice.paid", s.get("in_A1")));
  const ops = store.batches.flat().map((o) => o.op);
  assert.deepEqual(ops, ["product", "price", "subscription", "invoice", "payment", "refund", "refund"]);
  const pay = store.batches.flat().find((o) => o.op === "payment");
  assert.equal(pay.row.stripe_invoice_id, "in_A1");
  assert.equal(store.batches.flat().filter((o) => o.op === "refund").reduce((n, o) => n + o.row.amount_cents, 0), 150000);
});

test("sync: charge.refunded and refund.updated resync the whole payment (every partial refund)", async () => {
  const s = fakeStripe(); seedCustomer(s);
  const store = recordingStore();
  const sync = createStripeSync({ api: s.api, store });
  await sync.syncEvent(s.event("charge.refunded", s.get("py_A1")));
  await sync.syncEvent(s.event("refund.updated", s.get("pyr_A2")));
  for (const batch of store.batches) assert.deepEqual(batch.map((o) => o.op), ["payment", "refund", "refund"]);
});

test("sync: deleted objects are recorded from the event, without asking Stripe", async () => {
  const s = fakeStripe();
  const store = recordingStore();
  const sync = createStripeSync({ api: s.api, store });
  await sync.syncEvent(s.event("customer.deleted", { id: "cus_Gone", object: "customer", deleted: true }));
  await sync.syncEvent(s.event("product.deleted", { id: "prod_Gone", object: "product" }));
  await sync.syncEvent(s.event("price.deleted", { id: "price_Gone", object: "price" }));
  await sync.syncEvent(s.event("invoice.deleted", { id: "in_Draft", object: "invoice" }));
  assert.deepEqual(store.batches.flat().map((o) => `${o.op}:${o.object ?? ""}:${o.id}`),
    ["deleted:customer:cus_Gone", "deleted:product:prod_Gone", "deleted:price:price_Gone", "delete_invoice::in_Draft"]);
  assert.equal(s.calls.length, 0);
  // A product Stripe no longer returns, reached by an update event, is recorded deleted too.
  await sync.syncEvent(s.event("product.updated", { id: "prod_Vanished", object: "product" }));
  assert.equal(store.batches.at(-1)[0].op, "deleted");
});

test("sync: a Checkout session syncs what it produced; an unknown object type is not synced", async () => {
  const s = fakeStripe(); seedCustomer(s);
  s.put({ id: "cs_test_A", object: "checkout.session", status: "complete", payment_status: "paid", url: null, expires_at: T0 + 86400,
    subscription: "sub_A", invoice: "in_A1", payment_intent: null });
  const store = recordingStore();
  const sync = createStripeSync({ api: s.api, store });
  const results = await sync.syncEvent(s.event("checkout.session.completed", s.get("cs_test_A")));
  assert.deepEqual(store.batches[0].map((o) => o.op), ["checkout_session"]);
  assert.ok(store.batches.flat().some((o) => o.op === "invoice"));
  assert.ok(results.length > 1);
  assert.equal(await sync.syncEvent(s.event("coupon.created", { id: "co_1", object: "coupon" })), null);
});

test("sync: linking an existing customer imports its subscriptions, invoices and payments", async () => {
  const s = fakeStripe(); seedCustomer(s);
  const store = recordingStore();
  const sync = createStripeSync({ api: s.api, store });
  await sync.linkCustomer({ clientId: "client-1", customerId: "cus_A", linkSource: "linked_existing", linkedBy: "member-1" });
  const ops = store.batches.flat();
  assert.equal(ops[0].op, "link");
  assert.equal(ops[0].row.default_payment_method_last4, "6789");
  for (const op of ["customer", "subscription", "invoice", "payment", "refund"]) assert.ok(ops.some((o) => o.op === op), op);
  await assert.rejects(sync.linkCustomer({ clientId: "c", customerId: "cus_Nope", linkSource: "linked_existing", linkedBy: null }),
    (e) => e.missing === true);
  s.put({ id: "cus_Live", object: "customer", livemode: true, metadata: {} });
  await assert.rejects(sync.linkCustomer({ clientId: "c", customerId: "cus_Live", linkSource: "linked_existing", linkedBy: null }), /not in test mode/);
});

test("outcome: what the ledger records for a sync", () => {
  assert.deepEqual(outcome([{ op: "subscription", id: "sub", result: "written" }]), { status: "processed" });
  assert.deepEqual(outcome([{ op: "subscription", id: "sub", result: "stale" }]), { status: "processed" });
  assert.deepEqual(outcome([{ op: "customer", id: "c", result: "unlinked" }]), { status: "ignored", reason: "customer_not_linked" });
  assert.deepEqual(outcome([{ op: "subscription", id: "s", result: "mode_mismatch" }]), { status: "ignored", reason: "mode_mismatch" });
  assert.deepEqual(outcome([{ op: "product", id: "p", result: "written" }, { op: "subscription", id: "s", result: "unlinked" }]), { status: "processed" });
  assert.deepEqual(outcome([]), { status: "ignored", reason: "nothing_to_sync" });
});

test("the subscribed events are an explicit list, no wildcard, each routed to an object the mirror keeps", () => {
  assert.ok(!STRIPE_WEBHOOK_EVENTS.some((e) => e.includes("*")));
  assert.equal(new Set(STRIPE_WEBHOOK_EVENTS).size, STRIPE_WEBHOOK_EVENTS.length);
  const kinds = new Set(STRIPE_WEBHOOK_EVENTS.map((e) => e.replace(/\.[a-z_]+$/, "")));
  assert.deepEqual([...kinds].sort(), ["charge", "checkout.session", "customer", "customer.subscription", "invoice",
    "payment_intent", "price", "product", "refund"]);
});
