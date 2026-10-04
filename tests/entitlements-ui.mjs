// Browser check for the entitlement targets on the team's screens (B5). Run
// by `npm run test:entitlements-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): the Postgres replay behind PostgREST, `next dev` and Chromium.
//
//   - Tasks, Content and Social show this month's "used / allocation" from
//     client_quota_usage(), GBP posts apart from social posts.
//   - Reports shows what the agreement includes beside what was delivered.
//   - Intelligence shows the service scope.
//   - A client with no agreement reads "not included" everywhere.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN, SCREENSHOTS } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const ADMIN = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const users = new Map([ADMIN].map((u) => [u.id, u]));
const A = "00000000-0000-4000-b000-00000000000a";
const B = "00000000-0000-4000-b000-00000000000b";
const GROWTH = "00000000-0000-4000-c000-0000000000c1";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const verify = (token) => {
  const [h, p, s] = (token ?? "").split(".");
  if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
};
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const anonKey = sign({ role: "anon", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const run = (psql, q) => execFileSync("/bin/sh", ["-c", `${psql} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sql = (q) => run(PSQL, q);

const unexpected = [];
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
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const port = Number(process.env.ENTITLEMENTS_UI_PORT ?? 3438);
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
const usage = (client, key) => {
  const [allocation, used, completed] = sql(`select allocation || ',' || used || ',' || completed from client_quota_usage('${client}') where service_key = '${key}'`).split(",").map(Number);
  return { allocation, used, completed };
};

// Setup: A on Growth (SEO, Website, GBP; 4 blog, 4 GBP posts, 2 new pages)
// plus its own 8 social posts; one blog post published this month and one
// due. B has no agreement.
sql(`insert into billing_packages (id, key, name, kind) values ('${GROWTH}', 'growth_targets', 'Growth', 'standard')`);
sql(`insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  ('${GROWTH}', 'seo', 'feature', true, null), ('${GROWTH}', 'website', 'feature', true, null), ('${GROWTH}', 'gbp', 'feature', true, null),
  ('${GROWTH}', 'blog_posts', 'quota', true, 4), ('${GROWTH}', 'gbp_posts', 'quota', true, 4), ('${GROWTH}', 'website_pages', 'quota', true, 2)`);
sql(`insert into plans (client_id, package_id, collection, external_method, external_amount_cents, external_currency, external_interval)
  values ('${A}', '${GROWTH}', 'external', 'check', 150000, 'usd', 'month')`);
sql(`insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason) values
  ('${A}', 'social', 'feature', true, null, 'Added at signing'), ('${A}', 'social_posts', 'quota', true, 8, 'Eight a month')`);
const today = sql(`select (now() at time zone 'America/Chicago')::date`);
sql(`insert into content_posts (client_id, title, status, published_at) values ('${A}', 'Published this month', 'published', '${today}')`);
sql(`insert into content_posts (client_id, title, status, due_date) values ('${A}', 'Due this month', 'draft', '${today}')`);

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await (await contextFor(browser, ADMIN)).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const quota = (key) => page.locator(`[data-card=monthly-allocation] [data-quota=${key}]`);

  // Tasks: every quota, against client_quota_usage.
  await page.goto(`${base}/clients/${A}/tasks`, { waitUntil: "networkidle" });
  for (const key of ["blog_posts", "gbp_posts", "social_posts", "website_pages", "website_refreshes"]) {
    const u = usage(A, key);
    assert.equal(Number(await quota(key).getAttribute("data-used")), u.used, key);
    assert.equal(Number(await quota(key).getAttribute("data-allocation")), u.allocation, key);
  }
  // (The shared fixtures already publish a post for A on 2026-09-01; the
  // numbers come from the SQL, the wording from the component.)
  const blog = usage(A, "blog_posts");
  assert.ok(blog.used >= 2 && blog.allocation === 4, JSON.stringify(blog));
  assert.match(await text(quota("blog_posts")),
    new RegExp(`Blog Posts: ${blog.used} / 4 planned \\(${blog.completed} done, ${blog.used - blog.completed} in progress\\)`));
  assert.match(await text(quota("website_refreshes")), /not included/);
  await shot(page, "entitlements-tasks");
  ok("Tasks shows this month's targets (\"n / 4 planned\") for every quota, from client_quota_usage");

  await page.goto(`${base}/clients/${A}/content`, { waitUntil: "networkidle" });
  const b = usage(A, "blog_posts");
  assert.match(await text(page.locator("[data-blog-target]")), new RegExp(`Blog posts this month: ${b.used} / 4 planned \\(${b.completed} published\\)`));
  ok("Content shows blog posts against the allocation");

  await page.goto(`${base}/clients/${A}/social`, { waitUntil: "networkidle" });
  const g = usage(A, "gbp_posts");
  const so = usage(A, "social_posts");
  assert.equal(Number(await quota("gbp_posts").getAttribute("data-used")), g.used);
  assert.equal(Number(await quota("social_posts").getAttribute("data-used")), so.used);
  assert.equal(await quota("blog_posts").count(), 0);
  assert.match(await text(page.locator("[data-published-month]")), /social · \d+ Business Profile/);
  ok("Social shows social posts and Business Profile posts as separate targets");

  await page.goto(`${base}/clients/${A}/reports`, { waitUntil: "networkidle" });
  await page.locator("summary", { hasText: "Monthly workflow" }).click();
  assert.match(await text(page.locator("[data-included]")), /Included each month: 4 blog · 8 social · 4 Business Profile posts/);
  ok("Reports shows what the agreement includes, apart from what was delivered");

  await page.goto(`${base}/clients/${A}/intelligence`, { waitUntil: "networkidle" });
  const scope = page.locator("[data-card=service-scope]");
  assert.match(await text(scope.locator("[data-scope=included]")), /SEO.*Website Management.*Google Business Profile.*Social Media/);
  assert.match(await text(scope.locator("[data-scope=monthly]")), /4 Blog Posts \/ month · 2 New Website Pages \/ month · 4 Google Business Profile Posts \/ month · 8 Social Media Posts \/ month/);
  assert.match(await text(scope.locator("[data-scope=not-included]")), /Paid Advertising/);
  await shot(page, "entitlements-intelligence");
  ok("Intelligence shows the service scope: included, every month, not included");

  // B has no agreement.
  await page.goto(`${base}/clients/${B}/tasks`, { waitUntil: "networkidle" });
  for (const key of ["blog_posts", "gbp_posts", "social_posts"]) assert.match(await text(quota(key)), /not included/);
  await page.goto(`${base}/clients/${B}/intelligence`, { waitUntil: "networkidle" });
  assert.match(await text(page.locator("[data-scope=included]")), /no agreement recorded/);
  ok("a client with no agreement reads \"not included\" (never unlimited)");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Entitlement target browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
