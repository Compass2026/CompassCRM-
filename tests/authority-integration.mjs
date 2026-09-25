// End-to-end check of authority-run (Authority D2) against a real database:
// the full migration replay behind PostgREST, so the function's calls arrive
// as session_user authenticator / role service_role, the only session 0048's
// authority_begin_run / authority_record_run admit. The handler and store
// are the deployed ones (supabase/functions/authority-run); the client's
// site is a fake served in memory, and DNS is a fake resolver.
//
//   npm run test:authority     (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional client ("Sandbox Roofing", example.test addresses).
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createAuthorityRun } from "../supabase/functions/authority-run/handler.ts";
import { createStore } from "../supabase/functions/authority-run/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through npm run test:authority");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const C = "00000000-0000-4000-b000-0000000000a1";
const ROOF = "00000000-0000-4000-e000-0000000000a1";
const REPAIR = "00000000-0000-4000-e000-0000000000a2";
const KW = "00000000-0000-4000-d000-0000000000a1";
const KW2 = "00000000-0000-4000-d000-0000000000a2";
const OC = "00000000-0000-4000-f000-0000000000a1";
const SITE = "https://roof.example.test";
const PAGE = `${SITE}/services/roof-replacement`;

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const serviceKey = sign({ role: "service_role", exp: exp() });
const anonKey = sign({ role: "anon", exp: exp() });
const teamToken = sign({ sub: TEAM.id, role: "authenticated", aud: "authenticated", email: TEAM.email, exp: exp() });

const sql = (q) => {
  try { return execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { const err = new Error(`${String(e.stderr ?? e.message).trim()}\n  in: ${q}`); err.stderr = e.stderr; throw err; }
};

// Supabase's gateway, reduced to /auth/v1/user and /rest/v1.
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const ok = bearer === teamToken;
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
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// The fake site: path → [status, body, location]. Mutable between runs.
let routes = {};
let fetches = 0;
const siteFetch = async (url) => {
  fetches++;
  const u = new URL(url);
  if (u.hostname !== "roof.example.test") throw new Error(`the inventory asked for another host: ${url}`);
  const r = routes[u.pathname];
  if (typeof r === "function") return r();
  const [status, body, loc] = r ?? [404, "<title>Not found</title>"];
  return new Response(status >= 300 && status < 400 ? null : body ?? "", { status, headers: loc ? { location: loc } : {} });
};
let dns = ["93.184.216.34"];
const resolve = async () => dns;

function runner(over = {}) {
  const jobs = [];
  const run = createAuthorityRun({ store: createStore(service), gazetteer, fetch: siteFetch, resolve, waitUntil: (p) => jobs.push(p), ...over });
  const call = async (body, headers = { "x-cron-secret": "cron" }) => {
    const r = await run.handle(new Request("http://x/authority-run", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { call, settle: () => Promise.all(jobs) };
}
const { call, settle } = runner();
const runRow = (id) => JSON.parse(sql(`select row_to_json(r) from (select id, status, mode, requested_via, requested_by, engine_version, input_hash,
  section_hashes, inventory_pages, inventory_errors, inventory_fetched_at, counts, previous_run_id, diff, error,
  jsonb_array_length(report->'opportunities') as opps, report->'sources' as sources, inventory->'health' as health from authority_runs r where id = '${id}') r`));
const sqlRefused = (q) => { try { sql(q); return false; } catch (e) { return /team-only/.test(String(e.stderr ?? e.message)); } };
const oppState = () => sql(`select string_agg(key || '|' || present || '|' || status || '|' || section || '|' || last_seen_run_id, ',' order by key) from authority_opportunities where client_id = '${C}'`);
// Everything outside the Authority tables that a run could conceivably touch.
const outside = () => sql(`select md5(concat_ws('|',
  (select string_agg(md5(c::text), ',' order by id) from clients c where id = '${C}'),
  (select string_agg(md5(s::text), ',' order by id) from services s where client_id = '${C}'),
  (select string_agg(md5(k::text), ',' order by id) from keywords k where client_id = '${C}'),
  (select string_agg(md5(g::text), ',' order by id) from page_groups g where client_id = '${C}'),
  (select string_agg(md5(x::text), ',' order by id) from claims x where client_id = '${C}'),
  (select string_agg(md5(x::text), ',' order by id) from sites x where client_id = '${C}'),
  (select count(*) from social_posts), (select count(*) from tasks), (select count(*) from change_log),
  (select count(*) from content_posts), (select count(*) from drafter_runs), (select count(*) from worker_fires)))`);

// authority_fingerprint is team / service only (the worker's SQL is refused), so read through PostgREST.
const stale = async () => { const { data, error } = await service.from("authority_latest").select("stale_sections").eq("client_id", C).single(); assert.equal(error, null, error?.message); return data.stale_sections; };

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
const SITE_OK = () => ({
  "/sitemap.xml": [200, `<urlset><url><loc>${SITE}/</loc></url><url><loc>${PAGE}</loc></url><url><loc>${SITE}/services/roof-repair</loc></url></urlset>`],
  "/": [200, "<title>Sandbox Roofing | Wentzville Roofing Contractor</title><body><h1>Wentzville roofing, done plainly.</h1><p>Roof replacement and repair.</p></body>"],
  "/services/roof-replacement": [200, "<title>Roof Replacement in Wentzville | Sandbox Roofing</title><body><h1>Roof Replacement in Wentzville</h1><h2>Owens Corning Preferred Contractor</h2><p>Full tear-off and replacement.</p></body>"],
  "/services/roof-repair": [200, "<title>Roof Repair in Wentzville | Sandbox Roofing</title><body><h1>Roof Repair in Wentzville</h1><p>Leaks and flashing.</p></body>"],
});

try {
  sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Sandbox Roofing', 'Wentzville', 'MO', '(636) 555-0142', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values
       ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1),
       ('${REPAIR}', '${C}', 'Roof Repair', 'approved', '${SITE}/services/roof-repair', 'Roofing', 2)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority) values
       ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1'),
       ('${KW2}', '${C}', 'roof repair wentzville', 'commercial', true, true, false, '${REPAIR}', '${SITE}/services/roof-repair', 'p2')`);
  sql(`update services set primary_keyword_id = '${KW}' where id = '${ROOF}'`);
  sql(`update services set primary_keyword_id = '${KW2}' where id = '${REPAIR}'`);
  sql(`insert into claims (id, client_id, claim, status, source) values
       ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/contractor/1')`);
  sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids) values
       ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KW}', '{}'),
       ('${C}', 'Roof Repair', 'service', 'approved', '${SITE}/services/roof-repair', '${KW2}', '{}')`);
  sql(`insert into gsc_snapshots (client_id, keyword_id, query, page, clicks, impressions, ctr, avg_position, period_start, period_end) values
       ('${C}', '${KW}', 'roof replacement wentzville', '${PAGE}', 4, 120, 0.0333, 8.2, '2026-08-26', '2026-09-22'),
       ('${C}', null, 'roof leak repair near me', '${SITE}/services/roof-repair', 1, 60, 0.0167, 14.5, '2026-08-26', '2026-09-22')`);
  const before = outside();

  // 1. Who may call; the preflight.
  assert.equal((await call({ mode: "version" }, {})).status, 401);
  assert.equal((await call({ mode: "version" }, { Authorization: `Bearer ${anonKey}` })).status, 403);
  assert.equal((await call({ mode: "version" }, { "x-cron-secret": "wrong" })).status, 403);
  const v = await call({ mode: "version" }, { Authorization: `Bearer ${teamToken}` });
  assert.equal(v.status, 200);
  assert.equal(v.body.engine, "authority-v1.1");
  assert.equal(v.body.dns, true);
  ok("Callers: the cron secret or a team member; anon and a wrong secret refused; version reports the engine and DNS");

  // 2. Refresh before any completed run.
  const r0 = await call({ mode: "refresh", client_id: C });
  assert.equal(r0.status, 409);
  assert.equal(r0.body.error, "needs_full_run");
  assert.equal(sql(`select count(*) from authority_runs where client_id = '${C}'`), "0");
  assert.ok(sqlRefused(`select authority_fingerprint('${C}')`), "the worker's SQL cannot read the fingerprint");
  ok("Refresh with no completed run: 409 needs_full_run, no run row");

  // 3. A full run by a teammate, through the real store and 0048.
  routes = SITE_OK();
  fetches = 0;
  const r1 = await call({ mode: "full", client_id: C }, { Authorization: `Bearer ${teamToken}` });
  assert.equal(r1.status, 202, JSON.stringify(r1.body));
  assert.equal(runRow(r1.body.run_id).status, "running");
  await settle();
  const run1 = runRow(r1.body.run_id);
  assert.equal(run1.status, "completed", JSON.stringify(run1));
  assert.equal(run1.mode, "full");
  assert.equal(run1.requested_via, "team");
  assert.equal(run1.requested_by, sql(`select id from team_members where auth_user_id = '${TEAM.id}'`));
  assert.equal(run1.engine_version, "authority-v1.1");
  assert.match(run1.input_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(run1.inventory_pages, 3);
  assert.equal(run1.inventory_errors, 0);
  assert.ok(run1.opps > 0);
  assert.equal(Number(sql(`select count(*) from authority_opportunities where client_id = '${C}'`)), run1.opps);
  assert.deepEqual(run1.section_hashes, (await service.rpc("authority_fingerprint", { p_client_id: C })).data);
  assert.equal(run1.sources.gsc.rows, 2);
  assert.equal(run1.sources.gsc.coverage, "complete");
  assert.equal(run1.previous_run_id, null);
  assert.equal(run1.diff.added.length, run1.opps);
  assert.ok(fetches >= 4, "sitemap + three pages");
  assert.deepEqual(await stale(), []);
  ok(`Full run (team): 202 → completed through authority_record_run; ${run1.opps} opportunities stored; fingerprint = section hashes; nothing stale`);

  // 4. The run lock, and a second full run's diff.
  let release;
  const gate = new Promise((r) => { release = r; });
  routes = SITE_OK();
  routes["/services/roof-repair"] = [404, "<title>Not found</title>"];
  routes["/"] = async () => { await gate; return new Response("<title>Sandbox Roofing | Wentzville Roofing Contractor</title><body><h1>Wentzville roofing, done plainly.</h1></body>", { status: 200 }); };
  const r2 = await call({ mode: "full", client_id: C });
  assert.equal(r2.status, 202);
  const clash = await call({ mode: "full", client_id: C }, { Authorization: `Bearer ${teamToken}` });
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.body, { error: "run_in_progress", run_id: r2.body.run_id });
  assert.equal((await call({ mode: "refresh", client_id: C })).status, 409);
  release();
  await settle();
  const run2 = runRow(r2.body.run_id);
  assert.equal(run2.status, "completed", JSON.stringify(run2));
  assert.equal(run2.requested_via, "worker");
  assert.equal(run2.previous_run_id, r1.body.run_id);
  const keys = (id) => sql(`select string_agg(x->>'key', ',' order by x->>'key') from authority_runs, jsonb_array_elements(report->'opportunities') x where id = '${id}'`).split(",");
  const k1 = new Set(keys(r1.body.run_id)), k2 = new Set(keys(r2.body.run_id));
  assert.deepEqual([...run2.diff.added].sort(), [...k2].filter((k) => !k1.has(k)).sort());
  assert.deepEqual([...run2.diff.resolved].sort(), [...k1].filter((k) => !k2.has(k)).sort());
  assert.ok(run2.diff.added.length + run2.diff.resolved.length + run2.diff.section_changed.length > 0, "the broken Roof Repair page changes the map");
  assert.equal(Number(sql(`select count(*) from authority_runs where client_id = '${C}' and status = 'running'`)), 0);
  ok(`Run lock: a second caller gets 409 run_in_progress with the running id; second run's diff = key difference (+${run2.diff.added.length} / −${run2.diff.resolved.length}, ${run2.diff.section_changed.length} moved)`);

  // 5. Refresh: reuses run 2's inventory, fetches nothing, changes nothing.
  fetches = 0;
  const r3 = await call({ mode: "refresh", client_id: C });
  assert.equal(r3.status, 202);
  await settle();
  const run3 = runRow(r3.body.run_id);
  assert.equal(run3.status, "completed");
  assert.equal(run3.mode, "refresh");
  assert.equal(fetches, 0, "a refresh fetches nothing");
  assert.equal(run3.input_hash, run2.input_hash, "same facts and the same inventory");
  assert.equal(run3.inventory_fetched_at, run2.inventory_fetched_at);
  for (const k of ["added", "resolved", "regressed", "section_changed", "reopened"]) assert.deepEqual(run3.diff[k], [], k);
  ok("Refresh: reuses the latest inventory (no fetches), same input hash, empty diff");

  // 6. Degraded: the host resolves to a private address, so nothing is fetched.
  const snap = oppState();
  dns = ["10.0.0.9"];
  fetches = 0;
  const r4 = await call({ mode: "full", client_id: C });
  await settle();
  const run4 = runRow(r4.body.run_id);
  assert.equal(run4.status, "degraded", JSON.stringify(run4));
  assert.equal(fetches, 0, "the private address was never requested");
  assert.ok(run4.health.reasons.some((x) => /home page/.test(x)));
  assert.equal(run4.diff.skipped, "degraded run: opportunities unchanged");
  assert.equal(oppState(), snap, "a degraded run changes no opportunity");
  dns = ["93.184.216.34"];
  ok("Degraded: a host resolving to 10.0.0.9 is never fetched; the run is stored degraded and changes no opportunity");

  // 7. Failed: an exception in the background records the run failed.
  const broken = runner({ inventory: async () => { throw new Error("inventory exploded"); } });
  const r5 = await broken.call({ mode: "full", client_id: C });
  assert.equal(r5.status, 202);
  await broken.settle();
  const run5 = runRow(r5.body.run_id);
  assert.equal(run5.status, "failed");
  assert.equal(run5.error, "inventory exploded");
  assert.equal(oppState(), snap);
  ok("Failed: a background exception records the run failed with its error; opportunities untouched");

  // 8. Stale detection: the fingerprint was taken first, so a change after the run shows.
  sql(`update keywords set volume = 90 where id = '${KW}'`);
  assert.deepEqual(await stale(), ["keywords"]);
  sql(`update keywords set volume = null where id = '${KW}'`);
  ok("authority_latest reports a later keyword change as stale (section hashes = the fingerprint)");

  // 9. The run wrote nothing outside the Authority tables.
  assert.equal(outside(), before);
  ok("Nothing outside the Authority tables changed (client, services, keywords, page groups, claims, sites, posts, tasks, change log)");

  console.log(`Authority integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
