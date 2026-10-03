// Browser check for billing reconciliation (B4). Run by
// `npm run test:billing-reconcile-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): the Postgres replay behind PostgREST, `next dev`, Chromium, and the
// real stripe-billing, stripe-reconcile and webhook handlers behind the
// gateway over the fake Stripe. Nothing leaves the machine.
//
//   - A member sees Stripe sync (webhook health, last reconciled, result) and
//     the run history, but no Run / Reconcile buttons.
//   - An admin runs a billing reconciliation from Settings (the run table
//     shows it), then, after a missed webhook, reconciles one client from its
//     Billing tab: repaired, past due, the reasons shown.
//   - A failed webhook shows on the card until reconciliation recovers it.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createStripeBilling } from "../supabase/functions/stripe-billing/handler.ts";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";
import { createStripeReconcile } from "../supabase/functions/stripe-reconcile/handler.ts";
import { createReconcileStore } from "../supabase/functions/stripe-reconcile/store.ts";
import { createStripeWebhook } from "../supabase/functions/stripe-webhook/handler.ts";
import { createStripeStore } from "../supabase/functions/_shared/stripe/store.ts";
import { fakeStripe, seedCustomer, signedRequest } from "./fixtures/stripe-fake.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN, SCREENSHOTS } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const ADMIN = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const MEMBER = { id: "00000000-0000-4000-a000-000000000021", email: "sandbox-member@compassmarketing.ai" };
const users = new Map([ADMIN, MEMBER].map((u) => [u.id, u]));
const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const GROWTH = "00000000-0000-4000-c000-0000000000a1";
const WHSEC = "whsec_reconcile_ui";

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
let billing;
let reconcile;
const pending = [];
const handlers = { "/functions/v1/stripe-billing": () => billing, "/functions/v1/stripe-reconcile": () => reconcile };
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
  if (handlers[url.pathname]) {
    const headers = { "content-type": "application/json" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const r = await handlers[url.pathname]().handle(new Request(`http://x${url.pathname}`, { method: req.method, headers, body }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(await r.text());
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
billing = createStripeBilling({ config: async () => ({ secretKey: "sk_test_rui", appUrl: "https://crm.example.test" }), store: createBillingStore(service), makeApi: () => s.api });
reconcile = createStripeReconcile({ config: async () => ({ secretKey: "sk_test_rui" }), store: createReconcileStore(service), makeApi: () => s.api, waitUntil: (p) => pending.push(p) });
const webhook = createStripeWebhook({ config: async () => ({ secretKey: "sk_test_rui", webhookSecret: WHSEC }), store: createStripeStore(service), makeApi: () => s.api });
const callBilling = async (body) => {
  const r = await billing.handle(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${tokenFor(ADMIN)}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

const port = Number(process.env.BILLING_RECONCILE_UI_PORT ?? 3435);
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

// Setup: an admin and a member; Growth sold to A through Checkout; B an existing customer.
sqlAdmin(`insert into auth.users (id, email, email_confirmed_at) values ('${MEMBER.id}', '${MEMBER.email}', now())`);
sqlAdmin(`insert into team_members (auth_user_id, name, email, role) values ('${MEMBER.id}', 'Morgan Member', '${MEMBER.email}', 'member')`);
sqlAdmin(`update team_members set role = 'admin' where auth_user_id = '${ADMIN.id}'`);
s.put({ id: "prod_Growth", object: "product", livemode: false, name: "Compass Growth", active: true, metadata: {}, created: 1 });
s.put({ id: "price_GrowthM", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
  unit_amount: 150000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, metadata: {}, created: 1 });
seedCustomer(s, { cus: "cus_UiB", sub: "sub_UiB", inv: "in_UiB", pi: "pi_UiB", py: "py_UiB", prefix: "UB" });
sql(`insert into billing_packages (id, key, name, kind) values ('${GROWTH}', 'growth', 'Growth', 'standard')`);
assert.equal((await callBilling({ action: "import_product", target: "package", target_id: GROWTH, product_id: "prod_Growth" })).status, 200);
const pp = sql(`insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, is_default)
  values ('${GROWTH}', 'standard', 'prod_Growth', 'price_GrowthM', true) returning id`).split("\n")[0];
sql(`insert into plans (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
       agreed_billing_interval_count, billing_package_price_id)
     values ('${A}', '${GROWTH}', 'stripe', 150000, 'usd', 'month', 1, '${pp}'), ('${B}', '${GROWTH}', 'stripe', 150000, 'usd', 'month', 1, '${pp}')`);
assert.equal((await callBilling({ action: "create_customer", client_id: A, email: "a@example.test" })).status, 200);
const co = await callBilling({ action: "create_checkout", client_id: A, request_id: "00000000-0000-4000-f000-000000000001" });
assert.equal(co.status, 200, JSON.stringify(co.body));
const sub = s.complete(co.body.checkout.session_id).subscription;
await webhook.handle(await signedRequest(s.event("checkout.session.completed", s.get(co.body.checkout.session_id)), WHSEC));
assert.equal((await callBilling({ action: "link_customer", client_id: B, customer_id: "cus_UiB", confirm: true })).status, 200);
// A webhook that failed (left in the ledger).
sqlAdmin(`insert into stripe_events (id, type, livemode, event_created_at, object_type, object_id, status, attempts, last_error, last_attempt_at)
  values ('evt_UiFailed', 'customer.subscription.updated', false, now(), 'subscription', '${sub}', 'failed', 1, 'database unavailable', now())`);

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const admin = await (await contextFor(browser, ADMIN)).newPage();
  const member = await (await contextFor(browser, MEMBER)).newPage();
  const errors = [];
  for (const p of [admin, member]) p.on("pageerror", (e) => errors.push(e.message));

  // A member: status, no buttons.
  await member.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  const memberSync = await text(member.locator("[data-card=stripe-sync]"));
  assert.match(memberSync, /Webhook1 failed event — the next reconciliation retries them/);
  assert.match(memberSync, /Last reconciled—.*Not reconciled yet/);
  assert.equal(await member.getByRole("button", { name: "Run Billing Reconciliation" }).count(), 0);
  assert.match(await text(member.locator("[data-card=reconciliation-runs]")), /No runs yet/);
  await member.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.match(await text(member.locator("[data-card=stripe-sync]")), /Not reconciled yet/);
  assert.equal(await member.getByRole("button", { name: "Reconcile This Client" }).count(), 0);
  ok("a member sees Stripe sync (a failed webhook, not reconciled yet) but no reconciliation buttons");

  // The admin runs a reconciliation from Settings.
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  await shot(admin, "reconcile-settings-before");
  await admin.getByRole("button", { name: "Run Billing Reconciliation" }).click();
  await admin.waitForURL(/notice=Reconciled/, { timeout: 60_000 });
  const notice = await text(admin.locator(".bg-green-50").first());
  assert.match(notice, /Reconciled 2 Stripe customers: /, notice);
  await Promise.all(pending.splice(0));
  assert.equal(sql(`select status from stripe_events where id = 'evt_UiFailed'`), "processed");
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  const runRow = await text(admin.locator("[data-card=reconciliation-runs] tbody tr").first());
  assert.match(runRow, /Completed.*Test.*Admin · Sam Team2/, runRow);
  assert.match(await text(admin.locator("[data-card=stripe-sync]")), /WebhookHealthy.*Completed/);
  await shot(admin, "reconcile-settings-after");
  ok("the admin's Run Billing Reconciliation runs the engine: the failed webhook is recovered, the run is listed, the webhook reads Healthy");

  // A missed webhook, then Reconcile This Client.
  s.patch(sub, { status: "past_due" });
  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.match(await text(admin.locator("[data-card=stripe-sync]")), /No differences/);
  assert.match(await text(admin.locator("[data-card=stripe-sync]")), /Active|No differences/);
  await admin.getByRole("button", { name: "Reconcile This Client" }).click();
  await admin.getByText(/Reconciled with Stripe:/).first().waitFor({ timeout: 60_000 });
  await Promise.all(pending.splice(0));
  const flash = await text(admin.locator(".bg-green-50").first());
  assert.match(flash, /Reconciled with Stripe: Repaired 1 billing record · needs attention\./, flash);
  const card = await text(admin.locator("[data-card=stripe-sync]"));
  assert.match(card, /Repaired 1 billing record · needs attention/);
  assert.match(card, /Repaired: 1 subscription updated\./);
  assert.match(card, /Stripe marks the subscription past due/);
  assert.match(await text(admin.locator("main")), /Past due/);
  assert.equal(sql(`select trigger from billing_reconciliation_runs order by started_at desc limit 1`), "admin_client");
  await shot(admin, "reconcile-client");
  ok("Reconcile This Client repairs A's missed past-due subscription and shows the result, what changed and why it needs attention");

  // The member reads the same result.
  await member.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  const memberCard = await text(member.locator("[data-card=stripe-sync]"));
  assert.match(memberCard, /Last reconciled(Sep|Oct|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Nov|Dec) \d+, \d{4}/);
  assert.match(memberCard, /Repaired 1 billing record · needs attention/);
  ok("a member reads when the client was last reconciled and what it found");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Billing reconciliation browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
