// Browser check for the billing foundation (0058, B1). Run by
// `npm run test:billing-ui` (scripts/test-tasks-ui.sh with UI_SPEC set): a
// real Postgres replay behind PostgREST, `next dev` and Chromium. Nothing
// leaves the machine and nothing calls Stripe: the Stripe mirror is seeded
// as the Stripe functions would write it.
//
//   - Plan tab: choose a package, save the agreement; an external arrangement
//     without an amount is refused with the reason; an entitlement override
//     with its reason replaces the package's quantity.
//   - Content tab: "/ 6 planned" comes from the entitlement.
//   - Billing tab: Stripe's past_due is shown with the overdue invoice, the
//     outstanding amount, recurring and one-time invoices and the payment.
//   - Dashboard: "Billing needs attention" lists the client; Clients list
//     shows the package.
//   - API: a teammate cannot write the mirror; a portal contact reads no
//     billing, not even their own client's.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));
const CLIENT = "00000000-0000-4000-b000-00000000000a";

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
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });

// Supabase's gateway, reduced to what the app calls: /auth/v1/user and /rest/v1.
const unexpected = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const body = [];
    for await (const c of req) body.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) {
      if (req.headers[k]) headers[k] = req.headers[k];
    }
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(body),
    });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(upstream.status, h);
    return res.end(out);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

const port = Number(process.env.BILLING_UI_PORT ?? 3431);
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
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
// The Stripe mirror is written only by the sync functions (0059); fixtures load
// it as the cluster superuser, which the guard exempts (as 0047's fixtures).
const sqlAdmin = (q) => execFileSync("/bin/sh", ["-c", `${process.env.PSQL_ADMIN} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();


// The Stripe catalog and client A's Stripe state, as the functions will write them.
sqlAdmin(`insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values
  ('prod_UiStd', false, 'Compass Marketing Package', true, now()),
  ('prod_UiWeb', false, 'Website project', true, now())`);
sqlAdmin(`insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency, unit_amount_cents,
  recurring_interval, recurring_interval_count, recurring_usage_type, stripe_synced_at) values
  ('price_UiStdM', 'prod_UiStd', false, true, 'recurring', 'usd', 150000, 'month', 1, 'licensed', now()),
  ('price_UiWeb', 'prod_UiWeb', false, true, 'one_time', 'usd', 500000, null, null, null, now())`);
sql(`insert into billing_packages (id, key, name, kind, stripe_product_id) values
  ('00000000-0000-4000-c000-0000000000b1', 'marketing', 'Compass Marketing Package', 'standard', 'prod_UiStd')`);
sql(`insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, is_default)
  values ('00000000-0000-4000-c000-0000000000b1', 'standard', 'prod_UiStd', 'price_UiStdM', true)`);
sql(`insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  ('00000000-0000-4000-c000-0000000000b1', 'seo', 'feature', true, null),
  ('00000000-0000-4000-c000-0000000000b1', 'gbp', 'feature', true, null),
  ('00000000-0000-4000-c000-0000000000b1', 'blog_posts', 'quota', true, 4),
  ('00000000-0000-4000-c000-0000000000b1', 'paid_ads', 'feature', false, null)`);
sqlAdmin(`insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at,
  default_payment_method_type, default_payment_method_last4)
  values ('${CLIENT}', 'cus_UiA', false, 'linked_existing', now(), 'us_bank_account', '6789')`);
sqlAdmin(`insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status, collection_method,
  currency, current_period_start, current_period_end, stripe_created_at, stripe_synced_at)
  values ('${CLIENT}', 'cus_UiA', 'sub_UiA', false, 'past_due', 'charge_automatically', 'usd', '2026-09-01', '2026-10-01', '2026-08-01', now())`);
sqlAdmin(`insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
  select id, client_id, 'si_UiA', 'price_UiStdM', 2, now() from subscriptions where stripe_subscription_id = 'sub_UiA'`);
sqlAdmin(`insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, stripe_subscription_id, livemode, number, status,
  collection_method, currency, subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents,
  attempt_count, attempted, hosted_invoice_url, period_start, period_end, stripe_created_at, stripe_synced_at) values
  ('${CLIENT}', 'cus_UiA', 'in_UiAug', 'sub_UiA', false, 'UI-0001', 'paid', 'charge_automatically', 'usd', 300000, 300000,
   300000, 300000, 0, 1, true, 'https://invoice.stripe.com/i/ui_aug', '2026-08-01', '2026-09-01', '2026-08-01', now()),
  ('${CLIENT}', 'cus_UiA', 'in_UiSep', 'sub_UiA', false, 'UI-0002', 'open', 'charge_automatically', 'usd', 300000, 300000,
   300000, 0, 300000, 2, true, 'https://invoice.stripe.com/i/ui_sep', '2026-09-01', '2026-10-01', '2026-09-01', now())`);
sqlAdmin(`insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, livemode, number, status, collection_method,
  currency, subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents, stripe_created_at, stripe_synced_at)
  values ('${CLIENT}', 'cus_UiA', 'in_UiWeb', false, 'UI-WEB-1', 'paid', 'send_invoice', 'usd', 500000, 500000, 500000, 500000, 0,
  '2026-07-15', now())`);
sqlAdmin(`insert into payments (client_id, source, stripe_customer_id, stripe_payment_intent_id, stripe_invoice_id, livemode, status,
  payment_method_type, amount_cents, currency, paid_at, stripe_synced_at)
  values ('${CLIENT}', 'stripe', 'cus_UiA', 'pi_UiAug', 'in_UiAug', false, 'succeeded', 'us_bank_account', 300000, 'usd', '2026-08-04', now())`);

// Server actions finish after the click; wait for the write rather than the network.
async function until(page, read, want, what) {
  for (let i = 0; i < 60; i++) {
    const v = read();
    if (want(v)) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  const banner = await page.locator(".bg-red-50").allTextContents();
  throw new Error(`${what}: gave up (last ${JSON.stringify(read())}, page errors ${JSON.stringify(banner)})`);
}
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const team = await (await contextFor(browser, TEAM)).newPage();
  const errors = [];
  team.on("pageerror", (e) => errors.push(e.message));

  // Plan tab: an external arrangement without an amount is refused with the reason.
  await team.goto(`${base}/clients/${CLIENT}/plan`, { waitUntil: "networkidle" });
  await team.selectOption("#collection", "external");
  await team.selectOption("#external_method", "check");
  await team.getByRole("button", { name: "Save agreement" }).click();
  await team.getByText("An external arrangement needs the agreed amount.").waitFor();
  assert.equal(sql(`select count(*) from plans where client_id = '${CLIENT}'`), "0", "nothing saved");
  ok("Plan: an external arrangement without an amount is refused with the reason, nothing saved");

  // Choose the package and save a Stripe-collected agreement.
  await team.goto(`${base}/clients/${CLIENT}/plan`, { waitUntil: "networkidle" });
  await team.selectOption("#package_id", { label: "Compass Marketing Package" });
  await team.fill("#term_months", "12");
  await team.fill("#managed_ad_budget", "2,500");
  await team.getByRole("button", { name: "Save agreement" }).click();
  await until(team, () => sql(`select count(*) from plans where client_id = '${CLIENT}'`), (v) => v === "1", "agreement saved");
  const saved = sql(`select package_id || '|' || collection || '|' || term_months || '|' || managed_ad_budget_cents || '|' || (updated_by is not null)
    from plans where client_id = '${CLIENT}'`);
  assert.equal(saved, "00000000-0000-4000-c000-0000000000b1|stripe|12|250000|true", saved);
  ok("Plan: the agreement saves the package, term and ad budget in cents, stamped with the teammate");

  // Entitlements: the package's, then an override with its reason.
  await team.goto(`${base}/clients/${CLIENT}/plan`, { waitUntil: "networkidle" });
  const blogRow = team.locator("tr", { hasText: "Blog Posts" });
  assert.match(await blogRow.textContent(), /4 posts \/ month.*4 posts \/ month/);
  await blogRow.locator("summary").click();
  await blogRow.locator('input[name="quantity"]').fill("6");
  await blogRow.locator('input[name="reason"]').fill("Two extra posts agreed in September");
  await blogRow.getByRole("button", { name: "Save" }).click();
  await until(team, () => sql(`select quantity from client_entitlement_overrides where client_id = '${CLIENT}' and service_key = 'blog_posts'`),
    (v) => v === "6", "override saved");
  await team.goto(`${base}/clients/${CLIENT}/plan`, { waitUntil: "networkidle" });
  const blogAfter = (await team.locator("tr", { hasText: "Blog Posts" }).textContent()).replace(/\s+/g, " ");
  assert.match(blogAfter, /4 posts \/ month6 posts \/ monthOverride: Two extra posts agreed in September/, blogAfter);
  assert.match((await team.locator("tr", { hasText: "Paid Advertising" }).textContent()), /Not included/);
  ok("Plan: package entitlements shown; an override replaces blogs 4 → 6 with its reason");

  // An override without a reason is refused.
  const seoRow = team.locator("tr", { hasText: "SEO" }).first();
  await seoRow.locator("summary").click();
  await seoRow.getByRole("button", { name: "Save" }).click();
  await team.getByText("Say why this client's agreement differs from its package.").waitFor();
  ok("Plan: an override without a reason is refused");

  // Billing card on the Plan tab: Stripe's state, not Compass's.
  await team.goto(`${base}/clients/${CLIENT}/plan`, { waitUntil: "networkidle" });
  const billingCard = team.locator("div[data-slot=card]", { hasText: "Prices, invoices and payments come from Stripe" });
  assert.match(await billingCard.textContent(), /Past due.*\$3,000\.00 \/ month.*Stripe test mode.*Stripe marks the subscription past due/s);
  ok("Plan: the billing summary mirrors Stripe (past due, $3,000.00 / month, test mode)");

  // Content tab: planned count from the entitlement.
  await team.goto(`${base}/clients/${CLIENT}/content`, { waitUntil: "networkidle" });
  assert.ok(await team.getByText("/ 6 planned").first().isVisible(), "content tab reads the entitlement");
  ok("Content tab: '/ 6 planned' comes from the entitlement override");

  // Billing tab.
  await team.goto(`${base}/clients/${CLIENT}/billing`, { waitUntil: "networkidle" });
  const page = (await team.locator("main").textContent()).replace(/\s+/g, " ");
  for (const want of ["Past due", "Compass Marketing Package", "$3,000.00 / month", "ACH debit ····6789",
    "An open invoice is overdue or has failed a payment attempt", "UI-0002", "UI-WEB-1", "One-time", "Recurring",
    "Stripe test mode."]) {
    assert.ok(page.includes(want), `billing tab shows ${want}: ${page.slice(0, 600)}`);
  }
  assert.match(page, /Outstanding\s*\$3,000\.00/);
  assert.equal(await team.locator('a[href="https://dashboard.stripe.com/test/customers/cus_UiA"]').count(), 1);
  assert.equal(await team.locator('a[href="https://invoice.stripe.com/i/ui_sep"]').count() >= 1, true);
  ok("Billing tab: past due with the overdue invoice, $3,000.00 outstanding, recurring and one-time invoices, the ACH payment, test-mode Stripe links");

  // Dashboard and Clients list.
  await team.goto(`${base}/`, { waitUntil: "networkidle" });
  const attention = team.locator("div[data-slot=card]", { hasText: "Billing needs attention" });
  assert.match((await attention.textContent()).replace(/\s+/g, " "), /Past due — \$3,000\.00 open/);
  await team.goto(`${base}/clients`, { waitUntil: "networkidle" });
  assert.ok(await team.locator("tr", { hasText: "Compass Marketing Package" }).count() >= 1);
  ok("Dashboard lists the client under Billing needs attention; the Clients list shows the package");

  // API boundaries.
  const asTeam = { apikey: anonKey, authorization: `Bearer ${tokenFor(TEAM)}`, "content-type": "application/json" };
  const patch = await fetch(`${gatewayUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.sub_UiA`, {
    method: "PATCH", headers: asTeam, body: JSON.stringify({ status: "active" }) });
  assert.ok([401, 403].includes(patch.status), `team PATCH on the mirror: ${patch.status}`);
  assert.equal(sql(`select status from subscriptions where stripe_subscription_id = 'sub_UiA'`), "past_due");
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}` };
  for (const t of ["client_billing_status", "client_entitlements", "subscriptions", "invoices", "plans", "stripe_customers"]) {
    const rows = await (await fetch(`${gatewayUrl}/rest/v1/${t}?select=client_id`, { headers: asPortal })).json();
    assert.ok(Array.isArray(rows) && rows.length === 0, `portal reads ${t}: ${JSON.stringify(rows)}`);
  }
  const asAnon = { apikey: anonKey, authorization: `Bearer ${anonKey}` };
  assert.equal((await fetch(`${gatewayUrl}/rest/v1/client_billing_status?select=client_id`, { headers: asAnon })).status, 401);
  ok("API: a teammate cannot change the mirror; the portal contact reads no billing (their own client included); anon is refused");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Billing foundation browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
