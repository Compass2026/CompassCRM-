// post-drafter v2, Authority mode (migration 0053), over a fake store: the
// target derived from the opportunity (never the caller's), Authority checks
// in brief / check / submit, target and evidence disagreements refused, live
// cadence, duplicate_recent_post, the teammate's request for submit, and no
// Drafter run recorded for an Authority conflict. The Drafter's own refusals
// stay authoritative. End to end: tests/drafter-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostDrafter, chicagoDay } from "../supabase/functions/post-drafter/handler.ts";
import { OC, WARRANTY, REVIEWS, ROOF, KW, PAGE, lucas, TARGET, GAZETTEER, GOOD } from "./fixtures/drafter-lucas.mjs";

const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const OPP = "70ac7544-cd22-4221-ae61-d5d5daf9d9b5";
const RUN = "082e8e2a-94cf-4b03-b385-2c7cd7fb239b";
const OLD_RUN = "00000000-0000-4000-8000-00000000aaaa";
const TASK = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-27T18:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const opportunity = (over = {}) => ({
  id: OPP, client_id: CLIENT, key: `gbp_post:${ROOF}:commercial`, present: true, last_seen_run_id: RUN,
  status: "open", section: "ready", action: "create", tier: "B", content_type: "gbp_post", topic: "Roof Replacement",
  service_id: ROOF, keyword_id: KW, intent: "commercial", target_path: "/services/roof-replacement",
  eligible_from: null, cycle_started_at: null,
  opportunity: {
    objective: "Reach homeowners comparing roof replacement options.", gap: "No commercial Business Profile post for Roof Replacement.",
    target: { keyword: "roof replacement wentzville", cta: "LEARN_MORE", owner_path: "/services/roof-replacement" },
    evidence_claim_ids: [OC], reasons: [{ tag: "FACT", text: "No post in 21 days." }],
  },
  ...over,
});
const state = (over = {}) => ({
  opportunity: opportunity(over.opportunity),
  latest_run: { id: RUN, engine_version: "authority-v1.3", site: "https://lucasconstructionmo.com" },
  post_links: [],
  request: { task_id: TASK, status: "open", requested_by_team: true },
  recent_posts: [],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "opportunity")),
});

function fakeStore(s = state()) {
  const calls = { runs: [], writes: [], authority: 0 };
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron-secret" : null),
    teamMemberForJwt: async () => null,
    input: async (id) => (id === CLIENT ? lucas() : null),
    authority: async (c, o, now) => { calls.authority++; assert.equal(now.getTime(), NOW.getTime()); return typeof s === "function" ? s() : s; },
    attempts: async (_c, hash) => calls.runs.filter((r) => r.brief_hash === hash).length + calls.writes.filter((w) => w.brief_hash === hash).length,
    recordRun: async (r) => { calls.runs.push(r); },
    write: async (p) => { calls.writes.push(p); return { run_id: "run-1", post_id: "post-1", review_task_id: "task-1" }; },
  };
  return { store, calls };
}
const drafter = (store) => createPostDrafter({ store, gazetteer: { MO: GAZETTEER }, now: () => NOW });
const call = async (d, body) => {
  const r = await d.handle(new Request("http://x/post-drafter", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron-secret" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const A = (mode, extra = {}) => ({ mode, client_id: CLIENT, authority_opportunity_id: OPP, ...extra });
const draft = { copy: GOOD, claim_ids: [OC, WARRANTY] };
async function hashOf(d) {
  const r = await call(d, A("brief"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.brief_hash;
}

test("version: v2 with Authority mode and the duplicate rule", async () => {
  const v = await call(drafter(fakeStore().store), { mode: "version" });
  assert.equal(v.body.version, 2);
  assert.deepEqual(v.body.features, ["authority_mode", "duplicate_recent_post"]);
  assert.deepEqual(v.body.modes, ["brief", "check", "submit", "version"]);
});

test("brief: target derived from the opportunity; the Drafter's own brief plus brief.authority", async () => {
  const d = drafter(fakeStore().store);
  const r = await call(d, A("brief"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body.brief;
  assert.equal(b.target.service.id, ROOF);
  assert.equal(b.target.keyword.id, KW);
  assert.equal(b.target.search_intent, "commercial");
  assert.equal(b.target.cta.type, "LEARN_MORE");
  assert.equal(b.target.cta.url, PAGE);
  assert.equal(b.target.post_type, "standard");
  assert.deepEqual(b.target.assets, []);
  assert.equal(b.authority.opportunity_id, OPP);
  assert.equal(b.authority.run_id, RUN);
  assert.equal(b.authority.engine_version, "authority-v1.3");
  assert.equal(b.authority.objective, "Reach homeowners comparing roof replacement options.");
  assert.deepEqual(b.authority.preferred_claim_ids, [OC]);
  assert.deepEqual(b.allowed_facts.recommended_claim_ids, [OC], "the analysis's evidence becomes the recommendation");
  assert.deepEqual(b.authority.cadence, { days: 21, eligible_from: null });
  assert.deepEqual(r.body.request, { task_id: TASK, status: "open" });
  assert.equal(r.body.authority_opportunity_id, OPP);
  assert.match(r.body.model_request.instructions, /Authority opportunity \(Roof Replacement, commercial, "roof replacement wentzville"\)/);
  assert.match(r.body.model_request.instructions, /"Owens Corning Preferred Contractor"/);

  // The same allowed facts as the v1 brief for the same target: Authority only adds.
  const v1 = await call(d, { mode: "brief", client_id: CLIENT, target: TARGET });
  assert.deepEqual(b.allowed_facts.claims, v1.body.brief.allowed_facts.claims);
  assert.deepEqual(b.excluded, v1.body.brief.excluded);
  assert.equal(v1.body.brief.authority, undefined);
  assert.notEqual(r.body.brief_hash, v1.body.brief_hash);
});

test("the caller cannot name or override the target", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  for (const target of [TARGET, { ...TARGET, keywordId: null }, {}]) {
    const r = await call(d, A("brief", { target }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "target_not_allowed");
  }
  assert.equal((await call(d, A("brief", { authority_opportunity_id: "nope" }))).status, 400);
  assert.equal((await call(d, A("brief", { expected_run_id: "nope" }))).status, 400);
  assert.equal(calls.authority, 0);
});

test("stale expected run, non-current or unknown opportunity: refused in brief, check and submit alike", async () => {
  const cases = [
    [state(), { expected_run_id: OLD_RUN }, 409, "authority_stale"],
    [state({ latest_run: { id: "00000000-0000-4000-8000-00000000bbbb", engine_version: "authority-v1.3", site: "https://lucasconstructionmo.com" } }), {}, 409, "opportunity_not_current"],
    [state({ opportunity: { present: false } }), {}, 409, "opportunity_not_current"],
    [{ ...state(), opportunity: null }, {}, 404, "opportunity_not_found"],
    [state({ opportunity: { client_id: "00000000-0000-4000-8000-00000000cccc" } }), {}, 404, "opportunity_not_found"],
    [state({ opportunity: { status: "dismissed" } }), {}, 409, "dismissed"],
    [state({ opportunity: { section: "blocked", action: "blocked_data_prerequisite" } }), {}, 409, "not_ready"],
    [state({ opportunity: { eligible_from: "2026-10-16" } }), {}, 409, "cadence_active"],
  ];
  for (const [s, extra, status, code] of cases) {
    const { store, calls } = fakeStore(s);
    const d = drafter(store);
    for (const mode of ["brief", "check", "submit"]) {
      const r = await call(d, A(mode, { ...extra, brief_hash: "sha256:" + "0".repeat(64), draft, runtime: "test" }));
      assert.equal(r.status, status, `${code} ${mode}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "authority_conflict");
      assert.equal(r.body.code, code, mode);
    }
    assert.equal(calls.runs.length + calls.writes.length, 0, `${code}: an Authority conflict records no Drafter run`);
  }
  // The matching expected run is accepted.
  assert.equal((await call(drafter(fakeStore().store), A("brief", { expected_run_id: RUN }))).status, 200);
  // Eligible today (Chicago) is eligible.
  assert.equal((await call(drafter(fakeStore(state({ opportunity: { eligible_from: chicagoDay(NOW) } })).store), A("brief"))).status, 200);
});

test("cadence rechecked live: a post made after the analysis refuses; a rejected one or an older one does not", async () => {
  const post = (over) => ({ id: "p1", service_id: ROOF, search_intent: "commercial", review_status: "in_review", publish_status: "not_scheduled", created_at: daysAgo(3), copy: "Something else entirely about gutters and siding for a change of pace.", ...over });
  const live = await call(drafter(fakeStore(state({ recent_posts: [post()] })).store), A("brief"));
  assert.equal(live.status, 409);
  assert.equal(live.body.code, "cadence_active");
  const published = await call(drafter(fakeStore(state({ recent_posts: [post({ review_status: "approved", publish_status: "published", created_at: daysAgo(20) })] })).store), A("brief"));
  assert.equal(published.body.code, "cadence_active");
  for (const p of [post({ review_status: "rejected" }), post({ created_at: daysAgo(22), review_status: "approved" }), post({ search_intent: "transactional" }), post({ service_id: "other" })]) {
    const r = await call(drafter(fakeStore(state({ recent_posts: [p] })).store), A("brief"));
    assert.equal(r.status, 200, JSON.stringify(p));
  }
});

test("an active or completed linked post this cycle refuses; one from an earlier cycle does not", async () => {
  const link = (review_status, created_at = daysAgo(30), publish_status = "not_scheduled") => ({ created_at, review_status, publish_status });
  for (const l of [link("in_review"), link("draft"), link("approved"), link("approved", daysAgo(30), "published")]) {
    const r = await call(drafter(fakeStore(state({ post_links: [l] })).store), A("brief"));
    assert.equal(r.status, 409, JSON.stringify(l));
    assert.equal(r.body.code, "already_in_progress");
  }
  // A rejected post leaves it draftable again.
  assert.equal((await call(drafter(fakeStore(state({ post_links: [link("rejected")] })).store), A("brief"))).status, 200);
  // A new cadence cycle: the older approved post no longer counts.
  const s = state({ post_links: [link("approved", daysAgo(30))], opportunity: { cycle_started_at: daysAgo(1) } });
  assert.equal((await call(drafter(fakeStore(s).store), A("brief"))).status, 200);
});

test("Authority and the Drafter disagreeing on the target refuses; the Drafter never adapts", async () => {
  const page = await call(drafter(fakeStore(state({ opportunity: { target_path: "/roofing" } })).store), A("brief"));
  assert.equal(page.status, 409);
  assert.equal(page.body.code, "target_mismatch");
  assert.match(page.body.message, /page \(\/roofing vs https:\/\/lucasconstructionmo\.com\/services\/roof-replacement\)/);
  const key = await call(drafter(fakeStore(state({ opportunity: { key: `gbp_post:${ROOF}:transactional` } })).store), A("brief"));
  assert.equal(key.body.code, "target_mismatch");
  // The Drafter's own refusals stay authoritative (422, as in v1).
  const kw = await call(drafter(fakeStore(state({ opportunity: { keyword_id: "kw-info" } })).store), A("brief"));
  assert.equal(kw.status, 422);
  assert.ok(kw.body.refusals.some((r) => r.code === "keyword_intent_mismatch"), JSON.stringify(kw.body));
  assert.equal(kw.body.authority_opportunity_id, OPP);
  const svc = await call(drafter(fakeStore(state({ opportunity: { service_id: "2d53aa66-3353-4ea7-b5b9-fd1961a69788", key: "gbp_post:2d53aa66-3353-4ea7-b5b9-fd1961a69788:commercial", keyword_id: null } })).store), A("brief"));
  assert.equal(svc.status, 422);
  assert.ok(svc.body.refusals.some((r) => r.code === "target_page_missing"));
});

test("Authority evidence must be claims the Drafter itself allows", async () => {
  const r = await call(drafter(fakeStore(state({ opportunity: { opportunity: { ...opportunity().opportunity, evidence_claim_ids: [OC, REVIEWS] } } })).store), A("brief"));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "evidence_ineligible");
  assert.match(r.body.message, /100\+ 5-star reviews.*Reviews and ratings are not cited/);
  const unknown = await call(drafter(fakeStore(state({ opportunity: { opportunity: { ...opportunity().opportunity, evidence_claim_ids: ["00000000-0000-4000-8000-00000000dddd"] } } })).store), A("brief"));
  assert.equal(unknown.body.code, "evidence_ineligible");
  // No evidence: the Drafter's own recommendation stands.
  const none = await call(drafter(fakeStore(state({ opportunity: { opportunity: { ...opportunity().opportunity, evidence_claim_ids: [] } } })).store), A("brief"));
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.brief.authority.preferred_claim_ids, []);
  assert.ok(none.body.brief.allowed_facts.recommended_claim_ids.length > 0);
});

test("check: lints, adds duplicate_recent_post, reports the request, writes nothing", async () => {
  const older = { id: "p-old", service_id: ROOF, search_intent: "transactional", review_status: "approved", publish_status: "not_scheduled", created_at: daysAgo(40), copy: GOOD };
  const { store, calls } = fakeStore(state({ recent_posts: [older], request: null }));
  const d = drafter(store);
  const hash = await hashOf(d);
  const dup = await call(d, A("check", { brief_hash: hash, draft }));
  assert.equal(dup.status, 200);
  assert.equal(dup.body.ok, false);
  const p = dup.body.problems.find((x) => x.code === "duplicate_recent_post");
  assert.ok(p, JSON.stringify(dup.body.problems));
  assert.equal(p.match, "p-old");
  assert.equal(dup.body.request, null);
  assert.ok(dup.body.revision_request.instructions.includes("duplicate_recent_post"));

  const fresh = { copy: "Replacing an aging roof is a big decision for any Wentzville homeowner, and Lucas Construction wants you to have a clear picture before you commit. " +
    "We're an Owens Corning Preferred Contractor, so you can talk through your options with a team that knows the product line. " +
    "Our roof replacement page walks through what to expect, and when you're ready, request a quote and we'll set up a time to look at your roof together.", claim_ids: [OC] };
  const ok = await call(d, A("check", { brief_hash: hash, draft: fresh }));
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body.problems));
  // Opening the same way as a recent post is a duplicate even if the rest differs.
  const sameLead = await call(d, A("check", { brief_hash: hash, draft: { ...fresh, copy: GOOD.slice(0, 110) + fresh.copy.slice(110) } }));
  assert.ok(sameLead.body.problems.some((x) => x.code === "duplicate_recent_post"));
  assert.equal(calls.runs.length + calls.writes.length, 0);
  // Evidence unused is advice only.
  const noPref = await call(d, A("check", { brief_hash: hash, draft: { ...fresh, copy: fresh.copy.replace("We're an Owens Corning Preferred Contractor, so you can talk through your options with a team that knows the product line. ", "Every roof replacement we complete is backed by our Lifetime Workmanship Warranty. "), claim_ids: [WARRANTY] } }));
  assert.ok(noPref.body.warnings.some((w) => w.code === "authority_evidence_unused"), JSON.stringify(noPref.body));
});

test("the non-Authority path has no duplicate rule and no Authority reads (v1 behaviour kept)", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const b = await call(d, { mode: "brief", client_id: CLIENT, target: TARGET });
  const r = await call(d, { mode: "check", client_id: CLIENT, target: TARGET, brief_hash: b.body.brief_hash, draft });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.request, undefined);
  assert.equal(calls.authority, 0);
});

test("submit: needs a teammate's open request; refused without one, nothing recorded", async () => {
  for (const request of [null, { task_id: TASK, status: "open", requested_by_team: false }, { task_id: TASK, status: "blocked", requested_by_team: true }]) {
    const { store, calls } = fakeStore(state({ request }));
    const d = drafter(store);
    const hash = await hashOf(d);
    const r = await call(d, A("submit", { brief_hash: hash, draft, runtime: "test-model" }));
    assert.equal(r.status, 409, JSON.stringify(request));
    assert.equal(r.body.code, "not_requested");
    assert.equal(calls.runs.length + calls.writes.length, 0);
  }
});

test("submit: one drafter_write carrying the opportunity and the run it was checked against", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await hashOf(d);
  const r = await call(d, A("submit", { brief_hash: hash, draft, runtime: "test-model", expected_run_id: RUN }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.authority_opportunity_id, OPP);
  assert.equal(calls.writes.length, 1);
  const w = calls.writes[0];
  assert.equal(w.authority_opportunity_id, OPP);
  assert.equal(w.authority_run_id, RUN);
  assert.equal(w.brief.authority.opportunity_id, OPP);
  assert.deepEqual(w.brief.authority.preferred_claim_ids, [OC]);
  assert.equal(w.brief_hash, hash);
  assert.equal(calls.runs.length, 0);
});

test("submit: the Drafter's own refusals are recorded with the opportunity; a database Authority conflict is not", async () => {
  // lint failure → recorded (v1), now with the opportunity
  let f = fakeStore();
  let d = drafter(f.store);
  let hash = await hashOf(d);
  let r = await call(d, A("submit", { brief_hash: hash, draft: { ...draft, copy: GOOD + " The best roofer in town." }, runtime: "m" }));
  assert.equal(r.status, 422);
  assert.equal(f.calls.runs.length, 1);
  assert.equal(f.calls.runs[0].status, "lint_failed");
  assert.equal(f.calls.runs[0].authority_opportunity_id, OPP);

  // stale brief → recorded with the opportunity
  r = await call(d, A("submit", { brief_hash: "sha256:" + "1".repeat(64), draft, runtime: "m" }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "stale_brief");
  assert.equal(f.calls.runs[1].status, "stale_brief");
  assert.equal(f.calls.runs[1].authority_opportunity_id, OPP);

  // drafter_write refuses with AU409 (changed under the lock) → 409, no run
  f = fakeStore();
  f.store.write = async (p) => { f.calls.writes.push(p); return { error: { code: "AU409", message: "authority_conflict already_in_progress: A draft for this opportunity is already in review or approved" } }; };
  d = drafter(f.store);
  hash = await hashOf(d);
  r = await call(d, A("submit", { brief_hash: hash, draft, runtime: "m" }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "authority_conflict");
  assert.equal(r.body.code, "already_in_progress");
  assert.equal(f.calls.runs.length, 0);

  // drafter_write refuses for a Drafter reason (grounding) → recorded as in v1
  f = fakeStore();
  f.store.write = async () => ({ error: { code: "23514", message: "A linked claim is not in the brief" } });
  d = drafter(f.store);
  hash = await hashOf(d);
  r = await call(d, A("submit", { brief_hash: hash, draft, runtime: "m" }));
  assert.equal(r.status, 422);
  assert.equal(f.calls.runs[0].status, "refused");
  assert.equal(f.calls.runs[0].authority_opportunity_id, OPP);
});

test("a newer analysis changes the brief hash: a draft against the old run is stale", async () => {
  const s = state();
  const f = fakeStore(() => s);
  const d = drafter(f.store);
  const hash = await hashOf(d);
  s.opportunity.last_seen_run_id = "00000000-0000-4000-8000-00000000eeee";
  s.latest_run = { ...s.latest_run, id: "00000000-0000-4000-8000-00000000eeee" };
  const r = await call(d, A("check", { brief_hash: hash, draft }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "stale_brief");
});
