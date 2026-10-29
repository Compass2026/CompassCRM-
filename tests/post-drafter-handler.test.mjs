// post-drafter (AI Drafter D2) request boundary, over a fake store: auth,
// the brief / check / submit / version modes, stale briefs, the attempt cap,
// lint failures recorded as runs, and one drafter_write per accepted submit.
// End to end against PostgREST + the sandbox replay: tests/drafter-integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { OC, WARRANTY, lucas, TARGET, GAZETTEER, GOOD } from "./fixtures/drafter-lucas.mjs";

const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const MEMBER = "11111111-1111-4111-8111-111111111111";

function fakeStore(over = {}) {
  const calls = { runs: [], writes: [] };
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron-secret" : null),
    teamMemberForJwt: async (jwt) => (jwt === "team-jwt" ? MEMBER : null),
    input: async (id) => (id === CLIENT ? lucas() : null),
    socialAccounts: async () => [],
    attempts: async (_c, hash) => calls.runs.filter((r) => r.brief_hash === hash).length + calls.writes.filter((w) => w.brief_hash === hash).length,
    recordRun: async (r) => { calls.runs.push(r); },
    write: async (p) => { calls.writes.push(p); return { run_id: "run-1", post_id: "post-1", review_task_id: "task-1" }; },
    ...over,
  };
  return { store, calls };
}
const drafter = (store) => createPostDrafter({ store, gazetteer: { MO: GAZETTEER } });
const req = (body, headers = { "x-cron-secret": "cron-secret" }) =>
  new Request("http://x/post-drafter", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const call = async (d, body, headers) => { const r = await d.handle(req(body, headers)); return { status: r.status, body: await r.json() }; };
const draft = { copy: GOOD, claim_ids: [OC, WARRANTY] };

async function briefHash(d) {
  const r = await call(d, { mode: "brief", client_id: CLIENT, target: TARGET });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.brief_hash;
}

test("callers: the worker's cron secret or a team member; nobody else", async () => {
  const { store } = fakeStore();
  const d = drafter(store);
  assert.equal((await call(d, { mode: "version" }, {})).status, 401);
  assert.equal((await call(d, { mode: "version" }, { "x-cron-secret": "wrong" })).status, 403);
  assert.equal((await call(d, { mode: "version" }, { Authorization: "Bearer anon-key" })).status, 403);
  assert.equal((await call(d, { mode: "version" }, { Authorization: "Bearer team-jwt" })).status, 200);
  const v = await call(d, { mode: "version" });
  assert.deepEqual(v.body.modes, ["brief", "check", "submit", "version"]);
  assert.equal(v.body.max_attempts, 3);
});

test("there is no approve, schedule or publish mode", async () => {
  const d = drafter(fakeStore().store);
  for (const mode of ["approve", "schedule", "publish", "write", undefined]) {
    const r = await call(d, { mode, client_id: CLIENT, target: TARGET });
    assert.equal(r.status, 400, String(mode));
  }
});

test("brief: rebuilt from live data, with its hash and the vendor-neutral model request", async () => {
  const d = drafter(fakeStore().store);
  const r = await call(d, { mode: "brief", client_id: CLIENT, target: TARGET });
  assert.equal(r.status, 200);
  assert.match(r.body.brief_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.body.brief.target.service.id, TARGET.serviceId);
  assert.equal(r.body.model_request.output_contract.copy, "string");
  assert.equal((await call(d, { mode: "brief", client_id: "00000000-0000-4000-8000-000000000000", target: TARGET })).status, 404);
  const bad = await call(d, { mode: "brief", client_id: CLIENT, target: { ...TARGET, channel: "instagram" } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.refusals[0].code, "channel_unsupported");
});

test("check: lints against the live brief and writes nothing", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await briefHash(d);
  const ok = await call(d, { mode: "check", client_id: CLIENT, target: TARGET, brief_hash: hash, draft });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body.problems));
  const bad = await call(d, { mode: "check", client_id: CLIENT, target: TARGET, brief_hash: hash, draft: { ...draft, copy: GOOD + " The best roofer in town." } });
  assert.equal(bad.body.ok, false);
  assert.ok(bad.body.problems.some((p) => p.code === "unsupported_superlative"));
  assert.match(bad.body.revision_request.instructions, /previous draft was refused/);
  const stale = await call(d, { mode: "check", client_id: CLIENT, target: TARGET, brief_hash: "sha256:" + "0".repeat(64), draft });
  assert.equal(stale.status, 409);
  assert.equal(calls.runs.length + calls.writes.length, 0);
});

test("submit: one drafter_write with the server's brief, hash and lint; the caller's runtime label", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await briefHash(d);
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft, runtime: "claude-worker-skill" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "in_review");
  assert.equal(r.body.post_id, "post-1");
  assert.equal(calls.writes.length, 1);
  const w = calls.writes[0];
  assert.equal(w.brief_hash, hash);
  assert.equal(w.requested_via, "worker");
  assert.equal(w.requested_by, null);
  assert.equal(w.runtime, "claude-worker-skill");
  assert.equal(w.attempt, 1);
  assert.equal(w.lint.ok, true);
  assert.equal(w.copy, GOOD);
  assert.deepEqual(w.claim_ids, [OC, WARRANTY]);
  assert.deepEqual(w.asset_ids, []);
  assert.equal(w.brief.target.cta.url, "https://lucasconstructionmo.com/services/roof-replacement");
  assert.equal(calls.runs.length, 0);
});

test("submit by a team member is recorded as theirs", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await briefHash(d);
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft, runtime: "manual" }, { Authorization: "Bearer team-jwt" });
  assert.equal(r.status, 201);
  assert.equal(calls.writes[0].requested_via, "team");
  assert.equal(calls.writes[0].requested_by, MEMBER);
});

test("submit: a stale brief is refused and recorded, never written", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const old = "sha256:" + "ab".repeat(32);
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: old, draft, runtime: "w" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "stale_brief");
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.runs.length, 1);
  assert.equal(calls.runs[0].status, "stale_brief");
  assert.equal(calls.runs[0].brief_hash, old);
});

test("submit: a draft that fails the linter is recorded, never written", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await briefHash(d);
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft: { ...draft, copy: GOOD + " Family owned since 1998." }, runtime: "w" });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "lint_failed");
  assert.equal(r.body.attempts_left, 2);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.runs[0].status, "lint_failed");
  assert.equal(calls.runs[0].lint.ok, false);
});

test("submit: at most three attempts per brief, counted by the server", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await briefHash(d);
  const badDraft = { ...draft, copy: GOOD + " The best roofer in town." };
  for (let i = 1; i <= 3; i++) {
    const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft: badDraft, runtime: "w", attempt: 1 });
    assert.equal(r.status, 422);
    assert.equal(r.body.attempt, i, "the caller cannot reset its own attempt number");
  }
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft, runtime: "w" });
  assert.equal(r.status, 429);
  assert.equal(calls.writes.length, 0);
});

test("submit: a database refusal (grounding, duplicate) is recorded and reported", async () => {
  const { store, calls } = fakeStore({ write: async () => ({ error: { code: "23505", message: "An open drafted post already exists for this service and intent" } }) });
  const d = drafter(store);
  const hash = await briefHash(d);
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft, runtime: "w" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "refused");
  assert.equal(calls.runs[0].status, "refused");
  assert.match(calls.runs[0].detail, /^23505 An open drafted post/);
});

test("submit validates its inputs before touching anything", async () => {
  const { store, calls } = fakeStore();
  const d = drafter(store);
  const hash = await briefHash(d);
  const base = { mode: "submit", client_id: CLIENT, target: TARGET, brief_hash: hash, draft, runtime: "w" };
  assert.equal((await call(d, { ...base, runtime: "" })).status, 400);
  assert.equal((await call(d, { ...base, runtime: "x".repeat(81) })).status, 400);
  assert.equal((await call(d, { ...base, draft: { copy: "", claim_ids: [] } })).status, 400);
  assert.equal((await call(d, { ...base, draft: { copy: GOOD, claim_ids: ["not-a-uuid"] } })).status, 400);
  assert.equal((await call(d, { ...base, client_id: "x" })).status, 400);
  assert.equal((await call(d, { ...base, target: { ...TARGET, serviceId: "x" } })).status, 400);
  assert.equal(calls.runs.length + calls.writes.length, 0);
});

// ── Business Profile destinations (20261027190935) ───────────────────────────
// A Business Profile brief reads the client's verified locations, as a
// Facebook brief reads its Pages: a draft may name its own location, an
// unnamed draft takes the client's only one, and with several it must name
// one. Until Oct 29 2026 the handler loaded accounts for Facebook only, so a
// named location was always refused as unknown.
const LOCATION = "543793e4-5d63-4358-8432-4b96f534cd67";
const SECOND = "c0000000-0000-4000-8000-0000000000c2";
const verified = (id, page) => ({ id, platform: "google_business", external_account_id: page, display_name: "LUCAS Construction and Roofing",
  publish_provider: "zernio", publish_page_id: page, publish_verified_at: "2026-10-11T22:00:47Z" });
const PAGE_ROW = { id: "1ab8af8e-d720-47ed-8818-e0f2fa91a01e", platform: "facebook", external_account_id: "103977857788955", display_name: "LUCAS Construction",
  publish_provider: "zernio", publish_page_id: "103977857788955", publish_verified_at: "2026-10-11T22:00:47Z" };
const withAccounts = (rows) => fakeStore({ socialAccounts: async (id) => (id === CLIENT ? rows : []) });

test("Business Profile: a named verified location is accepted, carried in the brief and written to", async () => {
  const { store, calls } = withAccounts([verified(LOCATION, "locations/3692365240387501506"), PAGE_ROW]);
  const d = drafter(store);
  const target = { ...TARGET, socialAccountId: LOCATION };
  const b = await call(d, { mode: "brief", client_id: CLIENT, target });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(b.body.brief.target.social_account,
    { id: LOCATION, page_id: "locations/3692365240387501506", name: "LUCAS Construction and Roofing" });
  const r = await call(d, { mode: "submit", client_id: CLIENT, target, brief_hash: b.body.brief_hash, draft, runtime: "claude-worker-skill" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].brief.target.social_account.id, LOCATION);
});

test("Business Profile: never another destination: a Facebook Page, an unverified or another client's location", async () => {
  const unverified = { ...verified(SECOND, "locations/2"), publish_verified_at: null };
  const notZernio = { ...verified(SECOND, "locations/2"), publish_provider: null };
  for (const [rows, id] of [
    [[verified(LOCATION, "locations/1"), PAGE_ROW], PAGE_ROW.id],
    [[verified(LOCATION, "locations/1"), unverified], SECOND],
    [[verified(LOCATION, "locations/1"), notZernio], SECOND],
    [[verified(LOCATION, "locations/1")], "d0000000-0000-4000-8000-0000000000d4"],
  ]) {
    const r = await call(drafter(withAccounts(rows).store), { mode: "brief", client_id: CLIENT, target: { ...TARGET, socialAccountId: id } });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.ok(r.body.refusals.some((f) => f.code === "social_account_unknown"), JSON.stringify(r.body.refusals));
  }
});

test("Business Profile: unnamed, the only location gives the same brief as before; with several, the draft names one", async () => {
  const before = await call(drafter(fakeStore().store), { mode: "brief", client_id: CLIENT, target: TARGET });
  const one = await call(drafter(withAccounts([verified(LOCATION, "locations/1"), PAGE_ROW]).store), { mode: "brief", client_id: CLIENT, target: TARGET });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal("social_account" in one.body.brief.target, false);
  assert.equal(one.body.brief_hash, before.body.brief_hash, "an unnamed single-location brief is unchanged, so no brief in review goes stale");
  const two = await call(drafter(withAccounts([verified(LOCATION, "locations/1"), verified(SECOND, "locations/2")]).store),
    { mode: "brief", client_id: CLIENT, target: TARGET });
  assert.equal(two.status, 422);
  assert.ok(two.body.refusals.some((f) => f.code === "social_account_missing"), JSON.stringify(two.body.refusals));
});
