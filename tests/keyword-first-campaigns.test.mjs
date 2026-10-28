import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keywordCampaignRank } from "../supabase/functions/authority/opportunities.ts";
import { buildBrief } from "../supabase/functions/post-drafter/brief.ts";
import { lucas, TARGET, KW, PAGE } from "./fixtures/drafter-lucas.mjs";

test("keyword foundation derives missing intent and service without mutating input", () => {
  const target = { ...TARGET, intent: "", serviceId: null };
  const result = buildBrief(lucas(), target);
  assert.equal(result.ok, true, JSON.stringify(result.refusals));
  assert.equal(result.brief.target.search_intent, "commercial");
  assert.equal(result.brief.target.service.id, TARGET.serviceId);
  assert.equal(target.intent, "");
  assert.equal(target.serviceId, null);
});

test("direct drafting refuses a stored intent contradiction even when caller agrees", () => {
  const input = lucas();
  input.keywords[0].intent = "navigational";
  const result = buildBrief(input, { ...TARGET, intent: "navigational" });
  assert.equal(result.ok, false);
  assert.ok(result.refusals.some((r) => r.code === "keyword_intent_conflict"));
  assert.equal(input.keywords[0].intent, "navigational");
});

test("direct drafting refuses two primary owner pages and duplicate-text aliases", () => {
  for (const duplicateText of [false, true]) {
    const input = lucas();
    const otherId = "00000000-0000-4000-8000-000000000099";
    if (duplicateText) input.keywords.push({ ...input.keywords[0], id: otherId, keyword: "  ROOF replacement   WENTZVILLE  ", target_url: `${PAGE}-other` });
    input.pageGroups.push({ ...input.pageGroups[0], id: "other", primary_keyword_id: duplicateText ? otherId : KW, target_url: `${PAGE}-other` });
    const result = buildBrief(input, TARGET);
    assert.equal(result.ok, false);
    assert.ok(result.refusals.some((r) => r.code === "keyword_owner_conflict"));
  }
});

test("the same normalized owner URL may be shared by service, keyword and page group", () => {
  const input = lucas();
  input.pageGroups[0].target_url = `${PAGE}/?utm_source=review`;
  const result = buildBrief(input, TARGET);
  assert.equal(result.ok, true, JSON.stringify(result.refusals));
});

test("an owner conflict refuses the keyword it is on, not every keyword of the same service", () => {
  // 20261028170000: the owner is the keyword's own explicit claim. A service's
  // primary keyword no longer co-owns every keyword of that service (that rule
  // blocked whole services behind one broken page group).
  const input = lucas();
  input.pageGroups.push({ ...input.pageGroups[0], id: "competing", target_url: `${PAGE}-other` });
  const core = buildBrief(input, TARGET);
  assert.equal(core.ok, false);
  assert.ok(core.refusals.some((r) => r.code === "keyword_owner_conflict"), JSON.stringify(core.refusals));
  const supporting = input.keywords[1];
  const own = buildBrief(input, { ...TARGET, keywordId: supporting.id, intent: supporting.intent });
  assert.ok(!own.ok ? !own.refusals.some((r) => r.code === "keyword_owner_conflict") : true, JSON.stringify(own));
  // An equivalent row (same text) on another page still conflicts.
  input.keywords.push({ ...supporting, id: "dup-row", keyword: `  ${supporting.keyword.toUpperCase()} `, target_url: `${PAGE}-other` });
  const dup = buildBrief(input, { ...TARGET, keywordId: supporting.id, intent: supporting.intent });
  assert.equal(dup.ok, false);
  assert.ok(dup.refusals.some((r) => r.code === "keyword_owner_conflict"), JSON.stringify(dup.refusals));
});

const base = {
  keyword_id: "00000000-0000-4000-8000-000000000001",
  keyword: "example",
  service_id: "00000000-0000-4000-8000-000000000002",
  intent: "commercial",
  money: false,
  tracked: false,
  priority: "p3",
  volume: 0,
  cpc: 0,
  competition: null,
  target_path: "/service",
  role: "supporting",
  flags: [],
  reasons: [],
  intent_check: { stored: "commercial", assessed: "commercial_or_transactional", conflict: false, reason: "" },
  home_check: null,
  unapproved_places: [],
};

const before = (a, b) => {
  const x = keywordCampaignRank(a);
  const y = keywordCampaignRank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return a.keyword < b.keyword;
};

test("keyword-first ranking: governed priority beats lower-priority money/volume", () => {
  const p1 = { ...base, priority: "p1", volume: 10 };
  const p2Money = { ...base, priority: "p2", money: true, tracked: true, volume: 5000, cpc: 25 };
  assert.equal(before(p1, p2Money), true);
});

test("keyword-first ranking: owner, money, tracked, volume, CPC, then lower competition break same-priority ties", () => {
  const primary = { ...base, priority: "p2", role: "primary" };
  const support = { ...base, priority: "p2", role: "supporting", money: true, tracked: true, volume: 999 };
  assert.equal(before(primary, support), true);

  assert.equal(before({ ...base, priority: "p2", money: true }, { ...base, priority: "p2" }), true);
  assert.equal(before({ ...base, priority: "p2", tracked: true }, { ...base, priority: "p2" }), true);
  assert.equal(before({ ...base, priority: "p2", volume: 100 }, { ...base, priority: "p2", volume: 10 }), true);
  assert.equal(before({ ...base, priority: "p2", cpc: 8 }, { ...base, priority: "p2", cpc: 2 }), true);
  assert.equal(before({ ...base, priority: "p2", competition: 0.2 }, { ...base, priority: "p2", competition: 0.8 }), true);
});

test("Lucas pilot migration reconciles the cluster and preserves the exact graphics", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261011233500_keyword_first_lucas_pilot.sql", import.meta.url), "utf8");
  assert.match(sql, /Holiday Lighting Installation/);
  assert.match(sql, /https:\/\/lucasconstructionmo\.com\/christmas-lights/);
  assert.match(sql, /holiday lighting installation wentzville/);
  assert.match(sql, /service\/provider discovery query; commercial/);
  assert.match(sql, /drafter_run_id\s*=\s*null/);
  assert.match(sql, /set review_status\s*=\s*'draft'/);
  assert.match(sql, /set review_status\s*=\s*'in_review'/);
  assert.doesNotMatch(sql, /delete\s+from\s+post_assets/i);
  assert.doesNotMatch(sql, /update\s+post_assets/i);
  assert.match(sql, /alter table social_posts disable trigger social_posts_ab_drafter/);
  assert.match(sql, /alter table post_claims disable trigger post_claims_drafter_guard/);
  assert.match(sql, /alter table post_claims enable trigger post_claims_drafter_guard/);
  assert.match(sql, /alter table social_posts enable trigger social_posts_ab_drafter/);
  for (const label of [
    "xmas-01-season-is-here-wentzville-ranch",
    "xmas-02-save-your-weekend-wentzville-two-story",
    "xmas-03-stay-off-ladder-wentzville-three-car",
    "xmas-04-clean-professional-holiday-look",
    "xmas-05-make-home-merry-bright-wentzville-ranch",
    "xmas-06-brighten-neighborhood-wentzville-two-story",
    "xmas-07-why-homeowners-hire-it-out",
    "xmas-08-hosting-for-the-holidays",
    "xmas-09-schedule-early-for-the-holidays",
    "xmas-10-enjoy-season-skip-hassle",
  ]) assert.match(sql, new RegExp(label));
  assert.match(sql, /where website_url in/);
  assert.doesNotMatch(sql, /102d3b20-2795-44ae-bd64-d1e43916291c/);
});


test("post review exposes the keyword-first campaign foundation", () => {
  const page = readFileSync(new URL("../src/app/(app)/clients/[clientId]/social/[postId]/page.tsx", import.meta.url), "utf8");
  for (const label of ["Campaign foundation", "Primary keyword", "Post keyword", "Search intent", "Service", "Target page", "Authority reason"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /primary_keyword_id/);
  assert.match(page, /authority_opportunity_id/);
});
