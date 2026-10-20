// End-to-end check for Citations Phase 1. Run by `npm run test:citations-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, `next dev` with CITATIONS_ENABLED=true, and Chrome. SAMPLE DATA
// only (citations_ui_fixtures.sql + tests/fixtures/citations); nothing calls a
// provider. SCREENSHOTS=dir saves each page.
//
//   - Overview and client tab render; the mapped import refuses the login
//     column, rejects the unmapped location and invalid rows, adds the rest;
//     repeating it adds nothing.
//   - Provider complete stays unverified; a check sets verification; a
//     correction task is opened, then resolved with a dated check.
//   - A fulfillment request is approved by the admin and marked complete with
//     a credit; the listing's provider status follows, verification does not.
//   - Exports: the client-safe file has no hidden street; cells are safe.
//   - Another client's location is a 404; a portal contact gets nothing.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL_A = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL_A].map((u) => [u.id, u]));
const CLIENT_A = "00000000-0000-4000-b000-00000000000a";
const CLIENT_B = "00000000-0000-4000-b000-00000000000b";
const MAIN = "00000000-0000-4000-e000-0000000000a1";
const NORTH = "00000000-0000-4000-e000-0000000000a2";
const SUMMIT = "00000000-0000-4000-e000-0000000000b1";
const FIXTURE = new URL("./fixtures/citations/sample-generic-citations.csv", import.meta.url).pathname;

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
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL_ADMIN} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

const unexpected = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = upstream.headers.get(k); if (v) h[k] = v; }
    res.writeHead(upstream.status, h);
    return res.end(out);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

const port = Number(process.env.CITATIONS_UI_PORT ?? 3437);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1", CITATIONS_ENABLED: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-12000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-12000); });

async function contextFor(browser, user, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
const count = async (page, key) => Number(await page.locator(`[data-import-preview] [data-count=${key}], [data-import-done] [data-count=${key}]`).first().innerText());

async function mapImport(page) {
  await page.goto(`${base}/clients/${CLIENT_A}/citations/import`, { waitUntil: "networkidle" });
  await page.locator("input[type=file]").setInputFiles(FIXTURE);
  await page.locator("[data-credential-notice]").waitFor();
  await page.getByLabel("Location for Main office (sample)").selectOption(MAIN);
  await page.getByLabel("Location for North branch (sample)").selectOption(NORTH);
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.locator("[data-import-preview]").waitFor();
}

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const context = await contextFor(browser, TEAM);
  const team = await context.newPage();
  const errors = [];
  team.on("pageerror", (e) => errors.push(e.message));

  // ── Import ────────────────────────────────────────────────────────────
  await team.goto(`${base}/clients/${CLIENT_A}/citations`, { waitUntil: "networkidle" });
  assert.ok(await team.getByRole("link", { name: "Citations", exact: true }).first().isVisible(), "nav / tab while the flag is on");
  assert.equal(await team.locator("[data-location-card]").count(), 2);
  assert.ok(!(await team.locator("main").innerText()).includes("22 Hidden Way"), "location card shows the public form of a hidden address");
  await mapImport(team);
  const notice = await team.locator("[data-credential-notice]").innerText();
  assert.match(notice, /Login password/);
  assert.equal(await team.getByLabel("Column for Observed business name").locator("option", { hasText: "Login password" }).count(), 0, "login column not offered");
  assert.deepEqual([await count(team, "rows"), await count(team, "added"), await count(team, "rejected")], [10, 6, 4]);
  const previewText = await team.locator("[data-import-preview]").innerText();
  assert.match(previewText, /Location "Unknown annex \(sample\)" is not mapped/);
  assert.match(previewText, /verified by robot/);
  assert.match(previewText, /in the future/);
  assert.equal(sql(`select count(*) from citation_listings where client_id = '${CLIENT_A}'`), "0", "the preview wrote nothing");
  await shot(team, "import-preview");
  await team.getByRole("button", { name: /^Import 6 rows/ }).click();
  await team.locator("[data-import-done]").waitFor();
  assert.equal(await count(team, "added"), 6);
  assert.equal(sql(`select count(*) from citation_listings where client_id = '${CLIENT_A}'`), "6");
  assert.equal(sql(`select count(*) from citation_import_rows r join citation_imports i on i.id = r.import_id where i.client_id = '${CLIENT_A}'`), "10", "every row's outcome kept");
  assert.equal(sql(`select count(*) from citation_listings where client_id = '${CLIENT_A}' and verification_status <> 'unverified'`), "0", "nothing imported is verified");
  assert.ok(!sql(`select mapping::text from citation_imports where client_id = '${CLIENT_A}'`).includes("Login password"), "mapping keeps no credential header");
  ok("Import: login column refused, unmapped location and invalid rows rejected with reasons, 6 added, preview wrote nothing");

  await team.getByRole("button", { name: "Import another file" }).click();
  await mapImport(team);
  assert.deepEqual([await count(team, "added"), await count(team, "skipped"), await count(team, "rejected")], [0, 6, 4]);
  assert.ok(await team.getByRole("button", { name: /^Import/ }).isDisabled(), "nothing to import");
  assert.equal(sql(`select count(*) from citation_listings where client_id = '${CLIENT_A}'`), "6");
  ok("Repeat import: 0 added, 6 skipped, no duplicates");

  // ── Overview ──────────────────────────────────────────────────────────
  await team.goto(`${base}/citations`, { waitUntil: "networkidle" });
  assert.equal(await team.locator("[data-location-row]").count(), 3);
  assert.equal(await team.locator('[data-metric="Provider complete, not verified"]').innerText(), "4", "provider complete is counted apart");
  await shot(team, "overview");
  await team.getByRole("link", { name: "Action required" }).click();
  await team.waitForURL(/view=action/);
  assert.ok(await team.locator("[data-filtered-listings] li").count() >= 4);
  ok("Overview: every location, provider-complete-unverified counted apart, action filter");

  // ── Location workflow: check, task, resolution ────────────────────────
  const loc = `${base}/clients/${CLIENT_A}/citations/${MAIN}`;
  await team.goto(loc, { waitUntil: "networkidle" });
  assert.equal(await team.locator("[data-listing]").count(), 4);
  assert.equal(await team.locator("[data-duplicate]").count(), 2, "two Yellow Pages URLs are suspected duplicates");
  const yelp = team.locator('[data-listing="Yelp"]');
  assert.equal(await yelp.locator("[data-verification]").getAttribute("data-verification"), "unverified");
  assert.equal(await yelp.locator("[data-fulfillment]").getAttribute("data-fulfillment"), "provider_complete");
  const yp = team.locator("article", { hasText: "sample-roofing-1" });
  assert.equal(await yp.locator('[data-field="phone"]').getAttribute("data-compare"), "mismatch", "imported phone differs from the approved identity");
  await yp.getByText(/Checks & evidence/).click();
  await yp.getByRole("button", { name: "Record a check" }).click();
  await yp.getByLabel("Result").selectOption("discrepancy");
  await yp.getByLabel("Phone shown").fill("417-555-0199");
  await yp.getByLabel("Evidence", { exact: true }).fill("SAMPLE: listing shows 417-555-0199 (screenshot ref S-1)");
  await yp.getByRole("button", { name: "Save check" }).click();
  await yp.locator('[data-verification="discrepancy"]').waitFor();
  await yp.getByText("Open a task for this listing").click();
  await yp.getByRole("button", { name: "Open a task" }).click();
  await yp.getByLabel("Owner").selectOption({ label: "Jess Rivera" });
  await yp.getByLabel("Due").fill("2026-12-01");
  await yp.getByLabel("Reason").fill("SAMPLE: Yellow Pages phone is wrong; request the correction");
  await yp.getByRole("button", { name: "Open task" }).click();
  await team.locator('[data-task="open"]').waitFor();
  assert.match(await team.locator("[data-tasks]").innerText(), /Correct listing · Yellow Pages[^]*?Open · Jess Rivera · opened [0-9-]+ · due 2026-12-01/);
  await shot(team, "location-discrepancy-task");

  const again = yp.getByRole("button", { name: /^Record (another|a) check$/ });
  if (!(await again.isVisible())) await yp.getByText(/Checks & evidence/).click();
  await again.click();
  await yp.getByLabel("Phone shown").fill("(417) 555-0100");
  await yp.getByLabel("Evidence", { exact: true }).fill("SAMPLE: phone corrected on Yellow Pages (screenshot ref S-2)");
  await yp.getByRole("button", { name: "Save check" }).click();
  await yp.locator('[data-verification="verified_accurate"]').waitFor();
  const task = team.locator('[data-task="open"]');
  await task.getByText("Update task").click();
  await task.getByLabel("Status").selectOption("resolved");
  await task.getByLabel("Resolution").fill("SAMPLE: corrected by the owner; verified");
  const proving = await task.getByLabel("Check that proves it").locator("option").nth(1).getAttribute("value");
  await task.getByLabel("Check that proves it").selectOption(proving);
  await task.getByRole("button", { name: "Save task" }).click();
  await team.locator('[data-task="resolved"]').waitFor();
  assert.match(await team.locator('[data-task="resolved"] [data-resolution]').innerText(), /corrected by the owner/);
  assert.equal(sql(`select (resolved_on is not null and check_id is not null and resolved_by is not null)::text from citation_tasks where status = 'resolved'`), "true");
  await shot(team, "location-resolved");
  ok("Location: provider complete stays unverified; discrepancy check; task opened with owner and due date; resolved with a dated check");

  // ── Fulfillment request, approval, credits ────────────────────────────
  const north = `${base}/clients/${CLIENT_A}/citations/${NORTH}`;
  await team.goto(north, { waitUntil: "networkidle" });
  assert.ok(!(await team.locator("[data-listings]").innerText()).includes("22 Hidden Way"));
  const requests = team.locator("[data-requests]");
  await requests.getByRole("button", { name: "Record a fulfillment request" }).click();
  await requests.getByLabel("Directory").selectOption({ label: "Bing Places" });
  await requests.getByLabel("Existing listing").selectOption({ index: 1 });
  await requests.getByLabel("Provider").selectOption("brightlocal");
  await requests.getByLabel("Status").selectOption("pending_approval");
  await requests.getByLabel("Budget to approve").fill("3.20");
  await requests.getByRole("button", { name: "Save request" }).click();
  await team.locator('[data-request="pending_approval"]').waitFor();
  await team.reload({ waitUntil: "networkidle" });
  const req = team.locator('[data-request="pending_approval"]');
  await req.getByText("Update request").click();
  await req.getByLabel("Status").selectOption("approved");
  await req.getByRole("button", { name: "Save request" }).click();
  await team.locator('[data-request="approved"]').waitFor();
  const approved = team.locator('[data-request="approved"]');
  // The panel stays open across the re-render; open it only if it closed.
  if (!(await approved.getByLabel("Status").isVisible())) await approved.getByText("Update request").click();
  await approved.getByLabel("Status").selectOption("provider_complete");
  await approved.getByLabel("Provider reference").fill("SAMPLE-REF-1");
  await approved.getByLabel("Prepaid credits used").fill("1");
  await approved.getByRole("button", { name: "Save request" }).click();
  await team.locator('[data-request="provider_complete"]').waitFor();
  const bing = team.locator('[data-listing="Bing Places"]');
  assert.equal(await bing.locator("[data-fulfillment]").getAttribute("data-fulfillment"), "provider_complete");
  assert.equal(await bing.locator("[data-verification]").getAttribute("data-verification"), "unverified");
  await team.goto(`${base}/citations`, { waitUntil: "networkidle" });
  assert.equal(await team.locator('[data-credits-remaining="brightlocal"]').innerText(), "No balance recorded", "no negative balance before one is recorded");
  const credits = team.locator("[data-credit-balances]");
  await credits.getByRole("button", { name: "Record credits" }).click();
  await credits.getByLabel("Provider").selectOption("brightlocal");
  await credits.getByLabel("Credits").fill("10");
  await credits.getByLabel("Note").fill("SAMPLE opening balance");
  await credits.getByRole("button", { name: "Save entry" }).click();
  await team.locator('[data-credits-remaining="brightlocal"]', { hasText: /^9$/ }).waitFor();
  assert.match(await team.locator("[data-fulfillment-costs]").innerText(), /Prepaid credits used\s*1/);
  ok("Fulfillment: admin-approved request, provider complete mirrors to fulfillment only, credits apart from cash");

  // ── Exports ───────────────────────────────────────────────────────────
  sql(`update citation_listings set observed_name = '=HYPERLINK(\\"http://evil.example.test\\")' where listing_url like '%mapquest%'`);
  sql(`update citation_listings set observed_address = '22 Hidden Way, Ozark, MO' where listing_url like '%mapquest%'`);
  const clientCsv = await (await context.request.get(`${base}/clients/${CLIENT_A}/citations/export?variant=client`)).text();
  assert.ok(!clientCsv.includes("22 Hidden Way"), "client-safe export has no hidden street");
  assert.match(clientCsv, /Address shown publicly \(should be hidden\)/);
  assert.match(clientCsv, /"'=HYPERLINK/, "formula neutralized");
  assert.match(clientCsv, /Provider complete/);
  assert.equal(clientCsv.trim().split("\r\n").length, 7, "header + 6 listings");
  const internalCsv = await (await context.request.get(`${base}/clients/${CLIENT_A}/citations/export?variant=internal`)).text();
  assert.match(internalCsv, /22 Hidden Way.*HIDDEN — internal only/);
  const crossCsv = await (await context.request.get(`${base}/clients/${CLIENT_B}/citations/export?variant=internal&location=${MAIN}`)).text();
  assert.equal(crossCsv.trim().split("\r\n").length, 1, "another client's location exports nothing");
  ok("Exports: client-safe hides the street, internal marks it, formula cells neutralized, cross-client location empty");

  // ── Boundaries ────────────────────────────────────────────────────────
  const cross = await team.goto(`${base}/clients/${CLIENT_B}/citations/${MAIN}`, { waitUntil: "networkidle" });
  assert.equal(cross.status(), 404, "a location under the wrong client is a 404");
  assert.equal((await team.goto(`${base}/clients/${CLIENT_A}/citations/${SUMMIT}`, { waitUntil: "networkidle" })).status(), 404, "and the other way round");
  const portalContext = await contextFor(browser, PORTAL_A);
  const portal = await portalContext.newPage();
  await portal.goto(`${base}/clients/${CLIENT_A}/citations/${NORTH}`, { waitUntil: "networkidle" });
  assert.ok(!portal.url().includes("/citations"), "portal contact is sent away");
  assert.ok(!(await portal.content()).includes("22 Hidden Way"));
  const portalExport = await portalContext.request.get(`${base}/clients/${CLIENT_A}/citations/export?variant=internal`);
  assert.equal(portalExport.status(), 403);
  assert.equal(sql(`select count(*) from citation_listings where client_id = '${CLIENT_B}'`), "1", "client B untouched");
  ok("Boundaries: wrong-client location 404, portal contact redirected and refused the export");

  // ── Phone-sized location page ─────────────────────────────────────────
  const phone = await (await contextFor(browser, TEAM, { width: 390, height: 844 })).newPage();
  await phone.goto(loc, { waitUntil: "networkidle" });
  const overflow = await phone.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll on a phone (${overflow}px)`);
  await shot(phone, "location-mobile");
  await team.goto(`${base}/clients/${CLIENT_A}/citations`, { waitUntil: "networkidle" });
  await shot(team, "client-tab");
  ok("Phone width: location page without horizontal scroll");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`citations UI: ${checks.length} checks passed`);
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  await browser?.close();
  app.kill();
  gateway.close();
}
process.exit(0);
