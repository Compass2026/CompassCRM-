import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverVerificationEmail } from "../src/lib/agreement-verification-email.ts";
import { agreementEventDisplay } from "../src/lib/agreement-history.ts";

const email = { from: "Compass <agreements@send.example.com>", to: "delivered@example.com", issuer: "Compass", code: "123456" };
test("provider acceptance records its identifier without secrets or code", async () => {
  const records = [];
  const result = await deliverVerificationEmail(email, "test-only-key", async r => records.push(r), async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(JSON.parse(init.body).from, email.from);
    return Response.json({ id: "test-message-id" });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(records, [{ outcome: "accepted", provider_id: "test-message-id", http_status: 200 }]);
});
test("sender rejection is recorded and never claims code was sent", async () => {
  const records = [];
  await assert.rejects(deliverVerificationEmail(email, "test-only-key", async r => records.push(r), async () =>
    Response.json({ message: "This API key is not authorized" }, { status: 403 })), /sender configuration problem/);
  assert.deepEqual(records, [{ outcome: "failed", http_status: 403, failure_code: "sender_not_authorized" }]);
  assert.equal(agreementEventDisplay({ kind: "verification_email_failed", detail: records[0] }).warning, true);
});
test("timeouts and invalid acceptance responses are unknown, without automatic retries", async () => {
  for (const response of [() => { throw new Error("timeout with sensitive details"); }, () => Response.json({}), () => new Response("bad gateway", {status: 502})]) {
    let calls = 0;
    const records = [];
    await assert.rejects(deliverVerificationEmail(email, "key", async r => records.push(r), async () => { calls++; return response(); }), /could not be confirmed/);
    assert.equal(calls, 1);
    assert.equal(records[0].outcome, "unknown");
    assert.doesNotMatch(JSON.stringify(records), /sensitive|123456|key/);
  }
});
test("an audit failure after acceptance does not resend or record a false sending failure", async () => {
  let calls = 0;
  let audits = 0;
  await assert.rejects(deliverVerificationEmail(email, "key", async () => { audits++; throw new Error("database unavailable"); }, async () => {
    calls++; return Response.json({id: "test-message-id"});
  }), /status could not be saved/);
  assert.equal(calls, 1);
  assert.equal(audits, 1);
});
test("history distinguishes requests, provider acceptance and inbox delivery", () => {
  assert.match(agreementEventDisplay({kind: "verification_requested", detail:{}}).detail, /does not confirm/);
  assert.match(agreementEventDisplay({kind: "verification_email_accepted", detail:{}}).detail, /not yet confirmed/);
});
