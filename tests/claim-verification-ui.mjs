// Browser acceptance for claim verification on the Intelligence tab
// (20261104200000). Run by `npm run test:claim-verification-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, the real claim-evidence handler behind the same gateway, and the
// few Storage endpoints an upload uses emulated in memory (signed upload,
// download, remove), with storage.objects rows written as the storage service
// writes them. The verification owner uploads a PDF, classifies and verifies a
// claim; a second admin sees the decision and no controls. Fictional clients
// only (the repo is public). SCREENSHOTS=<dir> saves desktop and phone captures.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createClaimEvidenceHandler } from "../supabase/functions/claim-evidence/handler.ts";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const OWNER = { id: "00000000-0000-4000-a000-0000000000c1", email: "verifier@compassmarketing.ai" };
const ADMIN2 = { id: "00000000-0000-4000-a000-0000000000c2", email: "second-admin@compassmarketing.ai" };
const users = new Map([[OWNER.id, OWNER], [ADMIN2.id, ADMIN2]]);
const id = (n) => `9c${String(n).padStart(6, "0")}-0000-4000-9c00-000000000000`;
const L = id(1), W = id(11), S = id(12), U = id(13);
const PDF = Buffer.from("%PDF-1.4\n% Fictional Roofing Co project agreement, section 7: workmanship is warranted for three (3) years.\n");
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

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
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL_ADMIN} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

// ── Fixtures ────────────────────────────────────────────────────────────────
sql(`alter table storage.objects add column if not exists version text;
insert into auth.users (id, email) values ('${OWNER.id}', '${OWNER.email}'), ('${ADMIN2.id}', '${ADMIN2.email}');
insert into team_members (id, auth_user_id, name, email, role) values
  ('${id(91)}', '${OWNER.id}', 'Vera Verifier', '${OWNER.email}', 'admin'),
  ('${id(92)}', '${ADMIN2.id}', 'Ari Admin', '${ADMIN2.email}', 'admin');
insert into claim_verification_authorities (team_member_id, authority, basis)
values ('${id(91)}', 'owner', 'Fixture: the verification owner (a migration grants it in production)');
set session_replication_role = replica;
insert into clients (id, name, city, state, website_url, phone, status) values
  ('${L}', 'Fictional Roofing Co', 'Springfield', 'MO', 'https://roofing.example.test', '(555) 030-0001', 'active');
insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on, created_at) values
  ('${W}', '${L}', '3-Year Workmanship Warranty', 'confirmed', 'Contract excerpt supplied by the owner', 'owner@roofing.example.test', now() - interval '5 days', now() - interval '40 days'),
  ('${S}', '${L}', 'Installs architectural shingles', 'sourced', 'https://roofing.example.test/services', null, null, now() - interval '30 days'),
  ('${U}', '${L}', 'Lifetime Workmanship Warranty', 'unverified', 'https://roofing.example.test/warranty', null, null, now() - interval '60 days');`);
const digest = () => sql(`select md5(string_agg(concat_ws('|', id, status, source, confirmed_by, confirmed_on, claim), ',' order by id)) from claims where client_id = '${L}'`);
const governedBefore = digest();

// ── Storage, as the hosted service behaves for these calls ─────────────────
const objects = new Map(); // path → { bytes, type }
const tokens = new Map(); // token → path
const BUCKET = "claim-evidence";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,apikey,content-type,x-upsert,x-client-info,cache-control,x-metadata",
};
async function readBody(req) { const b = []; for await (const c of req) b.push(c); return Buffer.concat(b); }
const isService = (req) => verify((req.headers.authorization ?? "").replace(/^Bearer /, ""))?.role === "service_role";

async function storage(req, res, url) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { ...cors, "content-type": "application/json", ...headers });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return send(204, "");
  const sub = url.pathname.slice("/storage/v1".length);
  const signPrefix = `/object/upload/sign/${BUCKET}/`;
  if (sub.startsWith(signPrefix)) {
    const path = decodeURIComponent(sub.slice(signPrefix.length));
    if (req.method === "POST") {
      if (!isService(req)) return send(403, { error: "Unauthorized", message: "service role only" });
      if (objects.has(path)) return send(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      const token = randomUUID();
      tokens.set(token, path);
      return send(200, { url: `${signPrefix}${path}?token=${token}` });
    }
    if (req.method === "PUT") {
      const token = url.searchParams.get("token");
      if (!token || tokens.get(token) !== path) return send(400, { error: "InvalidSignature", message: "invalid upload token" });
      tokens.delete(token);
      if (objects.has(path)) return send(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      const raw = await readBody(req);
      const ct = req.headers["content-type"] ?? "";
      let bytes = raw, type = ct;
      if (ct.startsWith("multipart/form-data")) {
        const form = await new Response(raw, { headers: { "content-type": ct } }).formData();
        const file = [...form.values()].find((v) => typeof v !== "string");
        bytes = Buffer.from(await file.arrayBuffer());
        type = file.type;
      }
      objects.set(path, { bytes, type });
      sql(`insert into storage.objects (bucket_id, name, metadata, version) values ('${BUCKET}', '${path}',
           jsonb_build_object('size', ${bytes.length}, 'mimetype', '${type.replace(/'/g, "")}', 'eTag', '"${createHash("md5").update(bytes).digest("hex")}"'), '${randomUUID()}')`);
      return send(200, { Key: `${BUCKET}/${path}` });
    }
  }
  const objPrefix = `/object/${BUCKET}`;
  if (sub.startsWith(objPrefix) && isService(req)) {
    if (req.method === "GET") {
      const o = objects.get(decodeURIComponent(sub.slice(objPrefix.length + 1)));
      return o ? send(200, o.bytes, { "content-type": o.type }) : send(404, { error: "not_found", message: "Object not found" });
    }
    if (req.method === "DELETE") {
      const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || "{}");
      for (const p of prefixes) { sql(`delete from storage.objects where bucket_id = '${BUCKET}' and name = '${p}'`); objects.delete(p); }
      return send(200, prefixes.map((name) => ({ name })));
    }
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  return send(404, { error: "not_found" });
}

const unexpected = [];
let fnHandler = null;
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
    const body = await readBody(req);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = upstream.headers.get(k); if (v) h[k] = v; }
    res.writeHead(upstream.status, h);
    return res.end(out);
  }
  if (url.pathname.startsWith("/storage/v1/")) return storage(req, res, url);
  if (url.pathname === "/functions/v1/claim-evidence") {
    const body = await readBody(req);
    const r = await fnHandler(new Request(`http://localhost${url.pathname}`, { method: req.method, headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" }, body: req.method === "POST" ? body : undefined }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
fnHandler = createClaimEvidenceHandler({
  supabase: createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }),
  // As index.ts wires it: the caller's JWT, for the upload request.
  userClient: (jwt) =>
    createClient(gatewayUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    }),
});

const port = Number(process.env.CLAIM_VERIFICATION_UI_PORT ?? 3442);
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
try {
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });
  const ctx = await contextFor(browser, OWNER, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const card = page.locator('[data-card="claim-registry"]');
  const evCard = page.locator('[data-card="claim-evidence"]');
  const row = (claimId) => card.locator(`[data-claim="${claimId}"]`);
  const shot = async (name, target) => {
    if (!SHOTS) return;
    await page.addStyleTag({ content: "header { position: static !important; }" });
    await page.waitForTimeout(300);
    await target.screenshot({ path: `${SHOTS}/${name}.png` });
  };
  const today = sql(`select (now() at time zone 'America/Chicago')::date`);

  // ── The owner sees the controls ───────────────────────────────────────────
  await page.goto(`${base}/clients/${L}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.locator("[data-registry-mode]").getAttribute("data-registry-mode"), "owner");
  assert.equal(await card.locator("[data-review-controls]").count(), 3);
  assert.equal(await row(W).locator('[data-action="classify"]').textContent(), "Classify");
  assert.match(await row(W).locator("[data-verify-blocked]").textContent(), /Classify it before verifying it/);
  assert.match(await card.textContent(), /verification owner \(Vera Verifier\)/);
  ok("The verification owner sees Classify on every claim, and why verifying waits for a classification");

  // ── Upload a PDF; the server's SHA-256 is shown ───────────────────────────
  await evCard.locator('input[name="file"]').setInputFiles({ name: "agreement.pdf", mimeType: "application/pdf", buffer: PDF });
  await evCard.locator('input[name="label"]').fill("Signed project agreement, section 7 (fictional)");
  await evCard.locator('[data-form="evidence-upload"] button[type="submit"]').click();
  await evCard.locator("[data-upload-done]").waitFor({ timeout: 60000 });
  assert.match(await evCard.locator("[data-upload-done]").textContent(), new RegExp(`Registered · SHA-256 ${PDF_SHA}`));
  await evCard.locator(`[data-sha256="${PDF_SHA}"]`).waitFor({ timeout: 30000 });
  assert.equal(sql(`select sha256 || '|' || size_bytes || '|' || mime_type || '|' || storage_path from claim_evidence where client_id = '${L}'`),
    `${PDF_SHA}|${PDF.length}|application/pdf|${L}/${PDF_SHA}.pdf`);
  assert.equal(sql(`select count(*) from storage.objects where bucket_id = 'claim-evidence'`), "1");
  ok("Upload: the file goes to private storage at its content address and the function's SHA-256 is registered and shown");

  await evCard.locator('[data-action="check"]').first().click();
  await evCard.locator("[data-check-result]", { hasText: "still hash to the registered SHA-256" }).waitFor({ timeout: 30000 });
  ok("Re-check: the stored bytes are re-hashed and match");

  // ── Classify, then a refusal shown in place, then verify ──────────────────
  await row(W).locator('[data-action="classify"]').click();
  await row(W).locator('[data-form="classify"] select[name="kind"]').selectOption("warranty_guarantee");
  await row(W).locator('[data-form="classify"] button[type="submit"]').click();
  await row(W).locator('[data-action="verify"]').waitFor({ timeout: 30000 });
  assert.match(await row(W).textContent(), /Warranty or guarantee · review every 180 days/);
  assert.match(await row(W).locator("[data-decision-line]").textContent(), /Classified by Vera Verifier on/);
  ok("Classify: the kind and its review interval show, with the decision recorded");

  await row(W).locator('[data-action="verify"]').click();
  const vf = row(W).locator('[data-form="verify"]');
  assert.deepEqual(await vf.locator('select[name="method"] option').evaluateAll((o) => o.map((x) => x.value)), ["client_contract", "manufacturer_document"]);
  assert.equal(await vf.locator('select[name="evidence"] option').count(), 1);
  await vf.locator('textarea[name="excerpt"]').fill("Workmanship is warranted for three (3) years.");
  await vf.locator('input[name="expires_on"]').fill(today);
  await vf.locator('button[type="submit"]').click();
  await row(W).locator("[data-review-error]").waitFor({ timeout: 30000 });
  assert.match(await row(W).locator("[data-review-error]").textContent(), /An expiry must be after the day examined and after today/);
  assert.equal(sql(`select count(*) from claim_reviews where claim_id = '${W}'`), "1");
  ok("A refusal from the database shows in place, and nothing is written");

  await vf.locator('input[name="expires_on"]').fill("");
  await vf.locator('button[type="submit"]').click();
  await card.locator(`[data-bucket="verified"] [data-claim="${W}"]`).waitFor({ state: "attached", timeout: 30000 });
  // Verified is the one group that starts folded (good news last).
  await card.locator('[data-bucket="verified"] > summary').click();
  const verified = card.locator(`[data-claim="${W}"]`);
  await verified.waitFor();
  assert.equal(await verified.locator("[data-verification]").getAttribute("data-verification"), "independently_verified");
  assert.match(await verified.locator("[data-evidence-line]").textContent(),
    new RegExp(`Evidence: Signed project agreement, section 7 \\(fictional\\) · document · SHA-256 ${PDF_SHA.slice(0, 8)}…${PDF_SHA.slice(-4)}`));
  assert.match(await verified.textContent(), /Verified by Vera Verifier on .+ · Client contract/);
  assert.match(await verified.textContent(), /Workmanship is warranted for three \(3\) years/);
  assert.equal(await verified.locator('[data-action="verify"]').textContent(), "Re-review");
  assert.equal(await card.locator('[data-program="client"] [data-count="verified"] dd').textContent(), "1");
  ok("Verify: the claim moves to Verified, independently, with its pinned file and the words it rests on");
  await shot("claim-verification-owner", card);
  await shot("claim-verification-evidence", evCard);

  assert.equal(sql(`select string_agg(action || ':' || (reviewer_id = '${id(91)}'), ',' order by action) from claim_reviews where claim_id = '${W}'`), "classify:true,verify:true");
  assert.equal(sql(`select evidence_sha256 from claim_reviews where claim_id = '${W}' and action = 'verify'`), PDF_SHA);
  assert.equal(digest(), governedBefore);
  assert.equal(sql(`select status from claims where id = '${W}'`), "confirmed");
  ok("The ledger holds both decisions by the owner, pinned to the file's SHA-256; no claim's status, text or source moved");

  assert.match(await row(U).locator("[data-verify-blocked]").textContent(), /Classify it before verifying it/);
  await row(U).locator('[data-action="classify"]').click();
  await row(U).locator('[data-form="classify"] select[name="kind"]').selectOption("warranty_guarantee");
  await row(U).locator('[data-form="classify"] button[type="submit"]').click();
  await row(U).locator("[data-verify-blocked]", { hasText: "next release" }).waitFor({ timeout: 30000 });
  assert.equal(await row(U).locator('[data-action="verify"]').count(), 0);
  assert.equal(sql(`select status from claims where id = '${U}'`), "unverified");
  ok("An unverified claim can be classified but is not offered verification (that comes with its content-impact review)");

  // ── A second admin: the decisions, no controls ────────────────────────────
  const actx = await contextFor(browser, ADMIN2, { width: 1280, height: 900 });
  const ap = await actx.newPage();
  ap.on("pageerror", (e) => errors.push(e.message));
  await ap.goto(`${base}/clients/${L}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  const acard = ap.locator('[data-card="claim-registry"]');
  await acard.waitFor();
  assert.equal(await acard.locator("[data-registry-mode]").getAttribute("data-registry-mode"), "read-only");
  assert.equal(await acard.locator("button, input, select, textarea, form, [role=button]").count(), 0);
  assert.match(await acard.locator(`[data-claim="${W}"] [data-evidence-line]`).textContent(), /SHA-256/);
  assert.equal(await ap.locator('[data-card="claim-evidence"] [data-form="evidence-upload"]').count(), 1);
  await actx.close();
  ok("A second admin sees the decision and its evidence, no controls in the registry, and may still upload evidence");

  // ── Phone width ───────────────────────────────────────────────────────────
  const mctx = await contextFor(browser, OWNER, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await mp.goto(`${base}/clients/${L}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  await mp.locator('[data-card="claim-registry"]').waitFor();
  await mp.locator(`[data-claim="${S}"] [data-action="classify"]`).click();
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (SHOTS) await mp.locator('[data-card="claim-registry"]').screenshot({ path: `${SHOTS}/claim-verification-mobile.png` });
  await mctx.close();
  ok("Phone width: controls and forms fit with no horizontal scroll");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  ok("No page errors and no calls outside the sandbox");
  console.log(`Claim verification browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
