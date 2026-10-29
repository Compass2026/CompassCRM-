// End-to-end check of delegated copy edits (20261029180000 + content-approvals
// v4) against a real database: the full migration replay behind PostgREST, so
// the post-target read runs the exact select on the real schema (both
// social_posts ↔ drafter_runs foreign keys exist, so an unqualified embed is
// ambiguous) and the handler's writes arrive as authenticator / service_role,
// the only session content_edit_* admit. Handler, stores and copy check are
// the deployed ones; the post is written by the real post-drafter first.
//
//   npm run test:content-edit-copy     (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Fictional client ("Sandbox Copy Roofing", example.test addresses).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore as createDrafterStore } from "../supabase/functions/post-drafter/store.ts";
import { createContentApprovals } from "../supabase/functions/content-approvals/handler.ts";
import { createCopyCheck } from "../supabase/functions/content-approvals/copy-check.ts";
import { createPostTargetReader, createStore } from "../supabase/functions/content-approvals/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };
import { GOOD } from "./fixtures/drafter-lucas.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through npm run test:content-edit-copy");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const KEY = "sandbox-delegation-key";
const C = "00000000-0000-4000-b000-0000000000e7";
const ROOF = "00000000-0000-4000-e000-0000000000e7";
const KW = "00000000-0000-4000-d000-0000000000e7";
const OC = "00000000-0000-4000-f000-0000000000e7";
const WARRANTY = "00000000-0000-4000-f000-0000000000e8";
const UNVERIFIED = "00000000-0000-4000-f000-0000000000e9";
const LOC = "00000000-0000-4000-c000-0000000000e7";
const IMG = "00000000-0000-4000-9000-0000000000e7";
const SITE = "https://copyroof.example.test";
const PAGE = `${SITE}/services/roof-replacement`;
const TARGET = { channel: "google_business", postType: "standard", intent: "commercial", serviceId: ROOF, keywordId: KW, ctaType: "LEARN_MORE",
  offerId: null, assetIds: [], socialAccountId: LOC };
const NAME = "Sandbox Copy Roofing";
const COPY = GOOD.replaceAll("Lucas Construction", NAME);
const REVISED =
  `Planning a roof replacement for your Wentzville home? ${NAME} keeps the work straightforward, from the first inspection ` +
  "to a clear estimate you can plan around. We're an Owens Corning Preferred Contractor, so the roof that goes on your home " +
  "is installed by a crew the manufacturer recognises. When your roof is showing its age, see how our roof replacement " +
  "process works and request a quote.";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const serviceKey = sign({ role: "service_role", exp: exp() });
const anonKey = sign({ role: "anon", exp: exp() });
const teamToken = sign({ sub: TEAM.id, role: "authenticated", aud: "authenticated", email: TEAM.email, exp: exp() });

const run = (psql, q) => {
  try { return execFileSync("/bin/sh", ["-c", `${psql} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { const err = new Error(`${String(e.stderr ?? e.message).trim()}\n  in: ${q}`); err.stderr = e.stderr; throw err; }
};
const sql = (q) => run(PSQL, q);
// The publisher's verified binding, as a sandbox fixture (its guard admits only the publisher).
const sqlAdmin = (q) => run(PSQL_ADMIN, `set session_replication_role = replica; ${q}`);

// supabase-js talks to PostgREST directly at /rest/v1 through a tiny prefix proxy.
const rest = (key, extra = {}) => createClient(PGRST_URL.replace(/\/$/, "") + "/__", key, {
  auth: { persistSession: false, autoRefreshToken: false }, ...extra,
  global: { fetch: (u, init) => fetch(String(u).replace("/__/rest/v1", ""), init), ...(extra.global ?? {}) },
});
const service = rest(serviceKey);
const asTeam = rest(anonKey, { global: { headers: { Authorization: `Bearer ${teamToken}` } } });

const drafterStore = createDrafterStore(service);
const drafter = createPostDrafter({ store: drafterStore, gazetteer });
const postTarget = createPostTargetReader(service);
const copyCheck = createCopyCheck({
  postTarget,
  input: (c, s, k) => drafterStore.input(c, s, k),
  socialAccounts: (c) => drafterStore.socialAccounts(c),
  gazetteer,
});
const approvals = createContentApprovals({ store: createStore(service), copyCheck });

const callDrafter = async (body) => {
  const r = await drafter.handle(new Request("http://x/post-drafter", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const callApprovals = async (body) => {
  const r = await approvals.handle(new Request("http://x/content-approvals", { method: "POST", headers: { "content-type": "application/json", "x-compass-delegation-key": KEY }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };
const snap = (post) => sql(`select review_status || '|' || publish_status || '|' || md5(copy) || '|' ||
  coalesce((select string_agg(claim_id::text, ',' order by claim_id) from post_claims where post_id = p.id), '') || '|' ||
  (select count(*) from post_events where post_id = p.id) from social_posts p where id = '${post}'`);

// ── Fixture: a fictional roofing client shaped like the pilot ──
sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
sql(`select vault.create_secret('${KEY}', 'EXECUTIVE_OS_DELEGATION_SECRET')`);
sql(`update team_members set role = 'admin' where email = '${TEAM.email}'`);
sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
     values ('${C}', '${NAME}', 'Wentzville', 'MO', '(636) 555-0177', '${SITE}', 'service_area',
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
     values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.', 'Only one phone number: (636) 555-0177.'])`);
sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values
     ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority)
     values ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1')`);
sql(`update services set primary_keyword_id = '${KW}' where id = '${ROOF}'`);
sql(`insert into claims (id, client_id, claim, status, source) values
     ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/7'),
     ('${WARRANTY}', '${C}', 'Lifetime Workmanship Warranty', 'sourced', '${PAGE}'),
     ('${UNVERIFIED}', '${C}', 'Family operated since 2018', 'unverified', null)`);
sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids)
     values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KW}', '{}')`);
sqlAdmin(`insert into social_accounts (id, client_id, platform, external_account_id, display_name, publish_provider, publish_account_id, publish_page_id, publish_verified_at)
     values ('${LOC}', '${C}', 'google_business', 'locations/700000000000000077', '${NAME}', 'zernio', 'e7e7e7e7e7e7e7e7e7e7e7e7', 'locations/700000000000000077', now())`);
sqlAdmin(`insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash, content_hashed_at, content_measurement)
     values ('${IMG}', '${C}', 'social_post', 'upload', 'Illustrative roof graphic', '${C}/upload/${"7".repeat(64)}.png', 'image/png', 1900000, 1254, 1254,
             '${"7".repeat(64)}', now(), '{"bytes": 1900000, "content_type": "image/png", "measured_by": "sandbox"}')`);

try {
  // 1. The defect ChatGPT found: the unqualified embed is ambiguous on the real schema.
  const { error: ambiguous } = await service.from("social_posts").select("id, drafter_runs(target)").limit(1);
  assert.equal(ambiguous?.code, "PGRST201", JSON.stringify(ambiguous));
  ok("The unqualified drafter_runs embed is refused by PostgREST as ambiguous (PGRST201): both foreign keys exist");

  // 2. A drafted post, written by the real post-drafter (both FKs populated).
  const b = await callDrafter({ mode: "brief", client_id: C, target: TARGET });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const s = await callDrafter({ mode: "submit", client_id: C, target: TARGET, brief_hash: b.body.brief_hash,
    draft: { copy: COPY, claim_ids: [OC, WARRANTY] }, runtime: "sandbox-model" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const { post_id: drafted, run_id: run, review_task_id: oldTask } = s.body;
  assert.equal(sql(`select post_id from drafter_runs where id = '${run}'`), drafted, "the run points back at its post");

  const t = await postTarget(C, drafted);
  const runMode = sql(`select coalesce(target->>'campaignMode', '') from drafter_runs where id = '${run}'`);
  assert.deepEqual(t, {
    platform: "google_business", post_type: "standard", search_intent: "commercial", service_id: ROOF, keyword_id: KW, offer_id: null,
    cta_type: "LEARN_MORE", cta_url: PAGE, social_account_id: LOC, asset_ids: [],
    campaign_mode: runMode === "keyword" || runMode === "non_search" ? runMode : null,
  });
  assert.equal(await postTarget(C, "00000000-0000-4000-8000-00000000beef"), null);
  assert.equal(await postTarget("00000000-0000-4000-8000-00000000beef", drafted), null, "another client's id reads nothing");
  ok("Target reader on a drafted post: the exact select resolves through social_posts_drafter_run_fk; client-scoped");

  // 3. A post a person wrote (no run), with brand-asset media: the post_assets embed.
  const { data: human, error: humanErr } = await asTeam.from("social_posts").insert({
    client_id: C, platform: "google_business", search_intent: "commercial", service_id: ROOF, keyword_id: KW,
    social_account_id: LOC, cta_type: "LEARN_MORE", cta_url: PAGE, copy: REVISED }).select("id").single();
  assert.equal(humanErr, null, humanErr?.message);
  const { error: linkErr } = await asTeam.from("post_assets").insert({ post_id: human.id, client_id: C, brand_asset_id: IMG, sort_order: 1, role: "media" });
  assert.equal(linkErr, null, linkErr?.message);
  const th = await postTarget(C, human.id);
  assert.equal(th.campaign_mode, null);
  assert.deepEqual(th.asset_ids, [IMG]);
  assert.equal(th.social_account_id, LOC);
  ok("Target reader on a post with no run: campaign mode null; post_assets media read in order");

  // 4. The copy edit through the real handler: batch → revise.
  const batch = await callApprovals({ mode: "batch", client_id: C, channel: "google_business" });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  const item = batch.body.items.find((i) => i.id === drafted);
  assert.ok(item, "the drafted post is in the batch");
  const before = snap(drafted);
  const req = (o = {}) => ({
    mode: "revise", operation_id: "sandbox-copy-0001", client_id: C,
    post: { channel: "google_business", id: drafted, service_id: item.service_id, review_hash: item.review_hash, destination: item.destination },
    change: { kind: "replace_copy", copy: REVISED, claim_ids: [OC] },
    executor: { channel: "claude", executed_by: "Claude via Executive OS", account_email: TEAM.email },
    authority: { kind: "owner_approval", id: "sandbox-approval-1", channels: ["google_business"], service_ids: [ROOF], operations: ["replace_copy"] },
    reason: "Sandbox: the reviewed copy revision.",
    ...o,
  });

  // 4a. Refusals first: each recorded or refused, the post untouched.
  const dirty = await callApprovals(req({ operation_id: "sandbox-copy-dirty", change: { kind: "replace_copy", copy: `${REVISED} Family operated since 2018.`, claim_ids: [OC] } }));
  assert.equal(dirty.status, 422, JSON.stringify(dirty.body));
  assert.equal(dirty.body.error, "lint_failed");
  assert.ok(dirty.body.problems.length > 0);
  assert.equal(sql(`select status || '|' || refusal_code from content_edit_receipts where operation_id = 'sandbox-copy-dirty'`), "refused|lint_failed");
  const mediaOnly = await callApprovals(req({ operation_id: "sandbox-copy-media-auth",
    authority: { kind: "standing_policy", id: "p", channels: ["google_business"], service_ids: [ROOF], operations: ["replace_media"] } }));
  assert.equal(mediaOnly.status, 422, JSON.stringify(mediaOnly.body));
  assert.equal(mediaOnly.body.error, "outside_authority");
  const stale = await callApprovals(req({ operation_id: "sandbox-copy-stale", post: { ...req().post, review_hash: "sha256:" + "c".repeat(64) } }));
  assert.equal(stale.body.error, "content_changed");
  assert.equal(snap(drafted), before);
  ok("Refused through the API: copy the drafter's linter rejects (lint_failed, with problems), a media-only authority, a stale read; the post is untouched");

  // 4b. The edit.
  const r = await callApprovals(req());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rec = r.body.receipt;
  assert.equal(rec.status, "executed");
  assert.equal(rec.stage_id, null);
  assert.equal(sql(`select review_status || '|' || publish_status || '|' || (approved_hash is null) || '|' || coalesce(social_account_id::text, '-') || '|' || drafter_run_id
                    from social_posts where id = '${drafted}'`), `in_review|not_scheduled|true|${LOC}|${run}`);
  assert.equal(sql(`select copy = '${REVISED.replaceAll("'", "''")}' from social_posts where id = '${drafted}'`), "t");
  assert.equal(sql(`select string_agg(claim_id::text, ',') from post_claims where post_id = '${drafted}'`), OC);
  const newTask = sql(`select review_task_id from social_posts where id = '${drafted}'`);
  assert.notEqual(newTask, oldTask);
  assert.equal(sql(`select status from tasks where id = '${oldTask}'`), "done");
  assert.equal(sql(`select status from tasks where id = '${newTask}'`), "open");
  assert.equal(sql(`select count(*) from post_events where post_id = '${drafted}' and actor_kind = 'assistant' and detail->'edit'->>'receipt' = '${rec.id}'`) > "0", true);
  assert.equal(sql(`select count(*) from post_events where post_id = '${drafted}' and actor_kind = 'team'`), "0");
  assert.equal(rec.result.unlinked_claims[0], WARRANTY);
  assert.match(rec.result.brief_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(rec.result.review_url, `https://compass-crm-ten.vercel.app/clients/${C}/social/${drafted}`);
  ok("The edit: same post, run and destination; new copy, exactly the listed claims, a fresh review task; history is the assistant's with the receipt");

  // 4c. Replay, and the team still decides.
  const again = await callApprovals(req());
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  const status = await callApprovals({ mode: "revise_status", operation_id: "sandbox-copy-0001" });
  assert.equal(status.body.receipt.post_now.review_status, "in_review");
  const v = await callApprovals({ mode: "version" });
  assert.deepEqual(v.body.edit_kinds, ["replace_media", "replace_copy"]);
  ok("A replay answers with the receipt; revise_status shows the post in review; version lists replace_copy");

  console.log(`Copy edit integration checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
