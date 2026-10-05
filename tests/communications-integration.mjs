// End-to-end check of Compass Communications (0063) against a real database:
// the full migration replay behind PostgREST, so every write the functions
// make arrives as session_user authenticator / role service_role — the
// identity 0063's write functions accept — and every teammate write as
// authenticator / authenticated with a team JWT. The handlers and stores are
// the deployed ones (supabase/functions/communications, twilio-webhook) and
// the webhook signatures are the official SDK's; only Twilio is fake. No
// request leaves the machine.
//
//   npm run test:communications     (scripts/test-tasks-ui.sh with UI_SPEC set)
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import webhooks from "twilio/lib/webhooks/webhooks.js";
import { createCommunications } from "../supabase/functions/communications/handler.ts";
import { createStore as createCommsStore } from "../supabase/functions/communications/store.ts";
import { createTwilioWebhook } from "../supabase/functions/twilio-webhook/handler.ts";
import { createStore as createWebhookStore } from "../supabase/functions/twilio-webhook/store.ts";
import { createTwilioProvider } from "../supabase/functions/_shared/communications/twilio.ts";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through npm run test:communications");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const CA = "00000000-0000-4000-b000-00000000000a";
const CB = "00000000-0000-4000-b000-00000000000b";
const PARENT = "AC" + "0".repeat(32);
const BASE = "https://sandbox-ref.supabase.co/functions/v1/twilio-webhook";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const serviceKey = sign({ role: "service_role", exp: exp() });
const anonKey = sign({ role: "anon", exp: exp() });
const teamToken = sign({ sub: TEAM.id, role: "authenticated", aud: "authenticated", email: TEAM.email, exp: exp() });

const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

// Supabase's gateway, reduced to /auth/v1/user and /rest/v1.
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const ok = bearer === teamToken;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(ok ? { id: TEAM.id, email: TEAM.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await up.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status, h);
    return res.end(out);
  }
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const team = createClient(gatewayUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${teamToken}` } } });

// ── A fake Twilio (REST) ────────────────────────────────────────────────────
const hex = (n, c) => c + n.toString(16).padStart(32, "0");
const tw = { subaccounts: new Map(), sent: [], purchased: [], services: [], nextSid: 1, sendError: null, tfvStatus: "IN_REVIEW", authUsed: [] };
const SECRETS_SEEN = new Set(["parent-main-secret"]);
// A subaccount as Twilio holds it (made by Compass's create, or by a person in
// the Console): its Auth Token exists only here and in the Console.
function consoleSubaccount(name) {
  const sid = hex(tw.nextSid++, "AC"); const token = `token-${randomUUID()}`;
  SECRETS_SEEN.add(token);
  tw.subaccounts.set(sid, { token, name });
  return sid;
}
const twilioFetch = async (url, init = {}) => {
  const u = new URL(url);
  const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  const [keySid] = Buffer.from(String(init.headers.Authorization).replace(/^Basic /, ""), "base64").toString().split(":");
  tw.authUsed.push({ path: u.pathname, keySid });
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const p = u.pathname;
  // Like Twilio with an API key: a subaccount's Auth Token is never in the
  // answer (it is shown in the Twilio Console; tw.subaccounts holds it).
  if (p === "/2010-04-01/Accounts.json" && init.method === "POST") {
    const sid = consoleSubaccount(form.FriendlyName);
    return json(201, { sid, friendly_name: form.FriendlyName, status: "active", owner_account_sid: PARENT });
  }
  if (p === "/2010-04-01/Accounts.json" && init.method === "GET") {
    const name = u.searchParams.get("FriendlyName");
    return json(200, { accounts: [...tw.subaccounts].filter(([, a]) => a.name === name).map(([sid, a]) => ({ sid, friendly_name: a.name, status: "active", owner_account_sid: PARENT })) });
  }
  let m = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\.json$/.exec(p);
  if (m) {
    if (m[1] === PARENT) return json(200, { sid: PARENT, status: "active", owner_account_sid: PARENT });
    const sid = "AC" + m[1].slice(2).toLowerCase();
    const sa = tw.subaccounts.get(sid);
    return sa ? json(200, { sid, friendly_name: sa.name, status: "active", owner_account_sid: PARENT }) : json(404, { code: 20404, message: "not found" });
  }
  m = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Keys\.json$/.exec(p);
  if (m) { const secret = `key-secret-${randomUUID()}`; SECRETS_SEEN.add(secret); return json(201, { sid: hex(tw.nextSid++, "SK"), secret }); }
  if (p === "/v1/Services" && u.host === "messaging.twilio.com") { const sid = hex(tw.nextSid++, "MG"); tw.services.push({ sid, form }); return json(201, { sid, friendly_name: form.FriendlyName }); }
  if (/^\/v1\/Services\/MG[0-9a-f]{32}\/PhoneNumbers$/.test(p)) return json(201, { sid: form.PhoneNumberSid });
  if (/\/AvailablePhoneNumbers\/US\/TollFree\.json$/.test(p)) {
    const ac = u.searchParams.get("AreaCode");
    return json(200, { available_phone_numbers: ac === "800"
      ? [{ phone_number: "+18005550100", friendly_name: "(800) 555-0100", capabilities: { voice: true, SMS: true, MMS: true } }]
      : [{ phone_number: "+18885550200", friendly_name: "(888) 555-0200", capabilities: { voice: true, SMS: true, MMS: false } }] });
  }
  m = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/IncomingPhoneNumbers\.json$/.exec(p);
  if (m) { const sid = hex(tw.nextSid++, "PN"); tw.purchased.push(form.PhoneNumber); return json(201, { sid, phone_number: form.PhoneNumber, friendly_name: form.FriendlyName, account_sid: m[1], capabilities: { voice: true, sms: true, mms: true } }); }
  m = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Messages\.json$/.exec(p);
  if (m) {
    if (tw.sendError) return json(400, tw.sendError);
    const sid = hex(tw.nextSid++, "SM");
    tw.sent.push({ account: m[1], sid, ...form });
    return json(201, { sid, status: "queued", error_code: null, error_message: null });
  }
  m = /^\/v1\/Tollfree\/Verifications\/(HH[0-9a-f]{32})$/.exec(p);
  if (m) return json(200, { sid: m[1], status: tw.tfvStatus, date_created: "2026-10-02T12:00:00Z", edit_allowed: null });
  return json(404, { code: 20404, message: `fake Twilio has no ${p}` });
};

const logs = [];
const comms = createCommunications({ store: createCommsStore(service), provider: createTwilioProvider(twilioFetch), webhookBase: async () => BASE, log: (e, d) => logs.push({ e, ...d }) });
const hook = createTwilioWebhook({
  store: createWebhookStore(service),
  validate: (t, s, u, p) => webhooks.validateRequest(t, s, u, p),
  publicBase: async () => BASE,
  log: (e, d) => logs.push({ e, ...d }),
});

const responses = [];
async function call(body, token = teamToken) {
  const res = await comms.handle(new Request("http://edge.local/communications", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: JSON.parse(text) };
}
async function twilioPost(route, params, token, query = "") {
  const sig = webhooks.getExpectedTwilioSignature(token, `${BASE}${route}${query}`, params);
  const res = await hook.handle(new Request(`http://edge.local/twilio-webhook${route}${query}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params).toString(),
  }));
  responses.push(await res.clone().text());
  return res;
}
const vault = (name) => sql(`select decrypted_secret from vault.decrypted_secrets where name = '${name}'`);

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`); }
}

// Parent Main key in Vault; the sandbox team account is Compass's admin.
sql(`select vault.create_secret('${PARENT}', 'TWILIO_ACCOUNT_SID'); select vault.create_secret('SK${"p".repeat(32)}', 'TWILIO_API_KEY'); select vault.create_secret('parent-main-secret', 'TWILIO_API_SECRET')`);
sql(`update team_members set role = 'admin' where auth_user_id = '${TEAM.id}'`);

let acctA, acctB, tokenA, tokenB, numberA, conversationA, contactA;

await check("a teammate turns communications on (PostgREST, team JWT)", async () => {
  const { error } = await team.from("client_communication_settings").insert([
    { client_id: CA, enabled: true, outbound_enabled: true }, { client_id: CB, enabled: true, outbound_enabled: true }]);
  assert.equal(error, null, error?.message);
});

// An operator storing a subaccount's Auth Token by hand, as production does:
// psql as postgres, vault.create_secret(value, name).
const storeToken = (name, value) => sql(`select vault.create_secret('${value}', '${name}')`);
const tokenName = (sid) => `TWILIO_SUB_${sid}_AUTH_TOKEN`;

await check("create_subaccount (A): Twilio creates it but returns no Auth Token → recorded at once, key minted, 207 naming the exact secret", async () => {
  const a = await call({ mode: "create_subaccount", client_id: CA, confirm: sql(`select name from clients where id = '${CA}'`) });
  assert.equal(a.status, 207, JSON.stringify(a.body));
  acctA = a.body.account_sid;
  assert.equal(a.body.key, "created");
  assert.equal(a.body.auth_token, "missing");
  assert.equal(a.body.auth_token_secret, tokenName(acctA));
  assert.equal(tokenName(acctA).length, 56);
  assert.equal(sql(`select count(*) from communication_accounts where client_id = '${CA}'`), "1", "the subaccount is recorded");
  assert.ok(vault(`TWILIO_SUB_${acctA}_API_SECRET`).startsWith("key-secret-"));
  assert.equal(vault(tokenName(acctA)), "");
  const again = await call({ mode: "create_subaccount", client_id: CA, confirm: sql(`select name from clients where id = '${CA}'`) });
  assert.equal(again.body.code, "account_exists");
  assert.equal(tw.subaccounts.size, 1, "never a second subaccount");
  const parentUses = tw.authUsed.filter((x) => x.keySid === "SK" + "p".repeat(32)).map((x) => x.path);
  assert.ok(parentUses.every((pth) => /\/Accounts(\.json|\/AC[0-9a-f]{32}(\.json|\/Keys\.json))$/.test(pth)), parentUses.join(", "));
});

await check("the production symptom through PostgREST: get_secret answers a 56-character dynamic name, and null (200) for another SID's name", async () => {
  tokenA = tw.subaccounts.get(acctA).token;
  storeToken(tokenName(acctA), tokenA);
  const hit = await service.rpc("get_secret", { secret_name: tokenName(acctA) });
  assert.equal(hit.error, null);
  assert.equal(hit.data, tokenA);
  const miss = await service.rpc("get_secret", { secret_name: tokenName(hex(4242, "AC")) });
  assert.equal(miss.error, null);
  assert.equal(miss.data, null, "a name that differs in its SID is a 200 with null, exactly what production logged");
});

await check("A: with the token stored by hand, “Store the subaccount's key and token again” finishes it (200, no second row)", async () => {
  const r = await call({ mode: "link_subaccount", client_id: CA, account_sid: acctA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.key, "existing");
  assert.equal(r.body.auth_token, "stored in Vault");
  assert.equal(sql(`select count(*) from communication_accounts where client_id = '${CA}'`), "1");
  const status = await team.rpc("communication_secret_status", { p_account_sid: acctA });
  assert.equal(status.error, null, status.error?.message);
  assert.deepEqual([status.data.parent, status.data.subaccount_key, status.data.subaccount_auth_token], [true, true, true]);
  assert.ok(!JSON.stringify(status.data).includes(tokenA));
});

await check("B (made in the Twilio Console): create is refused (it exists by name); link with the token under another SID → 409 naming the exact secret, nothing recorded", async () => {
  const nameB = sql(`select name from clients where id = '${CB}'`);
  acctB = consoleSubaccount(`Compass - ${nameB}`);
  tokenB = tw.subaccounts.get(acctB).token;
  const dup = await call({ mode: "create_subaccount", client_id: CB, confirm: nameB });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "subaccount_exists_in_twilio");
  assert.deepEqual(dup.body.account_sids, [acctB]);
  assert.equal(tw.subaccounts.size, 2, "nothing created");
  // The token stored under a SID that is not B's (a slip copying the SID).
  const wrong = hex(4343, "AC");
  storeToken(tokenName(wrong), tokenB);
  const r = await call({ mode: "link_subaccount", client_id: CB, account_sid: acctB });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "auth_token_missing");
  assert.equal(r.body.auth_token_secret, tokenName(acctB));
  assert.ok(r.body.other_auth_token_accounts.includes(wrong));
  assert.match(r.body.error, new RegExp(tokenName(acctB)));
  assert.equal(sql(`select count(*) from communication_accounts where client_id = '${CB}'`), "0");
  sql(`delete from vault.secrets where name = '${tokenName(wrong)}'`);
});

await check("B: the token stored under the SID with upper-case hex, the link typed in upper case → linked with Twilio's spelling, key minted", async () => {
  storeToken(`TWILIO_SUB_AC${acctB.slice(2).toUpperCase()}_AUTH_TOKEN`, tokenB);
  const r = await call({ mode: "link_subaccount", client_id: CB, account_sid: `AC${acctB.slice(2).toUpperCase()}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account_sid, acctB);
  assert.equal(r.body.key, "created");
  assert.equal(sql(`select provider_account_sid from communication_accounts where client_id = '${CB}'`), acctB);
  assert.ok(vault(`TWILIO_SUB_${acctB}_API_SECRET`).startsWith("key-secret-"));
});

await check("Messaging Service, search (buys nothing), confirmed purchase: all with the subaccount's own key", async () => {
  const before = tw.authUsed.length;
  assert.equal((await call({ mode: "create_messaging_service", client_id: CA })).status, 200);
  const s = await call({ mode: "search_numbers", client_id: CA });
  assert.equal(s.body.purchased, false);
  assert.equal(s.body.numbers[0].phone_number, "+18005550100");
  assert.equal(tw.purchased.length, 0);
  const p = await call({ mode: "purchase_number", client_id: CA, phone_number: "+18005550100", confirm: "+18005550100" });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok(String(p.body.messaging_service).startsWith("MG"));
  assert.ok(tw.authUsed.slice(before).every((x) => x.keySid !== "SK" + "p".repeat(32)), "no parent key for client operations");
  numberA = sql(`select id from communication_numbers where client_id = '${CA}'`);
  assert.equal(sql(`select is_primary and messaging_service_id is not null from communication_numbers where id = '${numberA}'`), "t");
  assert.equal(tw.services[0].form.InboundRequestUrl, `${BASE}/messages/inbound`);
  // Client B gets its own number in its own service.
  await call({ mode: "create_messaging_service", client_id: CB });
  await call({ mode: "purchase_number", client_id: CB, phone_number: "+18885550200", confirm: "+18885550200" });
});

const inbound = (o = {}) => ({ MessageSid: hex(9001, "SM"), AccountSid: acctA, From: "+15735550101", To: "+18005550100", Body: "Is the CPR class still on Tuesday?", NumMedia: "0", ApiVersion: "2010-04-01", ...o });

await check("inbound SMS (signed with the subaccount's token): contact, thread and message are created; empty TwiML", async () => {
  const res = await twilioPost("/messages/inbound", inbound(), tokenA);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Response><\/Response>/);
  contactA = sql(`select id from contacts where client_id = '${CA}' and phone_e164 = '+15735550101'`);
  conversationA = sql(`select id from communication_conversations where client_id = '${CA}' and contact_id = '${contactA}'`);
  assert.ok(contactA && conversationA);
  assert.equal(sql(`select unread_count from communication_conversations where id = '${conversationA}'`), "1");
  assert.equal(sql(`select provider_status || '|' || direction from communication_messages where provider_message_sid = '${hex(9001, "SM")}'`), "received|inbound");
});

await check("a Twilio retry of the same MessageSid is recorded once", async () => {
  assert.equal((await twilioPost("/messages/inbound", inbound(), tokenA)).status, 200);
  assert.equal(sql(`select count(*) from communication_messages where provider_message_sid = '${hex(9001, "SM")}'`), "1");
  assert.equal(sql(`select unread_count from communication_conversations where id = '${conversationA}'`), "1");
});

await check("cross-tenant: A's account cannot deliver to B's number; B's token cannot sign A's webhooks", async () => {
  assert.equal((await twilioPost("/messages/inbound", inbound({ MessageSid: hex(9002, "SM"), To: "+18885550200" }), tokenA)).status, 404);
  assert.equal((await twilioPost("/messages/inbound", inbound({ MessageSid: hex(9003, "SM") }), tokenB)).status, 403);
  assert.equal(sql(`select count(*) from communication_messages where provider_message_sid in ('${hex(9002, "SM")}', '${hex(9003, "SM")}')`), "0");
});

await check("outbound without consent is refused before Twilio (a phone number is not consent)", async () => {
  const r = await call({ mode: "send", client_id: CA, conversation_id: conversationA, body: "Yes, Tuesday at 9.", request_id: randomUUID() });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "no_consent");
  assert.equal(tw.sent.length, 0);
});

let sentId;
await check("a teammate records consent; the send goes through the Messaging Service and records Twilio's SID", async () => {
  const { error } = await team.rpc("communication_record_consent", { p: { client_id: CA, phone_e164: "+15735550101", contact_id: contactA,
    status: "granted", source: "inbound_sms", evidence: "Texted first asking about the class; asked for a reply by text" } });
  assert.equal(error, null, error?.message);
  const requestId = randomUUID();
  const r = await call({ mode: "send", client_id: CA, conversation_id: conversationA, body: "Yes, Tuesday at 9.", request_id: requestId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sentId = r.body.message_id;
  assert.equal(tw.sent.length, 1);
  assert.equal(tw.sent[0].To, "+15735550101");
  assert.ok(tw.sent[0].MessagingServiceSid.startsWith("MG"));
  assert.equal(tw.sent[0].StatusCallback, `${BASE}/messages/status?m=${sentId}`);
  assert.equal(sql(`select provider_status from communication_messages where id = '${sentId}'`), "queued");
  const again = await call({ mode: "send", client_id: CA, conversation_id: conversationA, body: "Yes, Tuesday at 9.", request_id: requestId });
  assert.equal(again.body.duplicate, true);
  assert.equal(tw.sent.length, 1, "the same request never sends twice");
});

await check("delivery status callbacks: delivered recorded; a late 'sent' does not move it back; another account is refused", async () => {
  const sidOut = sql(`select provider_message_sid from communication_messages where id = '${sentId}'`);
  const q = `?m=${sentId}`;
  assert.equal((await twilioPost("/messages/status", { MessageSid: sidOut, AccountSid: acctA, MessageStatus: "delivered" }, tokenA, q)).status, 200);
  assert.equal((await twilioPost("/messages/status", { MessageSid: sidOut, AccountSid: acctA, MessageStatus: "sent" }, tokenA, q)).status, 200);
  assert.equal(sql(`select provider_status || '|' || (delivered_at is not null) from communication_messages where id = '${sentId}'`), "delivered|true");
  assert.equal((await twilioPost("/messages/status", { MessageSid: sidOut, AccountSid: acctB, MessageStatus: "failed" }, tokenB, q)).status, 403);
  assert.equal(sql(`select provider_status from communication_messages where id = '${sentId}'`), "delivered");
});

await check("STOP from the recipient (Twilio's OptOutType) opts them out; the next send is refused", async () => {
  assert.equal((await twilioPost("/messages/inbound", inbound({ MessageSid: hex(9010, "SM"), Body: "STOP", OptOutType: "STOP" }), tokenA)).status, 200);
  assert.equal(sql(`select status from communication_consents where client_id = '${CA}' and phone_e164 = '+15735550101'`), "opted_out");
  const r = await call({ mode: "send", client_id: CA, conversation_id: conversationA, body: "Are you sure?", request_id: randomUUID() });
  assert.equal(r.body.code, "opted_out");
  assert.equal(tw.sent.length, 1);
  const { error } = await team.rpc("communication_record_consent", { p: { client_id: CA, phone_e164: "+15735550101", status: "granted", source: "verbal", evidence: "x" } });
  assert.match(String(error?.message), /^opted_out:/, "a teammate cannot overwrite the recipient's STOP");
});

await check("a teammate cannot write messages directly; the service role cannot either", async () => {
  const t = await team.from("communication_messages").update({ body: "edited" }).eq("id", sentId);
  assert.ok(t.error, "team update refused");
  const s = await service.from("communication_messages").insert({ client_id: CA, conversation_id: conversationA, direction: "inbound", from_e164: "+15735550101", to_e164: "+18005550100", provider_status: "received", provider_message_sid: hex(9999, "SM") });
  assert.ok(s.error, "service insert refused");
});

await check("compliance: a teammate drafts and links the toll-free verification; Sync records Twilio's status", async () => {
  const { data, error } = await team.from("communication_compliance_profiles").insert({ client_id: CA, profile_type: "toll_free_verification",
    communication_number_id: numberA, use_case_categories: ["CUSTOMER_CARE"], message_volume: "1,000", opt_in_type: "WEB_FORM",
    privacy_url: "https://a.example.test/privacy", terms_url: "https://a.example.test/terms", opt_in_url: "https://a.example.test/contact" }).select("id").single();
  assert.equal(error, null, error?.message);
  const hh = hex(77, "HH");
  assert.equal((await team.from("communication_compliance_profiles").update({ provider_profile_sid: hh }).eq("id", data.id)).error, null);
  const r = await call({ mode: "sync_compliance", client_id: CA });
  assert.equal(r.body.results[0].status, "in_review");
  assert.equal(sql(`select provider_status || '|' || status from communication_compliance_profiles where id = '${data.id}'`), "IN_REVIEW|in_review");
  tw.tfvStatus = "TWILIO_APPROVED";
  await call({ mode: "sync_compliance", client_id: CA });
  assert.equal(sql(`select status || '|' || (approved_at is not null) from communication_compliance_profiles where id = '${data.id}'`), "approved|true");
  assert.ok((await team.from("communication_compliance_profiles").update({ status: "rejected" }).eq("id", data.id)).error, "status is Twilio's, never typed");
});

await check("a member who is not an admin cannot purchase or create subaccounts", async () => {
  sql(`update team_members set role = 'member' where auth_user_id = '${TEAM.id}'`);
  const r = await call({ mode: "purchase_number", client_id: CA, phone_number: "+18005550111", confirm: "+18005550111" });
  assert.equal(r.status, 403);
  assert.equal(tw.purchased.length, 2);
  sql(`update team_members set role = 'admin' where auth_user_id = '${TEAM.id}'`);
});

await check("no response and no log line carries a credential or an auth token", async () => {
  const all = responses.join("\n") + JSON.stringify(logs);
  for (const s of [...SECRETS_SEEN, tokenA, tokenB]) assert.ok(!all.includes(s), "a secret leaked");
  assert.ok(!JSON.stringify(logs).includes("CPR"), "a message body reached a log");
});

gateway.close();
console.log(failures ? `\n${failures} communications integration check(s) failed` : "\nall communications integration checks passed");
process.exit(failures ? 1 : 0);
