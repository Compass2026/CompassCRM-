// Browser acceptance check for rejection corrections (20261026200000). Run by
// `npm run test:post-revisions-ui` (scripts/test-tasks-ui.sh with UI_SPEC set):
// the full migration replay behind PostgREST, `next dev` and Chromium. The
// reviewer works in the real UI; the worker's caption correction runs through
// the real post-drafter handler and store (cron secret, service role); the
// ChatGPT image correction runs through the real content-approvals handler
// (delegation key, service role) with an in-memory file store. There is no
// model: the "model" is a fixed caption, all a model adapter ever hands in.
// Fictional data only ("Sandbox Siding", example.test); nothing leaves the
// machine, and nothing is approved, scheduled or published.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore as drafterStore } from "../supabase/functions/post-drafter/store.ts";
import { createContentApprovals } from "../supabase/functions/content-approvals/handler.ts";
import { createStore as approvalsStore } from "../supabase/functions/content-approvals/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through npm run test:post-revisions-ui");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const C = "00000000-0000-4000-b000-0000000000e7";
const SVC = "00000000-0000-4000-e000-0000000000e7";
const KW = "00000000-0000-4000-d000-0000000000e7";
const OC = "00000000-0000-4000-f000-0000000000e1";
const WARRANTY = "00000000-0000-4000-f000-0000000000e2";
const GBP = "00000000-0000-4000-c000-0000000000e7";
const IMG = "00000000-0000-4000-f200-0000000000e7";
const P_IMAGE = "00000000-0000-4000-f300-0000000000e1"; // the bug: an attached image rejected as the image
const P_CAPTION = "00000000-0000-4000-f300-0000000000e2"; // caption only → Claude, automatically
const P_MIXED = "00000000-0000-4000-f300-0000000000e3"; // both → Claude and ChatGPT
const P_UNCHANGED = "00000000-0000-4000-f300-0000000000e4"; // misclassified, then an unchanged resubmit
const P_EDIT = "00000000-0000-4000-f300-0000000000e5"; // caption edited on the review screen
const SITE = "https://siding.example.test";
const PAGE = `${SITE}/services/siding-installation`;
const COPY = "Thinking about siding installation for your Wentzville home? Sandbox Siding keeps the process straightforward, " +
  "from the first inspection to a clear estimate you can plan around. Every siding installation we complete is backed by our " +
  "Lifetime Workmanship Warranty. See how our siding installation process works and request a quote.";
const FIXED = COPY.replace("Thinking about siding installation for your Wentzville home?", "Siding Installation in Wentzville: thinking about new siding for your home?");

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const verify = (t) => {
  const [h, p, s] = (t ?? "").split(".");
  if (!s || createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
};
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const anonKey = sign({ role: "anon", exp: exp() });
const serviceKey = sign({ role: "service_role", exp: exp() });
const tokenFor = (u) => sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp: exp() });
const run = (cmd, q) => {
  try { return execFileSync("/bin/sh", ["-c", `${cmd} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { throw new Error(`${String(e.stderr ?? e.message).trim()}\n  in: ${q}`); }
};
const sql = (q) => run(PSQL, q);        // the worker's login (postgres)
const admin = (q) => run(PSQL_ADMIN, q); // the cluster owner, for fixtures only

// A real PNG (640×480), the corrected image ChatGPT "made".
const PNG = (() => {
  const [w, h] = [640, 480];
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(y < h * 0.5 ? [180, 200, 220] : [90, 110, 90], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
})();
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

// Supabase's gateway, reduced to /auth/v1/user, /rest/v1 and signing brand-asset files.
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const ok = claims?.sub === TEAM.id;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(ok ? { id: TEAM.id, email: TEAM.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await up.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status, h);
    return res.end(out);
  }
  if (req.method === "POST" && url.pathname === "/storage/v1/object/sign/brand-assets") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const { paths = [] } = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(paths.map((path) => ({ path, signedURL: `/object/sign/brand-assets/${path}?token=sandbox`, error: null }))));
  }
  if (req.method === "GET" && url.pathname.startsWith("/storage/v1/object/sign/brand-assets/")) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG);
  }
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// The worker's path: post-drafter's revision modes, as the Routine calls them.
const drafter = createPostDrafter({ store: drafterStore(service), gazetteer });
const callDrafter = async (body) => {
  const r = await drafter.handle(new Request("http://fn/post-drafter", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
// ChatGPT's path: content-approvals as Executive OS calls it. Files live in memory
// here (the uploaded bytes); the database still checks the storage object row.
const files = new Map();
const approvals = createContentApprovals({ store: {
  ...approvalsStore(service),
  uploadSlot: async (path) => ({ exists: files.has(path), signed_url: `https://upload.example.test/${path}`, token: "t" }),
  read: async (path) => (files.has(path) ? { ok: true, bytes: files.get(path) } : { ok: false, reason: "missing" }),
} });
const callApprovals = async (body) => {
  const r = await approvals.handle(new Request("http://fn/content-approvals", { method: "POST", headers: { "content-type": "application/json", "x-compass-delegation-key": "delegation" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

const port = Number(process.env.POSTS_UI_PORT ?? 3427);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
let browser;
try {
  // ── Fixture: a fictional siding client with a governed keyword-first target ──
  admin(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
  admin(`select vault.create_secret('delegation', 'EXECUTIVE_OS_DELEGATION_SECRET')`);
  admin(`insert into vault.secrets (name, secret) select n, v from (values ('ROUTINE_FIRE_URL', 'https://routine.example.test/fire'), ('ROUTINE_FIRE_TOKEN', 'sandbox-token')) x(n, v)
           where not exists (select 1 from vault.secrets where name = x.n)`);
  admin(`update team_members set role = 'admin' where auth_user_id = '${TEAM.id}'`);
  admin(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
         values ('${C}', 'Sandbox Siding', 'Wentzville', 'MO', '(636) 555-0142', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  admin(`update client_brands set positioning = 'Wentzville siding contractor.', voice_tone = 'Warm, straight-talking and local. Never state or imply prices.',
           audience = 'Homeowners in Wentzville.', differentiators = 'One local company from inspection and estimate to final sign-off',
           ai_guidance = 'Use only sourced or confirmed claims.', words_we_use = array['local', 'straightforward', 'inspection', 'estimate'],
           words_we_avoid = array['cheapest'], content_pillars = array['Siding'], tagline = 'Local siding, done plainly.' where client_id = '${C}'`);
  admin(`insert into brand_boards (client_id, version, status, standing_cta, hard_rules)
         values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.', 'Only one phone number: (636) 555-0142.'])`);
  admin(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${SVC}', '${C}', 'Siding Installation', 'approved', '${PAGE}', 'Exterior', 1)`);
  admin(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority)
         values ('${KW}', '${C}', 'siding installation wentzville', 'commercial', true, true, true, '${SVC}', '${PAGE}', 'p1')`);
  admin(`update services set primary_keyword_id = '${KW}' where id = '${SVC}'`);
  admin(`insert into claims (id, client_id, claim, status, source) values
         ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/contractors/1'),
         ('${WARRANTY}', '${C}', 'Lifetime Workmanship Warranty', 'sourced', '${PAGE}')`);
  admin(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
  admin(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids)
         values ('${C}', 'Siding Installation', 'service', 'approved', '${PAGE}', '${KW}', '{}')`);
  admin(`insert into social_accounts (id, client_id, platform, external_account_id, display_name) values ('${GBP}', '${C}', 'google_business', 'locations/5550001', 'Sandbox Siding')`);
  admin(`insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height)
         values ('${IMG}', '${C}', 'social_post', 'upload', 'Siding graphic (blue underline)', '${C}/upload/${"a".repeat(64)}.png', 'image/png', 1900000, 1448, 1086)`);
  for (const id of [P_IMAGE, P_CAPTION, P_MIXED, P_UNCHANGED, P_EDIT]) {
    admin(`insert into social_posts (id, client_id, platform, post_type, search_intent, copy, cta_type, cta_url, service_id, keyword_id, social_account_id)
           values ('${id}', '${C}', 'google_business', 'standard', 'commercial', $$${COPY}$$, 'LEARN_MORE', '${PAGE}', '${SVC}', '${KW}', '${GBP}')`);
    admin(`insert into post_claims (post_id, client_id, claim_id) values ('${id}', '${C}', '${WARRANTY}')`);
  }
  for (const id of [P_IMAGE, P_MIXED, P_UNCHANGED]) {
    admin(`insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values ('${id}', '${C}', '${IMG}', 1, 'media')`);
  }
  admin(`update social_posts set review_status = 'in_review' where client_id = '${C}'`);
  assert.equal(admin(`select count(*) from social_posts where client_id = '${C}' and review_status = 'in_review'`), "5");

  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`next dev stopped:\n${logs}`);
    try { await fetch(`${base}/login`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const executablePath = process.env.CHROME_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const session = { access_token: tokenFor(TEAM), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...TEAM, aud: "authenticated" } };
  await ctx.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name) => { if (!SHOTS) return; await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const open = async (id) => { await page.goto(`${base}/clients/${C}/social/${id}`, { waitUntil: "networkidle" }); };
  const panel = () => page.locator("[data-post-revision]");
  const obligation = (k) => panel().locator(`[data-obligation="${k}"]`);
  const reject = async (note, category) => {
    await page.getByLabel("Reject").fill(note);
    if (category) await page.locator(`input[name="rejection_category"][value="${category}"]`).check();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await panel().waitFor();
  };
  const reqOf = (id) => sql(`select id from post_revision_requests where post_id = '${id}' order by created_at desc limit 1`);

  // 1. The bug: an attached (uploaded) image can now be rejected as the image.
  await open(P_IMAGE);
  const choices = await page.locator("[data-rejection-category] label").allTextContents();
  assert.deepEqual(choices.map((c) => c.trim()), ["The caption", "The image", "Both"]);
  await shot("1-review-attached-image");
  const FEEDBACK = "Get rid of the blue line under the wording in the top left corner. Capitalize Siding Installation and Repair.";
  await reject(FEEDBACK, "creative");
  assert.equal((await panel().locator("[data-revision-feedback]").textContent()).trim(), FEEDBACK);
  assert.equal(await obligation("image").getAttribute("data-state"), "queued");
  assert.match(await obligation("image").textContent(), /Queued for ChatGPT.*Nothing wakes an idle ChatGPT/);
  assert.equal(await obligation("copy").getAttribute("data-state"), "not_needed");
  assert.equal(sql(`select rejection_category from social_posts where id = '${P_IMAGE}'`), "creative");
  assert.equal(sql(`select count(*) || '/' || min(status) from post_revision_outbox where post_id = '${P_IMAGE}'`), "1/pending");
  assert.equal(sql(`select count(*) from worker_fires where reason = 'Post revision request ${reqOf(P_IMAGE)}'`), "0");
  ok("An attached image is rejected as the image: one request with the exact feedback, queued for ChatGPT; nothing sent to Claude");
  await shot("2-rejected-image-queued-chatgpt");

  // 2. Caption only: rejected in the UI, the worker Routine is fired, the
  //    worker's correction lands through post-drafter, back for a fresh review.
  await open(P_CAPTION);
  assert.equal(await page.locator("[data-rejection-category]").count(), 0, "no image: only the caption can be rejected");
  await reject("Open with “Siding Installation and Repair in Wentzville” and capitalize the service name.");
  const capReq = reqOf(P_CAPTION);
  const fire = sql(`select f.id || '|' || f.client_id || '|' || (q.body->>'text') from worker_fires f join net.http_request_queue q on q.id = f.request_id where f.reason = 'Post revision request ${capReq}'`);
  assert.match(fire, new RegExp(`^\\d+\\|${C}\\|CRM event: Post revision request ${capReq} for client "Sandbox Siding" .*Run the foundation-worker skill\\.$`));
  assert.match(await obligation("copy").textContent(), /Queued for Claude.*the worker was started \(fire \d+\)/);
  await panel().locator("summary", { hasText: "Correction history" }).click();
  assert.match(await panel().locator("[data-revision-history]").textContent(), /the worker Routine was started \(fire \d+\)/);
  ok("Caption-only: the worker Routine is fired (worker_fires + the queued Routine request) and the page shows that evidence");
  await shot("3-rejected-caption-dispatched");
  // The Routine's session: claim, brief, check, submit (as the skill's playbook does).
  assert.equal(JSON.parse(sql(`select post_revision_claim('${capReq}', 'worker-routine')`)).claimed, true);
  const rb = await callDrafter({ mode: "revision_brief", client_id: C, revision_request_id: capReq, claimant: "worker-routine" });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.match(rb.body.model_request.instructions, /CORRECTION of a post a reviewer rejected/);
  const same = await callDrafter({ mode: "revision_check", client_id: C, revision_request_id: capReq, claimant: "worker-routine", brief_hash: rb.body.brief_hash, expected_copy_hash: rb.body.revision.expected_copy_hash, copy: COPY });
  assert.ok(same.body.problems.some((p) => p.code === "unchanged"), JSON.stringify(same.body));
  const chk = await callDrafter({ mode: "revision_check", client_id: C, revision_request_id: capReq, claimant: "worker-routine", brief_hash: rb.body.brief_hash, expected_copy_hash: rb.body.revision.expected_copy_hash, copy: FIXED });
  assert.equal(chk.body.ok, true, JSON.stringify(chk.body.problems));
  const sub = await callDrafter({ mode: "revision_submit", client_id: C, revision_request_id: capReq, claimant: "worker-routine", brief_hash: rb.body.brief_hash, expected_copy_hash: rb.body.revision.expected_copy_hash, copy: FIXED, runtime: "claude-worker-skill" });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.resubmitted, true);
  const again = await callDrafter({ mode: "revision_submit", client_id: C, revision_request_id: capReq, claimant: "worker-routine", brief_hash: rb.body.brief_hash, expected_copy_hash: rb.body.revision.expected_copy_hash, copy: FIXED, runtime: "claude-worker-skill" });
  assert.equal(again.status, 409, "a retry after success writes nothing");
  assert.equal(sql(`select review_status || '/' || publish_status || '/' || (approved_hash is null) || '/' || (select status from tasks where id = review_task_id) from social_posts where id = '${P_CAPTION}'`), "in_review/not_scheduled/true/open");
  await open(P_CAPTION);
  assert.equal(await panel().getAttribute("data-revision-status"), "returned");
  assert.equal(await obligation("copy").getAttribute("data-state"), "ready");
  assert.ok(await page.getByText(FIXED.slice(0, 60)).first().isVisible());
  assert.ok(await page.getByRole("button", { name: "Approve" }).isVisible(), "a fresh review: the reviewer decides");
  await panel().locator("summary", { hasText: "Correction history" }).click();
  const hist = await panel().locator("[data-revision-history]").textContent();
  for (const line of [/worker-routine claimed it/, /Claude \(AI Drafter\): corrected the caption/, /back in review for a fresh approval/]) assert.match(hist, line);
  ok("The worker's caption correction (post-drafter revision modes) returns the post for a FRESH review: not approved, not scheduled; a retry writes nothing");
  await shot("4-caption-corrected-fresh-review");

  // 3. Mixed: both obligations are kept; the caption alone leaves a draft
  //    waiting for the image; ChatGPT's image (content-approvals) completes it.
  await open(P_MIXED);
  await reject("Remove the blue line from the image, and the caption should say Siding Installation and Repair.", "both");
  const mixReq = reqOf(P_MIXED);
  assert.equal(await obligation("copy").getAttribute("data-state"), "queued");
  assert.equal(await obligation("image").getAttribute("data-state"), "queued");
  sql(`select post_revision_claim('${mixReq}', 'worker-routine')`);
  const mb = await callDrafter({ mode: "revision_brief", client_id: C, revision_request_id: mixReq, claimant: "worker-routine" });
  assert.match(mb.body.model_request.instructions, /change only the caption here/);
  const ms = await callDrafter({ mode: "revision_submit", client_id: C, revision_request_id: mixReq, claimant: "worker-routine", brief_hash: mb.body.brief_hash, expected_copy_hash: mb.body.revision.expected_copy_hash, copy: FIXED, runtime: "claude-worker-skill" });
  assert.equal(ms.status, 201, JSON.stringify(ms.body));
  assert.deepEqual(ms.body.waiting_for, ["image"]);
  await open(P_MIXED);
  assert.equal(await obligation("copy").getAttribute("data-state"), "ready");
  assert.equal(await obligation("image").getAttribute("data-state"), "queued");
  assert.equal(sql(`select review_status from social_posts where id = '${P_MIXED}'`), "draft");
  ok("Mixed feedback keeps both obligations: the caption alone leaves a draft waiting for the image");
  await shot("5-mixed-caption-done-waiting-image");
  // Executive OS picks the image work up for ChatGPT and records its receipt.
  const q = await callApprovals({ mode: "revision_queue" });
  const item = q.body.items.find((i) => i.post_id === P_MIXED);
  assert.ok(item && q.body.items.some((i) => i.post_id === P_IMAGE), JSON.stringify(q.body));
  const ack = await callApprovals({ mode: "revision_ack", outbox_id: item.outbox_id, generation: item.generation, receipt: { id: "eos-task-sandbox", handoff_id: "eos-handoff-sandbox" } });
  assert.equal(ack.status, 201, JSON.stringify(ack.body));
  assert.equal((await callApprovals({ mode: "revision_ack", outbox_id: item.outbox_id, generation: item.generation, receipt: { id: "eos-task-sandbox", handoff_id: "eos-handoff-sandbox" } })).status, 200);
  // ChatGPT stages its corrected PNG, uploads it and revises the post.
  const st = await callApprovals({ mode: "stage_media", operation_id: "ui-stage-mixed-1", client_id: C, post: { channel: "google_business", id: P_MIXED },
    file: { sha256: PNG_SHA, size_bytes: PNG.length, mime_type: "image/png", width: 640, height: 480, file_name: "siding-fixed.png" } });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  files.set(st.body.stage.storage_path, PNG);
  admin(`insert into storage.objects (bucket_id, name, metadata) values ('brand-assets', '${st.body.stage.storage_path}', '{"size": ${PNG.length}}')`);
  const rv = await callApprovals({ mode: "revise", operation_id: "ui-revise-mixed-1", client_id: C,
    post: { channel: "google_business", id: P_MIXED, service_id: SVC, review_hash: item.review_hash, destination: item.destination },
    change: { kind: "replace_media", stage_id: st.body.stage.id, sha256: PNG_SHA, label: "Siding graphic (no underline)", provenance: "AI-edited illustrative graphic; non-evidentiary (sandbox)." },
    executor: { channel: "chatgpt", executed_by: "ChatGPT via Executive OS", account_email: TEAM.email },
    authority: { kind: "owner_approval", id: "approval-sandbox", channels: ["google_business"], service_ids: [SVC], operations: ["replace_media"] },
    reason: "Corrected image for the rejection feedback." });
  assert.equal(rv.status, 201, JSON.stringify(rv.body));
  assert.equal(rv.body.receipt.result.revision.resubmitted, true);
  await open(P_MIXED);
  assert.equal(await panel().getAttribute("data-revision-status"), "returned");
  assert.equal(await obligation("image").getAttribute("data-state"), "ready");
  assert.ok(await page.getByRole("button", { name: "Approve" }).isVisible());
  await panel().locator("summary", { hasText: "Correction history" }).click();
  const mh = await panel().locator("[data-revision-history]").textContent();
  assert.match(mh, /Executive OS picked it up for ChatGPT \(receipt eos-task-sandbox\)/);
  assert.match(mh, /ChatGPT via Executive OS: corrected the image/);
  assert.equal(sql(`select approved_hash is null and publish_status = 'not_scheduled' from social_posts where id = '${P_MIXED}'`), "t");
  ok("ChatGPT's corrected image (revision_queue → revision_ack → stage_media → revise) completes the mixed correction and the post returns for a fresh review");
  await shot("6-mixed-corrected-fresh-review");

  // 4. Misclassified (as on Lucas), corrected in the UI; then an unchanged
  //    resubmission is refused and the feedback stays.
  await open(P_UNCHANGED);
  await reject("Get rid of the blue line.", "copy");
  await panel().locator("#revision_category").selectOption("creative");
  await panel().locator("[data-revision-reclassify] textarea").fill("The blue line is on the image, not the caption.");
  await panel().getByRole("button", { name: "Change category" }).click();
  await page.waitForFunction(() => document.querySelector('[data-obligation="image"]')?.getAttribute("data-state") === "queued");
  assert.match(await panel().textContent(), /What was rejected: Image \(first recorded as caption\)/);
  assert.equal(sql(`select string_agg(kind || ':' || coalesce(to_value, ''), ',' order by id) from post_events where post_id = '${P_UNCHANGED}' and kind like 'rejection_%'`), "rejection_classified:copy,rejection_reclassified:creative");
  ok("A misclassified rejection is corrected with a note; the original classification stays in history");
  page.once("dialog", (d) => d.accept());
  await panel().locator('[data-revision-action="reopen_manual"]').click();
  await page.getByRole("button", { name: "Submit for review" }).waitFor();
  assert.equal(sql(`select mode from post_revision_requests where post_id = '${P_UNCHANGED}'`), "manual");
  assert.equal(sql(`select status from post_revision_outbox where post_id = '${P_UNCHANGED}'`), "cancelled");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("alert").filter({ hasText: /The rejection feedback is not addressed: the image is unchanged/ }).waitFor();
  assert.equal(sql(`select review_status from social_posts where id = '${P_UNCHANGED}'`), "draft");
  assert.equal((await panel().locator("[data-revision-feedback]").textContent()).trim(), "Get rid of the blue line.");
  ok("Reopen to edit by hand stops the automatic correction; an unchanged resubmission is refused and the feedback stays visible");
  await shot("7-unchanged-resubmit-refused");
  // A teammate may record that the image needs no change; then it can go back.
  await panel().locator('[data-revision-resolve="image"] textarea').fill("Checked at full size: there is no underline.");
  await panel().locator('[data-revision-resolve="image"]').getByRole("button", { name: "Record" }).click();
  await page.waitForFunction(() => document.querySelector('[data-obligation="image"]')?.getAttribute("data-state") === "resolved");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve" }).waitFor();
  assert.equal(sql(`select status from post_revision_requests where post_id = '${P_UNCHANGED}'`), "returned");
  ok("An attributed “no change needed” lets the post go back for review; nothing is approved");

  // 5. Caption edit on the review screen: one step, fresh review, media kept.
  await open(P_EDIT);
  await page.locator("[data-edit-caption] summary").click();
  await page.getByLabel("Caption").fill(FIXED);
  await page.getByRole("button", { name: "Save caption" }).click();
  await page.getByText("Saved and sent back for a fresh review.").waitFor();
  assert.equal(sql(`select review_status || '/' || (copy = $$${FIXED}$$) || '/' || (approved_hash is null) from social_posts where id = '${P_EDIT}'`), "in_review/true/true");
  assert.equal(sql(`select string_agg(kind, ',' order by id) from post_events where post_id = '${P_EDIT}' and kind in ('withdrawn', 'edited', 'submitted') and actor_kind = 'team'`), "withdrawn,edited,submitted");
  ok("Edit caption on the review screen: withdraw, change only the caption and resubmit in one step; a fresh review");
  await shot("8-edit-caption-review");

  assert.deepEqual(errors, [], "no page errors");
  console.log(`\n${checks.length} checks passed.`);
} catch (e) {
  console.error(logs.slice(-3000));
  throw e;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
