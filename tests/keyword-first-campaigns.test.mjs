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
  for (const id of [
    "a643d847-f6e3-41ba-84bf-7bdf3a277fa0",
    "b5d2cddd-60da-47b7-865a-395fb604ff3c",
    "7ce0b892-1708-4232-8310-f2285106632d",
    "eba50553-753b-4f91-93a1-b019ca82951d",
    "15dd7594-fe7e-45e0-9653-951adbf8ad68",
    "cedc3fe2-ea78-48ae-a113-d426895a3167",
    "e6fb964c-0b6c-4932-832e-62b27ac76254",
    "812a1fc2-5dc9-4d4f-8ee4-e312ed5e5232",
    "7a1fcd69-38e0-4b0e-b4f0-714ec61a5c51",
    "4b0b297f-8982-4ba5-8224-f6957671b583",
  ]) assert.match(sql, new RegExp(id));
});
