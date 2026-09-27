// Browser acceptance check for Draft with AI on the Authority tab (0053 +
// post-drafter v2). Run by `npm run test:authority-draft-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, `next dev` and Chromium. The worker is simulated by calling the
// real post-drafter handler (the same brief → check → submit the skill runs);
// the Routine fire goes to the sandbox's stubbed net.http_post (recorded,
// never sent). Nothing leaves the machine; nothing is published.
//
//   SCREENSHOTS=docs/screenshots/authority npm run test:authority-draft-ui
//
// Fictional client ("Draft Roofing", example.test addresses).
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore } from "../supabase/functions/post-drafter/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const users = new Map([[TEAM.id, TEAM]]);
const C = "00000000-0000-4000-b000-0000000000f1";
const ROOF = "00000000-0000-4000-e000-0000000000f1";
const KT = "00000000-0000-4000-d000-0000000000f1";
const KC = "00000000-0000-4000-d000-0000000000f2";
const OC = "00000000-0000-4000-f000-0000000000f1";
const WARRANTY = "00000000-0000-4000-f000-0000000000f2";
const SITE = "https://draft.example.test";
const PAGE = `${SITE}/services/roof-replacement`;
const TX = `gbp_post:${ROOF}:transactional`;
const CM = `gbp_post:${ROOF}:commercial`;
const COPY_A =
  "Ready to replace an aging roof on your Wentzville home? Draft Roofing keeps roof replacement straightforward, from the " +
  "first inspection to an estimate you can plan around. We're an Owens Corning Preferred Contractor, and every roof " +
  "replacement we complete is backed by our Lifetime Workmanship Warranty. When you're ready, request a quote and we'll " +
  "set up a time to look at your roof together.";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
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

const unexpected = [];
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (url.pathname === "/auth/v1/user") {
    const claims = verify(bearer);
    const u = claims?.sub && users.get(claims.sub);
    res.writeHead(u ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(u ? { ...u, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
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
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const asTeam = createClient(gatewayUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${tokenFor(TEAM)}` } } });
const drafter = createPostDrafter({ store: createStore(service), gazetteer });
const worker = async (body) => {
  const r = await drafter.handle(new Request("http://x/post-drafter", { method: "POST", headers: { "x-cron-secret": "cron" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

const port = Number(process.env.AUTHORITY_UI_PORT ?? 3427);
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

const page1 = (p) => ({ url: SITE + p, status: 200, final_url: SITE + p, final_status: 200, redirect_loop: false, in_sitemap: true, title: null, h1: null, h2: [], canonical: null, words: 300, text: "x" });
const gbp = (intent, keyword, kwText, over = {}) => ({
  id: `gbp_post:roof-replacement:${intent}`, key: `gbp_post:${ROOF}:${intent}`, section: "ready", action: "create", tier: "B",
  content_type: "gbp_post", topic: "Roof Replacement", service_id: ROOF, objective: "Help homeowners ready to act take the next step.",
  order: [1], eligible_from: null, gap: `No ${intent} Business Profile post for Roof Replacement.`,
  target: { keyword_id: keyword, keyword: kwText, intent, location: null, owner_path: "/services/roof-replacement", cta: "LEARN_MORE" },
  evidence_claim_ids: [OC], existing_coverage: [], blockers: [], gates: [], reasons: [{ tag: "FACT", text: "No recent post." }], provenance: { FACT: [], HEURISTIC: [], RESEARCH_REQUIRED: [], REQUIRES_CONFIRMATION: [] },
  ...over,
});
async function analysis() {
  const { data: run, error: e1 } = await service.rpc("authority_begin_run", { p_client_id: C, p_mode: "refresh", p_requested_via: "worker" });
  assert.equal(e1, null, e1?.message);
  const { data: fp } = await service.rpc("authority_fingerprint", { p_client_id: C });
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await service.rpc("authority_record_run", { p_run_id: run, p: {
    status: "completed", engine_version: "authority-v1.3", judged_at: new Date().toISOString(), as_of: today,
    input_hash: "sha256:" + "f1".repeat(32), section_hashes: fp,
    inventory: { fetched_at: new Date().toISOString(), site: SITE, pages: [page1("/"), page1("/services/roof-replacement")] }, inventory_errors: 0,
    report: { client: { id: C }, as_of: today, sources: {}, keywords: [], pillars: [],
      opportunities: [gbp("transactional", KT, "roof quote draft"), gbp("commercial", KC, "roof replacement draft", { eligible_from: "2099-01-01" })] },
  } });
  assert.equal(error, null, error?.message);
  return run;
}
const opp = (key) => JSON.parse(sql(`select row_to_json(o) from (select o.id, o.status, s.effective_status from authority_opportunities o join authority_opportunity_state s on s.id = o.id where o.client_id = '${C}' and o.key = '${key}') o`));
const requests = () => JSON.parse(sql(`select coalesce(json_agg(json_build_object('id', id, 'status', status) order by created_at), '[]') from tasks where client_id = '${C}' and key like 'authority\\_draft:%'`));
const fires = () => Number(sql(`select count(*) from worker_fires where client_id = '${C}' and reason like 'Authority draft request %'`));

let browser;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

try {
  sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
  sql(`select vault.create_secret('https://routine.example.test/fire', 'ROUTINE_FIRE_URL')`);
  sql(`select vault.create_secret('sandbox-token', 'ROUTINE_FIRE_TOKEN')`);
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Draft Roofing', 'Wentzville', 'MO', '(636) 555-0188', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  sql(`update client_brands set positioning = 'Wentzville roofing contractor.', voice_tone = 'Warm and local. Never state prices.',
       audience = 'Wentzville homeowners.', differentiators = 'One local company', ai_guidance = 'Use only sourced claims.',
       words_we_use = array['local', 'straightforward', 'inspection', 'estimate'], words_we_avoid = array['cheapest'],
       content_pillars = array['Roof replacement'], tagline = 'Local roofs.' where client_id = '${C}'`);
  sql(`insert into brand_boards (client_id, version, status, standing_cta, hard_rules) values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.'])`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority) values
       ('${KT}', '${C}', 'roof quote draft', 'transactional', true, true, true, '${ROOF}', '${PAGE}', 'p1'),
       ('${KC}', '${C}', 'roof replacement draft', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1')`);
  sql(`insert into claims (id, client_id, claim, status, source) values
       ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/3'),
       ('${WARRANTY}', '${C}', 'Lifetime Workmanship Warranty', 'sourced', '${PAGE}')`);
  sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids)
       values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KC}', '{}')`);
  const run1 = await analysis();

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
  const shot = async (name, p = page, fullPage = true) => { if (!SHOTS) return; await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }); };
  const url = `${base}/clients/${C}/authority`;
  const card = (key) => page.locator(`article[data-key="${key}"]`);
  const message = (key, re) => page.waitForFunction(([k, src]) => new RegExp(src).test(document.querySelector(`article[data-key="${k}"] [data-draft-message]`)?.textContent ?? ""), [key, re.source], { timeout: 20000 });
  const load = async () => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("details[data-group]").evaluateAll((els) => els.forEach((d) => { d.open = true; }));
  };

  // 1. Only the Ready, due Business Profile post carries the button.
  await load();
  assert.equal(await card(TX).locator("[data-open-draft]").count(), 1);
  assert.equal(await card(CM).locator("[data-draft=waiting]").count(), 1, "the commercial post is not yet due");
  assert.equal(await card(CM).locator("[data-open-draft]").count(), 0);
  assert.equal(await page.locator("[data-open-draft]").count(), 1);
  await shot("authority-draft-card-desktop");
  ok("Draft with AI shows on the Ready, due Business Profile post only; a post inside its cadence says when it is due");

  // 2. Request: one CLAUDE request task, the opportunity accepted (never linked), the worker started.
  await card(TX).locator("[data-open-draft]").click();
  await page.locator("[data-draft-dialog]").waitFor();
  await shot("authority-draft-dialog-desktop", page, false);
  await page.locator("[data-confirm-draft]").click();
  await card(TX).locator("[data-draft-message=ok]").waitFor();
  assert.match(await card(TX).locator("[data-draft-message]").innerText(), /Draft with AI requested\. The worker was started/);
  await card(TX).locator("[data-draft=requested]").waitFor();
  const [req] = requests();
  assert.equal(requests().length, 1);
  assert.equal(req.status, "open");
  assert.equal(sql(`select owner from tasks where id = '${req.id}'`), "CLAUDE");
  assert.equal(fires(), 1);
  assert.deepEqual([opp(TX).status, opp(TX).effective_status], ["accepted", "accepted"]);
  assert.equal(Number(sql(`select count(*) from authority_opportunity_links where client_id = '${C}'`)), 0);
  ok("Request: one CLAUDE request task, the opportunity accepted (not linked), the worker started once");

  // 3. Restart inside the debounce window: same request, no second fire.
  await card(TX).locator("[data-restart-draft]").click();
  await message(TX, /did not start just now/);
  assert.equal(requests().length, 1);
  assert.equal(fires(), 1);
  // …and after it (a failed or missed start): fires again, still one request.
  sql(`update worker_fires set created_at = now() - interval '11 minutes' where client_id = '${C}'`);
  await load();
  await card(TX).locator("[data-restart-draft]").click();
  await message(TX, /The worker was started/);
  assert.equal(fires(), 2);
  assert.equal(requests().length, 1);
  await shot("authority-draft-requested-desktop");
  ok("Restart: debounced inside two minutes; later it fires again for the same request — never a second request");

  // 4. The worker drafts (post-drafter v2): the card shows the post in review; the opportunity is in progress.
  const b = await worker({ mode: "brief", client_id: C, authority_opportunity_id: opp(TX).id, expected_run_id: run1 });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(b.body.request, { task_id: req.id, status: "open" });
  const s = await worker({ mode: "submit", client_id: C, authority_opportunity_id: opp(TX).id, expected_run_id: run1, brief_hash: b.body.brief_hash, draft: { copy: COPY_A, claim_ids: [OC, WARRANTY] }, runtime: "sandbox-model" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  await load();
  await card(TX).locator("[data-draft=in_review]").waitFor();
  assert.equal(await card(TX).locator("[data-draft-post]").getAttribute("href"), `/clients/${C}/social/${s.body.post_id}`);
  assert.equal(opp(TX).effective_status, "in_progress");
  assert.equal(requests()[0].status, "done");
  await shot("authority-draft-in-review-desktop");
  ok("The worker's submit links the post: the card shows the draft in review with a link to it; in progress; the request done");

  // 5. Rejected → draftable again.
  const rej = await asTeam.from("social_posts").update({ review_status: "rejected", review_note: "Try another angle." }).eq("id", s.body.post_id);
  assert.equal(rej.error, null, rej.error?.message);
  await load();
  assert.equal(await card(TX).locator("[data-open-draft]").count(), 1);
  assert.equal(opp(TX).effective_status, "accepted");
  ok("A rejected post leaves the opportunity accepted and Draft with AI available again");

  // 6. A request the worker stopped (blocked) shows why; Draft with AI again reopens the same task.
  await card(TX).locator("[data-open-draft]").click();
  await page.locator("[data-confirm-draft]").click();
  await card(TX).locator("[data-draft=requested]").waitFor();
  const second = requests().find((r) => r.status === "open");
  assert.ok(second && second.id !== req.id);
  sql(`update tasks set status = 'blocked', notes = notes || E'\\nevidence_ineligible: Authority''s evidence includes claims the Drafter does not allow.' where id = '${second.id}'`);
  await load();
  await card(TX).locator("[data-draft=blocked]").waitFor();
  assert.match(await card(TX).locator("[data-draft-blocked]").innerText(), /evidence_ineligible/);
  await shot("authority-draft-blocked-desktop");
  await card(TX).locator("[data-open-draft]").click();
  await page.locator("[data-confirm-draft]").click();
  await message(TX, /The open request was restarted/);
  assert.equal(requests().filter((r) => r.status !== "done").length, 1);
  assert.equal(sql(`select status from tasks where id = '${second.id}'`), "open");
  ok("A blocked request shows the worker's reason; Draft with AI again reopens and restarts the same request");

  // 7. Phone width: the control fits.
  const phone = await (await contextFor(browser, TEAM, { width: 390, height: 844 })).newPage();
  await phone.goto(url, { waitUntil: "networkidle" });
  await phone.locator("details[data-group]").evaluateAll((els) => els.forEach((d) => { d.open = true; }));
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal scroll (${overflow}px)`);
  await shot("authority-draft-requested-phone", phone);
  ok("Phone width: no horizontal scroll");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(sql(`select count(*) from social_posts where client_id = '${C}' and (publish_status <> 'not_scheduled' or review_status = 'approved')`), "0");
  ok("No page errors, no calls outside the sandbox, nothing approved, scheduled or published");
  console.log(`Authority Draft with AI browser checks passed (${checks.length}).`);
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
