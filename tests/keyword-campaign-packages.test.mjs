import { test } from "node:test";
import assert from "node:assert/strict";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { lucasAuthority, ROOF, KW } from "./fixtures/authority-lucas.mjs";

test("campaign packages persist one governed cluster across channel plans", () => {
  const input = lucasAuthority();
  const before = JSON.stringify(input);
  const report = runAuthority(input);
  const c = report.campaigns.find((c) => c.service_id === ROOF);
  assert.equal(c.primary.id, KW);
  assert.ok(c.cluster.every((k) => input.keywords.find((x) => x.id === k.id)?.service_id === ROOF));
  assert.ok(!c.cluster.some((k) => /roofer in wentzville/.test(k.keyword)), "home pollution excluded");
  assert.deepEqual(c.channels.map((c) => c.channel), ["website", "blog", "google_business", "facebook", "email", "ads"]);
  assert.equal(c.channels.find((c) => c.channel === "ads").status, "not_planned");
  assert.equal(c.measurement.traffic, null);
  assert.equal(c.measurement.conversions, null);
  assert.equal(JSON.stringify(input), before);
});

test("packages block duplicate owner declarations, even with equivalent keyword text", () => {
  const input = lucasAuthority();
  const keyword = input.keywords.find((k) => k.id === KW);
  input.keywords.push({ ...keyword, id: "duplicate-keyword", target_url: "https://lucasconstructionmo.com/competing" });
  const c = runAuthority(input).campaigns.find((c) => c.service_id === ROOF);
  assert.ok(c.blockers.some((b) => b.includes("more than one owner")));
  assert.ok(c.channels.every((c) => c.status === "blocked"));
});

test("an inactive primary keyword cannot authorize a new owner page", () => {
  const input = lucasAuthority();
  input.keywords.find((k) => k.id === KW).is_active = false;
  input.authority.inventory.pages = [];
  const report = runAuthority(input);
  const opportunity = report.opportunities.find((o) => o.key === `service_page:${ROOF}`);
  assert.equal(opportunity.action, "blocked_data_prerequisite");
  assert.ok(opportunity.gates.some((g) => g.gate === "keyword_foundation" && !g.pass));
});

test("campaign metrics use only cluster demand in the latest window; unknown stays unknown", () => {
  const input = lucasAuthority();
  input.authority.gsc = [
    { query: "roof replacement wentzville", keyword_id: KW, page: null, impressions: 20, clicks: 2, avg_position: 3, period_start: "2026-09-01", period_end: "2026-09-30" },
    { query: "unrelated", keyword_id: null, page: null, impressions: 999, clicks: 99, avg_position: 1, period_start: "2026-09-01", period_end: "2026-09-30" },
    { query: "roof replacement wentzville", keyword_id: KW, page: null, impressions: 100, clicks: 10, avg_position: 5, period_start: "2026-08-01", period_end: "2026-08-31" },
  ];
  let c = runAuthority(input).campaigns.find((c) => c.service_id === ROOF);
  assert.equal(c.measurement.impressions, 20);
  assert.equal(c.measurement.clicks, 2);
  input.authority.gsc = [];
  c = runAuthority(input).campaigns.find((c) => c.service_id === ROOF);
  assert.equal(c.measurement.impressions, null);
});
