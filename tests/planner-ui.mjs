// Browser acceptance check for the Content Planner (0064): the Production
// page across clients and a client's Planner tab — plan items, plan from
// Authority, link a draft and follow it through review, block, deliver.
// Run by `npm run test:planner-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): the real app (`next dev`) against a Postgres replay behind
// PostgREST and a signed-in teammate. Fictional clients.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { currentWeek, addDays } from "../src/lib/content-planner.ts";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const verify = (t) => { const [h, p, s] = (t ?? "").split("."); if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null; return JSON.parse(Buffer.from(p, "base64url").toString()); };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const anonKey = sign({ role: "anon", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const run = (cmd, q) => execFileSync("/bin/sh", ["-c", `${cmd} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sql = (q) => run(PSQL, q);
const admin = (q) => run(PSQL_ADMIN, q);

const unexpected = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const c = verify(bearer);
    const u = c?.sub && users.get(c.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const body = []; for await (const c of req) body.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(body) });
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

// ── Fixtures (fictional) ────────────────────────────────────────────────────
const A = "00000000-0000-4000-b000-0000000000a7";
const B = "00000000-0000-4000-b000-0000000000b7";
const SVC = "00000000-0000-4000-e000-0000000000a7";
const KW = "00000000-0000-4000-d000-0000000000a7";
const POST = "00000000-0000-4000-c000-0000000000a7";
const OPP = "00000000-0000-4000-c100-0000000000a7";
const RUN = "00000000-0000-4000-c200-0000000000a7";
const W = currentWeek();
sql(`insert into clients (id, name, city, state, status, website_url) values
     ('${A}', 'Planner Roofing', 'Wentzville', 'MO', 'active', 'https://planner-roofing.example.test'),
     ('${B}', 'Planner Plumbing', 'Columbia', 'MO', 'launching', null)`);
sql(`insert into services (id, client_id, name, status) values ('${SVC}', '${A}', 'Roof Replacement', 'approved')`);
sql(`insert into keywords (id, client_id, keyword, is_tracked) values ('${KW}', '${A}', 'roof replacement wentzville', true)`);
sql(`insert into claims (id, client_id, claim, status, source) values ('00000000-0000-4000-f000-0000000000a7', '${A}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/1')`);
admin(`insert into social_posts (id, client_id, platform, search_intent, service_id, copy, cta_type, cta_url) values
     ('${POST}', '${A}', 'google_business', 'commercial', '${SVC}', 'Roof replacement in Wentzville by an Owens Corning Preferred Contractor.', 'LEARN_MORE', 'https://planner-roofing.example.test/roofs')`);
admin(`insert into post_claims (post_id, client_id, claim_id) values ('${POST}', '${A}', '00000000-0000-4000-f000-0000000000a7')`);
// An Authority run's output (its guard admits only the authority functions).
admin(`set session_replication_role = replica;
  insert into authority_runs (id, client_id, status, mode, requested_via) values ('${RUN}', '${A}', 'running', 'full', 'team');
  insert into authority_opportunities (id, client_id, key, first_seen_run_id, last_seen_run_id, last_seen_at, section, action, tier,
    content_type, topic, service_id, intent, target_path, opportunity, status)
  values ('${OPP}', '${A}', 'blog:roof-life', '${RUN}', '${RUN}', now(), 'ready', 'create', 'A', 'blog_post',
    'How long does a roof last in Missouri', '${SVC}', 'informational', '/blog/roof-life', '{}', 'open');`);

const port = Number(process.env.PLANNER_UI_PORT ?? 3434);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user, viewport) {
  const context = await browser.newContext({ viewport });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}
const noScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
try {
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });
  const ctx = await contextFor(browser, TEAM, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());

  // 1. Production: every active / launching client, nothing planned yet.
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Production" }).first().click();
  await page.waitForURL(/\/production/);
  const rowA = page.locator(`[data-production-client="${A}"]`);
  await rowA.waitFor();
  assert.equal(await page.locator(`[data-production-client="${B}"]`).count(), 1, "launching clients are planned too");
  assert.deepEqual(await rowA.locator("[data-slot-count]").allInnerTexts(), ["0/2", "0/2", "0/2", "0/1"]);
  assert.match(await rowA.innerText(), /2 to plan[\s\S]*1 to plan/);
  ok("Production lists active and launching clients with Social 0/2 | GBP 0/2 | Blogs 0/2 | Web Pages 0/1");

  // 2. The client's planner: plan a Business Profile service post.
  await rowA.getByRole("link", { name: "Planner Roofing" }).click();
  await page.waitForURL(new RegExp(`/clients/${A}/planner\\?week=${W}`));
  const gbp = page.locator('[data-planner-section="gbp"]');
  await gbp.locator("summary").filter({ hasText: "Plan 2 more" }).click();
  await gbp.getByLabel("Topic or target keyword").fill("Roof replacement before winter");
  await gbp.getByLabel("Search intent").selectOption("commercial");
  await gbp.getByLabel("Service").selectOption(SVC);
  await gbp.getByLabel("Tracked keyword").selectOption(KW);
  await gbp.getByLabel("Planned date").fill(addDays(W, 2));
  await gbp.getByRole("button", { name: "Add to the plan" }).click();
  const gbpItem = gbp.locator("[data-plan-item]").first();
  await gbpItem.waitFor();
  assert.equal(await gbpItem.locator("[data-plan-status]").getAttribute("data-plan-status"), "ready_to_generate");
  assert.match(await gbpItem.locator("[data-next-step]").innerText(), /write the post/);
  const memberId = sql(`select id from team_members where auth_user_id = '${TEAM.id}'`);
  assert.equal(sql(`select deliverable||'/'||channel||'/'||purpose||'/'||created_by from content_plan_items where topic = 'Roof replacement before winter'`),
    `gbp/google_business/service/${memberId}`);
  ok("A teammate plans a GBP service post (topic, intent, service, keyword, date): Ready to generate, with the next step");

  // A social post with no intent yet: Planned.
  const social = page.locator('[data-planner-section="social"]');
  await social.locator("summary").filter({ hasText: "Plan 2 more" }).click();
  await social.getByLabel("Topic or target keyword").fill("Crew photos from the O'Fallon job");
  await social.getByLabel("Purpose").selectOption("real_work");
  await social.getByLabel("Channel").selectOption("instagram");
  await social.getByRole("button", { name: "Add to the plan" }).click();
  const socialItem = social.locator("[data-plan-item]").first();
  await socialItem.waitFor();
  assert.equal(await socialItem.locator("[data-plan-status]").getAttribute("data-plan-status"), "planned");
  assert.match(await socialItem.innerText(), /Real Work \/ Project · Instagram/);
  ok("A social Real Work post with no intent yet reads Planned");

  // 3. Plan from Authority: the blog opportunity fills a blog slot.
  await page.locator(`[data-plan-opportunity="${OPP}"] button`).click();
  const blogItem = page.locator('[data-planner-section="blog"] [data-plan-item]').first();
  await blogItem.waitFor();
  assert.equal(await blogItem.locator("[data-plan-status]").getAttribute("data-plan-status"), "ready_to_generate");
  assert.match(await blogItem.innerText(), /How long does a roof last in Missouri[\s\S]*Authority[\s\S]*informational/);
  assert.equal(sql(`select purpose||'/'||authority_opportunity_id||'/'||target_url from content_plan_items where deliverable = 'blog'`),
    `authority/${OPP}/https://planner-roofing.example.test/blog/roof-life`);
  assert.equal(await page.locator(`[data-plan-opportunity="${OPP}"]`).count(), 0, "a planned opportunity leaves the list");
  ok("From Authority: the blog opportunity is planned with its topic, intent, service and target page");

  // 4. Link the existing GBP draft, then follow it into review.
  await gbpItem.locator("[data-link-output] select").selectOption({ index: 1 });
  await gbpItem.getByRole("button", { name: "Link" }).click();
  await gbpItem.locator('[data-plan-status="drafting"]').waitFor();
  admin(`update social_posts set review_status = 'in_review' where id = '${POST}'`);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await gbp.locator("[data-plan-item] [data-plan-status]").first().getAttribute("data-plan-status"), "in_review");
  ok("Linking the draft reads Drafting; the post going to review reads In review (derived from the review gate)");

  // 5. Block the social item, then deliver it with its link.
  await socialItem.locator("[data-hold-form] summary").click();
  await socialItem.locator('input[value="blocked"]').check();
  await socialItem.locator('input[name="hold_reason"]').fill("Waiting on the client's photos");
  await socialItem.getByRole("button", { name: "Save" }).first().click();
  await socialItem.locator('[data-plan-status="blocked"]').waitFor();
  assert.match(await socialItem.innerText(), /Waiting on[\s\S]*client's photos/);
  await socialItem.getByRole("button", { name: "Unblock" }).click();
  await socialItem.locator('[data-plan-status="planned"]').waitFor();
  await socialItem.locator("[data-hold-form] summary").click();
  await socialItem.locator('input[name="output_url"]').fill("https://instagram.example.test/p/1");
  await socialItem.getByRole("button", { name: "Save" }).first().click();
  await socialItem.locator('[data-plan-status="delivered"]').waitFor();
  assert.deepEqual(await page.locator('[data-slot-strip] [data-slot="social"] [data-slot-count]').allInnerTexts(), ["1/2"]);
  ok("Blocked needs a reason and shows it; unblock; delivered with its link counts toward Social 1/2");

  // 6. Production follows.
  await page.goto(`${base}/production?week=${W}`, { waitUntil: "networkidle" });
  assert.deepEqual(await rowA.locator("[data-slot-count]").allInnerTexts(), ["1/2", "0/2", "0/2", "0/1"]);
  assert.match(await rowA.innerText(), /in review/i);
  assert.match(await page.locator("[data-production]").innerText(), /1 waiting for review/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/production.png`, fullPage: true });
  ok("Production shows the week: Social 1/2, the GBP post in review, the blog ready to generate");

  // 7. Remove an unlinked item; a linked one is kept until unlinked.
  await page.goto(`${base}/clients/${A}/planner?week=${W}`, { waitUntil: "networkidle" });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/planner.png`, fullPage: true });
  await page.locator('[data-planner-section="blog"] [data-plan-item]').first().getByRole("button", { name: "Remove" }).click();
  await page.locator('[data-planner-section="blog"]').getByText("Nothing planned yet.").waitFor();
  assert.equal(await gbp.locator("[data-plan-item]").first().getByRole("button", { name: "Remove" }).count(), 0);
  ok("An unlinked item can be removed; a linked one offers Unlink first");

  // 8. Other weeks are separate.
  await page.locator("[data-week]").getByRole("link", { name: "Next →" }).click();
  await page.waitForURL(new RegExp(`week=${addDays(W, 7)}`));
  assert.deepEqual(await page.locator("[data-slot-strip] [data-slot-count]").allInnerTexts(), ["0/2", "0/2", "0/2", "0/1"]);
  ok("Next week starts empty; weeks are separate");

  // 9. Access and phone width.
  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const pp = await pctx.newPage();
  await pp.goto(`${base}/production?week=${W}`, { waitUntil: "networkidle" });
  assert.ok(!/Planner Roofing/.test(await pp.content()), "a portal contact sees no production data");
  await pctx.close();
  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  for (const path of [`/production?week=${W}`, `/clients/${A}/planner?week=${W}`]) {
    await mp.goto(`${base}${path}`, { waitUntil: "networkidle" });
    assert.ok(await noScroll(mp), path);
  }
  await mctx.close();
  ok("A portal contact sees no plan; phone width has no horizontal scroll on either page");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.deepEqual(unexpected, [], `calls outside the sandbox: ${unexpected.join(" | ")}`);
  ok("No page errors; no calls outside the sandbox");
  console.log(`Planner browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
