// Browser acceptance check for Authority decisions (0049, Decisions PR B):
// intent, market and service decisions and Create task, each previewed,
// applied through authority_apply as the signed-in teammate, and followed by
// an Authority refresh when client data changed. Run by
// `npm run test:authority-decisions-ui` (scripts/test-tasks-ui.sh with
// UI_SPEC set): a real Postgres replay behind PostgREST, `next dev` and
// Chromium. The gateway serves /functions/v1/authority-run with the real
// handler, store and engine, so the decisions come from a real analysis of a
// fake site served in memory, and a refresh really resolves them. Nothing
// leaves the machine.
//
//   SCREENSHOTS=docs/screenshots/authority npm run test:authority-decisions-ui
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

const port = Number(process.env.AUTHORITY_UI_PORT ?? 3424);
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
const SAM = () => sql(`select id from team_members where email = '${TEAM.email}'`);
const opp = (key) => {
  const out = sql(`select row_to_json(o) from (select id, status, suppressed, suppression_basis, present from authority_opportunities where client_id = '${C}' and key = '${key}') o`);
  return out ? JSON.parse(out) : null;
};
const refreshRuns = () => Number(sql(`select count(*) from authority_runs where client_id = '${C}' and mode = 'refresh' and requested_via = 'team'`));

const KW_BRAND = "00000000-0000-4000-d000-0000000000b1";
const KW_BUYER = "00000000-0000-4000-d000-0000000000b2";
const INTENT_BRAND = `confirm_intent:${KW_BRAND}`;
const INTENT_BUYER = `confirm_intent:${KW_BUYER}`;
const MARKET = "confirm_market:ofallon";
const MARKET2 = "confirm_market:lake-saint-louis";
const SERVICE = "confirm_service:/services/commercial-roofing";
const SERVICE2 = "confirm_service:/services/solar-panels";

try {
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Sandbox Roofing', 'Wentzville', 'MO', '(636) 555-0142', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority) values
       ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1'),
       ('${KW_BRAND}', '${C}', 'sandbox reviews', 'commercial', true, true, false, '${ROOF}', '${PAGE}', 'p2'),
       ('${KW_BUYER}', '${C}', 'roof repair near me', 'informational', true, true, false, '${ROOF}', '${PAGE}', 'p2')`);
  sql(`update services set primary_keyword_id = '${KW}' where id = '${ROOF}'`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids) values
       ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KW}', '{}')`);
  sql(`insert into locations (client_id, name, city, state, lat, lng, is_active) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO', 38.8114, -90.8529, true)`);
  const html = (title, h1) => [200, `<title>${title}</title><body><h1>${h1}</h1></body>`];
  routes = {
    "/sitemap.xml": [200, `<urlset>${["/", "/services/roof-replacement", "/services/commercial-roofing", "/services/solar-panels", "/service-areas/wentzville", "/service-areas/ofallon", "/service-areas/lake-saint-louis"].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join("")}</urlset>`],
    "/": html("Sandbox Roofing | Wentzville Roofing Contractor", "Wentzville roofing, done plainly."),
    "/services/roof-replacement": html("Roof Replacement in Wentzville | Sandbox Roofing", "Roof Replacement in Wentzville"),
    "/services/commercial-roofing": html("Commercial Roofing | Sandbox Roofing", "Commercial Roofing"),
    "/services/solar-panels": html("Solar Panels | Sandbox Roofing", "Solar Panels"),
    "/service-areas/wentzville": html("Roofing in Wentzville, MO | Sandbox Roofing", "Roofing in Wentzville"),
    "/service-areas/ofallon": html("Roofing in O'Fallon, MO | Sandbox Roofing", "Roofing in O'Fallon"),
    "/service-areas/lake-saint-louis": html("Roofing in Lake Saint Louis, MO | Sandbox Roofing", "Roofing in Lake Saint Louis"),
  };

  // The first analysis, as a teammate would start it.
  const first = await fetch(`${gatewayUrl}/functions/v1/authority-run`, { method: "POST", headers: { Authorization: `Bearer ${tokenFor(TEAM)}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "full", client_id: C }) });
  assert.equal(first.status, 202);
  await settle();
  for (const k of [INTENT_BRAND, INTENT_BUYER, MARKET, MARKET2, SERVICE, SERVICE2]) assert.ok(opp(k)?.present, `the analysis reports ${k}`);
  ok("A real full analysis of the fake site reports two intent conflicts, two unapproved markets and two unconfirmed service pages");

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
  const openGroup = (id) => page.locator(`details#${id}`).evaluate((d) => { d.open = true; });
  const dialog = (action) => page.locator(`[data-decision-dialog="${action}"]`);
  const runMessage = () => page.locator("[data-run-message]");
  const waitRunMessage = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-run-message]")?.textContent ?? ""), re.source, { timeout: 20000 })
    .catch(async (e) => { throw new Error(`${e.message}\n  run message: ${JSON.stringify(await runMessage().innerText().catch(() => null))}`); });
  const gone = (key) => page.waitForFunction((k) => !document.querySelector(`article[data-key="${k}"]`), key, { timeout: 20000 });
  const openAll = async () => { for (const id of ["decide-services", "decide-markets", "decide-intents"]) if (await page.locator(`details#${id}`).count()) await openGroup(id); };

  // 1. The decision cards.
  await page.goto(url, { waitUntil: "networkidle" });
  await openAll();
  assert.deepEqual(await card(INTENT_BUYER).locator("[data-decision]").evaluateAll((els) => els.map((e) => e.dataset.decision)),
    ["keep_intent", "set_intent:commercial", "set_intent:transactional", "create_task"]);
  assert.deepEqual(await card(INTENT_BRAND).locator("[data-decision]").evaluateAll((els) => els.map((e) => e.dataset.decision)), ["keep_intent", "set_intent:navigational", "create_task"]);
  assert.deepEqual(await card(MARKET).locator("[data-decision]").evaluateAll((els) => els.map((e) => e.dataset.decision)), ["approve_market", "decline_market", "later", "create_task"]);
  assert.deepEqual(await card(SERVICE).locator("[data-decision]").evaluateAll((els) => els.map((e) => e.dataset.decision)), ["confirm_service", "not_offered", "create_task"]);
  await shot("authority-decisions-cards-desktop");
  ok("Decision cards: intent (keep / change to each recommended intent), market (approve / decline / later + select), service (confirm / not offered), each with Create task");

  // 2. Keep current intent: preview, bound suppression, no client-data write, no refresh.
  const runsBefore = refreshRuns();
  await card(INTENT_BRAND).locator('[data-decision="keep_intent"]').click();
  await dialog("keep_intent").locator("[data-preview]").waitFor();
  assert.match(await dialog("keep_intent").innerText(), /keywords\.intent[\s\S]*commercial[\s\S]*commercial \(unchanged\)[\s\S]*reads the query as navigational/);
  await shot("authority-decisions-keep-intent-dialog-desktop", page, false);
  await dialog("keep_intent").locator("[data-confirm-decision]").click();
  await card(INTENT_BRAND).locator('[data-status="dismissed"]').waitFor({ state: "attached" });
  assert.deepEqual(opp(INTENT_BRAND).suppression_basis, { keyword_id: KW_BRAND, stored: "commercial", assessed: "navigational" });
  assert.equal(sql(`select intent from keywords where id = '${KW_BRAND}'`), "commercial");
  assert.equal(refreshRuns(), runsBefore, "no refresh after an Authority-only decision");
  await page.locator("#dismissed").evaluate((d) => { d.open = true; });
  assert.equal(await card(INTENT_BRAND).locator("[data-status]").innerText(), "Intent kept: commercial");
  ok("Keep current intent: previewed (unchanged), suppressed bound to {commercial, navigational}, keyword untouched, no refresh; the Dismissed group labels it 'Intent kept: commercial'");

  // 3. Changed since the preview, then a clean change + refresh + resolution.
  await card(INTENT_BUYER).locator('[data-decision="set_intent:transactional"]').click();
  const setDlg = dialog("set_intent");
  await setDlg.locator("[data-preview]").waitFor();
  assert.equal(await setDlg.locator("[data-before]").innerText(), "informational");
  assert.equal(await setDlg.locator("[data-after]").innerText(), "transactional");
  sql(`update keywords set intent = 'commercial' where id = '${KW_BUYER}'`); // someone else, after the preview
  await setDlg.locator("[data-confirm-decision]").click();
  await setDlg.locator("[data-apply-error]").waitFor();
  assert.match(await setDlg.locator("[data-apply-error]").innerText(), /Changed since the preview: the keyword's intent is now commercial.*Nothing was saved/);
  assert.equal(sql(`select intent from keywords where id = '${KW_BUYER}'`), "commercial", "the other change stands; ours was not written");
  assert.equal(Number(sql(`select count(*) from authority_opportunity_events where opportunity_id = '${opp(INTENT_BUYER).id}' and kind = 'decision'`)), 0);
  await shot("authority-decisions-changed-desktop", page, false);
  sql(`update keywords set intent = 'informational' where id = '${KW_BUYER}'`);
  await setDlg.locator("[data-review-again]").click();
  await setDlg.locator("[data-confirm-decision]").waitFor();
  await setDlg.locator("[data-confirm-decision]").click();
  await waitRunMessage(/Intent changed to transactional\. Refreshing the analysis with the change\./);
  assert.equal(sql(`select intent from keywords where id = '${KW_BUYER}'`), "transactional");
  assert.equal(refreshRuns(), runsBefore + 1, "one refresh, started by the decision");
  await settle();
  await waitRunMessage(/Refresh complete/);
  await gone(INTENT_BUYER);
  assert.equal(opp(INTENT_BUYER).present, false, "the refresh resolved the conflict");
  ok("Change intent: a change after the preview is refused (AU409, nothing written), Review again, then keywords.intent → transactional, one refresh through the shared watcher, and the conflict resolves");

  // 4. Markets: explicit selection, batch preview, one refresh; decline is Authority-only.
  await openAll();
  assert.equal(await page.locator("[data-selected-count]").innerText(), "0 selected");
  assert.ok(await page.locator('[data-batch="approve_market"]').isDisabled(), "nothing is selected by default");
  await page.locator(`[data-select-market="${opp(MARKET).id}"]`).check();
  assert.equal(await page.locator("[data-selected-count]").innerText(), "1 selected");
  await page.locator('[data-batch="approve_market"]').click();
  const batch = dialog("batch:approve_market");
  await batch.locator(`[data-batch-row="${opp(MARKET).id}"]`).waitFor();
  await page.waitForFunction(() => /O'Fallon, MO · approved · 38\.8106, -90\.6998/.test(document.querySelector("[data-batch-preview]")?.textContent ?? ""));
  await shot("authority-decisions-markets-dialog-desktop", page, false);
  const before = refreshRuns();
  await batch.locator("[data-confirm-decision]").click();
  await batch.locator('[data-batch-result="ok"]').waitFor();
  assert.equal(sql(`select count(*) from locations where client_id = '${C}' and city = 'O''Fallon' and state = 'MO' and is_active and lat = 38.8106 and lng = -90.6998`), "1");
  assert.equal(sql(`select count(*) from locations where client_id = '${C}' and city = 'Lake Saint Louis'`), "0", "only the selected market");
  await batch.locator("[data-slot=\"dialog-footer\"] button", { hasText: "Close" }).click();
  await waitRunMessage(/1 of 1 market approved/);
  assert.equal(refreshRuns(), before + 1);
  await settle();
  await waitRunMessage(/Refresh complete/);
  await gone(MARKET);
  ok("Approve market: nothing selected by default; the selected row previews O'Fallon, MO with its coordinates; one location written, one refresh, and the market decision resolves");

  await openAll();
  await card(MARKET2).locator('[data-decision="decline_market"]').click();
  const dec = dialog("decline_market");
  await dec.locator("[data-note]").waitFor();
  assert.match(await dec.locator("[data-note]").innerText(), /Authority decision only; no Client Intelligence record created\./);
  assert.ok(await dec.locator("[data-confirm-decision]").isDisabled(), "a reason is required");
  await dec.locator('[data-field="reason"]').fill("Across the river; not served");
  await dec.locator("[data-confirm-decision]").click();
  await card(MARKET2).locator("[data-decision-message]").waitFor({ state: "attached" }).catch(() => {});
  await page.waitForFunction((k) => document.querySelector(`#section-dismissed article[data-key="${k}"]`), MARKET2);
  assert.equal(sql(`select count(*) from locations where client_id = '${C}' and city = 'Lake Saint Louis'`), "0");
  assert.equal(sql(`select detail->>'note' from authority_opportunity_events where opportunity_id = '${opp(MARKET2).id}' and kind = 'decision'`), "Authority decision only; no Client Intelligence record created.");
  ok("Decline market: reason required, the dialog and the decision event say 'Authority decision only; no Client Intelligence record created.', no location written");

  // 5. Services.
  await openAll();
  await card(SERVICE).locator('[data-decision="confirm_service"]').click();
  const svc = dialog("confirm_service");
  await svc.locator('[data-field="name"]').waitFor();
  assert.equal(await svc.locator('[data-field="name"]').inputValue(), "Commercial Roofing");
  assert.match(await svc.locator("[data-after]").innerText(), /approved service · https:\/\/roof\.example\.test\/services\/commercial-roofing/);
  await svc.locator('[data-field="segment"]').selectOption("Roofing");
  await shot("authority-decisions-service-dialog-desktop", page, false);
  await svc.locator("[data-confirm-decision]").click();
  await waitRunMessage(/Commercial Roofing confirmed as a service\. Refreshing/);
  assert.equal(sql(`select count(*) from services where client_id = '${C}' and name = 'Commercial Roofing' and status = 'approved' and segment = 'Roofing' and page_url = '${SITE}/services/commercial-roofing'`), "1");
  await settle();
  await waitRunMessage(/Refresh complete/);
  await gone(SERVICE);
  await openAll();
  await card(SERVICE2).locator('[data-decision="not_offered"]').click();
  const no = dialog("not_offered");
  await no.locator('[data-field="reason"]').fill("They subcontract solar; not a service they sell");
  assert.match(await no.locator("[data-note]").innerText(), /Authority decision only; no Client Intelligence record created\./);
  await no.locator("[data-confirm-decision]").click();
  await page.waitForFunction((k) => document.querySelector(`#section-dismissed article[data-key="${k}"]`), SERVICE2);
  assert.equal(sql(`select count(*) from services where client_id = '${C}' and page_url like '%solar%'`), "0");
  ok("Services: Confirm service previews the page and the suggested name, writes one approved service, refreshes and resolves; Not offered writes no service and says so");

  // 6. Create task: task + link + event together; no refresh.
  const fixKey = "topic:storm_hail";
  assert.ok(opp(fixKey)?.present && opp(fixKey).status === "open", "a research topic still open");
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("details[data-group]").evaluateAll((els) => els.forEach((d) => { d.open = true; }));
  const runsNow = refreshRuns();
  await card(fixKey).locator('[data-decision="create_task"]').click();
  const task = dialog("create_task");
  await task.locator('[data-field="title"]').waitFor();
  await task.locator('[data-field="title"]').fill("Map the unmapped keywords");
  await task.locator('[data-field="assignee"]').selectOption({ label: "Sam Team" });
  await shot("authority-decisions-task-dialog-desktop", page, false);
  await task.locator("[data-confirm-decision]").click();
  await page.locator("details[data-group]").evaluateAll((els) => els.forEach((d) => { d.open = true; }));
  await card(fixKey).locator('[data-status="in_progress"]').waitFor();
  assert.equal(sql(`select count(*) from tasks t join authority_opportunity_links l on l.task_id = t.id
    where t.client_id = '${C}' and t.key = 'authority:${fixKey}' and t.owner = 'TOM' and t.assignee_id = '${SAM()}' and t.title = 'Map the unmapped keywords'`), "1");
  assert.equal(await card(fixKey).locator('[data-decision="create_task"]').count(), 0, "no second task while one is open");
  assert.equal(refreshRuns(), runsNow, "no refresh after creating a task");
  ok("Create task: one TOM task (assigned), linked, the card In progress, no second Create task, no refresh");

  // 7. A decision while an analysis is running: its refresh meets that run
  //    (409) and the shared watcher follows it; no second run.
  await page.goto(url, { waitUntil: "networkidle" });
  holdRuns();
  await page.locator('[data-run="refresh"]').click();
  await waitRunMessage(/Refresh started\./);
  const running = sql(`select id from authority_runs where client_id = '${C}' and status = 'running'`);
  const teamRefreshes = refreshRuns();
  await page.locator("#dismissed").evaluate((d) => { d.open = true; });
  await card(INTENT_BRAND).locator('[data-verb="reopen"]').click();
  await page.waitForFunction((k) => document.querySelector(`article[data-key="${k}"] [data-decision="set_intent:navigational"]`), INTENT_BRAND);
  await openAll();
  await card(INTENT_BRAND).locator('[data-decision="set_intent:navigational"]').click();
  await dialog("set_intent").locator("[data-confirm-decision]").click();
  await waitRunMessage(/Intent changed to navigational\. An analysis is already running and may predate this change/);
  assert.equal(sql(`select intent from keywords where id = '${KW_BRAND}'`), "navigational");
  assert.equal(refreshRuns(), teamRefreshes, "no second run: the decision's refresh met the running one");
  releaseHold();
  await settle();
  await waitRunMessage(/Refresh complete/);
  assert.equal(sql(`select status from authority_runs where id = '${running}'`), "completed");
  ok("A decision during a running analysis: saved, 'already running and may predate this change', no second run; the shared watcher follows the running one to completion");

  // 8. Mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 390px");
  await shot("authority-decisions-mobile");
  await page.locator("details[data-group]").evaluateAll((els) => els.forEach((d) => { d.open = true; }));
  await card("topic:maintenance").locator('[data-decision="create_task"]').click();
  await dialog("create_task").locator('[data-field="title"]').waitFor();
  assert.ok(await dialog("create_task").evaluate((d) => d.getBoundingClientRect().right <= window.innerWidth + 1));
  await shot("authority-decisions-dialog-mobile", page, false);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  ok("Mobile (390px): no horizontal scroll; the decision dialog fits the screen");

  // 9. Portal contact: authority_apply refused through the API.
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}`, "content-type": "application/json" };
  const r = await fetch(`${gatewayUrl}/rest/v1/rpc/authority_apply`, { method: "POST", headers: asPortal,
    body: JSON.stringify({ p_opportunity_id: opp(fixKey).id, p_action: "create_task", p_payload: { title: "x" }, p_expected: {} }) });
  assert.ok(r.status === 403 || r.status === 401, `portal apply refused (${r.status})`);
  assert.equal(sql(`select count(*) from tasks where client_id = '${C}' and key like 'authority:%'`), "1");
  ok("Portal contact: authority_apply refused through the API; nothing written");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);

  console.log(`Authority decisions browser checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
