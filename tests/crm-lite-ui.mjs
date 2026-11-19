// End-to-end check for CRM Lite. Run by `npm run test:crm-lite-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, `next dev` and Chromium. The gateway serves the real
// inquiry-intake and crm-lite handlers and stores; Twilio is a fake that
// records any send. Fixtures are fictional (Sandbox Client A / B, 555
// numbers, example.test). SCREENSHOTS=dir saves each page.
//
//   - The website's server posts an inquiry with its source token: saved once
//     (a retry is the same inquiry), under the source's client; a token for
//     another source or a client id in the body cannot move it.
//   - Agency: list (newest first, status labels), search, filter, detail with
//     the full message, call / email links, Mark contacted, a note, history.
//   - Setup: the gates are shown closed; SMS alerts off; no text was sent.
//   - Portal contact of client A: Inquiries tab, own inquiries only, close
//     and reopen, a note under their own name; on a phone-sized screen.
//   - Portal contact of client B: client A's inquiry is a 404.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createInquiryIntake } from "../supabase/functions/inquiry-intake/handler.ts";
import { createStore as createIntakeStore } from "../supabase/functions/inquiry-intake/store.ts";
import { createCrmLite } from "../supabase/functions/crm-lite/handler.ts";
import { createStore as createCrmStore } from "../supabase/functions/crm-lite/store.ts";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL_A = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const PORTAL_B = { id: "00000000-0000-4000-a000-000000000012", email: "portal-b@example.test" };
const users = new Map([TEAM, PORTAL_A, PORTAL_B].map((u) => [u.id, u]));
const CLIENT_A = "00000000-0000-4000-b000-00000000000a";
const CLIENT_B = "00000000-0000-4000-b000-00000000000b";
const TOKEN_A = "cit_SANDBOX-TOKEN-A-NOT-REAL";
const TOKEN_B = "cit_SANDBOX-TOKEN-B-NOT-REAL";

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

const twilio = { sent: [] };
const twilioFetch = async (url, init = {}) => {
  twilio.sent.push({ url, body: init.body });
  return new Response(JSON.stringify({ sid: "SM" + "9".repeat(32), status: "queued" }), { status: 201 });
};

const unexpected = [];
// The lead composer check scripts client-phone's send answers here (armed only
// inside that check); every other time a mutation is unexpected. Nothing here
// reaches Twilio: the composer's own requests are recorded and answered.
const phone = { armed: false, replies: [], sends: [], autosaves: 0, messages: [] };
let intake, crm;
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
  // Communication UI status only. Mutations are never simulated as successful.
  if (url.pathname === "/functions/v1/client-phone" && phone.armed) {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const snapshot = () => ({ draft: null, messages: phone.messages, calls: [], number: "+18885550123", recipient: "+16185550142",
      can_send: true, reason: null, voice_ready: false });
    if (body.mode === "autosave") { phone.autosaves++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"saved":true}'); }
    if (body.mode === "send") {
      phone.sends.push({ body: body.body, request_id: body.request_id });
      const r = phone.replies.shift() ?? { state: "uncertain", code: "send_uncertain" };
      if (r.delay) await new Promise((ok) => setTimeout(ok, r.delay));
      if (r.state === "accepted") phone.messages = [...phone.messages, { id: body.request_id, direction: "outbound", body: body.body,
        provider_status: "queued", created_at: new Date().toISOString() }];
      res.writeHead(r.http ?? 200, { "content-type": "application/json" });
      return res.end(JSON.stringify(r.http ? { error: r.error } : { ...snapshot(), send: { state: r.state, code: r.code } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(body.mode === "voice_status" ? { enabled: false, number: null } : snapshot()));
  }
  if (["/functions/v1/client-mailbox", "/functions/v1/client-phone"].includes(url.pathname)) {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!["status", "load"].includes(body.mode)) unexpected.push(`communication mutation: ${body.mode}`);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ email: "leads@example.test", connected: false, draft: null, messages: [], calls: [], number: null, can_send: false, voice_ready: false, reason: "outbound_disabled" }));
  }
  const fn = url.pathname === "/functions/v1/inquiry-intake" ? intake : url.pathname === "/functions/v1/crm-lite" ? crm : null;
  if (fn) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await fn.handle(new Request(`http://edge.local${url.pathname}`, { method: req.method, headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) }));
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
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
intake = createInquiryIntake({ store: createIntakeStore(service) });
crm = createCrmLite({ store: createCrmStore(service), provider: (await import("../supabase/functions/_shared/communications/twilio.ts")).createTwilioProvider(twilioFetch),
  webhookBase: async () => "https://sandbox-ref.supabase.co/functions/v1/twilio-webhook" });

// ── Fixtures ───────────────────────────────────────────────────────────────
sql(`update team_members set role = 'admin' where auth_user_id = '${TEAM.id}'`);
sql(`update portal_users set name = 'Alex Owner' where email = 'portal-a@example.test'`);
sql(`insert into crm_lite_settings (client_id, enabled, portal_enabled) values ('${CLIENT_A}', true, true), ('${CLIENT_B}', true, true)`);
sql(`insert into inquiry_sources (client_id, source_key, label, site_url, enabled, secret_name) values
     ('${CLIENT_A}', 'sandbox-a-website', 'Sandbox A website', 'https://a.example.test', true, 'CRM_INTAKE_SANDBOX_A_WEBSITE'),
     ('${CLIENT_B}', 'sandbox-b-website', 'Sandbox B website', 'https://b.example.test', true, 'CRM_INTAKE_SANDBOX_B_WEBSITE')`);
sql(`select vault.create_secret('${TOKEN_A}', 'CRM_INTAKE_SANDBOX_A_WEBSITE'); select vault.create_secret('${TOKEN_B}', 'CRM_INTAKE_SANDBOX_B_WEBSITE')`);
sql(`insert into notification_senders (sender_key, label, provider_account_sid, phone_e164) values ('sandbox_alerts', 'Compass - Notifications (sandbox)', 'AC${"7".repeat(32)}', '+18885550199')`);
sql(`insert into notification_recipients (client_id, phone_e164, name) values ('${CLIENT_A}', '+16185550100', 'Owner mobile')`);

const post = (body, { key = "sandbox-a-website", token = TOKEN_A } = {}) => fetch(`${gatewayUrl}/functions/v1/inquiry-intake`, {
  method: "POST", headers: { "content-type": "application/json", "x-compass-source": key, authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});
const inquiry = (sub, o = {}) => ({ submission_id: sub, name: "Jordan Visitor", email: "jordan@example.test", phone: "(618) 555-0142",
  location: "Edwardsville, IL", service_type: "Kitchen & Bath", budget: "$25,000 - $50,000 (Multi-Room Update)",
  message: "We are remodeling our kitchen.\nCould you call after 5pm?", page_url: "https://a.example.test/contact/",
  submitted_at: new Date().toISOString(), email_status: "accepted", email_provider_id: "resend-fixture-1", ...o });

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };

// The website's server → inquiry-intake.
const first = await (await post(inquiry("2b6f0c4e-0000-4000-8000-000000000001"))).json();
const retry = await (await post(inquiry("2b6f0c4e-0000-4000-8000-000000000001"))).json();
assert.equal(first.ok, true);
assert.equal(retry.duplicate, true);
assert.equal(retry.inquiry_id, first.inquiry_id);
await post(inquiry("2b6f0c4e-0000-4000-8000-000000000002", { name: "Jordan Visitor", message: "Also a powder room, separately." }));
await post(inquiry("2b6f0c4e-0000-4000-8000-000000000003", { name: "Casey Neighbor", email: "casey@example.test", phone: "", message: "Window treatments quote." }));
assert.equal((await post(inquiry("2b6f0c4e-0000-4000-8000-000000000004"), { token: TOKEN_B })).status, 401, "B's token cannot use A's source");
const moved = await (await post({ ...inquiry("2b6f0c4e-0000-4000-8000-000000000005"), client_id: CLIENT_B }, { key: "sandbox-b-website", token: TOKEN_B })).json();
assert.equal(sql(`select client_id from inquiries where id = '${moved.inquiry_id}'`), CLIENT_B);
assert.equal(sql(`select count(*) from inquiries where client_id = '${CLIENT_A}'`), "3");
assert.equal(sql(`select count(distinct contact_id) from inquiries where client_id = '${CLIENT_A}'`), "2", "Jordan's two inquiries share one contact");
assert.equal(sql(`select count(*) from notification_jobs where status <> 'blocked'`), "0");
ok("Intake: saved once per submission id under the source's client; separate inquiries share the contact; alerts blocked");

const port = Number(process.env.CRM_LITE_UI_PORT ?? 3433);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  // The same session on both names of this machine: next dev reports its own
  // origin as localhost, and /api/client-phone refuses a browser write whose
  // Origin differs, so the composer check runs on localhost.
  await context.addCookies(["127.0.0.1", "localhost"].map((domain) => ({ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain, path: "/" })));
  return context;
}
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

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
  const root = `${base}/clients/${CLIENT_A}/inquiries`;

  await team.goto(root, { waitUntil: "networkidle" });
  assert.ok(await team.getByRole("link", { name: "Inquiries" }).first().isVisible(), "the client tab");
  const names = await team.locator("[data-inquiry-list] li").allInnerTexts();
  assert.equal(names.length, 3);
  assert.match(names[0], /Casey Neighbor/, "newest first");
  assert.ok(names.every((n) => /New/.test(n)), "status labels");
  await shot(team, "agency-list");
  await team.getByRole("searchbox").or(team.getByPlaceholder("Search name, email or phone")).fill("casey");
  await team.getByRole("button", { name: "Search" }).click();
  await team.waitForURL(/q=casey/);
  assert.equal(await team.locator("[data-inquiry-list] li").count(), 1);
  await team.goto(`${root}?q=555-0142`, { waitUntil: "networkidle" });
  assert.equal(await team.locator("[data-inquiry-list] li").count(), 2, "search by phone");
  ok("Agency list: newest first, status labels, search by name and phone");

  await team.goto(`${root}/${first.inquiry_id}`, { waitUntil: "networkidle" });
  assert.equal(await team.locator("[data-inquiry-message]").innerText(), "We are remodeling our kitchen.\nCould you call after 5pm?");
  assert.equal(await team.getByRole("link", { name: "Call from my phone", exact: true }).getAttribute("href"), "tel:+16185550142");
  assert.match(await team.getByRole("link", { name: "Email" }).getAttribute("href"), /^mailto:jordan@example\.test\?subject=/);
  await team.getByRole("button", { name: "Mark contacted" }).click();
  await team.locator("[data-inquiry-status=contacted]").first().waitFor();
  await team.getByLabel("Add a follow-up note").fill("Called back; consultation booked.");
  await team.getByRole("button", { name: "Add note" }).click();
  await team.getByText("Called back; consultation booked.").waitFor();
  const history = await team.locator("[data-inquiry-history]").innerText();
  assert.match(history, /Inquiry received from the website/);
  assert.match(history, /Status: New → Contacted — Sam Team/);
  assert.match(await team.locator("[data-inquiry-note]").innerText(), /Sam Team/);
  assert.match(await team.locator("main").innerText(), /SMS alert: Not sent \(gate closed\) — SMS alerts were off for this client/);
  await shot(team, "agency-detail");
  ok("Agency detail: full message, call / email, Mark contacted, a note with author, history, alert job blocked");

  await team.goto(`${root}/settings`, { waitUntil: "networkidle" });
  const setup = await team.locator("main").innerText();
  assert.match(setup, /Status: Off/);
  assert.match(setup, /○ Twilio toll-free verification recorded approved/);
  assert.ok(!setup.includes(TOKEN_A), "no token on the page");
  assert.ok(await team.getByRole("button", { name: "Turn SMS alerts on" }).isDisabled(), "the switch waits for every gate");
  await shot(team, "agency-setup");
  ok("Setup: SMS off, every gate shown, the switch disabled, no token on the page");

  // The portal contact of client A, on a phone-sized screen.
  const portal = await (await contextFor(browser, PORTAL_A, { width: 390, height: 844 })).newPage();
  portal.on("pageerror", (e) => errors.push(e.message));
  await portal.goto(`${base}/portal`, { waitUntil: "networkidle" });
  await portal.getByRole("link", { name: "Inquiries" }).click();
  await portal.waitForURL(/\/portal\/inquiries$/);
  assert.equal(await portal.locator("[data-inquiry-list] li").count(), 3);
  assert.ok(!(await portal.content()).includes("Sandbox B"), "only client A's");
  await shot(portal, "portal-list-mobile");
  await portal.goto(`${base}/portal/inquiries/${first.inquiry_id}`, { waitUntil: "networkidle" });
  await portal.getByRole("button", { name: "Close" }).click();
  await portal.locator("[data-inquiry-status=closed]").first().waitFor();
  await portal.getByRole("button", { name: "Reopen" }).click();
  await portal.locator("[data-inquiry-status=new]").first().waitFor();
  await portal.getByLabel("Add a follow-up note").fill("Sent her the lookbook.");
  await portal.getByRole("button", { name: "Add note" }).click();
  await portal.getByText("Sent her the lookbook.").waitFor();
  const portalHistory = await portal.locator("[data-inquiry-history]").innerText();
  assert.match(portalHistory, /Contacted → Closed — Alex Owner/);
  assert.match(portalHistory, /Closed → New — Alex Owner/);
  assert.ok(!(await portal.locator("main").innerText()).includes("SMS alert"), "no delivery internals in the portal");
  await shot(portal, "portal-detail-mobile");
  ok("Portal (phone): Inquiries tab, own inquiries only, close, reopen, a note under their own name");

  const other = await (await contextFor(browser, PORTAL_B)).newPage();
  const res = await other.goto(`${base}/portal/inquiries/${first.inquiry_id}`, { waitUntil: "networkidle" });
  assert.equal(res.status(), 404);
  assert.ok(!(await other.content()).includes("remodeling our kitchen"));
  ok("Portal: client B cannot open client A's inquiry (404)");

  sql(`update portal_users set access_scope='leads_only' where auth_user_id='${PORTAL_A.id}'`);
  await portal.goto(`${base}/portal`, { waitUntil: "networkidle" });
  assert.match(portal.url(), /\/portal\/inquiries$/);
  await portal.locator("[data-client-workspace]").waitFor();
  for (const path of ["growth", "backlinks", "rankings", "search", "work-log", "reports", "billing"]) {
    await portal.goto(`${base}/portal/${path}`, { waitUntil: "networkidle" });
    assert.match(portal.url(), /\/portal\/inquiries$/, `blocked ${path}`);
  }
  assert.deepEqual(await portal.locator('nav[aria-label="Workspace"] button').allTextContents(), ["Dashboard", "Leads3", "Pipeline", "Inbox"]);
  assert.equal(await portal.getByRole("link", { name: "Billing", exact: true }).count(), 0);
  assert.equal(await portal.getByRole("link", { name: "Settings", exact: true }).count(), 0);
  assert.ok(await portal.getByRole("button", { name: "Sign out", exact: true }).isVisible());
  await portal.goto(`${base}/portal/inquiries/${first.inquiry_id}`, { waitUntil: "networkidle" });
  assert.match(portal.url(), new RegExp(`lead=${first.inquiry_id}`));
  // Device calling and browser calling are told apart (BHG, Nov 18 2026).
  const device = portal.getByRole("link", { name: "Call from my phone", exact: true });
  assert.equal(await device.getAttribute("href"), "tel:+16185550142");
  assert.match(await device.getAttribute("title"), /your own number, not the business line/);
  assert.ok(await portal.getByRole("region", { name: "Browser calling on the business line", exact: true }).isVisible());
  assert.equal(await portal.getByRole("link", { name: "Call lead", exact: true }).count(), 0);
  ok("Lead calling: device call link and browser calling are labelled apart");

  // The text composer works like a messaging app (Nov 19 2026).
  phone.armed = true;
  const lead = await (await contextFor(browser, PORTAL_A, { width: 390, height: 844 })).newPage();
  await lead.goto(`http://localhost:${port}/portal/inquiries/${first.inquiry_id}`, { waitUntil: "networkidle" });
  await lead.getByRole("button", { name: "Text message", exact: true }).click();
  const thread = lead.getByRole("region", { name: "Lead text conversation", exact: true });
  const box = thread.getByLabel("Text message", { exact: true });
  const sendButton = thread.locator('button[type="submit"]');
  await box.waitFor();
  assert.equal(await thread.getByRole("button", { name: "Save draft" }).count(), 0, "no Save draft button");
  await thread.getByText(/From \+18885550123 · to \+16185550142/).waitFor();
  assert.ok(await sendButton.isDisabled(), "Send is off while empty");
  // Enter sends; Shift+Enter is a new line; no save step first.
  await box.click();
  await box.pressSequentially("On our way");
  await box.press("Shift+Enter");
  await box.pressSequentially("ETA 9am");
  assert.equal(await box.inputValue(), "On our way\nETA 9am");
  phone.replies.push({ state: "accepted" });
  await box.press("Enter");
  await lead.waitForFunction((el) => el.value === "", await box.elementHandle());
  assert.equal(phone.sends.length, 1);
  assert.equal(phone.sends[0].body, "On our way\nETA 9am");
  await thread.getByText("ETA 9am").waitFor();
  assert.match(await thread.locator("[data-sms-status]").last().innerText(), /^Queued/);
  // A double click is one request.
  await box.fill("Second text");
  phone.replies.push({ state: "accepted", delay: 700 });
  await sendButton.dblclick();
  await thread.getByRole("button", { name: "Sending…" }).waitFor();
  await lead.waitForFunction((el) => el.value === "", await box.elementHandle());
  assert.equal(phone.sends.length, 2, "one request for the double click");
  assert.notEqual(phone.sends[1].request_id, phone.sends[0].request_id);
  // A failure keeps the text and says why; the next press is a new request.
  await box.fill("Third text");
  phone.replies.push({ state: "failed", code: "provider_refused" });
  await sendButton.click();
  await thread.getByRole("alert").filter({ hasText: "carrier refused" }).waitFor();
  assert.equal(await box.inputValue(), "Third text");
  // A refusal (no consent) keeps the text too.
  phone.replies.push({ http: 409, error: "no_consent" });
  await sendButton.click();
  await thread.getByRole("alert").filter({ hasText: "permission to be texted" }).waitFor();
  assert.equal(await box.inputValue(), "Third text");
  assert.notEqual(phone.sends[3].request_id, phone.sends[2].request_id, "a failed press is not reused");
  // Uncertain: the text and the request id stay; the next press only checks it.
  phone.replies.push({ state: "uncertain", code: "send_uncertain" });
  await sendButton.click();
  await thread.getByRole("button", { name: "Check status", exact: true }).waitFor();
  assert.equal(await box.inputValue(), "Third text");
  assert.match(await thread.getByRole("status").innerText(), /won't be sent twice/);
  phone.replies.push({ state: "accepted" });
  await thread.getByRole("button", { name: "Check status", exact: true }).click();
  await lead.waitForFunction((el) => el.value === "", await box.elementHandle());
  assert.equal(phone.sends[5].request_id, phone.sends[4].request_id, "Check status asks about the same press");
  assert.equal(phone.sends.length, 6);
  assert.ok(await sendButton.isDisabled(), "Send is off again once empty");
  await shot(lead, "lead-composer-mobile");
  await lead.context().close();
  phone.armed = false;
  ok("Lead texting: type and Send (Enter / Shift+Enter), no save step, one request per press, failures keep the text, uncertain sends are checked not resent");
  await portal.getByText("Follow-up and internal notes", { exact: true }).click();
  await portal.getByLabel("Add a follow-up note").fill("Leads-only access still works.");
  await portal.getByRole("button", { name: "Add note", exact: true }).click();
  await portal.getByText("Leads-only access still works.", { exact: true }).waitFor();
  assert.equal(await portal.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(portal, "leads-only-mobile");
  // Pipeline uses the same scoped status action and real database history.
  await portal.getByRole("button", { name: "Dashboard", exact: true }).click();
  await portal.getByRole("button", { name: "New: 3 leads", exact: true }).click();
  assert.equal(await portal.getByLabel("Filter by status").inputValue(), "new");
  await portal.getByRole("button", { name: "Pipeline", exact: true }).click();
  const pipelineLead = portal.locator(`[data-pipeline-lead="${first.inquiry_id}"]`);
  await pipelineLead.getByRole("button", { name: "Mark contacted", exact: true }).click();
  await portal.locator(`[data-pipeline-stage="contacted"] [data-pipeline-lead="${first.inquiry_id}"]`).waitFor();
  assert.equal(sql(`select status from inquiries where id='${first.inquiry_id}'`), "contacted");
  assert.ok(await portal.getByRole("button", { name: "New: 2 leads", exact: true }).isVisible());
  assert.ok(await portal.getByRole("button", { name: "Contacted: 1 leads", exact: true }).isVisible());
  await pipelineLead.getByRole("button", { name: "Close", exact: true }).click();
  await portal.locator(`[data-pipeline-stage="closed"] [data-pipeline-lead="${first.inquiry_id}"]`).waitFor();
  assert.equal(sql(`select status from inquiries where id='${first.inquiry_id}'`), "closed");
  await pipelineLead.getByRole("button", { name: "Reopen", exact: true }).click();
  await portal.locator(`[data-pipeline-stage="new"] [data-pipeline-lead="${first.inquiry_id}"]`).waitFor();
  assert.equal(await portal.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(portal, "pipeline-mobile");
  await pipelineLead.getByRole("link").click();
  await portal.getByText("Follow-up and internal notes", { exact: true }).click();
  await portal.getByText("Leads-only access still works.", { exact: true }).waitFor();
  assert.equal(await portal.getByRole("region", { name: "Lead workspace", exact: true }).isVisible(), true);
  await portal.getByRole("button", { name: "Pipeline", exact: true }).click();
  // Another session changes a lead after this board was loaded.
  sql(`set session authorization authenticator; set role authenticated; set request.jwt.claims='{"sub":"${TEAM.id}","role":"authenticated"}'; select crm_inquiry_set_status('${first.inquiry_id}', 'contacted', 'new')`);
  await pipelineLead.getByRole("button", { name: "Close", exact: true }).click();
  await portal.locator(`[data-pipeline-stage="contacted"] [data-pipeline-lead="${first.inquiry_id}"]`).waitFor();
  assert.equal(sql(`select status from inquiries where id='${first.inquiry_id}'`), "contacted", "stale move cannot overwrite another session");
  ok("Pipeline: stage bubbles filter leads; moves persist and refresh counts; closed leads reopen; mobile fits; lead details retain notes; stale moves cannot overwrite");
  await portal.goto(`${base}/workspace-preview/${CLIENT_A}`, { waitUntil: "networkidle" });
  assert.equal(await portal.locator("[data-client-workspace]").count(), 0, "portal contact cannot use team preview");
  await team.goto(`${base}/clients/${CLIENT_A}/workspace-preview`, { waitUntil: "networkidle" });
  assert.equal(team.url(), `${base}/workspace-preview/${CLIENT_A}`);
  await team.locator("[data-client-workspace]").waitFor();
  assert.equal(await team.getByRole("link", { name: "Production", exact: true }).count(), 0);
  assert.equal(await team.getByRole("link", { name: "Settings", exact: true }).count(), 0);
  await shot(team, "clean-workspace-preview");
  await team.getByRole("button", { name: "Pipeline", exact: true }).click();
  await shot(team, "pipeline-desktop");
  await other.goto(`${base}/portal`, { waitUntil: "networkidle" });
  assert.ok(await other.getByRole("link", { name: "Reports", exact: true }).isVisible(), "other clients retain reporting");
  ok("Leads-only: home and direct reporting URLs redirect; notes and mobile workspace work; preview is team-only without agency navigation; other clients retain reporting");

  assert.equal(twilio.sent.length, 0, "no text was sent");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`crm-lite UI: ${checks.length} checks passed`);
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  await browser?.close();
  app.kill();
  gateway.close();
}
process.exit(0);
