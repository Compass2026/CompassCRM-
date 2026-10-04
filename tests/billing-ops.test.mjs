// Billing operations helpers (B3): form readers, the words for the
// stripe-billing function's answers, and small display rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billingAnswerText, intervalText, linkIsOpen, readCustomPrice, readEntitlement, readExternalPayment, readOneTimeItem, readPackage,
} from "../src/lib/billing-ops.ts";

const RID = "00000000-0000-4000-f000-000000000001";

test("answers: the function's own detail wins; Stripe errors say so; no answer warns the action may have gone through", () => {
  assert.equal(billingAnswerText({ status: 409, body: { error: "subscription_exists", detail: "Already subscribed." } }), "Already subscribed.");
  assert.equal(billingAnswerText({ status: 403, body: { error: "admin_only" } }), "Only an admin can do that.");
  assert.match(billingAnswerText({ status: 502, body: { error: "stripe_error", detail: "No such price" } }), /^Stripe refused the request: No such price/);
  assert.match(billingAnswerText({ status: null, body: null }), /may have gone through/);
  assert.equal(billingAnswerText({ status: 500, body: null }), "The billing function answered 500.");
});

test("external payment: exact cents, a method, a real past date, a note and the form's request id", () => {
  const ok = readExternalPayment({ amount: "1,500.10", currency: "USD", method: "check", paid_at: "2026-09-20", reference: " 1042 ", notes: " September ", request_id: RID },
    new Date("2026-09-29T00:00:00Z"));
  assert.deepEqual(ok, { body: { amount_cents: 150010, currency: "usd", method: "check", paid_at: "2026-09-20", reference: "1042", notes: "September", request_id: RID } });
  const base = { amount: "10", currency: "usd", method: "wire", paid_at: "2026-09-20", reference: null, notes: "x", request_id: RID };
  assert.match(readExternalPayment({ ...base, amount: "0" }).error, /amount/);
  assert.match(readExternalPayment({ ...base, amount: "1.005" }).error, /amount/);
  assert.match(readExternalPayment({ ...base, method: "cash" }).error, /how the payment arrived/);
  assert.match(readExternalPayment({ ...base, paid_at: "2099-01-01" }, new Date("2026-09-29")).error, /future/);
  assert.match(readExternalPayment({ ...base, notes: "  " }).error, /note/);
  assert.match(readExternalPayment({ ...base, request_id: "x" }).error, /expired/);
});

test("custom price: positive exact amount, month or year only", () => {
  assert.deepEqual(readCustomPrice({ amount: "2250", interval: "month", nickname: "", request_id: RID }),
    { body: { amount_cents: 225000, currency: "usd", interval: "month", interval_count: 1, nickname: null, request_id: RID } });
  assert.match(readCustomPrice({ amount: "-5", interval: "month", nickname: null, request_id: RID }).error, /amount/);
  assert.match(readCustomPrice({ amount: "5", interval: "week", nickname: null, request_id: RID }).error, /month or per year/);
});

test("catalog readers", () => {
  assert.deepEqual(readPackage({ key: "growth_plus", name: " Growth+ ", description: "", kind: "standard", sort_order: "2" }),
    { row: { key: "growth_plus", name: "Growth+", description: null, kind: "standard", sort_order: 2 } });
  assert.match(readPackage({ key: "Growth Plus", name: "x", description: null, kind: "standard", sort_order: null }).error, /key/);
  assert.match(readPackage({ key: "growth", name: "x", description: null, kind: "bespoke", sort_order: null }).error, /standard or custom/);
  assert.match(readOneTimeItem({ key: "site", name: "Site", description: null, category: "nope" }).error, /category/);
  assert.equal(readOneTimeItem({ key: "site_build", name: "Site", description: null, category: "website_project" }).row.category, "website_project");
  assert.deepEqual(readEntitlement("feature", true, "4"), { enabled: true, quantity: null });
  assert.deepEqual(readEntitlement("quota", true, "4"), { enabled: true, quantity: 4 });
  assert.deepEqual(readEntitlement("quota", false, "4"), { enabled: false, quantity: null });
  assert.match(readEntitlement("quota", true, "").error, /quantity/);
});

test("display rules", () => {
  assert.equal(intervalText("month", 1), "month");
  assert.equal(intervalText("month", 3), "3 months");
  assert.equal(intervalText(null, null), "one time");
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(linkIsOpen({ status: "open", url: "https://checkout.stripe.com/x", expires_at: "2026-09-30T00:00:00Z" }, now), true);
  assert.equal(linkIsOpen({ status: "open", url: "https://checkout.stripe.com/x", expires_at: "2026-09-29T00:00:00Z" }, now), false);
  assert.equal(linkIsOpen({ status: "complete", url: null, expires_at: "2026-09-30T00:00:00Z" }, now), false);
});
