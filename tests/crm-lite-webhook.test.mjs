// twilio-webhook's CRM Lite routes (Compass's alert sender) with the official
// Twilio SDK's validator and an in-memory store. STOP / START / HELP and the
// alerts' delivery status; the database rules (opt-out across clients,
// forward-only status, the account owning the job) are crm_lite.test.sql's.
// Fictional SIDs and numbers; nothing is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import webhooks from "twilio/lib/webhooks/webhooks.js";
import { createTwilioWebhook } from "../supabase/functions/twilio-webhook/handler.ts";

const BASE = "https://example-ref.supabase.co/functions/v1/twilio-webhook";
const CLIENT_ACCT = "AC" + "a".repeat(32);
const SENDER_ACCT = "AC" + "c".repeat(32);
const TOKENS = { [CLIENT_ACCT]: "client-token-not-real", [SENDER_ACCT]: "sender-token-not-real" };
const SENDER = "+18885550199";
const OWNER = "+16185550100";
const sid = (n) => "SM" + String(n).padStart(32, "0");

function setup() {
  const s = { keywords: new Map(), statuses: [], clientInbound: 0 };
  const store = {
    async authToken(a) { return TOKENS[a] ?? null; },
    async accountKnown(a) { return a === CLIENT_ACCT; },
    async notificationSenderKnown(a) { return a === SENDER_ACCT; },
    async recordInbound() { s.clientInbound++; return { duplicate: false }; },
    async recordStatus() { return { result: "updated" }; },
    async recordNotificationKeyword(p) {
      if (p.to !== SENDER) throw new Error(`unknown_number: ${p.to} is not a Compass alert sender of that account`);
      if (s.keywords.has(p.message_sid)) return { duplicate: true };
      s.keywords.set(p.message_sid, p);
      return { duplicate: false, keyword: p.keyword };
    },
    async recordNotificationStatus(p) {
      if (p.account_sid !== SENDER_ACCT) throw new Error("forbidden: that account did not send this alert");
      s.statuses.push(p);
      return { job_id: p.job_id };
    },
  };
  const logs = [];
  const fn = createTwilioWebhook({
    store, validate: (t, sig, url, params) => webhooks.validateRequest(t, sig, url, params), publicBase: async () => BASE,
    log: (event, detail) => logs.push({ event, ...detail }),
  });
  return { fn, s, logs };
}

function signed(route, params, { acct = SENDER_ACCT, query = "", token } = {}) {
  const url = `${BASE}${route}${query}`;
  const sig = webhooks.getExpectedTwilioSignature(token ?? TOKENS[acct], url, params);
  return new Request(`http://edge.local/twilio-webhook${route}${query}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params).toString(),
  });
}
const inbound = (body, o = {}) => ({ MessageSid: sid(1), AccountSid: SENDER_ACCT, From: OWNER, To: SENDER, Body: body, ...o });

test("crm-lite webhook: STOP to the alert sender is recorded once and answered with empty TwiML (Twilio replies)", async () => {
  const { fn, s } = setup();
  const res = await fn.handle(signed("/notifications/inbound", inbound("stop")));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Response><\/Response>/);
  assert.equal(s.keywords.get(sid(1)).keyword, "STOP");
  const again = await fn.handle(signed("/notifications/inbound", inbound("stop")));
  assert.equal(again.status, 200);
  assert.equal(s.keywords.size, 1);
});

test("crm-lite webhook: Twilio's OptOutType wins; HELP and START are recorded; other text is not stored", async () => {
  const { fn, s, logs } = setup();
  await fn.handle(signed("/notifications/inbound", inbound("please stop texting", { MessageSid: sid(2), OptOutType: "STOP" })));
  await fn.handle(signed("/notifications/inbound", inbound("HELP", { MessageSid: sid(3) })));
  await fn.handle(signed("/notifications/inbound", inbound("start", { MessageSid: sid(4) })));
  await fn.handle(signed("/notifications/inbound", inbound("Thanks, got it — the Smith inquiry", { MessageSid: sid(5) })));
  assert.deepEqual([...s.keywords.values()].map((k) => k.keyword), ["STOP", "HELP", "START"]);
  assert.ok(!JSON.stringify(logs).includes("Smith"));
});

test("crm-lite webhook: an alert sender's inbound posted to the client route is still handled as the sender's", async () => {
  const { fn, s } = setup();
  const res = await fn.handle(signed("/messages/inbound", inbound("STOP", { MessageSid: sid(6) })));
  assert.equal(res.status, 200);
  assert.equal(s.keywords.get(sid(6)).keyword, "STOP");
  assert.equal(s.clientInbound, 0);
});

test("crm-lite webhook: signatures are checked with the sender's own token; other accounts are refused", async () => {
  const { fn, s } = setup();
  assert.equal((await fn.handle(signed("/notifications/inbound", inbound("STOP"), { token: TOKENS[CLIENT_ACCT] }))).status, 403);
  const stranger = "AC" + "d".repeat(32);
  assert.equal((await fn.handle(signed("/notifications/inbound", inbound("STOP", { AccountSid: stranger }), { token: "x" }))).status, 403);
  // A client's subaccount cannot post to the alert routes.
  assert.equal((await fn.handle(signed("/notifications/inbound", inbound("STOP", { AccountSid: CLIENT_ACCT }), { acct: CLIENT_ACCT }))).status, 403);
  assert.equal(s.keywords.size, 0);
});

test("crm-lite webhook: a STOP to a number that is not the sender's is a 404 (visible in Twilio's debugger)", async () => {
  const { fn } = setup();
  assert.equal((await fn.handle(signed("/notifications/inbound", inbound("STOP", { To: "+18885550000" })))).status, 404);
});

test("crm-lite webhook: delivery status for an alert carries the job id from the callback URL", async () => {
  const { fn, s } = setup();
  const res = await fn.handle(signed("/notifications/status", { MessageSid: sid(9), AccountSid: SENDER_ACCT, MessageStatus: "delivered" },
    { query: "?j=job-1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(s.statuses[0], { job_id: "job-1", message_sid: sid(9), account_sid: SENDER_ACCT, status: "delivered", error_code: null, error_message: null });
});
