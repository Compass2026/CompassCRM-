// The communications function's handler (0063) over an in-memory store that
// keeps 0063's send rules (consent, opt-out, outbound switch, idempotent
// request ids) and a fake Twilio. The real rules run in the database: the
// sandbox suite (communications.test.sql) and, through this same handler
// over PostgREST, tests/communications-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommunications } from "../supabase/functions/communications/handler.ts";
import { ProviderError } from "../supabase/functions/_shared/communications/provider.ts";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const ADMIN = "00000000-0000-4000-8000-00000000aa01";
const MEMBER = "00000000-0000-4000-8000-00000000aa02";
const PARENT = "AC" + "0".repeat(32);
const SUB = "AC" + "1".repeat(32);
const SUB_OTHER = "AC" + "2".repeat(32);
const MG = "MG" + "3".repeat(32);
const BASE = "https://example-ref.supabase.co/functions/v1/twilio-webhook";
const PARENT_SECRET = "parent-secret-value";
const SUB_SECRET = "sub-secret-value";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fakeStore(o = {}) {
  const s = {
    secrets: {
      TWILIO_ACCOUNT_SID: PARENT, TWILIO_API_KEY: "SK" + "p".repeat(32), TWILIO_API_SECRET: PARENT_SECRET,
      [`TWILIO_SUB_${SUB}_API_KEY`]: "SK" + "s".repeat(32), [`TWILIO_SUB_${SUB}_API_SECRET`]: SUB_SECRET,
      [`TWILIO_SUB_${SUB}_AUTH_TOKEN`]: "sub-token", ...(o.secrets ?? {}),
    },
    members: { "jwt-admin": { member: ADMIN, role: "admin" }, "jwt-member": { member: MEMBER, role: "member" }, "jwt-stranger": { member: null, role: null } },
    clients: { [CLIENT]: { id: CLIENT, name: "Example Safety Partners", status: "active" }, [OTHER]: { id: OTHER, name: "Other Co", status: "active" } },
    settings: { [CLIENT]: { enabled: true, outbound_enabled: true, display_name: null }, ...(o.settings ?? {}) },
    accounts: { [CLIENT]: { id: "acct-1", provider_account_sid: SUB, status: "active" }, ...(o.accounts ?? {}) },
    services: { [CLIENT]: { id: "svc-1", provider_service_sid: MG, friendly_name: "Example Safety Messaging", status: "active" }, ...(o.services ?? {}) },
    consent: { "+15735550101": "granted", "+15735550102": "opted_out", ...(o.consent ?? {}) },
    messages: new Map(),
    rpcs: [],
    vaultWrites: [],
  };
  return {
    s,
    async secret(name) { return s.secrets[name] ?? null; },
    async setSecret(name, value) { s.vaultWrites.push(name); s.secrets[name] = value; },
    async caller(jwt) { return jwt ? s.members[jwt] ?? "none" : "none"; },
    async client(id) { return s.clients[id] ?? null; },
    async settings(id) { return s.settings[id] ?? null; },
    async account(id) { return s.accounts[id] ?? null; },
    async messagingService(id) { return s.services[id] ?? null; },
    async number(clientId, id) { return id === uuid(50) && clientId === CLIENT ? { id, provider_phone_number_sid: "PN" + "5".repeat(32), phone_number_e164: "+18005550100", messaging_service_id: null, status: "active" } : null; },
    async registrations() {
      return [
        { id: uuid(60), profile_type: "toll_free_verification", provider_profile_sid: "HH" + "6".repeat(32) },
        { id: uuid(61), profile_type: "secondary_customer_profile", provider_profile_sid: "BU" + "7".repeat(32) },
        { id: uuid(62), profile_type: "secondary_customer_profile", provider_profile_sid: null },
      ];
    },
    async rpc(fn, p) {
      s.rpcs.push({ fn, p });
      if (fn === "communication_begin_outbound") {
        const existing = [...s.messages.values()].find((m) => m.request_id === p.request_id);
        if (existing) return { duplicate: true, message_id: existing.id, conversation_id: "conv-1", provider_status: existing.status };
        const settings = s.settings[p.client_id];
        if (!settings?.enabled) throw new Error("not_enabled: communications are not enabled for this client");
        if (!settings.outbound_enabled) throw new Error("outbound_disabled: sending is turned off for this client");
        const to = p.contact_id === uuid(2) ? "+15735550102" : p.contact_id === uuid(3) ? "+15735550103" : "+15735550101";
        if (s.consent[to] === "opted_out") throw new Error(`opted_out: ${to} opted out of messages from this business`);
        if (s.consent[to] !== "granted") throw new Error(`no_consent: there is no SMS consent on record for ${to}`);
        const id = uuid(100 + s.messages.size);
        s.messages.set(id, { id, request_id: p.request_id, status: "pending", to });
        return { duplicate: false, message_id: id, conversation_id: "conv-1", to, from: "+18005550100", messaging_service_sid: MG, account_sid: SUB, body: p.body };
      }
      if (fn === "communication_mark_sent") {
        const m = s.messages.get(p.message_id);
        m.status = p.provider_status ?? (p.provider_message_sid ? "queued" : "failed");
        m.sid = p.provider_message_sid ?? null;
        m.error_code = p.error_code ?? null;
        return { result: "updated" };
      }
      return { ok: true };
    },
  };
}

function fakeTwilio(o = {}) {
  const calls = [];
  const rec = (name, cred, args) => calls.push({ name, scope: cred.scope, accountSid: cred.accountSid, args });
  return {
    calls,
    async fetchParentAccount(cred) { rec("fetchParentAccount", cred); if (o.standardKey) throw new ProviderError(403, "20003", "Authenticate"); return { sid: cred.accountSid, status: "active", friendlyName: "Compass", ownerAccountSid: cred.accountSid }; },
    async createSubaccount(cred, name) { rec("createSubaccount", cred, { name }); return { sid: "AC" + "9".repeat(32), friendlyName: name, status: "active", ownerAccountSid: PARENT, authToken: "new-sub-token" }; },
    async fetchSubaccount(cred, sid) { rec("fetchSubaccount", cred, { sid }); return { sid, friendlyName: "x", status: "active", ownerAccountSid: o.foreignOwner ? "AC" + "8".repeat(32) : PARENT, authToken: "linked-token" }; },
    async createSubaccountKey(cred, sid) { rec("createSubaccountKey", cred, { sid }); return { sid: "SK" + "k".repeat(32), secret: "new-key-secret" }; },
    async searchTollFree(cred, opts) {
      rec("searchTollFree", cred, opts);
      if (opts.areaCode === "800") return [{ phoneNumber: "+18005550111", friendlyName: "(800) 555-0111", sms: true, voice: true, mms: false }];
      return [
        { phoneNumber: "+18885550122", friendlyName: "(888) 555-0122", sms: true, voice: true, mms: false },
        { phoneNumber: "+18445550133", friendlyName: "(844) 555-0133", sms: true, voice: false, mms: false },
        { phoneNumber: "+18005550111", friendlyName: "(800) 555-0111", sms: true, voice: true, mms: false },
      ];
    },
    async purchaseNumber(cred, phone, name) { rec("purchaseNumber", cred, { phone, name }); return { sid: "PN" + "4".repeat(32), phoneNumber: phone, friendlyName: name, sms: true, voice: true, mms: false, accountSid: cred.accountSid }; },
    async fetchNumber(cred, sid) { rec("fetchNumber", cred, { sid }); return { sid, phoneNumber: "+18005550100", friendlyName: null, sms: true, voice: true, mms: false, accountSid: o.numberAccount ?? cred.accountSid }; },
    async createMessagingService(cred, opts) { rec("createMessagingService", cred, opts); return { sid: MG, friendlyName: opts.friendlyName }; },
    async addNumberToService(cred, svc, num) { rec("addNumberToService", cred, { svc, num }); },
    async sendMessage(cred, opts) {
      rec("sendMessage", cred, opts);
      if (o.sendError) throw o.sendError;
      return { sid: "SM" + "e".repeat(32), status: "queued", errorCode: null, errorMessage: null };
    },
    async fetchTollFreeVerification(cred, sid) { rec("fetchTollFreeVerification", cred, { sid }); return { sid, rawStatus: "TWILIO_REJECTED", rejectionCode: "30513", rejectionReason: "Opt-in not shown", editAllowed: true, submittedAt: "2026-10-01T00:00:00Z" }; },
    async fetchCustomerProfile(cred, sid) { rec("fetchCustomerProfile", cred, { sid }); return { sid, rawStatus: "twilio-approved", rejectionCode: null, rejectionReason: null, editAllowed: null, submittedAt: null }; },
  };
}

function setup(o = {}) {
  const store = fakeStore(o);
  const twilio = fakeTwilio(o);
  const logs = [];
  const fn = createCommunications({ store, provider: twilio, webhookBase: async () => BASE, log: (e, d) => logs.push({ e, ...d }) });
  const call = async (jwt, body) => {
    const res = await fn.handle(new Request("http://edge.local/communications", {
      method: "POST", headers: { Authorization: jwt ? `Bearer ${jwt}` : "", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  return { store, twilio, call, logs };
}

const SECRETS = [PARENT_SECRET, SUB_SECRET, "sub-token", "new-sub-token", "linked-token", "new-key-secret"];
const noSecrets = (text) => SECRETS.every((x) => !text.includes(x));

test("only a signed-in teammate reaches the function", async () => {
  const { call } = setup();
  assert.equal((await call(null, { mode: "version" })).status, 401);
  assert.equal((await call("jwt-unknown", { mode: "version" })).status, 401);
  assert.equal((await call("jwt-stranger", { mode: "version" })).status, 403);
  assert.equal((await call("jwt-member", { mode: "version" })).status, 200);
});

test("send: consent on record → Twilio through the Messaging Service with the SUBACCOUNT key, SID recorded", async () => {
  const { call, twilio, store } = setup();
  const r = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(1), body: "Your class is Tuesday at 9.", request_id: uuid(9) });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "queued");
  const send = twilio.calls.find((c) => c.name === "sendMessage");
  assert.equal(send.scope, "subaccount");
  assert.equal(send.accountSid, SUB);
  assert.equal(send.args.messagingServiceSid, MG);
  assert.equal(send.args.to, "+15735550101");
  assert.equal(send.args.statusCallbackUrl, `${BASE}/messages/status?m=${r.body.message_id}`);
  assert.equal(store.s.messages.get(r.body.message_id).sid, "SM" + "e".repeat(32));
  assert.equal(store.s.rpcs.find((x) => x.fn === "communication_begin_outbound").p.sent_by, MEMBER, "the sender is the signed-in teammate");
  assert.ok(!twilio.calls.some((c) => c.scope === "parent"), "no parent credential for a normal send");
  assert.ok(noSecrets(r.text));
});

test("send: an opted-out recipient is refused before Twilio is called", async () => {
  const { call, twilio } = setup();
  const r = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(2), body: "Hello", request_id: uuid(10) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "opted_out");
  assert.ok(!twilio.calls.some((c) => c.name === "sendMessage"));
});

test("send: no consent on record (a phone number is not consent) → refused", async () => {
  const { call, twilio } = setup();
  const r = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(3), body: "Hello", request_id: uuid(11) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "no_consent");
  assert.equal(twilio.calls.length, 0);
});

test("send: outbound off for the client → refused", async () => {
  const { call, twilio } = setup({ settings: { [CLIENT]: { enabled: true, outbound_enabled: false } } });
  const r = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(1), body: "Hello", request_id: uuid(12) });
  assert.equal(r.body.code, "outbound_disabled");
  assert.equal(twilio.calls.length, 0);
});

test("send: the same request_id twice sends once", async () => {
  const { call, twilio } = setup();
  const a = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(1), body: "Once", request_id: uuid(13) });
  const b = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(1), body: "Once", request_id: uuid(13) });
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.message_id, a.body.message_id);
  assert.equal(twilio.calls.filter((c) => c.name === "sendMessage").length, 1);
});

test("send: Twilio's refusal (21610) is recorded as failed with its code", async () => {
  const { call, store } = setup({ sendError: new ProviderError(400, "21610", "Attempt to send to unsubscribed recipient") });
  const r = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(1), body: "Hi", request_id: uuid(14) });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "failed");
  assert.equal(store.s.messages.get(r.body.message_id).error_code, "21610");
});

test("send: Twilio unreachable → the message stays pending (no false failure, no resend)", async () => {
  const { call, store } = setup({ sendError: new Error("network down") });
  const r = await call("jwt-member", { mode: "send", client_id: CLIENT, contact_id: uuid(1), body: "Hi", request_id: uuid(15) });
  assert.equal(r.status, 202);
  assert.equal(r.body.status, "uncertain");
  assert.equal(store.s.messages.get(r.body.message_id).status, "pending");
});

test("provisioning is an admin's: a member is refused every admin mode", async () => {
  const { call, twilio } = setup();
  for (const mode of ["check_parent", "create_subaccount", "link_subaccount", "create_messaging_service", "purchase_number", "link_number", "attach_number"]) {
    const r = await call("jwt-member", { mode, client_id: CLIENT });
    assert.equal(r.status, 403, mode);
    assert.equal(r.body.code, "admin_only");
  }
  assert.equal(twilio.calls.length, 0);
});

test("check_parent: a Main key reads /Accounts; a Standard key is reported as not Main", async () => {
  const ok = await setup().call("jwt-admin", { mode: "check_parent" });
  assert.equal(ok.body.main_key, true);
  const std = await setup({ standardKey: true }).call("jwt-admin", { mode: "check_parent" });
  assert.equal(std.status, 200);
  assert.equal(std.body.main_key, false);
  assert.match(std.body.detail, /Main API key/);
  const none = await setup({ secrets: { TWILIO_API_SECRET: null } }).call("jwt-admin", { mode: "check_parent" });
  assert.equal(none.body.configured, false);
});

test("create_subaccount: parent Main key creates it; auth token and the subaccount's own key go to Vault, never the response", async () => {
  const { call, twilio, store } = setup({ accounts: { [CLIENT]: null } });
  const wrong = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "example safety" });
  assert.equal(wrong.body.code, "confirm");
  const r = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(r.status, 200);
  const created = "AC" + "9".repeat(32);
  assert.equal(r.body.account_sid, created);
  assert.deepEqual(twilio.calls.map((c) => [c.name, c.scope]), [["createSubaccount", "parent"], ["createSubaccountKey", "parent"]]);
  assert.deepEqual(store.s.vaultWrites.sort(), [`TWILIO_SUB_${created}_API_KEY`, `TWILIO_SUB_${created}_API_SECRET`, `TWILIO_SUB_${created}_AUTH_TOKEN`].sort());
  assert.equal(store.s.rpcs.find((x) => x.fn === "communication_register_account").p.account_sid, created);
  assert.ok(noSecrets(r.text));
});

test("create_subaccount: refused when the client already has one, or communications are off", async () => {
  const has = await setup().call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(has.body.code, "account_exists");
  const off = await setup({ settings: { [CLIENT]: { enabled: false, outbound_enabled: false } }, accounts: { [CLIENT]: null } })
    .call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(off.body.code, "not_enabled");
});

test("link_subaccount: only a subaccount of Compass's parent is linked", async () => {
  const foreign = await setup({ accounts: { [CLIENT]: null }, foreignOwner: true }).call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: SUB_OTHER });
  assert.equal(foreign.body.code, "not_a_subaccount");
  const { call, store } = setup({ accounts: { [CLIENT]: null } });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: SUB_OTHER });
  assert.equal(r.status, 200);
  assert.ok(store.s.vaultWrites.includes(`TWILIO_SUB_${SUB_OTHER}_AUTH_TOKEN`));
  assert.ok(noSecrets(r.text));
});

test("search_numbers: toll-free, SMS + voice only, 800 first, nothing bought", async () => {
  const { call, twilio } = setup();
  const r = await call("jwt-member", { mode: "search_numbers", client_id: CLIENT });
  assert.equal(r.status, 200);
  assert.equal(r.body.purchased, false);
  assert.deepEqual(r.body.numbers.map((n) => n.phone_number), ["+18005550111", "+18885550122"]);
  assert.equal(r.body.numbers[0].preferred_prefix, true);
  assert.ok(twilio.calls.every((c) => c.name === "searchTollFree" && c.scope === "subaccount"));
});

test("purchase_number: an admin, the exact number confirmed, toll-free only; then joined to the Messaging Service", async () => {
  const { call, twilio, store } = setup();
  assert.equal((await call("jwt-admin", { mode: "purchase_number", client_id: CLIENT, phone_number: "+18005550111" })).body.code, "confirm");
  assert.equal((await call("jwt-admin", { mode: "purchase_number", client_id: CLIENT, phone_number: "+15735550111", confirm: "+15735550111" })).status, 400);
  assert.ok(!twilio.calls.some((c) => c.name === "purchaseNumber"), "nothing bought without the confirmation");
  const r = await call("jwt-admin", { mode: "purchase_number", client_id: CLIENT, phone_number: "+18005550111", confirm: "+18005550111" });
  assert.equal(r.status, 200);
  assert.equal(r.body.messaging_service, MG);
  assert.deepEqual(twilio.calls.map((c) => [c.name, c.scope]), [["purchaseNumber", "subaccount"], ["addNumberToService", "subaccount"]]);
  const regs = store.s.rpcs.filter((x) => x.fn === "communication_register_number");
  assert.equal(regs.at(-1).p.messaging_service_sid, MG);
});

test("link_number: a number from another account is refused", async () => {
  const r = await setup({ numberAccount: SUB_OTHER }).call("jwt-admin", { mode: "link_number", client_id: CLIENT, number_sid: "PN" + "4".repeat(32) });
  assert.equal(r.body.code, "wrong_account");
});

test("create_messaging_service: named after the display name when set", async () => {
  const { call, twilio } = setup({ services: { [CLIENT]: null }, settings: { [CLIENT]: { enabled: true, outbound_enabled: false, display_name: "Example Safety" } } });
  await call("jwt-admin", { mode: "create_messaging_service", client_id: CLIENT });
  assert.equal(twilio.calls.find((x) => x.name === "createMessagingService").args.friendlyName, "Example Safety Messaging");
});

test("create_messaging_service: inbound and status webhooks point at twilio-webhook", async () => {
  const { call, twilio } = setup({ services: { [CLIENT]: null } });
  const r = await call("jwt-admin", { mode: "create_messaging_service", client_id: CLIENT });
  assert.equal(r.status, 200);
  const c = twilio.calls.find((x) => x.name === "createMessagingService");
  assert.equal(c.scope, "subaccount");
  assert.equal(c.args.friendlyName, "Example Safety Partners Messaging");
  assert.equal(c.args.inboundUrl, `${BASE}/messages/inbound`);
  assert.equal(c.args.statusCallbackUrl, `${BASE}/messages/status`);
});

test("sync_compliance: Twilio's raw statuses are mapped and recorded; unlinked registrations are skipped", async () => {
  const { call, store } = setup();
  const r = await call("jwt-member", { mode: "sync_compliance", client_id: CLIENT });
  assert.deepEqual(r.body.results.map((x) => [x.result, x.status ?? null]), [["synced", "rejected"], ["synced", "approved"], ["not_linked", null]]);
  const tfv = store.s.rpcs.find((x) => x.fn === "communication_record_compliance_sync" && x.p.profile_id === uuid(60)).p;
  assert.equal(tfv.provider_status, "TWILIO_REJECTED");
  assert.equal(tfv.rejection_code, "30513");
});

test("a client without its subaccount key in Vault is told so; no parent fallback", async () => {
  const { call, twilio } = setup({ secrets: { [`TWILIO_SUB_${SUB}_API_KEY`]: null } });
  const r = await call("jwt-member", { mode: "search_numbers", client_id: CLIENT });
  assert.equal(r.status, 412);
  assert.equal(r.body.code, "subaccount_key_missing");
  assert.equal(twilio.calls.length, 0);
});
