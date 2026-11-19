// Browser smoke test for New Client Onboarding v1.0. Run by
// `npm run test:onboarding-ui` (scripts/test-tasks-ui.sh with UI_SPEC set): a
// throwaway Postgres replay of every migration behind PostgREST, `next dev`,
// and Chrome. RLS, the guards and the server actions run for real; nothing
// touches the Supabase project. SAMPLE DATA only (onboarding_ui_fixtures.sql).
// SCREENSHOTS=dir saves each page.
//
//   - Client Onboarding tab: sections, exact vs client-wide signals.
//   - Edit / sign-off: verified is signed and shown; a prerequisite that is not
//     done refuses verified with the guard's message.
//   - Citation Tracker link opens the client's Citations tab.
//   - Start / re-run on an existing client; its scope gaps keep it incomplete.
//   - Control Center › Client onboarding shows the check per client.
//   - New client creation enrolls the client (and its site) on its own.
//   - Map-tracking exclusion is visible; phone width has no horizontal scroll.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const users = new Map([[TEAM.id, TEAM]]);
const U = "0c000000-0000-4000-b000-00000000000a";
const V = "0c000000-0000-4000-b000-00000000000b";
const W = "0c000000-0000-4000-b000-00000000000c";

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

const port = Number(process.env.ONBOARDING_UI_PORT ?? 3447);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1", CITATIONS_ENABLED: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-12000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-12000); });

async function contextFor(browser, user, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
const item = (page, key) => page.locator(`[data-onboarding-item="${key}"]`).first();
async function save(page, key, status, note) {
  const li = item(page, key);
  if (!(await li.locator("details").evaluate((d) => d.open))) await li.locator("summary").click();
  const form = li.locator(`[data-onboarding-form="${key}"]`);
  await form.locator("select[name=status]").selectOption(status);
  await form.locator("textarea[name=evidence_note]").fill(note);
  await form.getByRole("button", { name: "Save" }).click();
  await form.locator("[role=alert], [role=status]").first().waitFor();
  return form;
}

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const context = await contextFor(browser, TEAM);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ── Onboarding tab ────────────────────────────────────────────────────
  await page.goto(`${base}/clients/${U}/onboarding`, { waitUntil: "networkidle" });
  assert.ok(await page.getByRole("link", { name: "Onboarding", exact: true }).first().isVisible(), "client tab");
  assert.equal(await page.locator("[data-onboarding-section]").count(), 5);
  const total = Number(sql(`select count(*) from client_onboarding_items i join onboarding_items o on o.key = i.item_key where i.client_id = '${U}' and i.required`));
  assert.equal(await page.locator("[data-onboarding-done]").innerText(), `0 / ${total}`);
  assert.equal(await page.locator('[data-onboarding-item="citation_yelp"][data-scope-label="Main office (sample)"]').count(), 1, "location row from the later location");
  assert.equal(await page.locator('[data-onboarding-item="gsc_verified"][data-scope-label="https://ui-sample.example.test"]').count(), 1, "site row from the later site");
  await item(page, "zernio_gbp").locator("summary").click();
  assert.equal(await item(page, "zernio_gbp").locator("[data-onboarding-signal]").getAttribute("data-onboarding-signal"), "client-wide");
  assert.match(await item(page, "zernio_gbp").locator("[data-onboarding-signal]").innerText(), /not evidence for this location/);
  await item(page, "gsc_verified").locator("summary").click();
  assert.match(await item(page, "gsc_verified").locator("[data-onboarding-signal]").innerText(), /No Search Console import for ui-sample\.example\.test yet/);
  await shot(page, "onboarding-tab");
  ok("Onboarding tab: five sections, site and location rows, exact vs client-wide signals labelled");

  // ── Edit / sign-off ───────────────────────────────────────────────────
  let form = await save(page, "identity_business", "verified", "Agreement names Onboarding UI Sample U LLC (sample)");
  assert.equal(await form.locator("[role=status]").innerText(), "Saved.");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await item(page, "identity_business").getAttribute("data-status"), "verified");
  assert.match(await item(page, "identity_business").locator("summary").innerText(), /verified \d{4}-\d{2}-\d{2}/);
  assert.equal(sql(`select verified_by from client_onboarding_items where client_id = '${U}' and item_key = 'identity_business'`), TEAM.id);
  assert.equal(await page.locator("[data-onboarding-done]").innerText(), `1 / ${total}`);
  form = await save(page, "citation_yelp", "verified", "Looks fine (sample)");
  assert.match(await form.locator("[role=alert]").innerText(), /Prerequisite not done: "Location identity approved/);
  assert.equal(sql(`select status from client_onboarding_items where client_id = '${U}' and item_key = 'citation_yelp'`), "not_started");
  ok("Sign-off: verified is attributed to the signed-in teammate; an unmet prerequisite refuses verified");

  // ── Citation Tracker link ────────────────────────────────────────────
  await page.locator("[data-citations-link]").click();
  await page.waitForURL(`${base}/clients/${U}/citations`);
  await page.locator("[data-client-citations]").waitFor();
  assert.equal(await page.locator("[data-location-card]").count(), 1);
  ok("Citation Tracker link opens the client's Citations tab");

  // ── Start / re-run on an existing client; scope gaps ─────────────────
  await page.goto(`${base}/clients/${V}/onboarding`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-onboarding-item]").count(), 0);
  await page.getByRole("button", { name: "Start the checklist" }).click();
  await page.locator("[data-onboarding-enroll] [role=status]").waitFor();
  assert.match(await page.locator("[data-onboarding-enroll] [role=status]").innerText(), /^\d+ items added\.$/);
  await page.reload({ waitUntil: "networkidle" });
  const vRows = await page.locator("[data-onboarding-item]").count();
  assert.ok(vRows > 0);
  assert.deepEqual(await page.locator("[data-outstanding]").evaluateAll((els) => els.map((e) => e.getAttribute("data-outstanding"))), ["gap", "gap"]);
  assert.match(await page.locator("[data-onboarding-summary]").innerText(), /Not complete: 2 scope gaps open/);
  await page.getByRole("button", { name: "Add missing items" }).click();
  await page.locator("[data-onboarding-enroll] [role=status]").waitFor();
  assert.equal(await page.locator("[data-onboarding-enroll] [role=status]").innerText(), "Nothing missing; no item was changed.");
  assert.equal(Number(sql(`select count(*) from client_onboarding_items where client_id = '${V}'`)), vRows);
  await shot(page, "onboarding-gaps");
  ok("Start and re-run: rows added once, nothing changed on re-run; no site / no location shown as scope gaps");

  // ── Control Center ───────────────────────────────────────────────────
  await page.goto(`${base}/production/health`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Client onboarding" }).click();
  for (const [client, state] of [[U, "Waiting"], [V, "Blocked"]]) {
    const card = page.locator(`[data-readiness-client="${client}"]`);
    await card.locator("summary").click();
    const line = card.locator("li", { hasText: "New client onboarding checklist" });
    assert.equal(await line.count(), 1, client);
    assert.match(await line.innerText(), new RegExp(state));
  }
  assert.match(await page.locator(`[data-readiness-client="${V}"] li`, { hasText: "New client onboarding checklist" }).innerText(), /2 scope gaps/);
  assert.equal(await page.locator(`[data-readiness-client="${W}"]`).count(), 0, "map-tracking client not in the roster");
  await shot(page, "control-center");
  ok("Control Center › Client onboarding: per-client check, gaps keep a client blocked");

  // ── New client creation ──────────────────────────────────────────────
  await page.goto(`${base}/clients`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New client" }).click();
  await page.locator("#name").fill("Onboarding UI New Client (fictional)");
  await page.locator("#vertical").fill("roofing");
  await page.locator("#city").fill("Springfield");
  await page.locator("#state").fill("MO");
  await page.locator("#website_url").fill("https://new-client.example.test");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.waitForURL(/\/clients\/[0-9a-f-]{36}$/);
  const created = page.url().split("/").at(-1);
  await page.goto(`${base}/clients/${created}/onboarding`, { waitUntil: "networkidle" });
  assert.equal(await page.getByRole("button", { name: "Add missing items" }).count(), 1, "already enrolled");
  assert.equal(await page.locator('[data-onboarding-item="website_owner"]').count(), 1, "its site has rows");
  assert.deepEqual(await page.locator("[data-outstanding]").evaluateAll((els) => els.map((e) => e.getAttribute("data-outstanding"))), ["gap"], "no location decided yet");
  ok("New client: enrolled on creation with its site's rows; the missing location is a gap");

  // ── Exclusion and phone width ────────────────────────────────────────
  await page.goto(`${base}/clients/${W}/onboarding`, { waitUntil: "networkidle" });
  assert.match(await page.locator("[data-onboarding-excluded]").innerText(), /Map-tracking-only client/);
  assert.equal(await page.getByRole("button", { name: "Start the checklist" }).count(), 1);
  const phone = await (await contextFor(browser, TEAM, { width: 390, height: 844 })).newPage();
  await phone.goto(`${base}/clients/${U}/onboarding`, { waitUntil: "networkidle" });
  const overflow = await phone.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll on a phone (${overflow}px)`);
  await shot(phone, "onboarding-mobile");
  ok("Map-tracking exclusion visible; phone width without horizontal scroll");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`onboarding UI: ${checks.length} checks passed`);
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  await browser?.close();
  app.kill();
  gateway.close();
}
process.exit(0);
