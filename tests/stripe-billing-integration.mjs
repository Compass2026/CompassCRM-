// End-to-end check of stripe-billing (B3) against a real database: the full
// migration replay behind PostgREST, so the handler's store reaches Postgres
// as authenticator / service_role (the session 0059 / 0060 admit), and every
// teammate or portal read and write goes through RLS as that person. The
// handler, the shared sync layer, the webhook and both stores are the
// deployed ones; Stripe is the in-memory fake (tests/fixtures/stripe-fake.mjs).
//
//   npm run test:stripe-billing   (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional clients, customers and ids only. Nothing leaves the machine.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createStripeBilling } from "../supabase/functions/stripe-billing/handler.ts";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";
import { createStripeWebhook } from "../supabase/functions/stripe-webhook/handler.ts";
import { createStripeStore } from "../supabase/functions/_shared/stripe/store.ts";
import { fakeStripe, seedCustomer, signedRequest } from "./fixtures/stripe-fake.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through npm run test:stripe-billing");

const ADMIN = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const MEMBER = { id: "00000000-0000-4000-a000-000000000021", email: "sandbox-member@compassmarketing.ai" };
const PORTAL_A = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const PORTAL_B = { id: "00000000-0000-4000-a000-000000000012", email: "portal-b@example.test" };
const STRANGER = { id: "00000000-0000-4000-a000-000000000014", email: "stranger@example.test" };
const users = new Map([ADMIN, MEMBER, PORTAL_A, PORTAL_B, STRANGER].map((u) => [u.id, u]));
const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const C = "00000000-0000-4000-b000-00000000000c";
const PKG = "00000000-0000-4000-c000-0000000000e1";
const CUSTOM = "00000000-0000-4000-c000-0000000000e2";
const WHSEC = "whsec_billing_integration";
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

// Supabase's gateway, reduced to /auth/v1/user and /rest/v1.
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

function handlerFor(s, key = "sk_test_billing") {
  return createStripeBilling({
    config: async () => ({ secretKey: key, appUrl: "https://crm.example.test" }),
    store: createBillingStore(service),
    makeApi: () => s.api,
  });
}
const s = fakeStripe();
const billing = handlerFor(s);
const call = async (u, body, h = billing) => {
  const r = await h.handle(new Request("http://x/stripe-billing", {
    method: "POST", headers: { authorization: u ? `Bearer ${tokenFor(u)}` : "", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: r.status, body: await r.json() };
};
const webhook = createStripeWebhook({ config: async () => ({ secretKey: "sk_test_billing", webhookSecret: WHSEC }), store: createStripeStore(service), makeApi: () => s.api });
const deliver = async (type, obj) => {
  const r = await webhook.handle(await signedRequest(s.event(type, obj), WHSEC));
  return { status: r.status, body: await r.json() };
};
const status = (client) => JSON.parse(sql(`select row_to_json(x) from client_billing_status x where client_id = '${client}'`));

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

try {
  // A second teammate (member) and a third client; the sandbox team account is the admin.
  sqlAdmin(`insert into auth.users (id, email, email_confirmed_at) values ('${MEMBER.id}', '${MEMBER.email}', now())`);
  sqlAdmin(`insert into team_members (auth_user_id, name, email, role) values ('${MEMBER.id}', 'Morgan Member', '${MEMBER.email}', 'member')`);
  sqlAdmin(`update team_members set role = 'admin' where auth_user_id = '${ADMIN.id}'`);
  sql(`insert into clients (id, name, city, state, status) values ('${C}', 'Cedar Landscaping', 'Joplin', 'MO', 'active')`);
  const adminId = sql(`select id from team_members where auth_user_id = '${ADMIN.id}'`);

  // ── Catalog: packages are defined by an admin in the app; Stripe products imported here.
  s.put({ id: "prod_Growth", object: "product", livemode: false, name: "Compass Growth", active: true, metadata: {}, created: 1 });
  s.put({ id: "price_GrowthM", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
    unit_amount: 150000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
  s.put({ id: "price_GrowthOld", object: "price", livemode: false, product: "prod_Growth", active: false, type: "recurring", currency: "usd",
    unit_amount: 120000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
  s.put({ id: "prod_Custom", object: "product", livemode: false, name: "Compass Custom Retainer", active: true, metadata: {}, created: 1 });
  {
    const member = as(MEMBER);
    const { error: memberPkg } = await member.from("billing_packages").insert({ key: "growth", name: "Growth", kind: "standard" });
    assert.ok(memberPkg, "a member cannot define a package");
    const admin = as(ADMIN);
    const { error } = await admin.from("billing_packages").insert([
      { id: PKG, key: "growth", name: "Growth", kind: "standard" },
      { id: CUSTOM, key: "custom_retainer", name: "Custom Retainer", kind: "custom" },
    ]);
    assert.equal(error, null, error?.message);
  }
  assert.equal((await call(MEMBER, { action: "import_product", target: "package", target_id: PKG, product_id: "prod_Growth" })).status, 403);
  const imp = await call(ADMIN, { action: "import_product", target: "package", target_id: PKG, product_id: "prod_Growth" });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.prices.sort(), ["price_GrowthM", "price_GrowthOld"]);
  assert.equal((await call(ADMIN, { action: "import_product", target: "package", target_id: CUSTOM, product_id: "prod_Custom" })).status, 200);
  assert.equal(sql(`select stripe_product_id from billing_packages where id = '${PKG}'`), "prod_Growth");
  assert.equal(sql(`select count(*) from stripe_prices where stripe_product_id = 'prod_Growth'`), "2");
  // The admin approves the standard price in the app (RLS: admin only).
  const { error: memberMap } = await as(MEMBER).from("billing_package_prices")
    .insert({ package_id: PKG, package_kind: "standard", stripe_product_id: "prod_Growth", stripe_price_id: "price_GrowthM", is_default: true });
  assert.ok(memberMap, "a member cannot map a price");
  const { data: mapped, error: mapErr } = await as(ADMIN).from("billing_package_prices")
    .insert({ package_id: PKG, package_kind: "standard", stripe_product_id: "prod_Growth", stripe_price_id: "price_GrowthM", is_default: true }).select("id").single();
  assert.equal(mapErr, null, mapErr?.message);
  const PP = mapped.id;
  ok("catalog: an admin defines packages and maps prices, importing the Stripe product through the shared sync; a member can do neither");

  // ── Agreements: a member records them.
  for (const [client, pkg] of [[A, PKG], [B, PKG], [C, CUSTOM]]) {
    const { error } = await as(MEMBER).from("plans").upsert({ client_id: client, package_id: pkg, collection: "stripe" }, { onConflict: "client_id" });
    assert.equal(error, null, error?.message);
  }
  ok("agreements: a member records each client's package");

  // ── The agreed price and its exact Stripe Price: an admin's.
  {
    const terms = (cents) => ({ agreed_amount_cents: cents, agreed_currency: "usd", agreed_billing_interval: "month", agreed_billing_interval_count: 1 });
    const { error: memberTerms } = await as(MEMBER).from("plans").update(terms(150000)).eq("client_id", A);
    assert.match(memberTerms?.message ?? "", /Only an admin/);
    for (const [client, cents] of [[A, 150000], [B, 150000], [C, 225000]]) {
      const { error } = await as(ADMIN).from("plans").update(terms(cents)).eq("client_id", client);
      assert.equal(error, null, error?.message);
    }
    const { error: memberBind } = await as(MEMBER).from("plans").update({ billing_package_price_id: PP }).eq("client_id", A);
    assert.match(memberBind?.message ?? "", /Only an admin/);
    // No Stripe Price is bound yet: Checkout has nothing to sell.
    assert.equal((await call(ADMIN, { action: "create_checkout", client_id: A, request_id: rid(90) })).body.error, "agreement_price_not_mapped");
    const { error: wrongTerms } = await as(ADMIN).from("plans").update(terms(99900)).eq("client_id", A).select();
    assert.equal(wrongTerms, null);
    const { error: mismatch } = await as(ADMIN).from("plans").update({ billing_package_price_id: PP }).eq("client_id", A);
    assert.match(mismatch?.message ?? "", /differs from the agreement/, "the database refuses a price that is not the agreed one");
    await as(ADMIN).from("plans").update(terms(150000)).eq("client_id", A);
    for (const client of [A, B]) {
      const { error } = await as(ADMIN).from("plans").update({ billing_package_price_id: PP }).eq("client_id", client);
      assert.equal(error, null, error?.message);
    }
    assert.equal(sql(`select string_agg(price_status, ',' order by client_id) from client_agreement_price where client_id in ('${A}', '${B}')`), "ready,ready");
  }
  ok("agreed price: only an admin records it and binds the exact approved Stripe Price, which must say the same thing; unbound, Checkout refuses");

  // ── 2. Create a customer for A.
  assert.equal((await call(MEMBER, { action: "create_customer", client_id: A, email: "owner@a.example.test" })).status, 403);
  const [c1, c2] = await Promise.all([
    call(ADMIN, { action: "create_customer", client_id: A, email: "owner@a.example.test" }),
    call(ADMIN, { action: "create_customer", client_id: A, email: "owner@a.example.test" }),
  ]);
  assert.ok([c1.status, c2.status].includes(200), JSON.stringify([c1.body, c2.body]));
  assert.equal(s.all("customer").length, 1, "one Stripe customer for two clicks");
  const cusA = s.all("customer")[0].id;
  assert.equal(s.get(cusA).metadata.compass_client_id, A);
  assert.equal(sql(`select link_source || '|' || (linked_by = '${adminId}') from stripe_customers where client_id = '${A}'`), "created|true");
  assert.equal((await call(ADMIN, { action: "create_customer", client_id: A, email: "owner@a.example.test" })).body.error, "client_already_linked");
  ok("create customer: admin only; two concurrent clicks make one Stripe customer, linked with the client in its metadata");

  // ── 1. Link B's existing Stripe customer (with its history).
  seedCustomer(s, { cus: "cus_ExistB", sub: "sub_ExistB", inv: "in_ExistB", pi: "pi_ExistB", py: "py_ExistB", prefix: "EB" });
  const found = await call(ADMIN, { action: "search_customers", query: "owner-eb@example.test" });
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.customers.map((c) => [c.id, c.linked_client, c.subscriptions.length]), [["cus_ExistB", null, 1]]);
  assert.equal((await call(MEMBER, { action: "link_customer", client_id: B, customer_id: "cus_ExistB", confirm: true })).status, 403);
  assert.equal((await call(ADMIN, { action: "link_customer", client_id: B, customer_id: "cus_ExistB" })).body.error, "confirmation_required");
  const linked = await call(ADMIN, { action: "link_customer", client_id: B, customer_id: "cus_ExistB", confirm: true });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(sql(`select count(*) from subscriptions where client_id = '${B}'`), "1");
  assert.equal(sql(`select count(*) from invoices where client_id = '${B}'`), "1");
  assert.equal(sql(`select count(*) from payments where client_id = '${B}' and source = 'stripe'`), "1");
  assert.equal(sql(`select string_agg(amount_cents::text, ',' order by amount_cents) from stripe_refunds where client_id = '${B}'`), "50000,100000");
  assert.equal(s.get("cus_ExistB").metadata.compass_client_id, undefined, "linking never writes to Stripe");
  const searchAgain = await call(ADMIN, { action: "search_customers", query: "cus_ExistB" });
  assert.equal(searchAgain.body.customers[0].linked_client.id, B);
  assert.equal((await call(ADMIN, { action: "link_customer", client_id: C, customer_id: "cus_ExistB", confirm: true })).body.error, "customer_linked_elsewhere");
  assert.equal((await call(ADMIN, { action: "link_customer", client_id: A, customer_id: "cus_ExistB", confirm: true })).body.error, "customer_linked_elsewhere");
  s.put({ id: "cus_SecondA", object: "customer", livemode: false, name: "A again", email: "a2@example.test", metadata: {}, created: 1 });
  assert.equal((await call(ADMIN, { action: "link_customer", client_id: A, customer_id: "cus_SecondA", confirm: true })).body.error, "client_already_linked");
  ok("link existing: search shows the customer; an admin links it with explicit confirmation; its subscription, invoice, payment and both partial refunds are imported by the shared sync; no second client, no second customer");

  // ── Duplicate subscription: B already pays.
  const dup = await call(ADMIN, { action: "create_checkout", client_id: B, request_id: rid(1) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "subscription_exists");
  assert.equal(s.all("checkout.session").length, 0);
  ok("duplicate subscription: Checkout is refused for a client whose customer already has an active subscription");

  // ── 5/6. Checkout for A, standard package.
  assert.equal((await call(MEMBER, { action: "create_checkout", client_id: A, request_id: rid(2) })).status, 403);
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: A, package_price_id: rid(99), request_id: rid(2) })).body.error,
    "agreement_price_mismatch", "the browser cannot choose another price");
  const co = await call(ADMIN, { action: "create_checkout", client_id: A, request_id: rid(2),
    price: "price_GrowthOld", amount_cents: 100, customer: "cus_ExistB" });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const cs = s.all("checkout.session")[0];
  assert.deepEqual([cs.customer, cs.line_items_requested[0].price, cs.client_reference_id], [cusA, "price_GrowthM", A]);
  const row = JSON.parse(sql(`select row_to_json(x) from (select client_id, stripe_customer_id, status, url, livemode, package_id,
    created_by, line_items from checkout_sessions where stripe_checkout_session_id = '${cs.id}') x`));
  assert.deepEqual([row.client_id, row.stripe_customer_id, row.status, row.livemode, row.package_id, row.created_by],
    [A, cusA, "open", false, PKG, adminId]);
  assert.equal(row.url, cs.url);
  assert.equal(co.body.checkout.url, cs.url);
  assert.equal(co.body.checkout.package_name, "Growth");
  assert.equal(co.body.checkout.price.unit_amount_cents, 150000);
  assert.equal(sql(`select count(*) from billing_audit_events where action = 'create_checkout' and client_id = '${A}' and actor_team_member_id = '${adminId}'`), "1");
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: A, request_id: rid(2) })).body.created, false);
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: A, request_id: rid(3) })).body.error, "checkout_open");
  assert.equal(s.all("checkout.session").length, 1);
  // A member reads the link (to copy or send it).
  const { data: memberView } = await as(MEMBER).from("checkout_sessions").select("url, status").eq("client_id", A);
  assert.deepEqual(memberView, [{ url: cs.url, status: "open" }]);
  ok("Checkout: admin creates it at the agreement's exact price only (a different package price is refused; browser price, amount and customer ignored); recorded with its creator and audited; a repeat returns it; a member can read the link");

  // ── Webhook completes it: Checkout success is not proof; the webhook is.
  assert.equal(status(A).billing_state, "checkout_pending");
  s.complete(cs.id);
  const done = await deliver("checkout.session.completed", s.get(cs.id));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(sql(`select status || '|' || (completed_at is not null) || '|' || coalesce(url, 'null') from checkout_sessions where stripe_checkout_session_id = '${cs.id}'`), "complete|true|null");
  const stA = status(A);
  assert.equal(stA.billing_state, "active");
  assert.equal(Number(stA.mrr_cents), 150000);
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: A, request_id: rid(4) })).body.error, "subscription_exists");
  ok("Checkout completed: the webhook marks the session complete and the client active at $1,500 / month; a second sale is refused");

  // ── Custom Retainer for C.
  assert.equal((await call(MEMBER, { action: "create_custom_price", client_id: C, package_id: CUSTOM, amount_cents: 225000, request_id: rid(5) })).status, 403);
  const { error: memberCustom } = await as(MEMBER).from("billing_package_prices").insert({ package_id: CUSTOM, package_kind: "custom",
    stripe_product_id: "prod_Custom", stripe_price_id: "price_GrowthM", client_id: C });
  assert.ok(memberCustom, "a member cannot map a custom price");
  const cp = await call(ADMIN, { action: "create_custom_price", client_id: C, package_id: CUSTOM, amount_cents: 225000, interval: "month",
    nickname: "Cedar retainer", request_id: rid(5) });
  assert.equal(cp.status, 200, JSON.stringify(cp.body));
  assert.equal((await call(ADMIN, { action: "create_custom_price", client_id: C, package_id: CUSTOM, amount_cents: 225000, interval: "month",
    nickname: "Cedar retainer", request_id: rid(5) })).body.created, false);
  assert.equal(s.all("price").filter((p) => p.product === "prod_Custom").length, 1);
  assert.equal(sql(`select client_id || '|' || package_kind from billing_package_prices where id = '${cp.body.package_price_id}'`), `${C}|custom`);
  assert.equal(sql(`select unit_amount_cents || '|' || recurring_interval from stripe_prices where stripe_price_id = '${cp.body.price_id}'`), "225000|month");
  // A cannot be sold C's price: not through Checkout, not even by binding it.
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: A, package_price_id: cp.body.package_price_id, request_id: rid(6) })).body.error, "agreement_price_mismatch");
  const { error: steal } = await as(ADMIN).from("plans")
    .update({ package_id: CUSTOM, agreed_amount_cents: 225000, billing_package_price_id: cp.body.package_price_id }).eq("client_id", A);
  assert.match(steal?.message ?? "", /reserved for another client/);
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: C, request_id: rid(7) })).body.error, "agreement_price_not_mapped");
  {
    const { error } = await as(ADMIN).from("plans").update({ billing_package_price_id: cp.body.package_price_id }).eq("client_id", C);
    assert.equal(error, null, error?.message);
  }
  assert.equal((await call(ADMIN, { action: "create_checkout", client_id: C, request_id: rid(7) })).body.error, "no_customer");
  await call(ADMIN, { action: "create_customer", client_id: C, email: "owner@c.example.test" });
  const coC = await call(ADMIN, { action: "create_checkout", client_id: C, request_id: rid(7) });
  assert.equal(coC.status, 200, JSON.stringify(coC.body));
  assert.equal(coC.body.checkout.price.unit_amount_cents, 225000);
  ok("Custom Retainer: an admin creates C's $2,250 / month price once (idempotent); only C can be sold it");

  // ── Expire C's link.
  const csC = coC.body.checkout.session_id;
  assert.equal((await call(ADMIN, { action: "expire_checkout", client_id: A, session_id: csC })).status, 404);
  const ex = await call(ADMIN, { action: "expire_checkout", client_id: C, session_id: csC });
  assert.equal(ex.status, 200);
  assert.equal(sql(`select status || '|' || coalesce(url, 'null') from checkout_sessions where stripe_checkout_session_id = '${csC}'`), "expired|null");
  ok("expire: an admin expires C's open link in Stripe; the record follows; another client's id is not found");

  // ── 7. Customer Portal.
  assert.equal((await call(PORTAL_A, { action: "create_portal_session" })).body.error, "portal_not_configured");
  assert.equal((await call(MEMBER, { action: "configure_portal" })).status, 403);
  const conf = await call(ADMIN, { action: "configure_portal" });
  assert.equal(conf.status, 200);
  const setting = JSON.parse(sql(`select value from app_settings where key = 'billing_portal'`));
  assert.equal(setting.test.configuration_id, conf.body.configuration_id);
  const pa = await call(PORTAL_A, { action: "create_portal_session" });
  assert.equal(pa.status, 200, JSON.stringify(pa.body));
  assert.equal(s.all("billing_portal.session").at(-1).customer, cusA);
  assert.equal((await call(PORTAL_B, { action: "create_portal_session", client_id: A })).status, 403);
  const pb = await call(PORTAL_B, { action: "create_portal_session" });
  assert.equal(pb.status, 200);
  assert.equal(s.all("billing_portal.session").at(-1).customer, "cus_ExistB");
  assert.equal((await call(STRANGER, { action: "create_portal_session", client_id: A })).status, 403);
  assert.equal((await call(null, { action: "create_portal_session", client_id: A })).status, 401);
  assert.equal((await call(MEMBER, { action: "create_portal_session", client_id: A })).status, 403);
  assert.equal((await call(ADMIN, { action: "create_portal_session", client_id: A })).status, 200);
  assert.equal(sql(`select string_agg(actor_kind, ',' order by created_at) from billing_audit_events where action = 'portal_session'`), "portal,portal,team");
  ok("Customer Portal: configured once by an admin; each portal contact gets their own client's customer only; a stranger, a member and anon are refused");

  // ── 8. External payments.
  const pay = { action: "record_external_payment", client_id: C, amount_cents: 225000, currency: "usd", method: "check",
    paid_at: "2026-09-25", reference: "Check 2201", notes: "Paid by check for September", request_id: rid(8) };
  assert.equal((await call(MEMBER, pay)).status, 403);
  const { error: memberPay } = await as(MEMBER).from("payments").insert({ client_id: C, source: "external", status: "succeeded",
    external_method: "check", amount_cents: 1, currency: "usd", paid_at: "2026-09-25", notes: "x" });
  assert.ok(memberPay, "a member cannot write payments");
  const p1 = await call(ADMIN, pay);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal((await call(ADMIN, pay)).body.created, false);
  assert.equal(sql(`select count(*) || '|' || min(source) || '|' || min(external_method) || '|' || min(amount_cents) || '|' || bool_and(recorded_by = '${adminId}')
    from payments where client_id = '${C}'`), `1|external|check|225000|true`);
  const v = await call(ADMIN, { action: "void_external_payment", client_id: C, payment_id: p1.body.payment_id, reason: "Check returned unpaid" });
  assert.equal(v.status, 200);
  assert.equal((await call(ADMIN, { action: "void_external_payment", client_id: C, payment_id: p1.body.payment_id, reason: "again" })).status, 404);
  assert.equal(sql(`select void_reason from payments where id = '${p1.body.payment_id}'`), "Check returned unpaid");
  assert.equal(sql(`select string_agg(action, ',' order by created_at) from billing_audit_events where client_id = '${C}' and action like '%external%'`),
    "record_external_payment,void_external_payment");
  ok("external payments: admin only; recorded once per request with the admin's name; voided with a reason, never edited or deleted; audited");

  // ── Entitlements are never switched off by billing.
  const ents = () => sql(`select count(*) filter (where enabled) from client_entitlements where client_id = '${B}'`);
  const before = ents();
  s.patch("sub_ExistB", { status: "past_due" });
  assert.equal((await deliver("customer.subscription.updated", s.get("sub_ExistB"))).status, 200);
  assert.equal(status(B).billing_state, "past_due");
  assert.equal(ents(), before);
  ok("past due: B's billing state follows Stripe; its entitlements are unchanged");

  // ── Mode isolation.
  const live = handlerFor(fakeStripe({ mode: "live" }), "sk_live_billing");
  assert.equal((await call(ADMIN, { action: "search_customers", query: "owner" }, live)).body.error, "live_mode_not_enabled");
  sqlAdmin(`insert into app_settings (key, value) values ('billing', '{"livemode": true}')`);
  assert.equal((await call(ADMIN, { action: "search_customers", query: "owner" })).body.error, "key_mode_mismatch");
  assert.equal((await call(PORTAL_A, { action: "create_portal_session" })).body.error, "key_mode_mismatch");
  sqlAdmin(`delete from app_settings where key = 'billing'`);
  const { error: memberMode } = await as(MEMBER).from("app_settings").insert({ key: "billing", value: { livemode: true } });
  assert.ok(memberMode, "a member cannot switch the billing mode");
  ok("mode: a live key does nothing until an admin switches billing to live, and a test key does nothing after; a member cannot switch it");

  // ── Cross-client isolation of the records themselves.
  for (const u of [PORTAL_A, STRANGER]) {
    for (const t of ["checkout_sessions", "billing_audit_events", "payments", "stripe_customers"]) {
      const { data } = await as(u).from(t).select("client_id");
      assert.deepEqual(data ?? [], [], `${u.email} reads ${t}`);
    }
  }
  const { error: auditWrite } = await as(ADMIN).from("billing_audit_events").insert({ action: "link_customer", actor_kind: "team" });
  assert.ok(auditWrite, "not even an admin writes the audit trail directly");
  ok("isolation: portal contacts and strangers read no billing records; nobody writes the audit trail through the API");

  console.log(`stripe-billing integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
