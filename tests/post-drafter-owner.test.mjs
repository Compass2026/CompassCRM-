// Post and blog briefs on the keyword owner page (20261028170000): the brief
// builders take the owner from the same owner_context the database's
// keyword_owner() reads, with the related service as the topic. Fictional
// rows on the Lucas drafter fixture; no database, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../supabase/functions/post-drafter/brief.ts";
import { buildBlogBrief } from "../supabase/functions/content-drafter/brief.ts";
import { SITE, PAGE, ROOF, lucas, TARGET } from "./fixtures/drafter-lucas.mjs";

const HOME_KW = "22222222-2222-4222-8222-222222222222";
const CITY_KW = "33333333-3333-4333-8333-333333333333";
const CITY = `${SITE}/service-areas/ofallon`;
const live = (url) => ({ url_norm: url.toLowerCase().replace(/^https:\/\/www\./, "https://").replace(/\/+$/, ""), verdict: "live", checked_at: "2026-10-27T12:00:00Z" });

// lucas() plus a Home term (no service), a city term (Roof Replacement related)
// and the owner context the loader would return for them.
function input({ checks = [PAGE, `${SITE}/`, CITY], markets = [{ city: "O'Fallon", status: "approved" }], holds = [] } = {}) {
  const x = lucas();
  x.keywords.push(
    { id: HOME_KW, keyword: "roofer near me", intent: "transactional", intent_note: null, is_active: true, is_tracked: true, is_money: false, service_id: null, target_url: null, priority: "p2" },
    { id: CITY_KW, keyword: "roofer o'fallon mo", intent: "commercial", intent_note: null, is_active: true, is_tracked: true, is_money: false, service_id: ROOF, target_url: CITY, priority: "p2" },
  );
  x.pageGroups.push(
    { id: "pg-home", name: "Home", status: "approved", target_url: `${SITE}/`, primary_keyword_id: HOME_KW },
    { id: "pg-city", name: "O'Fallon, MO", status: "approved", target_url: CITY, primary_keyword_id: CITY_KW },
  );
  const types = { "pg-home": "home", "pg-city": "city" };
  x.owner_context = {
    enforce: true, program_id: null, site_url: SITE, workspaces: [],
    keywords: x.keywords.map((k) => ({ id: k.id, keyword: k.keyword, is_active: k.is_active, intent: k.intent, service_id: k.service_id,
      target_url: k.target_url, city: k.id === CITY_KW ? "O'Fallon" : null, market_id: null, core_parent_keyword_id: null })),
    services: x.services.map((s) => ({ id: s.id, status: s.status, page_url: s.page_url, primary_keyword_id: s.primary_keyword_id })),
    page_groups: x.pageGroups.map((g, i) => ({ id: g.id, status: g.status, page_type: types[g.id] ?? "service", target_url: g.target_url,
      primary_keyword_id: g.primary_keyword_id, created_at: `2026-10-01T00:00:0${i}Z` })),
    published_posts: [],
    markets: markets.map((m, i) => ({ id: `m${i}`, brand_workspace_id: null, city: m.city, state: "MO", status: m.status, source_ref: "test" })),
    page_checks: checks.map(live),
    holds,
    as_of: "2026-10-28T12:00:00Z",
  };
  return x;
}

test("a city-owned term: the owner page is the CTA and required page, Roof Replacement stays the related topic", () => {
  const r = buildBrief(input(), { ...TARGET, keywordId: CITY_KW, serviceId: ROOF });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.brief.target.owner_page.role, "city");
  assert.equal(r.brief.target.owner_page.url, CITY);
  assert.equal(r.brief.target.cta.url, CITY);
  assert.equal(r.brief.target.service.id, ROOF);
  assert.equal(r.brief.target.service.page_group_id, null, "the service page is not the owner here");
  assert.ok(r.brief.allowed_facts.crm.places.includes("O'Fallon"), "an approved market is a place the copy may name");
});

test("a Home term with no service drafts a post with brand-level claims, never a blog", () => {
  const r = buildBrief(input(), { ...TARGET, intent: "transactional", keywordId: HOME_KW, serviceId: null });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.brief.target.owner_page.role, "home");
  assert.equal(r.brief.target.service, null);
  assert.equal(r.brief.target.cta.url, `${SITE}/`);
  const blog = buildBlogBrief(input(), { id: "d1", deliverable: "blog", keyword_id: HOME_KW, service_id: null, search_intent: "transactional",
    topic: "t", primary_keyword: null, plan_item_id: null, authority_opportunity_id: null, request_note: null });
  assert.equal(blog.ok, false);
  assert.ok(blog.refusals.some((f) => f.code === "owner_role_not_allowed"), JSON.stringify(blog.refusals));
});

test("unchecked owner page, held market and held offering refuse the brief", () => {
  const unchecked = buildBrief(input({ checks: [] }), TARGET);
  assert.ok(!unchecked.ok && unchecked.refusals.some((f) => f.code === "page_not_verified"), JSON.stringify(unchecked));
  const held = buildBrief(input({ markets: [{ city: "O'Fallon", status: "held" }] }), { ...TARGET, keywordId: CITY_KW });
  assert.ok(!held.ok && held.refusals.some((f) => f.code === "market_unverified"), JSON.stringify(held));
  const hold = { id: "h", brand_workspace_id: null, offering: "Roof replacement", phrases: ["roof replacement"], service_ids: [], decided_on: "2026-10-28", source_ref: "test" };
  const promo = buildBrief(input({ holds: [hold] }), TARGET);
  assert.ok(!promo.ok && promo.refusals.some((f) => f.code === "promotion_held"), JSON.stringify(promo));
});

test("a button to the related service's page is refused when a city page owns the term", () => {
  const r = buildBrief(input(), { ...TARGET, keywordId: CITY_KW, serviceId: ROOF, ctaUrl: PAGE });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "cta_invalid"), JSON.stringify(r.refusals));
});

test("held offerings travel in the brief, so the linter can refuse them in copy", () => {
  const hold = { id: "h", brand_workspace_id: null, offering: "Repairs on other installers' systems", phrases: ["third party repair"], service_ids: [], decided_on: "2026-10-28", source_ref: "test" };
  const r = buildBrief(input({ holds: [hold] }), TARGET);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.deepEqual(r.brief.excluded.offerings, [{ offering: hold.offering, phrases: ["third party repair"] }]);
});
