// Billing test-mode dress rehearsal (production-readiness review, Phases 10–13).
// Walks the whole lifecycle, in the order the Stripe TEST MODE cutover will,
// for one fictional client — "Compass Billing Test Client (TEST)" — with the
// real stripe-billing, stripe-webhook and stripe-reconcile handlers and stores
// behind PostgREST on the full migration replay. Stripe is the in-memory fake
// (tests/fixtures/stripe-fake.mjs); nothing leaves the machine. The same step
// list is the manual checklist for the real test-mode run
// (docs/billing-readiness.md § 10).
//
//   npm run test:billing-rehearsal   (scripts/test-tasks-ui.sh with UI_SPEC set)
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createStripeBilling } from "../supabase/functions/stripe-billing/handler.ts";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";
import { createStripeWebhook } from "../supabase/functions/stripe-webhook/handler.ts";
import { createStripeStore } from "../supabase/functions/_shared/stripe/store.ts";
import { createStripeReconcile } from "../supabase/functions/stripe-reconcile/handler.ts";
import { createReconcileStore } from "../supabase/functions/stripe-reconcile/store.ts";
import { checkPortalConfig } from "../supabase/functions/stripe-billing/handler.ts";
import { fakeStripe, signedRequest } from "./fixtures/stripe-fake.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through npm run test:billing-rehearsal");

const ADMIN = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL_T = { id: "00000000-0000-4000-a000-0000000000c1", email: "billing-test-contact@example.test" };
const PORTAL_B = { id: "00000000-0000-4000-a000-000000000012", email: "portal-b@example.test" };
const users = new Map([ADMIN, PORTAL_T, PORTAL_B].map((u) => [u.id, u]));
const T = "00000000-0000-4000-b000-0000000000c1";           // Compass Billing Test Client (TEST)
const B = "00000000-0000-4000-b000-00000000000b";           // another (fictional) client
const PKG = "00000000-0000-4000-c000-0000000000c1";
const WHSEC = "whsec_rehearsal";
const RSECRET = "reconcile-rehearsal";

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
const billing = createStripeBilling({ config: async () => ({ secretKey: "sk_test_rehearsal", appUrl: "https://crm.example.test" }), store: createBillingStore(service), makeApi: () => s.api });
const webhook = createStripeWebhook({ config: async () => ({ secretKey: "sk_test_rehearsal", webhookSecret: WHSEC }), store: createStripeStore(service), makeApi: () => s.api });
const reconcileStore = createReconcileStore(service);
const jobs = [];
const reconcile = createStripeReconcile({
  config: async () => ({ secretKey: "sk_test_rehearsal" }),
  store: { ...reconcileStore, secret: async (n) => n === "BILLING_RECONCILE_SECRET" ? RSECRET : reconcileStore.secret(n) },
  makeApi: () => s.api, waitUntil: (p) => jobs.push(p),
});
const post = async (h, headers, body = {}) => {
  const r = await h.handle(new Request("http://x/fn", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const callBilling = (u, body) => post(billing, { authorization: `Bearer ${tokenFor(u)}` }, body);
const send = async (event) => {
  const r = await webhook.handle(await signedRequest(event, WHSEC));
  return { status: r.status, body: await r.json() };
};
const deliver = (type, obj) => send(s.event(type, obj));
async function reconcileRun(body = {}) {
  const r = await post(reconcile, { "x-billing-reconcile-secret": RSECRET }, body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await Promise.all(jobs.splice(0));
  return json(`select row_to_json(x) from billing_reconciliation_runs x where id = '${r.body.run_id}'`);
}
const status = (client) => json(`select row_to_json(x) from client_billing_status x where client_id = '${client}'`);
const entitlements = async () => {
  const { data, error } = await as(ADMIN).rpc("client_entitlements_for", { p_client_id: T });
  assert.equal(error, null, error?.message);
  return data;
};
const usage = async (key) => {
  const { data, error } = await as(ADMIN).rpc("client_quota_usage", { p_client_id: T });
  assert.equal(error, null, error?.message);
  return data.find((u) => u.service_key === key);
};
const portalView = async (u, view) => {
  const { data, error } = await as(u).from(view).select("*");
  assert.equal(error, null, error?.message);
  return data;
};
const STRIPE_ID = /\b(cus|sub|price|prod|in|pi|ch|si|bpc|bps|cs|evt|re)_[A-Za-z0-9]{3,}/;

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

try {
  sqlAdmin(`update team_members set role = 'admin' where auth_user_id = '${ADMIN.id}'`);
  // ── Phase 9: the fake test client, its portal contact, the test package ──
  sql(`insert into clients (id, name, city, state, status, industry)
       values ('${T}', 'Compass Billing Test Client (TEST)', 'Springfield', 'MO', 'active', 'FICTIONAL billing test client — not a real business')`);
  sqlAdmin(`insert into auth.users (id, email, email_confirmed_at) values ('${PORTAL_T.id}', '${PORTAL_T.email}', now())`);
  sql(`insert into portal_users (client_id, email, is_active) values ('${T}', '${PORTAL_T.email}', true)`);
  s.put({ id: "prod_VMxmKG052epGVU", object: "product", livemode: false, name: "Compass Test Standard (TEST)", active: true, metadata: {}, created: 1 });
  s.put({ id: "price_1UMDr54Zq9yMk653B7jdneFm", object: "price", livemode: false, product: "prod_VMxmKG052epGVU", active: true, type: "recurring", currency: "usd",
    unit_amount: 250000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
  {
    const admin = as(ADMIN);
    const { error } = await admin.from("billing_packages").insert({ id: PKG, key: "test_standard", name: "Test Standard (TEST)", kind: "standard" });
    assert.equal(error, null, error?.message);
    const rows = [
      ["website", "feature", true, null], ["hosting", "feature", true, null], ["seo", "feature", true, null], ["gbp", "feature", true, null],
      ["social", "feature", true, null], ["reporting", "feature", true, null], ["client_portal", "feature", true, null],
      ["blog_posts", "quota", true, 4], ["gbp_posts", "quota", true, 8], ["social_posts", "quota", true, 30],
      ["website_pages", "quota", true, 2], ["website_refreshes", "quota", true, 2],
    ].map(([service_key, service_kind, enabled, quantity]) => ({ package_id: PKG, service_key, service_kind, enabled, quantity }));
    const { error: e2 } = await admin.from("package_entitlements").insert(rows);
    assert.equal(e2, null, e2?.message);
  }
  assert.equal((await callBilling(ADMIN, { action: "import_product", target: "package", target_id: PKG, product_id: "prod_VMxmKG052epGVU" })).status, 200);
  const pp = sql(`insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, is_default)
    values ('${PKG}', 'standard', 'prod_VMxmKG052epGVU', 'price_1UMDr54Zq9yMk653B7jdneFm', true) returning id`).split("\n")[0];

  // ── Phase 10: agreement → entitlements ──
  {
    // The test agreement states its contracted price: the TEST price's $2,500.00/month.
    const { error } = await as(ADMIN).from("plans").insert({ client_id: T, package_id: PKG, collection: "stripe",
      agreed_amount_cents: 250000, agreed_currency: "usd", agreed_billing_interval: "month", agreed_billing_interval_count: 1 });
    assert.equal(error, null, error?.message);
  }
  const ents = await entitlements();
  const byKey = Object.fromEntries(ents.map((e) => [e.service_key, e]));
  assert.equal(ents.length, 14);
  for (const k of ["website", "hosting", "seo", "gbp", "social", "reporting", "client_portal"]) assert.equal(byKey[k].enabled, true, k);
  for (const k of ["paid_ads", "crm"]) assert.deepEqual([byKey[k].enabled, byKey[k].source], [false, "none"], k);
  assert.deepEqual(["blog_posts", "gbp_posts", "social_posts", "website_pages", "website_refreshes"].map((k) => byKey[k].quantity), [4, 8, 30, 2, 2]);
  ok("agreement assigned: the test package's services and quotas (4 blog, 8 GBP, 30 social, 2 pages, 2 refreshes) are the client's entitlements");

  // Customer → Checkout from the approved price → payment → webhook.
  const cust = await callBilling(ADMIN, { action: "create_customer", client_id: T, email: "billing-test@example.test" });
  assert.equal(cust.status, 200, JSON.stringify(cust.body));
  const cusId = json(`select row_to_json(x) from stripe_customers x where client_id = '${T}'`).stripe_customer_id;
  assert.equal(s.get(cusId).metadata.compass_client_id, T);
  // Until the agreement is bound to its exact TEST price, Checkout refuses it.
  assert.equal((await callBilling(ADMIN, { action: "create_checkout", client_id: T, request_id: "00000000-0000-4000-f000-0000000000c0" })).body.error,
    "agreement_price_not_mapped");
  {
    // 06_bind_test_client_price.sql's step, through the app's path (an admin's update; the database checks it).
    const { error } = await as(ADMIN).from("plans").update({ billing_package_price_id: pp }).eq("client_id", T);
    assert.equal(error, null, error?.message);
    assert.equal(sql(`select price_status || '|' || stripe_price_id from client_agreement_price where client_id = '${T}'`),
      "ready|price_1UMDr54Zq9yMk653B7jdneFm");
  }
  // The browser cannot substitute another price.
  assert.equal((await callBilling(ADMIN, { action: "create_checkout", client_id: T, package_price_id: "00000000-0000-4000-d000-00000000dead",
    request_id: "00000000-0000-4000-f000-0000000000c0" })).body.error, "agreement_price_mismatch");
  const co = await callBilling(ADMIN, { action: "create_checkout", client_id: T, request_id: "00000000-0000-4000-f000-0000000000c1" });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.equal(s.get(co.body.checkout.session_id).line_items_requested[0].price, "price_1UMDr54Zq9yMk653B7jdneFm");
  assert.match(co.body.checkout.url, /^https:\/\//);
  assert.equal(status(T).billing_state, "checkout_pending");
  ok("Stripe customer created (linked by metadata); Checkout refused until the agreement is bound to its exact TEST price ($2,500.00/month, price_1UMDr54Zq9yMk653B7jdneFm), then created at exactly that price (no other price accepted); the payment link is ready to copy");

  const done = s.complete(co.body.checkout.session_id);
  const cse = await deliver("checkout.session.completed", s.get(co.body.checkout.session_id));
  assert.equal(cse.status, 200, JSON.stringify(cse.body));
  const st = status(T);
  assert.equal(st.billing_state, "active");
  assert.equal(st.mrr_cents, 250000);
  assert.equal(new Date(st.next_billing_at).getTime() / 1000, s.get(done.subscription).items.data[0].current_period_end);
  assert.equal(json(`select row_to_json(x) from subscriptions x where stripe_subscription_id = '${done.subscription}'`).status, "active");
  assert.equal(json(`select row_to_json(x) from invoices x where stripe_invoice_id = '${done.invoice}'`).status, "paid");
  assert.equal(json(`select row_to_json(x) from payments x where stripe_payment_intent_id = '${done.payment_intent}'`).status, "succeeded");
  assert.equal(json(`select row_to_json(x) from checkout_sessions x where client_id = '${T}'`).status, "complete");
  assert.deepEqual(await entitlements(), ents);
  ok("test payment completed → webhook → subscription, invoice and payment mirrored; Active; MRR $2,500; next billing date = Stripe's period end; entitlements unchanged");

  // Invoice internally and in the portal.
  {
    const { data } = await as(ADMIN).from("invoices").select("stripe_invoice_id, hosted_invoice_url").eq("client_id", T);
    assert.equal(data.length, 1);
    const pinv = await portalView(PORTAL_T, "portal_billing_invoices");
    assert.equal(pinv.length, 1);
    assert.match(pinv[0].hosted_invoice_url, /^https:\/\/invoice\.stripe\.com\//);
    assert.match(pinv[0].invoice_pdf, /^https:\/\/pay\.stripe\.com\//);
    const psum = await portalView(PORTAL_T, "portal_billing_summary");
    assert.deepEqual([psum.length, psum[0].status, psum[0].monthly_amount_cents, psum[0].can_manage_billing], [1, "active", 250000, true]);
    // The plan price the portal shows is the agreement's.
    assert.deepEqual([psum[0].agreed_amount_cents, psum[0].agreed_currency, psum[0].agreed_interval, psum[0].agreed_interval_count],
      [250000, "usd", "month", 1]);
    const pents = await portalView(PORTAL_T, "portal_entitlements");
    // Stripe's own hosted invoice page and PDF are the customer-facing links
    // (required); every other field carries no Stripe id.
    const scrub = (rows) => rows.map(({ hosted_invoice_url, invoice_pdf, ...rest }) => rest);
    for (const view of [pinv, psum, pents]) assert.doesNotMatch(JSON.stringify(scrub(view)), STRIPE_ID);
    for (const col of ["package_id", "source", "override_reason", "attention_reasons", "billing_attention"]) {
      assert.ok(!Object.keys(psum[0]).includes(col) && !Object.keys(pents[0]).includes(col), col);
    }
    assert.equal((await portalView(PORTAL_B, "portal_billing_invoices")).filter((i) => i.client_id === T).length, 0);
  }
  ok("the invoice is visible internally and, safely, in the client portal (hosted page + PDF; no Stripe id, package id or attention code)");

  // Customer Portal: this client only, restricted configuration.
  assert.equal((await callBilling(ADMIN, { action: "configure_portal" })).status, 200);
  const conf = s.all("billing_portal.configuration").at(-1);
  assert.deepEqual(checkPortalConfig(conf), []);
  assert.deepEqual([conf.features.payment_method_update.enabled, conf.features.subscription_cancel.enabled, conf.features.subscription_update.enabled],
    [true, false, false]);
  const ps = await callBilling(PORTAL_T, { action: "create_portal_session" });
  assert.equal(ps.status, 200, JSON.stringify(ps.body));
  assert.equal(s.all("billing_portal.session").at(-1).customer, cusId);
  assert.equal(s.all("billing_portal.session").at(-1).return_url, "https://crm.example.test/portal/billing");
  assert.equal((await callBilling(PORTAL_B, { action: "create_portal_session", client_id: T })).status, 403);
  s.patch(conf.id, { features: { ...conf.features, subscription_cancel: { enabled: true } } });
  const widened = await callBilling(PORTAL_T, { action: "create_portal_session" });
  assert.deepEqual([widened.status, widened.body.error], [409, "portal_config_unsafe"], "a configuration widened in the dashboard is refused");
  s.patch(conf.id, { features: conf.features });
  ok("Customer Portal opens for this client only: payment methods managed; cancel and package changes unavailable (a widened configuration is refused); another client's contact is refused");

  // Reconciliation: runs, then reports no differences.
  const r1 = await reconcileRun();
  assert.ok(["completed"].includes(r1.status), JSON.stringify(r1));
  const r2 = await reconcileRun();
  assert.deepEqual([r2.status, r2.records_changed], ["completed", 0]);
  ok(`reconciliation runs (first: ${r1.records_changed} change(s)); the second reports no differences`);

  // ── Phase 11: failure paths ──
  const sub = done.subscription;
  const baseInv = s.get(done.invoice);
  // Payment failure.
  s.put({ ...baseInv, id: "in_TFail", number: "T-0002", status: "open", amount_paid: 0, amount_remaining: 250000, attempt_count: 1, attempted: true,
    next_payment_attempt: Math.floor(Date.now() / 1000) + 3 * 86400, created: baseInv.created + 60, due_date: null,
    status_transitions: { finalized_at: baseInv.created + 60, paid_at: null }, payments: { object: "list", data: [] },
    hosted_invoice_url: "https://invoice.stripe.com/i/in_TFail", lines_data: [{ ...baseInv.lines_data[0], id: "il_TFail" }] });
  s.patch(sub, { status: "past_due", latest_invoice: "in_TFail" });
  assert.equal((await deliver("invoice.payment_failed", s.get("in_TFail"))).body.status, "processed");
  let now = status(T);
  assert.equal(now.billing_state, "past_due");
  assert.ok(now.billing_attention && now.attention_reasons.includes("subscription_past_due"), now.attention_reasons);
  assert.deepEqual(await entitlements(), ents);
  assert.equal((await portalView(PORTAL_T, "portal_billing_summary"))[0].status, "payment_attention");
  ok("payment failure → webhook → billing needs attention (past due) → entitlements remain active; the portal says \"payment needs attention\"");

  // Successful retry.
  s.put({ id: "pi_TRetry", object: "payment_intent", livemode: false, customer: cusId, status: "succeeded", amount: 250000, currency: "usd",
    latest_charge: "ch_TRetry", payment_method_types: ["card"], last_payment_error: null, created: baseInv.created + 120 });
  s.put({ id: "ch_TRetry", object: "charge", livemode: false, payment_intent: "pi_TRetry", amount: 250000, amount_refunded: 0,
    created: baseInv.created + 120, payment_method_details: { type: "card" } });
  s.patch("in_TFail", { status: "paid", amount_paid: 250000, amount_remaining: 0, attempt_count: 2,
    status_transitions: { finalized_at: baseInv.created + 60, paid_at: baseInv.created + 120 },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_TRetry" } }] } });
  s.patch(sub, { status: "active" });
  assert.equal((await deliver("invoice.paid", s.get("in_TFail"))).body.status, "processed");
  now = status(T);
  assert.deepEqual([now.billing_state, now.billing_attention], ["active", false]);
  ok("successful retry → the state returns to Active, attention cleared");

  // Duplicate webhook.
  const dupe = s.event("invoice.paid", s.get("in_TFail"));
  assert.equal((await send(dupe)).body.status, "processed");
  assert.equal((await send(dupe)).body.duplicate, true);
  assert.equal(sql(`select attempts from stripe_events where id = '${dupe.id}'`), "1");
  ok("duplicate webhook → one processing result (the second delivery is acknowledged as a duplicate)");

  // Out-of-order webhook, then cancel at period end.
  const stale = s.event("customer.subscription.updated", { ...s.get(sub), status: "past_due" });
  s.patch(sub, { cancel_at_period_end: true, cancellation_details: { reason: "cancellation_requested", feedback: null, comment: null } });
  await deliver("customer.subscription.updated", s.get(sub));
  await send(stale);
  now = status(T);
  assert.deepEqual([now.subscription_status, now.billing_state, now.next_billing_at], ["active", "canceling", null]);
  assert.deepEqual(await entitlements(), ents);
  const pend = (await portalView(PORTAL_T, "portal_billing_summary"))[0];
  assert.ok(pend.status === "scheduled_to_end" && pend.ends_at, JSON.stringify(pend));
  ok("out-of-order webhook → Stripe's current state wins; cancel-at-period-end mirrored as \"scheduled to end\" with its end date; entitlements intact");
  s.patch(sub, { cancel_at_period_end: false, cancellation_details: { reason: null, feedback: null, comment: null } });
  await deliver("customer.subscription.updated", s.get(sub));
  assert.equal(status(T).billing_state, "active");

  // Refunds: two partial refunds on the first payment, each its own row.
  const ch0 = s.get(done.payment_intent).latest_charge;
  s.put({ id: "re_T1", object: "refund", payment_intent: done.payment_intent, charge: ch0, amount: 50000, currency: "usd", status: "succeeded", reason: "requested_by_customer", failure_reason: null, created: baseInv.created + 200 });
  s.patch(ch0, { amount_refunded: 50000 });
  await deliver("charge.refunded", s.get(ch0));
  s.put({ id: "re_T2", object: "refund", payment_intent: done.payment_intent, charge: ch0, amount: 25000, currency: "usd", status: "succeeded", reason: null, failure_reason: null, created: baseInv.created + 300 });
  s.patch(ch0, { amount_refunded: 75000 });
  await deliver("charge.refunded", s.get(ch0));
  assert.equal(sql(`select count(*) || ':' || sum(amount_cents) from stripe_refunds where client_id = '${T}'`), "2:75000");
  ok("refunds mirrored individually: two partial refunds are two rows ($500 + $250)");

  // Expired Checkout repaired by reconciliation (another fictional client; T is subscribed).
  {
    const { error } = await as(ADMIN).from("plans").insert({ client_id: B, package_id: PKG, collection: "stripe",
      agreed_amount_cents: 250000, agreed_currency: "usd", agreed_billing_interval: "month", agreed_billing_interval_count: 1,
      billing_package_price_id: pp });
    assert.equal(error, null, error?.message);
  }
  assert.equal((await callBilling(ADMIN, { action: "create_customer", client_id: B, email: "b@example.test" })).status, 200);
  const coB = await callBilling(ADMIN, { action: "create_checkout", client_id: B, request_id: "00000000-0000-4000-f000-0000000000c2" });
  assert.equal(coB.status, 200, JSON.stringify(coB.body));
  s.patch(coB.body.checkout.session_id, { status: "expired", url: null });   // no webhook delivered
  assert.equal(sql(`select status from checkout_sessions where stripe_checkout_session_id = '${coB.body.checkout.session_id}'`), "open");
  await reconcileRun();
  assert.equal(sql(`select status from checkout_sessions where stripe_checkout_session_id = '${coB.body.checkout.session_id}'`), "expired");
  ok("expired Checkout (no webhook) → reconciliation repairs the state");

  // Missed webhook → reconciliation repairs the mirror; then no differences.
  const item = s.get(sub).items.data[0];
  s.patch(sub, { items: { object: "list", data: [{ ...item, quantity: 2 }] } });   // quantity changed in Stripe, no webhook
  const rMiss = await reconcileRun();
  assert.ok(rMiss.records_changed > 0, JSON.stringify(rMiss));
  assert.equal(status(T).mrr_cents, 500000);
  assert.equal((await reconcileRun()).records_changed, 0);
  ok("missed webhook → reconciliation repairs the mirror (MRR follows Stripe: $5,000); the next run reports no differences");

  // ── Phase 12: entitlements and the Five Layers ──
  for (const [label, fields] of [
    ["past_due", { status: "past_due" }], ["unpaid", { status: "unpaid" }],
    ["canceling", { status: "active", cancel_at_period_end: true }], ["canceled", { status: "canceled", canceled_at: Math.floor(Date.now() / 1000), cancel_at_period_end: false }],
  ]) {
    s.patch(sub, fields);
    assert.equal((await callBilling(ADMIN, { action: "resync_customer", client_id: T })).status, 200);
    assert.equal(status(T).billing_state, label);
    assert.deepEqual(await entitlements(), ents, label);
  }
  ok("past_due, unpaid, canceling and canceled leave the client's entitlements exactly as agreed");

  // Social 30 → 20 → 30 with existing work kept.
  const month = sql(`select (now() at time zone 'America/Chicago')::date`);
  sqlAdmin(`set session_replication_role = replica;
    insert into social_posts (client_id, platform, search_intent, copy, created_at)
    select '${T}', 'facebook', 'commercial', 'Rehearsal post ' || g, now() from generate_series(1, 25) g`);
  let u = await usage("social_posts");
  assert.deepEqual([u.allocation, u.used, u.remaining, u.over_allocation], [30, 25, 5, 0]);
  const admin = as(ADMIN);
  assert.equal((await admin.from("client_entitlement_overrides").insert({ client_id: T, service_key: "social_posts", service_kind: "quota",
    enabled: true, quantity: 20, reason: "TEST: reduced to 20" })).error, null);
  u = await usage("social_posts");
  assert.deepEqual([u.allocation, u.used, u.remaining, u.over_allocation], [20, 25, 0, 5]);
  assert.equal(sql(`select count(*) from social_posts where client_id = '${T}'`), "25");
  assert.equal((await admin.from("client_entitlement_overrides").update({ quantity: 30, reason: "TEST: back to 30" })
    .eq("client_id", T).eq("service_key", "social_posts")).error, null);
  u = await usage("social_posts");
  assert.deepEqual([u.allocation, u.remaining], [30, 5]);
  assert.equal(sql(`select count(*) from client_agreement_events where client_id = '${T}' and service_key = 'social_posts'`), "2");
  ok(`social 30 → 20: remaining 0, 5 over, all 25 posts kept; 20 → 30: remaining 5 again; both changes in the agreement history (${month})`);

  // The Five Layer reads.
  {
    const { data: intel, error } = await admin.rpc("client_intelligence_input", { p_client_id: T });
    assert.equal(error, null, error?.message);
    assert.ok(intel?.client, "Client Intelligence reads the test client");
    assert.doesNotMatch(JSON.stringify(intel), STRIPE_ID);
    const { error: e2 } = await admin.rpc("authority_input", { p_client_id: T });
    assert.equal(e2, null, e2?.message);
  }
  ok("Client Intelligence and Authority inputs read the test client with no billing data in them (the agreement is read separately)");

  // ── Phase 13: portal ──
  {
    const sum = await portalView(PORTAL_T, "portal_billing_summary");
    assert.equal(sum.length, 1);
    assert.equal(sum[0].client_id, T);
    const ents2 = await portalView(PORTAL_T, "portal_entitlements");
    assert.ok(ents2.every((e) => e.client_id === T));
    assert.ok(ents2.find((e) => e.service_key === "social_posts").quantity === 30);
    for (const table of ["stripe_customers", "subscriptions", "invoices", "payments", "billing_audit_events",
      "billing_reconciliation_runs", "billing_reconciliation_results", "client_billing_status", "plans", "client_entitlement_overrides",
      "client_agreement_events", "stripe_events"]) {
      const { data } = await as(PORTAL_T).from(table).select("*").limit(5);
      assert.equal((data ?? []).length, 0, `portal reads nothing from ${table}`);
    }
    const bSum = await portalView(PORTAL_B, "portal_billing_summary");
    assert.ok(bSum.every((r) => r.client_id !== T));
    assert.ok((await portalView(PORTAL_B, "portal_entitlements")).every((r) => r.client_id !== T));
    const { data: rows } = await as(PORTAL_B).rpc("portal_billing_summary_row");
    assert.ok((rows ?? []).every((r) => r.client_id !== T));
  }
  ok("portal: its own summary and client-safe entitlements only; no billing table, audit, reconciliation or history readable; another client's contact cannot reach it");

  console.log(`Billing test-mode rehearsal passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
