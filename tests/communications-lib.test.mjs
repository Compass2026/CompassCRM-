// src/lib/communications.ts: the pure rules the app and the functions share.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSendTo,
  formatPhone,
  isUsTollFree,
  mapCustomerProfileStatus,
  mapTollFreeStatus,
  messageStatusRank,
  normalizeUsPhone,
  optOutKeyword,
  pipelineStatus,
  refusalText,
} from "../src/lib/communications.ts";

test("US phone entry → E.164", () => {
  assert.equal(normalizeUsPhone("573-822-6448"), "+15738226448");
  assert.equal(normalizeUsPhone("(573) 822-6448"), "+15738226448");
  assert.equal(normalizeUsPhone("1 573 822 6448"), "+15738226448");
  assert.equal(normalizeUsPhone("+1 (800) 555-0100"), "+18005550100");
  assert.equal(normalizeUsPhone("822-6448"), null);
  assert.equal(normalizeUsPhone("073-822-6448"), null);
  assert.equal(normalizeUsPhone(""), null);
  assert.equal(formatPhone("+18005550100"), "(800) 555-0100");
});

test("toll-free prefixes", () => {
  assert.ok(isUsTollFree("+18005550100"));
  assert.ok(isUsTollFree("+18885550100"));
  assert.ok(!isUsTollFree("+15738226448"));
});

test("opt-out keywords are whole-message only", () => {
  assert.equal(optOutKeyword("STOP"), "STOP");
  assert.equal(optOutKeyword(" stop. "), "STOP");
  assert.equal(optOutKeyword("Unsubscribe"), "STOP");
  assert.equal(optOutKeyword("start"), "START");
  assert.equal(optOutKeyword("help"), "HELP");
  assert.equal(optOutKeyword("please stop texting"), null);
  assert.equal(optOutKeyword("Can you help with CPR?"), null);
});

test("message status order mirrors the database", () => {
  assert.ok(messageStatusRank("pending") < messageStatusRank("queued"));
  assert.ok(messageStatusRank("sent") < messageStatusRank("delivered"));
  assert.equal(messageStatusRank("delivered"), messageStatusRank("undelivered"));
  assert.equal(messageStatusRank("nope"), -1);
});

test("Twilio's registration statuses map one-to-one", () => {
  assert.equal(mapTollFreeStatus("PENDING_REVIEW"), "pending_review");
  assert.equal(mapTollFreeStatus("IN_REVIEW"), "in_review");
  assert.equal(mapTollFreeStatus("TWILIO_APPROVED"), "approved");
  assert.equal(mapTollFreeStatus("TWILIO_REJECTED"), "rejected");
  assert.equal(mapCustomerProfileStatus("pending-review"), "pending_review");
  assert.equal(mapCustomerProfileStatus("twilio-approved"), "approved");
  assert.equal(mapCustomerProfileStatus("draft"), "draft");
});

const reg = (o) => ({ profile_type: "toll_free_verification", status: "draft", provider_profile_sid: null, restriction: null, communication_number_id: null, ...o });
const num = { id: "n1", is_primary: true, status: "active", sms_enabled: true };

test("the client's pipeline status", () => {
  assert.equal(pipelineStatus({ hasAccount: false, registrations: [], numbers: [] }), "not_configured");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ profile_type: "secondary_customer_profile" })], numbers: [] }), "profile_pending");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ profile_type: "secondary_customer_profile", provider_profile_sid: "BU1", status: "approved" })], numbers: [] }), "profile_approved");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [], numbers: [num] }), "number_purchased");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ communication_number_id: "n1" })], numbers: [num] }), "number_purchased", "a draft TFV is not submitted");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ communication_number_id: "n1", provider_profile_sid: "HH1", status: "pending_review" })], numbers: [num] }), "verification_pending");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ communication_number_id: "n1", provider_profile_sid: "HH1", status: "in_review" })], numbers: [num] }), "verification_in_review");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ communication_number_id: "n1", provider_profile_sid: "HH1", status: "approved" })], numbers: [num] }), "approved");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ communication_number_id: "n1", provider_profile_sid: "HH1", status: "rejected" })], numbers: [num] }), "rejected");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ communication_number_id: "n1", provider_profile_sid: "HH1", status: "approved", restriction: "restricted" })], numbers: [num] }), "restricted");
  assert.equal(pipelineStatus({ hasAccount: true, registrations: [reg({ restriction: "blocked" }), reg({ restriction: "restricted" })], numbers: [num] }), "blocked");
});

test("composer gate and refusal text", () => {
  assert.deepEqual(canSendTo("granted", false), { ok: true });
  assert.equal(canSendTo("granted", true).ok, false);
  assert.equal(canSendTo(null, false).ok, false);
  assert.match(refusalText("opted_out: +15735550101 opted out"), /STOP/);
  assert.equal(refusalText("weird: something"), "something");
});
