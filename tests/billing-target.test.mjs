// Where the CRM sends billing calls (Option B, docs/billing-runtime.md):
// BILLING_API_URL set → the compass-billing project; unset → the Supabase Edge
// Functions (the TEST setup before cutover, and the rollback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { billingTarget } from "../src/lib/stripe-billing-call.ts";

const SUPA = { NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" };

test("unset: the Edge Functions, with the project's anon key", () => {
  assert.deepEqual(billingTarget("stripe-billing", SUPA), { url: "https://ref.supabase.co/functions/v1/stripe-billing", headers: { apikey: "anon" } });
  assert.deepEqual(billingTarget("stripe-reconcile", { ...SUPA, BILLING_API_URL: "  " }), { url: "https://ref.supabase.co/functions/v1/stripe-reconcile", headers: { apikey: "anon" } });
});

test("set: the billing project's endpoints, and no Supabase key goes with the call", () => {
  const env = { ...SUPA, BILLING_API_URL: "https://compass-billing.vercel.app/" };
  assert.deepEqual(billingTarget("stripe-billing", env), { url: "https://compass-billing.vercel.app/api/billing", headers: {} });
  assert.deepEqual(billingTarget("stripe-reconcile", env), { url: "https://compass-billing.vercel.app/api/reconcile", headers: {} });
  assert.equal(billingTarget("stripe-billing", { BILLING_API_URL: "http://localhost:3100" }).url, "http://localhost:3100/api/billing");
});

test("a malformed value is refused rather than silently falling back", () => {
  for (const v of ["http://compass-billing.vercel.app", "https://x.vercel.app/api", "compass-billing.vercel.app", "https://a b"]) {
    assert.ok("error" in billingTarget("stripe-billing", { ...SUPA, BILLING_API_URL: v }), v);
  }
});
