// Browser acceptance check for the Authority tab's run controls: Run Full
// Analysis / Refresh, the running watcher and every answer authority-run can
// give. Run by `npm run test:authority-controls-ui` (scripts/test-tasks-ui.sh
// with UI_SPEC set): a real Postgres replay behind PostgREST, `next dev` and
// Chromium. The gateway serves /functions/v1/authority-run with the real
// handler and store (supabase/functions/authority-run), so the teammate's JWT
// is checked by the function itself and runs are begun and recorded through
// 0048 exactly as in production. The client's site is served in memory and
// DNS is a fake resolver. Nothing leaves the machine.
//
//   SCREENSHOTS=docs/screenshots/authority npm run test:authority-controls-ui
//
// Fictional client ("Sandbox Roofing", example.test addresses).
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createAuthorityRun } from "../supabase/functions/authority-run/handler.ts";
import { createStore } from "../supabase/functions/authority-run/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));
const C = "00000000-0000-4000-b000-0000000000a1";
const ROOF = "00000000-0000-4000-e000-0000000000a1";
const KW = "00000000-0000-4000-d000-0000000000a1";
const KW_NEW = "00000000-0000-4000-d000-0000000000c9";
const SITE = "https://roof.example.test";
const PAGE = `${SITE}/services/roof-replacement`;

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
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

// ── The fake site, DNS and the function's switches ─────────────────────────
let routes = {};
const siteFetch = async (url) => {
  const u = new URL(url);
  if (u.hostname !== "roof.example.test") throw new Error(`the inventory asked for another host: ${url}`);
  const [status, body] = routes[u.pathname] ?? [404, "<title>Not found</title>"];
  return new Response(body ?? "", { status });
};
let dns = ["93.184.216.34"];
const sw = { hold: null, inventoryThrows: false, answer: null, answerAfterStart: null, calls: 0 };
const jobs = [];
const settle = () => Promise.all(jobs.splice(0));
let releaseHold = () => {};
const holdRuns = () => { sw.hold = new Promise((r) => { releaseHold = () => { sw.hold = null; r(); }; }); };

// Supabase's gateway, reduced to /auth/v1/user, /rest/v1 and the one function.
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
  if (url.pathname === "/functions/v1/authority-run") {
    sw.calls++;
    if (sw.answer) { res.writeHead(sw.answer, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "upstream" })); }
    const headers = { "content-type": "application/json" };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const r = await fn.handle(new Request("http://x/authority-run", { method: req.method, headers, body }));
    // A gateway that loses the function's answer after it began the run.
    if (sw.answerAfterStart && r.status === 202) { res.writeHead(sw.answerAfterStart); return res.end(); }
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(await r.text());
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const store = createStore(createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }));
// The background half waits on sw.hold (when set) before it reads anything,
// so a run can be kept "running" while the page is looked at.
const heldStore = { ...store, fingerprint: async (id) => { if (sw.hold) await sw.hold; return store.fingerprint(id); } };
const fn = createAuthorityRun({
  store: heldStore, gazetteer, fetch: siteFetch, resolve: async () => dns, waitUntil: (p) => jobs.push(p),
  inventory: async (opts) => {
    if (sw.inventoryThrows) throw new Error("inventory exploded");
    const { inventorySite } = await import("../supabase/functions/authority/inventory.ts");
    return inventorySite(opts);
  },
});

const port = Number(process.env.AUTHORITY_UI_PORT ?? 3422);
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

const runs = () => sql(`select coalesce(string_agg(mode || ':' || status, ',' order by created_at), '') from authority_runs where client_id = '${C}'`);
const runCount = () => Number(sql(`select count(*) from authority_runs where client_id = '${C}'`));

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
try {
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Sandbox Roofing', 'Wentzville', 'MO', '(636) 555-0142', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority) values
       ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1')`);
  sql(`update services set primary_keyword_id = '${KW}' where id = '${ROOF}'`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids) values
       ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KW}', '{}')`);
  routes = {
    "/sitemap.xml": [200, `<urlset><url><loc>${SITE}/</loc></url><url><loc>${PAGE}</loc></url></urlset>`],
    "/": [200, "<title>Sandbox Roofing | Wentzville Roofing Contractor</title><body><h1>Wentzville roofing, done plainly.</h1></body>"],
    "/services/roof-replacement": [200, "<title>Roof Replacement in Wentzville | Sandbox Roofing</title><body><h1>Roof Replacement in Wentzville</h1></body>"],
  };

  // 0. The function itself: a portal contact's JWT and the anon key are refused.
  const direct = async (token) => (await fetch(`${gatewayUrl}/functions/v1/authority-run`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "full", client_id: C }) })).status;
  assert.equal(await direct(tokenFor(PORTAL)), 403);
  assert.equal(await direct(anonKey), 403);
  assert.equal(runCount(), 0);
  ok("authority-run refuses a portal contact's JWT and the anon key (403); no run row");

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
  // Server-action POSTs (the status polls and starts) and RSC refreshes.
  const traffic = [];
  page.on("request", (r) => {
    const h = r.headers();
    if (r.method() === "POST" && h["next-action"]) traffic.push({ t: Date.now(), kind: "action" });
    else if (r.method() === "GET" && h["rsc"] === "1") traffic.push({ t: Date.now(), kind: "rsc" });
  });
  const since = (t, kind) => traffic.filter((x) => x.t >= t && x.kind === kind).length;
  const shot = async (name, p = page) => {
    if (!SHOTS) return;
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  };
  const url = `${base}/clients/${C}/authority`;
  const full = (p = page) => p.locator('[data-run="full"]');
  const refresh = (p = page) => p.locator('[data-run="refresh"]');
  const message = (p = page) => p.locator("[data-run-message]");
  const waitMessage = async (re, p = page, timeout = 20000) => {
    await p.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-run-message]")?.textContent ?? ""), re.source, { timeout })
      .catch(async (e) => { throw new Error(`${e.message}\n  waiting for ${re}; the message reads: ${JSON.stringify(await message(p).innerText().catch(() => null))}`); });
    return message(p).innerText();
  };

  // 1. No analysis yet: Run Full Analysis is primary, Refresh waits for one.
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator('[data-empty="authority"]').waitFor();
  assert.equal(await full().innerText(), "Run Full Analysis");
  assert.equal(await refresh().innerText(), "Refresh");
  assert.equal(await full().getAttribute("data-primary"), "true");
  assert.ok(await full().isEnabled());
  assert.ok(await refresh().isDisabled());
  const controlsText = await page.locator('[data-controls="authority"]').innerText();
  assert.ok(controlsText.includes("Full analysis crawls the website again. Refresh rechecks current business and search data using the latest site snapshot."));
  assert.ok(controlsText.includes("Needs a full analysis first."));
  assert.equal(await page.getByRole("button", { name: /Accept|Dismiss|Approve|Draft/ }).count(), 0, "no decision controls");
  await shot("authority-controls-empty-desktop");
  ok("No analysis yet: Run Full Analysis (primary) and Refresh (disabled: needs a full analysis first), the helper text, no decision buttons");

  // 2. Run Full Analysis, double-clicked: one run; running state; a second tab gets the duplicate answer.
  const other = await ctx.newPage();
  await other.goto(url, { waitUntil: "networkidle" });
  holdRuns();
  await full().dblclick();
  await waitMessage(/Full analysis started\./);
  await page.locator('[data-banner="running"]').waitFor();
  assert.equal(runCount(), 1, "a double click starts one run");
  assert.equal(runs(), "full:running");
  assert.ok(await full().isDisabled());
  assert.ok(await refresh().isDisabled());
  assert.match(await page.locator('[data-banner="running"]').innerText(), /updates when it finishes/);
  await page.evaluate(() => getSelection()?.removeAllRanges()); // the double click selected text
  await shot("authority-controls-running-desktop");
  // The other tab still shows the empty page with the button enabled; its click meets the running run.
  await full(other).click();
  assert.match(await waitMessage(/already running/, other), /An analysis is already running for this client; showing its progress\./);
  assert.equal(runCount(), 1, "the second tab did not start another run");
  ok("Run Full Analysis: a double click starts exactly one run; buttons disabled while it runs; a second tab gets 409 run_in_progress as 'already running' and watches it");

  // 3. Polling only while running; one refresh when it finishes.
  const pollStart = Date.now();
  await page.waitForTimeout(7000);
  const polls = since(pollStart, "action");
  assert.ok(polls >= 1 && polls <= 4, `about one status poll every 3 s while running (${polls} in 7 s)`);
  releaseHold();
  await settle();
  assert.equal(runs(), "full:completed");
  const text = await waitMessage(/complete/);
  assert.match(text, /^Full analysis complete: \+\d+ added\.$/);
  await page.getByRole("heading", { name: /Last analyzed/ }).waitFor();
  const finishedAt = Date.now();
  await page.waitForTimeout(7000);
  assert.equal(since(finishedAt, "action"), 0, "no polling after the run finished");
  assert.equal(since(finishedAt - 3500, "rsc"), 1, "the page refreshed exactly once");
  assert.equal(await page.locator("[data-state]").getAttribute("data-state"), "current");
  assert.equal(await page.locator('[data-banner="running"]').count(), 0);
  assert.ok(await full().isEnabled());
  assert.ok(await refresh().isEnabled());
  await waitMessage(/complete/, other);
  await shot("authority-controls-completed-desktop");
  await other.close();
  ok(`Watcher: ${polls} status polls in 7 s while running, none after; the completed message ('${text}'); the page refreshed once into the results with both buttons enabled`);

  // 4. Hidden tab: no polling while hidden; a poll as soon as it is shown again.
  holdRuns();
  await refresh().click();
  await waitMessage(/Refresh started\./);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  const hiddenAt = Date.now();
  releaseHold();
  await settle();
  assert.equal(runs(), "full:completed,refresh:completed");
  await page.waitForTimeout(7000);
  assert.equal(since(hiddenAt, "action"), 0, "no polls while the tab is hidden");
  assert.match(await message().innerText(), /Refresh started\./, "the outcome is not known while hidden");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await waitMessage(/complete/, page, 3000), "Refresh complete: no change.");
  ok("Hidden tab: polling pauses while hidden (0 polls in 7 s), resumes immediately when shown; 'Refresh complete: no change.'");

  // 5. Stale CRM data: Refresh becomes the primary; a refresh clears the banner.
  sql(`insert into keywords (id, client_id, keyword) values ('${KW_NEW}', '${C}', 'roof replacement near me')`);
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await page.locator('[data-banner="stale"]').isVisible());
  assert.equal(await refresh().getAttribute("data-primary"), "true");
  assert.equal(await full().getAttribute("data-primary"), null);
  await shot("authority-controls-stale-desktop");
  await refresh().click();
  await settle();
  await waitMessage(/Refresh complete/);
  await page.getByRole("heading", { name: /Last analyzed/ }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-banner="stale"]'));
  assert.equal(await page.locator("[data-state]").getAttribute("data-state"), "current");
  assert.equal(await full().getAttribute("data-primary"), "true");
  ok("Stale: a keyword added after the run makes Refresh primary; the refresh completes and the stale banner clears without a reload");

  // 6. Site record changed: Refresh is refused in the page, Full clears it.
  sql(`insert into sites (client_id, url, content_paths) values ('${C}', '${SITE}', '{"blog": "data/blog-posts.json"}')`);
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await refresh().isDisabled());
  assert.ok((await page.locator('[data-controls="authority"]').innerText()).includes("The site record changed since the last snapshot; run a full analysis."));
  assert.equal(await full().getAttribute("data-primary"), "true");
  await full().click();
  await settle();
  await waitMessage(/Full analysis complete/);
  await page.waitForFunction(() => !document.querySelector('[data-banner="stale"]'));
  assert.ok(await refresh().isEnabled());
  ok("Site changed: Refresh disabled with the reason; a full analysis clears it");

  // 7. Degraded: the host resolves to a private address.
  const before = sql(`select string_agg(key || status || section, ',' order by key) from authority_opportunities where client_id = '${C}'`);
  dns = ["10.0.0.9"];
  await full().click();
  await settle();
  const degraded = await waitMessage(/degraded/);
  assert.match(degraded, /^Full analysis finished degraded \(home page answered nothing.*\)\. Results are unchanged\.$/);
  await page.locator('[data-banner="degraded"]').waitFor();
  assert.equal(sql(`select string_agg(key || status || section, ',' order by key) from authority_opportunities where client_id = '${C}'`), before);
  await shot("authority-controls-degraded-desktop");
  dns = ["93.184.216.34"];
  ok(`Degraded: '${degraded}'; the degraded banner shows and no opportunity changed`);

  // 8. Failed: the background run throws.
  sw.inventoryThrows = true;
  await full().click();
  await settle();
  assert.equal(await waitMessage(/failed/), "Full analysis failed: inventory exploded. Results are unchanged.");
  await page.locator('[data-banner="failed"]').waitFor();
  sw.inventoryThrows = false;
  ok("Failed: 'Full analysis failed: inventory exploded. Results are unchanged.' and the failed-attempt banner");

  // 9. No clear answer (a 502 from the gateway): nothing claimed either way.
  const n = runCount();
  sw.answer = 502;
  await full().click();
  const uncertain = await waitMessage(/Couldn't confirm/);
  assert.equal(uncertain, "Couldn't confirm that the analysis started (no clear answer from the Authority service). It may have started; the page will show it if so.");
  assert.equal(runCount(), n);
  await page.waitForFunction(() => !document.querySelector('[data-run="full"]').disabled, null, { timeout: 5000 }); // nothing is running: usable again
  sw.answer = null;
  await shot("authority-controls-uncertain-desktop");
  // The run began but its answer was lost: the page finds it running, watches it and reports it.
  holdRuns();
  sw.answerAfterStart = 504;
  await refresh().click();
  await waitMessage(/Couldn't confirm/);
  sw.answerAfterStart = null;
  await page.locator('[data-banner="running"]').waitFor();
  assert.ok(await full().isDisabled(), "the refreshed page shows the run and disables the buttons");
  releaseHold();
  await settle();
  assert.equal(await waitMessage(/complete/), "Refresh complete: no change.");
  ok("Ambiguous answers: a 502 says it couldn't confirm (no run made, buttons usable); a lost 202 is found on the refreshed page, watched and reported");

  // 10. Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 390px");
  assert.ok(await full().isVisible());
  await shot("authority-controls-mobile");
  holdRuns();
  await full().click();
  await waitMessage(/Full analysis started\./);
  await page.locator('[data-banner="running"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot("authority-controls-running-mobile");
  releaseHold();
  await settle();
  await waitMessage(/complete/);
  ok("Mobile (390px): controls, helper and running state fit without horizontal scroll");

  // 11. Offboarded: no controls.
  sql(`update clients set status = 'offboarded' where id = '${C}'`);
  await page.goto(url, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-controls="authority"]').count(), 0);
  ok("Offboarded client: no run controls");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Authority controls browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
