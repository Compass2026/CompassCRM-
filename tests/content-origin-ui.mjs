// Browser check for content provenance (0050, content_posts.origin): a page
// recorded from the client's own site (origin site_inventory) never shows as
// Compass's work, while Authority coverage still counts it. Run by
// `npm run test:content-origin-ui` (scripts/test-tasks-ui.sh with UI_SPEC
// set): a real Postgres replay behind PostgREST, `next dev` and Chromium.
// Nothing leaves the machine.
//
//   - Reports tab: the cycle's "N blog" count is Compass's posts only.
//   - Content tab: the tracker lists Compass's posts only and says how many
//     pages were recorded from the site.
//   - Client portal work log: Compass's posts only.
//   - authority_input (the engine's read): both.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through scripts/test-tasks-ui.sh");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const PORTAL = { id: "00000000-0000-4000-a000-000000000011", email: "portal-a@example.test" };
const users = new Map([TEAM, PORTAL].map((u) => [u.id, u]));
const CLIENT = "00000000-0000-4000-b000-00000000000a";

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

// Supabase's gateway, reduced to what the app calls: /auth/v1/user and /rest/v1.
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
    const body = [];
    for await (const c of req) body.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) {
      if (req.headers[k]) headers[k] = req.headers[k];
    }
    const upstream = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(body),
    });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(upstream.status, h);
    return res.end(out);
  }
  unexpected.push(`${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

const port = Number(process.env.CONTENT_ORIGIN_UI_PORT ?? 3427);
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: gatewayUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (c) => { logs = (logs + c).slice(-8000); });
app.stderr.on("data", (c) => { logs = (logs + c).slice(-8000); });

async function contextFor(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const session = { access_token: tokenFor(user), refresh_token: "local", expires_at: exp(), expires_in: 3600, token_type: "bearer", user: { ...user, aud: "authenticated" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }]);
  return context;
}
const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();

const COMPASS = "Five signs your water heater is failing";
const SITE = "Our 1998 opening day (already on their site)";
// Both in the September cycle the fixtures open for client A; the site page
// carries a date on purpose, so only the origin filter keeps it out.
sql(`insert into content_posts (client_id, title, status, url, published_at) values
  ('${CLIENT}', '${COMPASS}', 'published', 'https://a.example.test/blog/water-heater', '2026-09-15')`);
sql(`insert into content_posts (client_id, title, status, url, published_at, notes, origin) values
  ('${CLIENT}', '${SITE.replace(/'/g, "''")}', 'published', 'https://a.example.test/blog/opening-day', '2026-09-16',
   'Already on the client''s site; recorded by Authority. Not produced by Compass.', 'site_inventory')`);
const compassSept = Number(sql(`select count(*) from content_posts where client_id = '${CLIENT}' and status = 'published' and origin = 'compass'
  and published_at >= '2026-09-01' and published_at < '2026-10-01'`));
const allSept = Number(sql(`select count(*) from content_posts where client_id = '${CLIENT}' and status = 'published'
  and published_at >= '2026-09-01' and published_at < '2026-10-01'`));
assert.equal(allSept, compassSept + 1, "the fixture has exactly one site_inventory post in September");

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/login`)).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const team = await (await contextFor(browser, TEAM)).newPage();
  const errors = [];
  team.on("pageerror", (e) => errors.push(e.message));

  // Reports tab: the September cycle counts Compass's posts only.
  await team.goto(`${base}/clients/${CLIENT}/reports`, { waitUntil: "networkidle" });
  // B5: each cycle's delivered work (blog · social · Business Profile).
  const counts = await team.locator("[data-actual]").allTextContents();
  assert.ok(counts.some((t) => t.replace(/\s+/g, " ").startsWith(`${compassSept} blog ·`)), `a cycle reads ${compassSept} blog: ${JSON.stringify(counts)}`);
  assert.ok(!counts.some((t) => t.replace(/\s+/g, " ").startsWith(`${allSept} blog ·`)), `no cycle counts the recorded page (${allSept}): ${JSON.stringify(counts)}`);
  ok(`Reports: the September cycle reads ${compassSept} blog, not ${allSept}`);

  // Content tab: Compass's production only, with the recorded pages counted.
  await team.goto(`${base}/clients/${CLIENT}/content`, { waitUntil: "networkidle" });
  assert.ok(await team.getByText(COMPASS).first().isVisible(), "Compass's post is listed");
  assert.equal(await team.getByText(SITE).count(), 0, "the recorded page is not listed");
  assert.equal(await team.locator("[data-recorded-from-site]").getAttribute("data-recorded-from-site"), "1");
  assert.match(await team.locator("[data-recorded-from-site]").textContent(), /1 page already on the client.s site is recorded for Authority coverage/);
  ok("Content tab: lists Compass's post only and says 1 page is recorded from the site");

  // Authority coverage: the engine's read counts both.
  const asTeam = { apikey: anonKey, authorization: `Bearer ${tokenFor(TEAM)}`, "content-type": "application/json" };
  const inputRes = await fetch(`${gatewayUrl}/rest/v1/rpc/authority_input`, { method: "POST", headers: asTeam, body: JSON.stringify({ p_client_id: CLIENT }) });
  assert.ok(inputRes.ok, `authority_input as the teammate: ${inputRes.status}`);
  const input = (await inputRes.json()).authority.contentPosts;
  assert.ok(input.some((p) => p.title === SITE) && input.some((p) => p.title === COMPASS), "authority_input carries both origins");
  ok("Authority coverage: authority_input carries both origins");

  // Client portal: the work log shows Compass's post only.
  const portal = await (await contextFor(browser, PORTAL)).newPage();
  portal.on("pageerror", (e) => errors.push(e.message));
  await portal.goto(`${base}/portal/work-log`, { waitUntil: "networkidle" });
  assert.ok(await portal.getByText(COMPASS).first().isVisible(), "the portal shows Compass's post");
  assert.equal(await portal.getByText(SITE).count(), 0, "the portal never shows the recorded page");
  const asPortal = { apikey: anonKey, authorization: `Bearer ${tokenFor(PORTAL)}` };
  const direct = await (await fetch(`${gatewayUrl}/rest/v1/portal_work_log?select=label&kind=eq.post`, { headers: asPortal })).json();
  assert.ok(direct.some((r) => r.label === COMPASS) && !direct.some((r) => r.label === SITE), `portal_work_log through the API: ${JSON.stringify(direct)}`);
  const raw = await (await fetch(`${gatewayUrl}/rest/v1/content_posts?select=title`, { headers: asPortal })).json();
  assert.ok(Array.isArray(raw) ? raw.length === 0 : true, "the portal still reads no content_posts rows");
  ok("Portal: the work log (page and API) shows Compass's post only; content_posts stays unreadable");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Content provenance browser checks passed (${checks.length}).`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
