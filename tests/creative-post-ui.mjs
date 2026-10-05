// Browser acceptance check for a post's graphic, end to end: a teammate
// records a template preview for the client, approves it, sets a draft
// post's graphic policy, renders the graphic, downloads it, submits and
// approves the post, then requests a new graphic. Run by
// `npm run test:creative-post-ui` (scripts/test-tasks-ui.sh with UI_SPEC set).
//
// The real app (`next dev`) against a Postgres replay behind PostgREST. The
// gateway serves /functions/v1/creative-engine with the deployed handler and
// store (supabase/functions/creative-engine) over a service-role client, so
// every write goes through 0054's governed functions as the Creative Engine
// session; Storage is an in-memory stand-in that records objects in
// storage.objects as Supabase does. Lucas's ids and governed record
// (production snapshot) with synthetic stand-in photos, not client photos.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { nodeEngine } from "../scripts/lib/creative-engine-node.mjs";
import { createCreativeEngine } from "../supabase/functions/creative-engine/handler.ts";
import { createStore } from "../supabase/functions/creative-engine/store.ts";
import { FACTS, clone, C as CLAIM, RR } from "./helpers/creative-fixtures.mjs";
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
const serviceKey = sign({ role: "service_role", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const run = (cmd, q) => execFileSync("/bin/sh", ["-c", `${cmd} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sql = (q) => run(PSQL, q);
const admin = (q) => run(PSQL_ADMIN, q);
const lit = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ── Stand-in source files, hashed as the hasher would record them ──────────
const engine = await nodeEngine();
const facts = clone(FACTS);
const files = new Map();                 // brand-assets path → bytes
for (const a of facts.assets) {
  const png = engine.rasterize(syntheticSvg(a));
  a.content_hash = sha(png);
  files.set(a.storage_path, png);
}
const creativeFiles = new Map();         // creative-assets path → bytes

// ── Supabase's gateway, reduced: auth user, REST, Storage, the function ────
let creativeEngine;                      // set once the gateway URL exists
const unexpected = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const body = []; for await (const c of req) body.push(c);
  if (url.pathname === "/auth/v1/user") {
    const c = verify(bearer);
    const u = c?.sub && users.get(c.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname === "/functions/v1/creative-engine") {
    const r = await creativeEngine.handle(new Request("http://x/functions/v1/creative-engine", {
      method: req.method, headers: { "content-type": "application/json", authorization: req.headers.authorization ?? "" },
      body: req.method === "POST" ? Buffer.concat(body) : undefined,
    }));
    res.writeHead(r.status, { "content-type": "application/json" });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  // Teammates read the private creative-assets bucket (0054's team-only policy).
  const m = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?(brand-assets|creative-assets)\/(.+)$/);
  if (m && req.method === "GET") {
    const path = decodeURIComponent(m[2]);
    const team = verify(bearer)?.sub === TEAM.id;
    const bytes = (m[1] === "brand-assets" ? files : creativeFiles).get(path);
    if (!team || !bytes) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"message":"Object not found"}'); }
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(bytes);
  }
  if (url.pathname.startsWith("/rest/v1/")) {
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

// The deployed handler and store over a service-role client; Storage reads
// and uploads go to the stand-in (an upload records its storage.objects row).
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const store = createStore(service);
store.read = async (path) => files.get(path);
store.upload = async (path, bytes, type) => {
  creativeFiles.set(path, Buffer.from(bytes));
  admin(`insert into storage.objects (bucket_id, name, metadata) select 'creative-assets', ${lit(path)}, ${lit(JSON.stringify({ size: bytes.byteLength, mimetype: type }))}::jsonb
         where not exists (select 1 from storage.objects where bucket_id = 'creative-assets' and name = ${lit(path)})`);
};
creativeEngine = createCreativeEngine({ store, engine: nodeEngine });

// ── Fixtures: Lucas's governed record and one draft Business Profile post ──
const C = facts.client.id;
const POST = "00000000-0000-4000-c000-00000000c0a1";
const COPY = "Planning a roof replacement in Wentzville? Lucas Construction is an Owens Corning Preferred Contractor and installs Owens Corning Duration shingles. Request a quote.";
sql(`insert into clients (id, name, city, state, phone, website_url, status) values (${lit(C)}, ${lit(facts.client.name)}, 'Wentzville', 'MO', ${lit(facts.client.phone)}, ${lit(facts.client.website_url)}, 'launching')`);
sql(`update client_brands set tagline = ${lit(facts.brand.tagline)} where client_id = ${lit(C)}`);
sql(`insert into brand_boards (client_id, version, standing_cta) values (${lit(C)}, 1, ${lit(facts.brand.standing_cta)})`);
sql(`insert into services (id, client_id, name, segment, status) values ${facts.services.map((s) => `(${lit(s.id)}, ${lit(C)}, ${lit(s.name)}, ${lit(s.segment)}, ${lit(s.status)})`).join(", ")}`);
sql(`insert into claims (id, client_id, claim, status, source) values ${facts.claims.map((c) => `(${lit(c.id)}, ${lit(C)}, ${lit(c.claim)}, ${lit(c.status)}, ${lit(c.source)})`).join(", ")}`);
admin(`insert into brand_assets (id, client_id, kind, label, source, storage_path, width, height, content_hash, content_hashed_at,
  creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_review_note, creative_reviewed_at) values ${facts.assets.map((a) =>
  `(${lit(a.id)}, ${lit(C)}, ${lit(a.kind)}, 'Stand-in', 'website_scan', ${lit(a.storage_path)}, ${a.width}, ${a.height}, ${lit(a.content_hash)}, now(),
    ${lit(a.creative_use)}, ${a.depicts_own_work == null ? "null" : a.depicts_own_work}, ${lit(`{${a.subjects.map((s) => `"${s}"`).join(",")}}`)},
    ${a.focal_x ?? "null"}, ${a.focal_y ?? "null"}, ${a.creative_use === "excluded" ? "'Stand-in exclusion'" : "null"}, now())`).join(", ")}`);
admin(`insert into storage.objects (bucket_id, name, metadata) select 'brand-assets', storage_path, '{"size": 2000}' from brand_assets where client_id = ${lit(C)}`);
admin(`insert into social_posts (id, client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
       values (${lit(POST)}, ${lit(C)}, 'google_business', 'commercial', ${lit(RR)}, ${lit(COPY)}, 'LEARN_MORE', 'https://lucasconstructionmo.com/services/roof-replacement')`);
admin(`insert into post_claims (post_id, client_id, claim_id) values (${lit(POST)}, ${lit(C)}, ${lit(CLAIM.oc)}), (${lit(POST)}, ${lit(C)}, ${lit(CLAIM.dur)})`);

const port = Number(process.env.CREATIVE_UI_PORT ?? 3433);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user, viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}
const fnCall = async (body) => {
  const r = await creativeEngine.handle(new Request("http://x", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(TEAM)}` }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

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
  page.on("dialog", (d) => d.accept());
  const memberId = sql(`select id from team_members where auth_user_id = '${TEAM.id}'`);

  // 1. Go-live step 3, as the function does it: register the template versions.
  const reg = await fnCall({ mode: "register" });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(sql(`select count(*) from creative_templates`), "15");
  ok("register writes the 15 Lucas template versions through creative_register_template");

  // 2. Record a client preview, then approve it, on Creative previews.
  const previews = `${base}/clients/${C}/brand/creative-preview`;
  const KEY = "lucas-service-spotlight-gbp";
  await page.goto(previews, { waitUntil: "networkidle" });
  const panel = page.locator(`[data-approval="${KEY}"]`);
  assert.match(await panel.innerText(), /Business Profile/);
  await panel.locator(`[data-record-preview="${KEY}"] button`).click();
  await panel.getByText(/Preview recorded/).waitFor({ timeout: 120000 });
  assert.equal(sql(`select cct.status from client_creative_templates cct join creative_templates t on t.id = cct.template_id where t.key = '${KEY}'`), "proposed");
  assert.equal(sql(`select purpose||'/'||status from creative_runs`), "template_preview/succeeded");
  await page.reload({ waitUntil: "networkidle" });
  const recorded = await page.request.get(`${base}${await panel.getByRole("link", { name: "Recorded preview" }).getAttribute("href")}`);
  assert.equal(recorded.status(), 200);
  assert.equal(recorded.headers()["x-creative-content-hash"], sha(await recorded.body()));
  await panel.getByRole("button", { name: "Approve for this client" }).click();
  await panel.getByText("Approved for this client.").waitFor();
  assert.equal(sql(`select status||'/'||approved_by from client_creative_templates`), `approved/${memberId}`);
  ok("A teammate records a client preview (proposed), opens it, and approves it; the database stamps who approved");

  // Go-live step 6: the channel default (new posts only).
  await page.locator(`[data-channel-policy="facebook"] select`).selectOption("optional");
  await page.locator(`[data-channel-policy="facebook"] button`).click();
  await page.locator(`[data-channel-policy="facebook"]`).getByText(/Saved/).waitFor();
  assert.equal(sql(`select channel||'/'||creative_policy||'/'||updated_by from client_creative_settings`), `facebook/optional/${memberId}`);
  ok("The per-channel graphic policy is set by a teammate (client_creative_settings)");

  // 3. The post: policy, render, download.
  const postUrl = `${base}/clients/${C}/social/${POST}`;
  await page.goto(postUrl, { waitUntil: "networkidle" });
  const g = page.locator("[data-post-creative]");
  assert.match(await g.innerText(), /without a rendered graphic/);
  assert.equal(await g.locator("[data-generate-creative-form]").count(), 0);
  await g.locator("[data-creative-policy-form] select").selectOption("optional");
  await g.locator("[data-creative-policy-form] button").click();
  await g.locator("[data-generate-creative-form]").waitFor();
  assert.deepEqual(await g.locator("#template_id option").allInnerTexts(), ["Lucas Service Spotlight — Business Profile 1200×900 (v1)"]);
  await g.getByRole("button", { name: "Generate graphic" }).click();
  await g.getByText("Graphic rendered and linked.").waitFor({ timeout: 120000 });
  await page.reload({ waitUntil: "networkidle" });
  const img = g.locator("[data-creative-image]");
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 60000 });
  assert.deepEqual(await img.evaluate((i) => [i.naturalWidth, i.naturalHeight]), [1200, 900]);
  const [hash, runs, link, status] = [
    sql(`select content_hash from creative_assets where purpose = 'post'`),
    sql(`select string_agg(purpose||'/'||status||'/'||requested_via||'/'||(requested_by = '${memberId}'), ',' order by created_at) from creative_runs`),
    sql(`select copy_hash from post_assets where post_id = '${POST}' and creative_asset_id is not null`),
    sql(`select creative_status||'/'||creative_version from social_posts where id = '${POST}'`),
  ];
  assert.equal(runs, "template_preview/succeeded/team/true,post/succeeded/team/true");
  assert.equal(link, sha(COPY), "the link records the copy it was made for");
  assert.equal(status, "ready/1");
  const overlay = JSON.parse(sql(`select overlay from creative_assets where purpose = 'post'`));
  assert.deepEqual(overlay.filter((o) => o.role === "claim").map((o) => o.source_id).sort(), [CLAIM.dur, CLAIM.oc].sort(), "only the post's linked claims");
  const dlHref = await g.locator("[data-creative-download]").getAttribute("href");
  const dl = await page.request.get(`${base}${dlHref}`);
  assert.match(dl.headers()["content-disposition"], /^attachment; filename="lucas-construction-lucas-service-spotlight-gbp-[0-9a-f]{12}\.png"$/);
  assert.equal(sha(await dl.body()), hash, "the download is exactly the recorded bytes");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/post-graphic-draft.png`, fullPage: true });
  ok("On a draft post a teammate sets the graphic policy, renders from the approved template, sees it and downloads the exact recorded bytes");

  // 4. Review: submit, approve; the approval binds the creative bytes.
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve" }).waitFor();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator("[data-copy-text]").waitFor();
  assert.equal(sql(`select review_status||'/'||(approved_snapshot->'creative'->0->>'content_hash') from social_posts where id = '${POST}'`), `approved/${hash}`);
  ok("Submit and approve: the approval snapshot binds the graphic's content hash; Copy text is offered on the approved post");

  // 5. Request a new graphic: back to draft, unlinked; render again; reject the graphic only.
  await g.locator("[data-request-new-creative-form] input").fill("Use the real-work layout");
  await g.getByRole("button", { name: "Request new graphic" }).click();
  // The post is a draft again: the badge says so and the render form is back.
  await g.getByText("new graphic requested").waitFor();
  await g.locator("[data-generate-creative-form]").waitFor();
  assert.equal(sql(`select review_status||'/'||creative_status||'/'||(select count(*) from post_assets where post_id = '${POST}') from social_posts where id = '${POST}'`), "draft/requested/0");
  await page.reload({ waitUntil: "networkidle" });
  await g.getByRole("button", { name: "Generate graphic" }).click();
  await g.getByText("Graphic rendered and linked.").waitFor({ timeout: 120000 });
  assert.equal(sql(`select creative_status||'/'||creative_version from social_posts where id = '${POST}'`), "ready/2");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.locator("[data-rejection-category]").waitFor();
  await page.locator("#reject_note").fill("Graphic is too dark");
  await page.locator("[data-rejection-category] input[value=creative]").check();
  await page.getByRole("button", { name: "Reject" }).click();
  await page.getByText(/Rejected by .*Graphic is too dark/).waitFor();
  await g.locator("[data-request-new-creative-form]").waitFor();
  assert.equal(sql(`select review_status||'/'||rejection_category from social_posts where id = '${POST}'`), "rejected/creative");
  ok("Request new graphic returns the post to draft unlinked; a re-render is a new run; a reviewer can reject the graphic alone");

  // 6. Only teammates read creative files.
  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const pr = await pctx.request.get(`${base}${dlHref}`, { maxRedirects: 0 });
  const anon = await fetch(`${base}${dlHref}`, { redirect: "manual" });
  assert.ok(pr.status() !== 200 && !pr.headers()["x-creative-content-hash"], `portal: ${pr.status()}`);
  assert.ok(anon.status !== 200 && !anon.headers.get("x-creative-content-hash"), `anon: ${anon.status}`);
  await pctx.close();
  ok("A portal contact and an anonymous caller get no creative file");

  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  await mp.goto(postUrl, { waitUntil: "networkidle" });
  const wide = await mp.evaluate(() => [...document.querySelectorAll("body *")]
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest("[data-overflow-ok]"))
    .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} ${Math.round(el.getBoundingClientRect().right)}`));
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), wide.join(" | "));
  await mctx.close();
  ok("Phone width: the post page has no horizontal scroll");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.deepEqual(unexpected, [], `calls outside the sandbox: ${unexpected.join(" | ")}`);
  assert.equal(sql(`select count(*) from publisher_runs`), "0");
  ok("Nothing was published; no calls outside the sandbox");
  console.log(`Creative post browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
