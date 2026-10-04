// Browser check for Client › Communications (0063). Run by
// `npm run test:communications-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): a real Postgres replay behind PostgREST, `next dev` and Chromium. The
// gateway routes /functions/v1/communications to the deployed handler and
// store with a fake Twilio, so the composer's Send goes the whole way.
// Nothing leaves the machine. SCREENSHOTS=dir saves each page.
//
//   - Overview: primary number, verification status, unread, recent messages.
//   - Inbox: list → thread → contact; opening marks it read; Send from the UI;
//     an opted-out contact's composer is replaced by the reason.
//   - Numbers: the table; search shows numbers and buys nothing.
//   - Compliance: pipeline, registrations, checklist.
//   - Settings: switches, configuration; no credential on any page.
//   - A portal contact never reaches any of it.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createCommunications } from "../supabase/functions/communications/handler.ts";
import { createStore } from "../supabase/functions/communications/store.ts";
import { createTwilioProvider } from "../supabase/functions/_shared/communications/twilio.ts";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));
const CLIENT = "00000000-0000-4000-b000-00000000000a";
const ACCT = "AC" + "a1".repeat(16);
const PARENT_SECRET = "PARENT-SECRET-NEVER-SHOWN";
const SUB_TOKEN = "SUB-TOKEN-NEVER-SHOWN";
const SUB_SECRET = "SUB-KEY-SECRET-NEVER-SHOWN";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function sign(claims) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
}
function verify(token) {
  const [h, p, s] = (token ?? "").split(".");
  if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const anonKey = sign({ role: "anon", exp: exp() });
const serviceKey = sign({ role: "service_role", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL_ADMIN} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

// A fake Twilio for the function: sends and toll-free searches only.
const twilio = { sent: [], purchased: [] };
const twilioFetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  if (u.pathname.endsWith("/Messages.json")) {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    twilio.sent.push(form);
    return json(201, { sid: "SM" + String(twilio.sent.length).padStart(32, "0"), status: "queued" });
  }
  if (u.pathname.endsWith("/AvailablePhoneNumbers/US/TollFree.json")) {
    return json(200, { available_phone_numbers: [{ phone_number: "+18005550111", friendly_name: "(800) 555-0111", capabilities: { voice: true, SMS: true, MMS: false } }] });
  }
  if (u.pathname.endsWith("/IncomingPhoneNumbers.json")) twilio.purchased.push(u.pathname);
  return json(404, { code: 20404, message: "not in this fake" });
};

// Supabase's gateway, reduced to what the app calls: /auth/v1/user, /rest/v1
// and the communications function.
const unexpected = [];
let comms;
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname === "/functions/v1/communications") {
    const r = await comms.handle(new Request("http://edge.local/communications", { method: req.method, headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" }, body: Buffer.concat(chunks) }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = upstream.headers.get(k); if (v) h[k] = v; }
    res.writeHead(upstream.status, h);
    return res.end(out);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
comms = createCommunications({
  store: createStore(createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })),
  provider: createTwilioProvider(twilioFetch),
  webhookBase: async () => "https://sandbox-ref.supabase.co/functions/v1/twilio-webhook",
});

// ── Fixtures (the fixtures login; the guards let it through) ────────────────
const id = (k) => sql(`select md5('cmui:${k}')::uuid`);
const [acct, svc, num, cp, tfv, pat, sam, c1, c2] = ["acct", "svc", "num", "cp", "tfv", "pat", "sam", "c1", "c2"].map(id);
const member = sql(`select id from team_members where auth_user_id = '${TEAM.id}'`);
sql(`update team_members set role = 'admin' where id = '${member}'`);
sql(`insert into client_communication_settings (client_id, enabled, outbound_enabled, display_name) values ('${CLIENT}', true, true, 'Sandbox Safety')`);
sql(`insert into communication_accounts (id, client_id, provider_account_sid, friendly_name) values ('${acct}', '${CLIENT}', '${ACCT}', 'Compass - Sandbox Client A')`);
sql(`insert into communication_messaging_services (id, client_id, communication_account_id, provider_service_sid, friendly_name) values ('${svc}', '${CLIENT}', '${acct}', 'MG${"b2".repeat(16)}', 'Sandbox Safety Messaging')`);
sql(`insert into communication_numbers (id, client_id, communication_account_id, messaging_service_id, provider_phone_number_sid, phone_number_e164, friendly_name, number_type, voice_enabled, sms_enabled, is_primary, purchased_at)
     values ('${num}', '${CLIENT}', '${acct}', '${svc}', 'PN${"c3".repeat(16)}', '+18005550100', 'Sandbox toll-free', 'toll_free', true, true, true, now() - interval '3 days')`);
sql(`insert into communication_compliance_profiles (id, client_id, profile_type, provider_profile_sid, provider_status, status, legal_business_name, website_url, privacy_url, terms_url, submitted_at, approved_at, last_synced_at)
     values ('${cp}', '${CLIENT}', 'secondary_customer_profile', 'BU${"d4".repeat(16)}', 'twilio-approved', 'approved', 'Sandbox Safety LLC', 'https://a.example.test', 'https://a.example.test/privacy', 'https://a.example.test/terms', now() - interval '5 days', now() - interval '4 days', now())`);
sql(`insert into communication_compliance_profiles (id, client_id, profile_type, communication_number_id, provider_profile_sid, provider_status, status, use_case_categories, message_volume, opt_in_type, opt_in_url, privacy_url, terms_url, submitted_at, last_synced_at)
     values ('${tfv}', '${CLIENT}', 'toll_free_verification', '${num}', 'HH${"e5".repeat(16)}', 'IN_REVIEW', 'in_review', '{CUSTOMER_CARE}', '1,000', 'WEB_FORM', 'https://a.example.test/contact', 'https://a.example.test/privacy', 'https://a.example.test/terms', now() - interval '2 days', now())`);
sql(`select communication_ensure_checklist('${tfv}')`);
sql(`insert into contacts (id, client_id, first_name, last_name, company, phone_e164, source) values
     ('${pat}', '${CLIENT}', 'Pat', 'Lee', 'River Plant', '+15735550101', 'inbound_sms'), ('${sam}', '${CLIENT}', 'Sam', 'Stone', null, '+15735550102', 'inbound_sms')`);
sql(`insert into communication_consents (client_id, contact_id, phone_e164, status, source, evidence, consented_at) values ('${CLIENT}', '${pat}', '+15735550101', 'granted', 'web_form', 'Opt-in box ticked on /contact', now() - interval '1 day')`);
sql(`insert into communication_consents (client_id, contact_id, phone_e164, status, source, evidence, revoked_at) values ('${CLIENT}', '${sam}', '+15735550102', 'opted_out', 'inbound_sms', 'Recipient texted STOP', now() - interval '1 hour')`);
sql(`insert into communication_conversations (id, client_id, contact_id, communication_number_id, last_message_at, last_message_preview, last_direction, unread_count) values
     ('${c1}', '${CLIENT}', '${pat}', '${num}', now() - interval '5 minutes', 'Great, thanks', 'inbound', 1),
     ('${c2}', '${CLIENT}', '${sam}', '${num}', now() - interval '1 hour', 'STOP', 'inbound', 0)`);
sql(`insert into communication_messages (client_id, conversation_id, provider_message_sid, request_id, direction, from_e164, to_e164, body, provider_status, sent_by, opt_out_type, created_at) values
     ('${CLIENT}', '${c1}', 'SM${"01".repeat(16)}', null, 'inbound', '+15735550101', '+18005550100', 'Is the CPR class still on Tuesday?', 'received', null, null, now() - interval '30 minutes'),
     ('${CLIENT}', '${c1}', 'SM${"02".repeat(16)}', gen_random_uuid(), 'outbound', '+18005550100', '+15735550101', 'Yes, Tuesday at 9am.', 'delivered', '${member}', null, now() - interval '20 minutes'),
     ('${CLIENT}', '${c1}', 'SM${"03".repeat(16)}', null, 'inbound', '+15735550101', '+18005550100', 'Great, thanks', 'received', null, null, now() - interval '5 minutes'),
     ('${CLIENT}', '${c2}', 'SM${"04".repeat(16)}', null, 'inbound', '+15735550102', '+18005550100', 'STOP', 'received', null, 'STOP', now() - interval '1 hour')`);
sql(`select vault.create_secret('${ACCT.replace("a1", "00")}', 'TWILIO_ACCOUNT_SID'); select vault.create_secret('SKparent', 'TWILIO_API_KEY'); select vault.create_secret('${PARENT_SECRET}', 'TWILIO_API_SECRET');
     select vault.create_secret('SKsub', 'TWILIO_SUB_${ACCT}_API_KEY'); select vault.create_secret('${SUB_SECRET}', 'TWILIO_SUB_${ACCT}_API_SECRET'); select vault.create_secret('${SUB_TOKEN}', 'TWILIO_SUB_${ACCT}_AUTH_TOKEN')`);

const port = Number(process.env.COMMS_UI_PORT ?? 3431);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}

const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const noSecrets = async (page, where) => {
  const html = await page.content();
  for (const s of [PARENT_SECRET, SUB_TOKEN, SUB_SECRET]) assert.ok(!html.includes(s), `${where} shows a credential`);
};
const waitFor = async (fn, what) => {
  for (let i = 0; i < 40; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 250)); }
  assert.fail(`timed out: ${what}`);
};

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const team = await (await contextFor(browser, TEAM)).newPage();
  const errors = [];
  team.on("pageerror", (e) => errors.push(e.message));
  const root = `${base}/clients/${CLIENT}/communications`;

  // Overview.
  await team.goto(root, { waitUntil: "networkidle" });
  assert.ok(await team.getByRole("link", { name: "Communications" }).first().isVisible(), "the client tab");
  const overview = await team.locator("main").innerText();
  for (const t of ["(800) 555-0100", "Verification in review", "Sending on", "Sandbox Safety Messaging", "Great, thanks", "Twilio: IN_REVIEW"]) {
    assert.ok(overview.includes(t), `overview shows ${t}`);
  }
  await noSecrets(team, "Overview");
  await shot(team, "overview");
  ok("Overview: primary number, verification in review, sending on, recent messages");

  // Inbox: open Pat's thread; it is marked read.
  await team.goto(`${root}/inbox?filter=unread`, { waitUntil: "networkidle" });
  await team.getByRole("link", { name: /Pat Lee/ }).first().click();
  await team.waitForURL(/c=/);
  await team.getByText("Is the CPR class still on Tuesday?").waitFor();
  assert.ok(await team.getByText("Yes, Tuesday at 9am.").isVisible());
  assert.ok(await team.getByText("Consent on record").isVisible());
  await waitFor(() => sql(`select unread_count from communication_conversations where id = '${c1}'`) === "0", "the thread is marked read");
  await shot(team, "inbox");
  ok("Inbox: list → thread → contact with consent; opening marks it read");

  // Send from the UI: through the function, the subaccount key, the Messaging Service.
  await team.getByRole("textbox", { name: "Message" }).fill("See you Tuesday. Bring a photo ID.");
  await team.getByRole("button", { name: "Send SMS" }).click();
  await team.getByRole("status").filter({ hasText: "Sent." }).waitFor();
  await team.getByText("See you Tuesday. Bring a photo ID.").waitFor();
  assert.equal(twilio.sent.length, 1);
  assert.equal(twilio.sent[0].To, "+15735550101");
  assert.equal(twilio.sent[0].MessagingServiceSid, "MG" + "b2".repeat(16));
  assert.equal(sql(`select provider_status || '|' || (sent_by = '${member}') from communication_messages where body = 'See you Tuesday. Bring a photo ID.'`), "queued|true");
  ok("Inbox: Send SMS goes through the function with the subaccount key and records Twilio's SID");

  // The opted-out contact: the composer is replaced by the reason.
  await team.goto(`${root}/inbox?c=${c2}&filter=all`, { waitUntil: "networkidle" });
  assert.ok(await team.getByText("Opted out (STOP)").isVisible());
  assert.ok(await team.getByText(/texted STOP\. Only the recipient can opt back in/).first().isVisible());
  assert.equal(await team.getByRole("button", { name: "Send SMS" }).count(), 0);
  await noSecrets(team, "Inbox");
  ok("Inbox: an opted-out recipient has no composer, only the reason");

  // Numbers.
  await team.goto(`${root}/numbers`, { waitUntil: "networkidle" });
  const numbers = await team.locator("main").innerText();
  for (const t of ["(800) 555-0100", "primary", "SMS · Voice", "Sandbox Safety Messaging", "In review", ACCT]) assert.ok(numbers.includes(t), `numbers shows ${t}`);
  await team.getByRole("button", { name: "Search available numbers" }).click();
  await team.getByText("(800) 555-0111").waitFor();
  assert.equal(twilio.purchased.length, 0, "a search buys nothing");
  await noSecrets(team, "Numbers");
  await shot(team, "numbers");
  ok("Numbers: the table and a search that buys nothing");

  // Compliance.
  await team.goto(`${root}/compliance`, { waitUntil: "networkidle" });
  const compliance = await team.locator("main").innerText();
  for (const t of ["Verification in review", "Twilio: IN_REVIEW", "Twilio: twilio-approved", "(0/12)", "https://a.example.test/privacy", "Compass never stores the EIN"]) {
    assert.ok(compliance.includes(t), `compliance shows ${t}`);
  }
  await shot(team, "compliance");
  ok("Compliance: pipeline, both registrations as Twilio reports them, the checklist");

  // Settings.
  await team.goto(`${root}/settings`, { waitUntil: "networkidle" });
  assert.ok(await team.getByLabel("Communications enabled for this client").isChecked());
  const settings = await team.locator("main").innerText();
  for (const t of ["/functions/v1/twilio-webhook/messages/inbound", "/functions/v1/twilio-webhook/messages/status", "Parent Main key"]) assert.ok(settings.includes(t), `settings shows ${t}`);
  await noSecrets(team, "Settings");
  await shot(team, "settings");
  ok("Settings: switches and configuration; no credential on any page");

  // A portal contact never reaches it.
  const portal = await (await contextFor(browser, PORTAL)).newPage();
  await portal.goto(`${root}/inbox`, { waitUntil: "networkidle" });
  assert.ok(!(await portal.content()).includes("Pat Lee"), "the portal contact sees no contact");
  assert.ok(new URL(portal.url()).pathname.startsWith("/portal"), `the portal contact is sent to the portal (${portal.url()})`);
  const raw = await (await fetch(`${gatewayUrl}/rest/v1/communication_messages?select=body`, { headers: { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}` } })).json();
  assert.deepEqual(raw, []);
  ok("Portal: a client contact is sent to the portal and reads no messages through the API");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Communications browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
