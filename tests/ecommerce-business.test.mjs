import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { assessIntelligence } from "../src/lib/client-intelligence.ts";
import { buildBrief } from "../supabase/functions/post-drafter/brief.ts";
import { buildBlogBrief } from "../supabase/functions/content-drafter/brief.ts";
import { localRankBlock } from "../supabase/functions/rank-sync/market.ts";
import { lucas, TARGET } from "./fixtures/drafter-lucas.mjs";
import { draftRow } from "./fixtures/blog-lucas.mjs";

function onlineStore() {
  const input = lucas();
  Object.assign(input.client, { business_type: "ecommerce", city: null, state: null, address_line1: null, service_area: "United States" });
  input.locations = [];
  return input;
}
const facebook = { ...TARGET, channel: "facebook", ctaType: null, ctaUrl: null, socialAccountId: "own-page" };
const accounts = [{ id: "own-page", platform: "facebook", external_account_id: "page-id", display_name: "Own Page" }];

test("online store facts use shipping market without requiring a local address or city", () => {
  const input = onlineStore();
  const areas = assessIntelligence(input);
  assert.equal(areas.find(a => a.key === "facts").status, "ready");
  assert.equal(areas.find(a => a.key === "locations").status, "ready");
  input.client.service_area = " ";
  assert.ok(assessIntelligence(input).find(a => a.key === "facts").gaps.some(g => g.includes("shipping market")));
  for (const type of ["storefront", "service_area"]) {
    input.client.business_type = type;
    assert.ok(assessIntelligence(input).find(a => a.key === "facts").gaps.includes("Add the home city and state."));
  }
});
test("online store Facebook and blog drafts pass existing foundation gates", () => {
  const input = onlineStore();
  const fb = buildBrief(input, facebook, { socialAccounts: accounts });
  assert.equal(fb.ok, true, JSON.stringify(fb));
  const blog = buildBlogBrief(input, draftRow());
  assert.equal(blog.ok, true, JSON.stringify(blog));
  input.board.status = "draft";
  for (const result of [buildBrief(input, facebook, { socialAccounts: accounts }), buildBlogBrief(input, draftRow())]) {
    assert.ok(result.refusals.some(r => r.code === "brand_board_not_approved"));
  }
});
test("online store GBP requires a verified location; Facebook binding is insufficient", () => {
  const input = onlineStore();
  for (const socialAccounts of [[], accounts, [{ platform: "google_business", publish_page_id: "unverified" }]]) {
    const result = buildBrief(input, TARGET, { socialAccounts });
    assert.ok(result.refusals.some(r => r.code === "gbp_location_required"));
  }
  const gbp = { id: "verified-gbp", platform: "google_business", publish_provider: "zernio", publish_page_id: "location-id", publish_verified_at: "2026-10-31T00:00:00Z", display_name: "Verified Location" };
  const verified = buildBrief(input, { ...TARGET, socialAccountId: gbp.id }, { socialAccounts: [gbp] });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const wrong = buildBrief(input, { ...TARGET, socialAccountId: "other-client" }, { socialAccounts: [gbp] });
  assert.ok(wrong.refusals.some(r => r.code === "social_account_unknown"));
  assert.equal(buildBrief(lucas(), TARGET).ok, true, "existing local behavior retained");
});
test("national stores never fall back to local rank tracking", () => {
  assert.match(localRankBlock("ecommerce"), /no city fallback/);
  for (const type of ["storefront", "service_area", null]) assert.equal(localRankBlock(type), null);
});
test("business type migration preserves local values and permits ecommerce", async () => {
  const db = new PGlite();
  try {
    await db.exec("create type public.business_type as enum ('storefront','service_area'); create table clients (business_type public.business_type); insert into clients values ('storefront'),('service_area');");
    const sql = await readFile(new URL("../supabase/migrations/20261031145435_ecommerce_business_type.sql", import.meta.url), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    await db.exec("insert into clients values ('ecommerce')");
    assert.deepEqual((await db.query("select business_type from clients")).rows.map(r => r.business_type), ["storefront", "service_area", "ecommerce"]);
  } finally { await db.close(); }
});
