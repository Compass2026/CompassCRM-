// Billing read-model helpers (src/lib/billing.ts, 0058): money in integer
// minor units, the agreement and override rules (the same rules as plans' and
// client_entitlement_overrides' constraints; sandbox: billing_foundation.test.sql),
// entitlement text and the derived billing states.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agreedPriceText, agreementPriceStatus, agreementPriceStatusLabels, attentionLabel, billingState, billingStateLabels,
  bindablePrices, entitlementText, formatMoney, minorUnits, parseMoneyToCents, stripeDashboardUrl, validateAgreedPrice,
  validateAgreement, validateOverride,
} from "../src/lib/billing.ts";

const agreement = (o = {}) => ({
  package_id: null, collection: "stripe", external_method: null, external_amount: null, external_currency: null,
  external_interval: null, term_months: null, start_date: null, renewal_date: null, managed_ad_budget: null,
  notes: null, ...o,
});

test("money is parsed to integer minor units exactly", () => {
  assert.equal(parseMoneyToCents("1500"), 150000);
  assert.equal(parseMoneyToCents("$1,500.5"), 150050);
  assert.equal(parseMoneyToCents("0.1"), 10);
  assert.equal(parseMoneyToCents("19.99"), 1999); // 19.99 * 100 is 1998.9999… in floats
  assert.equal(parseMoneyToCents(""), null);
  assert.equal(parseMoneyToCents(null), null);
  assert.equal(parseMoneyToCents("-5"), "invalid");
  assert.equal(parseMoneyToCents("1.234"), "invalid");
  assert.equal(parseMoneyToCents("abc"), "invalid");
  assert.equal(parseMoneyToCents("1500", "jpy"), 1500);
  assert.equal(parseMoneyToCents("1500.5", "jpy"), "invalid");
});

test("money is formatted from minor units with the row's currency", () => {
  assert.equal(formatMoney(150000, "usd"), "$1,500.00");
  assert.equal(formatMoney(99, "usd"), "$0.99");
  assert.equal(formatMoney(1500, "jpy"), "¥1,500");
  assert.equal(formatMoney(null, "usd"), "—");
  assert.equal(formatMoney(100, null), "—");
  assert.equal(minorUnits("USD"), 2);
});

test("a Stripe-collected agreement carries no external terms", () => {
  const r = validateAgreement(agreement({ external_method: "check", external_amount: "100", term_months: "12",
    start_date: "2026-09-01", renewal_date: "2027-09-01", managed_ad_budget: "2,000" }));
  assert.ok("row" in r);
  assert.equal(r.row.collection, "stripe");
  assert.equal(r.row.external_method, null);
  assert.equal(r.row.external_amount_cents, null);
  assert.equal(r.row.term_months, 12);
  assert.equal(r.row.managed_ad_budget_cents, 200000);
});

test("an external arrangement needs its method, amount and interval", () => {
  assert.match(validateAgreement(agreement({ collection: "external" })).error, /payment method/);
  assert.match(validateAgreement(agreement({ collection: "external", external_method: "check" })).error, /amount/);
  assert.match(validateAgreement(agreement({ collection: "external", external_method: "check", external_amount: "1200" })).error, /per month or per year/);
  const r = validateAgreement(agreement({ collection: "external", external_method: "wire", external_amount: "1,200",
    external_interval: "month" }));
  assert.deepEqual([r.row.external_method, r.row.external_amount_cents, r.row.external_currency, r.row.external_interval],
    ["wire", 120000, "usd", "month"]);
  assert.match(validateAgreement(agreement({ collection: "external", external_method: "cash", external_amount: "1",
    external_interval: "month" })).error, /payment method/);
});

test("agreement dates and term are checked", () => {
  assert.match(validateAgreement(agreement({ term_months: "1.5" })).error, /whole number/);
  assert.match(validateAgreement(agreement({ start_date: "2026-09-01", renewal_date: "2026-08-01" })).error, /before/);
  assert.match(validateAgreement(agreement({ collection: "invoice" })).error, /how the client pays/);
  assert.match(validateAgreement(agreement({ managed_ad_budget: "lots" })).error, /ad budget/);
});

test("an override says why; a quota override has a whole-number quantity", () => {
  assert.match(validateOverride({ service_kind: "feature", enabled: true, quantity: null, reason: " " }).error, /why/);
  assert.deepEqual(validateOverride({ service_kind: "feature", enabled: true, quantity: "3", reason: "Added" }),
    { enabled: true, quantity: null, reason: "Added" });
  assert.deepEqual(validateOverride({ service_kind: "quota", enabled: true, quantity: "6", reason: "Two extra" }),
    { enabled: true, quantity: 6, reason: "Two extra" });
  assert.deepEqual(validateOverride({ service_kind: "quota", enabled: false, quantity: "6", reason: "Paused" }),
    { enabled: false, quantity: null, reason: "Paused" });
  assert.match(validateOverride({ service_kind: "quota", enabled: true, quantity: "", reason: "x" }).error, /quantity/);
  assert.match(validateOverride({ service_kind: "quota", enabled: true, quantity: "-1", reason: "x" }).error, /quantity/);
});

test("entitlement text", () => {
  assert.equal(entitlementText({ service_kind: "feature", enabled: true, quantity: null, unit: null, period: null }), "Included");
  assert.equal(entitlementText({ service_kind: "quota", enabled: true, quantity: 4, unit: "posts", period: "month" }), "4 posts / month");
  assert.equal(entitlementText({ service_kind: "quota", enabled: false, quantity: null, unit: "posts", period: "month" }), "Not included");
});

test("billing states and attention reasons have labels; unknown values degrade safely", () => {
  for (const s of ["none", "checkout_pending", "external", "incomplete", "trialing", "active", "past_due", "unpaid",
    "paused", "collection_paused", "canceling", "canceled"]) {
    assert.equal(billingState(s), s);
    assert.ok(billingStateLabels[s]);
  }
  assert.equal(billingState("something_new"), "none");
  assert.equal(billingState(null), "none");
  assert.match(attentionLabel("subscription_past_due"), /past due/);
  assert.equal(attentionLabel("new_reason"), "new reason");
});

test("Stripe dashboard links follow the object's mode", () => {
  assert.equal(stripeDashboardUrl("customers", "cus_1", false), "https://dashboard.stripe.com/test/customers/cus_1");
  assert.equal(stripeDashboardUrl("invoices", "in_1", true), "https://dashboard.stripe.com/invoices/in_1");
});

// ── The agreed price (plans.agreed_* + billing_package_price_id) ──────────
test("the agreed price reads as the contract: $650.00/month, $500.00/month", () => {
  assert.equal(agreedPriceText({ amount_cents: 65000, currency: "usd", interval: "month", interval_count: 1 }), "$650.00/month");
  assert.equal(agreedPriceText({ amount_cents: 50000, currency: "usd", interval: "month" }), "$500.00/month");
  assert.equal(agreedPriceText({ amount_cents: 195000, currency: "usd", interval: "month", interval_count: 3 }), "$1,950.00 every 3 months");
  assert.equal(agreedPriceText({ amount_cents: null, currency: null, interval: null }), "—");
});

test("an admin's agreed price: positive, per month or year, every 1 – 12; empty clears it", () => {
  assert.deepEqual(validateAgreedPrice({ amount: "650", interval: "month", interval_count: "1" }).row,
    { agreed_amount_cents: 65000, agreed_currency: "usd", agreed_billing_interval: "month", agreed_billing_interval_count: 1 });
  assert.deepEqual(validateAgreedPrice({ amount: "$500.00", interval: null, interval_count: null }).row.agreed_amount_cents, 50000);
  assert.deepEqual(validateAgreedPrice({ amount: "", interval: "month", interval_count: "1" }).row,
    { agreed_amount_cents: null, agreed_currency: null, agreed_billing_interval: null, agreed_billing_interval_count: null });
  assert.match(validateAgreedPrice({ amount: "0", interval: "month", interval_count: "1" }).error, /above zero/);
  assert.match(validateAgreedPrice({ amount: "abc", interval: "month", interval_count: "1" }).error, /above zero/);
  assert.match(validateAgreedPrice({ amount: "650", interval: "week", interval_count: "1" }).error, /per month or per year/);
  assert.match(validateAgreedPrice({ amount: "650", interval: "month", interval_count: "13" }).error, /1 to 12/);
});

test("an external arrangement clears any agreed Stripe price and its binding", () => {
  const r = validateAgreement(agreement({ collection: "external", external_method: "check", external_amount: "650", external_interval: "month" }));
  assert.deepEqual([r.row.agreed_amount_cents, r.row.billing_package_price_id], [null, null]);
  const s = validateAgreement(agreement({ collection: "stripe" }));
  assert.equal("agreed_amount_cents" in s.row, false, "a Stripe agreement's save leaves the admin's price alone");
});

test("only the package's prices that say exactly the agreed price can be bound", () => {
  const P = "pkg-standard", OTHER = "pkg-other", C = "client-1";
  const price = (id, cents, o = {}, sp = {}) => ({ id, package_id: P, client_id: null, active: true, is_default: false, ...o,
    stripe_prices: { active: true, livemode: false, deleted_at: null, unit_amount_cents: cents, currency: "usd",
      recurring_interval: "month", recurring_interval_count: 1, ...sp } });
  const prices = [
    price("pp650", 65000, { is_default: true }), price("pp500", 50000), price("ppYear", 65000, {}, { recurring_interval: "year" }),
    price("ppOther", 65000, { package_id: OTHER }), price("ppLive", 65000, {}, { livemode: true }),
    price("ppArchived", 65000, {}, { active: false }), price("ppRetired", 65000, { active: false }),
    price("ppReserved", 65000, { client_id: "client-2" }),
  ];
  const plan = (cents) => ({ client_id: C, package_id: P, agreed_amount_cents: cents, agreed_currency: "usd",
    agreed_billing_interval: "month", agreed_billing_interval_count: 1 });
  assert.deepEqual(bindablePrices(prices, plan(65000), false).map((p) => p.id), ["pp650"]);
  assert.deepEqual(bindablePrices(prices, plan(50000), false).map((p) => p.id), ["pp500"]);
  assert.deepEqual(bindablePrices(prices, plan(65000), true).map((p) => p.id), ["ppLive"]);
  assert.deepEqual(bindablePrices(prices, { ...plan(null), agreed_currency: null }, false), []);
});

test("the agreement price status reads as Mapped / Not mapped", () => {
  assert.equal(agreementPriceStatusLabels[agreementPriceStatus("ready")], "Mapped");
  assert.equal(agreementPriceStatusLabels[agreementPriceStatus("unmapped")], "Not mapped");
  assert.equal(agreementPriceStatus("nonsense"), "not_applicable");
  assert.match(attentionLabel("agreement_price_unmapped"), /no exact Stripe Price/);
  assert.match(attentionLabel("agreement_price_mismatch"), /differs from the agreed price/);
});
