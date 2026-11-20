// Browser acceptance for the Keywords tab's core link (20261120200000). Run by
// `npm run test:keyword-core-link-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): a real Postgres replay behind PostgREST, so the server action calls
// keyword_link_core_parent / keyword_unlink_core_parent as the signed-in
// teammate, exactly as in production. Fictional client only (the repo is
// public). SCREENSHOTS=<dir> saves a capture of the linked row.
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
const id = (n) => `8f${String(n).padStart(6, "0")}-0000-4000-8f00-000000000000`;
const C = id(1), S1 = id(2), S2 = id(3);
const K = { core: id(11), core2: id(12), coreOP: id(13), coreInfo: id(14), child: id(21), off: id(22) };

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
insert into clients (id, name, city, state, website_url, status) values
  ('${C}', 'Fictional Solar Co', 'Wichita', 'KS', 'https://solar.example.test', 'active');
insert into services (id, client_id, name, status, page_url) values
  ('${S1}', '${C}', 'Installation', 'approved', 'https://solar.example.test/services/installation'),
  ('${S2}', '${C}', 'Repair', 'approved', 'https://solar.example.test/services/repair');
insert into client_service_markets (client_id, city, state, status, basis, source_ref, decided_on) values
  ('${C}', 'Wichita', 'KS', 'approved', 'office', 'test fixture', current_date);
insert into keywords (id, client_id, keyword, service_id, is_active, intent, city) values
  ('${K.core}', '${C}', 'solar installation wichita ks', '${S1}', true, 'commercial', 'Wichita'),
  ('${K.core2}', '${C}', 'solar installation company', '${S1}', true, 'commercial', null),
  ('${K.coreOP}', '${C}', 'solar panels overland park ks', '${S1}', true, 'commercial', null),
  ('${K.coreInfo}', '${C}', 'how solar installation works', '${S1}', true, 'informational', null),
  ('${K.child}', '${C}', 'solar installers wichita ks', '${S1}', true, 'commercial', 'Wichita'),
  ('${K.off}', '${C}', 'solar repair near me', '${S2}', true, 'commercial', null);
insert into keywords (client_id, keyword, service_id, is_active, intent)
select '${C}', 'fixture filler ' || n, '${S2}', true, 'informational' from generate_series(1, 46) n;
insert into core_keyword_lists (client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
select '${C}', 1, 'approved',
       array['${K.core}', '${K.core2}', '${K.coreOP}', '${K.coreInfo}']::uuid[]
         || (select array_agg(id order by keyword) from keywords where client_id = '${C}' and keyword like 'fixture filler %'),
       'test fixture', (select id from team_members where email = '${TEAM.email}'), now();`);
// The place reference (production loads it as a data step), for place_mismatch.
execFileSync("/bin/sh", ["-c", `${PSQL_ADMIN} -o /dev/null -f supabase/seeds/place-names-v1.sql`]);

const parentOf = () => sql(`select coalesce(core_parent_keyword_id::text, '') from keywords where id = '${K.child}'`);
const events = () => sql(`select string_agg(e.action || ':' || coalesce(e.parent_id::text, '-') || ':' || e.reason || ':' || t.email, ' | ' order by e.id)
  from keyword_core_link_events e join team_members t on t.id = e.actor_id where e.keyword_id = '${K.child}'`);

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
  if (url.pathname.startsWith("/functions/v1/")) { res.writeHead(202, { "content-type": "application/json" }); return res.end("{}"); }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

const port = Number(process.env.KEYWORD_CORE_LINK_UI_PORT ?? 3447);
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
  const row = page.locator(`[data-core-link="${K.child}"]`);

  await page.goto(`${base}/clients/${C}/keywords`, { waitUntil: "networkidle", timeout: 180000 });
  await row.waitFor({ timeout: 90000 });
  assert.equal(await page.locator(`[data-core-link="${K.core}"]`).count(), 0);
  assert.match(await row.textContent(), /Link to core keyword/);
  assert.match(await page.locator(`[data-core-link="${K.off}"]`).textContent(), /no core keyword shares its service, intent and city/);
  ok("A core keyword has no link control; an off-list keyword with no eligible parent says why");

  await row.locator("summary", { hasText: "Link to core keyword" }).click();
  const offered = await row.locator('select[name="parent_id"] option:not([disabled])').evaluateAll((os) => os.map((o) => o.value).sort());
  assert.deepEqual(offered, [K.core, K.core2].sort());
  ok("Only eligible parents are offered (same service and intent; not the Overland Park keyword, not the informational one)");

  await row.locator('select[name="parent_id"]').selectOption(K.core);
  await row.locator('input[name="reason"]').fill("Same service, city, intent and page as the core keyword.");
  await row.getByRole("button", { name: "Link" }).click();
  await page.waitForFunction((kid) => document.querySelector(`[data-core-link="${kid}"]`)?.textContent?.includes("Serves core keyword"), K.child, { timeout: 60000 });
  assert.equal(parentOf(), K.core);
  assert.equal(events(), `linked:${K.core}:Same service, city, intent and page as the core keyword.:${TEAM.email}`);
  assert.match(await row.textContent(), /Serves core keyword solar installation wichita ks \(core v1\)/);
  ok("Linking runs as the signed-in teammate: the parent is set and the audit row names who, what and why");
  if (SHOTS) await row.screenshot({ path: `${SHOTS}/keyword-core-link-linked.png` });

  assert.equal(sql(`select coalesce(core_keyword_eligibility('${C}', null, '${K.child}', '${S1}'), 'PASS') like 'core_keyword_required%'`), "f");
  ok("The linked keyword now grounds in the approved core list (the gate no longer says core_keyword_required)");

  await row.locator("summary", { hasText: "Unlink" }).click();
  await row.locator('form:has(button:has-text("Unlink")) input[name="reason"]').fill("Linked by mistake in the test.");
  await row.getByRole("button", { name: "Unlink" }).click();
  await page.waitForFunction((kid) => document.querySelector(`[data-core-link="${kid}"]`)?.textContent?.includes("Link to core keyword")
    && !document.querySelector(`[data-core-link="${kid}"]`)?.textContent?.includes("Serves core keyword"), K.child, { timeout: 60000 });
  assert.equal(parentOf(), "");
  assert.match(events(), new RegExp(`\\| unlinked:-:Linked by mistake in the test\\.:${TEAM.email.replace(/[.@]/g, "\\$&")}$`));
  ok("Unlinking clears the parent and is audited too");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  ok("No page errors and no calls outside the sandbox");
  console.log(`Keyword core link browser checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.close();
}
