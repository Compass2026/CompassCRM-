// The Twilio provider (0063) against a fake fetch: which credential each call
// uses, the URLs and form fields Twilio documents, and error mapping. No
// request leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTwilioProvider } from "../supabase/functions/_shared/communications/twilio.ts";
import { ProviderError } from "../supabase/functions/_shared/communications/provider.ts";

const PARENT = { scope: "parent", accountSid: "AC" + "0".repeat(32), keySid: "SKparent", keySecret: "parent-secret" };
const SUB = { scope: "subaccount", accountSid: "AC" + "1".repeat(32), keySid: "SKsub", keySecret: "sub-secret" };

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, form: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    const a = answers.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { fn, calls };
}
const auth = (c) => "Basic " + Buffer.from(`${c.keySid}:${c.keySecret}`).toString("base64");

test("subaccount management uses the parent key on /Accounts and /Keys", async () => {
  const f = fakeFetch([
    { status: 201, body: { sid: "AC" + "9".repeat(32), friendly_name: "Compass - X", status: "active", owner_account_sid: PARENT.accountSid, auth_token: "tok" } },
    { status: 201, body: { sid: "SKnew", secret: "s" } },
  ]);
  const t = createTwilioProvider(f.fn);
  const sub = await t.createSubaccount(PARENT, "Compass - X");
  assert.equal(sub.authToken, "tok");
  await t.createSubaccountKey(PARENT, sub.sid, "Compass CRM communications");
  assert.equal(f.calls[0].url, "https://api.twilio.com/2010-04-01/Accounts.json");
  assert.deepEqual(f.calls[0].form, { FriendlyName: "Compass - X" });
  assert.equal(f.calls[1].url, `https://api.twilio.com/2010-04-01/Accounts/${sub.sid}/Keys.json`);
  assert.ok(f.calls.every((c) => c.auth === auth(PARENT)));
});

test("a send names the subaccount, uses its own key and the Messaging Service", async () => {
  const f = fakeFetch([{ status: 201, body: { sid: "SM" + "e".repeat(32), status: "accepted", error_code: null } }]);
  const t = createTwilioProvider(f.fn);
  const r = await t.sendMessage(SUB, { messagingServiceSid: "MGx", to: "+15735550101", body: "Hi", statusCallbackUrl: "https://h/s?m=1" });
  assert.equal(r.status, "accepted");
  assert.equal(f.calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Messages.json`);
  assert.equal(f.calls[0].auth, auth(SUB));
  assert.deepEqual(f.calls[0].form, { MessagingServiceSid: "MGx", To: "+15735550101", Body: "Hi", StatusCallback: "https://h/s?m=1" });
});

test("toll-free search asks for SMS + voice and reads both capability spellings", async () => {
  const f = fakeFetch([{ status: 200, body: { available_phone_numbers: [
    { phone_number: "+18005550111", friendly_name: "(800) 555-0111", capabilities: { voice: true, SMS: true, MMS: false } },
  ] } }]);
  const t = createTwilioProvider(f.fn);
  const list = await t.searchTollFree(SUB, { areaCode: "800", limit: 20 });
  assert.deepEqual(list[0], { phoneNumber: "+18005550111", friendlyName: "(800) 555-0111", sms: true, voice: true, mms: false });
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, `/2010-04-01/Accounts/${SUB.accountSid}/AvailablePhoneNumbers/US/TollFree.json`);
  assert.equal(u.searchParams.get("SmsEnabled"), "true");
  assert.equal(u.searchParams.get("VoiceEnabled"), "true");
  assert.equal(u.searchParams.get("AreaCode"), "800");
});

test("a Messaging Service is created with its inbound and status webhooks, inbound by the service", async () => {
  const f = fakeFetch([{ status: 201, body: { sid: "MG" + "3".repeat(32), friendly_name: "X Messaging" } }]);
  const t = createTwilioProvider(f.fn);
  await t.createMessagingService(SUB, { friendlyName: "X Messaging", inboundUrl: "https://h/messages/inbound", statusCallbackUrl: "https://h/messages/status", useCase: "customer_care" });
  assert.equal(f.calls[0].url, "https://messaging.twilio.com/v1/Services");
  assert.deepEqual(f.calls[0].form, { FriendlyName: "X Messaging", InboundRequestUrl: "https://h/messages/inbound", InboundMethod: "POST",
    StatusCallback: "https://h/messages/status", UseInboundWebhookOnNumber: "false" });
});

test("toll-free verification and customer profile reads", async () => {
  const f = fakeFetch([
    { status: 200, body: { sid: "HHx", status: "TWILIO_REJECTED", error_code: 30513, rejection_reason: "Opt-in", edit_allowed: true, date_created: "2026-10-01T00:00:00Z" } },
    { status: 200, body: { sid: "BUx", status: "in-review" } },
  ]);
  const t = createTwilioProvider(f.fn);
  const tfv = await t.fetchTollFreeVerification(SUB, "HHx");
  assert.deepEqual([tfv.rawStatus, tfv.rejectionCode, tfv.editAllowed], ["TWILIO_REJECTED", "30513", true]);
  assert.equal(f.calls[0].url, "https://messaging.twilio.com/v1/Tollfree/Verifications/HHx");
  const cp = await t.fetchCustomerProfile(SUB, "BUx");
  assert.equal(cp.rawStatus, "in-review");
  assert.equal(f.calls[1].url, "https://trusthub.twilio.com/v1/CustomerProfiles/BUx");
});

test("Twilio errors become ProviderError with Twilio's code, never the credential", async () => {
  const f = fakeFetch([{ status: 400, body: { code: 21610, message: "Attempt to send to unsubscribed recipient", more_info: "https://www.twilio.com/docs/errors/21610" } }]);
  const t = createTwilioProvider(f.fn);
  await assert.rejects(t.sendMessage(SUB, { messagingServiceSid: "MGx", to: "+1", body: "x", statusCallbackUrl: "https://h" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "21610");
    assert.ok(!e.message.includes("sub-secret"));
    return true;
  });
});

test("listSubaccounts: a read of /Accounts by friendly name with the parent key; tokens are never carried", async () => {
  const f = fakeFetch([{ status: 200, body: { accounts: [
    { sid: "AC" + "9".repeat(32), friendly_name: "Compass - X", status: "active", owner_account_sid: PARENT.accountSid, auth_token: "tok" },
  ] } }]);
  const t = createTwilioProvider(f.fn);
  const list = await t.listSubaccounts(PARENT, "Compass - X");
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].url, "https://api.twilio.com/2010-04-01/Accounts.json?FriendlyName=Compass+-+X&PageSize=50");
  assert.equal(f.calls[0].auth, auth(PARENT));
  assert.deepEqual(list, [{ sid: "AC" + "9".repeat(32), friendlyName: "Compass - X", status: "active", ownerAccountSid: PARENT.accountSid }]);
  assert.ok(!JSON.stringify(list).includes("tok"));
});

test("createSubaccount with an API key: Twilio sends no auth_token → authToken is empty (the caller must not treat that as failure)", async () => {
  const f = fakeFetch([{ status: 201, body: { sid: "AC" + "9".repeat(32), friendly_name: "Compass - X", status: "active", owner_account_sid: PARENT.accountSid } }]);
  const sub = await createTwilioProvider(f.fn).createSubaccount(PARENT, "Compass - X");
  assert.equal(sub.sid, "AC" + "9".repeat(32));
  assert.equal(sub.authToken, "");
});
