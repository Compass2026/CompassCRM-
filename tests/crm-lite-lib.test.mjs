// CRM Lite's pure rules (src/lib/inquiries.ts): status moves, search safety,
// call / email links and the alert gates shown on the setup page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertGates, mailtoHref, refusalText, searchFilter, searchTerm, statusActions, telHref } from "../src/lib/inquiries.ts";

test("status moves: new → contacted / closed, contacted → closed (or back), closed → reopen", () => {
  assert.deepEqual(statusActions("new").map((a) => a.to), ["contacted", "closed"]);
  assert.deepEqual(statusActions("contacted").map((a) => a.to), ["closed", "new"]);
  assert.deepEqual(statusActions("closed"), [{ to: "new", label: "Reopen", primary: true }]);
});

test("search terms cannot change the PostgREST filter (commas, parentheses, stars, quotes are dropped)", () => {
  assert.equal(searchTerm("pat,status.eq.closed)"), "pat status.eq.closed");
  assert.equal(searchTerm("o'brien*"), "obrien");
  assert.equal(searchFilter(""), null);
  const f = searchFilter("(618) 791-9113");
  assert.ok(f.includes("phone_e164.ilike.*6187919113*"));
  assert.ok(!/[()]/.test(f.replace(/ilike/g, "")));
  assert.equal(searchFilter("pat@example.test"), "name.ilike.*pat@example.test*,email.ilike.*pat@example.test*,phone.ilike.*pat@example.test*");
});

test("click-to-call and email links", () => {
  assert.equal(telHref("+16185550142"), "tel:+16185550142");
  assert.equal(telHref(null, "618-555-0142"), "tel:6185550142");
  assert.equal(telHref(null, "n/a"), null);
  assert.equal(mailtoHref("pat@example.test", "Example Interiors"), "mailto:pat@example.test?subject=Your%20inquiry%20with%20Example%20Interiors");
  assert.equal(mailtoHref(null, "x"), null);
});

test("database refusals read as plain words", () => {
  assert.match(refusalText("changed: this inquiry is now closed; reload and try again"), /Someone else just changed/);
  assert.match(refusalText("incomplete: the recipient's actual response is required"), /actual response is required/);
  assert.match(refusalText("something odd"), /didn't work/);
});

test("alert gates: each go-live condition separately; none open without consent and a confirmed test", () => {
  const base = { settingsEnabled: true, smsAlertsEnabled: false, sender: { verification_status: "pending_review", enabled: false },
    senderCredentialsPresent: false, recipients: [{ consent_status: "pending", enabled: true, delivery_test_confirmed_at: null }] };
  assert.deepEqual(alertGates(base).map((g) => g.ok), [false, false, false, false]);
  const ready = { ...base, sender: { verification_status: "approved", enabled: true }, senderCredentialsPresent: true,
    recipients: [{ consent_status: "granted", enabled: true, delivery_test_confirmed_at: "2026-10-20T00:00:00Z" }] };
  assert.deepEqual(alertGates(ready).map((g) => g.ok), [true, true, true, true]);
  assert.equal(alertGates({ ...ready, recipients: [{ consent_status: "granted", enabled: true, delivery_test_confirmed_at: null }] })[3].ok, false);
});
