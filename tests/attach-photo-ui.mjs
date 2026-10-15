// Browser and API acceptance for the drafter's photo attach
// (20261015060000) and the brand-asset picker. Run by
// `npm run test:attach-photo-ui` (scripts/test-tasks-ui.sh with
// UI_FIXTURES=posts_ui_fixtures.sql): a real Postgres replay behind
// PostgREST, the real post-drafter and post-publisher handlers over a stub of
// Supabase's gateway (auth, REST, Storage), a fake Zernio, `next dev` and
// Chrome. Fictional data only; nothing leaves the machine.
//
// What it proves: the post-drafter attaches an approved photo of the post's
// own client to a drafted Business Profile post in review, hashing the stored
// bytes itself; refusals (unreviewed, excluded, another client's, stale) leave
// nothing behind; a retry replays. The post page shows the photo; a person's
// approval carries it; the publisher's no-write preflight loads the same
// bytes, matches the approved hash and puts it in the request. The picker
// lists only eligible photos, as cards a person can tell apart, closes after
// one photo on a Business Profile post, says so when there is nothing to pick,
// and the server refuses an ineligible asset sent around it.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createPostPublisher } from "../supabase/functions/post-publisher/handler.ts";
import { createStore as publisherStore } from "../supabase/functions/post-publisher/store.ts";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore as drafterStore } from "../supabase/functions/post-drafter/store.ts";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const CLIENT_A = "00000000-0000-4000-b000-00000000000a";
const CLIENT_B = "00000000-0000-4000-b000-00000000000b";
const DRAIN = "00000000-0000-4000-e000-00000000000a";
const HEATERS = "00000000-0000-4000-e000-00000000001a";
const SOURCED = "00000000-0000-4000-f000-00000000001a";
const users = new Map([[TEAM.id, TEAM]]);

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
const teamJwt = sign({ sub: TEAM.id, role: "authenticated", aud: "authenticated", email: TEAM.email, exp: exp() });
const sh = (cmd, q) => execFileSync("/bin/sh", ["-c", `${cmd} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sql = (q) => sh(PSQL, q);
const admin = (q) => sh(PSQL_ADMIN, q);

// Distinct photo-sized PNGs, so each file has its own hash.
function png(rgb) {
  const [w, h] = [480, 600];
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(y < h * 0.55 ? rgb : [110, 90, 70], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const FILES = new Map(); // storage path → bytes

// Supabase's gateway, reduced to what the app and the two functions call.
const unexpected = [];
const signedPaths = [];
const downloads = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const body = [];
  for await (const c of req) body.push(c);
  const raw = Buffer.concat(body);
  if (url.pathname === "/auth/v1/user") {
    const u = users.get(verify(bearer)?.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = upstream.headers.get(k); if (v) h[k] = v; }
    res.writeHead(upstream.status, h);
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (req.method === "POST" && url.pathname === "/functions/v1/post-publisher") {
    const answer = await publisher().handle(new Request("http://fn/post-publisher", { method: "POST", headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" }, body: raw }));
    res.writeHead(answer.status, { "content-type": "application/json" });
    return res.end(Buffer.from(await answer.arrayBuffer()));
  }
  // Signing: a signed-in teammate's session only.
  if (req.method === "POST" && url.pathname === "/storage/v1/object/sign/brand-assets") {
    const { paths = [] } = JSON.parse(raw.toString() || "{}");
    if (!verify(bearer)?.sub) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ statusCode: "403", message: "teammates only" })); }
    signedPaths.push(...paths);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(paths.map((path) => FILES.has(path)
      ? { path, signedURL: `/object/sign/brand-assets/${path}?token=sandbox`, error: null }
      : { path, signedURL: null, error: "Object not found" })));
  }
  const serve = (path) => {
    const bytes = FILES.get(path);
    if (!bytes) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ statusCode: "404", message: "Object not found" })); }
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(bytes);
  };
  if (req.method === "GET" && url.pathname.startsWith("/storage/v1/object/sign/brand-assets/") && url.searchParams.get("token") === "sandbox") {
    return serve(decodeURIComponent(url.pathname.slice("/storage/v1/object/sign/brand-assets/".length)));
  }
  // A download by the functions' service role (supabase-js storage.download).
  const dl = /^\/storage\/v1\/object\/(?:authenticated\/)?brand-assets\/(.+)$/.exec(url.pathname);
  if (dl && ["GET", "POST"].includes(req.method)) {
    if (verify(bearer)?.role !== "service_role") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ statusCode: "403", message: "service role only" })); }
    downloads.push(decodeURIComponent(dl[1]));
    return serve(decodeURIComponent(dl[1]));
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = () => createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const ZGBP = "cccccccccccccccccccccccc";
const GBP_LOC = "locations/7770001";
const zernioFetch = async (u) => {
  const url = new URL(String(u));
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const path = url.pathname.replace(/^\/api/, "");
  if (path === "/v1/accounts") return json(200, { accounts: url.searchParams.get("platform") === "googlebusiness" ? [{ _id: ZGBP, platform: "googlebusiness", displayName: "Harbor Lane", isActive: true }] : [] });
  if (path.endsWith("/gmb-locations")) return json(200, { locations: [{ id: "7770001", name: "Harbor Lane Plumbing", websiteUrl: "https://a.example.test" }], selectedLocationId: "7770001", hasMore: false });
  if (path.endsWith("/health")) return json(200, { status: "healthy", tokenStatus: { valid: true }, permissions: { posting: [{ scope: "business.manage", granted: true, required: true }] } });
  return json(404, { error: `unexpected ${path}` });
};
let publisherInstance = null;
const publisher = () => publisherInstance ??= createPostPublisher({ store: publisherStore(service()), fetch: zernioFetch });
const drafter = createPostDrafter({ store: drafterStore(service()) });
const attach = async (b, auth = { authorization: `Bearer ${teamJwt}` }) => {
  const r = await drafter.handle(new Request("http://fn/post-drafter", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ mode: "attach_photo", runtime: "attach-ui-test", ...b }) }));
  return { status: r.status, body: await r.json() };
};
const rpc = async (fn, args) => {
  const r = await fetch(`${gatewayUrl}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const text = await r.text();
  assert.ok(r.ok, `${fn}: ${r.status} ${text}`);
  return JSON.parse(text);
};
// A drafter_write request shaped like the post-drafter's Business Profile submit.
const draftReq = (copy, serviceId, intent) => ({
  client_id: CLIENT_A, requested_via: "worker", runtime: "attach-ui-model", attempt: 1,
  brief_version: "drafter-brief/1", brief_hash: `sha256:${"ef".repeat(32)}`,
  brief: { client: { id: CLIENT_A }, target: { channel: "google_business", post_type: "standard", search_intent: intent,
    service: { id: serviceId, name: "Service" }, keyword: null, cta: { type: null, url: null }, offer: null },
    allowed_facts: { claims: [{ id: SOURCED }] } },
  lint: { ok: true, problems: [], warnings: [] }, copy, claim_ids: [SOURCED], asset_ids: [],
});

const port = Number(process.env.POSTS_UI_PORT ?? 3421);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
try {
  // ── Fixtures: Harbor Lane's photos, as reviewed and hashed ───────────────
  const photo = (key, rgb) => { const path = `${CLIENT_A}/scan/${key}.png`; const bytes = png(rgb); FILES.set(path, bytes); return { path, hash: sha(bytes) }; };
  const own = photo("roof-finished", [96, 140, 190]);
  const own2 = photo("roof-active", [180, 120, 90]);
  const illus = photo("roof-diagram", [90, 160, 110]);
  const unrev = photo("unreviewed", [200, 200, 80]);
  const excl = photo("excluded", [160, 60, 60]);
  const bPath = `${CLIENT_B}/scan/b-roof.png`;
  FILES.set(bPath, png([60, 60, 160]));
  const asset = (id, client, path, hash, use, ownWork, subjects, label = "Photo from the home page") => admin(`
    insert into brand_assets (id, client_id, kind, label, source, storage_path, mime_type, width, height, content_hash, content_hashed_at,
      content_measurement, creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_reviewed_at, creative_review_note)
    values ('${id}', '${client}', 'photo', '${label}', 'website_scan', '${path}', 'image/png', 480, 600, '${hash}', now(),
      '{"measured_by": "attach-ui"}', '${use}', ${ownWork === null ? "null" : ownWork}, ${use === "approved" ? `array[${subjects.map((s) => `'${s}'`).join(",")}]` : "'{}'"},
      ${use === "approved" ? "0.5" : "null"}, ${use === "approved" ? "0.5" : "null"},
      ${use === "unreviewed" ? "null" : "now()"}, ${use === "excluded" ? "'Client asked us not to use it'" : "null"})`);
  const OWN = "00000000-0000-4000-f400-00000000000a", OWN2 = "00000000-0000-4000-f400-00000000001a", ILLUS = "00000000-0000-4000-f400-00000000002a";
  const UNREV = "00000000-0000-4000-f400-00000000003a", EXCL = "00000000-0000-4000-f400-00000000004a", B_PHOTO = "00000000-0000-4000-f400-00000000000b";
  asset(OWN, CLIENT_A, own.path, own.hash, "approved", true, ["roof replacement", "completed project"]);
  asset(OWN2, CLIENT_A, own2.path, own2.hash, "approved", true, ["roof installation", "active project"]);
  asset(ILLUS, CLIENT_A, illus.path, illus.hash, "approved", false, ["roof"], "Roof layers diagram");
  asset(UNREV, CLIENT_A, unrev.path, unrev.hash, "unreviewed", null, []);
  asset(EXCL, CLIENT_A, excl.path, excl.hash, "excluded", null, []);
  asset(B_PHOTO, CLIENT_B, bPath, sha(FILES.get(bPath)), "approved", true, ["roof"]);
  admin(`update services set page_url = 'https://a.example.test/drain-cleaning' where id = '${DRAIN}';
         update services set page_url = 'https://a.example.test/water-heaters' where id = '${HEATERS}'`);
  // Harbor Lane's location, bound by the publisher's service session; keys for the preflight.
  sql(`select vault.create_secret('sk_publish_attach', 'ZERNIO_PUBLISH_API_KEY'); select vault.create_secret('sk_read_attach', 'ZERNIO_READ_API_KEY')`);
  const gbpAcc = (await rpc("publisher_bind_gbp_location", { p_client_id: CLIENT_A, p_account_id: ZGBP, p_location_id: GBP_LOC, p_location_name: "Harbor Lane Plumbing", p_account_name: "Harbor Lane", p_health: { status: "healthy" } })).social_account_id;

  // Two drafted Business Profile posts (the drafter's write), in review.
  const p1 = await rpc("drafter_write", { p: draftReq("Harbor Lane Plumbing clears slow drains in Springfield. A licensed master plumber is on every job.", DRAIN, "informational") });
  const p2 = await rpc("drafter_write", { p: draftReq("Water heater trouble? A licensed master plumber is on every Harbor Lane job. Ask for a quote.", HEATERS, "commercial") });
  assert.equal(p1.social_account_id, gbpAcc);
  const row = (id, cols) => sql(`select ${cols} from social_posts where id = '${id}'`);
  const updatedAt = (id) => sql(`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from social_posts where id = '${id}'`) || null;
  const before = row(p1.post_id, "copy || '|' || social_account_id || '|' || service_id || '|' || drafter_run_id || '|' || publish_attempts");
  ok("Fixtures: Harbor Lane's reviewed photos, its bound location, two drafted Business Profile posts in review");

  // ── The post-drafter attaches ─────────────────────────────────────────────
  for (const [id, err, status] of [[UNREV, "asset_not_approved", 422], [EXCL, "asset_not_approved", 422], [B_PHOTO, "asset_not_found", 404]]) {
    const r = await attach({ post_id: p1.post_id, brand_asset_id: id, operation_id: `ui-refuse-${id.slice(-4)}`, expected_updated_at: updatedAt(p1.post_id) });
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error, err);
  }
  assert.ok(!downloads.includes(bPath), "another client's file is never read");
  const stale = await attach({ post_id: p1.post_id, brand_asset_id: OWN, operation_id: "ui-stale-0001", expected_updated_at: "2020-01-01T00:00:00Z" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "stale_post");
  const noAuth = await attach({ post_id: p1.post_id, brand_asset_id: OWN, operation_id: "ui-noauth-001", expected_updated_at: updatedAt(p1.post_id) }, {});
  assert.equal(noAuth.status, 401);
  assert.equal(row(p1.post_id, "review_status || '|' || (select count(*) from post_assets where post_id = social_posts.id)"), "in_review|0");
  ok("Refusals through the function: unreviewed, excluded, another client's photo, a stale read, no caller; nothing changed");

  const attached = await attach({ post_id: p1.post_id, brand_asset_id: OWN, operation_id: "ui-attach-p1-0001", expected_updated_at: updatedAt(p1.post_id) });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  assert.equal(attached.body.review_status, "in_review");
  assert.equal(attached.body.content_hash, own.hash);
  assert.ok(downloads.includes(own.path), "the function hashed the stored file");
  assert.equal(row(p1.post_id, "review_status || '|' || publish_status || '|' || publish_attempts || '|' || coalesce(updated_by::text, 'none')"), "in_review|not_scheduled|0|none");
  assert.equal(row(p1.post_id, "copy || '|' || social_account_id || '|' || service_id || '|' || drafter_run_id || '|' || publish_attempts"), before);
  assert.equal(sql(`select brand_asset_id || '|' || content_hash from post_assets where post_id = '${p1.post_id}'`), `${OWN}|${own.hash}`);
  const team = sql(`select id from team_members where email = '${TEAM.email}'`);
  assert.equal(sql(`select requested_via || '|' || requested_by || '|' || outcome from drafter_post_edits where operation_id = 'ui-attach-p1-0001'`), `team|${team}|attached`);
  assert.equal(sql(`select string_agg(kind || '/' || actor_kind || '/' || coalesce(actor_id::text, '-'), ',' order by id) from post_events where post_id = '${p1.post_id}' and kind in ('withdrawn', 'asset_linked')`), "withdrawn/drafter/-,asset_linked/drafter/-");
  const replay = await attach({ post_id: p1.post_id, brand_asset_id: OWN, operation_id: "ui-attach-p1-0001", expected_updated_at: null });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  ok("The post-drafter attaches the approved photo: in review, unscheduled, no attempts, same copy / destination / provenance, history names the drafter, a retry replays");

  // ── The post page: the photo renders; a person approves; the preflight ────
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const session = { access_token: teamJwt, refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...TEAM, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); } };
  const postUrl = (id) => `${base}/clients/${CLIENT_A}/social/${id}`;

  await page.goto(postUrl(p1.post_id), { waitUntil: "networkidle" });
  const media = page.locator("[data-post-media]");
  assert.equal(await media.count(), 1);
  assert.match(await media.textContent(), new RegExp(own.hash.slice(0, 12)));
  const img = page.locator("[data-post-media-image]");
  assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth === 480 && el.naturalHeight === 600), "the stored photo renders at its size");
  assert.match(await page.locator("[data-gbp-destination]").textContent(), /Harbor Lane Plumbing \(locations\/7770001\)/);
  await shot("attach-post-in-review");
  ok("The post page renders the attached photo (480×600, hash shown) with the bound location");

  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText(/Approved by Sam Team/).waitFor();
  assert.equal(row(p1.post_id, "approved_snapshot -> 'assets' -> 0 ->> 'content_hash'"), own.hash);
  await page.getByRole("button", { name: "Check without sending" }).click();
  await page.locator("[data-preflight-verdict]").waitFor();
  const pre = await page.locator("[data-preflight]").textContent();
  assert.match(pre, /✓ image bytes match the approved hash/);
  assert.match(pre, /✓ content publishable on .* as approved/);
  await page.getByText("The exact request").click();
  const reqBody = JSON.parse(await page.locator("[data-preflight] pre").textContent());
  assert.deepEqual(reqBody.mediaItems, [{ type: "image", url: "https://media.zernio.com/temp/<uploaded at publish time>" }]);
  assert.match(pre, /media\/presign/);
  assert.equal(sql(`select count(*) from publisher_runs where post_id = '${p1.post_id}'`), "0", "the preflight recorded nothing");
  assert.equal(row(p1.post_id, "publish_status || '|' || publish_attempts"), "not_scheduled|0");
  await shot("attach-post-approved-preflight");
  ok("A person approves; the publisher's no-write preflight loads the same bytes, matches the approved hash and carries one image in the request");

  // ── The picker ────────────────────────────────────────────────────────────
  sql(`update social_posts set review_status = 'draft' where id = '${p2.post_id}'`); // anyone may withdraw
  await page.goto(postUrl(p2.post_id), { waitUntil: "networkidle" });
  const picker = page.locator("[data-asset-picker]");
  await picker.waitFor();
  const offered = await picker.locator("[data-asset-option]").evaluateAll((els) => els.map((e) => e.getAttribute("data-asset-option")).sort());
  assert.deepEqual(offered, [OWN, OWN2, ILLUS].sort(), "only approved, stored, hashed photos of this client");
  const card = picker.locator(`[data-asset-option="${OWN2}"]`);
  assert.match(await card.textContent(), /roof installation, active project/);
  assert.match(await card.textContent(), new RegExp(`480×600 · own work · id ${OWN2.slice(0, 8)} · hash ${own2.hash.slice(0, 12)}`));
  assert.match(await picker.locator(`[data-asset-option="${ILLUS}"]`).textContent(), /Roof layers diagram.*not own work \(illustration or stock\)/);
  assert.ok(await picker.locator("img").evaluateAll((els) => els.length === 3 && els.every((e) => e.complete && e.naturalWidth > 0 && e.alt.length > 0)), "thumbnails render with alt text");
  assert.ok(await page.getByRole("radio", { name: /roof installation, active project/ }).isVisible(), "each card is a labelled radio");
  await shot("attach-picker");
  ok("The picker shows only eligible photos as labelled cards: thumbnail, subjects, size, own work or not, short id and hash");

  // Around the picker: the server refuses what the picker would not offer.
  await page.evaluate((id) => {
    const r = document.querySelector('[data-asset-picker] input[type="radio"]');
    r.value = id;
    r.checked = true;
  }, UNREV);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("Approve the photo for creative use on the Brand tab first.").waitFor();
  assert.equal(sql(`select count(*) from post_assets where post_id = '${p2.post_id}'`), "0");
  ok("linkAssetAction refuses an ineligible photo sent around the picker");

  await page.getByRole("radio", { name: /roof installation, active project/ }).check();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("[data-asset-picker-closed]").waitFor();
  assert.match(await page.locator("[data-asset-picker-closed]").textContent(), /takes one photo/);
  assert.equal(sql(`select brand_asset_id || '|' || content_hash from post_assets where post_id = '${p2.post_id}'`), `${OWN2}|${own2.hash}`);
  ok("A person picks a photo; the link carries its hash; the Business Profile picker then closes");

  // Client B has a draft and no eligible photo of its own: an explicit empty state.
  const bDraft = admin(`insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy)
    values ('${CLIENT_B}', 'google_business', 'navigational', true, 'Summit Electric. Call us.') returning id`).split("\n")[0];
  admin(`update brand_assets set creative_use = 'excluded', creative_review_note = 'Test: nothing eligible' where id = '${B_PHOTO}'`);
  await page.goto(`${base}/clients/${CLIENT_B}/social/${bDraft}`, { waitUntil: "networkidle" });
  assert.match(await page.locator("[data-asset-picker-empty]").textContent(), /No photos are approved for creative use/);
  ok("With nothing eligible the picker says so and points to the Brand tab");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(postUrl(p1.post_id), { waitUntil: "networkidle" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 390px");
  await shot("attach-post-mobile");
  ok("Mobile (390px): the post with its photo fits without horizontal scrolling");

  assert.ok(signedPaths.every((p) => p.startsWith(`${CLIENT_A}/`) || p.startsWith(`${CLIENT_B}/`)), "only the viewed client's files are signed");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Attach photo checks passed (${checks.length}).${SHOTS ? ` Screenshots in ${SHOTS}.` : ""}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
