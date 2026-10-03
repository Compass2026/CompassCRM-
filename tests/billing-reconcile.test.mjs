// Reconciliation display rules (B4): what the Billing screens say a run found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changesText, resultText, runLooksStuck, warningText, webhookText } from "../src/lib/billing-reconcile.ts";

test("result: not yet, no differences, repaired N records, needs attention, failed", () => {
  assert.equal(resultText(null), "Not reconciled yet");
  assert.equal(resultText({ status: "healthy", records_changed: 0 }), "No differences");
  assert.equal(resultText({ status: "repaired", records_changed: 3 }), "Repaired 3 billing records");
  assert.equal(resultText({ status: "repaired", records_changed: 1 }), "Repaired 1 billing record");
  assert.equal(resultText({ status: "attention", records_changed: 2 }), "Repaired 2 billing records · needs attention");
  assert.equal(resultText({ status: "attention", records_changed: 0 }), "No differences · needs attention");
  assert.equal(resultText({ status: "failed", records_changed: 0, error: "Stripe 500" }), "Failed: Stripe 500");
});

test("changes and warnings in words", () => {
  assert.equal(changesText({ invoice_imported: 2, refund_imported: 1, subscription_updated: 0 }), "2 invoices imported, 1 refund imported");
  assert.equal(changesText(null), "");
  assert.equal(warningText("customer_deleted_in_stripe"), "The Stripe customer was deleted in Stripe");
  assert.equal(warningText("checkout_missing:cs_test_1"), "Stripe no longer has payment link cs_test_1");
  assert.equal(warningText("something_new"), "something new");
});

test("webhook health and a stuck run", () => {
  assert.deepEqual(webhookText({ failed_events: 0, stuck_events: 0, last_event_at: "2026-09-30T00:00:00Z" }), { ok: true, text: "Healthy" });
  assert.deepEqual(webhookText({ failed_events: 0, stuck_events: 0, last_event_at: null }), { ok: true, text: "No events received yet" });
  assert.equal(webhookText({ failed_events: 2, stuck_events: 1, last_event_at: "x" }).text, "2 failed events, 1 stuck event — the next reconciliation retries them");
  const now = new Date("2026-09-30T08:00:00Z");
  assert.equal(runLooksStuck({ status: "running", started_at: "2026-09-30T07:00:00Z" }, now), true);
  assert.equal(runLooksStuck({ status: "running", started_at: "2026-09-30T07:50:00Z" }, now), false);
  assert.equal(runLooksStuck({ status: "completed", started_at: "2026-09-30T07:00:00Z" }, now), false);
});
