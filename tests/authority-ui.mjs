// Browser acceptance check for the read-only Authority tab
// (/clients/[clientId]/authority). Run by `npm run test:authority-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, `next dev` and Chromium. The Lucas run is the trimmed production
// export in tests/fixtures/authority-lucas-run.json, recorded through the same
// service path authority-run uses (authority_begin_run / authority_record_run
// as authenticator + service_role). Nothing leaves the machine.
//
//   SCREENSHOTS=docs/screenshots/authority npm run test:authority-ui
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const CLIENT_A = "00000000-0000-4000-b000-00000000000a";
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));

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

const port = Number(process.env.AUTHORITY_UI_PORT ?? 3421);
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

// Elements that stick out past the viewport; empty means no horizontal scroll.
const overflowing = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((el) => !el.closest(".overflow-x-auto"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`)
  );
const noHorizontalScroll = async (page) => {
  const out = await overflowing(page);
  if (out.length) console.log("    overflow:", out.join(" | "));
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
};

const FX = JSON.parse(readFileSync(new URL("./fixtures/authority-lucas-run.json", import.meta.url), "utf8"));
const LUCAS = FX.meta.client.id;
const serviceKey = sign({ role: "service_role", exp: exp() });
const asService = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" };
const rpc = async (fn, args) => {
  const r = await fetch(`${PGRST_URL}/rpc/${fn}`, { method: "POST", headers: asService, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  assert.ok(r.ok, `${fn}: ${r.status} ${JSON.stringify(body)}`);
  return body;
};
// The recorded observation: 62 pages answering 200 and 2 answering 404, as in production.
const inventory = (fetchedAt, health = { status: "completed", reasons: [], inventory_errors: 0 }) => ({
  fetched_at: fetchedAt, site: "https://lucasconstructionmo.com", sitemap_urls: 47, refused: [], refusals: [], budget_exceeded: false, skipped: 0, health,
  pages: Array.from({ length: 64 }, (_, i) => ({ url: `https://lucasconstructionmo.com/p${i}`, status: i < 62 ? 200 : 404, final_url: null, final_status: i < 62 ? 200 : 404,
    redirect_loop: false, in_sitemap: true, title: null, h1: null, h2: [], canonical: null, words: null, text: null })),
});
const report = () => ({
  version: "authority-v1.1", client: FX.meta.client, as_of: FX.meta.as_of, generated_at: FX.meta.generated_at, inventory: FX.meta.inventory,
  sources: FX.meta.sources, pillars: FX.meta.pillars, keywords: [], conflicts: [], supporting: [], opportunities: FX.opportunities, judgments: [],
});
async function recordRun({ mode, via, by = null, status = "completed", fetchedAt = FX.meta.run.inventory_fetched_at, error = null, health }) {
  const runId = await rpc("authority_begin_run", { p_client_id: LUCAS, p_mode: mode, p_requested_via: via, p_requested_by: by });
  if (status === "running") return runId;
  if (status === "failed") { await rpc("authority_record_run", { p_run_id: runId, p: { status, error } }); return runId; }
  const fingerprint = await rpc("authority_fingerprint", { p_client_id: LUCAS });
  const inv = inventory(fetchedAt, health);
  await rpc("authority_record_run", { p_run_id: runId, p: {
    status, engine_version: "authority-v1.1", judged_at: FX.meta.generated_at, as_of: FX.meta.as_of,
    input_hash: `sha256:${"a".repeat(64)}`, section_hashes: fingerprint, inventory: inv, inventory_errors: health?.inventory_errors ?? 0, report: report(),
  } });
  return runId;
}

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
try {
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, status)
       values ('${LUCAS}', 'Lucas Construction', 'Wentzville', 'MO', '(636) 555-0100', 'https://lucasconstructionmo.com', 'service_area', 'active')`);
  const sam = sql(`select id from team_members where email = '${TEAM.email}'`);
  const fullId = await recordRun({ mode: "full", via: "team", by: sam });
  const refreshId = await recordRun({ mode: "refresh", via: "worker" });
  assert.equal(sql(`select count(*) from authority_opportunities where client_id = '${LUCAS}'`), "68");

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
  const shot = async (name, p = page) => {
    if (!SHOTS) return;
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  };
  const url = `${base}/clients/${LUCAS}/authority`;
  const summaryCount = async (s) => Number(await page.locator(`[data-summary="${s}"] [data-count]`).innerText());
  const isOpen = (id) => page.locator(`details#${id}`).evaluate((el) => el.open);

  // 1. The Lucas page: the tab, the header, the five counts.
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Last analyzed/ }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Authority", exact: true }).getAttribute("aria-current"), "page");
  const counts = {};
  for (const s of ["fix_now", "ready", "needs_decision", "research", "blocked"]) counts[s] = await summaryCount(s);
  assert.deepEqual(counts, { fix_now: 23, ready: 2, needs_decision: 27, research: 3, blocked: 9 });
  assert.equal(await page.locator("[data-state]").getAttribute("data-state"), "current");
  const header = await page.getByRole("region", { name: "Latest analysis" }).innerText();
  for (const s of ["Refresh", "authority-v1.1", "60 pages checked (64 URLs)", "Search Console complete · 825 rows · Aug 26 – Sep 22"]) assert.ok(header.includes(s), `header shows ${s}`);
  assert.equal(await page.locator("[data-banner]").count(), 0);
  ok("Lucas: Authority tab, header (refresh, engine, 60 pages / 64 URLs, Search Console complete 825 rows) and the five counts 23 / 2 / 27 / 3 / 9");

  // 2. Work-queue collapse: Tier A open and first; everything long collapsed.
  const fixNow = page.locator("#section-fix_now");
  assert.deepEqual(await fixNow.locator("details[data-group]").evaluateAll((els) => els.map((e) => [e.id, e.open])), [["fix-now-tier-A", true], ["fix-now-tier-B", false], ["fix-now-tier-C", false]]);
  assert.equal(await fixNow.locator("article").first().getAttribute("data-key"), "service_page:c1c55a67-bc9f-43d1-a3a6-ad9bfe96841d");
  const first = await fixNow.locator("article").first().innerText();
  for (const s of ["Roof Repair", "Create the page", "Tier A", "The owner page /services/roof-repair is missing.", "/services/roof-repair", "missing", "roof repair wentzville mo", "navigational", "1,690 impressions (28 days)", "3 usable claims", "FACT"]) assert.ok(first.includes(s), `Roof Repair card shows ${s}`);
  assert.equal(await page.locator("#fix-now-tier-B > summary [data-count]").innerText(), "16");
  assert.equal(await page.locator("#fix-now-tier-C > summary [data-count]").innerText(), "1");
  assert.ok(!(await page.locator('[data-key="data_fix:unmapped-keywords"]').isVisible()), "Tier C card hidden until opened");
  assert.equal(await isOpen("ready-now"), true);
  assert.equal(await isOpen("ready-waiting"), false);
  assert.ok((await page.locator("#ready-waiting > summary").innerText()).includes("Next eligible Oct 16, 2026"));
  assert.deepEqual(await page.locator("#section-needs_decision details[data-group]").evaluateAll((els) => els.map((e) => [e.id, e.open, e.querySelector(":scope > summary [data-count]").textContent])),
    [["decide-services", true, "1"], ["decide-markets", false, "19"], ["decide-intents", false, "7"]]);
  assert.equal(await isOpen("research-first"), true);
  assert.equal(await page.locator("#research-first article").count(), 3);
  assert.ok(await page.locator("#section-blocked details[data-group]").evaluateAll((els) => els.length === 7 && els.every((e) => !e.open)));
  assert.ok(await page.locator("#section-avoid details[data-group]").evaluate((e) => !e.open));
  const visibleCards = await page.locator("article").evaluateAll((els) => els.filter((e) => e.checkVisibility()).length);
  assert.equal(visibleCards, 6 + 1 + 1 + 3, "only Tier A, Ready now, the one service decision and research are expanded");
  assert.ok(await page.locator("#section-fix_now details[data-group] >> nth=0").evaluate((el) => el.querySelectorAll("article > details").length === 6 && [...el.querySelectorAll("article details")].every((d) => !d.open)), "Details collapsed");
  ok("Work queue: Tier A open and first (Roof Repair), Tier B 16 / C 1 collapsed, Ready now open, cadence item collapsed with its date, decisions grouped 1 / 19 / 7, 3 research open, 7 blocked groups and Avoid collapsed; 11 of 68 cards expanded");

  // Blocked groups name what unblocks them and link to the Fix Now item.
  const gutters = page.locator("#section-blocked details[data-group]").filter({ hasText: "Set Gutter Installation & Repair's service page" });
  assert.equal(await gutters.locator(":scope > summary [data-count]").innerText(), "1");
  assert.equal(await gutters.locator(":scope > summary a").getAttribute("href"), "#opp-data_fix:service-page:gutter-installation-repair");
  assert.equal(await page.locator('[id="opp-data_fix:service-page:gutter-installation-repair"]').count(), 1);
  ok("Blocked: grouped by the prerequisite that unblocks them, each linked to its Fix Now item");
  await shot("authority-lucas-desktop");

  // Opening a group and a card's Details.
  await page.locator("#fix-now-tier-B > summary").click();
  assert.equal(await page.locator("#fix-now-tier-B article").evaluateAll((els) => els.filter((e) => e.checkVisibility()).length), 16);
  const card = page.locator('[data-key="page_improvement:home"]');
  await card.locator("details > summary", { hasText: "Details" }).click();
  const details = await card.innerText();
  for (const s of ["Reasons", "Gates", "no_new_claims", "page_improvement:home", "First seen", "created"]) assert.ok(details.includes(s), `details show ${s}`);
  ok("Opening Tier B shows its 16 cards; Details shows reasons, gates, key and lifecycle history");

  // 3. Run history: both runs, the current one marked.
  const rows = page.locator('[data-history="table"] tbody tr');
  assert.equal(await rows.count(), 2);
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => [e.dataset.run, e.dataset.status])), [[refreshId, "completed"], [fullId, "completed"]]);
  assert.ok((await rows.nth(0).innerText()).includes("current"));
  assert.ok((await rows.nth(0).innerText()).includes("no change"));
  assert.ok((await rows.nth(1).innerText()).includes("+68 added"));
  assert.ok((await rows.nth(1).innerText()).includes("Sam Team"));
  assert.ok((await rows.nth(1).innerText()).includes("64 URLs · 0 errors"));
  ok("Run history: refresh (current, no change, inventory reused) and full (+68 added, Sam Team, 64 URLs · 0 errors)");

  // 4. Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await noHorizontalScroll(page), "no horizontal scroll at 390px");
  assert.ok(await page.locator('[data-history="cards"]').isVisible());
  assert.ok(!(await page.locator('[data-history="table"]').isVisible()));
  await shot("authority-lucas-mobile");
  ok("Mobile (390px): no horizontal scroll; run history as stacked cards");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 5. Stale: a keyword change after the analysis.
  sql(`insert into keywords (id, client_id, keyword) values ('00000000-0000-4000-d000-0000000000c1', '${LUCAS}', 'roof replacement near me')`);
  await page.goto(url, { waitUntil: "networkidle" });
  const stale = page.locator('[data-banner="stale"]');
  assert.ok(await stale.isVisible());
  assert.match(await stale.innerText(), /keywords changed\. A refresh \(re-judging with the stored site inventory\) will bring it up to date\./);
  assert.equal(await page.locator("[data-state]").getAttribute("data-state"), "stale");
  await shot("authority-stale-desktop");
  sql(`delete from keywords where id = '00000000-0000-4000-d000-0000000000c1'`);
  await page.goto(url, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-banner="stale"]').count(), 0);
  ok("Stale: a keyword added after the run shows the stale banner (refresh suggested); removing it clears it");

  // 6. Degraded and failed attempts: stored, shown in history, never replace the results.
  await recordRun({ mode: "full", via: "team", by: sam, status: "degraded", fetchedAt: "2026-09-27T10:00:00Z",
    health: { status: "degraded", reasons: ["home page answered 503", "40 of 64 URLs errored"], inventory_errors: 40 } });
  await recordRun({ mode: "full", via: "worker", status: "failed", error: "The inventory could not resolve the site's host." });
  await page.goto(url, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-state]").getAttribute("data-state"), "attempt_problem");
  assert.match(await page.locator('[data-banner="failed"]').innerText(), /could not resolve the site's host.*Showing results from/s);
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => e.dataset.status)), ["failed", "degraded", "completed", "completed"]);
  assert.ok((await rows.nth(1).innerText()).includes("unchanged (degraded)"));
  assert.ok((await rows.nth(1).innerText()).includes("home page answered 503"));
  assert.ok((await page.locator(`[data-run="${refreshId}"]`).first().innerText()).includes("current"), "the completed refresh is still current");
  assert.equal(await summaryCount("fix_now"), 23, "a degraded or failed run changes no opportunity");
  await shot("authority-attempts-desktop");
  ok("Degraded and failed runs: listed in history with their reasons, a failed-attempt banner, results still from the completed refresh");

  // 7. Running: a run in progress is shown; nothing on the page starts one.
  const running = await recordRun({ mode: "refresh", via: "worker", status: "running" });
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await page.locator('[data-banner="running"]').isVisible());
  assert.equal(await page.getByRole("button", { name: /Run|Refresh|Accept|Dismiss/ }).count(), 0, "no run, refresh or decision controls in this checkpoint");
  await rpc("authority_record_run", { p_run_id: running, p: { status: "failed", error: "test cleanup" } });
  ok("Running: a run in progress shows a banner; the page has no run, refresh or decision buttons");

  // 8. No run yet.
  await page.goto(`${base}/clients/${CLIENT_A}/authority`, { waitUntil: "networkidle" });
  assert.ok(await page.locator('[data-empty="authority"]').isVisible());
  assert.ok((await page.locator('[data-empty="authority"]').innerText()).includes("No Authority analysis yet"));
  await shot("authority-empty-desktop");
  ok("No run yet: the empty state explains the analysis and starts nothing");

  assert.deepEqual(errors, []);

  // 9. Portal users reach none of it.
  const portalCtx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const portalPage = await portalCtx.newPage();
  await portalPage.goto(url, { waitUntil: "networkidle" });
  assert.ok(!portalPage.url().includes("/authority"), `portal user was not left on the Authority page (${portalPage.url()})`);
  assert.equal(await portalPage.getByText("Fix Now").count(), 0);
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}` };
  for (const t of ["authority_runs", "authority_opportunities", "authority_opportunity_events", "authority_opportunity_links", "authority_latest", "authority_opportunity_state"]) {
    const r = await fetch(`${gatewayUrl}/rest/v1/${t}?select=*`, { headers: asPortal });
    assert.deepEqual(await r.json(), [], `${t} empty for a portal user`);
  }
  ok("Portal contact: redirected away from the tab; every Authority table and view reads empty through the API");

  assert.deepEqual(unexpected, []);
  console.log(`Authority browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
