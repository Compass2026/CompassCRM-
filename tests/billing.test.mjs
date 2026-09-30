// Billing read-model helpers (src/lib/billing.ts, 0057): money in integer
// minor units, the agreement and override rules (the same rules as plans' and
// client_entitlement_overrides' constraints; sandbox: billing_foundation.test.sql),
// entitlement text and the derived billing states.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionLabel, billingState, billingStateLabels, entitlementText, formatMoney, minorUnits,
  parseMoneyToCents, stripeDashboardUrl, validateAgreement, validateOverride,
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
