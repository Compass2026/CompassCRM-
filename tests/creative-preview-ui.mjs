// Browser acceptance check for the read-only Creative previews page
// (Brand › Creative previews). Run by `npm run test:creative-preview-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): the real app (`next dev`)
// against a Postgres replay behind PostgREST, a signed-in teammate, and a
// stubbed Storage that serves stand-in source files whose hashes are the
// recorded ones. The client row carries Lucas's ids (the preview set names
// them); the source files are synthetic stand-ins, not client photos.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { nodeEngine } from "../scripts/lib/creative-engine-node.mjs";
import { render } from "../supabase/functions/creative-engine/render.ts";
import { findTemplate } from "../supabase/functions/creative-engine/registry.ts";
import { lucasPreviewRefs, LUCAS_PREVIEW_ORDER } from "../supabase/functions/creative-engine/previews.ts";
import { specHash } from "../supabase/functions/creative-engine/spec.ts";
import { FACTS, clone } from "./helpers/creative-fixtures.mjs";
import { syntheticSvg } from "./helpers/creative-synthetic.mjs";

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
const lit = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ── Stand-in source files, hashed as the hasher would record them ──────────
const engine = await nodeEngine();
const facts = clone(FACTS);
const files = new Map();                 // storage path → bytes
for (const a of facts.assets) {
  const png = engine.rasterize(syntheticSvg(a));
  a.content_hash = sha(png);
  files.set(a.storage_path, png);
}
let tamper = null;                       // a storage path served with changed bytes

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
  // The Creative use page's thumbnails: signed URLs for a teammate.
  if (url.pathname === "/storage/v1/object/sign/brand-assets" && req.method === "POST") {
    const body = []; for await (const c of req) body.push(c);
    const { paths } = JSON.parse(Buffer.concat(body).toString() || "{}");
    const team = verify(bearer)?.sub === TEAM.id;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify((paths ?? []).map((p) => (team ? { path: p, signedURL: `/object/sign/brand-assets/${p}?token=t`, error: null }
      : { path: p, signedURL: null, error: "Object not found" }))));
  }
  const signed = url.pathname.match(/^\/storage\/v1\/object\/sign\/brand-assets\/(.+)$/);
  if (signed && files.has(decodeURIComponent(signed[1]))) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(files.get(decodeURIComponent(signed[1])));
  }
  const m = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?brand-assets\/(.+)$/);
  if (m && req.method === "GET") {
    const path = decodeURIComponent(m[1]);
    const team = verify(bearer)?.sub === TEAM.id;
    const bytes = files.get(path);
    if (!team || !bytes) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"message":"Object not found"}'); }
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(path === tamper ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
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

// ── Fixtures: Lucas's governed record (production snapshot) ────────────────
const C = facts.client.id;
sql(`insert into clients (id, name, city, state, phone, website_url, status) values (${lit(C)}, ${lit(facts.client.name)}, 'Wentzville', 'MO', ${lit(facts.client.phone)}, ${lit(facts.client.website_url)}, 'launching')`);
sql(`update client_brands set tagline = ${lit(facts.brand.tagline)} where client_id = ${lit(C)}`);
sql(`insert into brand_boards (client_id, version, standing_cta) values (${lit(C)}, 1, ${lit(facts.brand.standing_cta)})`);
sql(`insert into services (id, client_id, name, segment, status) values ${facts.services.map((s) => `(${lit(s.id)}, ${lit(C)}, ${lit(s.name)}, ${lit(s.segment)}, ${lit(s.status)})`).join(", ")}`);
sql(`insert into claims (id, client_id, claim, status, source) values ${facts.claims.map((c) => `(${lit(c.id)}, ${lit(C)}, ${lit(c.claim)}, ${lit(c.status)}, ${lit(c.source)})`).join(", ")}`);
// Reviewed assets as a teammate and the hasher left them (cluster superuser).
admin(`insert into brand_assets (id, client_id, kind, label, source, storage_path, width, height, content_hash, content_hashed_at,
  creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_review_note, creative_reviewed_at) values ${facts.assets.map((a) =>
  `(${lit(a.id)}, ${lit(C)}, ${lit(a.kind)}, 'Stand-in', 'website_scan', ${lit(a.storage_path)}, ${a.width}, ${a.height}, ${lit(a.content_hash)}, now(),
    ${lit(a.creative_use)}, ${a.depicts_own_work == null ? "null" : a.depicts_own_work}, ${lit(`{${a.subjects.map((s) => `"${s}"`).join(",")}}`)},
    ${a.focal_x ?? "null"}, ${a.focal_y ?? "null"}, ${a.creative_use === "excluded" ? "'Stand-in exclusion'" : "null"}, now())`).join(", ")}`);
admin(`insert into storage.objects (bucket_id, name, metadata) select 'brand-assets', storage_path, '{"size": 2000}' from brand_assets where client_id = ${lit(C)}`);
const counts = () => sql(`select (select count(*) from creative_runs)||'/'||(select count(*) from creative_assets)||'/'||(select count(*) from creative_templates)||'/'||(select count(*) from client_creative_templates)||'/'||(select count(*) from social_posts)||'/'||(select count(*) from post_events)||'/'||(select count(*) from client_creative_settings)||'/'||(select md5(string_agg(to_jsonb(b)::text, '' order by id)) from brand_assets b)`);
const before = counts();

const port = Number(process.env.CREATIVE_UI_PORT ?? 3432);
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
  const ctx = await contextFor(browser, TEAM, { width: 1280, height: 900 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const url = `${base}/clients/${C}/brand/creative-preview`;

  await page.goto(`${base}/clients/${C}/brand/creative-use`, { waitUntil: "networkidle" });
  await page.locator("[data-creative-previews]").click();
  await page.waitForURL(url);
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator("[data-preview]").count(), 10);
  assert.equal(await page.locator("[data-refusal]").count(), 0, await page.locator("[data-refusal]").allInnerTexts().then((t) => t.join(" | ")));
  for (const img of await page.locator("[data-preview-image]").all()) {
    await img.scrollIntoViewIfNeeded();
    await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 120000 });
  }
  const widths = await page.$$eval("[data-preview-image]", (imgs) => imgs.map((i) => `${i.naturalWidth}x${i.naturalHeight}`));
  assert.deepEqual(widths, LUCAS_PREVIEW_ORDER.map((k) => (k.endsWith("-gbp") ? "1200x900" : "1080x1350")));
  ok("Creative use links to the previews; all ten previews (five families × Business Profile and 4:5 social) render for a teammate");

  const text = (await page.locator("[data-preview]").allInnerTexts()).join("\n");
  for (const s of ["Roof Replacement", "(636) 459-9328", "lucasconstructionmo.com", "Request a quote", "Owens Corning Preferred Contractor", "Our work", "Fall"]) assert.ok(text.includes(s), s);
  for (const s of ["Lifetime Workmanship Warranty", "reviews", "Free quotes", "12618 Veterans"]) assert.ok(!text.includes(s), s);
  assert.match(await page.locator("[data-blocked]").innerText(), /Review Spotlight[\s\S]*Team & Community[\s\S]*Offer mode/);
  ok("The page lists the governed lines each preview uses (no unavailable claim) and the families that stay blocked");

  // The app's render is the renderer's render: same bytes as the Node engine.
  const key = "lucas-service-spotlight-gbp";
  const r1 = await page.request.get(`${url}/${key}`);
  const r2 = await page.request.get(`${url}/${key}`);
  const body1 = await r1.body();
  assert.equal(r1.headers()["content-type"], "image/png");
  assert.equal(r1.headers()["x-creative-content-hash"], sha(body1));
  assert.equal(r2.headers()["x-creative-content-hash"], sha(body1), "deterministic across requests");
  const t = findTemplate(key, 1);
  const local = await render(engine, t, facts, { template: { key, version: 1, spec_hash: await specHash(t.spec) }, client_id: C, ...lucasPreviewRefs(key) },
    async (a) => files.get(a.storage_path));
  assert.equal(r1.headers()["x-creative-content-hash"], local.content_hash, "the app renders the same bytes as the renderer tests");
  ok("The image route is deterministic and byte-identical to the renderer's own output");
  if (SHOTS) {
    for (const k of LUCAS_PREVIEW_ORDER) writeFileSync(`${SHOTS}/${k}.png`, await (await page.request.get(`${url}/${k}`)).body());
    await page.screenshot({ path: `${SHOTS}/creative-preview-page.png`, fullPage: true });
  }

  // Governance holds at request time: a withdrawn approval and changed bytes refuse.
  admin(`update brand_assets set creative_use = 'excluded', creative_review_note = 'test' where id = '3a5e930a-1841-4cc3-860e-f6abbdf3e5a1'`);
  const refused = await page.request.get(`${url}/${key}`);
  assert.equal(refused.status(), 409);
  assert.equal((await refused.json()).code, "source_not_approved");
  await page.reload({ waitUntil: "networkidle" });
  assert.ok((await page.locator("[data-refusal]").count()) >= 4, "every preview led by that photo shows the refusal");
  admin(`update brand_assets set creative_use = 'approved', creative_review_note = null where id = '3a5e930a-1841-4cc3-860e-f6abbdf3e5a1'`);
  tamper = facts.assets.find((a) => a.id === "3a5e930a-1841-4cc3-860e-f6abbdf3e5a1").storage_path;
  const changed = await page.request.get(`${url}/${key}`);
  assert.equal(changed.status(), 409);
  assert.equal((await changed.json()).code, "source_hash_mismatch");
  tamper = null;
  assert.equal((await page.request.get(`${url}/${key}`)).status(), 200);
  ok("A withdrawn approval or changed source bytes refuse the preview (no fallback image)");

  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const pr = await pctx.request.get(`${url}/${key}`, { maxRedirects: 0 });
  const anon = await fetch(`${url}/${key}`, { redirect: "manual" });
  const notImage = (status, type, hash) => status !== 200 && !/image/.test(type ?? "") && !hash;
  assert.ok(notImage(pr.status(), pr.headers()["content-type"], pr.headers()["x-creative-content-hash"]), `portal: ${pr.status()} ${pr.headers()["content-type"]}`);
  assert.ok(notImage(anon.status, anon.headers.get("content-type"), anon.headers.get("x-creative-content-hash")), `anon: ${anon.status}`);
  await pctx.close();
  ok("A portal contact and an anonymous caller get no preview");

  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  await mp.goto(url, { waitUntil: "networkidle" });
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mctx.close();
  ok("Phone width: no horizontal scroll");

  assert.equal(counts().split("/").slice(0, 7).join("/"), before.split("/").slice(0, 7).join("/"));
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.deepEqual(unexpected, [], `calls outside the sandbox: ${unexpected.join(" | ")}`);
  assert.equal(sql(`select count(*) from creative_assets`), "0");
  ok("Read-only: no run, asset, template, client template, post, post event or policy was written; no calls outside the sandbox");
  console.log(`Creative preview browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
