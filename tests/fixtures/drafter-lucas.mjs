// Lucas Construction's production records on Sept 25 2026 (claims,
// statuses and sources as stored), shared by the AI Drafter tests.
export const SITE = "https://lucasconstructionmo.com";
export const PAGE = `${SITE}/services/roof-replacement`;
export const ROOF = "4288b96c-db9f-436e-b492-78f5fa7f1f21";
export const KW = "0fd4fb44-379d-4b22-92ef-dfad62c26547";
export const OC = "818761df-41bb-41ab-afab-6ecbe4779803";
export const WARRANTY = "64d13e2d-c6d0-417d-b5c8-b3f368fb2077";
export const FREE_QUOTES = "d7c9864d-6e9e-4010-bd5c-4e0e5128ce72";
export const REVIEWS = "ca802383-d8a4-42ea-a7a1-c2747e113cff";

export const lucas = () => ({
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

export const TARGET = { channel: "google_business", postType: "standard", intent: "commercial", serviceId: ROOF, keywordId: KW, ctaType: "LEARN_MORE", offerId: null, assetIds: [] };
export const GAZETTEER = ["Wentzville", "O'Fallon", "Lake Saint Louis", "St. Peters", "Saint Charles", "Troy", "Lucas", "Union", "Liberty", "Independence"];

export const GOOD =
  "Thinking about a roof replacement for your Wentzville home? Lucas Construction keeps the process straightforward, " +
  "from the first inspection to a clear estimate you can plan around. We're an Owens Corning Preferred Contractor, and " +
  "every roof replacement we complete is backed by our Lifetime Workmanship Warranty. If your roof is showing its age, " +
  "see how our roof replacement process works and request a quote.";

