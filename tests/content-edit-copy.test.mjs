// Delegated copy edits (20261029180000): content-approvals' replace_copy over a
// fake store, and the copy check (the post-drafter's real brief and linter)
// over the Lucas fixtures. The rules themselves (authority, post state, review
// hash, destination, claims, one transaction, attribution) run in the
// database: supabase/tests/sandbox/content_edit_copy.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContentApprovals, parseRevise } from "../supabase/functions/content-approvals/handler.ts";
import { createCopyCheck, targetOf } from "../supabase/functions/content-approvals/copy-check.ts";
import { OC, WARRANTY, ROOF, KW, lucas, GAZETTEER, GOOD } from "./fixtures/drafter-lucas.mjs";

const KEY = "delegation-secret-value";
const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const POST = "eba50553-753b-4f91-93a1-b019ca82951d";
const HASH = "sha256:" + "a".repeat(64);
const BRIEF = "sha256:" + "b".repeat(64);

function fakeStore(o = {}) {
  const calls = [];
  return {
    calls,
    async secret(name) { return name === "EXECUTIVE_OS_DELEGATION_SECRET" ? KEY : null; },
    async clientsNamed() { return []; },
    async batch() { return { data: {}, error: null }; },
    async record() { return { data: null, error: null }; },
    async execute() { return { data: null, error: null }; },
    async refuse() { return { data: null, error: null }; },
    async status() { return { data: null, error: null }; },
    async editStage() { throw new Error("a copy edit stages nothing"); },
    async uploadSlot() { throw new Error("a copy edit uploads nothing"); },
    async read() { throw new Error("a copy edit reads no bytes"); },
    async editRecord(p) { calls.push(["editRecord", p]); return o.record ?? { data: { id: "rev-1", status: "recorded", storage_path: null }, error: null }; },
    async editExecute(id, measured) { calls.push(["editExecute", id, measured]); if (o.executeThrows) throw new Error("fetch failed");
      return o.execute ?? { data: { id, status: "executed", result: { review_status: "in_review", publish_status: "not_scheduled" } }, error: null }; },
    async editRefuse(id, code, message) { calls.push(["editRefuse", id, code, message]); return { data: { id, status: "refused", refusal_code: code }, error: null }; },
    async editStatus() { return { data: null, error: null }; },
  };
}

const post = (body) => new Request("https://x.supabase.co/functions/v1/content-approvals", {
  method: "POST", headers: { "content-type": "application/json", "x-compass-delegation-key": KEY }, body: JSON.stringify(body),
});
const COPY = "Do solar panels increase home value? A solar energy system will likely increase a home’s value.";
const CLAIM = "c1a10000-0000-4000-8000-000000000001";
const copyBody = (o = {}) => ({
  mode: "revise", operation_id: "exos-copy-0001", client_id: CLIENT,
  post: { channel: "facebook", id: POST, service_id: ROOF, review_hash: HASH, destination: "facebook:103977857788955" },
  change: { kind: "replace_copy", copy: COPY, claim_ids: [CLAIM] },
  executor: { channel: "claude", executed_by: "Claude via Executive OS", account_email: "thomas@compassmarketing.ai" },
  authority: { kind: "owner_approval", id: "appr-1", channels: ["facebook"], service_ids: [ROOF], operations: ["replace_copy"] },
  reason: "Answer the keyword question with the reviewed sourced claim.",
  ...o,
});
const clean = async () => ({ ok: true, brief_hash: BRIEF, warnings: [] });

test("version says which edit kinds this deployment can do", async () => {
  const withCheck = await (await createContentApprovals({ store: fakeStore(), copyCheck: clean }).handle(post({ mode: "version" }))).json();
  assert.equal(withCheck.version, 4);
  assert.deepEqual(withCheck.edit_kinds, ["replace_media", "replace_copy"]);
  const without = await (await createContentApprovals({ store: fakeStore() }).handle(post({ mode: "version" }))).json();
  assert.deepEqual(without.edit_kinds, ["replace_media"]);
});

test("replace_copy requests are validated; the copy reaches the database exactly as sent, with no file fields", () => {
  const p = parseRevise(copyBody({ change: { kind: "replace_copy", copy: COPY, claim_ids: [CLAIM.toUpperCase()], stage_id: "x", sha256: "y" } }));
  assert.equal(typeof p, "object");
  assert.deepEqual(p.change, { kind: "replace_copy", copy: COPY, claim_ids: [CLAIM] });
  const bad = [
    copyBody({ change: { kind: "replace_copy", copy: "", claim_ids: [] } }),
    copyBody({ change: { kind: "replace_copy", copy: "x".repeat(5001), claim_ids: [] } }),
    copyBody({ change: { kind: "replace_copy", copy: COPY } }),
    copyBody({ change: { kind: "replace_copy", copy: COPY, claim_ids: ["not-a-uuid"] } }),
    copyBody({ change: { kind: "replace_copy", copy: COPY, claim_ids: [CLAIM, CLAIM] } }),
    copyBody({ change: { kind: "replace_copy", copy: COPY, claim_ids: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) } }),
    copyBody({ change: { kind: "approve", copy: COPY, claim_ids: [] } }),
  ];
  for (const b of bad) assert.equal(typeof parseRevise(b), "string", JSON.stringify(b.change).slice(0, 80));
});

test("a clean copy is recorded, checked, then executed with the check's result; no bytes are read", async () => {
  const s = fakeStore();
  const seen = [];
  const copyCheck = async (...a) => { seen.push(a); return clean(); };
  const r = await createContentApprovals({ store: s, copyCheck }).handle(post(copyBody()));
  assert.equal(r.status, 201);
  assert.deepEqual(s.calls.map((c) => c[0]), ["editRecord", "editExecute"]);
  assert.deepEqual(seen, [[CLIENT, POST, COPY, [CLAIM]]]);
  assert.deepEqual(s.calls[1][2], { lint_ok: true, brief_hash: BRIEF, checked_copy: COPY, warnings: [] });
});

test("copy the linter refuses is refused on its receipt with the problems; nothing executes", async () => {
  const s = fakeStore();
  const problems = [{ code: "unsupported_pricing", message: "\"free\" is pricing.", match: "free" }];
  const copyCheck = async () => ({ ok: false, code: "lint_failed", message: "unsupported_pricing: \"free\" is pricing.", problems });
  const r = await createContentApprovals({ store: s, copyCheck }).handle(post(copyBody()));
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.equal(body.error, "lint_failed");
  assert.deepEqual(body.problems, problems);
  assert.deepEqual(s.calls.map((c) => c[0]), ["editRecord", "editRefuse"]);
  assert.equal(s.calls[1][2], "lint_failed");
});

test("without a copy check the deployment refuses copy edits; a check that throws is unknown and not refused", async () => {
  const s1 = fakeStore();
  const r1 = await createContentApprovals({ store: s1 }).handle(post(copyBody()));
  assert.equal(r1.status, 422);
  assert.equal((await r1.json()).error, "copy_check_unavailable");
  assert.ok(!s1.calls.some((c) => c[0] === "editExecute"));

  const s2 = fakeStore();
  const r2 = await createContentApprovals({ store: s2, copyCheck: async () => { throw new Error("timeout"); } }).handle(post(copyBody()));
  assert.equal(r2.status, 503);
  assert.deepEqual(s2.calls.map((c) => c[0]), ["editRecord"]);
});

test("a replayed receipt answers without checking or executing again", async () => {
  const s = fakeStore({ record: { data: { id: "rev-1", status: "executed", result: {} }, error: null } });
  let checked = 0;
  const r = await createContentApprovals({ store: s, copyCheck: async () => { checked++; return clean(); } }).handle(post(copyBody()));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).replayed, true);
  assert.equal(checked, 0);
});

// The copy check itself: the post-drafter's real brief and linter.
const LUCAS_POST = {
  platform: "google_business", post_type: "standard", search_intent: "commercial", service_id: ROOF, keyword_id: KW, offer_id: null,
  cta_type: "LEARN_MORE", cta_url: null, social_account_id: null, asset_ids: [], campaign_mode: "keyword",
};
const check = (postRow = LUCAS_POST) => createCopyCheck({
  postTarget: async (c, p) => (c === CLIENT && p === POST ? postRow : null),
  input: async (id) => (id === CLIENT ? lucas() : null),
  socialAccounts: async () => [],
  gazetteer: { MO: GAZETTEER },
});

test("the target is the post's own: channel, intent, service, keyword, CTA, media, destination", () => {
  assert.deepEqual(targetOf({ ...LUCAS_POST, social_account_id: "acc-1", asset_ids: ["a1"] }), {
    channel: "google_business", postType: "standard", intent: "commercial", campaignMode: "keyword", serviceId: ROOF, keywordId: KW,
    ctaType: "LEARN_MORE", ctaUrl: null, offerId: null, assetIds: ["a1"], socialAccountId: "acc-1",
  });
  assert.equal(targetOf({ ...LUCAS_POST, campaign_mode: null, keyword_id: null }).campaignMode, "non_search");
});

test("the copy check passes copy the drafter would accept and refuses what it would refuse", async () => {
  const ok = await check()(CLIENT, POST, GOOD, [OC, WARRANTY]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(ok.brief_hash, /^sha256:[0-9a-f]{64}$/);

  const hype = await check()(CLIENT, POST, GOOD + " The best roofer in town.", [OC, WARRANTY]);
  assert.equal(hype.ok, false);
  assert.equal(hype.code, "lint_failed");
  assert.ok(hype.problems.length > 0);

  const foreign = await check()(CLIENT, POST, GOOD, [OC, "00000000-0000-4000-8000-00000000dead"]);
  assert.equal(foreign.ok, false, "a claim outside the brief is refused");

  const missing = await check()(CLIENT, "00000000-0000-4000-8000-000000000000", GOOD, [OC, WARRANTY]);
  assert.equal(missing.code, "post_not_found");
});
