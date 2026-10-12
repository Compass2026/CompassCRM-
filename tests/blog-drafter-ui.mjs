// Blog Drafter v1, end to end in the browser (0066 + 0067 and the
// content-drafter function): Planner → Generate draft → the worker writes it
// through the deployed handler and store → review (reject, revise, edit,
// submit) → Approve → ONE final content_posts row → Copy / Download Markdown
// → reopen / regenerate / re-approve updates the same row.
// Run by `npm run test:blog-drafter-ui` (scripts/test-tasks-ui.sh with
// UI_SPEC set): `next dev` against a Postgres replay behind PostgREST; the
// worker's calls go to the real content-drafter handler over a service-role
// client, so its write arrives as 0067's drafter session. Fictional client.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createContentDrafter } from "../supabase/functions/content-drafter/handler.ts";
import { createStore } from "../supabase/functions/content-drafter/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };
import { currentWeek, addDays } from "../src/lib/content-planner.ts";
import { GOOD_BLOG, PAGE as LUCAS_PAGE } from "./fixtures/blog-lucas.mjs";

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

// The worker: the deployed handler and store, called with the cron secret.
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const drafter = createContentDrafter({ store: createStore(service), gazetteer });
const worker = async (body) => {
  const r = await drafter.handle(new Request("http://x/content-drafter", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

// ── Fixtures: the drafter integration's fictional roofing client ────────────
const C = "00000000-0000-4000-b000-0000000000e1";
const ROOF = "00000000-0000-4000-e000-0000000000e1";
const KW = "00000000-0000-4000-d000-0000000000e1";
const OC = "00000000-0000-4000-f000-0000000000e1";
const ITEM = "00000000-0000-4000-c300-0000000000e1";
const SITE = "https://roof.example.test";
const PAGE = `${SITE}/services/roof-replacement`;
const W = currentWeek();
const article = (over = {}) => JSON.parse(JSON.stringify({
  ...GOOD_BLOG,
  body_markdown: GOOD_BLOG.body_markdown.replaceAll(LUCAS_PAGE, PAGE).replaceAll("Lucas Construction", "Sandbox Roofing"),
  internal_links: [{ url: PAGE, anchor: "roof replacement", reason: "The service the article is about." }],
  cta: { text: "Request a quote", url: PAGE },
  claim_ids: [OC],
  ...over,
}));
sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
     values ('${C}', 'Sandbox Roofing', 'Wentzville', 'MO', '(636) 555-0142', '${SITE}', 'service_area', 'Wentzville and nearby, Missouri', 'active')`);
sql(`update client_brands set positioning = 'Wentzville roofing contractor serving Wentzville and surrounding communities.',
       voice_tone = 'Warm, straight-talking and local. Never state or imply prices.',
       audience = 'Homeowners in Wentzville who need roofing work.', differentiators = 'One local company from inspection and estimate to final sign-off',
       ai_guidance = 'Use only sourced or confirmed claims.', words_we_use = array['local', 'straightforward'],
       words_we_avoid = array['storm chaser', 'cheapest'], content_pillars = array['Roof replacement'], tagline = 'Local roofs, done plainly.'
     where client_id = '${C}'`);
sql(`insert into brand_boards (client_id, version, status, standing_cta, hard_rules)
     values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.'])`);
sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, service_id, target_url, priority)
     values ('${KW}', '${C}', 'how long does a roof last', 'informational', true, true, '${ROOF}', '${PAGE}', 'p3')`);
sql(`insert into claims (id, client_id, claim, status, source) values
     ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/1')`);
sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
sql(`insert into page_groups (client_id, name, page_type, status, target_url, supporting_keyword_ids) values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '{}')`);
sql(`insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, planned_date)
     values ('${ITEM}', '${C}', '${W}', 'blog', 'educational', 'How long does a roof last', 'informational', '${KW}', '${ROOF}', '${addDays(W, 2)}')`);

const port = Number(process.env.BLOG_UI_PORT ?? 3435);
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
// The worker's loop: brief → check → submit, as the playbook does it.
async function workerWrites(draftId, over = {}) {
  const b = await worker({ mode: "brief", draft_id: draftId });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const draft = article(over);
  const c = await worker({ mode: "check", draft_id: draftId, brief_hash: b.body.brief_hash, draft });
  assert.equal(c.body.ok, true, JSON.stringify(c.body.problems));
  const s = await worker({ mode: "submit", draft_id: draftId, brief_hash: b.body.brief_hash, draft, runtime: "claude-worker-skill" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  return s.body;
}
const db = (q) => sql(q);

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

  // 1. Planner → Generate draft.
  await page.goto(`${base}/clients/${C}/planner?week=${W}`, { waitUntil: "networkidle" });
  const item = page.locator(`[data-plan-item="${ITEM}"]`);
  await item.locator("[data-generate-draft] input[name=note]").fill("Keep it practical for first-time homeowners");
  await item.getByRole("button", { name: "Generate draft" }).click();
  await page.waitForURL(/\/drafts\//);
  const draftId = page.url().match(/drafts\/([0-9a-f-]{36})/)[1];
  await page.locator("[data-draft-waiting]").waitFor();
  assert.equal(db(`select status||'/'||request_note||'/'||topic from content_drafts where id = '${draftId}'`), "requested/Keep it practical for first-time homeowners/How long does a roof last");
  assert.equal(db(`select owner||'/'||status from tasks where key = 'content_draft:${draftId}'`), "CLAUDE/open");
  assert.equal(db(`select count(*) from content_posts where client_id = '${C}'`), "0");
  ok("Planner → Generate draft opens a requested draft (with the note), a CLAUDE task, and no content_posts row");

  // 2. The worker writes it (brief → check → submit).
  const written = await workerWrites(draftId);
  assert.equal(written.status, "in_review");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-draft-status]").innerText(), "In review");
  assert.match(await page.locator("[data-draft-h1]").innerText(), /How long does a roof last\?/);
  assert.match(await page.locator("[data-markdown-preview]").innerText(), /What wears a roof out[\s\S]*roof replacement/);
  assert.equal(await page.locator("[data-markdown-preview] a").first().getAttribute("href"), PAGE);
  assert.match(await page.locator("[data-draft-claims]").innerText(), /Owens Corning Preferred Contractor[\s\S]*Source: https:\/\/manufacturer[\s\S]*Grounding checks pass/);
  assert.equal(db(`select status from tasks where key = 'content_draft:${draftId}'`), "done");
  ok("The worker's draft arrives in review: title, H1, outline, body preview, internal link, claims with sources; the request closes");

  // 3. Copy and Download Markdown.
  assert.equal(await page.locator("[data-copy-markdown]").count(), 1);
  const md = await page.request.get(`${base}/clients/${C}/drafts/${draftId}/markdown?download=1`);
  assert.equal(md.status(), 200);
  assert.match(md.headers()["content-disposition"], /^attachment; filename="how-long-does-a-roof-last\.md"$/);
  const text = await md.text();
  assert.match(text, /^---\ntitle: ".+"\nslug: "how-long-does-a-roof-last"\nmeta_title: ".+"\nmeta_description: ".+"\nprimary_keyword: "how long does a roof last"\n---\n\n# How long does a roof last\?\n\n## What wears a roof out/);
  assert.ok(text.trimEnd().endsWith(`[Request a quote](${PAGE})`));
  ok("Copy Markdown and Download .md (front matter, H1, body, CTA)");

  // 4. Reject, revise, edit, submit.
  await page.locator("#reject_note").fill("Open with the answer");
  await page.getByRole("button", { name: "Reject" }).click();
  await page.getByText(/Rejected by .*Open with the answer/).waitFor();
  await page.getByRole("button", { name: "Revise" }).click();
  await page.locator("[data-edit-draft]").waitFor();
  await page.locator("#d_title").fill("How long does a roof last? A plain answer for Wentzville homeowners");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Saved.").waitFor();
  assert.equal(db(`select status||'/'||version||'/'||author_kind from content_drafts where id = '${draftId}'`), "draft/2/team");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.locator('[data-draft-status]:text("In review")').waitFor();
  ok("Reject (with a note) → Revise → Edit (version 2, the team's) → Submit for review");

  // 5. Approve → ONE final content_posts row; the planner follows.
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator("[data-draft-approved]").waitFor().catch(async (e) => {
    throw new Error(`${e.message}\n${await page.locator("[role=alert]").allInnerTexts()}`);
  });
  assert.match(await page.locator("[data-draft-approved]").innerText(), /Final article: How long does a roof last\? A plain answer/);
  const [post] = db(`select id||'|'||status||'|'||title||'|'||origin||'|'||due_date from content_posts where client_id = '${C}'`).split("\n");
  const [postId, ...rest] = post.split("|");
  assert.deepEqual(rest, ["approved", "How long does a roof last? A plain answer for Wentzville homeowners", "compass", addDays(W, 2)]);
  assert.equal(db(`select status||'/'||approved_version||'/'||final_content_post_id from content_drafts where id = '${draftId}'`), `approved/2/${postId}`);
  assert.equal(db(`select content_post_id from content_plan_items where id = '${ITEM}'`), postId);
  await page.goto(`${base}/clients/${C}/planner?week=${W}`, { waitUntil: "networkidle" });
  assert.equal(await item.locator("[data-plan-status]").getAttribute("data-plan-status"), "approved");
  assert.deepEqual(await page.locator('[data-slot-strip] [data-slot="blog"] [data-slot-count]').allInnerTexts(), ["1/2"]);
  await page.goto(`${base}/clients/${C}/content`, { waitUntil: "networkidle" });
  assert.match(await page.locator("main").innerText(), /How long does a roof last\? A plain answer[\s\S]*approved/);
  ok("Approve creates ONE content_posts row (approved, Compass, the planned date); the plan item links it; Blogs 1/2");

  // 6. Reopen → regenerate → the worker writes again → approve: the same row.
  await page.goto(`${base}/clients/${C}/drafts/${draftId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Reopen (clears approval)" }).click();
  await page.locator('[data-draft-status]:text("Draft")').waitFor();
  await page.locator("#regen_note").fill("Add a section on attic ventilation");
  await page.getByRole("button", { name: "Regenerate" }).click();
  await page.locator("[data-draft-waiting]").waitFor();
  assert.equal(db(`select status||'/'||request_note from content_drafts where id = '${draftId}'`), "requested/Add a section on attic ventilation");
  await workerWrites(draftId, { title: "How long does a roof last? Ventilation, weather and planning ahead" });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator('[data-draft-status]:text("Approved")').waitFor();
  assert.equal(db(`select count(*)||'/'||max(title) from content_posts where client_id = '${C}'`), "1/How long does a roof last? Ventilation, weather and planning ahead");
  assert.equal(db(`select final_content_post_id from content_drafts where id = '${draftId}'`), postId);
  ok("Reopen → Regenerate (with a note) → the worker rewrites → Approve: the same final row, updated; still one");

  // 7. Access and layout.
  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const pr = await pctx.request.get(`${base}/clients/${C}/drafts/${draftId}/markdown`, { maxRedirects: 0 });
  assert.ok(pr.status() !== 200 || !(await pr.text()).includes("How long"), `portal: ${pr.status()}`);
  const pp = await pctx.newPage();
  await pp.goto(`${base}/clients/${C}/drafts/${draftId}`, { waitUntil: "networkidle" });
  assert.ok(!(await pp.content()).includes("Ventilation, weather"), "a portal contact sees no draft");
  await pctx.close();
  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  await mp.goto(`${base}/clients/${C}/drafts/${draftId}`, { waitUntil: "networkidle" });
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mctx.close();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/blog-draft.png`, fullPage: true });
  ok("A portal contact sees no draft or Markdown; phone width has no horizontal scroll");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.deepEqual(unexpected, [], `calls outside the sandbox: ${unexpected.join(" | ")}`);
  ok("No page errors; no calls outside the sandbox; nothing published");
  console.log(`Blog drafter browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
