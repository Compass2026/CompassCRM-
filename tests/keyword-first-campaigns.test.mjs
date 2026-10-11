import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keywordCampaignRank } from "../supabase/functions/authority/opportunities.ts";

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
  assert.match(sql, /8296bfc1-d8e4-4065-be8f-1fc566117f1f/);
  assert.match(sql, /service\/provider discovery query; commercial/);
  assert.match(sql, /drafter_run_id = null/);
  assert.match(sql, /set review_status = 'draft'/);
  assert.match(sql, /set review_status = 'in_review'/);
  assert.doesNotMatch(sql, /delete\s+from\s+post_assets/i);
  assert.doesNotMatch(sql, /update\s+post_assets/i);
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
