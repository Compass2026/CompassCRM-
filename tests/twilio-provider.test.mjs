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

test("a subaccount is created with the parent key on the parent's /Accounts.json; its key is minted with the subaccount's own SID + Auth Token", async () => {
  const f = fakeFetch([
    { status: 201, body: { sid: "AC" + "9".repeat(32), friendly_name: "Compass - X", status: "active", owner_account_sid: PARENT.accountSid, auth_token: "tok" } },
    { status: 201, body: { sid: "SKnew", secret: "s" } },
  ]);
  const t = createTwilioProvider(f.fn);
  const sub = await t.createSubaccount(PARENT, "Compass - X");
  assert.equal(sub.authToken, "tok");
  const key = await t.createSubaccountKey({ scope: "subaccount_token", accountSid: sub.sid, authToken: "tok" }, "Compass CRM communications");
  assert.deepEqual(key, { sid: "SKnew", secret: "s" });
  assert.equal(f.calls[0].url, "https://api.twilio.com/2010-04-01/Accounts.json");
  assert.deepEqual(f.calls[0].form, { FriendlyName: "Compass - X" });
  assert.equal(f.calls[0].auth, auth(PARENT));
  assert.equal(f.calls[1].url, `https://api.twilio.com/2010-04-01/Accounts/${sub.sid}/Keys.json`);
  assert.equal(f.calls[1].auth, "Basic " + Buffer.from(`${sub.sid}:tok`).toString("base64"), "the subaccount's own credentials, never the parent key");
});

// Twilio as it behaves with a parent API key: the parent's Accounts list
// answers, any subaccount resource (/Accounts/<sub>.json) is 20404.
function parentKeyTwilio(accounts, { pageSize = 1000 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === "/2010-04-01/Accounts.json" && init.method === "GET") {
      const page = Number(u.searchParams.get("Page") ?? 0);
      const slice = accounts.slice(page * pageSize, (page + 1) * pageSize);
      const more = (page + 1) * pageSize < accounts.length;
      return new Response(JSON.stringify({ accounts: slice, next_page_uri: more ? `/2010-04-01/Accounts.json?PageSize=${pageSize}&Page=${page + 1}` : null }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 20404, message: `The requested resource ${u.pathname} was not found` }), { status: 404 });
  };
  return { fn, calls };
}
const acct = (sid, extra = {}) => ({ sid, friendly_name: "Compass - X", status: "active", owner_account_sid: PARENT.accountSid, ...extra });

test("findSubaccount: the SID is found in the parent's own Accounts list although a direct fetch is 20404 for the parent key", async () => {
  const BHG = "AC" + "4af8abc3".repeat(4);
  const tw = parentKeyTwilio([acct(PARENT.accountSid), acct("AC" + "2".repeat(32)), acct(BHG)]);
  const t = createTwilioProvider(tw.fn);
  // What v2 did, and what Twilio answers.
  const direct = await tw.fn(`https://api.twilio.com/2010-04-01/Accounts/${BHG}.json`, { method: "GET", headers: { Authorization: auth(PARENT) } });
  assert.equal(direct.status, 404);
  assert.equal((await direct.json()).code, 20404);
  tw.calls.length = 0;
  const found = await t.findSubaccount(PARENT, "AC" + BHG.slice(2).toUpperCase());
  assert.deepEqual(found, { sid: BHG, friendlyName: "Compass - X", status: "active", ownerAccountSid: PARENT.accountSid });
  assert.deepEqual(tw.calls.map((c) => new URL(c.url).pathname), ["/2010-04-01/Accounts.json"], "only the list, never /Accounts/<sid>.json");
  assert.ok(tw.calls.every((c) => c.auth === auth(PARENT)));
  assert.equal(await t.findSubaccount(PARENT, "AC" + "7".repeat(32)), null);
});

test("findSubaccount: follows Twilio's next page of the same list (and only that)", async () => {
  const target = "AC" + "c".repeat(32);
  const tw = parentKeyTwilio([acct("AC" + "a".repeat(32)), acct("AC" + "b".repeat(32)), acct(target)], { pageSize: 1 });
  const t = createTwilioProvider(tw.fn);
  assert.equal((await t.findSubaccount(PARENT, target)).sid, target);
  assert.equal(tw.calls.length, 3);
  const evil = createTwilioProvider(async () => new Response(JSON.stringify({ accounts: [], next_page_uri: "https://elsewhere.example/steal" }), { status: 200 }));
  assert.equal(await evil.findSubaccount(PARENT, target), null);
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
