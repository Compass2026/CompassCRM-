// End-to-end check of the Stripe sync (B2) against a real database: the full
// migration replay behind PostgREST, so every write arrives as session_user
// authenticator / role service_role — the only session 0058 lets write the
// Stripe mirror. The webhook handler, the shared sync layer and the store are
// the deployed ones; Stripe is the in-memory fake (tests/fixtures/stripe-fake.mjs).
//
//   npm run test:stripe-webhook   (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional clients, customers and ids only. Nothing leaves the machine.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createStripeWebhook } from "../supabase/functions/stripe-webhook/handler.ts";
import { createStripeStore } from "../supabase/functions/_shared/stripe/store.ts";
import { createStripeSync } from "../supabase/functions/_shared/stripe/sync.ts";
import { fakeStripe, seedCustomer, signedRequest, T0 } from "./fixtures/stripe-fake.mjs";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through npm run test:stripe-webhook");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const A = "00000000-0000-4000-b000-0000000000f1";
const B = "00000000-0000-4000-b000-0000000000f2";
const WHSEC = "whsec_integration";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const serviceKey = sign({ role: "service_role", exp: exp() });
const anonKey = sign({ role: "anon", exp: exp() });
const teamToken = sign({ sub: TEAM.id, role: "authenticated", aud: "authenticated", email: TEAM.email, exp: exp() });

const sql = (q) => {
  try { return execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { const err = new Error(`${String(e.stderr ?? e.message).trim()}\n  in: ${q}`); err.stderr = e.stderr; throw err; }
};
const sqlFails = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); } };
const one = (q) => sql(q);

// Supabase's gateway, reduced to /rest/v1.
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/rest/v1/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await up.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status, h);
    return res.end(out);
  }
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(gatewayUrl, serviceKey, opts);
const asTeam = createClient(gatewayUrl, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${teamToken}` } } });

const s = fakeStripe();
const store = createStripeStore(service);
const sync = createStripeSync({ api: s.api, store });
const webhook = createStripeWebhook({ config: async () => ({ secretKey: "sk_test_integration", webhookSecret: WHSEC }), store, makeApi: () => s.api });
const send = async (event) => { const r = await webhook.handle(await signedRequest(event, WHSEC)); return { status: r.status, body: await r.json() }; };
const status = (client) => JSON.parse(one(`select row_to_json(s) from client_billing_status s where client_id = '${client}'`));
const ledger = (id) => JSON.parse(one(`select row_to_json(e) from stripe_events e where id = '${id}'`));

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

try {
  sql(`insert into clients (id, name, city, state, status) values
       ('${A}', 'Integration Roofing', 'Wentzville', 'MO', 'active'),
       ('${B}', 'Integration Plumbing', 'Columbia', 'MO', 'active')`);
  const member = one(`select id from team_members where auth_user_id = '${TEAM.id}'`);
  seedCustomer(s, { prefix: "A" });
  seedCustomer(s, { prefix: "B", cus: "cus_B", sub: "sub_B", inv: "in_B1", pi: "pi_B1", py: "py_B1" });

  // ── Link an existing Stripe customer and import what Stripe holds ──
  await sync.linkCustomer({ clientId: A, customerId: "cus_A", linkSource: "linked_existing", linkedBy: member });
  await sync.linkCustomer({ clientId: B, customerId: "cus_B", linkSource: "created", linkedBy: null });
  assert.equal(one(`select link_source || ':' || linked_by || ':' || default_payment_method_last4 from stripe_customers where stripe_customer_id = 'cus_A'`),
    `linked_existing:${member}:6789`);
  assert.equal(one(`select status || ':' || (select sum(quantity) from subscription_items i where i.subscription_id = s.id) from subscriptions s where stripe_subscription_id = 'sub_A'`), "active:2");
  assert.equal(one(`select status || ':' || amount_remaining_cents from invoices where stripe_invoice_id = 'in_A1'`), "paid:0");
  assert.equal(one(`select count(*) from invoice_line_items l join invoices i on i.id = l.invoice_id where i.stripe_invoice_id = 'in_A1'`), "1");
  assert.equal(one(`select string_agg(amount_cents::text, ',' order by amount_cents) from stripe_refunds where client_id = '${A}'`), "50000,100000");
  let st = status(A);
  assert.deepEqual([st.billing_state, st.mrr_cents, st.billing_attention], ["active", 300000, true], "unmapped price flagged until a package maps it");
  ok("Linking an existing customer imports its subscription, invoice, lines, payment and both partial refunds onto the client");

  // ── Duplicate and concurrent delivery ──
  const paid = s.event("invoice.paid", s.get("in_A1"));
  assert.equal((await send(paid)).body.status, "processed");
  assert.equal((await send(paid)).body.duplicate, true);
  assert.equal(ledger(paid.id).attempts, 1);
  const race = s.event("customer.subscription.updated", s.get("sub_A"));
  const both = (await Promise.all([send(race), send(race)])).map((r) => r.status).sort();
  assert.ok(both[0] === 200 && [200, 409].includes(both[1]), JSON.stringify(both));
  assert.equal(ledger(race.id).status, "processed");
  assert.equal(ledger(race.id).attempts, 1, "one delivery worked it");
  ok(`Duplicate delivery is acknowledged without a second run; concurrent delivery works once (${both.join(" / ")})`);

  // ── Payment failure: Stripe marks it past due, Compass mirrors it ──
  s.put({ ...s.get("in_A1"), id: "in_A2", number: "A-0002", status: "open", amount_paid: 0, amount_remaining: 300000, attempt_count: 1,
    next_payment_attempt: T0 + 40 * 86400, created: T0 + 30 * 86400, status_transitions: { finalized_at: T0 + 30 * 86400 },
    payments: { object: "list", data: [] }, hosted_invoice_url: "https://invoice.stripe.com/i/in_A2",
    lines_data: [{ ...s.get("in_A1").lines_data[0], id: "il_A2" }] });
  s.patch("sub_A", { status: "past_due", latest_invoice: "in_A2" });
  const pf = await send(s.event("invoice.payment_failed", s.get("in_A2")));
  assert.equal(pf.body.status, "processed", JSON.stringify(pf));
  st = status(A);
  assert.equal(st.billing_state, "past_due");
  assert.ok(st.attention_reasons.includes("subscription_past_due") && st.attention_reasons.includes("invoice_overdue"), st.attention_reasons);
  assert.deepEqual(st.outstanding_cents_by_currency, { usd: 300000 });
  ok("invoice.payment_failed: the subscription reads past due with an overdue invoice and $3,000 outstanding (Stripe's state, not Compass's)");

  // ── A failed write, then Stripe's retry ──
  s.put({ id: "pi_A2", object: "payment_intent", livemode: false, customer: "cus_A", status: "succeeded", amount: 300000, currency: "usd",
    latest_charge: "py_A2", payment_method_types: ["card"], created: T0 + 41 * 86400 });
  s.put({ id: "py_A2", object: "charge", livemode: false, payment_intent: "pi_A2", amount: 300000, amount_refunded: 0, created: T0 + 41 * 86400,
    payment_method_details: { type: "card" } });
  s.patch("in_A2", { status: "paid", amount_paid: 300000, amount_remaining: 0, attempt_count: 2,
    status_transitions: { finalized_at: T0 + 30 * 86400, paid_at: T0 + 41 * 86400 }, payments: { object: "list", data: [{ payment: { payment_intent: "pi_A2" } }] } });
  s.patch("sub_A", { status: "active" });
  const paid2 = s.event("invoice.paid", s.get("in_A2"));
  s.fail("/v1/invoices/in_A2/lines", 1, 500);
  const first = await send(paid2);
  assert.equal(first.status, 500);
  const failed = ledger(paid2.id);
  assert.deepEqual([failed.status, failed.attempts], ["failed", 1]);
  assert.match(failed.last_error, /Stripe 500/);
  assert.equal(one(`select status from invoices where stripe_invoice_id = 'in_A2'`), "open", "nothing half-written for the invoice");
  const retry = await send(paid2);
  assert.equal(retry.status, 200);
  assert.deepEqual([ledger(paid2.id).status, ledger(paid2.id).attempts, ledger(paid2.id).last_error], ["processed", 2, null]);
  assert.equal(one(`select status from invoices where stripe_invoice_id = 'in_A2'`), "paid");
  assert.equal(status(A).billing_state, "active");
  ok("A failed sync is recorded (failed, with the error, not processed) and answered 500; Stripe's retry processes it");

  // ── Out-of-order delivery ──
  const stale = s.event("customer.subscription.updated", { ...s.get("sub_A"), status: "past_due" });
  s.patch("sub_A", { cancel_at_period_end: true, cancellation_details: { reason: "cancellation_requested", feedback: "switched_service", comment: null } });
  await send(s.event("customer.subscription.updated", s.get("sub_A")));
  await send(stale); // the older event arrives last
  assert.equal(one(`select status || ':' || cancel_at_period_end from subscriptions where stripe_subscription_id = 'sub_A'`), "active:true");
  assert.equal(status(A).billing_state, "canceling");
  ok("Out-of-order events converge on Stripe's present state (an older past_due payload never wins)");

  // ── Cancellation ──
  s.patch("sub_A", { status: "canceled", canceled_at: T0 + 60 * 86400, ended_at: T0 + 60 * 86400 });
  await send(s.event("customer.subscription.deleted", s.get("sub_A")));
  st = status(A);
  assert.deepEqual([st.subscription_status, st.billing_state, st.next_billing_at, st.mrr_cents], ["canceled", "canceled", null, null]);
  ok("customer.subscription.deleted: canceled, no next billing date, no MRR");

  // ── Multiple partial refunds ──
  s.put({ id: "pyr_A3", object: "refund", payment_intent: "pi_A1", charge: "py_A1", amount: 25000, currency: "usd", status: "pending", reason: null, failure_reason: null, created: T0 + 70 * 86400 });
  s.patch("py_A1", { amount_refunded: 175000 });
  await send(s.event("charge.refunded", s.get("py_A1")));
  assert.equal(one(`select count(*) || ':' || sum(amount_cents) from stripe_refunds where client_id = '${A}'`), "3:175000");
  assert.equal(one(`select amount_refunded_cents from payments where stripe_payment_intent_id = 'pi_A1'`), "175000");
  s.patch("pyr_A3", { status: "failed", failure_reason: "insufficient_funds" });
  await send(s.event("refund.failed", s.get("pyr_A3")));
  assert.equal(one(`select status || ':' || failure_reason from stripe_refunds where stripe_refund_id = 'pyr_A3'`), "failed:insufficient_funds");
  ok("Refunds: three partial refunds kept individually (the payment's aggregate is Stripe's); a refund failing is mirrored with its reason");

  // ── Customer, product and price updates ──
  s.patch("cus_A", { email: "accounts@integration-roofing.test" });
  await send(s.event("customer.updated", s.get("cus_A")));
  assert.equal(one(`select email from stripe_customers where stripe_customer_id = 'cus_A'`), "accounts@integration-roofing.test");
  s.patch("prod_Std", { name: "Compass Marketing Package (2027)" });
  s.patch("price_StdM", { nickname: "Standard monthly", active: false });
  await send(s.event("product.updated", s.get("prod_Std")));
  await send(s.event("price.updated", s.get("price_StdM")));
  assert.equal(one(`select p.name || ':' || pr.nickname || ':' || pr.active from stripe_products p join stripe_prices pr using (stripe_product_id) where pr.stripe_price_id = 'price_StdM'`),
    "Compass Marketing Package (2027):Standard monthly:false");
  ok("customer.updated / product.updated / price.updated mirror Stripe's current values");

  // ── Test / live isolation ──
  const live = s.event("invoice.paid", s.get("in_B1"), { livemode: true });
  const lr = await send(live);
  assert.deepEqual([lr.status, ledger(live.id).status, ledger(live.id).ignored_reason], [200, "ignored", "mode_mismatch"]);
  const mm = await store.apply([{ op: "subscription", row: { stripe_subscription_id: "sub_Live", stripe_customer_id: "cus_A", livemode: true,
    status: "active", collection_method: "charge_automatically", currency: "usd", stripe_synced_at: new Date().toISOString() }, items: [] }]);
  assert.equal(mm[0].result, "mode_mismatch");
  assert.equal(one(`select count(*) from subscriptions where livemode`), "0");
  ok("Test / live isolation: a live event on the test endpoint is ignored; a live object on a test customer is refused");

  // ── Cross-client isolation ──
  const beforeA = one(`select count(*) from invoices where client_id = '${A}'`);
  s.patch("sub_B", { status: "past_due" });
  await send(s.event("customer.subscription.updated", s.get("sub_B")));
  const aimed = await store.apply([{ op: "subscription", row: { ...{ stripe_subscription_id: "sub_B", stripe_customer_id: "cus_B", livemode: false,
    status: "past_due", collection_method: "charge_automatically", currency: "usd", stripe_synced_at: new Date().toISOString() }, client_id: A }, items: [] }]);
  assert.equal(aimed[0].result, "written");
  assert.equal(one(`select client_id from subscriptions where stripe_subscription_id = 'sub_B'`), B);
  assert.equal(one(`select count(*) from invoices where client_id = '${A}'`), beforeA);
  assert.equal(status(B).billing_state, "past_due");
  ok("Cross-client isolation: B's events land on B only; a row naming A for B's customer still lands on B");

  // ── Nobody else writes the mirror ──
  const teamWrite = await asTeam.from("subscriptions").update({ status: "active" }).eq("stripe_subscription_id", "sub_B").select();
  assert.ok(teamWrite.error || (teamWrite.data ?? []).length === 0, JSON.stringify(teamWrite));
  const serviceDirect = await service.from("stripe_refunds").delete().eq("stripe_refund_id", "pyr_A1").select();
  assert.ok(serviceDirect.error, "service role direct delete refused");
  const teamRpc = await asTeam.rpc("billing_sync_apply", { p: { ops: [] } });
  assert.ok(teamRpc.error, "a teammate cannot call the sync function");
  assert.ok(sqlFails(`update subscriptions set status = 'active' where stripe_subscription_id = 'sub_B'`)?.includes("written only by the Stripe sync functions"));
  assert.ok(sqlFails(`select billing_sync_apply('{"ops": []}')`)?.includes("Stripe sync functions only"));
  assert.equal(one(`select status from subscriptions where stripe_subscription_id = 'sub_B'`), "past_due");
  assert.equal(one(`select count(*) from stripe_refunds where client_id = '${A}'`), "3");
  ok("Unauthorized writes refused: a teammate (API and RPC), the service role directly, and the worker's SQL");

  // ── Canonical resync (a missed webhook) ──
  s.patch("sub_B", { status: "active", items: { object: "list", data: [{ ...s.get("sub_B").items.data[0], quantity: 3 }] } });
  await sync.resyncCustomer("cus_B");
  assert.equal(one(`select s.status || ':' || i.quantity from subscriptions s join subscription_items i on i.subscription_id = s.id where s.stripe_subscription_id = 'sub_B'`), "active:3");
  assert.equal(status(B).mrr_cents, 450000);
  ok("Canonical resync brings a customer current after a missed webhook (quantity 3 → $4,500 MRR)");

  // ── The ledger ──
  const counts = JSON.parse(one(`select json_object_agg(status, n) from (select status, count(*) n from stripe_events group by status) x`));
  assert.ok(counts.processed >= 10 && counts.ignored >= 1 && !counts.failed && !counts.processing, JSON.stringify(counts));
  ok(`Ledger: ${JSON.stringify(counts)}; nothing left failed or in processing`);

  console.log(`Stripe sync integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
