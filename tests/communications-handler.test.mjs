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
    vaultReads: [],
  };
  return {
    s,
    async secret(name) { if (o.vaultDown) throw new Error(`vault_read: could not read ${name}`); return s.secrets[name] ?? null; },
    // communication_subaccount_secrets (0065): the exact name, else the one
    // name that differs only in the SID's letter case.
    async subaccountSecrets(sid) {
      if (o.vaultDown) throw new Error(`vault_read: could not read the credentials of ${sid}`);
      s.vaultReads.push(sid);
      const find = (name) => {
        if (s.secrets[name] != null) return [name, s.secrets[name]];
        const hits = Object.keys(s.secrets).filter((k) => k.toLowerCase() === name.toLowerCase() && s.secrets[k] != null);
        return hits.length === 1 ? [hits[0], s.secrets[hits[0]]] : [null, null];
      };
      const names = { keySid: `TWILIO_SUB_${sid}_API_KEY`, keySecret: `TWILIO_SUB_${sid}_API_SECRET`, authToken: `TWILIO_SUB_${sid}_AUTH_TOKEN` };
      const [, keySid] = find(names.keySid); const [, keySecret] = find(names.keySecret); const [foundAs, authToken] = find(names.authToken);
      const others = Object.keys(s.secrets).map((k) => /^TWILIO_SUB_(AC[0-9a-fA-F]{32})_AUTH_TOKEN$/.exec(k)?.[1])
        .filter((x) => x && x.toLowerCase() !== sid.toLowerCase() && s.secrets[`TWILIO_SUB_${x}_AUTH_TOKEN`] != null);
      return { accountSid: sid, keySid, keySecret, authToken, names, authTokenFoundAs: foundAs, otherAuthTokenAccounts: others };
    },
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
      if (fn === "communication_register_account") {
        const holder = Object.entries(s.accounts).find(([, a]) => a && a.provider_account_sid === p.account_sid);
        if (holder && holder[0] !== p.client_id) throw new Error(`account_taken: subaccount ${p.account_sid} belongs to another client`);
        s.accounts[p.client_id] = { id: `acct-${p.client_id}`, provider_account_sid: p.account_sid, status: p.status ?? "active" };
        return { account_id: s.accounts[p.client_id].id };
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
    // Twilio hands a subaccount's Auth Token only to Auth Token callers; to
    // Compass's Main API key it is absent ("" on create, missing on fetch).
    async listSubaccounts(cred, name) { rec("listSubaccounts", cred, { name }); return (o.existingSubaccounts ?? []).map((sid) => ({ sid, friendlyName: name, status: "active", ownerAccountSid: PARENT })); },
    async createSubaccount(cred, name) {
      rec("createSubaccount", cred, { name });
      return { sid: o.createdSid ?? "AC" + "9".repeat(32), friendlyName: name, status: "active", ownerAccountSid: PARENT, authToken: o.tokenFromTwilio ? "new-sub-token" : "" };
    },
    // What Twilio does with a parent API key on /Accounts/<sub>.json: 20404.
    // Not part of the provider any more; kept to prove nothing calls it.
    async fetchSubaccount(cred, sid) {
      rec("fetchSubaccount", cred, { sid });
      throw new ProviderError(404, "20404", `The requested resource /2010-04-01/Accounts/${sid}.json was not found`);
    },
    // Parent list lookup remains for duplicate-create prevention and diagnostics.
    async findSubaccount(cred, sid) {
      rec("findSubaccount", cred, { sid });
      if (o.findError) throw o.findError;
      if (o.notInParent) return null;
      return { sid: "AC" + sid.slice(2).toLowerCase(), friendlyName: "x", status: o.closed ? "closed" : "active", ownerAccountSid: o.foreignOwner ? "AC" + "8".repeat(32) : PARENT };
    },
    // Link/recovery proves the relationship with the subaccount's own SID +
    // Auth Token, then checks owner_account_sid.
    async fetchSubaccountWithToken(cred) {
      rec("fetchSubaccountWithToken", cred, { sid: cred.accountSid, withToken: !!cred.authToken });
      if (o.selfFetchError) throw o.selfFetchError;
      return { sid: "AC" + cred.accountSid.slice(2).toLowerCase(), friendlyName: "x", status: o.closed ? "closed" : "active",
        ownerAccountSid: o.foreignOwner ? "AC" + "8".repeat(32) : PARENT };
    },
    // Minted with the subaccount's own SID + Auth Token, never the parent key.
    async createSubaccountKey(cred) {
      rec("createSubaccountKey", cred, { sid: cred.accountSid, withToken: !!cred.authToken });
      if (cred.scope !== "subaccount_token") throw new ProviderError(404, "20404", "The requested resource was not found");
      if (o.keyError) throw o.keyError;
      return { sid: "SK" + "f".repeat(32), secret: "new-key-secret" };
    },
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

const SECRETS = [PARENT_SECRET, SUB_SECRET, "sub-token", "new-sub-token", "linked-token", "new-key-secret", "bhg-token-placeholder-0000000000"];
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

test("create_subaccount: Twilio creates it without an Auth Token (an API key never gets one) → recorded at once, key waits for the token, 207 naming the exact secret", async () => {
  const { call, twilio, store } = setup({ accounts: { [CLIENT]: null } });
  const wrong = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "example safety" });
  assert.equal(wrong.body.code, "confirm");
  assert.equal(twilio.calls.length, 0);
  const r = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  const created = "AC" + "9".repeat(32);
  assert.equal(r.status, 207, JSON.stringify(r.body));
  assert.equal(r.body.account_sid, created);
  assert.equal(r.body.key, "waiting_for_auth_token");
  assert.equal(r.body.auth_token, "missing");
  assert.equal(r.body.auth_token_secret, `TWILIO_SUB_${created}_AUTH_TOKEN`);
  assert.match(r.body.detail, new RegExp(`TWILIO_SUB_${created}_AUTH_TOKEN`));
  assert.deepEqual(twilio.calls.map((c) => [c.name, c.scope]), [["listSubaccounts", "parent"], ["createSubaccount", "parent"]],
    "no key is minted with the parent key (Twilio refuses it on a subaccount)");
  assert.deepEqual(store.s.rpcs.filter((x) => x.fn === "communication_register_account").map((x) => x.p.account_sid), [created], "recorded once, at once");
  assert.deepEqual(store.s.vaultWrites, []);
  assert.ok(noSecrets(r.text));
  // The partial state never invites a second creation.
  const again = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "account_exists");
  assert.equal(twilio.calls.filter((c) => c.name === "createSubaccount").length, 1);
});

test("create_subaccount: when Twilio does return a token, everything lands in Vault → 200", async () => {
  const { call, store } = setup({ accounts: { [CLIENT]: null }, tokenFromTwilio: true });
  const r = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  const created = "AC" + "9".repeat(32);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.auth_token, "stored in Vault");
  assert.equal(r.body.key, "created");
  assert.deepEqual(store.s.vaultWrites.sort(), [`TWILIO_SUB_${created}_API_KEY`, `TWILIO_SUB_${created}_API_SECRET`, `TWILIO_SUB_${created}_AUTH_TOKEN`].sort());
  assert.ok(noSecrets(r.text));
});

test("create_subaccount: refused when Twilio already has a subaccount by that name; nothing is created", async () => {
  const { call, twilio, store } = setup({ accounts: { [CLIENT]: null }, existingSubaccounts: [SUB_OTHER] });
  const r = await call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "subaccount_exists_in_twilio");
  assert.deepEqual(r.body.account_sids, [SUB_OTHER]);
  assert.match(r.body.error, /Link it instead/);
  assert.ok(!twilio.calls.some((c) => c.name === "createSubaccount"));
  assert.ok(!store.s.rpcs.some((x) => x.fn === "communication_register_account"));
});

test("create_subaccount: an answer without a SID, or a Twilio failure, is 424 (not 5xx) and records nothing", async () => {
  const bad = setup({ accounts: { [CLIENT]: null }, createdSid: "not-a-sid" });
  const r = await bad.call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(r.status, 424);
  assert.match(r.body.detail, /Check the Twilio Console/);
  assert.ok(!bad.store.s.rpcs.some((x) => x.fn === "communication_register_account"));
});

test("create_subaccount: refused when the client already has one, or communications are off", async () => {
  const has = await setup().call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(has.body.code, "account_exists");
  const off = await setup({ settings: { [CLIENT]: { enabled: false, outbound_enabled: false } }, accounts: { [CLIENT]: null } })
    .call("jwt-admin", { mode: "create_subaccount", client_id: CLIENT, confirm: "Example Safety Partners" });
  assert.equal(off.body.code, "not_enabled");
});

// The BHG case: the subaccount exists in Twilio, its Auth Token was copied
// into Vault by hand under the long dynamic name, Twilio returns no token.
// Built, not written out: a literal SID trips secret scanning.
const BHG_LIKE = "AC" + "4af8abc3".repeat(4);
const BHG_TOKEN_NAME = `TWILIO_SUB_${BHG_LIKE}_AUTH_TOKEN`;

test("link_subaccount: the Auth Token stored by hand under TWILIO_SUB_<sid>_AUTH_TOKEN is found → registered once, key minted and stored under the dynamic names", async () => {
  assert.equal(BHG_TOKEN_NAME.length, 56);
  const { call, twilio, store } = setup({ accounts: { [CLIENT]: null }, secrets: { [BHG_TOKEN_NAME]: "bhg-token-placeholder-0000000000" } });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account_sid, BHG_LIKE);
  assert.equal(r.body.key, "created");
  assert.equal(r.body.auth_token, "stored in Vault");
  assert.deepEqual(store.s.rpcs.filter((x) => x.fn === "communication_register_account").map((x) => x.p.account_sid), [BHG_LIKE]);
  assert.deepEqual(store.s.vaultWrites.sort(), [`TWILIO_SUB_${BHG_LIKE}_API_KEY`, `TWILIO_SUB_${BHG_LIKE}_API_SECRET`].sort(), "the token is read, never rewritten");
  assert.equal(store.s.secrets[`TWILIO_SUB_${BHG_LIKE}_API_KEY`], "SK" + "f".repeat(32));
  assert.deepEqual(twilio.calls.map((c) => [c.name, c.scope, c.accountSid]),
    [["fetchSubaccountWithToken", "subaccount_token", BHG_LIKE], ["createSubaccountKey", "subaccount_token", BHG_LIKE]]);
  assert.ok(noSecrets(r.text));
  // Linking again changes nothing: key exists, row exists.
  const again = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(again.status, 200);
  assert.equal(again.body.key, "existing");
  assert.equal(store.s.rpcs.filter((x) => x.fn === "communication_register_account").length, 1);
});

test("link_subaccount: no token in Vault for that SID → 409 naming the exact secret and the SID that has one; nothing registered, no key minted", async () => {
  const { call, twilio, store } = setup({ accounts: { [CLIENT]: null }, secrets: { [BHG_TOKEN_NAME]: "bhg-token-placeholder-0000000000" } });
  const typed = "AC" + "5".repeat(32);
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: typed });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "auth_token_missing");
  assert.equal(r.body.auth_token_secret, `TWILIO_SUB_${typed}_AUTH_TOKEN`);
  assert.ok(r.body.other_auth_token_accounts.includes(BHG_LIKE));
  assert.match(r.body.error, new RegExp(`TWILIO_SUB_${typed}_AUTH_TOKEN`));
  assert.match(r.body.error, new RegExp(BHG_LIKE));
  assert.ok(!store.s.rpcs.some((x) => x.fn === "communication_register_account"));
  assert.ok(!twilio.calls.some((c) => c.name === "createSubaccountKey"));
  assert.ok(noSecrets(r.text));
});

test("link_subaccount: a SID typed with upper-case hex is accepted; Twilio's spelling names the row and the secrets", async () => {
  const { call, store } = setup({ accounts: { [CLIENT]: null }, secrets: { [BHG_TOKEN_NAME]: "bhg-token-placeholder-0000000000" } });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: "AC" + BHG_LIKE.slice(2).toUpperCase() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.s.rpcs.find((x) => x.fn === "communication_register_account").p.account_sid, BHG_LIKE);
});

test("link_subaccount: a token stored under the SID in another letter case is found (one Vault read, case-insensitive on the SID)", async () => {
  const { call } = setup({ accounts: { [CLIENT]: null }, secrets: { [`TWILIO_SUB_AC${BHG_LIKE.slice(2).toUpperCase()}_AUTH_TOKEN`]: "bhg-token-placeholder-0000000000" } });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("link_subaccount: finishes a subaccount a partial create registered (no second row)", async () => {
  const { call, store } = setup({ accounts: { [CLIENT]: { id: "acct-1", provider_account_sid: BHG_LIKE, status: "active" } },
    secrets: { [BHG_TOKEN_NAME]: "bhg-token-placeholder-0000000000" } });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!store.s.rpcs.some((x) => x.fn === "communication_register_account"));
  const other = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: SUB_OTHER });
  assert.equal(other.body.code, "account_exists");
});

test("link_subaccount: direct fetch would answer 20404 to the parent key, the parent's Accounts list has the SID → linked, key minted with the subaccount's token", async () => {
  const { call, twilio, store } = setup({ accounts: { [CLIENT]: null }, secrets: { [BHG_TOKEN_NAME]: "bhg-token-placeholder-0000000000" } });
  await assert.rejects(twilio.fetchSubaccount({ scope: "parent", accountSid: PARENT }, BHG_LIKE), /20404|not found/);
  twilio.calls.length = 0;
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.key, "created");
  assert.ok(twilio.calls.some((c) => c.name === "fetchSubaccountWithToken"), "the subaccount verifies itself with its Auth Token");
  const mint = twilio.calls.find((c) => c.name === "createSubaccountKey");
  assert.equal(mint.scope, "subaccount_token");
  assert.equal(mint.args.withToken, true);
  assert.equal(store.s.rpcs.filter((x) => x.fn === "communication_register_account").length, 1);
  assert.ok(noSecrets(r.text));
});

test("link_subaccount: only a live subaccount of Compass's parent is linked; refusals register nothing and mint nothing", async () => {
  const cases = [
    [{ foreignOwner: true }, SUB_OTHER, "not_a_subaccount"],
    [{ closed: true }, SUB_OTHER, "subaccount_closed"],
    [{}, PARENT, "not_a_subaccount"],
  ];
  for (const [o, sid, code] of cases) {
    const { call, twilio, store } = setup({ accounts: { [CLIENT]: null }, secrets: { [`TWILIO_SUB_${sid}_AUTH_TOKEN`]: "sub-token" }, ...o });
    const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: sid });
    assert.equal(r.status, 409, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
    assert.ok(!store.s.rpcs.some((x) => x.fn === "communication_register_account"), code);
    assert.ok(!twilio.calls.some((c) => c.name === "createSubaccountKey"), code);
    assert.ok(noSecrets(r.text));
  }
});

test("link_subaccount: the key could not be minted → 207 partial; the registration stays, a retry finishes it", async () => {
  const { call, store } = setup({ accounts: { [CLIENT]: null }, secrets: { [BHG_TOKEN_NAME]: "bhg-token-placeholder-0000000000" },
    keyError: new ProviderError(403, "20003", "Authenticate") });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(r.status, 207);
  assert.equal(r.body.key, "missing");
  assert.equal(r.body.twilio_code, "20003");
  assert.equal(store.s.rpcs.filter((x) => x.fn === "communication_register_account").length, 1);
});

test("a Vault read that fails is an error (424 vault_read), never reported as a credential to store", async () => {
  const { call, store } = setup({ accounts: { [CLIENT]: null }, vaultDown: true });
  const r = await call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(r.status, 424);
  assert.equal(r.body.code, "vault_read");
  assert.doesNotMatch(r.text, /AUTH_TOKEN/);
  assert.ok(!store.s.rpcs.some((x) => x.fn === "communication_register_account"));
});

test("Twilio failures answer 424, never 5xx (the gateway replaces a 5xx body)", async () => {
  const { call } = setup({ standardKey: true });
  const r = await call("jwt-admin", { mode: "check_parent" });
  assert.equal(r.status, 200);
  const off = setup({ accounts: { [CLIENT]: null } });
  off.twilio.fetchSubaccountWithToken = async () => { throw new ProviderError(401, "20003", "Authenticate"); };
  const l = await off.call("jwt-admin", { mode: "link_subaccount", client_id: CLIENT, account_sid: BHG_LIKE });
  assert.equal(l.status, 424);
  assert.equal(l.body.twilio_code, "20003");
});

test("link_number: a phone number SID with upper-case hex is accepted", async () => {
  const r = await setup().call("jwt-admin", { mode: "link_number", client_id: CLIENT, number_sid: "PN" + "ABCDEF0123456789abcdef0123456789" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
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
