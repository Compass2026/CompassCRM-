// AI Drafter v1, Deliverable 1: the governed brief and the deterministic
// linter (supabase/functions/post-drafter). Pure: no database, no model, no
// network. The fixture mirrors Lucas Construction's production records on
// Sept 25 2026 (claims, statuses and sources as stored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, briefHash } from "../supabase/functions/post-drafter/brief.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";
import { modelRequest } from "../supabase/functions/post-drafter/prompt.ts";

const SITE = "https://lucasconstructionmo.com";
const PAGE = `${SITE}/services/roof-replacement`;
const ROOF = "4288b96c-db9f-436e-b492-78f5fa7f1f21";
const KW = "0fd4fb44-379d-4b22-92ef-dfad62c26547";
const OC = "818761df-41bb-41ab-afab-6ecbe4779803";
const WARRANTY = "64d13e2d-c6d0-417d-b5c8-b3f368fb2077";
const FREE_QUOTES = "d7c9864d-6e9e-4010-bd5c-4e0e5128ce72";
const REVIEWS = "ca802383-d8a4-42ea-a7a1-c2747e113cff";

const lucas = () => ({
  asOf: "2026-09-25",
  client: {
    id: "102d3b20-2795-44ae-bd64-d1e43916291c", name: "Lucas Construction", phone: "(636) 459-9328", website_url: SITE,
    city: "Wentzville", state: "MO", business_type: "service_area", address_line1: null,
    service_area: "Wentzville, O'Fallon, Lake St. Louis, St. Peters, St. Charles County, Lincoln County, and Warren County, Missouri",
  },
  brand: {
    positioning: "Wentzville roofing, siding and gutter contractor serving Wentzville and surrounding communities. One local company from inspection and estimate to final sign-off, backed by a Lifetime Workmanship Warranty.",
    voice_tone: "Warm, straight-talking and local. Speaks like a knowledgeable neighbor. Confident and reassuring during storm season. Do not state or imply specific prices, discounts, savings or cost promises unless approved and supported by evidence.",
    audience: "Homeowners in Wentzville and surrounding communities who need roofing, siding or gutter services, including homeowners dealing with aging roofs or hail and wind damage.",
    differentiators: "Owens Corning Preferred Contractor\nLifetime Workmanship Warranty\nOne local company from inspection and estimate to final sign-off",
    ai_guidance: "Use only locations currently approved in Client Intelligence. Phone: (636) 459-9328. Use only sourced or confirmed claims.",
    words_we_use: ["local", "straightforward", "Lifetime Workmanship Warranty", "Owens Corning", "inspection", "estimate", "final sign-off"],
    words_we_avoid: ["storm chaser", "cheapest", "out-of-town", "limited time offer", "high-pressure language"],
    content_pillars: ["Roof replacement done right"],
    tagline: "Built on local roots. Driven by trust.",
  },
  board: {
    id: "ebbe3fac-77b5-4e84-9fe4-8ece69d458d2", version: 1, status: "approved", standing_cta: "Request a quote",
    hard_rules: [
      "No street address in ad copy or social bios beyond what is already public on BBB/Yelp — lead with service area, not a storefront.",
      "Never quote or imply pricing.",
      "Never use \"storm chaser,\" \"cheapest,\" \"out-of-town,\" or high-pressure/limited-time language.",
      "Only one phone number: (636) 459-9328.",
      "Never claim a specific founding year, response-time promise, or material offering (cedar shake/slate) until confirmed — currently unverified.",
      "Never fabricate a testimonial, review count, or project photo — use only sourced claims.",
    ],
  },
  services: [
    { id: ROOF, name: "Roof Replacement", status: "approved", page_url: PAGE, primary_keyword_id: KW, parent_service_id: null, segment: "Roofing" },
    { id: "c1c55a67-bc9f-43d1-a3a6-ad9bfe96841d", name: "Roof Repair", status: "approved", page_url: `${SITE}/roofing-repairs/`, primary_keyword_id: null, parent_service_id: null, segment: "Roofing" },
    { id: "2d53aa66-3353-4ea7-b5b9-fd1961a69788", name: "Storm Damage & Insurance Claims", status: "approved", page_url: null, primary_keyword_id: null, parent_service_id: null, segment: "Roofing" },
    { id: "svc-draft", name: "Metal Roofing", status: "draft", page_url: `${SITE}/services/metal`, primary_keyword_id: null, parent_service_id: null, segment: "Roofing" },
  ],
  keywords: [
    { id: KW, keyword: "roof replacement wentzville", intent: "commercial", intent_note: null, is_active: true, is_tracked: true, is_money: true, service_id: ROOF, target_url: PAGE, priority: "p1" },
    { id: "kw-info", keyword: "how long does a roof last", intent: "informational", intent_note: null, is_active: true, is_tracked: true, is_money: false, service_id: ROOF, target_url: PAGE, priority: "p3" },
  ],
  claims: [
    { id: OC, claim: "Owens Corning Preferred Contractor", status: "sourced", source: "https://www.owenscorning.com/en-us/roofing/contractors/contractor-profile/234319" },
    { id: "fa1d2070-c56c-4a75-a7ce-43effb6f0d21", claim: "Installs Owens Corning Duration shingles", status: "sourced", source: "https://www.owenscorning.com/en-us/roofing/contractors/contractor-profile/234319" },
    { id: REVIEWS, claim: "100+ 5-star reviews (5.0 stars, 97 reviews aggregated)", status: "sourced", source: "https://leadsmartinc.com/services/roofing-services/roofing-contractor/missouri/wentzville/lucas-construction-and-roofing/" },
    { id: "7c2a2d65-8242-4734-851d-fa3d6f58911e", claim: "BBB Accredited Business since 6/30/2025", status: "sourced", source: "https://www.bbb.org/us/mo/wentzville/profile/residential-roofing/lucas-construction-roofing-0734-1000023653" },
    { id: WARRANTY, claim: "Lifetime Workmanship Warranty", status: "sourced", source: PAGE },
    { id: "b73742bd-3d98-40f5-997f-846860397621", claim: "Office address 12618 Veterans Memorial Pkwy, Wentzville, MO 63385", status: "sourced", source: "https://www.bbb.org/us/mo/wentzville/profile/residential-roofing/lucas-construction-roofing-0734-1000023653" },
    { id: "c28a16b0-7357-42dc-b975-c43d50c7505f", claim: "Phone (636) 459-9328", status: "sourced", source: "https://www.bbb.org/us/mo/wentzville/profile/residential-roofing/lucas-construction-roofing-0734-1000023653" },
    { id: "fc6e22d0-f704-43f8-b39b-24f8750ada61", claim: "Roofing, siding, guttering, fascia and soffit contractor", status: "sourced", source: `${SITE}/` },
    { id: "28ba6126-91e5-478b-8aae-2ec2ee9ea111", claim: "Specializes in storm damage repair and insurance claims assistance", status: "sourced", source: "https://leadsmartinc.com/services/roofing-services/roofing-contractor/missouri/wentzville/lucas-construction-and-roofing/" },
    { id: FREE_QUOTES, claim: "Free quotes offered", status: "unverified", source: null },
    { id: "b7444b1f-7600-4f5d-8a50-7fabe47a2f6f", claim: "On site within 2-3 days after storm damage", status: "unverified", source: null },
    { id: "25fc4471-38d3-4349-93e2-e76d7b7b2955", claim: "Offers cedar shake and slate roofing in addition to asphalt", status: "unverified", source: null },
    { id: "a1ba3d4a-a619-4a61-8de0-cd3cfab3a50c", claim: "Local / family-operated since 2018", status: "unverified", source: null },
  ],
  locations: [{ name: "Wentzville, MO", city: "Wentzville", state: "MO", is_active: true }],
  assets: [{ id: "logo-1", kind: "logo_primary", label: "Logo", storage_path: "x/logo.png" }],
  offers: [],
  pageGroups: [{ id: "046dba3b-fae7-44d5-a1a8-887d30602d85", name: "Roof Replacement", status: "approved", target_url: PAGE, primary_keyword_id: KW }],
});

const TARGET = { channel: "google_business", postType: "standard", intent: "commercial", serviceId: ROOF, keywordId: KW, ctaType: "LEARN_MORE", offerId: null, assetIds: [] };
const GAZETTEER = ["Wentzville", "O'Fallon", "Lake Saint Louis", "St. Peters", "Saint Charles", "Troy", "Lucas", "Union"];

const GOOD =
  "Thinking about a roof replacement for your Wentzville home? Lucas Construction keeps the process straightforward, " +
  "from the first inspection to a clear estimate you can plan around. We're an Owens Corning Preferred Contractor, and " +
  "every roof replacement we complete is backed by our Lifetime Workmanship Warranty. If your roof is showing its age, " +
  "see how our roof replacement process works and request a quote.";

const brief = (mut = (x) => x, target = TARGET) => buildBrief(mut(lucas()), target);
const okBrief = () => {
  const r = brief();
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  return r.brief;
};
const lint = (copy, claim_ids = [OC, WARRANTY]) => lintDraft(okBrief(), { copy, claim_ids }, { gazetteer: GAZETTEER });
const codes = (r) => r.problems.map((p) => p.code);
const refused = (copy, code, claim_ids) => {
  const r = lint(copy, claim_ids);
  assert.equal(r.ok, false, `expected ${code}: ${copy}`);
  assert.ok(codes(r).includes(code), `expected ${code}, got ${JSON.stringify(r.problems)}`);
};

// ── The Lucas pilot brief ────────────────────────────────────────────────────
test("Lucas Roof Replacement: an eligible brief with the right target, facts and exclusions", async () => {
  const b = okBrief();
  assert.equal(b.target.service.page_url, PAGE);
  assert.equal(b.target.service.page_group_id, "046dba3b-fae7-44d5-a1a8-887d30602d85");
  assert.deepEqual(b.target.keyword, { id: KW, text: "roof replacement wentzville", tracked: true, money: true, max_exact_uses: 1 });
  assert.deepEqual(b.target.cta, { type: "LEARN_MORE", url: PAGE, in_copy_phrase: "Request a quote" });
  assert.equal(b.target.offer, null);
  assert.deepEqual(b.target.assets, []);
  assert.deepEqual(b.allowed_facts.recommended_claim_ids, [WARRANTY, OC], "the two relevant claims, strongest first");
  assert.deepEqual(b.allowed_facts.crm.places, ["Wentzville"], "active locations only");
  const ex = new Map(b.excluded.claims.map((c) => [c.id, c.reason]));
  assert.match(ex.get(REVIEWS), /Reviews and ratings/);
  assert.match(ex.get(FREE_QUOTES), /unverified/);
  assert.match(ex.get("b73742bd-3d98-40f5-997f-846860397621"), /street address/);
  assert.match(ex.get("7c2a2d65-8242-4734-851d-fa3d6f58911e"), /confirmed/, "BBB 'since' date needs confirmation");
  assert.ok(b.excluded.facts.some((f) => /service area/i.test(f.fact)), "free-text service area excluded");
  assert.ok(b.excluded.facts.some((f) => /One local company/.test(f.fact)), "differentiator without a claim excluded as evidence");
  assert.equal(b.brand.differentiators_citable, false);
  assert.equal(b.brand.hard_rules.length, 6);
  assert.match(await briefHash(b), /^sha256:[0-9a-f]{64}$/);
  assert.equal(await briefHash(b), await briefHash(okBrief()), "hash is stable");
});

test("the per-draft gate ignores unrelated gaps (unlabelled keywords, missing photos)", () => {
  const r = brief((x) => ({ ...x, keywords: [...x.keywords, { id: "u1", keyword: "gutters", intent: null, intent_note: null, is_active: true, is_tracked: false, is_money: false, service_id: null, target_url: null, priority: null }], assets: [] }));
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
});

test("a well-grounded Lucas draft passes the linter", () => {
  const r = lint(GOOD);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("the model request is vendor-neutral and carries the whole brief", () => {
  const req = modelRequest(okBrief());
  assert.equal(req.brief.target.service.name, "Roof Replacement");
  assert.match(req.instructions, /Return JSON only/);
  assert.doesNotMatch(JSON.stringify(req), /claude|anthropic|openai|gpt|gemini|model_name|temperature/i);
});

// ── Brief refusals ───────────────────────────────────────────────────────────
test("refused: brand board not approved", () => {
  const r = brief((x) => ({ ...x, board: { ...x.board, status: "draft" } }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "brand_board_not_approved"));
});

test("refused: missing, off-site or unapproved target page", () => {
  for (const [mut, code] of [
    [(x) => ({ ...x, services: x.services.map((s) => (s.id === ROOF ? { ...s, page_url: null } : s)) }), "target_page_missing"],
    [(x) => ({ ...x, services: x.services.map((s) => (s.id === ROOF ? { ...s, page_url: "https://evil.example/roof" } : s)) }), "target_page_invalid"],
    [(x) => ({ ...x, services: x.services.map((s) => (s.id === ROOF ? { ...s, page_url: "http://lucasconstructionmo.com/services/roof-replacement" } : s)) }), "target_page_invalid"],
    [(x) => ({ ...x, pageGroups: [] }), "target_page_unapproved"],
    [(x) => ({ ...x, pageGroups: x.pageGroups.map((g) => ({ ...g, status: "draft" })) }), "target_page_unapproved"],
  ]) {
    const r = brief(mut);
    assert.equal(r.ok, false, code);
    assert.ok(r.refusals.some((f) => f.code === code), `${code}: ${JSON.stringify(r.refusals)}`);
  }
});

test("refused: an unapproved service, a mismatched keyword, an offer on a standard post, a button to another page", () => {
  const cases = [
    [{ ...TARGET, serviceId: "svc-draft", keywordId: null }, "service_not_approved"],
    [{ ...TARGET, keywordId: "kw-info" }, "keyword_intent_mismatch"],
    [{ ...TARGET, offerId: "o1" }, "offer_not_applicable"],
    [{ ...TARGET, ctaUrl: `${SITE}/contact` }, "cta_invalid"],
    [{ ...TARGET, channel: "facebook" }, "channel_unsupported"],
    [{ ...TARGET, serviceId: null, keywordId: null }, "service_missing"],
  ];
  for (const [t, code] of cases) {
    const r = brief(undefined, t);
    assert.equal(r.ok, false, code);
    assert.ok(r.refusals.some((f) => f.code === code), `${code}: ${JSON.stringify(r.refusals)}`);
  }
});

test("refused: a commercial draft with no relevant usable claim", () => {
  const r = brief((x) => ({ ...x, claims: x.claims.filter((c) => c.status === "unverified") }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "no_usable_claim"));
});

test("refused: an offer post without a confirmed current offer", () => {
  const r = brief((x) => ({ ...x, offers: [{ id: "o1", title: "Spring", terms: "10% off", source: "x", status: "draft", starts_on: null, ends_on: null, confirmed_by: null, confirmed_on: null, service_id: null }] }), { ...TARGET, postType: "offer", offerId: "o1", ctaType: null });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "offer_not_current"));
});

// ── Lint refusals ────────────────────────────────────────────────────────────
test("refused: linking an unverified claim", () => {
  refused(GOOD, "claim_not_allowed", [OC, WARRANTY, FREE_QUOTES]);
  refused(GOOD, "claim_not_allowed", [OC, REVIEWS]);
});

test("refused: warranty or credential language not stated as a linked claim", () => {
  refused(GOOD.replace("our Lifetime Workmanship Warranty", "a lifetime warranty on materials"), "unsupported_credential");
  refused(GOOD, "unsupported_credential", [OC]); // warranty stated but its claim not linked
  refused(GOOD.replace("We're an Owens Corning Preferred Contractor, and", "Our certified crews are licensed and insured, and"), "unsupported_credential");
  refused(GOOD + " Our work is guaranteed.", "unsupported_credential");
});

test("refused: reviews and ratings", () => {
  refused(GOOD + " Rated 5 stars by over 100 homeowners.", "unsupported_review");
});

test("refused: a street address", () => {
  refused(GOOD + " Visit us at 12618 Veterans Memorial Pkwy.", "unsupported_address");
});

test("refused: pricing, free and discounts", () => {
  refused(GOOD.replace("request a quote", "request a free quote"), "unsupported_pricing");
  refused(GOOD + " Save 10% this month.", "unsupported_pricing");
  refused(GOOD + " Affordable prices for every budget.", "unsupported_pricing");
});

test("refused: a founding year or tenure", () => {
  refused(GOOD + " Serving families since 2018.", "unsupported_tenure");
  refused(GOOD + " We're family-owned.", "unsupported_tenure");
});

test("refused: a response-time promise", () => {
  refused(GOOD + " We're on site within 48 hours, 24/7.", "unsupported_response");
  refused(GOOD + " We can usually be out the same week.", "unsupported_response");
});

test("refused: an unapproved material", () => {
  refused(GOOD + " We also install cedar shake and slate roofs.", "unsupported_material");
});

test("refused: an unapproved location", () => {
  refused(GOOD.replace("your Wentzville home", "your O'Fallon home"), "unapproved_location");
  refused(GOOD + " Now serving St. Charles County.", "unapproved_location");
});

test("refused: a phone number other than the canonical one", () => {
  refused(GOOD + " Call (314) 555-0199.", "wrong_phone");
  assert.equal(lint(GOOD + " Call (636) 459-9328.").ok, true, "the canonical phone is allowed");
});

test("refused: keyword stuffing", () => {
  refused(GOOD + " Roof replacement Wentzville homeowners trust: roof replacement wentzville.", "keyword_stuffing");
});

test("refused: a URL in the body and a hashtag", () => {
  refused(GOOD + " Details at lucasconstructionmo.com/services.", "url_in_body");
  refused(GOOD + " #roofing", "hashtag");
});

test("refused: over-length and far over the Business Profile limit", () => {
  refused(GOOD + " " + "We keep you informed at every step of the job. ".repeat(12), "too_long");
  refused("x ".repeat(800) + GOOD, "channel_too_long");
});

test("refused: a brand differentiator stated as fact without its own claim", () => {
  refused(GOOD + " One local company from inspection and estimate to final sign-off.", "differentiator_as_fact");
});

test("refused: superlatives, stray numbers and words the brand avoids", () => {
  refused(GOOD + " The best roofer around.", "unsupported_superlative");
  refused(GOOD + " Over 300 roofs done.", "unsupported_number");
  refused(GOOD + " Not a storm chaser.", "word_to_avoid");
});
