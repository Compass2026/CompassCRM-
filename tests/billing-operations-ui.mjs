// Browser check for the billing operations (B3). Run by
// `npm run test:billing-ops-ui` (scripts/test-tasks-ui.sh with UI_SPEC set):
// a real Postgres replay behind PostgREST, `next dev`, Chromium, and the
// real stripe-billing handler and webhook behind the gateway with the fake
// Stripe. Nothing leaves the machine.
//
//   - Settings › Billing catalog: an admin adds a package, imports its Stripe
//     product, approves a price, sets what it includes; a member sees it
//     read-only.
//   - Billing tab: a member records nothing financial; an admin creates A's
//     customer and links B's existing one (confirmation required) with its
//     invoice, payment and each partial refund shown individually.
//   - Payment Link Ready: created by the admin, copied, opened; a member can
//     copy it but not expire it; after the webhook the client is Active and
//     no second link is offered.
//   - External payment recorded and voided; Customer Portal opened; the
//     public Checkout return page; the test-mode banner; billing history.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createStripeBilling } from "../supabase/functions/stripe-billing/handler.ts";
import { createBillingStore } from "../supabase/functions/stripe-billing/store.ts";
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
const WHSEC = "whsec_ops_ui";

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
const run = (psql, q) => execFileSync("/bin/sh", ["-c", `${psql} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sql = (q) => run(PSQL, q);
const sqlAdmin = (q) => run(PSQL_ADMIN, q);

// Stripe, the functions, and Supabase's gateway (/auth/v1/user, /rest/v1, the two functions).
const s = fakeStripe();
const unexpected = [];
let billing;
let webhook;
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
    const headers = { "content-type": "application/json" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const r = await billing.handle(new Request("http://x/stripe-billing", { method: req.method, headers, body }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(await r.text());
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
billing = createStripeBilling({
  config: async () => ({ secretKey: "sk_test_ops_ui", appUrl: "https://crm.example.test" }),
  store: createBillingStore(service),
  makeApi: () => s.api,
});
webhook = createStripeWebhook({ config: async () => ({ secretKey: "sk_test_ops_ui", webhookSecret: WHSEC }), store: createStripeStore(service), makeApi: () => s.api });

const port = Number(process.env.BILLING_OPS_UI_PORT ?? 3433);
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
  if (user) {
    const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
    await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  }
  // Stripe's hosted pages are not reachable from here; answer them locally.
  await context.route(/^https:\/\/(checkout|billing)\.stripe\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Stripe</title>stripe page" }));
  return context;
}
async function until(page, read, want, what) {
  for (let i = 0; i < 80; i++) {
    const v = read();
    if (want(v)) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  const banner = await page.locator(".bg-red-50").allTextContents();
  throw new Error(`${what}: gave up (last ${JSON.stringify(read())}, page errors ${JSON.stringify(banner)})`);
}
const text = async (page) => (await page.locator("main").textContent()).replace(/\s+/g, " ");
const shot = async (page, name) => {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
};
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };

// A second teammate (member); the sandbox team account is the admin.
sqlAdmin(`insert into auth.users (id, email, email_confirmed_at) values ('${MEMBER.id}', '${MEMBER.email}', now())`);
sqlAdmin(`insert into team_members (auth_user_id, name, email, role) values ('${MEMBER.id}', 'Morgan Member', '${MEMBER.email}', 'member')`);
sqlAdmin(`update team_members set role = 'admin' where auth_user_id = '${ADMIN.id}'`);
sql(`insert into client_contacts (client_id, name, email, is_primary) values ('${A}', 'Pat Owner', 'pat@harbor-lane.example.test', true)`);
// Stripe: the Growth product with a monthly price; B's existing customer and history.
s.put({ id: "prod_Growth", object: "product", livemode: false, name: "Compass Growth", active: true, metadata: {}, created: 1 });
s.put({ id: "price_GrowthM", object: "price", livemode: false, product: "prod_Growth", active: true, type: "recurring", currency: "usd",
  unit_amount: 150000, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, nickname: "Growth monthly", metadata: {}, created: 1 });
seedCustomer(s, { cus: "cus_SummitOld", sub: "sub_SummitOld", inv: "in_SummitOld", pi: "pi_SummitOld", py: "py_SummitOld", prefix: "SU" });
s.patch("cus_SummitOld", { name: "Summit Electric LLC", email: "books@summit.example.test" });

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const adminCtx = await contextFor(browser, ADMIN);
  await adminCtx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const admin = await adminCtx.newPage();
  const member = await (await contextFor(browser, MEMBER)).newPage();
  const errors = [];
  for (const p of [admin, member]) p.on("pageerror", (e) => errors.push(e.message));

  // ── Catalog ──────────────────────────────────────────────────────────
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  assert.match(await text(admin), /Stripe test mode\./);
  await admin.fill("#pkg-name", "Growth");
  await admin.fill("#pkg-key", "growth");
  await admin.getByRole("button", { name: "Add package" }).click();
  await until(admin, () => sql(`select count(*) from billing_packages where key = 'growth'`), (v) => v === "1", "package added");
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  const growth = admin.locator("[data-package=growth]");
  await growth.getByLabel("Stripe product for Growth").fill("prod_Growth");
  await growth.getByRole("button", { name: "Import from Stripe" }).click();
  await until(admin, () => sql(`select coalesce(stripe_product_id, '') from billing_packages where key = 'growth'`), (v) => v === "prod_Growth", "product imported");
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  await admin.locator("[data-package=growth]").locator('input[name="is_default"]').check();
  await admin.locator("[data-package=growth]").getByRole("button", { name: "Approve for Checkout" }).click();
  await until(admin, () => sql(`select count(*) from billing_package_prices where stripe_price_id = 'price_GrowthM' and is_default`), (v) => v === "1", "price approved");
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  const blogRow = admin.locator("[data-entitlement='growth:blog_posts']");
  await blogRow.locator("summary").click();
  await blogRow.locator('input[name="enabled"]').check();
  await blogRow.locator('input[name="quantity"]').fill("4");
  await blogRow.getByRole("button", { name: "Save" }).click();
  await until(admin, () => sql(`select coalesce(max(quantity), -1) from package_entitlements where service_key = 'blog_posts'`), (v) => v === "4", "entitlement saved");
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  const growthText = (await admin.locator("[data-package=growth]").textContent()).replace(/\s+/g, " ");
  assert.match(growthText, /Compass Growth prod_Growth/);
  assert.match(growthText, /\$1,500\.00 \/ month — Growth monthly.*price_GrowthM.*Default/);
  assert.match(growthText, /Blog Posts4 posts \/ month/);
  await shot(admin, "catalog-admin");
  ok("catalog: an admin adds Growth, imports its Stripe product, approves the $1,500 / month price as default and includes 4 blog posts");

  await member.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  assert.match(await text(member), /Only an admin can change them\./);
  for (const name of ["Add package", "Import from Stripe", "Re-import", "Approve for Checkout", "Configure Customer Portal", "Add item"]) {
    assert.equal(await member.getByRole("button", { name }).count(), 0, `member sees ${name}`);
  }
  assert.match(await text(member), /\$1,500\.00 \/ month/);
  ok("catalog: a member reads it and has no controls");

  // ── Agreements (a member's job) ──────────────────────────────────────
  for (const client of [A, B]) {
    await member.goto(`${base}/clients/${client}/plan`, { waitUntil: "networkidle" });
    await member.selectOption("#package_id", { label: "Growth" });
    await member.getByRole("button", { name: "Save agreement" }).click();
    await until(member, () => sql(`select count(*) from plans where client_id = '${client}' and package_id is not null`), (v) => v === "1", "agreement saved");
  }
  ok("agreements: a member puts both clients on Growth");

  // ── Customers ────────────────────────────────────────────────────────
  await member.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.match(await text(member), /No Stripe customer yet\. An admin links/);
  assert.equal(await member.getByRole("button", { name: "Create Stripe customer" }).count(), 0);
  assert.equal(await member.locator("[data-card=external-payment]").count(), 0);
  ok("Billing tab: a member cannot link or create a customer or record a payment");

  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.equal(await admin.locator("#cust-email").inputValue(), "pat@harbor-lane.example.test");
  await admin.getByRole("button", { name: "Create Stripe customer" }).click();
  await until(admin, () => sql(`select count(*) from stripe_customers where client_id = '${A}' and link_source = 'created'`), (v) => v === "1", "customer created");
  await admin.waitForURL(/notice=/);
  assert.match(await text(admin), /Created the client's Stripe customer\./);
  assert.equal(s.all("customer").filter((c) => c.metadata?.compass_client_id === A).length, 1);
  ok("create customer: the admin's one click makes one Stripe customer carrying the client id, prefilled with the primary contact's email");

  await admin.goto(`${base}/clients/${B}/billing`, { waitUntil: "networkidle" });
  await admin.getByLabel("Search Stripe customers").fill("books@summit.example.test");
  await admin.getByRole("button", { name: "Search Stripe" }).click();
  const hit = admin.locator("[data-customer=cus_SummitOld]");
  await hit.waitFor();
  assert.match((await hit.textContent()).replace(/\s+/g, " "), /Summit Electric LLC.*books@summit\.example\.test.*Test.*active — will be imported/);
  await shot(admin, "link-existing-customer");
  await hit.getByRole("button", { name: "Link customer" }).click();
  assert.equal(sql(`select count(*) from stripe_customers where client_id = '${B}'`), "0", "the confirmation box is required");
  await hit.locator('input[name="confirm"]').check();
  await hit.getByRole("button", { name: "Link customer" }).click();
  await until(admin, () => sql(`select count(*) from stripe_customers where client_id = '${B}' and link_source = 'linked_existing'`), (v) => v === "1", "customer linked");
  await admin.waitForURL(/notice=/);
  const bPage = await text(admin);
  assert.match(bPage, /Existing customer linked/);
  assert.match(bPage, /SU-0001/);
  assert.equal(await admin.locator("[data-refund]").count(), 2, "each partial refund on its own row");
  assert.match((await admin.locator("[data-refund=pyr_SU1]").textContent()).replace(/\s+/g, " "), /−\$1,000\.00.*succeeded.*requested by customer/);
  assert.match((await admin.locator("[data-refund=pyr_SU2]").textContent()).replace(/\s+/g, " "), /−\$500\.00/);
  assert.match(bPage, /already has a subscription in Stripe/);
  await shot(admin, "billing-linked-existing");
  ok("link existing: search, explicit confirmation, then the invoice, the ACH payment and both partial refunds (individually) appear; no payment link is offered over the active subscription");

  // ── Payment link ─────────────────────────────────────────────────────
  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: "Create payment link" }).click();
  await until(admin, () => sql(`select count(*) from checkout_sessions where client_id = '${A}' and status = 'open'`), (v) => v === "1", "checkout created");
  await admin.waitForURL(/notice=/);
  const link = admin.locator("[data-card=payment-link]");
  const linkText = (await link.textContent()).replace(/\s+/g, " ");
  const url = sql(`select url from checkout_sessions where client_id = '${A}'`);
  assert.match(linkText, /Payment Link Ready/);
  assert.match(linkText, /Harbor Lane Plumbing.*Growth.*\$1,500\.00 \/ month.*Test mode.*Sam Team/);
  assert.equal((await link.locator("[data-payment-link]").textContent()).trim(), url);
  await link.getByRole("button", { name: "Copy Payment Link" }).click();
  await link.getByRole("button", { name: "Copied" }).waitFor();
  assert.equal(await admin.evaluate(() => navigator.clipboard.readText()), url);
  assert.equal(await link.getByRole("link", { name: "Open Payment Link" }).getAttribute("href"), url);
  const cs = s.all("checkout.session")[0];
  assert.deepEqual(cs.payment_method_types, ["card", "us_bank_account"]);
  await shot(admin, "payment-link-ready");
  ok("payment link: created from the approved price; Payment Link Ready shows client, package, price, expiry, mode and creator; Copy puts the exact URL on the clipboard");

  await member.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.equal(await member.getByRole("button", { name: "Copy Payment Link" }).count(), 1);
  assert.equal(await member.getByRole("button", { name: "Expire link" }).count(), 0);
  ok("payment link: a member can copy and open it, not expire it");

  s.complete(cs.id);
  const done = await webhook.handle(await signedRequest(s.event("checkout.session.completed", s.get(cs.id)), WHSEC));
  assert.equal(done.status, 200);
  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  const aPage = await text(admin);
  assert.match(aPage, /Active/);
  assert.match(aPage, /\$1,500\.00 \/ month/);
  assert.match(aPage, /already has a subscription in Stripe/);
  assert.equal(await admin.getByRole("button", { name: "Create payment link" }).count(), 0);
  assert.match((await admin.locator("[data-card=entitlements]").textContent()).replace(/\s+/g, " "), /Blog Posts4 posts \/ monthPackage/);
  ok("after Stripe's webhook: Active at $1,500 / month, no second link offered, entitlements from the package");

  // ── Customer Portal ──────────────────────────────────────────────────
  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.equal(await admin.getByRole("button", { name: "Manage Billing in Stripe" }).isDisabled(), true);
  await admin.goto(`${base}/settings/billing`, { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: "Configure Customer Portal" }).click();
  await until(admin, () => sql(`select count(*) from app_settings where key = 'billing_portal'`), (v) => v === "1", "portal configured");
  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: "Manage Billing in Stripe" }).click();
  await admin.waitForURL(/^https:\/\/billing\.stripe\.com\//);
  assert.equal(s.all("billing_portal.session").at(-1).customer, sql(`select stripe_customer_id from stripe_customers where client_id = '${A}'`));
  assert.equal(await member.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" }).then(() => member.getByRole("button", { name: "Manage Billing in Stripe" }).count()), 0);
  ok("Customer Portal: configured in Settings by the admin; Manage Billing in Stripe opens the portal for A's own customer; not offered to a member");

  // ── External payment ─────────────────────────────────────────────────
  await admin.goto(`${base}/clients/${B}/billing`, { waitUntil: "networkidle" });
  await admin.locator("[data-card=external-payment] summary").click();
  await admin.fill("#ext-amount", "750");
  await admin.selectOption("#ext-method", "check");
  await admin.fill("#ext-date", "2026-09-20");
  await admin.fill("#ext-reference", "Check 3301");
  await admin.fill("#ext-notes", "Setup fee paid by check");
  await admin.getByRole("button", { name: "Record payment" }).click();
  await until(admin, () => sql(`select count(*) from payments where client_id = '${B}' and source = 'external'`), (v) => v === "1", "payment recorded");
  await admin.waitForURL(/notice=/);
  const pid = sql(`select id from payments where client_id = '${B}' and source = 'external'`);
  assert.match((await admin.locator(`[data-payment="${pid}"]`).textContent()).replace(/\s+/g, " "), /\$750\.00.*Check.*succeeded.*External · recorded by Sam Team.*Check 3301/);
  await admin.getByText("Void this payment").click();
  await admin.getByPlaceholder("Why (e.g. check returned)").fill("Check returned by the bank");
  await admin.getByRole("button", { name: "Void", exact: true }).click();
  await until(admin, () => sql(`select coalesce(void_reason, '') from payments where id = '${pid}'`), (v) => v === "Check returned by the bank", "payment voided");
  await admin.getByText("Voided the payment.").waitFor();
  assert.match((await admin.locator(`[data-payment="${pid}"]`).textContent()).replace(/\s+/g, " "), /void/);
  assert.match(await text(admin), /voided .* by Sam Team: Check returned by the bank/);
  ok("external payment: the admin records a $750 check with a note; voiding keeps it in the history, marked void with who and why");

  // ── History, mode and the public return page ─────────────────────────
  const history = (await admin.locator("[data-card=history]").textContent()).replace(/\s+/g, " ");
  for (const want of ["Linked an existing Stripe customer", "Recorded an external payment", "Voided an external payment"]) {
    assert.ok(history.includes(want), `history shows ${want}: ${history}`);
  }
  assert.equal(await admin.locator("[data-billing-mode=test]").count(), 1);
  await admin.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  const aHistory = (await admin.locator("[data-card=history]").textContent()).replace(/\s+/g, " ");
  for (const want of ["Created the Stripe customer", "Created a payment link", "Opened the Customer Portal"]) {
    assert.ok(aHistory.includes(want), `A's history shows ${want}: ${aHistory}`);
  }
  ok("billing history lists who did each action; every page carries the test-mode banner");

  const anon = await (await contextFor(browser, null)).newPage();
  await anon.goto(`${base}/checkout/complete`, { waitUntil: "networkidle" });
  assert.match(await anon.locator("main").textContent(), /Thank you.*Bank \(ACH\) payments take a few business days/s);
  await anon.goto(`${base}/checkout/canceled`, { waitUntil: "networkidle" });
  assert.match(await anon.locator("main").textContent(), /Nothing was charged/);
  await anon.goto(`${base}/clients/${A}/billing`, { waitUntil: "networkidle" });
  assert.match(anon.url(), /\/login$/);
  ok("Checkout return pages are public and say nothing about any account; the Billing tab still needs a sign-in");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Billing operations browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
