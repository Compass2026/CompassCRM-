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
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
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
  assert.equal(await team.getByRole("link", { name: "Call" }).getAttribute("href"), "tel:+16185550142");
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
