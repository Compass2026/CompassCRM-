// Browser acceptance for the Claims registry section of the Intelligence tab
// (20261103220000). Run by `npm run test:claim-registry-ui`
// (scripts/test-tasks-ui.sh with UI_SPEC set): a real Postgres replay behind
// PostgREST, so the page reads claim_registry exactly as a signed-in teammate
// does in production. Read-only: the spec proves the section has no control
// and that loading it writes nothing. Fictional clients only (the repo is
// public). SCREENSHOTS=<dir> saves desktop and phone captures.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL_ADMIN, "run through scripts/test-tasks-ui.sh");
const SHOTS = process.env.SCREENSHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const users = new Map([[TEAM.id, TEAM]]);
// Distinct first eight characters, as random ids have (the registry reads a
// claim id's first eight characters in supersession notes).
const id = (n) => `8e${String(n).padStart(6, "0")}-0000-4000-8e00-000000000000`;
const L = id(1), M = id(2), EMPTY = id(3);

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

// ── Fixtures (triggers off, as the SQL suites load theirs) ──────────────────
sql(`set session_replication_role = replica;
insert into clients (id, name, city, state, website_url, phone, status) values
  ('${L}', 'Fictional Roofing Co', 'Springfield', 'MO', 'https://roofing.example.test', '(555) 010-0001', 'active'),
  ('${M}', 'Fictional Training Group', 'Springfield', 'MO', 'https://training.example.test', '555-010-0002', 'active'),
  ('${EMPTY}', 'Fictional Empty Co', 'Springfield', 'MO', 'https://empty.example.test', null, 'active');
insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on, created_at) values
  ('${id(11)}', '${L}', '3-Year Workmanship Warranty', 'confirmed',
   'Contract excerpt supplied by the owner. It supersedes claim ${id(12).slice(0, 8)} (lifetime).', 'owner@roofing.example.test', now() - interval '5 days', now() - interval '40 days'),
  ('${id(12)}', '${L}', 'Lifetime Workmanship Warranty', 'unverified', 'https://roofing.example.test/services/roof-replacement', null, null, now() - interval '60 days'),
  ('${id(13)}', '${L}', 'Installs architectural shingles', 'sourced', 'https://www.roofing.example.test/about', null, null, now() - interval '50 days'),
  ('${id(14)}', '${L}', 'Family-operated since 2018', 'sourced', '', null, null, now() - interval '50 days'),
  ('${id(15)}', '${L}', 'Founded 2019', 'sourced', 'web search summary of an aggregator listing', null, null, now() - interval '50 days'),
  ('${id(16)}', '${L}', 'Phone (555) 010-0001', 'sourced', 'https://www.bbb.example.test/profile/roofing', null, null, now() - interval '50 days'),
  ('${id(17)}', '${L}', 'Free roof inspections', 'confirmed', 'Confirmed by the owner on a call', 'owner@roofing.example.test', now() - interval '120 days', now() - interval '130 days'),
  ('${id(18)}', '${L}', 'A federal rule requires fall protection on roofs', 'sourced', 'https://www.osha.gov/fall-protection', null, null, now() - interval '20 days'),
  ('${id(19)}', '${L}', 'North office line (555) 010-0777', 'sourced', 'https://www.google.com/maps?cid=456', null, null, now() - interval '20 days'),
  ('${id(20)}', '${L}', 'Storm line (555) 010-0999', 'sourced', 'https://directory.example.test/roofing', null, null, now() - interval '20 days'),
  ('${id(21)}', '${M}', 'Safety audits for companies of all sizes', 'sourced', 'https://safety.training.example.test/audits', null, null, now() - interval '20 days'),
  ('${id(22)}', '${M}', 'Founded in 2014', 'sourced', 'https://safety.training.example.test/about', null, null, now() - interval '20 days'),
  ('${id(23)}', '${M}', '65+ years combined experience', 'sourced', 'https://training.example.test/', null, null, now() - interval '20 days'),
  ('${id(24)}', '${M}', 'Heavy equipment operator classes', 'sourced', 'https://heavy.training.example.test/', null, null, now() - interval '20 days');
insert into citation_locations (id, client_id, label, business_name, address_line1, city, region, postal_code, phone)
values ('${id(35)}', '${L}', 'North office', 'Fictional Roofing Co', '1 Example Way', 'Northtown', 'MO', '63000', '555.010.0777');
update citation_locations set approved_by = '${TEAM.id}' where id = '${id(35)}';
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, positioning, voice_tone, standing_cta, hard_rules,
                                     service_ids, claim_ids, asset_ids, status, approved_by, approved_at, created_at) values
  ('${id(31)}', '${M}', 'safety', 'Fictional Safety', 'https://safety.training.example.test', '555-010-0002', 'Safety', 'Clear', 'Call', array['Sourced claims only'],
   '{}', array['${id(21)}', '${id(22)}']::uuid[], '{}', 'approved', (select id from team_members where email = '${TEAM.email}'), now(), now() - interval '3 days'),
  ('${id(32)}', '${M}', 'forklift', 'Fictional Forklift', 'https://forklift.training.example.test', '555-010-0003', 'Forklift', 'Clear', 'Call', array['Sourced claims only'],
   '{}', array['${id(22)}']::uuid[], '{}', 'approved', (select id from team_members where email = '${TEAM.email}'), now(), now() - interval '2 days'),
  ('${id(33)}', '${M}', 'heavy', 'Fictional Heavy Equipment', 'https://heavy.training.example.test', '555-010-0004', 'Heavy', 'Clear', 'Call', array['Sourced claims only'],
   '{}', array['${id(24)}']::uuid[], '{}', 'draft', null, null, now() - interval '1 day');
insert into social_posts (id, client_id, platform, search_intent, copy, review_status, publish_status, reviewed_by, reviewed_at, review_note,
                          approved_snapshot, approved_hash, published_url, published_at, external_post_id, created_at) values
  ('${id(41)}', '${L}', 'google_business', 'commercial', 'We offer a Lifetime Workmanship Warranty.', 'approved', 'published',
   (select id from team_members where email = '${TEAM.email}'), now() - interval '20 days', null, '{}', 'x', 'https://local.example.test/posts/1', now() - interval '19 days', 'ext-1', now() - interval '21 days'),
  ('${id(42)}', '${L}', 'google_business', 'commercial', 'Lifetime coverage, again.', 'rejected', 'not_scheduled',
   (select id from team_members where email = '${TEAM.email}'), now() - interval '15 days', 'Wrong warranty', null, null, null, null, null, now() - interval '16 days');
insert into post_claims (post_id, client_id, claim_id) values ('${id(41)}', '${L}', '${id(12)}'), ('${id(42)}', '${L}', '${id(12)}');
insert into content_drafts (id, client_id, deliverable, topic, status, title, body_markdown, created_at)
select ('8e0005' || lpad(i::text, 2, '0') || '-0000-4000-8e00-000000000000')::uuid, '${L}', 'blog', 'Topic ' || i, 'in_review',
       (array['Questions to ask about the shingles on your quote', 'What a written roofing estimate should cover', 'What happens on roof replacement day'])[i],
       'We offer a Lifetime Workmanship Warranty.', now() - make_interval(days => 15 - i)
  from generate_series(1, 3) i;
insert into content_draft_claims (draft_id, client_id, claim_id)
select ('8e0005' || lpad(i::text, 2, '0') || '-0000-4000-8e00-000000000000')::uuid, '${L}', '${id(12)}' from generate_series(1, 3) i;`);

const fingerprint = () => sql(`select md5(string_agg(t || ':' || n, ',' order by t)) from (
  select 'claims' t, count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) n from claims
  union all select 'posts', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from social_posts
  union all select 'drafts', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from content_drafts
  union all select 'events', count(*) || '/' || coalesce(sum(xmin::text::bigint), 0) from creative_governance_events) x`);
const before = fingerprint();

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

const port = Number(process.env.CLAIM_REGISTRY_UI_PORT ?? 3441);
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
  const card = page.locator('[data-card="claim-registry"]');
  // The app's sticky header would sit over an element capture.
  const shot = async (name, target) => {
    if (!SHOTS) return;
    await page.addStyleTag({ content: "header { position: static !important; }" });
    await page.waitForTimeout(300);
    await target.screenshot({ path: `${SHOTS}/${name}.png` });
  };

  // ── One site ──────────────────────────────────────────────────────────────
  await page.goto(`${base}/clients/${L}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  await card.waitFor({ timeout: 60000 });
  assert.equal(await card.locator("button, input, select, textarea, form, [role=button]").count(), 0);
  assert.match(await card.textContent(), /read-only/);
  ok("The section is on the Intelligence tab and has no control at all");

  assert.deepEqual(
    await card.locator("[data-bucket]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bucket"))),
    ["unverified", "missing_source", "stale", "needs_review"],
  );
  const tile = (prog, key) => card.locator(`[data-program="${prog}"] [data-count="${key}"] dd`).textContent();
  assert.equal(await tile("client", "verified"), "0");
  assert.equal(await tile("client", "needs_review"), "7");
  assert.equal(await tile("client", "unverified"), "1");
  assert.equal(await tile("client", "missing_source"), "1");
  assert.equal(await tile("client", "stale"), "1");
  ok("Counts per bucket; nothing reads as verified before it is classified and verified");

  const lifetime = card.locator(`[data-claim="${id(12)}"]`);
  assert.match(await lifetime.textContent(), /not citable under current rules/);
  assert.equal(await card.locator('[data-verification="independently_verified"]').count(), 0);
  assert.equal(await card.locator('[data-verification="not_independently_verified"]').count(), 10);
  const affected = await lifetime.locator('[aria-label="Cited by"] li').evaluateAll((els) =>
    els.map((li) => ({ text: li.textContent, href: li.querySelector("a")?.getAttribute("href"), published: li.getAttribute("data-affected") })));
  assert.equal(affected.length, 5);
  assert.equal(affected[0].published, "published");
  assert.equal(affected[0].href, `/clients/${L}/social/${id(41)}`);
  assert.match(affected[0].text, /Business Profile post \(published .+\) · live/);
  assert.equal(affected.filter((a) => a.href?.includes("/drafts/") && /in review/.test(a.text)).length, 3);
  assert.match(await lifetime.textContent(), /Possibly superseded: .*Tentative; not a recorded replacement/);
  assert.equal(await card.locator("[data-claim]", { hasText: "Possibly superseded" }).count(), 1);
  assert.equal(await tile("client", "superseded"), "0");
  assert.match(await card.locator("[data-registry-cited-unusable]").textContent(), /1 claim is cited .* 1 of them by published content/);
  ok("The unverified lifetime warranty links to its published post (and the live URL), a rejected post and three drafts in review; its supersession note is tentative");

  const three = card.locator(`[data-claim="${id(11)}"]`);
  assert.match(await three.textContent(), /Confirmed by owner@roofing\.example\.test on .+ · method not recorded/);
  assert.match(await three.textContent(), /Not yet classified · review every 90 days · due/);
  assert.match(await card.locator(`[data-claim="${id(13)}"]`).textContent(), /Never verified · recorded/);
  assert.match(await card.locator(`[data-claim="${id(13)}"] [data-source]`).textContent(), /Client's own website · roofing\.example\.test/);
  assert.match(await card.locator(`[data-claim="${id(16)}"]`).textContent(), /Repeats the phone on the client's record/);
  assert.match(await card.locator(`[data-claim="${id(19)}"]`).textContent(), /Matches the approved phone of the North office location/);
  assert.doesNotMatch(await card.locator(`[data-claim="${id(19)}"]`).textContent(), /Potential mismatch/);
  assert.match(await card.locator(`[data-claim="${id(20)}"]`).textContent(), /Potential mismatch: .*not evaluated yet/);
  assert.match(await three.textContent(), /citable under current rules.*not independently verified/);
  assert.match(await card.locator(`[data-claim="${id(17)}"]`).textContent(), /was due .+ days ago/);
  ok("Citable under current rules is kept apart from independent verification; the phone indicators respect location numbers");
  await shot("claim-registry-single-site", card);

  // ── Three brand sites ─────────────────────────────────────────────────────
  await page.goto(`${base}/clients/${M}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  await card.waitFor();
  assert.deepEqual(
    await card.locator("[data-program]").evaluateAll((els) => els.map((e) => e.getAttribute("data-program"))),
    ["safety", "forklift", "heavy"],
  );
  assert.equal(await tile("safety", "needs_review"), "2");
  assert.equal(await tile("forklift", "needs_review"), "1");
  for (const k of ["verified", "needs_review", "unverified"]) assert.equal(await tile("heavy", k), "—");
  assert.match(await card.locator('[data-program="heavy"]').textContent(), /not approved: its scope is not counted/);
  assert.match(await card.locator("[data-registry-unassigned]").textContent(), /Assigned to no brand site: 1 of 4 claims\. Shared by more than one brand site: 1\./);
  assert.match(await card.locator(`[data-claim="${id(23)}"]`).textContent(), /No brand site/);
  const shared = await card.locator(`[data-claim="${id(22)}"]`).textContent();
  assert.ok(shared.includes("Fictional Safety") && shared.includes("Fictional Forklift") && shared.includes("Shared by more than one brand site"));
  ok("Three brand sites: per-site counts, a shared claim labelled, an unassigned one counted for none, a draft workspace unknown (—), not 0");
  await shot("claim-registry-three-sites", card);

  // ── No claims ─────────────────────────────────────────────────────────────
  await page.goto(`${base}/clients/${EMPTY}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  await card.waitFor();
  assert.match(await card.textContent(), /No claims recorded for this client yet/);
  ok("A client with no claims says so");

  // ── Phone width ───────────────────────────────────────────────────────────
  const mctx = await contextFor(browser, TEAM, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await mp.goto(`${base}/clients/${L}/intelligence`, { waitUntil: "networkidle", timeout: 120000 });
  await mp.locator('[data-card="claim-registry"]').waitFor();
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (SHOTS) await mp.locator('[data-card="claim-registry"]').screenshot({ path: `${SHOTS}/claim-registry-mobile.png` });
  await mctx.close();
  ok("Phone width: no horizontal scroll");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(fingerprint(), before);
  ok("No page errors, no calls outside the sandbox, and loading the pages wrote nothing");
  console.log(`Claims registry browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
