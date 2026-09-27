// End to end: the Authority → AI Drafter hand-off (migration 0053 + post-drafter
// v2) against a real database — the full migration replay behind PostgREST,
// so the function arrives as authenticator + service_role, a teammate as
// authenticator + authenticated with a team JWT, and the worker's SQL as
// postgres. The handler and store are the deployed ones; there is no model:
// the "model" is a fixed draft.
//
//   npm run test:drafter-authority   (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional client ("Handoff Roofing Co", example.test addresses). The worker
// fire goes to the sandbox's stubbed net.http_post: recorded, never sent.
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore } from "../supabase/functions/post-drafter/store.ts";
import { buildBrief } from "../supabase/functions/post-drafter/brief.ts";
import { deriveTarget } from "../supabase/functions/post-drafter/authority.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through npm run test:drafter-authority");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const C = "00000000-0000-4000-b000-0000000000e1";
const ROOF = "00000000-0000-4000-e000-0000000000e1";
const KT = "00000000-0000-4000-d000-0000000000e1";
const KC = "00000000-0000-4000-d000-0000000000e2";
const OC = "00000000-0000-4000-f000-0000000000e1";
const WARRANTY = "00000000-0000-4000-f000-0000000000e2";
const REVIEWS = "00000000-0000-4000-f000-0000000000e3";
const SITE = "https://handoff.example.test";
const PAGE = `${SITE}/services/roof-replacement`;

const COPY_A =
  "Ready to replace an aging roof on your Wentzville home? Handoff Roofing Co keeps roof replacement straightforward, " +
  "from the first inspection to an estimate you can plan around. We're an Owens Corning Preferred Contractor, and every " +
  "roof replacement we complete is backed by our Lifetime Workmanship Warranty. When you're ready, request a quote and " +
  "we'll set up a time to look at your roof together.";
const COPY_B =
  "A roof replacement is one of the bigger projects a Wentzville homeowner takes on, and Handoff Roofing Co wants the " +
  "decision to feel clear rather than rushed. As an Owens Corning Preferred Contractor, we can walk you through your " +
  "options before anything is scheduled. Our roof replacement page explains what to expect, and when you're ready, " +
  "request a quote to get started with a local team.";

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

// ── Authority analysis, recorded the way authority-run records it ──
const page = (p) => ({ url: SITE + p, status: 200, final_url: SITE + p, final_status: 200, redirect_loop: false, in_sitemap: true, title: null, h1: null, h2: [], canonical: null, words: 300, text: "x" });
const gbp = (intent, keyword, kwText, over = {}) => ({
  id: `gbp_post:roof-replacement:${intent}`, key: `gbp_post:${ROOF}:${intent}`, section: "ready", action: "create", tier: "B",
  content_type: "gbp_post", topic: "Roof Replacement", service_id: ROOF, objective: "Help homeowners ready to act take the next step.",
  order: [1], eligible_from: null, gap: `No ${intent} Business Profile post for Roof Replacement.`,
  target: { keyword_id: keyword, keyword: kwText, intent, location: null, owner_path: "/services/roof-replacement", cta: "LEARN_MORE" },
  evidence_claim_ids: [OC], existing_coverage: [], blockers: [], gates: [], reasons: [{ tag: "FACT", text: "No recent post." }],
  ...over,
});
async function analysis(tx) {
  const { data: run, error: e1 } = await service.rpc("authority_begin_run", { p_client_id: C, p_mode: "refresh", p_requested_via: "worker" });
  assert.equal(e1, null, e1?.message);
  const { data: fp, error: e2 } = await service.rpc("authority_fingerprint", { p_client_id: C });
  assert.equal(e2, null, e2?.message);
  const today = new Date().toISOString().slice(0, 10);
  const report = {
    client: { id: C }, as_of: today, sources: {}, keywords: [],
    opportunities: [tx, gbp("commercial", KC, "roof replacement handoff", { eligible_from: "2099-01-01" })],
  };
  const { error: e3 } = await service.rpc("authority_record_run", { p_run_id: run, p: {
    status: "completed", engine_version: "authority-v1.3", judged_at: new Date().toISOString(), as_of: today,
    input_hash: "sha256:" + "e1".repeat(32), section_hashes: fp,
    inventory: { fetched_at: new Date().toISOString(), site: SITE, pages: [page("/"), page("/services/roof-replacement")] },
    inventory_errors: 0, report,
  } });
  assert.equal(e3, null, e3?.message);
  return run;
}
const opp = () => JSON.parse(sql(`select to_jsonb(o) from authority_opportunities o where client_id = '${C}' and key = 'gbp_post:${ROOF}:transactional'`));
const effective = () => sql(`select effective_status from authority_opportunity_state where client_id = '${C}' and key = 'gbp_post:${ROOF}:transactional'`);
const expected = (o = opp()) => ({ run_id: o.last_seen_run_id, status: o.status, suppressed: o.suppressed, dismissed_until: o.dismissed_until });
const requestDraft = () => asTeam.rpc("authority_apply", { p_opportunity_id: opp().id, p_action: "request_draft", p_payload: {}, p_expected: expected() });
// Time travel for the cadence checks (sandbox only): 0045's update trigger
// pins created_at, so it is bypassed for this one statement.
const agePosts = (where, interval) => sql(`begin; alter table social_posts disable trigger social_posts_aa_update;
  update social_posts set created_at = now() - interval '${interval}' where ${where};
  alter table social_posts enable trigger social_posts_aa_update; commit;`);
const count = (q) => Number(sql(`select count(*) from ${q}`));
const runs = () => count(`drafter_runs where client_id = '${C}'`);
const posts = () => count(`social_posts where client_id = '${C}'`);
const links = () => count(`authority_opportunity_links where client_id = '${C}'`);
const requests = () => count(`tasks where client_id = '${C}' and key like 'authority\\_draft:%'`);
const openRequests = () => count(`tasks where client_id = '${C}' and key like 'authority\\_draft:%' and status <> 'done'`);
const fires = (task) => count(`worker_fires where client_id = '${C}' and reason = 'Authority draft request ${task}'`);
const A = (mode, extra = {}) => ({ mode, client_id: C, authority_opportunity_id: opp().id, ...extra });
const briefHash = async () => { const r = await call(A("brief")); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.brief_hash; };

try {
  // ── Fixture ──
  sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
  sql(`select vault.create_secret('https://routine.example.test/fire', 'ROUTINE_FIRE_URL')`);
  sql(`select vault.create_secret('sandbox-token', 'ROUTINE_FIRE_TOKEN')`);
  sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
       values ('${C}', 'Handoff Roofing Co', 'Wentzville', 'MO', '(636) 555-0199', '${SITE}', 'service_area', 'Wentzville, Missouri', 'active')`);
  sql(`update client_brands set
         positioning = 'Wentzville roofing contractor serving Wentzville and surrounding communities.',
         voice_tone = 'Warm, straight-talking and local. Never state or imply prices.',
         audience = 'Homeowners in Wentzville who need roofing work.',
         differentiators = 'One local company from inspection and estimate to final sign-off',
         ai_guidance = 'Use only sourced or confirmed claims.',
         words_we_use = array['local', 'straightforward', 'inspection', 'estimate'],
         words_we_avoid = array['storm chaser', 'cheapest'], content_pillars = array['Roof replacement'], tagline = 'Local roofs, done plainly.'
       where client_id = '${C}'`);
  sql(`insert into brand_boards (client_id, version, status, standing_cta, hard_rules)
       values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.', 'Only one phone number: (636) 555-0199.'])`);
  sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
  sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority) values
       ('${KT}', '${C}', 'roof quote handoff', 'transactional', true, true, true, '${ROOF}', '${PAGE}', 'p1'),
       ('${KC}', '${C}', 'roof replacement handoff', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1')`);
  sql(`insert into claims (id, client_id, claim, status, source) values
       ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/2'),
       ('${WARRANTY}', '${C}', 'Lifetime Workmanship Warranty', 'sourced', '${PAGE}'),
       ('${REVIEWS}', '${C}', '4.9 stars from 120 reviews', 'sourced', 'https://reviews.example.test/handoff')`);
  sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
  sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids)
       values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KC}', '{}')`);
  const run1 = await analysis(gbp("transactional", KT, "roof quote handoff"));

  // 1. brief / check: target derived from the opportunity; the Drafter's own brief + brief.authority.
  const v = await call({ mode: "version" });
  assert.equal(v.body.version, 2);
  const b = await call(A("brief"));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const { data: input } = await service.rpc("client_intelligence_input", { p_client_id: C });
  const local = buildBrief(input, deriveTarget(opp()));
  assert.equal(local.ok, true, JSON.stringify(local.refusals));
  assert.deepEqual(b.body.brief.target, local.brief.target);
  assert.deepEqual(b.body.brief.allowed_facts.claims, local.brief.allowed_facts.claims);
  assert.equal(b.body.brief.target.keyword.id, KT);
  assert.equal(b.body.brief.target.search_intent, "transactional");
  assert.equal(b.body.brief.authority.run_id, run1);
  assert.deepEqual(b.body.brief.authority.preferred_claim_ids, [OC]);
  assert.equal(b.body.request, null);
  const c = await call(A("check", { brief_hash: b.body.brief_hash, draft: { copy: COPY_A, claim_ids: [OC, WARRANTY] } }));
  assert.equal(c.body.ok, true, JSON.stringify(c.body.problems));
  assert.equal(runs() + posts() + requests(), 0);
  ok("brief / check: the target comes from the opportunity (keyword, intent, page, button); the brief is the Drafter's own plus brief.authority; nothing written");

  // 2. The caller cannot supply the target; submit without a request is refused, nothing recorded.
  assert.equal((await call(A("brief", { target: { channel: "google_business", intent: "commercial", serviceId: ROOF } }))).body.error, "target_not_allowed");
  const noReq = await call(A("submit", { brief_hash: b.body.brief_hash, draft: { copy: COPY_A, claim_ids: [OC] }, runtime: "sandbox" }));
  assert.equal(noReq.status, 409);
  assert.equal(noReq.body.code, "not_requested");
  assert.equal(runs() + posts(), 0);
  ok("No caller target; submit without a teammate's request is an Authority conflict (409) and records no Drafter run");

  // 3. A teammate requests; the worker start fails and is retried, then is missed and restarted — one request throughout.
  const r1 = await requestDraft();
  assert.equal(r1.error, null, r1.error?.message);
  const task = r1.data.id;
  assert.equal(r1.data.rows[0].started.fired, true);
  assert.equal(fires(task), 1);
  assert.equal(opp().status, "accepted");
  assert.equal(effective(), "accepted", "the request is never a link");
  const again = await requestDraft();
  assert.equal(again.data.id, task);
  assert.equal(again.data.rows[0].reused, true);
  assert.equal(requests(), 1);
  // failed: the Routine API answered 500; ten minutes on, the fire log retries it
  sql(`update worker_fires set created_at = now() - interval '11 minutes' where client_id = '${C}' and reason = 'Authority draft request ${task}'`);
  sql(`insert into net._http_response (id, status_code, content) select request_id, 500, 'upstream' from worker_fires where client_id = '${C}' and reason = 'Authority draft request ${task}'`);
  sql(`select retry_failed_fires()`);
  assert.equal(fires(task), 2);
  // missed: no Routine credentials when the start ran; the Retry start restarts it
  sql(`update worker_fires set created_at = now() - interval '30 minutes' where client_id = '${C}' and reason = 'Authority draft request ${task}'`);
  sql(`delete from vault.secrets where name = 'ROUTINE_FIRE_URL'`);
  const missed = await asTeam.rpc("authority_draft_start", { p_task_id: task });
  assert.equal(missed.data.fired, false);
  sql(`select vault.create_secret('https://routine.example.test/fire', 'ROUTINE_FIRE_URL')`);
  const restart = await asTeam.rpc("authority_draft_start", { p_task_id: task });
  assert.equal(restart.data.fired, true);
  assert.equal(fires(task), 3);
  assert.equal(requests(), 1);
  assert.equal(runs() + posts(), 0);
  const seen = await call(A("brief"));
  assert.deepEqual(seen.body.request, { task_id: task, status: "open" });
  ok("request_draft: one CLAUDE request task (reused on re-request); a failed start retried by the fire log, a missed one restarted — still one request, no run, no post");

  // 4. Stale expected run and changed target refuse in every mode.
  for (const mode of ["brief", "check", "submit"]) {
    const s = await call(A(mode, { expected_run_id: randomUUID(), brief_hash: seen.body.brief_hash, draft: { copy: COPY_A, claim_ids: [OC] }, runtime: "sandbox" }));
    assert.equal(s.status, 409, mode);
    assert.equal(s.body.code, "authority_stale", mode);
  }
  sql(`update services set page_url = '${SITE}/roof-replacement-2' where id = '${ROOF}'`);
  sql(`update page_groups set target_url = '${SITE}/roof-replacement-2' where client_id = '${C}'`);
  sql(`update keywords set target_url = '${SITE}/roof-replacement-2' where client_id = '${C}'`);
  const moved = await call(A("check", { brief_hash: seen.body.brief_hash, draft: { copy: COPY_A, claim_ids: [OC] } }));
  assert.equal(moved.status, 409);
  assert.equal(moved.body.code, "target_mismatch");
  sql(`update services set page_url = '${PAGE}' where id = '${ROOF}'`);
  sql(`update page_groups set target_url = '${PAGE}' where client_id = '${C}'`);
  sql(`update keywords set target_url = '${PAGE}' where client_id = '${C}'`);
  assert.equal(runs() + posts(), 0);
  ok("A stale expected run refuses in brief, check and submit; the service page moved after the analysis → target_mismatch, not adapted");

  // 5. Cadence becoming active after the analysis: a teammate's post for the same service and intent.
  const { data: manual, error: mErr } = await asTeam.from("social_posts").insert({
    client_id: C, platform: "google_business", post_type: "standard", search_intent: "transactional", service_id: ROOF,
    copy: "A teammate's own post about roof replacement quotes, written by hand for this test.",
  }).select("id").single();
  assert.equal(mErr, null, mErr?.message);
  const cad = await call(A("brief"));
  assert.equal(cad.status, 409);
  assert.equal(cad.body.code, "cadence_active");
  agePosts(`id = '${manual.id}'`, "30 days");
  const aged = await call(A("brief"));
  assert.equal(aged.status, 200, JSON.stringify(aged.body) + sql(`select created_at from social_posts where id = '${manual.id}'`));
  ok("Cadence rechecked live: a post made after the analysis refuses (cadence_active); once 21 days old it no longer does");

  // 6. The Drafter's own refusal after the request: recorded with the opportunity; the request stays open.
  let hash = await briefHash();
  const lintFail = await call(A("submit", { brief_hash: hash, draft: { copy: COPY_A + " Rated 4.9 stars by 120 neighbors.", claim_ids: [OC] }, runtime: "sandbox" }));
  assert.equal(lintFail.status, 422);
  assert.equal(sql(`select status || '|' || authority_opportunity_id from drafter_runs where client_id = '${C}'`), `lint_failed|${opp().id}`);
  assert.equal(posts(), 1);
  assert.equal(openRequests(), 1);
  assert.equal(effective(), "accepted");
  ok("A Drafter refusal after the request (lint_failed) is recorded with authority_opportunity_id; no post; the request stays open");

  // 7. Atomic: a failure while linking rolls back the run, the post and the request's closing.
  sql(`create function public.sandbox_fail_link() returns trigger language plpgsql as $f$
       begin if exists (select 1 from social_posts where id = new.social_post_id and copy like '%plan around it%') then
         raise exception 'forced link failure' using errcode = 'XX003'; end if; return new; end $f$`);
  sql(`create trigger sandbox_fail_link before insert on authority_opportunity_links for each row execute function public.sandbox_fail_link()`);
  hash = await briefHash();
  const rolled = await call(A("submit", { brief_hash: hash, draft: { copy: COPY_A.replace("an estimate you can plan around", "an estimate so you can plan around it"), claim_ids: [OC, WARRANTY] }, runtime: "sandbox" }));
  assert.equal(rolled.status, 422, JSON.stringify(rolled.body));
  assert.equal(rolled.body.code, "XX003");
  assert.equal(posts(), 1, "no drafted post");
  assert.equal(links(), 0);
  assert.equal(openRequests(), 1);
  assert.equal(count(`drafter_runs where client_id = '${C}' and status = 'submitted'`), 0);
  sql(`drop trigger sandbox_fail_link on authority_opportunity_links`);
  ok("A failure while linking rolls back the write: no drafted post, no link, the request still open (the refusal is recorded as a run)");

  // 8. The successful submit: one run, one post in review, linked; the request done; in progress.
  hash = await briefHash();
  const w = await call(A("submit", { brief_hash: hash, draft: { copy: COPY_A, claim_ids: [OC, WARRANTY] }, runtime: "sandbox-model", expected_run_id: run1 }));
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const post1 = w.body.post_id;
  assert.equal(sql(`select status || '|' || authority_opportunity_id || '|' || post_id from drafter_runs where id = '${w.body.run_id}'`), `submitted|${opp().id}|${post1}`);
  assert.equal(sql(`select review_status || '|' || publish_status from social_posts where id = '${post1}'`), "in_review|not_scheduled");
  assert.equal(sql(`select kind || '|' || social_post_id from authority_opportunity_links where client_id = '${C}'`), `social_post|${post1}`);
  assert.equal(sql(`select status || '|' || (notes like '%${post1}%') from tasks where id = '${task}'`), "done|true");
  assert.equal(effective(), "in_progress");
  assert.equal(sql(`select key || '|' || owner from tasks where id = '${w.body.review_task_id}'`), "post_review|CLAUDE_APPROVAL");
  ok("Submit: one run with authority_opportunity_id, one post in review linked to the opportunity, the request done → in progress; the review task is 0045's");

  // 9. Retries after success create nothing.
  const dup = await call(A("submit", { brief_hash: hash, draft: { copy: COPY_A, claim_ids: [OC, WARRANTY] }, runtime: "sandbox-model" }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "already_in_progress");
  const late = await asTeam.rpc("authority_draft_start", { p_task_id: task });
  assert.equal(late.data.fired, false);
  const reReq = await requestDraft();
  assert.ok(reReq.error && /already in review or approved/.test(reReq.error.message), JSON.stringify(reReq));
  assert.equal(count(`drafter_runs where client_id = '${C}' and status = 'submitted'`), 1);
  assert.equal(posts(), 2);
  assert.equal(requests(), 1);
  ok("After success, a duplicate submit, a late restart and a re-request create no second request, run or post");

  // 10. Rejected → draftable again (a new request); the redraft may not repeat the rejected text.
  const rej = await asTeam.from("social_posts").update({ review_status: "rejected", review_note: "Say more about the quote." }).eq("id", post1);
  assert.equal(rej.error, null, rej.error?.message);
  assert.equal(effective(), "accepted");
  const r2 = await requestDraft();
  assert.equal(r2.error, null, r2.error?.message);
  assert.notEqual(r2.data.id, task);
  hash = await briefHash();
  const same = await call(A("submit", { brief_hash: hash, draft: { copy: COPY_A, claim_ids: [OC, WARRANTY] }, runtime: "sandbox-model" }));
  assert.equal(same.status, 422);
  assert.ok(same.body.problems.some((p) => p.code === "duplicate_recent_post" && p.match === post1), JSON.stringify(same.body.problems));
  const w2 = await call(A("submit", { brief_hash: hash, draft: { copy: COPY_B, claim_ids: [OC] }, runtime: "sandbox-model" }));
  assert.equal(w2.status, 201, JSON.stringify(w2.body));
  assert.equal(effective(), "in_progress");
  ok("Rejected post → accepted, a new request; the redraft repeating the rejected post fails duplicate_recent_post; a new draft is written");

  // 11. Approved → completed for this cycle; nothing more this cycle.
  const appr = await asTeam.from("social_posts").update({ review_status: "approved" }).eq("id", w2.body.post_id);
  assert.equal(appr.error, null, appr.error?.message);
  assert.equal(effective(), "completed");
  assert.equal((await call(A("brief"))).body.code, "already_in_progress");
  assert.equal(sql(`select publish_status from social_posts where id = '${w2.body.post_id}'`), "not_scheduled");
  ok("Approved post → completed for the current cycle; brief refuses (already_in_progress); nothing scheduled or published");

  // 12. Recurring cycle: still inside cadence → completed; eligible again → a new cycle, and the live cadence still guards.
  await analysis(gbp("transactional", KT, "roof quote handoff", { eligible_from: "2099-01-01" }));
  assert.equal(effective(), "completed");
  await analysis(gbp("transactional", KT, "roof quote handoff"));
  assert.equal(effective(), "open");
  assert.ok(opp().cycle_started_at);
  assert.equal(count(`authority_opportunity_events where opportunity_id = '${opp().id}' and kind = 'reopened' and detail->>'reason' = 'new cadence cycle'`), 1);
  const cyc = await call(A("brief"));
  assert.equal(cyc.status, 409);
  assert.equal(cyc.body.code, "cadence_active", "the approved post of this week still holds the live cadence");
  agePosts(`client_id = '${C}'`, "25 days");
  assert.equal((await call(A("brief"))).status, 200);
  ok("A later cycle reopens the opportunity (the older approved post no longer completes it); the live 21-day cadence still applies");

  console.log(`Drafter Authority integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
