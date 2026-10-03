// End-to-end check of stripe-reconcile (B4) against a real database: the
// full migration replay behind PostgREST, so the stores reach Postgres as
// authenticator / service_role and every teammate / portal read goes through
// RLS. The reconcile handler and engine, stripe-billing, the webhook, the
// shared sync layer and the stores are the deployed ones; Stripe is the
// in-memory fake (tests/fixtures/stripe-fake.mjs). Webhooks are "missed" by
// changing the fake without delivering anything.
//
//   npm run test:stripe-reconcile   (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional clients, customers and ids only. Nothing leaves the machine.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createStripeReconcile } from "../supabase/functions/stripe-reconcile/handler.ts";
import { createReconcileStore } from "../supabase/functions/stripe-reconcile/store.ts";
import { createStripeBilling } from "../supabase/functions/stripe-billing/handler.ts";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";
import { createStripeWebhook } from "../supabase/functions/stripe-webhook/handler.ts";
import { createStripeStore } from "../supabase/functions/_shared/stripe/store.ts";
import { StripeApiError } from "../supabase/functions/_shared/stripe/api.ts";
import { fakeStripe, seedCustomer, signedRequest } from "./fixtures/stripe-fake.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through npm run test:stripe-reconcile");

const ADMIN = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const MEMBER = { id: "00000000-0000-4000-a000-000000000021", email: "sandbox-member@compassmarketing.ai" };
const PORTAL_A = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([ADMIN, MEMBER, PORTAL_A].map((u) => [u.id, u]));
const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const C = "00000000-0000-4000-b000-00000000000c";
const D = "00000000-0000-4000-b000-00000000000d";
const GROWTH = "00000000-0000-4000-c000-0000000000f1";
const STARTER = "00000000-0000-4000-c000-0000000000f2";
const WHSEC = "whsec_reconcile";
const RSECRET = "reconcile-secret-sandbox";
const rid = (n) => `00000000-0000-4000-f000-${String(n).padStart(12, "0")}`;

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const verify = (token) => {
  const [h, p, s] = (token ?? "").split(".");
  if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
};
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const serviceKey = sign({ role: "service_role", exp: exp() });
const anonKey = sign({ role: "anon", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const run = (psql, q) => {
  try { return execFileSync("/bin/sh", ["-c", `${psql} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { throw new Error(`${String(e.stderr ?? e.message).trim()}\n  in: ${q}`); }
};
const sql = (q) => run(PSQL, q);
const sqlAdmin = (q) => run(PSQL_ADMIN, q);
const json = (q) => JSON.parse(sql(q) || "null");

const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
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
const as = (u) => createClient(gatewayUrl, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${tokenFor(u)}` } } });

const s = fakeStripe();
const billing = createStripeBilling({ config: async () => ({ secretKey: "sk_test_rec", appUrl: "https://crm.example.test" }), store: createBillingStore(service), makeApi: () => s.api });
const baseStore = createStripeStore(service);
const webhookStore = { ...baseStore };
const webhook = createStripeWebhook({ config: async () => ({ secretKey: "sk_test_rec", webhookSecret: WHSEC }), store: webhookStore, makeApi: () => s.api });
const reconcileStore = createReconcileStore(service);
const jobs = [];
const reconcileFor = (stripe, key = "sk_test_rec") => createStripeReconcile({
  config: async () => ({ secretKey: key }), store: { ...reconcileStore, secret: async (n) => n === "BILLING_RECONCILE_SECRET" ? RSECRET : reconcileStore.secret(n) },
  makeApi: () => stripe.api, waitUntil: (p) => jobs.push(p),
});
const reconcile = reconcileFor(s);
const post = async (h, headers, body = {}) => {
  const r = await h.handle(new Request("http://x/fn", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const callBilling = (u, body) => post(billing, { authorization: `Bearer ${tokenFor(u)}` }, body);
const deliver = async (type, obj) => {
  const r = await webhook.handle(await signedRequest(s.event(type, obj), WHSEC));
  return { status: r.status, body: await r.json() };
};
// A scheduled run, to completion.
async function scheduled(h = reconcile) {
  const r = await post(h, { "x-billing-reconcile-secret": RSECRET });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await Promise.all(jobs.splice(0));
  return json(`select row_to_json(x) from billing_reconciliation_runs x where id = '${r.body.run_id}'`);
}
const result = (runId, client) => json(`select row_to_json(x) from billing_reconciliation_results x where run_id = '${runId}' and client_id = '${client}'`);
const status = (client) => json(`select row_to_json(x) from client_billing_status x where client_id = '${client}'`);
const stripeWrites = () => s.calls.filter((c) => c.startsWith("POST")).length;

// A paid invoice (and its payment) Stripe created for a subscription while no webhook arrived.
function addPaidInvoice({ cus, sub, price, n, amount = 150000 }) {
  const t = Math.floor(Date.now() / 1000);
  s.put({ id: `ch_${n}`, object: "charge", livemode: false, payment_intent: `pi_${n}`, amount, amount_refunded: 0, created: t, payment_method_details: { type: "card" } });
  s.put({ id: `pi_${n}`, object: "payment_intent", livemode: false, customer: cus, status: "succeeded", amount, currency: "usd",
    latest_charge: `ch_${n}`, payment_method_types: ["card"], last_payment_error: null, created: t });
  s.put({ id: `in_${n}`, object: "invoice", livemode: false, customer: cus, number: `R-${n}`, status: "paid", billing_reason: "subscription_cycle",
    collection_method: "charge_automatically", currency: "usd", subtotal: amount, total: amount, amount_due: amount, amount_paid: amount,
    amount_remaining: 0, attempt_count: 1, attempted: true, next_payment_attempt: null, due_date: null, period_start: t, period_end: t + 30 * 86400,
    hosted_invoice_url: `https://invoice.stripe.com/i/in_${n}`, invoice_pdf: null, paid_out_of_band: false, created: t,
    status_transitions: { finalized_at: t, paid_at: t }, parent: { type: "subscription_details", subscription_details: { subscription: sub } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: `pi_${n}` } }] },
    lines_data: [{ id: `il_${n}`, object: "line_item", amount, currency: "usd", quantity: 1, description: "Growth", period: { start: t, end: t + 30 * 86400 },
      pricing: { price_details: { price, product: "prod_Growth" } }, parent: { type: "subscription_item_details", subscription_item_details: { subscription_item: `si_${n}`, proration: false } } }] });
}

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

try {
  // ── Setup: teammates, clients, catalog, agreements ─────────────────────────
  sqlAdmin(`insert into auth.users (id, email, email_confirmed_at) values ('${MEMBER.id}', '${MEMBER.email}', now())`);
  sqlAdmin(`insert into team_members (auth_user_id, name, email, role) values ('${MEMBER.id}', 'Morgan Member', '${MEMBER.email}', 'member')`);
  sqlAdmin(`update team_members set role = 'admin' where auth_user_id = '${ADMIN.id}'`);
  const adminId = sql(`select id from team_members where auth_user_id = '${ADMIN.id}'`);
  sql(`insert into clients (id, name, city, state, status) values ('${C}', 'Cedar Landscaping', 'Joplin', 'MO', 'active'), ('${D}', 'Dune Pools', 'Branson', 'MO', 'active')`);
  s.put({ id: "prod_Growth", object: "product", livemode: false, name: "Compass Growth", active: true, metadata: {}, created: 1 });
  s.put({ id: "price_GrowthM", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
    unit_amount: 150000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
  seedCustomer(s, { cus: "cus_ExistB", sub: "sub_ExistB", inv: "in_ExistB", pi: "pi_ExistB", py: "py_ExistB", prefix: "EB" }); // also prod_Std / price_StdM
  const { error: pkgErr } = await as(ADMIN).from("billing_packages").insert([
    { id: GROWTH, key: "growth", name: "Growth", kind: "standard" }, { id: STARTER, key: "starter", name: "Starter", kind: "standard" }]);
  assert.equal(pkgErr, null, pkgErr?.message);
  assert.equal((await callBilling(ADMIN, { action: "import_product", target: "package", target_id: GROWTH, product_id: "prod_Growth" })).status, 200);
  assert.equal((await callBilling(ADMIN, { action: "import_product", target: "package", target_id: STARTER, product_id: "prod_Std" })).status, 200);
  const { data: pp } = await as(ADMIN).from("billing_package_prices").insert([
    { package_id: GROWTH, package_kind: "standard", stripe_product_id: "prod_Growth", stripe_price_id: "price_GrowthM", is_default: true },
    { package_id: STARTER, package_kind: "standard", stripe_product_id: "prod_Std", stripe_price_id: "price_StdM", is_default: true }]).select("id, package_id");
  const PP = pp.find((x) => x.package_id === GROWTH).id;
  for (const client of [A, B, C, D]) {
    const { error } = await as(MEMBER).from("plans").upsert({ client_id: client, package_id: GROWTH, collection: "stripe" }, { onConflict: "client_id" });
    assert.equal(error, null, error?.message);
    // The agreed price and its exact Stripe Price (an admin's).
    const { error: priced } = await as(ADMIN).from("plans").update({ agreed_amount_cents: 150000, agreed_currency: "usd",
      agreed_billing_interval: "month", agreed_billing_interval_count: 1, billing_package_price_id: PP }).eq("client_id", client);
    assert.equal(priced, null, priced?.message);
  }
  // A: created customer, paid through Checkout, every webhook delivered.
  assert.equal((await callBilling(ADMIN, { action: "create_customer", client_id: A, email: "a@example.test" })).status, 200);
  const coA = await callBilling(ADMIN, { action: "create_checkout", client_id: A, request_id: rid(1) });
  assert.equal(coA.status, 200, JSON.stringify(coA.body));
  const done = s.complete(coA.body.checkout.session_id);
  assert.equal((await deliver("checkout.session.completed", s.get(coA.body.checkout.session_id))).status, 200);
  const subA = done.subscription;
  // B: an existing customer (Starter price, two partial refunds) linked.
  assert.equal((await callBilling(ADMIN, { action: "link_customer", client_id: B, customer_id: "cus_ExistB", confirm: true })).status, 200);
  // C: a customer with an open payment link; D: a customer with nothing yet.
  assert.equal((await callBilling(ADMIN, { action: "create_customer", client_id: C, email: "c@example.test" })).status, 200);
  const coC = await callBilling(ADMIN, { action: "create_checkout", client_id: C, request_id: rid(2) });
  assert.equal(coC.status, 200);
  assert.equal((await callBilling(ADMIN, { action: "create_customer", client_id: D, email: "d@example.test" })).status, 200);
  // C: an external payment (Compass-owned).
  const ext = await callBilling(ADMIN, { action: "record_external_payment", client_id: C, amount_cents: 50000, currency: "usd", method: "check",
    paid_at: "2026-09-20", notes: "Setup fee by check", request_id: rid(3) });
  assert.equal(ext.status, 200);
  const extBefore = sql(`select row_to_json(p)::text from payments p where id = '${ext.body.payment_id}'`);
  // A live-mode link and subscription for A that test-mode reconciliation must never touch.
  sqlAdmin(`insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values ('${A}', 'cus_LiveA', true, 'created', '2026-09-01')`);
  sqlAdmin(`insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status, collection_method, currency, stripe_created_at, stripe_synced_at)
    values ('${A}', 'cus_LiveA', 'sub_LiveA', true, 'active', 'charge_automatically', 'usd', '2026-09-01', '2026-09-01')`);
  const liveBefore = sql(`select string_agg(row_to_json(x)::text, '|') from (select * from subscriptions where livemode union all select * from subscriptions where false) x`);
  const liveCusBefore = sql(`select row_to_json(c)::text from stripe_customers c where stripe_customer_id = 'cus_LiveA'`);
  const entsBefore = sql(`select string_agg(client_id || service_key || enabled || coalesce(quantity, -1), ',' order by client_id, service_key) from client_entitlements`);

  // ── 17. Unauthorized invocations ─────────────────────────────────────────
  assert.equal((await post(reconcile, {})).status, 401);
  assert.equal((await post(reconcile, { "x-billing-reconcile-secret": "guess" })).status, 401);
  assert.equal((await post(reconcile, { authorization: `Bearer ${tokenFor(MEMBER)}` })).status, 403);
  assert.equal((await post(reconcile, { authorization: `Bearer ${tokenFor(PORTAL_A)}` })).status, 403);
  assert.equal(sql(`select count(*) from billing_reconciliation_runs`), "0");
  const { error: memberRun } = await as(MEMBER).rpc("billing_reconcile_begin", { p: { livemode: false, trigger: "admin" } });
  assert.ok(memberRun, "no direct path to the run functions");
  ok("unauthorized: no auth, a wrong secret, a member and a portal contact are refused, and nothing reaches the run functions");

  // ── Baseline, then 1 + 19: a healthy mirror, and a second run changes nothing
  const r0 = await scheduled();
  assert.ok(["completed", "completed_with_errors"].includes(r0.status), JSON.stringify(r0));
  assert.equal(r0.failures, 0, JSON.stringify(r0.summary.failures));
  const writesBefore = stripeWrites();
  const r1 = await scheduled();
  assert.equal(r1.status, "completed");
  assert.equal(r1.records_changed, 0, JSON.stringify(r1.summary.changed));
  assert.equal(r1.customers_examined, 4);
  assert.equal(result(r1.id, A).status, "healthy", JSON.stringify(result(r1.id, A)));
  assert.equal(result(r1.id, D).status, "healthy");
  assert.equal(stripeWrites(), writesBefore, "reconciliation never writes to Stripe");
  ok("healthy: an up-to-date mirror is reconciled with no changes, and an immediate second run changes nothing (and writes nothing to Stripe)");

  // ── Missed webhooks: 2–8 ────────────────────────────────────────────────
  s.patch(subA, { status: "past_due" });                                          // 2 subscription
  addPaidInvoice({ cus: s.get(subA).customer, sub: subA, price: "price_GrowthM", n: "Acycle2" }); // 3 invoice + 4 payment
  s.put({ id: "pyr_EB3", object: "refund", payment_intent: "pi_ExistB", charge: "py_ExistB", amount: 25000, currency: "usd", status: "succeeded",
    reason: "duplicate", failure_reason: null, created: Math.floor(Date.now() / 1000) });  // 5 refund
  s.patch("py_ExistB", { amount_refunded: 175000 });
  const csC = coC.body.checkout.session_id;
  s.patch(csC, { status: "expired", url: null });                                // 6 checkout
  s.patch("prod_Growth", { name: "Compass Growth 2026" });                       // 7 product
  s.patch("price_GrowthM", { active: false });                                   // 8 price archived
  s.put({ id: "sub_ExistB2", object: "subscription", livemode: false, customer: "cus_ExistB", status: "active",   // 12 second subscription
    collection_method: "charge_automatically", currency: "usd", cancel_at_period_end: false, pause_collection: null,
    cancellation_details: {}, start_date: 1, billing_cycle_anchor: 1, latest_invoice: null, default_payment_method: null, metadata: {}, created: 2,
    items: { object: "list", data: [{ id: "si_EB2", object: "subscription_item", price: "price_StdM", quantity: 1, current_period_start: 1, current_period_end: 2, created: 2 }] } });
  // 9: a webhook whose processing failed (the database was down), left failed in the ledger.
  s.put({ id: "price_GrowthY", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
    unit_amount: 1500000, billing_scheme: "per_unit", recurring: { interval: "year", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 3 });
  webhookStore.apply = async () => { throw new Error("billing_sync_apply: database unavailable"); };
  const failed = await deliver("price.created", s.get("price_GrowthY"));
  webhookStore.apply = baseStore.apply;
  assert.equal(failed.status, 500);
  const failedEvent = sql(`select id from stripe_events where status = 'failed' and object_id = 'price_GrowthY'`);
  assert.ok(failedEvent);
  // 10: an event whose processing stopped mid-way (lease expired).
  sqlAdmin(`insert into stripe_events (id, type, livemode, event_created_at, object_type, object_id, status, attempts, last_attempt_at, lease_expires_at)
    values ('evt_StaleSubA', 'customer.subscription.updated', false, now() - interval '1 hour', 'subscription', '${subA}', 'processing', 1,
            now() - interval '30 minutes', now() - interval '25 minutes')`);
  // 11: a draft invoice Stripe deleted, and D's customer deleted in Stripe.
  s.put({ id: "in_DraftA", object: "invoice", livemode: false, customer: s.get(subA).customer, number: null, status: "draft", billing_reason: "manual",
    collection_method: "send_invoice", currency: "usd", subtotal: 1000, total: 1000, amount_due: 1000, amount_paid: 0, amount_remaining: 1000,
    attempt_count: 0, attempted: false, created: 4, status_transitions: {}, lines_data: [] });
  const r2pre = await scheduled(); // mirrors the draft (and everything above)
  s.remove("in_DraftA");
  s.patch(sql(`select stripe_customer_id from stripe_customers where client_id = '${D}' and livemode = false`), { deleted: true });
  const r2 = await scheduled();

  // Assertions for 2–8 against r2pre (the run that saw them).
  const sa = result(r2pre.id, A);
  assert.equal(sql(`select status from subscriptions where stripe_subscription_id = '${subA}'`), "past_due");
  assert.ok(sa.changes.subscription_updated >= 1 && sa.changes.invoice_imported >= 1 && sa.changes.payment_imported >= 1, JSON.stringify(sa));
  assert.equal(sql(`select count(*) from invoices where stripe_invoice_id = 'in_Acycle2' and client_id = '${A}' and amount_paid_cents = 150000`), "1");
  assert.equal(sql(`select count(*) from payments where stripe_payment_intent_id = 'pi_Acycle2' and client_id = '${A}' and status = 'succeeded'`), "1");
  assert.ok(status(A).attention_reasons.includes("subscription_past_due"), JSON.stringify(status(A)));
  ok("missed subscription, invoice and payment webhooks: A's past-due subscription, new invoice and payment are repaired and counted; A shows past due");

  const sb = result(r2pre.id, B);
  assert.equal(sql(`select string_agg(stripe_refund_id, ',' order by stripe_refund_id) from stripe_refunds where client_id = '${B}'`), "pyr_EB1,pyr_EB2,pyr_EB3");
  assert.equal(sql(`select amount_refunded_cents from payments where stripe_payment_intent_id = 'pi_ExistB'`), "175000");
  assert.ok(sb.changes.refund_imported === 1 && sb.changes.payment_updated === 1, JSON.stringify(sb));
  ok("missed refund: B's third partial refund is imported as its own row and the payment's refunded total follows Stripe");

  assert.equal(sql(`select status || '|' || coalesce(url, 'null') from checkout_sessions where stripe_checkout_session_id = '${csC}'`), "expired|null");
  assert.equal(result(r2pre.id, C).changes.checkout_updated, 1);
  ok("expired Checkout: C's link, open in Compass, is expired from Stripe's answer (not the local clock)");

  assert.equal(sql(`select name from stripe_products where stripe_product_id = 'prod_Growth'`), "Compass Growth 2026");
  assert.equal(sql(`select active from stripe_prices where stripe_price_id = 'price_GrowthM'`), "f");
  assert.equal(sql(`select active::text from billing_package_prices where stripe_price_id = 'price_GrowthM'`), "true", "the mapping is kept");
  assert.ok(r2pre.summary.changed.catalog_product_updated >= 1 && r2pre.summary.changed.catalog_price_updated >= 1, JSON.stringify(r2pre.summary.changed));
  assert.ok(r2pre.summary.warnings.some((w) => w.code === "catalog_price_archived" && w.detail.includes("price_GrowthM")), JSON.stringify(r2pre.summary.warnings));
  ok("catalog: the renamed product and the archived price are mirrored; the mapping stays and the archive is a warning for an admin");

  assert.equal(sql(`select status from stripe_events where id = '${failedEvent}'`), "processed");
  assert.equal(sql(`select active from stripe_prices where stripe_price_id = 'price_GrowthY'`), "t");
  assert.equal(sql(`select status from stripe_events where id = 'evt_StaleSubA'`), "processed");
  assert.ok(r2pre.events_recovered >= 2, JSON.stringify(r2pre.summary.events));
  ok("webhook ledger: a failed event and a stale processing event are re-synced from Stripe's current state and marked processed");

  assert.equal(sql(`select count(*) from subscriptions where client_id = '${B}' and livemode = false and status = 'active'`), "2");
  assert.ok(status(B).attention_reasons.includes("multiple_live_subscriptions"), JSON.stringify(status(B)));
  assert.equal(result(r2pre.id, B).status, "attention");
  ok("multiple subscriptions: B's second active subscription is mirrored, neither is removed, and B needs attention");

  assert.ok(status(B).attention_reasons.includes("package_mismatch"), JSON.stringify(status(B)));
  assert.equal(sql(`select package_id from plans where client_id = '${B}'`), GROWTH, "the agreement is untouched");
  assert.equal(s.get("sub_ExistB").items.data[0].price, "price_StdM", "Stripe is untouched");
  ok("package mismatch: B's agreement (Growth) and Stripe subscription (Starter) are both kept and flagged");

  // 11: deleted objects.
  assert.equal(sql(`select count(*) from invoices where stripe_invoice_id = 'in_DraftA'`), "0");
  assert.equal(result(r2.id, A).changes.invoice_removed, 1, JSON.stringify(result(r2.id, A)));
  assert.equal(sql(`select (deleted_at is not null)::text from stripe_customers where client_id = '${D}' and livemode = false`), "true");
  assert.equal(result(r2.id, D).status, "attention");
  assert.deepEqual(result(r2.id, D).warnings, ["customer_deleted_in_stripe"]);
  ok("deleted in Stripe: a removed draft invoice leaves the mirror; D's deleted customer is marked deleted and flagged, not failed");

  // 14 + entitlements + 15.
  assert.equal(sql(`select row_to_json(p)::text from payments p where id = '${ext.body.payment_id}'`), extBefore);
  assert.equal(sql(`select string_agg(client_id || service_key || enabled || coalesce(quantity, -1), ',' order by client_id, service_key) from client_entitlements`), entsBefore);
  ok("external payment and entitlements: untouched by every run");
  assert.equal(sql(`select string_agg(row_to_json(x)::text, '|') from (select * from subscriptions where livemode union all select * from subscriptions where false) x`), liveBefore);
  assert.equal(sql(`select row_to_json(c)::text from stripe_customers c where stripe_customer_id = 'cus_LiveA'`), liveCusBefore);
  assert.equal(sql(`select count(*) from billing_reconciliation_results where livemode or stripe_customer_id = 'cus_LiveA'`), "0");
  const live = reconcileFor(fakeStripe({ mode: "live" }), "sk_live_rec");
  assert.equal((await post(live, { "x-billing-reconcile-secret": RSECRET })).body.error, "live_mode_not_enabled");
  ok("test / live: a test run never reads or writes A's live customer or subscription, and a live key is refused while billing is in test mode");

  // 16: cross-client.
  const cross = sql(`select count(*) from billing_reconciliation_results r join stripe_customers c on c.stripe_customer_id = r.stripe_customer_id where c.client_id <> r.client_id`);
  assert.equal(cross, "0");
  assert.equal(sql(`select count(*) from stripe_refunds where stripe_refund_id = 'pyr_EB3' and client_id <> '${B}'`), "0");
  const { data: portalRuns } = await as(PORTAL_A).from("billing_reconciliation_results").select("client_id");
  assert.deepEqual(portalRuns, []);
  ok("cross-client: every result pairs a client with its own customer; B's refund stays B's; a portal contact reads no results");

  // 19 again: after the repairs, nothing more to do.
  const r3 = await scheduled();
  assert.equal(r3.records_changed, 0, JSON.stringify(r3.summary.changed));
  assert.equal(r3.events_recovered, 0);
  ok("idempotent: the run after the repairs changes nothing");

  // 24: run history and counts.
  assert.equal(r2pre.trigger, "schedule");
  const sumClients = Number(sql(`select sum(records_changed) from billing_reconciliation_results where run_id = '${r2pre.id}'`));
  const catalog = ["catalog_product_updated", "catalog_price_updated", "catalog_price_imported", "catalog_product_imported"]
    .reduce((n, k) => n + (r2pre.summary.changed[k] ?? 0), 0);
  assert.equal(r2pre.records_changed, sumClients + catalog);
  assert.equal(r2pre.customers_repaired, Number(sql(`select count(*) from billing_reconciliation_results where run_id = '${r2pre.id}' and records_changed > 0`)));
  assert.ok(r2pre.objects_examined > 0 && r2pre.summary.examined.invoice > 0 && r2pre.summary.examined.subscription > 0);
  for (const k of ["subscription_updated", "invoice_imported", "payment_imported", "refund_imported", "checkout_updated"]) {
    assert.ok(r2pre.summary.changed[k] >= 1, `${k}: ${JSON.stringify(r2pre.summary.changed)}`);
  }
  assert.equal(JSON.stringify(r2pre.summary).includes("hosted_invoice_url"), false, "no Stripe payloads in the summary");
  ok("run history: status, counts and a category summary per run; the run total is the clients' changes plus the catalog's");

  // 18: an admin's manual runs (agency-wide and one client) use the same engine.
  const adm = await post(reconcile, { authorization: `Bearer ${tokenFor(ADMIN)}` });
  assert.equal(adm.status, 202);
  await Promise.all(jobs.splice(0));
  assert.equal(sql(`select trigger || '|' || requested_by || '|' || status || '|' || customers_examined from billing_reconciliation_runs where id = '${adm.body.run_id}'`),
    `admin|${adminId}|completed|3`); // D's customer was deleted in Stripe: no longer linked
  const one = await post(reconcile, { authorization: `Bearer ${tokenFor(ADMIN)}` }, { client_id: C });
  assert.equal(one.status, 202);
  await Promise.all(jobs.splice(0));
  assert.equal(sql(`select string_agg(client_id::text, ',') from billing_reconciliation_results where run_id = '${one.body.run_id}'`), C);
  assert.equal(sql(`select trigger || '|' || scope_client_id from billing_reconciliation_runs where id = '${one.body.run_id}'`), `admin_client|${C}`);
  ok("admin: a manual agency-wide run and a one-client run go through the same engine and are recorded with the admin");

  // 20: one customer failing.
  const cusC = sql(`select stripe_customer_id from stripe_customers where client_id = '${C}' and livemode = false`);
  s.fail(`/v1/customers/${cusC}`, 10, 500);
  const r4 = await scheduled();
  s.clearFailures();
  assert.equal(r4.status, "completed_with_errors", JSON.stringify(r4));
  assert.equal(r4.failures, 1);
  assert.equal(result(r4.id, C).status, "failed");
  assert.match(result(r4.id, C).error, /500/);
  assert.equal(result(r4.id, A).status, "attention"); // past due, not failed
  assert.equal(result(r4.id, B).status, "attention");
  ok("isolation: C's Stripe errors fail C only; A and B are reconciled and the run is completed_with_errors");

  // 21: a global Stripe failure.
  const broken = fakeStripe();
  broken.api.get = async (path) => { throw new StripeApiError(401, { error: { type: "authentication_error", message: "Invalid API Key provided" } }, path); };
  const r5 = await scheduled(reconcileFor(broken));
  assert.equal(r5.status, "failed");
  assert.match(r5.error, /Stripe refused the key \(401\)/);
  assert.equal(sql(`select count(*) from billing_reconciliation_results where run_id = '${r5.id}'`), "0");
  ok("global failure: an invalid Stripe key fails the run at once with the reason, touching no client");

  // 25: what the screens read.
  const { data: last } = await as(MEMBER).from("client_billing_reconciliation").select("client_id, status, checked_at, records_changed").eq("client_id", A).single();
  assert.equal(last.status, "attention");
  assert.ok(Date.parse(last.checked_at) > Date.now() - 10 * 60_000);
  const { data: health } = await as(MEMBER).from("billing_sync_health").select("*").single();
  assert.equal(health.last_run_status, "failed");
  assert.equal(health.failed_events, 0);
  assert.equal(health.stuck_events, 0);
  ok("last reconciled: a member reads each client's latest result and the agency's sync health");

  console.log(`stripe-reconcile integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
