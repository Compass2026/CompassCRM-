// Web Page Drafter v1, end to end in the browser (0069 on 0067's drafts and
// the content-drafter function): Planner → Generate page draft (type, new or
// refresh) → the worker writes it through the deployed handler and store →
// review (reject, revise, edit, submit) → Approve → ONE change_log row
// (page_added / page_rewrite) → Copy / Download → reopen / regenerate /
// re-approve updates the same row. Drafts never create a change_log row.
// Run by `npm run test:page-drafter-ui` (scripts/test-tasks-ui.sh with
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
import { GOOD_PAGE, SITE as LUCAS_SITE } from "./fixtures/blog-lucas.mjs";

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
const C = "00000000-0000-4000-b000-0000000000f7";
const ROOF = "00000000-0000-4000-e000-0000000000f7";
const KW = "00000000-0000-4000-d000-0000000000f7";
const OC = "00000000-0000-4000-f000-0000000000f7";
const ITEM = "00000000-0000-4000-c300-0000000000f7";
const ITEM_REFRESH = "00000000-0000-4000-c300-0000000000f8";
const SITE = "https://roof-pages.example.test";
const PAGE = `${SITE}/services/roof-replacement`;
const W = currentWeek();
const swap = (v) => JSON.parse(JSON.stringify(v).replaceAll(LUCAS_SITE, SITE).replaceAll("Lucas Construction", "Sandbox Pages")
  .replaceAll("(636) 459-9328", "(636) 555-0177"));
const page = (over = {}) => ({ ...swap(GOOD_PAGE), claim_ids: [OC], ...over });
sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
     values ('${C}', 'Sandbox Pages', 'Wentzville', 'MO', '(636) 555-0177', '${SITE}', 'service_area', 'Wentzville and nearby, Missouri', 'active')`);
sql(`update client_brands set positioning = 'Wentzville roofing contractor serving Wentzville and surrounding communities.',
       voice_tone = 'Warm, straight-talking and local. Never state or imply prices.',
       audience = 'Homeowners in Wentzville who need roofing work.', differentiators = 'One local company from inspection and estimate to final sign-off',
       ai_guidance = 'Use only sourced or confirmed claims.', words_we_use = array['local', 'straightforward'],
       words_we_avoid = array['storm chaser', 'cheapest'], content_pillars = array['Roof replacement'], tagline = 'Local roofs, done plainly.'
     where client_id = '${C}'`);
sql(`insert into brand_boards (client_id, version, status, standing_cta, hard_rules) values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.'])`);
sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, service_id, target_url, priority)
     values ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, '${ROOF}', '${PAGE}', 'p1')`);
sql(`insert into claims (id, client_id, claim, status, source) values
     ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/7')`);
sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
sql(`insert into page_groups (client_id, name, page_type, status, target_url, supporting_keyword_ids) values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '{}')`);
sql(`insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, target_url, planned_date) values
     ('${ITEM}', '${C}', '${W}', 'web_page', 'service', 'Roof replacement in Wentzville', 'commercial', '${KW}', '${ROOF}', null, '${addDays(W, 3)}')`);

const port = Number(process.env.PAGE_UI_PORT ?? 3436);
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
async function workerWrites(draftId, over = {}) {
  const b = await worker({ mode: "brief", draft_id: draftId });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.brief.kind, "page");
  const draft = page(over);
  const c = await worker({ mode: "check", draft_id: draftId, brief_hash: b.body.brief_hash, draft });
  assert.equal(c.body.ok, true, JSON.stringify(c.body.problems));
  const s = await worker({ mode: "submit", draft_id: draftId, brief_hash: b.body.brief_hash, draft, runtime: "claude-worker-skill" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  return s.body;
}
const db = (q) => sql(q);
const changes = () => db(`select count(*) from change_log where client_id = '${C}'`);

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
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  pg.on("dialog", (d) => d.accept());

  // 1. Planner → Generate page draft (service page, new).
  await pg.goto(`${base}/clients/${C}/planner?week=${W}`, { waitUntil: "networkidle" });
  const item = pg.locator(`[data-plan-item="${ITEM}"]`);
  assert.ok(await item.locator('[data-generate-page] option[value="page_rewrite"]').isDisabled(), "no target page → no refresh");
  await item.locator("[data-generate-page] select[name=page_type]").selectOption("service");
  await item.locator("[data-generate-page] input[name=note]").fill("Lead with what the homeowner gets");
  await item.getByRole("button", { name: "Generate page draft" }).click();
  await pg.waitForURL(/\/drafts\//);
  const draftId = pg.url().match(/drafts\/([0-9a-f-]{36})/)[1];
  await pg.locator("[data-draft-waiting]").waitFor();
  assert.equal(db(`select deliverable||'/'||page_type||'/'||page_change||'/'||status from content_drafts where id = '${draftId}'`), "web_page/service/page_added/requested");
  assert.equal(changes(), "0");
  ok("Planner → Generate page draft (service, new) opens a requested page draft; no change_log row");

  // 2. The worker writes it; the page shows its URL, objective, sections and JSON-LD.
  await workerWrites(draftId);
  await pg.reload({ waitUntil: "networkidle" });
  assert.equal(await pg.locator("[data-draft-status]").innerText(), "In review");
  assert.equal(await pg.locator("[data-page-url]").innerText(), `${SITE}/services/roof-replacement-wentzville`);
  assert.match(await pg.locator("[data-page-objective]").innerText(), /Help Wentzville homeowners/);
  assert.match(await pg.locator("[data-structured-data]").innerText(), /"@type": "Service"[\s\S]*Sandbox Pages/);
  assert.match(await pg.locator("[data-markdown-preview]").innerText(), /What a roof replacement involves[\s\S]*How we work/);
  assert.equal(changes(), "0", "review creates no change_log row");
  ok("The worker's page arrives in review with its proposed URL, objective, sections, copy and JSON-LD; still no change_log row");

  // 3. Reject → revise → edit (objective + JSON-LD) → submit → approve: ONE page_added row.
  await pg.locator("#reject_note").fill("Say who it is for");
  await pg.getByRole("button", { name: "Reject" }).click();
  await pg.getByText(/Rejected by .*Say who it is for/).waitFor();
  assert.equal(changes(), "0", "a rejection creates no row");
  await pg.getByRole("button", { name: "Revise" }).click();
  await pg.locator("[data-edit-draft]").waitFor();
  await pg.locator("#d_obj").fill("Help Wentzville homeowners planning a new roof understand the process and request a quote.");
  const sd = JSON.parse(await pg.locator("#d_sd").inputValue());
  sd.areaServed = "Wentzville";
  await pg.locator("#d_sd").fill(JSON.stringify(sd, null, 2));
  await pg.getByRole("button", { name: "Save changes" }).click();
  await pg.getByText("Saved.").waitFor();
  await pg.getByRole("button", { name: "Submit for review" }).click();
  await pg.locator('[data-draft-status]:text("In review")').waitFor();
  await pg.getByRole("button", { name: "Approve" }).click();
  await pg.locator("[data-draft-approved]").waitFor();
  assert.match(await pg.locator("[data-final-change]").innerText(), /new page in the change log \(approved\)/);
  const [row] = db(`select id||'|'||change_type||'|'||status||'|'||object_id||'|'||(after->>'url')||'|'||reasoning from change_log where client_id = '${C}'`).split("\n");
  const [changeId, ...rest] = row.split("|");
  assert.deepEqual(rest, ["page_added", "approved", draftId, `${SITE}/services/roof-replacement-wentzville`,
    "Help Wentzville homeowners planning a new roof understand the process and request a quote."]);
  assert.equal(db(`select final_change_log_id from content_drafts where id = '${draftId}'`), changeId);
  ok("Reject (no row) → Revise → Edit objective and JSON-LD → Submit → Approve: ONE change_log row, page_added, approved, the URL and objective");

  // 4. The planner counts it; Download carries the page.
  await pg.goto(`${base}/clients/${C}/planner?week=${W}`, { waitUntil: "networkidle" });
  assert.equal(await item.locator("[data-plan-status]").getAttribute("data-plan-status"), "approved");
  assert.deepEqual(await pg.locator('[data-slot-strip] [data-slot="web_page"] [data-slot-count]').allInnerTexts(), ["1/1"]);
  const md = await (await pg.request.get(`${base}/clients/${C}/drafts/${draftId}/markdown?download=1`)).text();
  assert.match(md, /\nurl_path: "\/services\/roof-replacement-wentzville"\npage_type: "service"\nchange: "new page"\nobjective: "Help Wentzville homeowners planning/);
  assert.equal(JSON.parse(md.match(/\nstructured_data: (.+)\n/)[1]).areaServed, "Wentzville");
  ok("The planner counts the approved page (Web Pages 1/1); Download .md carries the URL path, type, objective and JSON-LD");

  // 5. Reopen → the row goes back to proposed and the slot stops counting; regenerate → approve: the same row.
  await pg.goto(`${base}/clients/${C}/drafts/${draftId}`, { waitUntil: "networkidle" });
  await pg.getByRole("button", { name: "Reopen (clears approval)" }).click();
  await pg.locator('[data-draft-status]:text("Draft")').waitFor();
  assert.equal(db(`select status from change_log where id = '${changeId}'`), "proposed");
  await pg.goto(`${base}/clients/${C}/planner?week=${W}`, { waitUntil: "networkidle" });
  assert.deepEqual(await pg.locator('[data-slot-strip] [data-slot="web_page"] [data-slot-count]').allInnerTexts(), ["0/1"]);
  await pg.goto(`${base}/clients/${C}/drafts/${draftId}`, { waitUntil: "networkidle" });
  await pg.locator("#regen_note").fill("Add a short section on the final walkthrough");
  await pg.getByRole("button", { name: "Regenerate" }).click();
  await pg.locator("[data-draft-waiting]").waitFor();
  assert.equal(changes(), "1");
  await workerWrites(draftId, { title: "Roof replacement in Wentzville, start to finish" });
  await pg.reload({ waitUntil: "networkidle" });
  await pg.getByRole("button", { name: "Approve" }).click();
  await pg.locator("[data-draft-approved]").waitFor();
  assert.equal(db(`select count(*)||'|'||max(status::text)||'|'||max(after->>'title') from change_log where client_id = '${C}'`),
    "1|approved|Roof replacement in Wentzville, start to finish");
  ok("Reopen → the row back to proposed and Web Pages 0/1 → Regenerate → the worker rewrites → Approve: the same row, approved; still one");

  // 6. A refresh of the existing service page: page_rewrite naming it.
  sql(`insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, target_url)
       values ('${ITEM_REFRESH}', '${C}', '${addDays(W, 7)}', 'web_page', 'service', 'Refresh the roof replacement page', 'commercial', '${KW}', '${ROOF}', '${PAGE}')`);
  await pg.goto(`${base}/clients/${C}/planner?week=${addDays(W, 7)}`, { waitUntil: "networkidle" });
  const refresh = pg.locator(`[data-plan-item="${ITEM_REFRESH}"]`);
  await refresh.locator("[data-generate-page] select[name=page_change]").selectOption("page_rewrite");
  await refresh.getByRole("button", { name: "Generate page draft" }).click();
  await pg.waitForURL(/\/drafts\//);
  const refreshId = pg.url().match(/drafts\/([0-9a-f-]{36})/)[1];
  const moved = await worker({ mode: "check", draft_id: refreshId, brief_hash: (await worker({ mode: "brief", draft_id: refreshId })).body.brief_hash, draft: page() });
  assert.ok(moved.body.problems.some((p) => p.code === "refresh_moves_page"), "a refresh keeps its URL");
  await workerWrites(refreshId, { page_path: "/services/roof-replacement", slug: "roof-replacement" });
  await pg.reload({ waitUntil: "networkidle" });
  await pg.getByRole("button", { name: "Approve" }).click();
  await pg.locator("[data-draft-approved]").waitFor();
  assert.match(await pg.locator("[data-final-change]").innerText(), /page refresh in the change log \(approved\)/);
  assert.equal(db(`select change_type||'|'||(before->>'url')||'|'||(after->>'url') from change_log where object_id = '${refreshId}'`),
    `page_rewrite|${PAGE}|${SITE}/services/roof-replacement`);
  assert.equal(changes(), "2");
  ok("A refresh of the existing page keeps its URL and finalizes to ONE page_rewrite row naming it");

  // 7. Access and layout.
  const pctx = await contextFor(browser, PORTAL, { width: 1280, height: 900 });
  const pp = await pctx.newPage();
  await pp.goto(`${base}/clients/${C}/drafts/${draftId}`, { waitUntil: "networkidle" });
  assert.ok(!(await pp.content()).includes("start to finish"), "a portal contact sees no draft");
  await pctx.close();
  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  for (const path of [`/clients/${C}/drafts/${draftId}`, `/clients/${C}/planner?week=${W}`]) {
    await mp.goto(`${base}${path}`, { waitUntil: "networkidle" });
    assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path);
  }
  await mctx.close();
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/page-draft.png`, fullPage: true });
  ok("A portal contact sees no page draft; phone width has no horizontal scroll");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.deepEqual(unexpected, [], `calls outside the sandbox: ${unexpected.join(" | ")}`);
  ok("No page errors; no calls outside the sandbox; nothing published");
  console.log(`Page drafter browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
