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
//   - Follow-up (pilot audit): checks are recorded field by field (a name-only
//     review is "partially verified"); the teammate's verdict is shown apart
//     from the automated text comparison, which calls equivalent formatting
//     equivalent; a URL-less listing gains its URL through "Add URL / id"
//     without losing anything, and reimporting the original or the enriched
//     file adds nothing.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { parseCsv } from "../src/lib/citations.ts";
import { agencyToday } from "../src/lib/reporting.ts";

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
const TODAY = agencyToday();
// A CSV export as objects keyed by header.
const table = (csv) => { const [head, ...rows] = parseCsv(csv); return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))); };
const exportOf = async (context, client, query) => (await context.request.get(`${base}/clients/${client}/citations/export?${query}`)).text();
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
const count = async (page, key) => Number(await page.locator(`[data-import-preview] [data-count=${key}], [data-import-done] [data-count=${key}]`).first().innerText());

// Fills the field-by-field check form: { name: ["verified", "Sample Roofing"], phone: ["discrepancy", "417-…"] }; unnamed fields stay "not checked".
async function fillFields(scope, fields) {
  for (const [f, [status, value]] of Object.entries(fields)) {
    const label = f[0].toUpperCase() + f.slice(1);
    await scope.getByLabel(`${label} check`).selectOption(status);
    if (value) await scope.getByLabel(`${label} shown`).fill(value);
  }
}
const ALL_MAIN = (phone, address = "100 North Main Street, Springfield, MO 65806") => ({
  name: ["verified", "Sample Roofing LLC"], address: ["verified", address], phone: ["verified", phone], website: ["verified", "https://sample-roofing.example.test"] });

async function mapImport(page, file = FIXTURE) {
  await page.goto(`${base}/clients/${CLIENT_A}/citations/import`, { waitUntil: "networkidle" });
  await page.locator("input[type=file]").setInputFiles(file);
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
  assert.equal(sql(`select count(*) from citation_listing_overview where client_id = '${CLIENT_A}' and verification_status <> 'unverified'`), "0", "nothing imported is verified");
  assert.ok(!sql(`select mapping::text from citation_imports where client_id = '${CLIENT_A}'`).includes("Login password"), "mapping keeps no credential header");
  ok("Import: login column refused, unmapped location and invalid rows rejected with reasons, 6 added, preview wrote nothing");

  await team.getByRole("button", { name: "Import another file" }).click();
  await mapImport(team);
  assert.deepEqual([await count(team, "added"), await count(team, "skipped"), await count(team, "rejected")], [0, 6, 4]);
  assert.ok(await team.getByRole("button", { name: "Nothing to import" }).isDisabled(), "nothing to import");
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
  await fillFields(yp, { phone: ["discrepancy", "417-555-0199"] });
  assert.match(await yp.locator("[data-derived-verdict]").innerText(), /Discrepancy/);
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
  await fillFields(yp, ALL_MAIN("(417) 555-0100"));
  assert.match(await yp.locator("[data-derived-verdict]").innerText(), /Verified accurate/);
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

  // ── One current-evidence projection: import wrong phone → corrected check ─
  // Imported 417-555-0199 on 2026-10-02; checked today as (417) 555-0100. The
  // page and the CSV agree on current values and date; the import is kept apart.
  assert.equal(await yp.locator("[data-current-evidence]").getAttribute("data-current-evidence"), "check");
  assert.equal(await yp.locator('[data-current="phone"]').innerText(), "(417) 555-0100");
  assert.match(await yp.locator("[data-source-observation]").innerText(), /observed 2026-10-02.*417-555-0199/);
  const ypRow = () => exportOf(context, CLIENT_A, `variant=internal&location=${MAIN}`).then((csv) => table(csv).find((r) => r["Listing URL"].includes("sample-roofing-1")));
  let row = await ypRow();
  assert.deepEqual([row["Verification"], row["Current phone"], row["Last checked"], row["Evidence"], row["Source phone"], row["Source observed"]],
    ["Verified accurate", "(417) 555-0100", TODAY, "Current evidence", "417-555-0199", "2026-10-02"]);
  ok("Current evidence: detail and CSV agree on the checked phone and date; the imported phone and its date are kept as the source");

  // ── Identity change → needs reverification → a current check restores it ─
  await team.getByText("Edit approved identity").click();
  const identity = team.locator("[data-identity]");
  await identity.getByLabel("Internal notes").fill("SAMPLE: office hours confirmed");
  await identity.getByRole("button", { name: "Save identity" }).click();
  // The form remounts on the saved row (its updated_at key), so wait for the row itself.
  for (let i = 0; i < 75 && sql(`select notes from citation_locations where id = '${MAIN}'`) !== "SAMPLE: office hours confirmed"; i++) await new Promise((r) => setTimeout(r, 200));
  await team.reload({ waitUntil: "networkidle" });
  assert.equal(await team.locator("[data-identity-version]").getAttribute("data-identity-version"), "1", "a notes-only edit is not an identity change");
  assert.equal(await yp.locator("[data-verification]").getAttribute("data-verification"), "verified_accurate");
  if (!(await identity.getByLabel("Approved phone").isVisible())) await team.getByText("Edit approved identity").click();
  await identity.getByLabel("Approved phone").fill("(417) 555-0123");
  await identity.getByRole("button", { name: "Save identity" }).click();
  await identity.getByText("Say why the approved identity changed.").waitFor();
  await identity.getByLabel(/Why the identity changed/).fill("SAMPLE: client moved to a new main line");
  await identity.getByRole("button", { name: "Save identity" }).click();
  await team.locator('[data-identity-version="2"]').waitFor();
  await yp.locator('[data-verification="needs_reverification"]').waitFor();
  assert.match(await yp.locator("[data-reverify]").innerText(), /now v2; the latest check \(\d{4}-\d{2}-\d{2}\) was made against v1/);
  assert.equal(await yp.locator("[data-freshness]").getAttribute("data-freshness"), "superseded");
  row = await ypRow();
  assert.deepEqual([row["Verification"], row["Evidence"], row["Checked against identity"], row["Current identity"]], ["Needs reverification", "Identity changed since check", "1", "2"]);
  assert.equal(sql(`select count(*) from citation_checks c join citation_listings l on l.id = c.listing_id where l.listing_url like '%sample-roofing-1'`), "2", "history kept");
  await shot(team, "location-needs-reverification");
  await team.goto(`${base}/citations`, { waitUntil: "networkidle" });
  assert.equal(await team.locator('[data-metric="Needs reverification"]').innerText(), "1");
  assert.equal(await team.locator('[data-metric="Verified accurate"]').innerText(), "0");
  await team.goto(loc, { waitUntil: "networkidle" });
  await yp.getByText(/Checks & evidence/).click();
  await yp.getByRole("button", { name: "Record a check" }).click();
  await fillFields(yp, ALL_MAIN("(417) 555-0123"));
  await yp.getByLabel("Evidence", { exact: true }).fill("SAMPLE: new main line shown on Yellow Pages (screenshot ref S-3)");
  await yp.getByRole("button", { name: "Save check" }).click();
  await yp.locator('[data-verification="verified_accurate"]').waitFor();
  row = await ypRow();
  assert.deepEqual([row["Verification"], row["Current phone"], row["Checked against identity"], row["Current identity"]], ["Verified accurate", "(417) 555-0123", "2", "2"]);
  ok("Identity change: notes-only edit keeps verification; a phone change needs a reason, marks the check for reverification on page, overview and CSV; a new check restores it");

  // ── Follow-up: a partial check, and the verdict apart from the text comparison ─
  await team.goto(loc, { waitUntil: "networkidle" });
  const fb = team.locator('[data-listing="Facebook"]');
  await fb.getByText(/Checks & evidence/).click();
  await fb.getByRole("button", { name: "Record a check" }).click();
  await fillFields(fb, { name: ["verified", "Sample Roofing"] });
  assert.match(await fb.locator("[data-derived-verdict]").innerText(), /Partially verified/, "a name-only review is never verified accurate");
  assert.ok(await fb.getByLabel("Address shown").isDisabled(), "no value can be kept for a field that was not seen");
  await fb.getByLabel("Evidence", { exact: true }).fill("SAMPLE: only the page title was visible (screenshot ref S-4)");
  await fb.getByRole("button", { name: "Save check" }).click();
  await fb.locator('[data-verification="partially_verified"]').waitFor();
  assert.deepEqual(await fb.locator("[data-field-check]").evaluateAll((els) => els.map((e) => `${e.dataset.fieldCheck}:${e.dataset.status}`)),
    ["name:verified", "address:not_checked", "phone:not_checked", "website:not_checked"]);
  const yelpMain = team.locator('[data-listing="Yelp"]');
  await yelpMain.getByText(/Checks & evidence/).click();
  await yelpMain.getByRole("button", { name: "Record a check" }).click();
  await fillFields(yelpMain, ALL_MAIN("(417) 555-0123", "100 North Main Street, Springfield, Missouri 65806, United States"));
  await yelpMain.getByLabel("Evidence", { exact: true }).fill("SAMPLE: Yelp shows the address with the state written out (screenshot ref S-5)");
  await yelpMain.getByRole("button", { name: "Save check" }).click();
  await yelpMain.locator('[data-verification="verified_accurate"]').waitFor();
  assert.equal(await yelpMain.locator('[data-field="address"]').getAttribute("data-compare"), "equivalent", "equivalent formatting is not 'differs'");
  assert.match(await yelpMain.locator("[data-address-notes]").innerText(), /state written out; country shown/);
  assert.equal(await yelpMain.locator('[data-current="address"]').innerText(), "100 North Main Street, Springfield, Missouri 65806, United States", "raw observation kept");
  assert.match(await yelpMain.locator("[data-manual-verdict]").innerText(), /Teammate verdict \(\d{4}-\d{2}-\d{2}, identity v2\)/);
  await shot(team, "location-verdict-vs-comparison");
  if (shots) { await team.evaluate(() => window.scrollTo(0, 0)); await yelpMain.screenshot({ path: `${shots}/listing-verdict-vs-comparison.png` }); }
  let rows = table(await exportOf(context, CLIENT_A, `variant=client&location=${MAIN}`));
  const fbRow = rows.find((r) => r["Directory"] === "Facebook"), yelpRow = rows.find((r) => r["Directory"] === "Yelp");
  assert.deepEqual([fbRow["Verification"], fbRow["Field coverage"], fbRow["Address check"]], ["Partially verified", "Verified: name · Not checked: address, phone, website", "Not checked"]);
  assert.deepEqual([yelpRow["Verification"], yelpRow["Address check"], yelpRow["Address text comparison (automated, not a verdict)"]],
    ["Verified accurate", "Verified (matches)", "Equivalent formatting (state written out; country shown)"]);
  await team.goto(`${base}/citations`, { waitUntil: "networkidle" });
  assert.equal(await team.locator('[data-metric="Partially verified"]').innerText(), "1");
  assert.equal(await team.locator('[data-field-verified="name"]').innerText(), "3", "name verified on Yellow Pages, Yelp and the name-only Facebook check");
  assert.equal(await team.locator('[data-field-verified="phone"]').innerText(), "2", "the name-only check does not count for the phone");
  assert.match(await team.locator("[data-coverage-scope]").innerText(), /only the business locations already added/);
  await shot(team, "overview-field-coverage");
  ok("Field-level checks: name-only is partially verified (page, overview, CSV); the dated verdict is shown apart from the automated comparison, which calls a written-out state equivalent and keeps the raw text");

  // ── Follow-up: add a URL to an existing URL-less listing, then reimport ─
  const north = `${base}/clients/${CLIENT_A}/citations/${NORTH}`;
  await team.goto(north, { waitUntil: "networkidle" });
  const bingId = sql(`select id from citation_listings where location_id = '${NORTH}' and listing_url is null`);
  const bingBefore = sql(`select concat_ws('|', id, source_provider, last_import_id, fulfillment_status, source_phone, created_at) from citation_listings where id = '${bingId}'`);
  const bingCard = team.locator('[data-listing="Bing Places"]');
  await bingCard.getByText("Add URL / external id").click();
  await bingCard.getByRole("button", { name: "Add URL / id" }).click();
  await bingCard.getByLabel("Public listing URL").fill("https://www.bing.com/maps/verify?token=abcdefghijklmnopqrstu");
  await bingCard.getByLabel("Where you found it").fill("SAMPLE: Bing Maps search during the audit");
  await bingCard.getByRole("button", { name: "Save URL / id" }).click();
  await bingCard.getByText(/private account \/ verification link/).waitFor();
  await bingCard.getByLabel("Public listing URL").fill("https://www.bing.com/maps?q=Sample+Roofing+North+Ozark");
  await bingCard.getByLabel("External listing id").fill("YN0000SAMPLE0001");
  await shot(team, "enrich-form");
  await bingCard.getByRole("button", { name: "Save URL / id" }).click();
  await team.locator('[data-listing="Bing Places"] [data-enrichments]').waitFor();
  const enriched = team.locator('[data-listing="Bing Places"]');
  assert.match(await enriched.locator("[data-enrichments]").innerText(), /Sam Team added the URL and id YN0000SAMPLE0001 \(was recorded without a URL or id\) · SAMPLE: Bing Maps search/);
  assert.equal(await enriched.getAttribute("data-listing-url"), "https://www.bing.com/maps?q=Sample+Roofing+North+Ozark");
  assert.equal(sql(`select concat_ws('|', id, source_provider, last_import_id, fulfillment_status, source_phone, created_at) from citation_listings where id = '${bingId}'`), bingBefore,
    "same listing id, import provenance and provider status");
  assert.equal(sql(`select concat_ws('|', before_key, after_key, (recorded_by is not null)::text) from citation_listing_enrichments where listing_id = '${bingId}'`),
    "none|url:bing.com/maps?q=Sample+Roofing+North+Ozark|true");
  await shot(team, "enrich-done");
  // The original file (Bing without a URL) and an enriched copy (with it) both land on the same listing.
  await mapImport(team);
  assert.deepEqual([await count(team, "added"), await count(team, "skipped"), await count(team, "rejected")], [0, 6, 4], "original file after enrichment");
  const dir = mkdtempSync(join(tmpdir(), "citations-ui-"));
  const enrichedCsv = join(dir, "enriched-sample.csv");
  writeFileSync(enrichedCsv, readFileSync(FIXTURE, "utf8").replace("North branch (sample),Bing Places,,", "North branch (sample),Bing Places,https://www.bing.com/maps?q=Sample+Roofing+North+Ozark,"));
  await mapImport(team, enrichedCsv);
  assert.deepEqual([await count(team, "added"), await count(team, "skipped"), await count(team, "rejected")], [0, 6, 4], "enriched file");
  assert.equal(sql(`select count(*) from citation_listings where client_id = '${CLIENT_A}'`), "6", "no duplicate listing");
  ok("Enrichment: tokenized URL refused; URL and id added to the URL-less Bing listing with before / after, actor and reason; id, provenance and provider status kept; original and enriched reimports add nothing");

  // ── Fulfillment request, approval, credits ────────────────────────────
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
  sql(`update citation_listings set source_name = '=HYPERLINK(\\"http://evil.example.test\\")' where listing_url like '%mapquest%'`);
  sql(`update citation_listings set source_address = '22 Hidden Way, Ozark, MO' where listing_url like '%mapquest%'`);
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

  // ── Capacity: 1,200 more listings behind a 1,000-row API cap ──────────
  // PostgREST runs with db-max-rows = 1000 (npm run test:citations-ui). One
  // quiet listing's only check is 61 days old; a busy one has 3,500 newer
  // checks. Totals, export and each listing's latest evidence stay complete.
  sql(`alter table citation_location_identities disable trigger citation_identities_append_only;
    update citation_location_identities set recorded_at = now() - interval '120 days' where location_id = '${SUMMIT}';
    alter table citation_location_identities enable trigger citation_identities_append_only;
    insert into citation_listings (client_id, location_id, directory_id, listing_url, source_provider)
      select '${CLIENT_B}', '${SUMMIT}', (select id from citation_directories where key = 'manta'), 'https://bulk.example.test/l/' || lpad(g::text, 4, '0'), 'sample_csv'
      from generate_series(1, 1200) g;
    insert into citation_checks (listing_id, checked_on, method, result, observed_name, observed_address, observed_phone, evidence,
        name_status, address_status, phone_status, website_status)
      select id, (now() at time zone 'America/Chicago')::date - 61, 'visited_url', 'accurate', 'Summit Electric', '9 Elm Street, Columbia, MO', '(573) 555-0110', 'SAMPLE quiet listing',
        'verified', 'verified', 'verified', 'not_displayed'
      from citation_listings where listing_url = 'https://bulk.example.test/l/0001';
    insert into citation_checks (listing_id, checked_on, method, result, evidence)
      select (select id from citation_listings where listing_url = 'https://bulk.example.test/l/0002'), (now() at time zone 'America/Chicago')::date - (g % 60),
        'publisher_search', 'not_found', 'SAMPLE busy listing ' || g from generate_series(1, 3500) g;`);
  assert.equal(sql(`select count(*) from citation_listings where location_id = '${SUMMIT}'`), "1201");
  const unpaged = await (await fetch(`${gatewayUrl}/rest/v1/citation_listing_overview?select=id`, { headers: { authorization: `Bearer ${tokenFor(TEAM)}` } })).json();
  assert.equal(unpaged.length, 1000, "the API cap is in force: a single unpaged read stops at 1,000 of 1,207");
  await team.goto(`${base}/citations`, { waitUntil: "networkidle" });
  assert.equal(await team.locator('[data-location-row="Summit office (sample)"] td').nth(1).innerText(), "1201", "overview counts past the cap");
  assert.equal(await team.locator('[data-location-row="Summit office (sample)"] td').nth(2).innerText(), "1", "the quiet listing's old check still counts");
  assert.equal(await team.locator('[data-metric="Listings"]').innerText(), "1207");
  const bulk = table(await exportOf(context, CLIENT_B, "variant=internal"));
  assert.equal(bulk.length, 1201, "export carries every listing");
  assert.equal(new Set(bulk.map((r) => r["Listing URL"])).size, 1201);
  assert.deepEqual([bulk.find((r) => r["Listing URL"].endsWith("/l/0001"))["Verification"], bulk.find((r) => r["Listing URL"].endsWith("/l/0002"))["Last checked"]], ["Verified accurate", TODAY]);
  const summit = `${base}/clients/${CLIENT_B}/citations/${SUMMIT}`;
  await team.goto(summit, { waitUntil: "networkidle" });
  assert.match(await team.locator("[data-listing-range]").innerText(), /Showing 1–100 of 1201/);
  const quiet = team.locator('[data-listing-url="https://bulk.example.test/l/0001"]');
  assert.equal(await quiet.locator("[data-verification]").getAttribute("data-verification"), "verified_accurate", "a busy listing never displaces another's latest check");
  assert.equal(await quiet.locator("[data-freshness]").getAttribute("data-freshness"), "current");
  const busy = team.locator('[data-listing-url="https://bulk.example.test/l/0002"]');
  assert.match(await busy.getByText(/Checks & evidence/).innerText(), /\(3500\)/, "the busy listing's full history is read past the cap");
  await team.goto(`${summit}?page=13`, { waitUntil: "networkidle" });
  assert.match(await team.locator("[data-listing-range]").innerText(), /Showing 1201–1201 of 1201/);
  assert.equal(await team.locator('[data-listing="Yelp"]').count(), 1, "the last page holds the last listing");
  ok("Capacity: 1,200 listings through a 1,000-row API cap — complete totals, export and pages; a busy listing cannot displace another's latest check");

  // ── Follow-up: a URL already on another location's listing needs review ─
  sql(`insert into citation_listings (client_id, location_id, directory_id, source_provider) values ('${CLIENT_A}', '${NORTH}', (select id from citation_directories where key = 'yelp'), 'manual_entry')`);
  await team.goto(north, { waitUntil: "networkidle" });
  const northYelp = team.locator('[data-listing="Yelp"]');
  await northYelp.getByText("Add URL / external id").click();
  await northYelp.getByRole("button", { name: "Add URL / id" }).click();
  await northYelp.getByLabel("Public listing URL").fill("https://www.yelp.com/biz/sample-roofing-springfield/");
  await northYelp.getByLabel("Where you found it").fill("SAMPLE: the branch shares the main office's Yelp page?");
  await northYelp.getByRole("button", { name: "Save URL / id" }).click();
  await northYelp.locator("[data-enrich-matches]").waitFor();
  assert.match(await northYelp.locator("[data-enrich-matches]").innerText(), /Sample Roofing \(sample\) · Main office \(sample\) · Yelp · https:\/\/www\.yelp\.com\/biz\/sample-roofing-springfield/);
  assert.equal(sql(`select count(*) from citation_listing_enrichments where listing_id in (select id from citation_listings where location_id = '${NORTH}' and listing_url is null)`), "0", "nothing saved before review");
  await shot(team, "enrich-duplicate-warning");
  await northYelp.locator("[data-enrich-matches] input[type=checkbox]").check();
  await northYelp.getByRole("button", { name: "Save URL / id" }).click();
  await team.locator('[data-listing="Yelp"] [data-enrichments]').waitFor();
  assert.match(sql(`select array_length(acknowledged_listing_ids, 1)::text || ' ' || after_key from citation_listing_enrichments order by recorded_at desc limit 1`), /^1 url:yelp\.com\/biz\/sample-roofing-springfield$/);
  ok("Enrichment: a URL already on another location's listing is shown and saved only after review, with the reviewed listing recorded");

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
