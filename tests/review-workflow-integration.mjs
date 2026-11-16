// End-to-end check of the finished review workflow (20261116150000 review to
// delivery + 20261117010000 pending changes) against a real database: the full
// migration replay behind PostgREST. The post-drafter, content-approvals and
// post-publisher are the deployed handlers and stores; the teammate is a
// signed-in team JWT; only Zernio is fake. Nothing is sent anywhere.
//
//   npm run test:review-workflow     (scripts/test-tasks-ui.sh with UI_SPEC set)
//
// Path 1, a change requested in Executive OS: the post leaves Ready while the
// change is pending, cannot be approved, and comes back when the request is
// superseded.
// Path 2, Reject with feedback → revision → fresh review: the teammate
// rejects; the operator reads the feedback in the batch; unchanged copy is
// refused; revised copy comes back through the delegated door for a fresh
// review, its approved request's hold closing itself.
// Path 3, Approve & schedule → publication confirmation: the teammate
// approves for an exact time; the publisher sends it at that time through
// (fake) Zernio and records the provider's id and URL; the queue shows it
// Published with its link.
//
// Fictional client ("Sandbox Review Roofing", example.test addresses).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { createStore as createDrafterStore } from "../supabase/functions/post-drafter/store.ts";
import { createContentApprovals } from "../supabase/functions/content-approvals/handler.ts";
import { createCopyCheck } from "../supabase/functions/content-approvals/copy-check.ts";
import { createPostTargetReader, createStore } from "../supabase/functions/content-approvals/store.ts";
import { createPostPublisher } from "../supabase/functions/post-publisher/handler.ts";
import { createStore as createPublisherStore } from "../supabase/functions/post-publisher/store.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };
import { GOOD } from "./fixtures/drafter-lucas.mjs";

const { PGRST_URL, JWT_SECRET, PSQL, PSQL_ADMIN } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL && PSQL_ADMIN, "run through npm run test:review-workflow");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const KEY = "sandbox-delegation-key";
const ZKEY = "sk_publish_sandbox_review_workflow";
const C = "00000000-0000-4000-b000-0000000000d7";
const ROOF = "00000000-0000-4000-e000-0000000000d7";
const KW = "00000000-0000-4000-d000-0000000000d7";
const OC = "00000000-0000-4000-f000-0000000000d7";
const WARRANTY = "00000000-0000-4000-f000-0000000000d8";
const LOC = "00000000-0000-4000-c000-0000000000d7";
const ZG = "d7d7d7d7d7d7d7d7d7d7d7d7";
const LOC_DIGITS = "700000000000000088";
const SITE = "https://reviewroof.example.test";
const PAGE = `${SITE}/services/roof-replacement`;
const TARGET = { channel: "google_business", postType: "standard", intent: "commercial", serviceId: ROOF, keywordId: KW, ctaType: "LEARN_MORE",
  offerId: null, assetIds: [], socialAccountId: LOC };
const NAME = "Sandbox Review Roofing";
const COPY = GOOD.replaceAll("Lucas Construction", NAME);
const REVISED =
  `Planning a roof replacement for your Wentzville home? ${NAME} keeps the work straightforward, from the first inspection ` +
  "to a clear estimate you can plan around. We're an Owens Corning Preferred Contractor, so the roof that goes on your home " +
  "is installed by a crew the manufacturer recognises. When your roof is showing its age, see how our roof replacement " +
  "process works and request a quote.";
// Executive OS approval ids (the hold refs).
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";
const R4 = "44444444-4444-4444-8444-444444444444";

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
const sqlAdmin = (q) => run(PSQL_ADMIN, `set session_replication_role = replica; ${q}`);

const rest = (key, extra = {}) => createClient(PGRST_URL.replace(/\/$/, "") + "/__", key, {
  auth: { persistSession: false, autoRefreshToken: false }, ...extra,
  global: { fetch: (u, init) => fetch(String(u).replace("/__/rest/v1", ""), init), ...(extra.global ?? {}) },
});
const service = rest(serviceKey);
const asTeam = rest(anonKey, { global: { headers: { Authorization: `Bearer ${teamToken}` } } });

const drafterStore = createDrafterStore(service);
const drafter = createPostDrafter({ store: drafterStore, gazetteer });
const copyCheck = createCopyCheck({
  postTarget: createPostTargetReader(service),
  input: (c, s, k) => drafterStore.input(c, s, k),
  socialAccounts: (c) => drafterStore.socialAccounts(c),
  gazetteer,
});
const approvals = createContentApprovals({ store: createStore(service), copyCheck });

// A fake Zernio for googlebusiness: the account, its locations, health, and posts.
const zernio = { creates: [], posts: new Map() };
const zfetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  const headers = init.headers ?? {};
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  assert.equal(headers.Authorization, `Bearer ${ZKEY}`, "only the publish key is ever sent");
  assert.notEqual(u.host, "mybusiness.googleapis.com", "never Google's direct API");
  const path = u.pathname.replace(/^\/api/, "");
  if (method === "GET" && path === "/v1/accounts") {
    return json(200, { accounts: u.searchParams.get("platform") === "googlebusiness" ? [{ _id: ZG, platform: "googlebusiness", displayName: NAME, isActive: true }] : [], pagination: { pages: 1 } });
  }
  if (method === "GET" && /\/gmb-locations$/.test(path)) {
    return json(200, { locations: [{ id: LOC_DIGITS, name: NAME, address: "Wentzville, MO", websiteUrl: `${SITE}/`, accountId: "accounts/777" }], selectedLocationId: LOC_DIGITS, hasMore: false, cached: true });
  }
  if (method === "GET" && /\/health$/.test(path)) {
    return json(200, { status: "healthy", tokenStatus: { valid: true }, permissions: { posting: [{ scope: "business.manage", granted: true, required: true }] } });
  }
  if (method === "POST" && path === "/v1/posts") {
    const body = JSON.parse(init.body);
    zernio.creates.push({ key: headers["Idempotency-Key"], body });
    const id = `zr${String(zernio.posts.size + 1).padStart(22, "0")}`;
    const t = body.platforms[0];
    const post = { _id: id, content: body.content, status: "published", platforms: [{ platform: t.platform, accountId: { _id: t.accountId },
      platformSpecificData: t.platformSpecificData, status: "published", platformPostId: "98765432109876541",
      platformPostUrl: `https://business.google.com/posts/l/${LOC_DIGITS}/p1`, publishedAt: new Date().toISOString() }] };
    zernio.posts.set(id, post);
    return json(201, { post });
  }
  if (method === "GET" && path.startsWith("/v1/posts/")) {
    const id = path.split("/").pop();
    return zernio.posts.has(id) ? json(200, { post: zernio.posts.get(id) }) : json(404, { error: "Post not found" });
  }
  return json(404, { error: `unexpected ${method} ${path}` });
};
let clock = new Date();
const publisher = createPostPublisher({ store: createPublisherStore(service), fetch: zfetch, now: () => clock, googleTimeoutMs: 2000 });

const callDrafter = async (body) => {
  const r = await drafter.handle(new Request("http://x/post-drafter", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const callApprovals = async (body) => {
  const r = await approvals.handle(new Request("http://x/content-approvals", { method: "POST", headers: { "content-type": "application/json", "x-compass-delegation-key": KEY }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const queueItem = async (id) => {
  const { data, error } = await asTeam.rpc("review_queue", { p_client: C });
  assert.equal(error, null, error?.message);
  return data.find((i) => i.id === id);
};
const batchItem = async (id) => (await callApprovals({ mode: "batch", client_id: C, channel: "google_business" })).body.items.find((i) => i.id === id);
const holdRow = (ref) => sql(`select coalesce(close_reason, 'open') from content_edit_holds where ref = '${ref}'`);
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

// ── Fixture: a fictional roofing client with a Zernio-bound Business Profile ──
sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET')`);
sql(`select vault.create_secret('${KEY}', 'EXECUTIVE_OS_DELEGATION_SECRET')`);
sql(`select vault.create_secret('${ZKEY}', 'ZERNIO_PUBLISH_API_KEY')`);
sql(`update team_members set role = 'admin' where email = '${TEAM.email}'`);
sql(`insert into clients (id, name, city, state, phone, website_url, business_type, service_area, status)
     values ('${C}', '${NAME}', 'Wentzville', 'MO', '(636) 555-0188', '${SITE}', 'service_area',
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
     values ('${C}', 1, 'approved', 'Request a quote', array['Never quote or imply pricing.', 'Only one phone number: (636) 555-0188.'])`);
sql(`insert into services (id, client_id, name, status, page_url, segment, sort_order) values
     ('${ROOF}', '${C}', 'Roof Replacement', 'approved', '${PAGE}', 'Roofing', 1)`);
sql(`insert into keywords (id, client_id, keyword, intent, is_active, is_tracked, is_money, service_id, target_url, priority)
     values ('${KW}', '${C}', 'roof replacement wentzville', 'commercial', true, true, true, '${ROOF}', '${PAGE}', 'p1')`);
sql(`update services set primary_keyword_id = '${KW}' where id = '${ROOF}'`);
sql(`insert into claims (id, client_id, claim, status, source) values
     ('${OC}', '${C}', 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/roofing/contractors/contractor-profile/8'),
     ('${WARRANTY}', '${C}', 'Lifetime Workmanship Warranty', 'sourced', '${PAGE}')`);
sql(`insert into locations (client_id, name, city, state) values ('${C}', 'Wentzville, MO', 'Wentzville', 'MO')`);
sql(`insert into page_groups (client_id, name, page_type, status, target_url, primary_keyword_id, supporting_keyword_ids)
     values ('${C}', 'Roof Replacement', 'service', 'approved', '${PAGE}', '${KW}', '{}')`);
// The verified, enabled Zernio binding (its guard admits only the publisher and a team admin; set as a fixture).
sqlAdmin(`insert into social_accounts (id, client_id, platform, external_account_id, display_name, publish_provider, publish_account_id,
            publish_page_id, publish_account_name, publish_verified_at, publish_health, publish_enabled, publish_enabled_by, publish_enabled_at)
     values ('${LOC}', '${C}', 'google_business', 'locations/${LOC_DIGITS}', '${NAME}', 'zernio', '${ZG}', 'locations/${LOC_DIGITS}', '${NAME}', now(),
             '{"status": "healthy"}', true, (select id from team_members where email = '${TEAM.email}'), now())`);
sqlAdmin(`insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind) values ('${C}', 'zernio', 'publisher')`);
sql(`update app_settings set value = jsonb_build_object('enabled', true, 'clients', jsonb_build_array('${C}')) where key = 'publisher'`);

try {
  // ── The post: drafted by the real post-drafter, in review, no image on purpose ──
  const b = await callDrafter({ mode: "brief", client_id: C, target: TARGET });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const s = await callDrafter({ mode: "submit", client_id: C, target: TARGET, brief_hash: b.body.brief_hash,
    draft: { copy: COPY, claim_ids: [OC, WARRANTY] }, runtime: "sandbox-model" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const post = s.body.post_id;
  const { error: reasonErr } = await asTeam.rpc("social_post_set_no_image_reason", { p_post: post, p_reason: "Sandbox: no job photo for this location yet." });
  assert.equal(reasonErr, null, reasonErr?.message);
  let q = await queueItem(post);
  assert.equal(q.stage, "ready", JSON.stringify({ stage: q.stage, grounding: q.grounding_problems, publish: q.publish_problems }));
  assert.deepEqual(q.publish_problems, [], "the publisher would send it");
  ok("A drafted Business Profile post in review, grounded, with a stated no-image reason: Ready for final review");

  // ── Path 1: a change requested in Executive OS keeps it out of Ready ──
  let item = await batchItem(post);
  const hold = (ref, o = {}) => callApprovals({ mode: "hold", ref, client_id: C, post: { channel: "google_business", id: post }, kind: "replace_copy",
    review_hash: item.review_hash, summary: "Revise one Business Profile post in Compass: replace its copy", requested_by: "Claude via Executive OS", ...o });
  let h = await hold(R1);
  assert.equal(h.status, 201, JSON.stringify(h.body));
  assert.equal((await hold(R1)).status, 200, "a repeat replays the same hold");
  q = await queueItem(post);
  assert.equal(q.stage, "needs_preparation");
  assert.equal(q.pending_changes.length, 1);
  assert.equal(q.pending_changes[0].ref, R1);
  assert.equal((await batchItem(post)).pending_changes[0].ref, R1, "the operator sees it in the batch too");
  const { error: approveErr } = await asTeam.rpc("social_post_approve_and_schedule", {
    p_post: post, p_submitted_at: q.submitted_at, p_publish_at: new Date(Date.now() + 10 * 60_000).toISOString(), p_note: null });
  assert.match(approveErr?.message ?? "", /pending_change: a copy change for this post is waiting in Executive OS/);
  const { error: approveOnlyErr } = await asTeam.from("social_posts").update({ review_status: "approved" }).eq("id", post);
  assert.match(approveOnlyErr?.message ?? "", /pending_change/);
  ok("Path 1: an Executive OS request opens a hold; the post moves to Needs preparation with the pending change and cannot be approved (Approve & schedule or Approve only)");

  const rel = await callApprovals({ mode: "release", ref: R1, reason: "superseded", superseded_by_ref: R2, note: "Refiled against the new review hash" });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.released, true);
  assert.equal(rel.body.hold.close_reason, "superseded");
  assert.equal((await callApprovals({ mode: "release", ref: R1, reason: "withdrawn" })).body.released, false, "a second release changes nothing");
  assert.equal((await queueItem(post)).stage, "ready");
  ok("Path 1: superseding the request releases the hold (kept as a record); the post is Ready again");

  // ── Path 2: Reject with feedback → revision → fresh review ──
  const { error: rejectErr } = await asTeam.from("social_posts")
    .update({ review_status: "rejected", review_note: "Lead with the inspection and the Owens Corning credential, not the warranty.", rejection_category: "copy" })
    .eq("id", post);
  assert.equal(rejectErr, null, rejectErr?.message);
  q = await queueItem(post);
  assert.equal(q.stage, "revising");
  assert.match(q.last_feedback, /^Lead with the inspection/);
  item = await batchItem(post);
  assert.equal(item.status, "rejected");
  assert.match(item.feedback, /^Lead with the inspection/);
  assert.equal(item.rejection_category, "copy");
  ok("Path 2: rejected with feedback; the queue shows it revising; the operator's batch carries the feedback and category");

  const revise = (op, copy, ref) => callApprovals({
    mode: "revise", operation_id: op, client_id: C,
    post: { channel: "google_business", id: post, service_id: item.service_id, review_hash: item.review_hash, destination: item.destination },
    change: { kind: "replace_copy", copy, claim_ids: [OC] },
    executor: { channel: "claude", executed_by: "Claude via Executive OS", account_email: TEAM.email },
    authority: { kind: "owner_approval", id: ref, channels: ["google_business"], service_ids: [ROOF], operations: ["replace_copy"] },
    reason: "Tom's feedback on the post.",
  });
  h = await hold(R3);
  assert.equal(h.status, 201, JSON.stringify(h.body));
  const same = await revise("sandbox-review-same", sql(`select copy from social_posts where id = '${post}'`), R3);
  assert.equal(same.status, 422, JSON.stringify(same.body));
  assert.equal(holdRow(R3), "refused", "a refused approved revision closes its hold");
  assert.equal(sql(`select review_status from social_posts where id = '${post}'`), "rejected");
  ok(`Path 2: the same copy cannot come back (${same.body.error}); its hold closes as refused; the post stays rejected`);

  h = await hold(R4);
  assert.equal(h.status, 201, JSON.stringify(h.body));
  const good = await revise("sandbox-review-revised", REVISED, R4);
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.receipt.status, "executed");
  assert.equal(holdRow(R4), "executed", "the approved revision closed its own hold");
  assert.equal(sql(`select review_status || '|' || publish_status || '|' || (approved_hash is null) || '|' || (rejected_copy_hash is null) from social_posts where id = '${post}'`),
    "in_review|not_scheduled|true|true");
  assert.equal(sql(`select string_agg(kind, ',' order by id) from social_post_history where post_id = '${post}'`), "rejected,copy_changed,resubmitted");
  q = await queueItem(post);
  assert.equal(q.stage, "ready");
  assert.equal(q.copy, REVISED);
  ok("Path 2: the revised copy comes back through the delegated door for a fresh review (never approved by it); history keeps rejected → copy_changed → resubmitted; Ready");

  // ── Path 3: Approve & schedule → publication confirmation ──
  const at = new Date(Date.now() + 5 * 60_000);
  const { data: scheduled, error: schedErr } = await asTeam.rpc("social_post_approve_and_schedule", {
    p_post: post, p_submitted_at: q.submitted_at, p_publish_at: at.toISOString(), p_note: "Sandbox: approved for this time." });
  assert.equal(schedErr, null, schedErr?.message);
  assert.equal(scheduled.review_status, "approved");
  assert.equal(scheduled.publish_status, "scheduled");
  assert.equal(new Date(scheduled.approved_publish_at).getTime(), at.getTime(), "the approval is bound to the time");
  assert.equal(scheduled.approved_destination, `google_business:locations/${LOC_DIGITS}`);
  assert.equal((await queueItem(post)).stage, "scheduled");

  // Before its time: nothing is sent.
  clock = new Date(at.getTime() - 60_000);
  await publisher.tick({ mode: "tick" });
  assert.equal(zernio.creates.length, 0, "nothing goes out before the approved time");
  assert.equal(sql(`select publish_status from social_posts where id = '${post}'`), "scheduled");
  // At its time: sent once, confirmed, recorded.
  clock = new Date(at.getTime() + 60_000);
  await publisher.tick({ mode: "tick" });
  assert.equal(zernio.creates.length, 1, "sent exactly once");
  assert.equal(zernio.creates[0].body.content, REVISED, "the approved copy, exactly");
  assert.deepEqual(zernio.creates[0].body.platforms[0].platformSpecificData.locationId, `locations/${LOC_DIGITS}`);
  assert.equal(sql(`select publish_status || '|' || external_post_id || '|' || published_url from social_posts where id = '${post}'`),
    `published|98765432109876541|https://business.google.com/posts/l/${LOC_DIGITS}/p1`);
  assert.match(sql(`select string_agg(outcome || ':' || transport, ',' order by id) from publisher_runs where post_id = '${post}'`), /published:zernio$/);
  await publisher.tick({ mode: "tick" });
  assert.equal(zernio.creates.length, 1, "a later tick does not send it again");
  q = await queueItem(post);
  assert.equal(q.stage, "published");
  assert.equal(q.published_url, `https://business.google.com/posts/l/${LOC_DIGITS}/p1`);
  assert.equal(q.external_post_id, "98765432109876541");
  ok("Path 3: Approve & schedule binds time and destination; the publisher sends nothing early, then once at the time; the provider's id and URL are recorded; the queue shows Published with its link");

  console.log(`Review workflow integration checks passed (${checks.length}).`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
