// Browser acceptance check for Authority reconciliation (C2): Set service
// page, Re-home keywords, Record existing content and Map unmapped keywords,
// each previewed (before → after), applied through authority_apply (0050 /
// 0051 / 0052) as the signed-in teammate, and followed by one Authority
// refresh. Run by `npm run test:authority-reconcile-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, `next dev` and Chromium. The gateway serves
// /functions/v1/authority-run with the real handler, store and engine, so
// the data fixes come from a real analysis of a fake site served in memory
// and a refresh really resolves (or shrinks) them. Nothing leaves the machine.
//
//   SCREENSHOTS=docs/screenshots/authority npm run test:authority-reconcile-ui
//
// Fictional client ("Reconcile Roofing", example.test addresses).
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
const C = "00000000-0000-4000-b000-00000000007a";
const RR = "00000000-0000-4000-e000-00000000007a";
const GU = "00000000-0000-4000-e000-00000000007b";
const SD = "00000000-0000-4000-e000-00000000007c";
const K_PRIMARY = "00000000-0000-4000-d000-00000000007a";
const K_HOME = "00000000-0000-4000-d000-00000000007b";
const K_SVC = "00000000-0000-4000-d000-00000000007c";
const K_AMB = "00000000-0000-4000-d000-00000000007d";
const K_HOMEP = "00000000-0000-4000-d000-00000000007e";
const K_MAP = "00000000-0000-4000-d000-0000000007a1";
const K_TROY = "00000000-0000-4000-d000-0000000007a2";
const G_HOME = "00000000-0000-4000-f000-00000000007a";
const G_RR = "00000000-0000-4000-f000-00000000007b";
const G_GU = "00000000-0000-4000-f000-00000000007c";
const G_HUB = "00000000-0000-4000-f000-00000000007d";
const SITE = "https://recon.example.test";
const RR_PAGE = `${SITE}/services/roof-replacement`;
const GU_PAGE = `${SITE}/services/gutters`;
const SP_GU = `data_fix:service-page:${GU}`;
const OWN_RR = `data_fix:keyword-ownership:${RR}`;
const RECORD = "data_fix:record-live-blog-posts";
const UNMAPPED = "data_fix:unmapped-keywords";
const MARKET_TROY = "confirm_market:troy";
const TIPS = Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-d000-0000000007${(0xb0 + i).toString(16)}`);

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

// ── The fake site and DNS ───────────────────────────────────────────────────
let routes = {};
const siteFetch = async (url) => {
  const u = new URL(url);
  if (u.hostname !== "recon.example.test") throw new Error(`the inventory asked for another host: ${url}`);
  const [status, body] = routes[u.pathname] ?? [404, "<title>Not found</title>"];
  return new Response(body ?? "", { status });
};
const jobs = [];
const settle = () => Promise.all(jobs.splice(0));
const fnCalls = [];

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
    fnCalls.push(JSON.parse(body.toString() || "{}").mode);
    const headers = { "content-type": "application/json" };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const r = await fn.handle(new Request("http://x/authority-run", { method: req.method, headers, body }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(await r.text());
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const store = createStore(createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }));
const fn = createAuthorityRun({
  store, gazetteer, fetch: siteFetch, resolve: async () => ["93.184.216.34"], waitUntil: (p) => jobs.push(p),
  inventory: async (opts) => (await import("../supabase/functions/authority/inventory.ts")).inventorySite(opts),
});

const port = Number(process.env.AUTHORITY_UI_PORT ?? 3426);
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

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
const opp = (key) => {
  const out = sql(`select row_to_json(o) from (select o.id, o.status, o.present, s.effective_status, o.opportunity->'candidate_paths' as candidates
    from authority_opportunities o join authority_opportunity_state s on s.id = o.id where o.client_id = '${C}' and o.key = '${key}') o`);
  return out ? JSON.parse(out) : null;
};
const runs = (mode) => Number(sql(`select count(*) from authority_runs where client_id = '${C}' and mode = '${mode}'`));
const decisions = (key) => Number(sql(`select count(*) from authority_opportunity_events e join authority_opportunities o on o.id = e.opportunity_id
  where o.client_id = '${C}' and o.key = '${key}' and e.kind = 'decision'`));
const kwRow = (id) => JSON.parse(sql(`select row_to_json(k) from (select service_id, target_url from keywords where id = '${id}') k`));
const listed = (id) => sql(`select coalesce(string_agg(name, ',' order by name), '') from page_groups where '${id}' = any (supporting_keyword_ids)`);

try {
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Reconcile Roofing', 'Wentzville', 'MO', '(636) 555-0177', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values
       ('${RR}', '${C}', 'Roof Replacement', 'approved', '${RR_PAGE}', 'Roofing', 1),
       ('${GU}', '${C}', 'Gutters', 'approved', null, 'Exterior', 2),
       ('${SD}', '${C}', 'Storm Damage', 'approved', null, 'Roofing', 3)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority) values
       ('${K_PRIMARY}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${RR}', '${RR_PAGE}', 'p1'),
       ('${K_HOMEP}', '${C}', 'roofer near me', 'commercial', true, true, false, null, '${SITE}/', 'p2'),
       ('${K_HOME}', '${C}', 'roofing company near me', 'commercial', true, true, false, '${RR}', '${SITE}/', 'p2'),
       ('${K_SVC}', '${C}', 'roof replacement near me', 'commercial', true, true, false, '${RR}', '/', 'p2'),
       ('${K_AMB}', '${C}', 'roofing company troy', 'commercial', true, true, false, '${RR}', '/', 'p3'),
       ('${K_MAP}', '${C}', 'seamless gutters', 'commercial', true, true, false, null, null, 'p3'),
       ('${K_TROY}', '${C}', 'gutters troy', 'commercial', true, true, false, null, null, 'p3')`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, service_id) values ${TIPS.map((id, i) => `('${id}', '${C}', 'gutter tip number ${i + 1}', 'informational', true, false, null)`).join(", ")}`);
  sql(`update services set primary_keyword_id = '${K_PRIMARY}' where id = '${RR}'`);
  sql(`insert into page_groups (id, client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids) values
       ('${G_HOME}', '${C}', 'Home', 'home', 'approved', '${SITE}/', '${K_HOMEP}', '{}'),
       ('${G_RR}', '${C}', 'Roof Replacement', 'service', 'approved', '${RR_PAGE}', '${K_PRIMARY}', '{${K_HOME},${K_SVC}}'),
       ('${G_GU}', '${C}', 'Gutters', 'service', 'approved', '${GU_PAGE}', null, '{}'),
       ('${G_HUB}', '${C}', 'Exterior', 'hub', 'approved', null, null, '{}')`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, supporting_keyword_ids) values
       ('${C}', 'Storm Damage', 'service', 'approved', '${SITE}/services/storm-damage', '{}')`);
  sql(`insert into locations (client_id, name, city, state, lat, lng, is_active) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO', 38.8114, -90.8529, true)`);
  const html = (title, h1) => [200, `<title>${title}</title><body><h1>${h1}</h1><p>Plain words about the work.</p></body>`];
  const pages = ["/", "/services/roof-replacement", "/services/gutters", "/service-areas/wentzville", "/service-areas/troy", "/blog", "/blog/ice-dams", "/blog/attic-vents", "/blog/gutter-sizing"];
  routes = {
    "/sitemap.xml": [200, `<urlset>${pages.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join("")}</urlset>`],
    "/": html("Reconcile Roofing | Wentzville Roofer", "Wentzville roofing, done plainly."),
    "/services/roof-replacement": html("Roof Replacement in Wentzville | Reconcile Roofing", "Roof Replacement in Wentzville"),
    "/services/gutters": html("Gutters | Reconcile Roofing", "Gutters"),
    "/service-areas/wentzville": html("Roofing in Wentzville, MO | Reconcile Roofing", "Roofing in Wentzville"),
    "/service-areas/troy": html("Roofing in Troy, MO | Reconcile Roofing", "Roofing in Troy"),
    "/blog": html("Blog | Reconcile Roofing", "Blog"),
    "/blog/ice-dams": html("Ice dams explained | Reconcile Roofing", "Ice dams explained"),
    "/blog/attic-vents": html("Attic vents | Reconcile Roofing", "Why attic vents matter"),
    "/blog/gutter-sizing": html("Gutter sizing | Reconcile Roofing", "Sizing gutters"),
  };

  const first = await fetch(`${gatewayUrl}/functions/v1/authority-run`, { method: "POST", headers: { Authorization: `Bearer ${tokenFor(TEAM)}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "full", client_id: C }) });
  assert.equal(first.status, 202);
  await settle();
  for (const k of [SP_GU, OWN_RR, RECORD, UNMAPPED, MARKET_TROY]) assert.ok(opp(k)?.present, `the analysis reports ${k}`);
  assert.deepEqual(opp(RECORD).candidates, ["/blog/attic-vents", "/blog/gutter-sizing", "/blog/ice-dams"]);
  const flags = JSON.parse(sql(`select jsonb_object_agg(e->>'keyword', e->'flags') from authority_runs r, jsonb_array_elements(r.report->'keywords') e
    where r.client_id = '${C}' and r.status = 'completed' and e->>'keyword' in ('roofing company near me', 'roof replacement near me', 'roofing company troy', 'gutters troy')`));
  assert.ok(flags["roofing company near me"].includes("home_eligible"), JSON.stringify(flags));
  assert.ok(flags["roofing company troy"].includes("home_ambiguous"), JSON.stringify(flags));
  assert.ok(!flags["roof replacement near me"].some((f) => f.startsWith("home_")), JSON.stringify(flags));
  assert.ok(flags["gutters troy"].includes("location_unapproved"), JSON.stringify(flags));
  ok("A real full analysis reports the four data fixes (candidate_paths structured and sorted) and the Troy market decision");
  fnCalls.length = 0;

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
  const shot = async (name, p = page, fullPage = true) => {
    if (!SHOTS) return;
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
  };
  const url = `${base}/clients/${C}/authority`;
  const card = (key) => page.locator(`article[data-key="${key}"]`);
  const openGroups = () => page.locator("details[data-group]").evaluateAll((els) => els.forEach((d) => { d.open = true; }));
  const dialog = (action) => page.locator(`[data-reconcile-dialog="${action}"]`);
  const open = async (key, action) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await openGroups();
    await card(key).locator(`[data-open-reconcile="${action}"]`).click();
    await dialog(action).locator("[data-rows]").waitFor();
    return dialog(action);
  };
  const waitRunMessage = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-run-message]")?.textContent ?? ""), re.source, { timeout: 20000 })
    .catch(async (e) => { throw new Error(`${e.message}\n  run message: ${JSON.stringify(await page.locator("[data-run-message]").innerText().catch(() => null))}`); });

  // 1. The controls.
  await page.goto(url, { waitUntil: "networkidle" });
  await openGroups();
  for (const [k, a] of [[SP_GU, "set_service_page"], [OWN_RR, "rehome_keywords"], [RECORD, "record_content"], [UNMAPPED, "map_keywords"]]) {
    assert.equal(await card(k).locator(`[data-open-reconcile="${a}"]`).count(), 1, `${k} carries ${a}`);
  }
  assert.equal(await page.locator("[data-open-reconcile]").count(), 4, "no other card carries a reconciliation");
  await shot("authority-reconcile-cards-desktop");
  ok("Each data-fix card carries its one Reconcile control; no other card does");

  // 2. Set service page: stale preview refused (0052), then applied, one refresh, resolved.
  let d = await open(SP_GU, "set_service_page");
  assert.equal(await d.locator("[data-tick]").count(), 0, "one row, nothing to tick");
  assert.equal(await d.locator('[data-change="services · Gutters.page_url"] [data-before]').innerText(), "—");
  assert.equal(await d.locator('[data-change="services · Gutters.page_url"] [data-after]').innerText(), `→ ${GU_PAGE}`);
  await shot("authority-reconcile-service-page-dialog-desktop", page, false);
  sql(`update page_groups set target_url = '${GU_PAGE}/' where id = '${G_GU}'`); // another teammate, after the preview
  await d.locator("[data-confirm-reconcile]").click();
  await d.locator('[data-apply-error="stale"]').waitFor();
  assert.match(await d.locator("[data-apply-error]").innerText(), /Changed since the preview: the service's page group now targets .*Nothing was saved/);
  assert.equal(sql(`select coalesce(page_url, 'null') from services where id = '${GU}'`), "null", "nothing written");
  assert.equal(decisions(SP_GU), 0);
  assert.equal(fnCalls.length, 0, "no refresh after a refusal");
  sql(`update page_groups set target_url = '${GU_PAGE}' where id = '${G_GU}'`);
  await d.locator("[data-review-again]").click();
  await d.locator("[data-confirm-reconcile]:not([disabled])").waitFor();
  await d.locator("[data-confirm-reconcile]").click();
  await waitRunMessage(/Service page set for Gutters\. Refreshing the analysis with the change\./);
  assert.equal(sql(`select page_url from services where id = '${GU}'`), GU_PAGE);
  assert.deepEqual(fnCalls, ["refresh"], "exactly one refresh, never a full analysis");
  await settle();
  await waitRunMessage(/Refresh complete/);
  assert.equal(opp(SP_GU).present, false, "the refresh resolved it");
  ok("Set service page: before → after shown; a page group edited after the preview is refused (AU409, nothing written, no refresh); Preview again, apply, one refresh, resolved");

  // 3. Record content: nothing ticked; a page recorded meanwhile is skipped (partial); Partly recorded; the rest stays actionable.
  fnCalls.length = 0;
  d = await open(RECORD, "record_content");
  assert.equal(await d.locator("[data-selected-count]").getAttribute("data-selected-count"), "0");
  assert.equal(await d.locator("[data-tick]:checked").count(), 0, "no row preselected");
  assert.equal(await d.getByText(/select all/i).count(), 0, "no Select All");
  assert.ok(await d.locator("[data-confirm-reconcile]").isDisabled(), "nothing to apply until a row is ticked");
  assert.match(await d.locator('[data-row="/blog/ice-dams"]').innerText(), /content_posts · new row[\s\S]*Ice dams explained[\s\S]*site_inventory \(Not produced by Compass\.\)/);
  await d.locator('[data-tick="/blog/ice-dams"]').check();
  await d.locator('[data-tick="/blog/attic-vents"]').check();
  assert.equal(await d.locator("[data-confirm-reconcile]").innerText(), "Apply 2 changes");
  await shot("authority-reconcile-record-dialog-desktop", page, false);
  sql(`insert into content_posts (client_id, title, status, url) values ('${C}', 'Attic vents (written by Compass)', 'published', '${SITE}/blog/attic-vents')`);
  await d.locator("[data-confirm-reconcile]").click();
  await waitRunMessage(/Recorded 1 page from the client's site \(Not produced by Compass\.\) 1 already recorded: \/blog\/attic-vents\. Refreshing/);
  assert.equal(await card(RECORD).locator('[data-reconcile-message="partial"]').count(), 1, "the partial answer is marked partial");
  assert.equal(sql(`select count(*) from content_posts where client_id = '${C}' and origin = 'site_inventory' and url = '${SITE}/blog/ice-dams'`), "1");
  assert.equal(sql(`select count(*) from content_posts where client_id = '${C}' and url like '%attic-vents%'`), "1", "skipped, not duplicated");
  await settle();
  await waitRunMessage(/Refresh complete/);
  assert.deepEqual(opp(RECORD).candidates, ["/blog/gutter-sizing"], "the refresh lists only the page left");
  assert.equal(opp(RECORD).effective_status, "completed", "the stored lifecycle alone would call it done…");
  await page.goto(url, { waitUntil: "networkidle" });
  await openGroups();
  assert.equal(await card(RECORD).locator("[data-status]").innerText(), "Partly recorded · 1 remaining", "…the card does not");
  assert.equal(await card(RECORD).locator('[data-status]').getAttribute("data-status"), "partly_recorded");
  assert.equal(await card(RECORD).locator('[data-open-reconcile="record_content"]').count(), 1, "the Reconcile control stays");
  await shot("authority-reconcile-partly-recorded-desktop");
  d = await open(RECORD, "record_content");
  assert.deepEqual(await d.locator("[data-row]").evaluateAll((els) => els.map((e) => [e.dataset.row, e.dataset.enabled])), [["/blog/gutter-sizing", "1"]]);
  await d.locator('[data-tick="/blog/gutter-sizing"]').check();
  await d.locator("[data-confirm-reconcile]").click();
  await waitRunMessage(/Recorded 1 page/);
  await settle();
  await waitRunMessage(/Refresh complete/);
  assert.equal(opp(RECORD).present, false, "no page left: the analysis no longer reports it");
  assert.deepEqual(fnCalls, ["refresh", "refresh"], "one refresh per successful apply");
  ok("Record content: rows from candidate_paths, none ticked, no Select All; a page recorded meanwhile is skipped (partial, not duplicated); the card reads 'Partly recorded · 1 remaining' and keeps its control; the last page resolves it");

  // 4. Re-home: Home rows name the groups they leave (0051/0052); ambiguous row points at Ownership; stale groups refused.
  fnCalls.length = 0;
  d = await open(OWN_RR, "rehome_keywords");
  assert.equal(await d.locator(`[data-row="${K_AMB}"]`).getAttribute("data-enabled"), "0");
  assert.match(await d.locator(`[data-row="${K_AMB}"] [data-row-reason]`).innerText(), /Ownership/);
  assert.equal(await d.locator(`[data-row="${K_AMB}"] [data-link="confirm_owner:${K_AMB}"]`).count(), 1);
  assert.match(await d.locator(`[data-row="${K_HOME}"]`).innerText(), /page_groups · Roof Replacement · supporting_keyword_ids[\s\S]*removed[\s\S]*page_groups · Home · supporting_keyword_ids[\s\S]*added/);
  assert.match(await d.locator(`[data-row="${K_SVC}"]`).innerText(), new RegExp(`target_url[\\s\\S]*→ ${RR_PAGE}`));
  await d.locator(`[data-tick="${K_HOME}"]`).check();
  await d.locator(`[data-tick="${K_SVC}"]`).check();
  await shot("authority-reconcile-rehome-dialog-desktop", page, false);
  sql(`update page_groups set supporting_keyword_ids = '{${K_HOME}}' where id = '${G_HUB}'`); // after the preview
  await d.locator("[data-confirm-reconcile]").click();
  await d.locator('[data-apply-error="stale"]').waitFor();
  assert.match(await d.locator("[data-apply-error]").innerText(), /page groups listing "roofing company near me" changed/);
  assert.deepEqual(kwRow(K_HOME), { service_id: RR, target_url: `${SITE}/` }, "nothing written");
  assert.equal(kwRow(K_SVC).target_url, "/", "the valid row in the same batch was not written either");
  await d.locator("[data-review-again]").click();
  await d.locator(`[data-tick="${K_HOME}"]`).check();
  await d.locator(`[data-tick="${K_SVC}"]`).check();
  assert.match(await d.locator(`[data-row="${K_HOME}"]`).innerText(), /page_groups · Exterior · supporting_keyword_ids/, "the fresh preview names the new group");
  await d.locator("[data-confirm-reconcile]").click();
  await waitRunMessage(/Re-homed 2 keywords: 1 to Home, 1 to Roof Replacement's page\. Refreshing/);
  assert.deepEqual(kwRow(K_HOME), { service_id: null, target_url: `${SITE}/` });
  assert.equal(listed(K_HOME), "Home", "left Roof Replacement and Exterior, joined Home, in one transaction");
  assert.deepEqual(kwRow(K_SVC), { service_id: RR, target_url: RR_PAGE });
  assert.equal(listed(K_AMB), "", "the ambiguous keyword was not touched");
  assert.equal(kwRow(K_AMB).service_id, RR);
  await settle();
  await waitRunMessage(/Refresh complete/);
  assert.deepEqual(fnCalls, ["refresh"]);
  ok("Re-home: Home rows show every group they leave and Home's list; the ambiguous row is unavailable and links to its Ownership decision; a group that started listing the keyword after the preview is refused (AU409, whole batch rolled back); the fresh preview applies atomically, one refresh");

  // 5. Map: unapproved market blocked with its decision; no service preselected; 25 cap; live pages only.
  fnCalls.length = 0;
  d = await open(UNMAPPED, "map_keywords");
  const troy = d.locator(`[data-row="${K_TROY}"]`);
  assert.equal(await troy.getAttribute("data-enabled"), "0");
  assert.match(await troy.locator("[data-row-reason]").innerText(), /^This keyword references an unapproved market\. Decide on that market first\. \(Troy\)$/);
  assert.equal(await troy.locator(`[data-link="${MARKET_TROY}"]`).count(), 1, "links to the Troy market decision");
  assert.equal(await d.locator(`[data-choose="${K_MAP}"]`).inputValue(), "", "no service preselected");
  assert.deepEqual(await d.locator(`[data-choose="${K_MAP}"] option`).evaluateAll((os) => os.map((o) => [o.textContent, o.disabled])),
    [["Choose a service…", false], ["Gutters", false], ["Roof Replacement", false], ["Storm Damage (Storm Damage has no live page yet)", true]]);
  for (const id of TIPS.slice(0, 25)) await d.locator(`[data-tick="${id}"]`).check();
  assert.equal(await d.locator("[data-selected-count]").getAttribute("data-selected-count"), "25");
  assert.ok(await d.locator(`[data-tick="${TIPS[25]}"]`).isDisabled(), "the 26th row cannot be ticked");
  assert.ok(await d.locator(`[data-tick="${K_MAP}"]`).isDisabled());
  for (const id of TIPS.slice(0, 25)) await d.locator(`[data-tick="${id}"]`).uncheck();
  await d.locator(`[data-tick="${K_MAP}"]`).check();
  assert.ok(await d.locator("[data-confirm-reconcile]").isDisabled(), "a ticked row needs a service");
  await d.locator(`[data-choose="${K_MAP}"]`).selectOption({ label: "Gutters" });
  assert.match(await d.locator(`[data-row="${K_MAP}"]`).innerText(), new RegExp(`service_id[\\s\\S]*— \\(unmapped\\)[\\s\\S]*→ Gutters[\\s\\S]*target_url[\\s\\S]*→ ${GU_PAGE}`));
  await shot("authority-reconcile-map-dialog-desktop", page, false);
  await troy.locator(`[data-link="${MARKET_TROY}"]`).click();
  await page.waitForFunction(() => !document.querySelector("[data-reconcile-dialog]"));
  assert.ok(await card(MARKET_TROY).isVisible(), "Go to the market decision closes the dialog and shows the card");
  d = await open(UNMAPPED, "map_keywords");
  await d.locator(`[data-tick="${K_MAP}"]`).check();
  await d.locator(`[data-choose="${K_MAP}"]`).selectOption({ label: "Gutters" });
  await d.locator("[data-confirm-reconcile]").click();
  await waitRunMessage(/Mapped 1 keyword: seamless gutters → Gutters\. Refreshing/);
  assert.deepEqual(kwRow(K_MAP), { service_id: GU, target_url: GU_PAGE });
  assert.deepEqual(kwRow(K_TROY), { service_id: null, target_url: null });
  await settle();
  await waitRunMessage(/Refresh complete/);
  assert.deepEqual(fnCalls, ["refresh"]);
  ok("Map: the Troy keyword is blocked with 'references an unapproved market. Decide on that market first.' and links to the market decision; nothing preselected; services without a live page are not offered; the 26th tick is disabled; mapped with one refresh");

  // 6. Provenance: every apply left one decision event with its rows.
  const events = JSON.parse(sql(`select json_agg(detail->>'action' order by created_at) from authority_opportunity_events e join authority_opportunities o on o.id = e.opportunity_id
    where o.client_id = '${C}' and e.kind = 'decision'`));
  assert.deepEqual(events, ["set_service_page", "record_content", "record_content", "rehome_keywords", "map_keywords"]);
  await page.goto(url, { waitUntil: "networkidle" });
  ok("Provenance: one decision event per successful apply (none for the refused ones), each with its rows");

  // 7. Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  d = await open(UNMAPPED, "map_keywords");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll at 390px");
  assert.ok(await d.evaluate((el) => el.getBoundingClientRect().left >= -1 && el.getBoundingClientRect().right <= window.innerWidth + 1), "the dialog fits the screen");
  assert.ok(await d.locator("[data-rows]").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "rows do not scroll sideways");
  await shot("authority-reconcile-dialog-mobile", page, false);
  await page.keyboard.press("Escape");
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot("authority-reconcile-mobile");
  await page.setViewportSize({ width: 1280, height: 900 });
  ok("Mobile (390px): the dialog fits, its rows wrap, no horizontal scroll");

  // 8. A portal contact cannot reconcile.
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}`, "content-type": "application/json" };
  const r = await fetch(`${gatewayUrl}/rest/v1/rpc/authority_apply`, { method: "POST", headers: asPortal,
    body: JSON.stringify({ p_opportunity_id: opp(UNMAPPED).id, p_action: "map_keywords", p_payload: { rows: [] }, p_expected: {} }) });
  assert.ok(r.status === 403 || r.status === 401, `portal apply refused (${r.status})`);
  assert.equal(runs("full"), 1, "only the first analysis was a full one");
  ok("A portal contact is refused through the API; the only full analysis is the first");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Authority reconciliation browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
