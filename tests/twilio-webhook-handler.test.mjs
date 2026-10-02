// twilio-webhook's handler (0063) with the official Twilio SDK's validator
// (the same one index.ts uses) and an in-memory store that keeps 0063's
// idempotency and routing rules. The database itself (contact / thread /
// message in one transaction, forward-only status, consent) is covered by
// supabase/tests/sandbox/communications.test.sql and, end to end over
// PostgREST, by tests/communications-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import webhooks from "twilio/lib/webhooks/webhooks.js";
import { createTwilioWebhook } from "../supabase/functions/twilio-webhook/handler.ts";

const BASE = "https://example-ref.supabase.co/functions/v1/twilio-webhook";
const ACCT_A = "AC" + "a".repeat(32);
const ACCT_B = "AC" + "b".repeat(32);
const TOKEN_A = "token-a-not-a-real-secret";
const TOKEN_B = "token-b-not-a-real-secret";
const sid = (n) => "SM" + String(n).padStart(32, "0");

function fakeStore({ tokens = { [ACCT_A]: TOKEN_A, [ACCT_B]: TOKEN_B }, numbers = { "+18005550100": ACCT_A, "+18005550200": ACCT_B } } = {}) {
  const s = { messages: new Map(), contacts: new Map(), threads: new Map(), statuses: [], calls: 0 };
  return {
    s,
    async secret(name) {
      const m = /^TWILIO_SUB_(AC[0-9a-f]{32})_AUTH_TOKEN$/.exec(name);
      return m ? tokens[m[1]] ?? null : null;
    },
    async accountKnown(acct) { return acct in tokens; },
    async recordInbound(p) {
      s.calls++;
      if (s.messages.has(p.message_sid)) return { duplicate: true, message_id: s.messages.get(p.message_sid).id };
      if (numbers[p.to] !== p.account_sid) throw new Error(`unknown_number: ${p.to} is not an active Compass number of that account`);
      const contactKey = `${p.account_sid}|${p.from}`;
      if (!s.contacts.has(contactKey)) s.contacts.set(contactKey, { id: `contact-${s.contacts.size + 1}` });
      const threadKey = `${contactKey}|${p.to}`;
      const thread = s.threads.get(threadKey) ?? { id: `thread-${s.threads.size + 1}`, unread: 0 };
      thread.unread++;
      s.threads.set(threadKey, thread);
      const row = { id: `msg-${s.messages.size + 1}`, ...p, thread: thread.id };
      s.messages.set(p.message_sid, row);
      return { duplicate: false, message_id: row.id, conversation_id: thread.id };
    },
    async recordStatus(p) {
      s.statuses.push(p);
      if (p.status === "bogus") throw new Error("invalid: unknown message status bogus");
      return { result: "updated" };
    },
  };
}

function setup(opts) {
  const store = fakeStore(opts);
  const logs = [];
  const fn = createTwilioWebhook({
    store,
    validate: (token, signature, url, params) => webhooks.validateRequest(token, signature, url, params),
    publicBase: async () => BASE,
    log: (event, detail) => logs.push({ event, ...detail }),
  });
  return { fn, store, logs };
}

// A request exactly as Twilio would send it: form body, signature over the
// public URL (with its query string) and every parameter.
function twilioRequest(route, params, { token = TOKEN_A, query = "", signature, tamper } = {}) {
  const publicUrl = `${BASE}${route}${query}`;
  const sig = signature ?? webhooks.getExpectedTwilioSignature(token, publicUrl, params);
  const sent = tamper ? { ...params, ...tamper } : params;
  // The function sees its own path (Supabase strips /functions/v1).
  return new Request(`http://edge.local/twilio-webhook${route}${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(sent).toString(),
  });
}

const inbound = (o = {}) => ({
  MessageSid: sid(1), SmsMessageSid: sid(1), AccountSid: ACCT_A, MessagingServiceSid: "MG" + "c".repeat(32),
  From: "+15735550101", To: "+18005550100", Body: "Do you have a CPR class next week?", NumMedia: "0", NumSegments: "1",
  ApiVersion: "2010-04-01", ...o,
});

test("a correctly signed inbound SMS is recorded and answered with an empty TwiML (no auto-reply)", async () => {
  const { fn, store } = setup();
  const res = await fn.handle(twilioRequest("/messages/inbound", inbound()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/xml");
  const body = await res.text();
  assert.match(body, /<Response><\/Response>/);
  assert.doesNotMatch(body, /<Message/);
  const row = store.s.messages.get(sid(1));
  assert.equal(row.from, "+15735550101");
  assert.equal(row.to, "+18005550100");
  assert.equal(row.account_sid, ACCT_A);
  assert.equal(row.opt_out_type, null);
});

test("a bad signature, a tampered body or a missing signature is 403 and nothing is recorded", async () => {
  const { fn, store, logs } = setup();
  assert.equal((await fn.handle(twilioRequest("/messages/inbound", inbound(), { signature: "bm90LWEtc2lnbmF0dXJl" }))).status, 403);
  assert.equal((await fn.handle(twilioRequest("/messages/inbound", inbound(), { tamper: { Body: "changed in flight" } }))).status, 403);
  const unsigned = new Request(`http://edge.local/twilio-webhook/messages/inbound`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(inbound()).toString(),
  });
  assert.equal((await fn.handle(unsigned)).status, 403);
  assert.equal(store.s.calls, 0);
  assert.ok(logs.every((l) => !JSON.stringify(l).includes(TOKEN_A)), "the token never reaches a log");
  assert.ok(logs.every((l) => !JSON.stringify(l).includes("CPR")), "a message body never reaches a log");
});

test("a request signed with another subaccount's token is refused (each subaccount validates with its own)", async () => {
  const { fn, store } = setup();
  const res = await fn.handle(twilioRequest("/messages/inbound", inbound(), { token: TOKEN_B }));
  assert.equal(res.status, 403);
  assert.equal(store.s.calls, 0);
});

test("an unknown account, or one whose auth token is not in Vault, is 403", async () => {
  const { fn } = setup();
  const stranger = "AC" + "9".repeat(32);
  assert.equal((await fn.handle(twilioRequest("/messages/inbound", inbound({ AccountSid: stranger }), { token: "x" }))).status, 403);
  const { fn: fn2 } = setup({ tokens: { [ACCT_A]: null } });
  assert.equal((await fn2.handle(twilioRequest("/messages/inbound", inbound()))).status, 403);
});

test("Twilio retrying the same MessageSid records it once and answers 200 again", async () => {
  const { fn, store } = setup();
  const a = await fn.handle(twilioRequest("/messages/inbound", inbound()));
  const b = await fn.handle(twilioRequest("/messages/inbound", inbound()));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(store.s.messages.size, 1);
  assert.equal([...store.s.threads.values()][0].unread, 1);
});

test("contact and thread: one per sender, a second message adds to unread", async () => {
  const { fn, store } = setup();
  await fn.handle(twilioRequest("/messages/inbound", inbound()));
  await fn.handle(twilioRequest("/messages/inbound", inbound({ MessageSid: sid(2), SmsMessageSid: sid(2), Body: "Pricing?" })));
  await fn.handle(twilioRequest("/messages/inbound", inbound({ MessageSid: sid(3), SmsMessageSid: sid(3), From: "+15735550102" })));
  assert.equal(store.s.contacts.size, 2);
  assert.equal(store.s.threads.size, 2);
  assert.deepEqual([...store.s.threads.values()].map((t) => t.unread), [2, 1]);
});

test("parameters Twilio adds later are tolerated (and still covered by the signature)", async () => {
  const { fn, store } = setup();
  const res = await fn.handle(twilioRequest("/messages/inbound", inbound({ SomeFutureParam: "x", AddOns: '{"status":"successful"}' })));
  assert.equal(res.status, 200);
  assert.equal(store.s.messages.size, 1);
});

test("Twilio's OptOutType is recorded; without it the standard keywords are", async () => {
  const { fn, store } = setup();
  await fn.handle(twilioRequest("/messages/inbound", inbound({ Body: "Stop please", OptOutType: "STOP" })));
  assert.equal(store.s.messages.get(sid(1)).opt_out_type, "STOP");
  assert.equal(store.s.messages.get(sid(1)).opt_out_via, "twilio");
  await fn.handle(twilioRequest("/messages/inbound", inbound({ MessageSid: sid(2), SmsMessageSid: sid(2), Body: " unsubscribe " })));
  assert.equal(store.s.messages.get(sid(2)).opt_out_type, "STOP");
  assert.equal(store.s.messages.get(sid(2)).opt_out_via, "keyword");
  await fn.handle(twilioRequest("/messages/inbound", inbound({ MessageSid: sid(3), SmsMessageSid: sid(3), Body: "HELP" })));
  assert.equal(store.s.messages.get(sid(3)).opt_out_type, "HELP");
  await fn.handle(twilioRequest("/messages/inbound", inbound({ MessageSid: sid(4), SmsMessageSid: sid(4), Body: "Please stop by Tuesday" })));
  assert.equal(store.s.messages.get(sid(4)).opt_out_type, null, "a sentence containing stop is not an opt-out");
});

test("a message to a number Compass has not linked is 404 (visible in Twilio's debugger), nothing recorded", async () => {
  const { fn, store } = setup();
  const res = await fn.handle(twilioRequest("/messages/inbound", inbound({ To: "+18005559999" })));
  assert.equal(res.status, 404);
  assert.equal(store.s.messages.size, 0);
});

test("a number of client B with client A's account is not routed to either", async () => {
  const { fn, store } = setup();
  const res = await fn.handle(twilioRequest("/messages/inbound", inbound({ To: "+18005550200" })));
  assert.equal(res.status, 404);
  assert.equal(store.s.messages.size, 0);
});

test("status callback: validated with the ?m= query in the signed URL, passed through", async () => {
  const { fn, store } = setup();
  const params = { MessageSid: sid(7), SmsSid: sid(7), AccountSid: ACCT_A, MessageStatus: "delivered", SmsStatus: "delivered",
    To: "+15735550101", From: "+18005550100", ApiVersion: "2010-04-01", RawDlrDoneDate: "2610021200" };
  const query = "?m=11111111-2222-4333-8444-555555555555";
  const res = await fn.handle(twilioRequest("/messages/status", params, { query }));
  assert.equal(res.status, 200);
  assert.deepEqual(store.s.statuses[0], {
    message_sid: sid(7), message_id: "11111111-2222-4333-8444-555555555555", account_sid: ACCT_A,
    status: "delivered", error_code: null, error_message: null,
  });
  // Signed without the query → the URL differs → refused.
  const forged = twilioRequest("/messages/status", params, { query });
  const unsignedQuery = new Request(forged.url, { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": webhooks.getExpectedTwilioSignature(TOKEN_A, `${BASE}/messages/status`, params),
  }, body: new URLSearchParams(params).toString() });
  assert.equal((await fn.handle(unsignedQuery)).status, 403);
});

test("a failed delivery carries Twilio's error code", async () => {
  const { fn, store } = setup();
  const params = { MessageSid: sid(8), AccountSid: ACCT_A, MessageStatus: "undelivered", ErrorCode: "30003" };
  assert.equal((await fn.handle(twilioRequest("/messages/status", params))).status, 200);
  assert.equal(store.s.statuses[0].error_code, "30003");
  assert.equal(store.s.statuses[0].status, "undelivered");
});

test("a status Compass does not track is acknowledged (no retry storm)", async () => {
  const { fn } = setup();
  const res = await fn.handle(twilioRequest("/messages/status", { MessageSid: sid(9), AccountSid: ACCT_A, MessageStatus: "bogus" }));
  assert.equal(res.status, 200);
});

test("only the two routes, only POST, only form bodies", async () => {
  const { fn } = setup();
  assert.equal((await fn.handle(new Request("http://edge.local/twilio-webhook/messages/inbound"))).status, 405);
  assert.equal((await fn.handle(twilioRequest("/voice", inbound()))).status, 404);
  const json = new Request("http://edge.local/twilio-webhook/messages/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal((await fn.handle(json)).status, 415);
});
