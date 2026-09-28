// Browser acceptance check for the Creative use review (0054 / 0055). Run by
// `npm run test:creative-use-ui` (scripts/test-tasks-ui.sh with UI_SPEC set):
// a real Postgres replay behind PostgREST, so every decision reaches 0055's
// guard as a signed-in teammate does in production. Hashes are recorded the
// production way — brand_asset_record_hash through PostgREST as the service
// role (the source-assets function's session). Storage is stubbed by the
// gateway (signed URLs to a local PNG). Fictional, Lucas-shaped data only.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));
const C = "00000000-0000-4000-b000-0000000000c5";
const id = (n) => `00000000-0000-4000-8c00-0000000000${String(n).padStart(2, "0")}`;
const P1 = id(1), P2 = id(2), P3 = id(3), LOGO = id(4), LINK = id(5);

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
const sqlFails = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); } };

// A real 8×6 PNG (so the preview renders) served for every signed URL.
function tinyPng() {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(6, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(6 * (1 + 8 * 3), 0x7f); for (let y = 0; y < 6; y++) raw[y * 25] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = tinyPng();

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
  // Storage: signed URLs for brand-assets, answered only for a teammate.
  if (url.pathname === "/storage/v1/object/sign/brand-assets" && req.method === "POST") {
    const body = []; for await (const c of req) body.push(c);
    const { paths } = JSON.parse(Buffer.concat(body).toString() || "{}");
    const claims = verify(bearer);
    const team = claims?.sub === TEAM.id;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify((paths ?? []).map((p) => (team
      ? { path: p, signedURL: `/object/sign/brand-assets/${p}?token=t`, error: null }
      : { path: p, signedURL: null, error: "Object not found" }))));
  }
  if (url.pathname.startsWith("/storage/v1/object/sign/brand-assets/")) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG);
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const body = []; for await (const c of req) body.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(body) });
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

// The source-assets function's write: brand_asset_record_hash as service_role.
async function recordHash(assetId, bytesLabel, expected = null, w = 1066, h = 1600) {
  const path = sql(`select storage_path from brand_assets where id = '${assetId}'`);
  const hash = createHash("sha256").update(bytesLabel).digest("hex");
  const r = await fetch(`${PGRST_URL}/rpc/brand_asset_record_hash`, {
    method: "POST", headers: { authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    body: JSON.stringify({ p: { asset_id: assetId, storage_path: path, expected_hash: expected, content_hash: hash, width: w, height: h,
      byte_size: 2000, content_type: assetId === LOGO ? "image/png" : "image/jpeg", raw_width: w, raw_height: h, orientation: 1, measured_by: "ui-test" } }),
  });
  assert.equal(r.status, 200, await r.text());
  return hash;
}

// ── Fixtures: a Lucas-shaped client ─────────────────────────────────────────
sql(`insert into clients (id, name, city, state, website_url, status) values ('${C}', 'Lucas-shaped Roofing', 'Wentzville', 'MO', 'https://lucas.example.test', 'active')`);
sql(`insert into brand_assets (id, client_id, kind, label, source, storage_path, url, width, height, sort_order, creative_suggestions) values
  ('${P1}', '${C}', 'photo', 'Brick and stone home with a new architectural shingle roof', 'website_scan', '${C}/scan/photo-1.jpg', 'https://lucas.example.test/1.jpg', 1066, 1600, 101,
   '{"subjects": ["roof", "shingles", "Finished Project"], "focal": {"x": 0.45, "y": 0.35}, "depicts_own_work": true, "model": "sandbox-vision"}'),
  ('${P2}', '${C}', 'photo', 'Photo from the home page', 'website_scan', '${C}/scan/photo-2.jpg', 'https://lucas.example.test/2.jpg', 1066, 1600, 102, null),
  ('${P3}', '${C}', 'photo', 'Photo from the home page', 'website_scan', '${C}/scan/photo-3.jpg', 'https://lucas.example.test/3.jpg', 950, 1200, 103, null),
  ('${LOGO}', '${C}', 'logo_primary', 'Logo', 'website_scan', '${C}/scan/logo.png', 'https://lucas.example.test/logo.png', null, null, 0, null),
  ('${LINK}', '${C}', 'photo', 'Linked photo', 'link', null, 'https://lucas.example.test/linked.jpg', null, null, 104, null)`);
sql(`insert into storage.objects (bucket_id, name, metadata) select 'brand-assets', storage_path, '{"size": 2000}' from brand_assets where client_id = '${C}' and storage_path is not null`);
const H1 = await recordHash(P1, "p1-bytes");
await recordHash(P2, "p2-bytes");
await recordHash(LOGO, "logo-bytes", null, 512, 512);
// P3 stays unhashed; LINK has no stored file.

const port = Number(process.env.CREATIVE_UI_PORT ?? 3431);
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
const row = (assetId) => JSON.parse(sql(`select to_jsonb(b) - 'creative_suggestions' - 'content_measurement' from brand_assets b where id = '${assetId}'`));

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
  const sam = sql(`select id from team_members where email = '${TEAM.email}'`);
  const ctx = await contextFor(browser, TEAM, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name, p = page) => { if (!SHOTS) return; await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const card = (assetId) => page.locator(`[data-asset="${assetId}"]`);
  const url = `${base}/clients/${C}/brand/creative-use`;
  const save = async (assetId, expectText) => {
    await card(assetId).locator("[data-save-review]").click();
    await page.waitForFunction(([a, t]) => document.querySelector(`[data-asset="${a}"] [role=status]`)?.textContent?.includes(t), [assetId, expectText], { timeout: 20000 });
  };

  // The Brand tab links to the review with the counts.
  await page.goto(`${base}/clients/${C}/brand`, { waitUntil: "networkidle" });
  const summary = page.locator("[data-creative-use-summary]");
  assert.match(await summary.innerText(), /0 approved · 0 excluded · 5 unreviewed · 3 of 5 hashed/);
  await summary.getByRole("link", { name: /Review photos and logos/ }).click();
  await page.waitForURL(url);
  ok("Brand tab: Creative use summary (0 approved, 3 of 5 hashed) links to the review page");

  await page.locator("[data-counts]").waitFor();
  assert.equal(await page.locator("[data-asset]").count(), 5);
  assert.equal(await card(P1).locator("[data-hash-status]").getAttribute("data-hash-status"), "hashed");
  assert.match(await card(P1).locator("[data-hash-status]").innerText(), new RegExp(H1.slice(0, 16)));
  assert.equal(await card(P3).locator("[data-hash-status]").innerText(), "Stored, not hashed yet");
  assert.equal(await card(LINK).locator("[data-hash-status]").innerText(), "Link only (no stored file)");
  assert.equal(await card(LOGO).locator("[data-dimensions]").innerText(), "512×512");
  assert.ok(await card(P1).locator("img").isVisible());
  await page.waitForFunction((a) => document.querySelector(`[data-asset="${a}"] img`)?.naturalWidth === 8, P1);
  ok("Every image shows its preview, source, dimensions and SHA-256 status (hashed / not hashed / link only)");

  const sugg = card(P1).locator("[data-suggestions]");
  assert.match(await sugg.innerText(), /AI suggestions — not reviewed \(sandbox-vision\)/);
  assert.match(await sugg.innerText(), /suggested yes — decide it yourself/);
  assert.match(await card(P1).locator("[data-governed]").innerText(), /own work: not decided/i);
  assert.match(await card(P1).locator("[data-governed]").innerText(), /Subjects: none/);
  ok("AI suggestions are shown apart from the governed values, labelled not reviewed");
  await shot("creative-use-desktop");

  // Suggestions prefill only on request, and never decide own work.
  await card(P1).locator("[data-use-suggested-subjects]").click();
  await card(P1).locator("[data-use-suggested-focal]").click();
  assert.equal(await card(P1).locator("[data-subjects]").inputValue(), "roof, shingles, finished project");
  assert.equal(await card(P1).locator("[data-focal-x]").inputValue(), "45");
  assert.ok(await card(P1).locator('[data-own-work="undecided"]').isChecked());
  await card(P1).locator('[data-decision="approved"]').check();
  await save(P1, "Not saved");
  assert.match(await card(P1).locator("[role=status]").innerText(), /own work/);
  assert.equal(row(P1).creative_use, "unreviewed");
  ok("Suggestions only prefill on request; an approval without the teammate's own-work decision is refused, nothing written");

  // A complete approval: own work decided, focal point by clicking the image.
  await card(P1).locator('[data-own-work="yes"]').check();
  const box = await card(P1).locator("[data-focal-picker]").boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
  assert.ok(Math.abs(Number(await card(P1).locator("[data-focal-x]").inputValue()) - 25) < 1);
  await save(P1, "Approved for creative use");
  const r1 = row(P1);
  assert.deepEqual([r1.creative_use, r1.depicts_own_work, r1.subjects, r1.creative_reviewed_by],
    ["approved", true, ["roof", "shingles", "finished project"], sam]);
  assert.ok(Math.abs(Number(r1.focal_x) - 0.25) < 0.01 && Math.abs(Number(r1.focal_y) - 0.75) < 0.01, `focal ${r1.focal_x}, ${r1.focal_y}`);
  assert.equal(sql(`select changes->>'approved_content_hash' from creative_governance_events where subject_id = '${P1}' and action = 'approved' and actor_kind = 'team' and actor_id = '${sam}'`), H1);
  await page.waitForFunction((a) => document.querySelector(`[data-asset="${a}"]`)?.getAttribute("data-use") === "approved", P1);
  await card(P1).locator("[data-history] summary").click();
  assert.match(await card(P1).locator("[data-history]").innerText(), /approved it for creative use \(file/);
  assert.match(await card(P1).locator("[data-history]").innerText(), /Source hashing recorded the file's hash/);
  ok("A complete approval (own work, subjects, focal point clicked on the image) is saved, stamped to the teammate and in the history with the approved hash");

  // Exclusion needs a reason; then back to unreviewed.
  await card(P2).locator('[data-decision="excluded"]').check();
  await save(P2, "Not saved");
  assert.match(await card(P2).locator("[role=status]").innerText(), /Say why/);
  await card(P2).locator("[data-reason]").fill("Shows a neighbour's house, not a Lucas job");
  await save(P2, "Excluded from creative use");
  assert.equal(row(P2).creative_use, "excluded");
  assert.equal(row(P2).creative_review_note, "Shows a neighbour's house, not a Lucas job");
  await page.waitForFunction((a) => document.querySelector(`[data-asset="${a}"]`)?.getAttribute("data-use") === "excluded", P2);
  await card(P2).locator('[data-decision="unreviewed"]').check();
  await card(P2).locator("[data-reason]").fill("");
  await save(P2, "stays unreviewed");
  assert.equal(row(P2).creative_use, "unreviewed");
  ok("Exclude requires a reason; Keep unreviewed returns an image to unreviewed; both recorded");

  // An unhashed photo and a link-only photo cannot be approved.
  await card(P3).locator('[data-decision="approved"]').check();
  assert.match(await card(P3).locator("[data-blockers]").innerText(), /not been hashed/);
  await card(P3).locator('[data-own-work="yes"]').check();
  await card(P3).locator("[data-subjects]").fill("roof");
  await card(P3).locator("[data-focal-x]").fill("50"); await card(P3).locator("[data-focal-y]").fill("50");
  await save(P3, "Not saved");
  await card(LINK).locator('[data-decision="approved"]').check();
  assert.match(await card(LINK).locator("[data-blockers]").innerText(), /brand-scan import/);
  assert.equal(row(P3).creative_use, "unreviewed"); assert.equal(row(LINK).creative_use, "unreviewed");
  ok("An unhashed or link-only image cannot be approved (the reason is shown before saving)");

  // A logo: subjects only.
  await card(LOGO).locator('[data-decision="approved"]').check();
  await card(LOGO).locator("[data-subjects]").fill("logo");
  await save(LOGO, "Approved for creative use");
  assert.equal(row(LOGO).creative_use, "approved"); assert.equal(row(LOGO).depicts_own_work, null);
  ok("A logo is approved with subject tags; no own-work decision or focal point is asked for");

  // Stale page: the file changes after the page loaded.
  await page.goto(url, { waitUntil: "networkidle" });
  await recordHash(P2, "p2-new-bytes", createHash("sha256").update("p2-bytes").digest("hex"));
  await card(P2).locator('[data-decision="excluded"]').check();
  await card(P2).locator("[data-reason]").fill("Blurry");
  await save(P2, "changed since the page loaded");
  assert.equal(row(P2).creative_use, "unreviewed");
  ok("A decision on a file that changed since the page loaded is refused and nothing is written");

  // Changing an approved file resets its review.
  const hashNow = row(P1).content_hash;
  await recordHash(P1, "p1-replaced", hashNow);
  assert.equal(row(P1).creative_use, "unreviewed");
  await page.goto(url, { waitUntil: "networkidle" });
  assert.equal(await card(P1).getAttribute("data-use"), "unreviewed");
  ok("New bytes for an approved image reset it to unreviewed (the approval covered the old file)");

  // The worker and a portal contact.
  assert.match(sqlFails(`update brand_assets set creative_use = 'approved' where id = '${P3}'`) ?? "", /teammate|approved_complete/);
  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const pp = await pctx.newPage();
  await pp.goto(url, { waitUntil: "networkidle" });
  assert.ok(!pp.url().includes("/creative-use"), `portal contact stayed on ${pp.url()}`);
  const direct = await fetch(`${gatewayUrl}/rest/v1/brand_assets?id=eq.${P3}`, { method: "PATCH", headers: { authorization: `Bearer ${tokenFor(PORTAL)}`, apikey: anonKey, "content-type": "application/json", prefer: "return=representation" }, body: JSON.stringify({ creative_use: "excluded", creative_review_note: "x" }) });
  assert.deepEqual(await direct.json(), []);
  assert.equal(row(P3).creative_use, "unreviewed");
  await pctx.close();
  ok("The worker's SQL and a portal contact cannot review; the portal contact never reaches the page");

  // Phone width.
  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  await mp.goto(url, { waitUntil: "networkidle" });
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot("creative-use-mobile", mp);
  await mctx.close();
  ok("Phone width: no horizontal scroll");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(sql(`select count(*) from creative_assets`), "0");
  ok("No page errors, no calls outside the sandbox, no creative generated");
  console.log(`Creative use browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
