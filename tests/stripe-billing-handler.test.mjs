// stripe-billing request boundary (B3) over a fake Stripe and an in-memory
// store that follows the rules the database enforces (one active link per
// client and mode, a customer linked to one client, idempotent records).
// The real database: tests/stripe-billing-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCheckoutPrice, checkPortalConfig, createStripeBilling, customerSearchQuery, portalConfigParams, searchValue,
} from "../supabase/functions/stripe-billing/handler.ts";
import { BillingDbError } from "../supabase/functions/stripe-billing/store.ts";
import { formEncode } from "../supabase/functions/_shared/stripe/api.ts";
import { fakeStripe } from "./fixtures/stripe-fake.mjs";

const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const ADMIN = "00000000-0000-4000-a000-0000000000ad";
const MEMBER = "00000000-0000-4000-a000-0000000000be";
const PKG_STD = "00000000-0000-4000-c000-000000000001";
const PKG_CUSTOM = "00000000-0000-4000-c000-000000000002";
const PP_STD = "00000000-0000-4000-d000-000000000001";
const PORTAL_A = "00000000-0000-4000-e000-00000000000a";
const rid = (n) => `00000000-0000-4000-f000-${String(n).padStart(12, "0")}`;

function memoryStore({ live = false } = {}) {
  const db = {
    clients: new Map([[A, { id: A, name: "Alpha Roofing", status: "active" }], [B, { id: B, name: "Beta Plumbing", status: "active" }]]),
    plans: new Map([[A, { package_id: PKG_STD, collection: "stripe" }], [B, { package_id: PKG_CUSTOM, collection: "stripe" }]]),
    links: [], // {client_id, stripe_customer_id, livemode, active}
    packages: new Map([
      [PKG_STD, { id: PKG_STD, name: "Growth", kind: "standard", active: true, stripe_product_id: null }],
      [PKG_CUSTOM, { id: PKG_CUSTOM, name: "Custom Retainer", kind: "custom", active: true, stripe_product_id: null }],
    ]),
    packagePrices: new Map(),
    products: new Map(),
    prices: new Map(),
    subs: new Map(),
    checkouts: new Map(),
    payments: new Map(),
    audits: [],
    settings: new Map(),
  };
  const linkFor = (cus) => db.links.find((l) => l.stripe_customer_id === cus && l.active);
  const store = {
    db,
    async apply(ops) {
      return ops.map((o) => {
        const r = o.row ?? {};
        if (o.op === "product") db.products.set(r.stripe_product_id, { ...r, deleted_at: null });
        else if (o.op === "price") db.prices.set(r.stripe_price_id, { ...r, recurring_usage_type: r.recurring_usage_type ?? null, deleted_at: null });
        else if (o.op === "subscription") {
          const l = linkFor(r.stripe_customer_id);
          if (!l) return { op: o.op, id: null, result: "unlinked" };
          db.subs.set(r.stripe_subscription_id, { ...r, client_id: l.client_id });
        } else if (o.op === "checkout_session") {
          const cs = db.checkouts.get(r.stripe_checkout_session_id);
          if (!cs) return { op: o.op, id: null, result: "missing" };
          Object.assign(cs, r);
        }
        return { op: o.op, id: r.stripe_price_id ?? r.stripe_product_id ?? null, result: "written" };
      });
    },
    async linkCustomer(p) {
      if (db.links.some((l) => l.stripe_customer_id === p.row.stripe_customer_id)) throw new Error("duplicate key stripe_customer_id");
      if (db.links.some((l) => l.client_id === p.client_id && l.livemode === p.row.livemode && l.active)) throw new Error("duplicate key one_active_link");
      db.links.push({ client_id: p.client_id, stripe_customer_id: p.row.stripe_customer_id, livemode: p.row.livemode, active: true, link_source: p.link_source });
    },
    async secret() { return null; },
    async billingLivemode() { return live; },
    callers: new Map([
      ["admin", { kind: "team", memberId: ADMIN, role: "admin" }],
      ["member", { kind: "team", memberId: MEMBER, role: "member" }],
      ["portalA", { kind: "portal", portalUserId: PORTAL_A, clientId: A }],
      ["stranger", null],
    ]),
    async caller(jwt) { return store.callers.has(jwt) ? store.callers.get(jwt) : "none"; },
    async client(id) { return db.clients.get(id) ?? null; },
    async plan(id) { return db.plans.get(id) ?? null; },
    async activeLink(clientId, livemode) {
      const l = db.links.find((x) => x.client_id === clientId && x.livemode === livemode && x.active);
      return l ? { stripe_customer_id: l.stripe_customer_id } : null;
    },
    async linkOf(cus) {
      const l = db.links.find((x) => x.stripe_customer_id === cus);
      return l ? { client_id: l.client_id, client_name: db.clients.get(l.client_id).name, active: l.active } : null;
    },
    async linksOf(ids) {
      return db.links.filter((l) => ids.includes(l.stripe_customer_id))
        .map((l) => ({ stripe_customer_id: l.stripe_customer_id, client_id: l.client_id, client_name: db.clients.get(l.client_id).name, active: l.active }));
    },
    async linkCount(clientId, livemode) { return db.links.filter((l) => l.client_id === clientId && l.livemode === livemode).length; },
    async catalogEntry(target, id) {
      const p = target === "package" ? db.packages.get(id) : null;
      return p ? { ...p, mapped_prices: [...db.packagePrices.values()].filter((x) => x.package_id === id).length } : null;
    },
    async productOwner(productId) {
      const p = [...db.packages.values()].find((x) => x.stripe_product_id === productId);
      return p ? { target: "package", id: p.id, name: p.name } : null;
    },
    async productMirror(id) { const p = db.products.get(id); return p ? { livemode: p.livemode, active: p.active } : null; },
    async setProduct(target, id, productId) { db.packages.get(id).stripe_product_id = productId; },
    async packagePrice(id) {
      const p = db.packagePrices.get(id);
      return p ? { ...p, package_active: db.packages.get(p.package_id).active } : null;
    },
    async priceMirror(id) { return db.prices.get(id) ?? null; },
    async mapClientPrice(row) {
      const existing = [...db.packagePrices.values()].find((x) => x.stripe_price_id === row.stripe_price_id);
      if (existing) {
        if (existing.client_id !== row.client_id) throw new BillingDbError("23505", "mapped elsewhere");
        return { id: existing.id, created: false };
      }
      const id = rid(9000 + db.packagePrices.size);
      db.packagePrices.set(id, { id, ...row, active: true });
      return { id, created: true };
    },
    async blockingSubscriptions(clientId, livemode) {
      return [...db.subs.values()].filter((s) => s.client_id === clientId && s.livemode === livemode
        && ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(s.status));
    },
    async openCheckouts(clientId, livemode) {
      return [...db.checkouts.values()].filter((c) => c.client_id === clientId && c.livemode === livemode && c.status === "open")
        .map((c) => ({ stripe_checkout_session_id: c.stripe_checkout_session_id, expires_at: c.expires_at, request_id: c.line_items[0]?.request_id ?? null }));
    },
    async checkout(id) { const c = db.checkouts.get(id); return c ? { client_id: c.client_id, status: c.status, livemode: c.livemode } : null; },
    async checkoutSummary(id) { const c = db.checkouts.get(id); return c ? { session_id: id, url: c.url, status: c.status, expires_at: c.expires_at, livemode: c.livemode } : null; },
    async recordCheckout(p) {
      if (db.checkouts.has(p.stripe_checkout_session_id)) return { id: p.stripe_checkout_session_id, created: false };
      const l = db.links.find((x) => x.stripe_customer_id === p.stripe_customer_id && x.client_id === p.client_id);
      if (!l) throw new BillingDbError("23503", "customer is not this client's");
      db.checkouts.set(p.stripe_checkout_session_id, { ...p });
      db.audits.push({ action: "create_checkout", client_id: p.client_id, actor_team_member_id: p.created_by });
      return { id: p.stripe_checkout_session_id, created: true };
    },
    async recordExternalPayment(p) {
      if (p.recorded_by !== ADMIN) throw new BillingDbError("42501", "Only an admin records an external payment");
      const prior = [...db.payments.values()].find((x) => x.client_request_id === p.client_request_id);
      if (prior) return { id: prior.id, created: false };
      const id = rid(5000 + db.payments.size);
      db.payments.set(id, { id, source: "external", ...p });
      db.audits.push({ action: "record_external_payment", client_id: p.client_id });
      return { id, created: true };
    },
    async voidExternalPayment(p) {
      const x = db.payments.get(p.payment_id);
      if (!x || x.client_id !== p.client_id || x.voided_at) throw new BillingDbError("P0002", "No unvoided external payment");
      Object.assign(x, { voided_at: new Date().toISOString(), void_reason: p.reason });
      db.audits.push({ action: "void_external_payment", client_id: p.client_id });
      return { id: p.payment_id, voided: true };
    },
    async audit(p) { db.audits.push(p); return rid(7000 + db.audits.length); },
    async setting(key) { return db.settings.get(key) ?? null; },
    async saveSetting(key, value) { db.settings.set(key, value); },
  };
  return store;
}

function setup({ key = "sk_test_unit", live = false, achAvailable = true, searchLag = false } = {}) {
  const s = fakeStripe({ mode: key.includes("_live_") ? "live" : "test", achAvailable, searchLag });
  const store = memoryStore({ live });
  const billing = createStripeBilling({
    config: async () => ({ secretKey: key, appUrl: "https://crm.example.test" }),
    store,
    makeApi: () => s.api,
  });
  const call = async (who, body) => {
    const r = await billing.handle(new Request("http://x/stripe-billing", {
      method: "POST", headers: { authorization: `Bearer ${who}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: r.status, body: await r.json() };
  };
  return { s, store, call };
}

// A catalog with a standard package on a Stripe product with a monthly price,
// and the custom package on the general Custom Retainer product.
async function withCatalog(t) {
  t.s.put({ id: "prod_Growth", object: "product", livemode: false, name: "Growth", active: true, metadata: {}, created: 1 });
  t.s.put({ id: "price_GrowthM", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
    unit_amount: 150000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
  t.s.put({ id: "prod_Custom", object: "product", livemode: false, name: "Compass Custom Retainer", active: true, metadata: {}, created: 1 });
  assert.equal((await t.call("admin", { action: "import_product", target: "package", target_id: PKG_STD, product_id: "prod_Growth" })).status, 200);
  assert.equal((await t.call("admin", { action: "import_product", target: "package", target_id: PKG_CUSTOM, product_id: "prod_Custom" })).status, 200);
  t.store.db.packagePrices.set(PP_STD, { id: PP_STD, package_id: PKG_STD, package_kind: "standard", stripe_product_id: "prod_Growth",
    stripe_price_id: "price_GrowthM", client_id: null, active: true });
}
const createCustomer = (t, client = A) => t.call("admin", { action: "create_customer", client_id: client, email: "owner@alpha.example.test" });

// ── Pure rules ──────────────────────────────────────────────────────────────
test("form encoding nests objects and arrays the way Stripe reads them", () => {
  const q = new URLSearchParams(formEncode({ a: 1, line_items: [{ price: "price_1", quantity: 1 }], metadata: { k: "v" }, m: ["card", "us_bank_account"], skip: null }));
  assert.equal(q.get("line_items[0][price]"), "price_1");
  assert.equal(q.get("line_items[0][quantity]"), "1");
  assert.equal(q.get("metadata[k]"), "v");
  assert.equal(q.get("m[1]"), "us_bank_account");
  assert.equal(q.has("skip"), false);
});

test("customer search: an id is retrieved, an email matched exactly, a name by substring; quotes escaped", () => {
  assert.deepEqual(customerSearchQuery(" cus_Abc123 "), { kind: "id", query: "cus_Abc123" });
  assert.deepEqual(customerSearchQuery("Owner@Alpha.test"), { kind: "email", query: "email:'Owner@Alpha.test'" });
  assert.deepEqual(customerSearchQuery("O'Brien"), { kind: "name", query: "name~'O\\'Brien'" });
  assert.equal(searchValue("a\\b"), "'a\\\\b'");
});

test("portal configuration: Compass's is safe; any widening is caught", () => {
  const ours = portalConfigParams("https://crm.example.test");
  const asStripe = { active: true, features: ours.features };
  assert.deepEqual(checkPortalConfig(asStripe), []);
  assert.match(checkPortalConfig({ ...asStripe, features: { ...ours.features, subscription_cancel: { enabled: true } } }).join(), /cancellation/);
  assert.match(checkPortalConfig({ ...asStripe, features: { ...ours.features, subscription_update: { enabled: true } } }).join(), /plan or quantity/);
  assert.match(checkPortalConfig({ ...asStripe, features: { ...ours.features, subscription_pause: { enabled: true } } }).join(), /pausing/);
  assert.match(checkPortalConfig({ ...asStripe, active: false }).join(), /not active/);
  assert.match(checkPortalConfig({ ...asStripe, features: { ...ours.features, payment_method_update: { enabled: false } } }).join(), /payment method/);
});

test("checkout price rules", () => {
  const base = {
    mapping: { package_id: PKG_STD, client_id: null, active: true, package_active: true, package_kind: "standard" },
    price: { active: true, type: "recurring", livemode: false, deleted_at: null, unit_amount_cents: 150000, recurring_usage_type: "licensed" },
    plan: { package_id: PKG_STD, collection: "stripe" }, clientId: A, livemode: false,
  };
  assert.equal(checkCheckoutPrice(base), null);
  assert.equal(checkCheckoutPrice({ ...base, mapping: null }).code, "price_not_approved");
  assert.equal(checkCheckoutPrice({ ...base, mapping: { ...base.mapping, client_id: B, package_kind: "custom" } }).code, "price_not_for_client");
  assert.equal(checkCheckoutPrice({ ...base, mapping: { ...base.mapping, active: false } }).code, "price_inactive");
  assert.equal(checkCheckoutPrice({ ...base, plan: { package_id: PKG_CUSTOM, collection: "stripe" } }).code, "package_mismatch");
  assert.equal(checkCheckoutPrice({ ...base, plan: { package_id: PKG_STD, collection: "external" } }).code, "agreement_external");
  assert.equal(checkCheckoutPrice({ ...base, plan: null }).code, "no_agreement");
  assert.equal(checkCheckoutPrice({ ...base, price: { ...base.price, livemode: true } }).code, "price_mode_mismatch");
  assert.equal(checkCheckoutPrice({ ...base, price: { ...base.price, active: false } }).code, "price_inactive");
  assert.equal(checkCheckoutPrice({ ...base, price: { ...base.price, type: "one_time" } }).code, "price_not_recurring");
  assert.equal(checkCheckoutPrice({ ...base, price: { ...base.price, recurring_usage_type: "metered" } }).code, "price_not_recurring");
});

// ── Authorization ───────────────────────────────────────────────────────────
test("authorization: no sign-in 401, stranger 403, member refused every admin action before Stripe is called", async () => {
  const t = setup();
  assert.equal((await t.call("", { action: "version" })).status, 401);
  assert.equal((await t.call("stranger", { action: "version" })).status, 403);
  assert.equal((await t.call("member", { action: "version" })).status, 200);
  for (const action of ["search_customers", "link_customer", "create_customer", "import_product", "create_custom_price", "create_checkout",
    "expire_checkout", "configure_portal", "record_external_payment", "void_external_payment"]) {
    const r = await t.call("member", { action, client_id: A });
    assert.equal(r.status, 403, action);
    assert.equal(r.body.error, "admin_only", action);
  }
  assert.equal((await t.call("member", { action: "create_portal_session", client_id: A })).status, 403);
  assert.deepEqual(t.s.calls, []);
  assert.equal((await t.call("admin", { action: "nope" })).status, 400);
  assert.equal((await t.call("", { action: "nope" })).status, 401, "nothing is said to a caller who is not signed in");
  assert.equal((await t.call("stranger", { action: "nope" })).status, 403);
});

test("a portal contact opens only their own client's portal; every other action is refused", async () => {
  const t = setup();
  for (const action of ["search_customers", "create_checkout", "resync_customer", "record_external_payment", "version"]) {
    assert.equal((await t.call("portalA", { action })).status, 403, action);
  }
  const other = await t.call("portalA", { action: "create_portal_session", client_id: B });
  assert.equal(other.status, 403);
  assert.deepEqual(t.s.calls, []);
});

test("mode: a live key is refused until billing is switched live; a test key is refused once it is", async () => {
  let t = setup({ key: "sk_live_unit" });
  assert.equal((await t.call("admin", { action: "search_customers", query: "alpha" })).body.error, "live_mode_not_enabled");
  t = setup({ key: "sk_test_unit", live: true });
  assert.equal((await t.call("admin", { action: "search_customers", query: "alpha" })).body.error, "key_mode_mismatch");
  assert.deepEqual(t.s.calls, []);
});

// ── 1. Linking ─────────────────────────────────────────────────────────────
test("search shows each customer's mode, subscriptions and any client it is already linked to", async () => {
  const t = setup();
  t.s.put({ id: "cus_Old", object: "customer", livemode: false, name: "Alpha Roofing LLC", email: "billing@alpha.example.test", metadata: {}, created: 1 });
  t.s.put({ id: "sub_Old", object: "subscription", customer: "cus_Old", status: "active" });
  t.store.db.links.push({ client_id: B, stripe_customer_id: "cus_Old", livemode: false, active: true });
  const r = await t.call("admin", { action: "search_customers", query: "alpha" });
  assert.equal(r.status, 200);
  assert.equal(r.body.customers.length, 1);
  const c = r.body.customers[0];
  assert.deepEqual([c.id, c.livemode, c.mode_matches, c.linked_client.id], ["cus_Old", false, true, B]);
  assert.deepEqual(c.subscriptions, [{ id: "sub_Old", status: "active" }]);
  assert.equal((await t.call("admin", { action: "search_customers", query: "billing@alpha.example.test" })).body.customers.length, 1);
  assert.equal((await t.call("admin", { action: "search_customers", query: "cus_Old" })).body.customers.length, 1);
  assert.equal((await t.call("admin", { action: "search_customers", query: "cus_Missing" })).body.customers.length, 0);
});

test("link: needs confirmation; refuses a customer linked elsewhere, a second customer, another client's metadata, the wrong mode", async () => {
  const t = setup();
  t.s.put({ id: "cus_One", object: "customer", livemode: false, name: "Alpha", metadata: {}, created: 1 });
  t.s.put({ id: "cus_Two", object: "customer", livemode: false, name: "Alpha again", metadata: {}, created: 1 });
  t.s.put({ id: "cus_Tagged", object: "customer", livemode: false, name: "Beta", metadata: { compass_client_id: B }, created: 1 });
  t.s.put({ id: "cus_Live", object: "customer", livemode: true, name: "Alpha live", metadata: {}, created: 1 });
  t.s.put({ id: "cus_Gone", object: "customer", livemode: false, deleted: true });

  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_One" })).body.error, "confirmation_required");
  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_Live", confirm: true })).body.error, "mode_mismatch");
  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_Gone", confirm: true })).body.error, "customer_deleted");
  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_Nope", confirm: true })).status, 404);
  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_Tagged", confirm: true })).body.error, "customer_claimed_by_other_client");

  const ok = await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_One", confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(t.store.db.links[0].link_source, "linked_existing");
  assert.ok(t.s.calls.includes("/v1/customers/cus_One"));
  assert.ok(t.s.calls.some((c) => c.startsWith("/v1/subscriptions?customer=cus_One")), "imported through the shared resync");
  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_One", confirm: true })).body.already_linked, true);
  assert.equal((await t.call("admin", { action: "link_customer", client_id: B, customer_id: "cus_One", confirm: true })).body.error, "customer_linked_elsewhere");
  assert.equal((await t.call("admin", { action: "link_customer", client_id: A, customer_id: "cus_Two", confirm: true })).body.error, "client_already_linked");
  assert.equal(t.store.db.audits.filter((a) => a.action === "link_customer").length, 1);
  assert.equal(t.s.all("customer").filter((c) => c.metadata?.compass_client_id).length, 1, "linking never writes to Stripe");
});

// ── 2. Creating ────────────────────────────────────────────────────────────
test("create customer: metadata carries the client; a double click, a retry and a second request create one customer", async () => {
  const t = setup();
  const [a, b] = await Promise.all([createCustomer(t), createCustomer(t)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual([a.body.created, b.body.created].sort(), [false, true]);
  const customers = t.s.all("customer");
  assert.equal(customers.length, 1, "one Stripe customer");
  assert.equal(customers[0].metadata.compass_client_id, A);
  assert.equal(t.store.db.links.filter((l) => l.client_id === A).length, 1);
  assert.equal(t.store.db.links[0].link_source, "created");
  const again = await createCustomer(t);
  assert.equal(again.body.error, "client_already_linked");
  assert.equal(t.s.all("customer").length, 1);
});

test("create customer: a customer Compass created earlier but never linked is found and not duplicated", async () => {
  const t = setup();
  t.s.put({ id: "cus_Orphan", object: "customer", livemode: false, name: "Alpha Roofing", metadata: { compass_client_id: A }, created: 1 });
  const r = await createCustomer(t);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "existing_customer_found");
  assert.equal(r.body.customers[0].id, "cus_Orphan");
  assert.equal(t.s.all("customer").length, 1);
});

test("create customer: the link step failing leaves nothing duplicated on retry (same idempotency key)", async () => {
  const t = setup({ searchLag: true });
  const link = t.store.linkCustomer;
  t.store.linkCustomer = async () => { throw new Error("database unavailable"); };
  assert.equal((await createCustomer(t)).status, 500);
  t.store.linkCustomer = link;
  // Stripe search has not caught up; the idempotency key returns the same customer.
  const r = await createCustomer(t);
  assert.equal(r.status, 200);
  assert.equal(t.s.all("customer").length, 1);
  assert.equal(t.store.db.links[0].stripe_customer_id, t.s.all("customer")[0].id);
});

// ── 3/5. Catalog and Checkout ──────────────────────────────────────────────
test("import product: mirrors the product and its prices, refuses one already mapped elsewhere and the wrong mode", async () => {
  const t = setup();
  await withCatalog(t);
  assert.equal(t.store.db.packages.get(PKG_STD).stripe_product_id, "prod_Growth");
  assert.ok(t.store.db.prices.has("price_GrowthM"));
  assert.equal((await t.call("admin", { action: "import_product", target: "package", target_id: PKG_CUSTOM, product_id: "prod_Growth" })).body.error, "product_mapped_elsewhere");
  t.s.put({ id: "prod_Live", object: "product", livemode: true, name: "Live", active: true, metadata: {}, created: 1 });
  assert.equal((await t.call("admin", { action: "import_product", target: "package", target_id: PKG_STD, product_id: "prod_Live" })).body.error, "mode_mismatch");
});

test("standard package Checkout: approved price only, card + ACH, metadata names the client, recorded once", async () => {
  const t = setup();
  await withCatalog(t);
  await createCustomer(t);
  const req = { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(1) };
  const r = await t.call("admin", req);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.equal(r.body.ach_offered, true);
  const cs = t.s.all("checkout.session")[0];
  assert.equal(cs.mode, "subscription");
  assert.deepEqual(cs.payment_method_types, ["card", "us_bank_account"]);
  assert.equal(cs.client_reference_id, A);
  assert.equal(cs.metadata.compass_client_id, A);
  assert.equal(cs.subscription_data.metadata.compass_client_id, A);
  assert.deepEqual(cs.line_items_requested, [{ price: "price_GrowthM", quantity: 1 }]);
  assert.equal(cs.success_url, "https://crm.example.test/checkout/complete");
  assert.equal(cs.customer, t.store.db.links[0].stripe_customer_id);
  // The same request again (double click): the same session, nothing new.
  const again = await t.call("admin", req);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(t.s.all("checkout.session").length, 1);
  // A different request while that link is open: refused, with the open link.
  const other = await t.call("admin", { ...req, request_id: rid(2) });
  assert.equal(other.body.error, "checkout_open");
  assert.equal(other.body.checkout.session_id, cs.id);
  assert.equal(t.s.all("checkout.session").length, 1);
});

test("Checkout ignores anything the browser sends about price, amount or customer", async () => {
  const t = setup();
  await withCatalog(t);
  await createCustomer(t);
  t.s.put({ id: "price_Cheap", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
    unit_amount: 100, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
  const r = await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(3),
    price: "price_Cheap", stripe_price_id: "price_Cheap", amount_cents: 100, customer: "cus_Someone", line_items: [{ price: "price_Cheap" }] });
  assert.equal(r.status, 200);
  const cs = t.s.all("checkout.session")[0];
  assert.deepEqual(cs.line_items_requested, [{ price: "price_GrowthM", quantity: 1 }]);
  assert.notEqual(cs.customer, "cus_Someone");
  // A Stripe price id in place of the approved mapping id is not a mapping.
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: "price_Cheap", request_id: rid(4) })).status, 400);
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: rid(99), request_id: rid(4) })).body.error, "price_not_approved");
});

test("Checkout refuses a package other than the agreement, a price archived in Stripe, and no customer", async () => {
  const t = setup();
  await withCatalog(t);
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(5) })).body.error, "no_customer");
  await createCustomer(t);
  t.store.db.plans.set(A, { package_id: PKG_CUSTOM, collection: "stripe" });
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(5) })).body.error, "package_mismatch");
  t.store.db.plans.set(A, { package_id: PKG_STD, collection: "stripe" });
  t.s.patch("price_GrowthM", { active: false });
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(5) })).body.error, "price_inactive");
  assert.equal(t.s.all("checkout.session").length, 0);
});

test("duplicate subscription: Checkout is refused while the customer has a billing subscription in Stripe", async () => {
  const t = setup();
  await withCatalog(t);
  await createCustomer(t);
  const cus = t.store.db.links[0].stripe_customer_id;
  for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
    t.s.put({ id: "sub_Dup", object: "subscription", livemode: false, customer: cus, status, collection_method: "charge_automatically",
      currency: "usd", items: { object: "list", data: [] }, metadata: {}, created: 1 });
    const r = await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(6) });
    assert.equal(r.status, 409, status);
    assert.equal(r.body.error, "subscription_exists", status);
    assert.deepEqual(r.body.subscriptions, [{ id: "sub_Dup", status }]);
  }
  // A canceled or expired one does not block a new sale.
  t.s.patch("sub_Dup", { status: "canceled" });
  t.store.db.subs.get("sub_Dup").status = "canceled";
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(6) })).status, 200);
  assert.equal(t.s.all("checkout.session").length, 1);
});

test("ACH is offered where the account can take it and dropped (card only) where it cannot", async () => {
  const t = setup({ achAvailable: false });
  await withCatalog(t);
  await createCustomer(t);
  const r = await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(7) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ach_offered, false);
  assert.deepEqual(t.s.all("checkout.session")[0].payment_method_types, ["card"]);
});

test("expire: an open link is expired in Stripe and the record follows; another client's link is not found", async () => {
  const t = setup();
  await withCatalog(t);
  await createCustomer(t);
  const r = await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(8) });
  const id = r.body.checkout.session_id;
  assert.equal((await t.call("admin", { action: "expire_checkout", client_id: B, session_id: id })).status, 404);
  const x = await t.call("admin", { action: "expire_checkout", client_id: A, session_id: id });
  assert.equal(x.status, 200);
  assert.equal(t.s.get(id).status, "expired");
  assert.equal(t.store.db.checkouts.get(id).status, "expired");
  // Expired: a new link may be made.
  assert.equal((await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: PP_STD, request_id: rid(9) })).body.created, true);
});

test("Custom Retainer: an admin creates the client's price once per request; Checkout sells it to that client only", async () => {
  const t = setup();
  await withCatalog(t);
  const req = { action: "create_custom_price", client_id: B, package_id: PKG_CUSTOM, amount_cents: 275000, currency: "USD", interval: "month", request_id: rid(10) };
  assert.equal((await t.call("admin", { ...req, amount_cents: 2750.5 })).status, 400);
  assert.equal((await t.call("admin", { ...req, amount_cents: -1 })).status, 400);
  assert.equal((await t.call("admin", { ...req, package_id: PKG_STD })).body.error, "package_not_custom");
  const r = await t.call("admin", req);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await t.call("admin", req);
  assert.equal(again.body.created, false);
  assert.equal(again.body.price_id, r.body.price_id);
  const prices = t.s.all("price").filter((p) => p.product === "prod_Custom");
  assert.equal(prices.length, 1);
  assert.deepEqual([prices[0].unit_amount, prices[0].currency, prices[0].recurring.interval, prices[0].metadata.compass_client_id], [275000, "usd", "month", B]);
  const mapping = t.store.db.packagePrices.get(r.body.package_price_id);
  assert.deepEqual([mapping.client_id, mapping.package_kind], [B, "custom"]);

  await createCustomer(t, B);
  const sold = await t.call("admin", { action: "create_checkout", client_id: B, package_price_id: r.body.package_price_id, request_id: rid(11) });
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  // Client A cannot be sold B's price.
  await createCustomer(t, A);
  t.store.db.plans.set(A, { package_id: PKG_CUSTOM, collection: "stripe" });
  const stolen = await t.call("admin", { action: "create_checkout", client_id: A, package_price_id: r.body.package_price_id, request_id: rid(12) });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.body.error, "price_not_for_client");
});

// ── 7. Customer Portal ─────────────────────────────────────────────────────
test("portal: configured conservatively once; sessions for the client's own customer; a widened configuration is refused", async () => {
  const t = setup();
  await createCustomer(t);
  assert.equal((await t.call("admin", { action: "create_portal_session", client_id: A })).body.error, "portal_not_configured");
  const c = await t.call("admin", { action: "configure_portal" });
  assert.equal(c.status, 200);
  assert.equal((await t.call("admin", { action: "configure_portal" })).body.created, false);
  assert.equal(t.s.all("billing_portal.configuration").length, 1);
  const conf = t.s.all("billing_portal.configuration")[0];
  assert.deepEqual([conf.features.subscription_cancel.enabled, conf.features.subscription_update.enabled, conf.features.payment_method_update.enabled], [false, false, true]);

  const mine = await t.call("portalA", { action: "create_portal_session" });
  assert.equal(mine.status, 200);
  const session = t.s.all("billing_portal.session")[0];
  assert.equal(session.customer, t.store.db.links[0].stripe_customer_id);
  assert.equal(session.return_url, "https://crm.example.test/portal");
  const team = await t.call("admin", { action: "create_portal_session", client_id: A });
  assert.equal(team.status, 200);
  assert.equal(t.s.all("billing_portal.session").find((x) => x.return_url.endsWith("/billing")).return_url, `https://crm.example.test/clients/${A}/billing`);
  // B has no customer: nothing to open.
  assert.equal((await t.call("admin", { action: "create_portal_session", client_id: B })).body.error, "no_billing_account");
  // Someone enables cancellation in the dashboard: no more sessions.
  t.s.patch(conf.id, { features: { ...conf.features, subscription_cancel: { enabled: true } } });
  assert.equal((await t.call("portalA", { action: "create_portal_session" })).body.error, "portal_config_unsafe");
  const audits = t.store.db.audits.filter((a) => a.action === "portal_session");
  assert.deepEqual(audits.map((a) => a.actor_kind), ["portal", "team"]);
});

// ── 8. External payments ───────────────────────────────────────────────────
test("external payments: admin only, validated, idempotent per request, voided (never edited) with a reason", async () => {
  const t = setup();
  const req = { action: "record_external_payment", client_id: A, amount_cents: 120000, currency: "usd", method: "check",
    paid_at: "2026-09-20", reference: "Check 1042", notes: "Mailed check for September", request_id: rid(20) };
  assert.equal((await t.call("admin", { ...req, notes: " " })).status, 400);
  assert.equal((await t.call("admin", { ...req, method: "cash" })).status, 400);
  assert.equal((await t.call("admin", { ...req, amount_cents: 0 })).status, 400);
  assert.equal((await t.call("admin", { ...req, paid_at: "2099-01-01" })).status, 400);
  const r = await t.call("admin", req);
  assert.equal(r.status, 200);
  assert.equal((await t.call("admin", req)).body.created, false);
  assert.equal(t.store.db.payments.size, 1);
  assert.equal((await t.call("admin", { action: "void_external_payment", client_id: A, payment_id: r.body.payment_id })).status, 400);
  assert.equal((await t.call("admin", { action: "void_external_payment", client_id: B, payment_id: r.body.payment_id, reason: "wrong client" })).status, 404);
  assert.equal((await t.call("admin", { action: "void_external_payment", client_id: A, payment_id: r.body.payment_id, reason: "Check bounced" })).status, 200);
  assert.equal((await t.call("admin", { action: "void_external_payment", client_id: A, payment_id: r.body.payment_id, reason: "again" })).status, 404);
  assert.deepEqual(t.store.db.audits.map((a) => a.action), ["record_external_payment", "void_external_payment"]);
  assert.deepEqual(t.s.calls, [], "external payments never touch Stripe");
});
