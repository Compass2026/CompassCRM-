// Browser check for billing in the client portal (B5). Run by
// `npm run test:portal-billing-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): the Postgres replay behind PostgREST, `next dev`, Chromium, and the
// real stripe-billing and webhook handlers behind the gateway over the fake
// Stripe. Nothing leaves the machine.
//
//   - Portal A (Stripe-collected) sees its plan, status, monthly amount, plan
//     services and monthly content from its entitlements, and its invoices
//     with the Stripe-hosted links — no Stripe ids, no internal codes.
//   - Manage billing opens A's own Customer Portal: the request carries no
//     client id, the session is for A's customer, and it returns to
//     /portal/billing.
//   - A missed payment reads "Payment needs attention" (no internal code).
//   - Portal B (external arrangement) sees "Managed directly with Compass",
//     its plan services, and no Stripe button or invoices.
//   - A teammate is sent out of the portal; a portal contact is kept out of
//     the CRM's billing screen.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createStripeBilling } from "../supabase/functions/stripe-billing/handler.ts";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";
import { fakeStripe, seedCustomer } from "./fixtures/stripe-fake.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN, SCREENSHOTS } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const ADMIN = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL_A = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const PORTAL_B = { id: "00000000-0000-4000-a000-000000000012", email: "portal-b@example.test" };
const users = new Map([ADMIN, PORTAL_A, PORTAL_B].map((u) => [u.id, u]));
const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const GROWTH = "00000000-0000-4000-c000-0000000000b1";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const verify = (token) => {
  const [h, p, s] = (token ?? "").split(".");
  if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
};
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const anonKey = sign({ role: "anon", exp: exp() });
const serviceKey = sign({ role: "service_role", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const run = (psql, q) => execFileSync("/bin/sh", ["-c", `${psql} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sql = (q) => run(PSQL, q);
const sqlAdmin = (q) => run(PSQL_ADMIN, q);

const s = fakeStripe();
const unexpected = [];
const billingCalls = [];                   // every body sent to stripe-billing, with who sent it
let billing;
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const out = Buffer.from(await up.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status, h);
    return res.end(out);
  }
  if (url.pathname === "/functions/v1/stripe-billing") {
    billingCalls.push({ sub: verify(bearer)?.sub ?? null, body: JSON.parse(body.toString() || "{}") });
    const headers = { "content-type": "application/json" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const r = await billing.handle(new Request("http://x/functions/v1/stripe-billing", { method: req.method, headers, body }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(await r.text());
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
billing = createStripeBilling({ config: async () => ({ secretKey: "sk_test_pbu", appUrl: "https://crm.example.test" }), store: createBillingStore(service), makeApi: () => s.api });
const callBilling = async (body) => {
  const r = await billing.handle(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${tokenFor(ADMIN)}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

const port = Number(process.env.PORTAL_BILLING_UI_PORT ?? 3437);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  // Stripe's hosted pages are stubbed: the test only needs to see where the
  // browser was sent.
  await context.route(/^https:\/\/(billing|invoice)\.stripe\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body><h1>Stripe (stub)</h1></body></html>" }));
  return context;
}
const text = async (loc) => (await loc.textContent()).replace(/\s+/g, " ");
const shot = async (page, name) => {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
};
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
// Nothing internal on a portal page: Stripe ids, internal state codes, notes.
const INTERNAL = /\b(cus|sub|price|prod|in|pi|py|si|bpc|bps|cs)_[A-Za-z0-9]{2,}|past_due|billing_attention|attention_reasons|unmapped_price|package_mismatch|reconcil|override|webhook/i;

// Setup: Growth (SEO, GBP, 4 blog posts, 4 GBP posts); A on Stripe with an
// existing customer linked; B an external arrangement on the same package.
sqlAdmin(`update team_members set role = 'admin' where auth_user_id = '${ADMIN.id}'`);
seedCustomer(s, { cus: "cus_PortalA", sub: "sub_PortalA", inv: "in_PortalA", pi: "pi_PortalA", py: "py_PortalA", prefix: "PA" });
sql(`insert into billing_packages (id, key, name, kind) values ('${GROWTH}', 'growth_portal', 'Growth', 'standard')`);
sql(`insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  ('${GROWTH}', 'seo', 'feature', true, null), ('${GROWTH}', 'gbp', 'feature', true, null),
  ('${GROWTH}', 'social', 'feature', false, null),
  ('${GROWTH}', 'blog_posts', 'quota', true, 4), ('${GROWTH}', 'gbp_posts', 'quota', true, 4)`);
sql(`insert into plans (client_id, package_id, collection) values ('${A}', '${GROWTH}', 'stripe')`);
sql(`insert into plans (client_id, package_id, collection, external_method, external_amount_cents, external_currency, external_interval)
  values ('${B}', '${GROWTH}', 'external', 'check', 150000, 'usd', 'month')`);
// A's own override (with an internal reason the portal must never show).
sql(`insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason)
  values ('${A}', 'social_posts', 'quota', true, 8, 'Override reason: internal note for the team')`);
sql(`insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, reason)
  values ('${A}', 'social', 'feature', true, 'Social added at signing')`);
assert.equal((await callBilling({ action: "link_customer", client_id: A, customer_id: "cus_PortalA", confirm: true })).status, 200);
assert.equal((await callBilling({ action: "configure_portal" })).status, 200);

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const pa = await (await contextFor(browser, PORTAL_A)).newPage();
  const pb = await (await contextFor(browser, PORTAL_B)).newPage();
  const team = await (await contextFor(browser, ADMIN)).newPage();
  const errors = [];
  for (const p of [pa, pb, team]) p.on("pageerror", (e) => errors.push(e.message));

  // Portal A: the Billing tab and page.
  await pa.goto(`${base}/portal`, { waitUntil: "networkidle" });
  assert.equal(await pa.getByRole("link", { name: "Billing" }).count(), 1);
  await pa.getByRole("link", { name: "Billing" }).click();
  await pa.waitForURL(/\/portal\/billing$/);
  await pa.locator("[data-card=billing-overview]").waitFor();
  const overview = await text(pa.locator("[data-card=billing-overview]"));
  assert.match(overview, /Current plan\s*Growth/, overview);
  assert.match(overview, /Active/);
  assert.match(overview, /Monthly amount\s*\$3,000\.00/, overview);
  assert.match(overview, /Next billing date/);
  const plan = await text(pa.locator("[data-card=plan-services]"));
  assert.match(plan, /SEO/);
  assert.match(plan, /Google Business Profile/);
  assert.match(plan, /Social Media/, "an override that adds a service is shown as included");
  assert.match(plan, /4 Blog Posts/);
  assert.match(plan, /4 Google Business Profile Posts/);
  assert.match(plan, /8 Social Media Posts/);
  assert.doesNotMatch(plan, /Paid Advertising|Website Page Refreshes/, "what is not included is not listed");
  const invoices = await text(pa.locator("[data-card=invoices]"));
  assert.match(invoices, /PA-0001/);
  assert.match(invoices, /\$3,000\.00/);
  assert.match(invoices, /Paid/);
  assert.equal(await pa.getByRole("link", { name: "View invoice" }).getAttribute("href"), "https://invoice.stripe.com/i/in_PortalA");
  const whole = await text(pa.locator("main"));
  assert.doesNotMatch(whole, INTERNAL, whole);
  assert.doesNotMatch(await pa.content(), /cus_PortalA|sub_PortalA|price_StdM|Override reason|internal note/, "no internal value anywhere in the HTML");
  await shot(pa, "portal-billing-a");
  ok("portal A sees its plan, status, monthly amount, services and monthly content from its entitlements, and its invoices — nothing internal");

  // Manage billing: A's own Customer Portal, no client id sent.
  const before = billingCalls.length;
  await pa.getByRole("button", { name: "Manage billing" }).click();
  await pa.waitForURL(/^https:\/\/billing\.stripe\.com\/p\/session\//, { timeout: 60_000 });
  const mine = billingCalls.slice(before).filter((c) => c.sub === PORTAL_A.id);
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].body, { action: "create_portal_session" }, "the portal sends no client id");
  const session = s.all("billing_portal.session").at(-1);
  assert.equal(session.customer, "cus_PortalA");
  assert.equal(session.return_url, "https://crm.example.test/portal/billing");
  assert.equal(sql(`select actor_kind || ':' || client_id from billing_audit_events where action = 'portal_session' order by created_at desc limit 1`), `portal:${A}`);
  ok("Manage billing opens A's own Stripe Customer Portal (no client id sent; returns to Billing; audited as the portal contact)");

  // A missed payment, in client language.
  s.patch("sub_PortalA", { status: "past_due" });
  assert.equal((await callBilling({ action: "resync_customer", client_id: A })).status, 200);
  await pa.goto(`${base}/portal/billing`, { waitUntil: "networkidle" });
  const attention = await text(pa.locator("[data-card=billing-overview]"));
  assert.match(attention, /Payment needs attention/, attention);
  assert.match(attention, /update your payment method/);
  assert.doesNotMatch(attention, INTERNAL);
  await shot(pa, "portal-billing-a-attention");
  ok("a past-due subscription reads \"Payment needs attention\" with what to do — no internal code");

  // Portal B: external arrangement.
  await pb.goto(`${base}/portal/billing`, { waitUntil: "networkidle" });
  const ob = await text(pb.locator("[data-card=billing-overview]"));
  assert.match(ob, /Managed directly with Compass/);
  assert.match(ob, /Billing is managed directly with Compass\./);
  assert.doesNotMatch(ob, /Monthly amount|\$1,500/);
  assert.equal(await pb.getByRole("button", { name: "Manage billing" }).count(), 0);
  assert.match(await text(pb.locator("[data-card=invoices]")), /managed directly with Compass/i);
  assert.equal(await pb.getByRole("link", { name: "View invoice" }).count(), 0);
  assert.match(await text(pb.locator("[data-card=plan-services]")), /4 Blog Posts/);
  assert.doesNotMatch(await pb.content(), /PA-0001|cus_PortalA|Growth.*\$3,000/);
  await shot(pb, "portal-billing-b-external");
  ok("portal B (external) sees \"Managed directly with Compass\", its plan services, no Stripe button and none of A's invoices");

  // Portal B cannot open A's Customer Portal even by asking for it.
  const tryA = await (await fetch(`${gatewayUrl}/functions/v1/stripe-billing`, {
    method: "POST", headers: { authorization: `Bearer ${tokenFor(PORTAL_B)}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "create_portal_session", client_id: A }),
  })).json();
  assert.equal(tryA.error, "forbidden");
  ok("portal B asking for A's Customer Portal by id is refused");

  // Routing: team out of the portal, portal contacts out of the CRM.
  await team.goto(`${base}/portal/billing`, { waitUntil: "networkidle" });
  assert.ok(!new URL(team.url()).pathname.startsWith("/portal"), team.url());
  await pa.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.ok(new URL(pa.url()).pathname.startsWith("/portal"), pa.url());
  ok("a teammate is sent out of the portal; a portal contact is sent out of the CRM's billing screen");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Portal billing browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
