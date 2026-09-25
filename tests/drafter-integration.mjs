// End-to-end check of the AI Drafter's governed write path (0047 + the
// post-drafter function) against a real database: the full migration replay
// behind PostgREST, so the function's writes arrive as session_user
// authenticator / role service_role — the only session 0047 lets create a
// drafted post. The handler and store are the deployed ones
// (supabase/functions/post-drafter); there is no model: the "model" is a
// fixed draft, which is all a model adapter ever hands the function.
//
//   npm run test:drafter     (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional client ("Sandbox Roofing", example.test addresses).
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore } from "../supabase/functions/post-drafter/store.ts";
import { buildBrief } from "../supabase/functions/post-drafter/brief.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };
import { GOOD } from "./fixtures/drafter-lucas.mjs";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through npm run test:drafter");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const C = "00000000-0000-4000-b000-0000000000d1";
const ROOF = "00000000-0000-4000-e000-0000000000d1";
const REPAIR = "00000000-0000-4000-e000-0000000000d2";
const KW = "00000000-0000-4000-d000-0000000000d1";
const OC = "00000000-0000-4000-f000-0000000000d1";
const WARRANTY = "00000000-0000-4000-f000-0000000000d2";
const UNVERIFIED = "00000000-0000-4000-f000-0000000000d3";
const SITE = "https://roof.example.test";
const PAGE = `${SITE}/services/roof-replacement`;
const TARGET = { channel: "google_business", postType: "standard", intent: "commercial", serviceId: ROOF, keywordId: KW, ctaType: "LEARN_MORE", offerId: null, assetIds: [] };
const COPY = GOOD.replaceAll("Lucas Construction", "Sandbox Roofing");

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
const sqlFails = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); } };

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
const asTeam = createClient(gatewayUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${teamToken}` } } });
const drafter = createPostDrafter({ store: createStore(service), gazetteer });

const call = async (body, headers = { "x-cron-secret": "cron" }) => {
  const r = await drafter.handle(new Request("http://x/post-drafter", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

try {
  // ── Fixture: a fictional roofing client shaped like the pilot ──
  sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Sandbox Roofing', 'Wentzville', 'MO', '(636) 555-0142', '${SITE}', 'service_area',
               'Wentzville, O''Fallon and Lake St. Louis, Missouri', 'active')`);
  sql(`update client_brands set
         positioning = 'Wentzville roofing contractor serving Wentzville and surrounding communities.',
         voice_tone = 'Warm, straight-talking and local. Never state or imply prices.',
         audience = 'Homeowners in Wentzville who need roofing work, including aging roofs.',
         differentiators = 'One local company from inspection and estimate to final sign-off',
         ai_guidance = 'Use only sourced or confirmed claims.',
         words_we_use = array['local', 'straightforward', 'inspection', 'estimate'],
         words_we_avoid = array['storm chaser', 'cheapest'],
         content_pillars = array['Roof replacement'], tagline = 'Local roofs, done plainly.'
       where client_id = '${C}'`);
  sql(`insert into brand_boards (client_id, version, status, standing_cta, hard_rules)
       values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.', 'Only one phone number: (636) 555-0142.'])`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values
       ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1),
       ('${REPAIR}', '${C}', 'Roof Repair', 'approved', '${SITE}/services/roof-repair', 'Roofing', 2)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority)
       values ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1')`);
  sql(`update services set primary_keyword_id = '${KW}' where id = '${ROOF}'`);
  sql(`insert into claims (id, client_id, claim, status, source) values
       ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/1'),
       ('${WARRANTY}', '${C}', 'Lifetime Workmanship Warranty', 'sourced', '${PAGE}'),
       ('${UNVERIFIED}', '${C}', 'Family operated since 2018', 'unverified', null)`);
  sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids)
       values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KW}', '{}')`);

  // 1. Who may call.
  assert.equal((await call({ mode: "version" }, {})).status, 401);
  assert.equal((await call({ mode: "version" }, { Authorization: `Bearer ${anonKey}` })).status, 403);
  assert.equal((await call({ mode: "version" }, { Authorization: `Bearer ${teamToken}` })).status, 200);
  const v = await call({ mode: "version" });
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.modes, ["brief", "check", "submit", "version"]);
  ok("Callers: the worker's cron secret or a team member; anon refused; no approve / schedule / publish mode");

  // 2. The canonical loader feeds the brief: what the function builds is
  //    what buildBrief makes of client_intelligence_input's output.
  const { data: input, error: loadErr } = await service.rpc("client_intelligence_input", { p_client_id: C });
  assert.equal(loadErr, null, loadErr?.message);
  const local = buildBrief(input, TARGET);
  assert.equal(local.ok, true, JSON.stringify(local.refusals));
  const b = await call({ mode: "brief", client_id: C, target: TARGET });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(b.body.brief, local.brief);
  assert.equal(b.body.brief.target.cta.url, PAGE);
  assert.ok(b.body.brief.excluded.claims.some((x) => x.id === UNVERIFIED));
  const hash = b.body.brief_hash;
  ok("The brief is built from client_intelligence_input (the loader's JSON satisfies DrafterInput)");

  // 3. Check: lint only, nothing written.
  const draft = { copy: COPY, claim_ids: [OC, WARRANTY] };
  const c = await call({ mode: "check", client_id: C, target: TARGET, brief_hash: hash, draft });
  assert.equal(c.body.ok, true, JSON.stringify(c.body.problems));
  assert.equal(sql(`select count(*) from drafter_runs where client_id = '${C}'`), "0");
  ok("Check lints against the live brief and writes nothing");

  // 4. A change to Client Intelligence between brief and submit makes the brief stale.
  sql(`update client_brands set words_we_avoid = array['storm chaser', 'cheapest', 'act now'] where client_id = '${C}'`);
  const stale = await call({ mode: "submit", client_id: C, target: TARGET, brief_hash: hash, draft, runtime: "sandbox" });
  assert.equal(stale.status, 409);
  assert.equal(sql(`select status || '|' || brief_hash from drafter_runs where client_id = '${C}'`), `stale_brief|${hash}`);
  assert.equal(sql(`select count(*) from social_posts where client_id = '${C}'`), "0");
  const fresh = (await call({ mode: "brief", client_id: C, target: TARGET })).body.brief_hash;
  assert.notEqual(fresh, hash);
  ok("A brief that changed underneath the draft is refused as stale and recorded; nothing written");

  // 5. A draft that fails the linter is recorded as lint_failed.
  const bad = await call({ mode: "submit", client_id: C, target: TARGET, brief_hash: fresh, draft: { ...draft, copy: COPY + " Family operated since 2018." }, runtime: "sandbox" });
  assert.equal(bad.status, 422);
  assert.equal(sql(`select status || '|' || attempt from drafter_runs where client_id = '${C}' and brief_hash = '${fresh}'`), "lint_failed|1");
  assert.equal(sql(`select count(*) from social_posts where client_id = '${C}'`), "0");
  ok("A draft that fails the linter is recorded (lint_failed, attempt 1) and never written");

  // 6. The accepted submit: one transaction, ends in review with 0045's task.
  const s = await call({ mode: "submit", client_id: C, target: TARGET, brief_hash: fresh, draft, runtime: "sandbox-model" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const { post_id: post, run_id: run, review_task_id: task } = s.body;
  assert.equal(sql(`select review_status || '|' || publish_status || '|' || author_kind || '|' || coalesce(created_by::text, '-') || '|' || drafter_run_id || '|' || cta_type || '|' || cta_url from social_posts where id = '${post}'`),
    `in_review|not_scheduled|worker|-|${run}|LEARN_MORE|${PAGE}`);
  assert.equal(sql(`select string_agg(claim_id::text, ',' order by claim_id) from post_claims where post_id = '${post}'`), [OC, WARRANTY].sort().join(","));
  assert.equal(sql(`select key || '|' || owner || '|' || status || '|' || coalesce(assignee_id::text, '-') from tasks where id = '${task}'`), "post_review|CLAUDE_APPROVAL|open|-");
  assert.equal(sql(`select string_agg(distinct actor_kind, ',') from post_events where post_id = '${post}'`), "drafter");
  const copyHash = createHash("sha256").update(COPY, "utf8").digest("hex");
  assert.equal(sql(`select status || '|' || attempt || '|' || runtime || '|' || copy_hash || '|' || requested_via || '|' || post_id from drafter_runs where id = '${run}'`),
    `submitted|2|sandbox-model|${copyHash}|worker|${post}`);
  ok("Submit: one drafter_write → post in review (worker-authored, provenance), claims linked, an open unassigned CLAUDE_APPROVAL task, run submitted with the copy's sha256");

  // 7. Attempts: a duplicate is refused by the database and recorded; then the brief is spent.
  const dup = await call({ mode: "submit", client_id: C, target: TARGET, brief_hash: fresh, draft, runtime: "sandbox-model" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "23505");
  assert.equal(sql(`select status || '|' || attempt from drafter_runs where client_id = '${C}' and brief_hash = '${fresh}' order by created_at desc, attempt desc limit 1`), "refused|3");
  const spent = await call({ mode: "submit", client_id: C, target: TARGET, brief_hash: fresh, draft, runtime: "sandbox-model" });
  assert.equal(spent.status, 429);
  assert.equal(sql(`select count(*) from social_posts where client_id = '${C}'`), "1");
  ok("Duplicate refused by the database (recorded); three submits per brief, then none");

  // 8. The worker's SQL cannot touch the drafted post or its run; a person still decides.
  assert.match(sqlFails(`update social_posts set review_status = 'approved' where id = '${post}'`) ?? "", /Only a signed-in Compass team member/);
  assert.match(sqlFails(`update drafter_runs set runtime = 'x' where id = '${run}'`) ?? "", /written only by the post-drafter/);
  assert.match(sqlFails(`insert into social_posts (client_id, platform, search_intent, service_id, copy) values ('${C}', 'google_business', 'commercial', '${ROOF}', 'x')`) ?? "", /only through the post-drafter function/);
  const { data: runsSeen, error: runsErr } = await asTeam.from("drafter_runs").select("id, status").eq("client_id", C);
  assert.equal(runsErr, null, runsErr?.message);
  assert.equal(runsSeen.length, 4);
  const { error: teamWrite } = await asTeam.from("drafter_runs").insert({ client_id: C, requested_via: "team", target: {}, brief_version: "v", brief_hash: fresh, runtime: "x", status: "refused" });
  assert.ok(teamWrite, "a person cannot write runs through the API");
  const { error: rpcErr } = await asTeam.rpc("drafter_write", { p: {} });
  assert.ok(rpcErr, "a person cannot call drafter_write through the API");
  ok("Worker SQL cannot approve, rewrite the run or insert a post; the team reads runs but cannot write them or call drafter_write");

  // 9. Human review is unchanged: a team member approves through the API.
  //    (Sandbox only. Nothing is scheduled or published.)
  const { error: apprErr } = await asTeam.from("social_posts").update({ review_status: "approved" }).eq("id", post);
  assert.equal(apprErr, null, apprErr?.message);
  assert.equal(sql(`select review_status || '|' || publish_status || '|' || (approved_hash is not null) from social_posts where id = '${post}'`), "approved|not_scheduled|true");
  assert.equal(sql(`select status from tasks where id = '${task}'`), "done");
  ok("0045's review is unchanged: a signed-in teammate approves; the review task closes; nothing is scheduled");

  console.log(`Drafter integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
