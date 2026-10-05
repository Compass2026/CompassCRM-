// A blog draft for the Lucas-shaped fixture (tests/fixtures/drafter-lucas.mjs)
// that the content-drafter's lint passes: no numbers, prices, credentials
// outside the linked claim's own words, materials, unapproved places or
// diagnoses; the service page linked; the standing CTA.
import { OC, PAGE, ROOF, SITE } from "./drafter-lucas.mjs";

export const DRAFT_ID = "0b10c0de-0000-4000-8000-000000000001";

export const draftRow = (over = {}) => ({
  id: DRAFT_ID, client_id: "102d3b20-2795-44ae-bd64-d1e43916291c", plan_item_id: null, deliverable: "blog", status: "requested",
  topic: "How long does a roof last", primary_keyword: "how long does a roof last", keyword_id: "kw-info",
  search_intent: "informational", service_id: ROOF, authority_opportunity_id: null, target_url: null, request_note: null, ...over,
});

const para = [
  "A roof does its quiet work through every season, and most homeowners only think about it when something looks wrong.",
  "Knowing what wears a roof down helps you plan ahead instead of reacting to a leak at the worst possible moment.",
  "Sun, wind, ice and heavy rain all take their toll, and the way a roof was installed matters as much as the weather it faces.",
  "Good attic ventilation keeps heat and moisture from building up under the roof deck, which helps the whole system age evenly.",
  "Clean gutters move water away from the edges of the roof so it does not back up under the outer layer or soak the fascia.",
  "Small repairs made early can keep a sound roof in service longer, while a roof at the end of its life is better replaced on your own schedule.",
  "An inspection from a local contractor gives you a clear picture of where your roof stands and what your options are.",
  "Lucas Construction keeps that conversation straightforward, with a clear estimate you can plan around and no pressure to decide on the spot.",
];
const section = (h, k) => `## ${h}\n\n${para.slice(k).concat(para.slice(0, k)).join(" ")}\n\n${para.slice(k + 2).concat(para.slice(0, k + 2)).join(" ")}\n`;

export const OUTLINE = [
  { level: 2, heading: "What wears a roof out" },
  { level: 2, heading: "Signs worth a closer look" },
  { level: 2, heading: "Repair or replace" },
  { level: 2, heading: "Planning your next step" },
];

export const GOOD_BLOG = {
  title: "How long does a roof last? What Wentzville homeowners should know",
  slug: "how-long-does-a-roof-last",
  meta_title: "How Long Does a Roof Last? A Wentzville Homeowner's Guide",
  meta_description: "What wears a roof out, the signs worth a closer look, and how to plan a repair or a replacement on your own schedule in Wentzville.",
  h1: "How long does a roof last?",
  outline: OUTLINE,
  body_markdown: [
    section(OUTLINE[0].heading, 0),
    section(OUTLINE[1].heading, 1),
    section(OUTLINE[2].heading, 2) + `\nIf replacing makes more sense, learn how our [roof replacement](${PAGE}) process works.\n`,
    section(OUTLINE[3].heading, 3) + "\nLucas Construction is an Owens Corning Preferred Contractor serving homeowners in Wentzville.\n",
  ].join("\n"),
  internal_links: [{ url: PAGE, anchor: "roof replacement", reason: "The service the article is about." }],
  cta: { text: "Request a quote", url: PAGE },
  claim_ids: [OC],
};

export { SITE, PAGE };

// A service page for the same fixture (0069) that the page lint passes.
export const PAGE_DRAFT_ID = "0b10c0de-0000-4000-8000-000000000002";
export const pageRow = (over = {}) => draftRow({ id: PAGE_DRAFT_ID, deliverable: "web_page", page_type: "service", page_change: "page_added",
  topic: "Roof replacement in Wentzville", primary_keyword: "roof replacement wentzville", keyword_id: "0fd4fb44-379d-4b22-92ef-dfad62c26547",
  search_intent: "commercial", ...over });
const PAGE_OUTLINE = [
  { level: 2, heading: "What a roof replacement involves" },
  { level: 2, heading: "How we work" },
  { level: 2, heading: "When replacing makes sense" },
];
export const GOOD_PAGE = {
  title: "Roof replacement in Wentzville",
  slug: "roof-replacement-wentzville",
  page_path: "/services/roof-replacement-wentzville",
  page_objective: "Help Wentzville homeowners understand a roof replacement and request a quote.",
  meta_title: "Roof Replacement in Wentzville | Lucas Construction",
  meta_description: "How a roof replacement works with a local Wentzville contractor, from the first inspection to a clear estimate and final walkthrough.",
  h1: "Roof replacement in Wentzville",
  outline: PAGE_OUTLINE,
  body_markdown: PAGE_OUTLINE.map((o, k) => section(o.heading, k + 1)).join("\n") + "\nLucas Construction is an Owens Corning Preferred Contractor serving homeowners in Wentzville.\n",
  internal_links: [{ url: SITE, anchor: "Lucas Construction", reason: "The home page." }],
  cta: { text: "Request a quote", url: SITE },
  claim_ids: [OC],
  structured_data: {
    "@context": "https://schema.org", "@type": "Service", name: "Roof Replacement", areaServed: "Wentzville",
    provider: { "@type": "LocalBusiness", name: "Lucas Construction", telephone: "(636) 459-9328", url: SITE },
  },
};
