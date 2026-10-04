// stripe-webhook request boundary (B2) over a fake Stripe and an in-memory
// store that follows the ledger rules of 0059 (claim with a lease, finish or
// fail only by the claiming attempt). The real database: tests/stripe-webhook-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStripeWebhook } from "../supabase/functions/stripe-webhook/handler.ts";
import { fakeStripe, seedCustomer, signedRequest } from "./fixtures/stripe-fake.mjs";

const SECRET = "whsec_unit";

function memoryStore({ linked = ["cus_A"], live = false } = {}) {
  const linkedSet = new Set(linked);
  const events = new Map();
  const applied = [];
  const ctl = { failApply: 0, gate: null };
  const resultFor = (o) => {
    const cus = o.row?.stripe_customer_id;
    if (["subscription", "invoice", "payment", "customer"].includes(o.op)) return linkedSet.has(cus) ? "written" : "unlinked";
    if (o.op === "checkout_session") return "missing";
    if (o.op === "deleted" || o.op === "delete_invoice") return "deleted";
    return "written";
  };
  return {
    events, applied, ctl,
    async apply(ops) {
      if (ctl.gate) await ctl.gate;
      if (ctl.failApply > 0) { ctl.failApply -= 1; throw new Error("billing_sync_apply: database unavailable"); }
      applied.push(...ops);
      return ops.map((o) => ({ op: o.op, id: o.id ?? null, result: resultFor(o) }));
    },
    async linkCustomer(p) { linkedSet.add(p.row.stripe_customer_id); },
    async beginEvent(e) {
      if (!events.has(e.id)) events.set(e.id, { ...e, status: "received", attempts: 0 });
      const ev = events.get(e.id);
      if (["received", "failed"].includes(ev.status)) {
        ev.status = "processing"; ev.attempts += 1;
        return { claimed: true, attempt: ev.attempts };
      }
      return { claimed: false, state: ["processed", "ignored"].includes(ev.status) ? "done" : "in_progress", status: ev.status };
    },
    async finishEvent(id, attempt, status, reason) {
      const ev = events.get(id);
      if (ev.status !== "processing" || ev.attempts !== attempt) return { ok: false };
      Object.assign(ev, { status, ignored_reason: status === "ignored" ? reason : null, last_error: null });
      return { ok: true };
    },
    async failEvent(id, attempt, error) {
      const ev = events.get(id);
      if (ev.status !== "processing" || ev.attempts !== attempt) return { ok: false };
      Object.assign(ev, { status: "failed", last_error: error });
      return { ok: true };
    },
    async secret() { return null; },
    async billingLivemode() { return live; },
  };
}

function setup({ key = "sk_test_unit", store = memoryStore(), mode } = {}) {
  const s = fakeStripe({ mode: mode ?? (key.includes("_live_") ? "live" : "test") });
  seedCustomer(s);
  const webhook = createStripeWebhook({
    config: async () => ({ secretKey: key, webhookSecret: SECRET }),
    store,
    makeApi: () => s.api,
  });
  const send = async (event, opts) => {
    const res = await webhook.handle(await signedRequest(event, SECRET, opts));
    return { status: res.status, body: await res.json() };
  };
  return { s, store, webhook, send };
}

test("a bad signature is refused before anything is recorded or fetched", async () => {
  const { s, store, send } = setup();
  const r = await send(s.event("invoice.paid", s.get("in_A1")), { tamper: true });
  assert.equal(r.status, 400);
  assert.equal(store.events.size, 0);
  assert.equal(s.calls.length, 0);
  const old = await send(s.event("invoice.paid", s.get("in_A1")), { t: Math.floor(Date.now() / 1000) - 3600 });
  assert.deepEqual([old.status, old.body.reason], [400, "expired"]);
});

test("an event is claimed, synced from Stripe's current state, and marked processed", async () => {
  const { s, store, send } = setup();
  const snapshot = s.get("sub_A");
  s.patch("sub_A", { status: "past_due" });
  const ev = s.event("customer.subscription.updated", snapshot);
  const r = await send(ev);
  assert.deepEqual([r.status, r.body.status], [200, "processed"]);
  assert.equal(store.applied.find((o) => o.op === "subscription").row.status, "past_due", "the payload said active; Stripe says past_due");
  assert.equal(store.events.get(ev.id).status, "processed");
});

test("a duplicate delivery is acknowledged without re-running the sync", async () => {
  const { s, store, send } = setup();
  const ev = s.event("invoice.paid", s.get("in_A1"));
  await send(ev);
  const before = s.calls.length;
  const again = await send(ev);
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal(s.calls.length, before);
  assert.equal(store.events.get(ev.id).attempts, 1);
});

test("concurrent deliveries of one event: one works it, the other is told to retry later (409)", async () => {
  const store = memoryStore();
  let release;
  store.ctl.gate = new Promise((r) => { release = r; });
  const { s, send } = setup({ store });
  const ev = s.event("invoice.paid", s.get("in_A1"));
  const first = send(ev);
  await new Promise((r) => setTimeout(r, 20));
  const second = await send(ev);
  assert.deepEqual([second.status, second.body.error], [409, "in_progress"]);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await send(ev)).body.duplicate, true);
});

test("a failed write is recorded, answered 500, and Stripe's retry processes it", async () => {
  const store = memoryStore();
  store.ctl.failApply = 1;
  const { s, send } = setup({ store });
  const ev = s.event("invoice.payment_failed", s.get("in_A1"));
  const r = await send(ev);
  assert.equal(r.status, 500);
  assert.equal(store.events.get(ev.id).status, "failed");
  assert.match(store.events.get(ev.id).last_error, /database unavailable/);
  const retry = await send(ev);
  assert.deepEqual([retry.status, retry.body.status], [200, "processed"]);
  assert.equal(store.events.get(ev.id).attempts, 2);
});

test("a Stripe API failure is a failed event too (never marked processed)", async () => {
  const { s, store, send } = setup();
  s.fail("/v1/subscriptions/sub_A", 1, 503);
  const ev = s.event("customer.subscription.updated", s.get("sub_A"));
  assert.equal((await send(ev)).status, 500);
  assert.match(store.events.get(ev.id).last_error, /Stripe 503/);
  assert.equal((await send(ev)).status, 200);
});

test("out-of-order delivery converges on Stripe's present state", async () => {
  const { s, store, send } = setup();
  const older = s.event("customer.subscription.updated", { ...s.get("sub_A"), status: "active" });
  s.patch("sub_A", { status: "canceled", canceled_at: 1790100000, ended_at: 1790100000 });
  const newer = s.event("customer.subscription.deleted", s.get("sub_A"));
  await send(newer);
  await send(older); // delivered late
  const subs = store.applied.filter((o) => o.op === "subscription").map((o) => o.row.status);
  assert.deepEqual(subs, ["canceled", "canceled"]);
});

test("test / live isolation: a live event on the test endpoint is ignored; a live key waits for the admin switch", async () => {
  const { s, store, send } = setup();
  const live = s.event("invoice.paid", s.get("in_A1"), { livemode: true });
  const r = await send(live);
  assert.deepEqual([r.status, r.body.ignored], [200, "mode_mismatch"]);
  assert.equal(store.events.get(live.id).ignored_reason, "mode_mismatch");
  assert.equal(store.applied.length, 0);
  const liveKey = setup({ key: "sk_live_unit" });
  const blocked = await liveKey.send(liveKey.s.event("invoice.paid", liveKey.s.get("in_A1"), { livemode: true }));
  assert.deepEqual([blocked.status, blocked.body.error], [503, "live_mode_not_enabled"]);
  const enabled = setup({ key: "sk_live_unit", store: memoryStore({ live: true }) });
  assert.equal((await enabled.send(enabled.s.event("invoice.paid", enabled.s.get("in_A1"), { livemode: true }))).status, 200);
});

test("events for customers Compass has not linked are recorded as ignored", async () => {
  const { s, send } = setup({ store: memoryStore({ linked: [] }) });
  s.patch("sub_A", {});
  const ev = s.event("customer.subscription.updated", s.get("sub_A"));
  const r = await send(ev);
  assert.deepEqual([r.status, r.body.status, r.body.reason], [200, "processed", undefined], "catalog objects still mirror");
  const cust = s.event("customer.updated", s.get("cus_A"));
  const c = await send(cust);
  assert.deepEqual([c.body.status, c.body.reason], ["ignored", "customer_not_linked"]);
});

test("unsupported events are recorded as ignored; deleted objects are handled from the event", async () => {
  const { s, store, send } = setup();
  const ev = s.event("coupon.created", { id: "co_1", object: "coupon" });
  assert.deepEqual((await send(ev)).body.ignored, "unsupported_event");
  const gone = s.event("customer.deleted", { id: "cus_A", object: "customer", deleted: true });
  const r = await send(gone);
  assert.equal(r.status, 200);
  assert.deepEqual(store.applied.at(-1), { op: "deleted", object: "customer", id: "cus_A", at: new Date(gone.created * 1000).toISOString() });
});

test("refund events carry every partial refund of the payment", async () => {
  const { s, store, send } = setup();
  await send(s.event("charge.refunded", s.get("py_A1")));
  assert.deepEqual(store.applied.filter((o) => o.op === "refund").map((o) => o.row.amount_cents), [100000, 50000]);
});

test("not configured, wrong method, malformed body", async () => {
  const w = createStripeWebhook({ config: async () => null, store: memoryStore(), makeApi: () => { throw new Error("unused"); } });
  assert.equal((await w.handle(new Request("http://x", { method: "POST", body: "{}" }))).status, 503);
  const { webhook } = setup();
  assert.equal((await webhook.handle(new Request("http://x", { method: "GET" }))).status, 405);
  const { stripeSignature } = await import("../supabase/functions/_shared/stripe/signature.ts");
  const t = Math.floor(Date.now() / 1000);
  const bad = new Request("http://x", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${await stripeSignature(SECRET, t, "not json")}` }, body: "not json" });
  assert.equal((await webhook.handle(bad)).status, 400);
});
