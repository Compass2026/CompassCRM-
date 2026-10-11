// AI Drafter: Facebook drafts (Oct 11 2026). The brief, the linter and the
// request boundary for platform=facebook, over the Lucas fixture and a fake
// store. The database boundary (drafter_write's Facebook rules, the review
// gate, no approval) is the sandbox's drafter_facebook.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, briefHash, FACEBOOK_RULES, GBP_RULES } from "../supabase/functions/post-drafter/brief.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";
import { modelRequest } from "../supabase/functions/post-drafter/prompt.ts";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import { ROOF, OC, lucas, TARGET, GAZETTEER } from "./fixtures/drafter-lucas.mjs";

const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const PAGE_ACCOUNT = "1ab8af8e-d720-47ed-8818-e0f2fa91a01e";
const CONTRACTOR = "fc6e22d0-f704-43f8-b39b-24f8750ada61";
const GRAPHIC = "a0000000-0000-4000-8000-0000000000a1";
const ACCOUNTS = [
  { id: PAGE_ACCOUNT, platform: "facebook", external_account_id: "103977857788955", display_name: "LUCAS Construction" },
];
const withAssets = (x) => ({
  ...x,
  claims: [...x.claims.filter((c) => c.id !== CONTRACTOR),
    { id: CONTRACTOR, claim: "Roofing, siding, guttering, fascia and soffit contractor", status: "sourced", source: "https://lucasconstructionmo.com/" }],
  assets: [...x.assets,
    { id: GRAPHIC, kind: "social_post", label: "AI social creative 01: fall gutter cleaning check", storage_path: `${CLIENT}/upload/abc.png` },
    { id: "photo-1", kind: "photo", label: "Roof", storage_path: `${CLIENT}/scan/p.jpg` }],
});
const FB = { channel: "facebook", postType: "standard", intent: "informational", campaignMode: "keyword", serviceId: ROOF, keywordId: "kw-info", ctaType: null, offerId: null, assetIds: [GRAPHIC], socialAccountId: PAGE_ACCOUNT };
const fbBrief = (target = FB, accounts = ACCOUNTS) => buildBrief(withAssets(lucas()), target, { socialAccounts: accounts });

const GUTTER = "Quick one for anyone cleaning out gutters this fall.\n\nUnder the leaves you'll sometimes find a layer of gritty stuff that looks like coarse sand. It's usually granules that have come off the roof. They're part of the roof's top surface, and every roof loses a few over time, so a little isn't a reason to worry.\n\nA lot of it is different, especially after a hailstorm. That's worth having a roofer take a look at before winter, mostly so you know where you stand.\n\nBe careful on the ladder.";

test("a Facebook brief: standard, no button, the named Page, a social graphic allowed, Facebook's own length rules", async () => {
  const r = fbBrief();
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  const b = r.brief;
  assert.equal(b.target.channel, "facebook");
  assert.deepEqual(b.target.social_account, { id: PAGE_ACCOUNT, page_id: "103977857788955", name: "LUCAS Construction" });
  assert.deepEqual(b.target.cta, { type: null, url: null, in_copy_phrase: "Request a quote" });
  assert.deepEqual(b.target.assets.map((a) => [a.id, a.kind]), [[GRAPHIC, "social_post"]]);
  assert.equal(b.channel_rules.min_chars, FACEBOOK_RULES.min_chars);
  assert.equal(b.channel_rules.max_chars, FACEBOOK_RULES.max_chars);
  assert.match(modelRequest(b).instructions, /Write one Facebook \(Page: LUCAS Construction\) standard post/);
  assert.match(await briefHash(b), /^sha256:[0-9a-f]{64}$/);
});

test("Facebook refusals: no Page, another platform's account, a button, an offer post, two images, a logo", () => {
  const cases = [
    [{ ...FB, socialAccountId: null }, "social_account_missing"],
    [{ ...FB, socialAccountId: "b0000000-0000-4000-8000-0000000000b1" }, "social_account_unknown"],
    [{ ...FB, ctaType: "LEARN_MORE" }, "cta_not_applicable"],
    [{ ...FB, postType: "offer", offerId: null }, "post_type_invalid"],
    [{ ...FB, assetIds: [GRAPHIC, "photo-1"] }, "too_many_assets"],
    [{ ...FB, assetIds: ["logo-1"] }, "asset_unusable"],
  ];
  for (const [t, code] of cases) {
    const r = fbBrief(t);
    assert.equal(r.ok, false, code);
    assert.ok(r.refusals.some((f) => f.code === code), `${code}: ${JSON.stringify(r.refusals)}`);
  }
  // An Instagram account with the same id is not a Facebook Page.
  const ig = fbBrief(FB, [{ ...ACCOUNTS[0], platform: "instagram" }]);
  assert.ok(ig.refusals.some((f) => f.code === "social_account_unknown"));
});

test("Business Profile unchanged: no social_account key, its own rules, a graphic is not a photo, an account is refused", async () => {
  const g = buildBrief(withAssets(lucas()), TARGET);
  assert.equal(g.ok, true, JSON.stringify(g.refusals));
  assert.equal("social_account" in g.brief.target, false);
  assert.equal(g.brief.channel_rules.max_chars, GBP_RULES.max_chars);
  // The same brief whether or not Facebook Pages are passed in.
  assert.equal(await briefHash(g.brief), await briefHash(buildBrief(withAssets(lucas()), TARGET, { socialAccounts: ACCOUNTS }).brief));
  const graphic = buildBrief(withAssets(lucas()), { ...TARGET, assetIds: [GRAPHIC] });
  assert.ok(graphic.refusals.some((f) => f.code === "asset_unusable"));
  const named = buildBrief(withAssets(lucas()), { ...TARGET, socialAccountId: PAGE_ACCOUNT });
  assert.ok(named.refusals.some((f) => f.code === "social_account_not_applicable"));
});

test("the linter judges a Facebook draft by the same fact rules, plus Facebook's channel rules", () => {
  const b = fbBrief().brief;
  const ok = lintDraft(b, { copy: GUTTER, claim_ids: [CONTRACTOR] }, { gazetteer: GAZETTEER });
  assert.deepEqual(ok.problems, [], "the published gutter copy passes as written");
  const codes = (copy, claims = [CONTRACTOR]) => lintDraft(b, { copy, claim_ids: claims }, { gazetteer: GAZETTEER }).problems.map((p) => p.code);
  assert.ok(codes(GUTTER + " #roofing").includes("hashtag"));
  assert.ok(codes(GUTTER + " See lucasconstructionmo.com").includes("url_in_body"));
  assert.ok(codes(GUTTER + " We're the best roofer around.").includes("unsupported_superlative"));
  assert.ok(codes(GUTTER + " We offer emergency service.").includes("unsupported_response"));
  assert.ok(codes(GUTTER + " We also serve O'Fallon.").includes("unapproved_location"));
  assert.ok(codes(GUTTER + " We're an Owens Corning Preferred Contractor.").includes("unsupported_credential"), "a credential needs its linked claim");
  assert.deepEqual(codes(GUTTER + " We're an Owens Corning Preferred Contractor.", [CONTRACTOR, OC]), [], "...and passes with it");
  assert.ok(codes(GUTTER, ["not-a-claim"]).includes("claim_not_allowed"));
});

// ── The request boundary ─────────────────────────────────────────────────────
function fakeStore() {
  const calls = { writes: [], runs: [] };
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron-secret" : null),
    teamMemberForJwt: async () => null,
    input: async (id) => (id === CLIENT ? withAssets(lucas()) : null),
    socialAccounts: async (id) => (id === CLIENT ? ACCOUNTS : []),
    attempts: async () => 0,
    recordRun: async (r) => { calls.runs.push(r); },
    write: async (p) => { calls.writes.push(p); return { run_id: "run-1", post_id: "post-1", review_task_id: "task-1" }; },
  };
  return { store, calls };
}
const call = async (d, body) => {
  const r = await d.handle(new Request("http://x/post-drafter", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron-secret" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

test("submit: a Facebook draft goes to drafter_write with the Page and the graphic, and comes back in review", async () => {
  const { store, calls } = fakeStore();
  const d = createPostDrafter({ store, gazetteer: { MO: GAZETTEER } });
  const b = await call(d, { mode: "brief", client_id: CLIENT, target: FB });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const r = await call(d, { mode: "submit", client_id: CLIENT, target: FB, brief_hash: b.body.brief_hash, runtime: "claude-session", draft: { copy: GUTTER, claim_ids: [CONTRACTOR] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "in_review");
  assert.equal(calls.writes.length, 1);
  const w = calls.writes[0];
  assert.equal(w.brief.target.channel, "facebook");
  assert.equal(w.brief.target.social_account.id, PAGE_ACCOUNT);
  assert.deepEqual(w.asset_ids, [GRAPHIC]);
  assert.deepEqual(w.claim_ids, [CONTRACTOR]);
  // There is still no approve, schedule or publish mode.
  for (const mode of ["approve", "schedule", "publish"]) assert.equal((await call(d, { mode, client_id: CLIENT, target: FB })).status, 400);
});

test("a malformed socialAccountId is refused at the boundary", async () => {
  const d = createPostDrafter({ store: fakeStore().store });
  const r = await call(d, { mode: "brief", client_id: CLIENT, target: { ...FB, socialAccountId: "not-a-uuid" } });
  assert.equal(r.status, 400);
});


test("keyword-first: a missing keyword is refused; non-search mode must be explicit and cannot carry service grounding", () => {
  const missing = fbBrief({ ...FB, keywordId: null });
  assert.equal(missing.ok, false);
  assert.ok(missing.refusals.some((f) => f.code === "keyword_missing"));

  const disguised = fbBrief({ ...FB, campaignMode: "non_search", keywordId: null });
  assert.equal(disguised.ok, false);
  assert.ok(disguised.refusals.some((f) => f.code === "service_not_applicable"));

  const brandOnly = fbBrief({
    ...FB,
    campaignMode: "non_search",
    serviceId: null,
    keywordId: null,
  });
  assert.equal(brandOnly.ok, true, JSON.stringify(brandOnly.refusals));
  assert.equal(brandOnly.brief.target.campaign_mode, "non_search");
  assert.equal(brandOnly.brief.target.keyword, null);
  assert.equal(brandOnly.brief.target.service, null);
});
