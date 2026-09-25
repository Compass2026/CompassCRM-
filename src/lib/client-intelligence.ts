// Client Intelligence readiness (five-layer plan, layer 1).
//
// Answers one question per client: could an AI drafter write a grounded
// social or Google Business Profile post from what the CRM holds today, and
// if not, what exactly is missing? Pure functions over rows the page loads;
// nothing here writes. The same rules decide what a draft may cite later
// (usableClaims, topicCandidates), so the readiness screen and the drafter
// can never disagree about what counts as a fact.
//
// Imports are type-only so node --test can load this file directly.
import type { Database } from "./database.types.ts";

type Tables = Database["public"]["Tables"];
type Row<T extends keyof Tables> = Tables[T]["Row"];

export const SEARCH_INTENTS = ["navigational", "informational", "commercial", "transactional"] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

// What each intent is good for in a short post. Posts support visibility and
// engagement; they are not a promise of Google rankings or topical authority.
export const intentPostGuidance: Record<SearchIntent, { label: string; use: string }> = {
  navigational: { label: "Navigational", use: "Brand and contact posts: who we are, where, how to reach us." },
  informational: { label: "Informational", use: "Educational posts: answer a question, explain a process, give a tip." },
  commercial: { label: "Commercial", use: "Comparison and proof posts: why us, finished work, reviews, credentials." },
  transactional: { label: "Transactional", use: "Action posts: book, call, request a quote, a current offer." },
};

export function normalizeIntent(raw: string | null | undefined): SearchIntent | null {
  const v = (raw ?? "").trim().toLowerCase();
  return (SEARCH_INTENTS as readonly string[]).includes(v) ? (v as SearchIntent) : null;
}

export type IntelligenceInput = {
  client: Pick<
    Row<"clients">,
    "name" | "phone" | "website_url" | "city" | "state" | "service_area" | "business_type" | "address_line1"
  >;
  brand: Pick<
    Row<"client_brands">,
    "positioning" | "voice_tone" | "audience" | "differentiators" | "ai_guidance" | "words_we_use" | "words_we_avoid" | "content_pillars"
  > | null;
  board: Pick<Row<"brand_boards">, "status" | "hard_rules" | "standing_cta"> | null;
  services: Pick<Row<"services">, "id" | "name" | "status" | "page_url" | "primary_keyword_id" | "parent_service_id">[];
  keywords: Pick<Row<"keywords">, "id" | "keyword" | "intent" | "intent_note" | "is_active" | "is_tracked" | "is_money" | "service_id" | "target_url" | "priority">[];
  claims: Pick<Row<"claims">, "id" | "claim" | "status" | "source">[];
  locations: Pick<Row<"locations">, "name" | "city" | "state" | "is_active">[];
  assets: Pick<Row<"brand_assets">, "kind">[];
  offers: OfferRow[];
  // The day offers are judged against (YYYY-MM-DD, Compass's Central day).
  // Defaults to today in UTC when omitted.
  asOf?: string;
};

export type OfferRow = Pick<
  Row<"offers">,
  "id" | "title" | "terms" | "source" | "status" | "starts_on" | "ends_on" | "confirmed_by" | "confirmed_on" | "service_id"
>;

export type AreaStatus = "ready" | "partial" | "missing";

export type AreaReport = {
  key: string;
  label: string;
  status: AreaStatus;
  // One line on what is there, then what to add to reach "ready".
  summary: string;
  gaps: string[];
  // Blocking areas must be ready before a pilot client drafts posts.
  blocking: boolean;
};

const MIN_PROOF = 3;
const MIN_PHOTOS = 6;

const filled = (s: string | null | undefined) => (s ?? "").trim().length > 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A claim a post may state: sourced from the client's own material, or
// confirmed by the client. "unverified" is never cited.
export function usableClaims(claims: IntelligenceInput["claims"]) {
  return claims.filter((c) => (c.status === "sourced" && filled(c.source)) || c.status === "confirmed");
}

export function intentCounts(keywords: IntelligenceInput["keywords"]) {
  const active = keywords.filter((k) => k.is_active);
  const counts = Object.fromEntries(SEARCH_INTENTS.map((i) => [i, 0])) as Record<SearchIntent, number>;
  let unlabelled = 0;
  let unlabelledWithNote = 0;
  // Since 0044 the database refuses anything but the four intents, so this
  // stays 0; it is kept so rows from before the constraint read honestly.
  let nonStandard = 0;
  for (const k of active) {
    const intent = normalizeIntent(k.intent);
    if (intent) counts[intent] += 1;
    else if (filled(k.intent)) nonStandard += 1;
    else {
      unlabelled += 1;
      if (filled(k.intent_note)) unlabelledWithNote += 1;
    }
  }
  return { active: active.length, counts, unlabelled, unlabelledWithNote, nonStandard };
}

export type OfferState = "current" | "upcoming" | "ended" | "awaiting_confirmation" | "retired";

// Where an offer stands on a given day. Only a confirmed offer can be
// current; dates are optional (a standing offer has none). Channel rules,
// such as a GBP Offer post needing a date window, are not decided here.
export function offerState(offer: OfferRow, asOf: string): OfferState {
  if (offer.status === "retired") return "retired";
  if (offer.status !== "confirmed") return "awaiting_confirmation";
  if (offer.starts_on && offer.starts_on > asOf) return "upcoming";
  if (offer.ends_on && offer.ends_on < asOf) return "ended";
  return "current";
}

// Offers a post may mention today: confirmed, and in their window if they
// have one.
export function currentOffers(offers: OfferRow[], asOf: string) {
  return offers.filter((o) => offerState(o, asOf) === "current");
}

export type TopicCandidate = {
  serviceId: string;
  service: string;
  pageUrl: string | null;
  primaryKeyword: string | null;
  intents: Partial<Record<SearchIntent, string[]>>;
};

// Post topics come from approved services and the keywords mapped to them,
// grouped by intent, so every draft names a service, a page and a search
// intent rather than a free-floating idea.
export function topicCandidates(input: IntelligenceInput, perIntent = 3): TopicCandidate[] {
  const byId = new Map(input.keywords.map((k) => [k.id, k]));
  return input.services
    .filter((s) => s.status === "approved")
    .map((s) => {
      const linked = input.keywords
        .filter((k) => k.is_active && (k.service_id === s.id || k.id === s.primary_keyword_id))
        .sort((a, b) => Number(b.is_money) - Number(a.is_money) || (a.priority ?? "p9").localeCompare(b.priority ?? "p9"));
      const intents: TopicCandidate["intents"] = {};
      for (const k of linked) {
        const intent = normalizeIntent(k.intent);
        if (!intent) continue;
        const list = (intents[intent] ??= []);
        if (list.length < perIntent && !list.includes(k.keyword)) list.push(k.keyword);
      }
      return {
        serviceId: s.id,
        service: s.name,
        pageUrl: s.page_url,
        primaryKeyword: s.primary_keyword_id ? byId.get(s.primary_keyword_id)?.keyword ?? null : null,
        intents,
      };
    })
    .filter((t) => Object.keys(t.intents).length > 0);
}

export function assessIntelligence(input: IntelligenceInput): AreaReport[] {
  const { client, brand, board } = input;
  const areas: AreaReport[] = [];
  const add = (a: Omit<AreaReport, "status"> & { status?: AreaStatus }) =>
    areas.push({ ...a, status: a.status ?? (a.gaps.length ? "partial" : "ready") });

  // 1. Business facts: what a post may say about who and where.
  {
    const gaps: string[] = [];
    if (!filled(client.phone)) gaps.push("Add the business phone.");
    if (!filled(client.website_url)) gaps.push("Add the website URL.");
    if (!client.business_type) gaps.push("Set the business type: storefront or service area.");
    if (client.business_type === "storefront" && !filled(client.address_line1)) gaps.push("Add the street address for a storefront.");
    if (!filled(client.city) || !filled(client.state)) gaps.push("Add the home city and state.");
    if (client.business_type === "service_area" && !filled(client.service_area)) gaps.push("Describe the service area.");
    add({
      key: "facts",
      label: "Business facts",
      summary: [client.phone, client.city && client.state ? `${client.city}, ${client.state}` : null, client.business_type?.replace("_", " ")]
        .filter(Boolean)
        .join(" · ") || "No contact facts yet.",
      gaps,
      blocking: true,
      status: gaps.length >= 3 ? "missing" : undefined,
    });
  }

  // 2. Brand and voice.
  {
    const gaps: string[] = [];
    if (!brand || !filled(brand.positioning)) gaps.push("Write the positioning.");
    if (!brand || !filled(brand.voice_tone)) gaps.push("Describe the voice and tone.");
    if (!board) gaps.push("Start and approve the brand board.");
    else if (board.status !== "approved") gaps.push("Approve the brand board (it is still a draft).");
    add({
      key: "brand",
      label: "Brand and voice",
      summary: brand && filled(brand.positioning) ? `Positioning and voice written; board ${board?.status ?? "not started"}.` : "No positioning yet.",
      gaps,
      blocking: true,
      status: !brand || (!filled(brand.positioning) && !filled(brand.voice_tone)) ? "missing" : undefined,
    });
  }

  // 3. Services.
  {
    const approved = input.services.filter((s) => s.status === "approved");
    const withPage = approved.filter((s) => filled(s.page_url));
    const gaps: string[] = [];
    if (approved.length === 0) gaps.push("Approve the service taxonomy (Foundation › Service Taxonomy).");
    else if (withPage.length === 0) gaps.push("Map at least one approved service to a page URL so posts can link somewhere specific.");
    add({
      key: "services",
      label: "Services",
      summary: approved.length ? `${plural(approved.length, "approved service")}, ${withPage.length} with a page.` : "No approved services.",
      gaps,
      blocking: true,
      status: approved.length === 0 ? "missing" : undefined,
    });
  }

  // 4. Audience.
  add({
    key: "audience",
    label: "Audience",
    summary: brand && filled(brand.audience) ? "Audience described." : "No audience description.",
    gaps: brand && filled(brand.audience) ? [] : ["Describe who the posts are for (Brand tab › Audience)."],
    blocking: true,
    status: brand && filled(brand.audience) ? "ready" : "missing",
  });

  // 5. Locations.
  {
    const active = input.locations.filter((l) => l.is_active);
    const serviceArea = filled(client.service_area);
    add({
      key: "locations",
      label: "Locations",
      summary: active.length
        ? `${plural(active.length, "tracked location")}${serviceArea ? "; service area described" : ""}.`
        : serviceArea ? "Service area described; no tracked locations." : "No locations.",
      gaps: active.length || serviceArea ? [] : ["Add the home location (Keywords › Tracked locations) or describe the service area."],
      blocking: true,
      status: active.length || serviceArea ? "ready" : "missing",
    });
  }

  // 6. Offers. General posts run without one, so offers never block the
  //    pilot; content that needs an offer asks pilotReadiness for it.
  {
    const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
    const by = (state: OfferState) => input.offers.filter((o) => offerState(o, asOf) === state);
    const current = by("current");
    const upcoming = by("upcoming").length;
    const ended = by("ended").length;
    const drafts = by("awaiting_confirmation").length;
    const standing = current.filter((o) => !o.starts_on && !o.ends_on).length;
    const gaps: string[] = [];
    if (drafts) gaps.push(`Confirm ${plural(drafts, "draft offer")} with the client (who and when) before a post may use it.`);
    if (!current.length && ended && !drafts && !upcoming) gaps.push("Every confirmed offer has ended; record the current one, if there is one.");
    if (!current.length && !input.offers.some((o) => o.status !== "retired"))
      gaps.push("No offers recorded. General posts don't need one; record the exact terms and source before any offer post.");
    const parts = [
      current.length
        ? `${plural(current.length, "current offer")}${standing ? ` (${standing} standing)` : ""}`
        : "No current offer",
      upcoming ? `${upcoming} upcoming` : null,
      drafts ? `${drafts} awaiting confirmation` : null,
      ended ? `${ended} ended` : null,
    ].filter(Boolean);
    add({
      key: "offers",
      label: "Offers",
      summary: `${parts.join("; ")}.`,
      gaps,
      blocking: false,
      status: current.length ? "ready" : input.offers.some((o) => o.status !== "retired") ? "partial" : "missing",
    });
  }

  // 7. Proof: the facts a post may cite.
  {
    const usable = usableClaims(input.claims);
    const confirmed = input.claims.filter((c) => c.status === "confirmed").length;
    const unverified = input.claims.filter((c) => c.status === "unverified").length;
    const sourcedWithoutSource = input.claims.filter((c) => c.status === "sourced" && !filled(c.source)).length;
    const gaps: string[] = [];
    if (usable.length < MIN_PROOF) gaps.push(`Record at least ${MIN_PROOF} sourced or confirmed claims (${usable.length} now).`);
    if (sourcedWithoutSource) gaps.push(`${plural(sourcedWithoutSource, "claim")} marked sourced without a source; add it or it cannot be cited.`);
    add({
      key: "proof",
      label: "Proof and claims",
      // Sourced-from-the-client's-own-material is enough to cite; client
      // confirmation is stronger and shown, but not required.
      summary: `${usable.length} usable (${confirmed ? `${confirmed} client-confirmed` : "none client-confirmed yet"})${unverified ? `; ${unverified} unverified, never cited` : ""}.`,
      gaps,
      blocking: true,
      status: usable.length === 0 ? "missing" : usable.length < MIN_PROOF ? "partial" : undefined,
    });
  }

  // 8. Assets.
  {
    const logo = input.assets.some((a) => a.kind === "logo_primary");
    const photos = input.assets.filter((a) => a.kind === "photo").length;
    const gaps: string[] = [];
    if (!logo) gaps.push("Mark a primary logo.");
    if (photos < MIN_PHOTOS) gaps.push(`Add real photos: ${photos} of ${MIN_PHOTOS}.`);
    add({
      key: "assets",
      label: "Assets",
      summary: `${logo ? "Primary logo" : "No primary logo"}; ${plural(photos, "photo")}.`,
      gaps,
      blocking: true,
      status: !logo && photos === 0 ? "missing" : undefined,
    });
  }

  // 9. Keywords and search intent.
  {
    const { active, unlabelled, unlabelledWithNote, nonStandard } = intentCounts(input.keywords);
    const gaps: string[] = [];
    if (active === 0) gaps.push("Run Keyword Research.");
    if (unlabelled)
      gaps.push(
        `Label the search intent of ${plural(unlabelled, "active keyword")}` +
          (unlabelledWithNote ? ` (${unlabelledWithNote} ${unlabelledWithNote === 1 ? "has" : "have"} a note that can guide the label).` : ".")
      );
    if (nonStandard)
      gaps.push(`${plural(nonStandard, "keyword")} carry a note instead of an intent; move the note and set navigational, informational, commercial or transactional.`);
    const topics = topicCandidates(input).length;
    if (active && topics === 0) gaps.push("Link keywords to approved services so posts have topics.");
    add({
      key: "keywords",
      label: "Keywords and intent",
      summary: active ? `${plural(active, "active keyword")}; ${plural(topics, "service topic")} with labelled intent.` : "No keywords.",
      gaps,
      blocking: true,
      status: active === 0 ? "missing" : undefined,
    });
  }

  // 10. Content rules.
  {
    const rules = (board?.hard_rules ?? []).length + (brand?.words_we_avoid ?? []).length;
    const guidance = filled(brand?.ai_guidance);
    const gaps: string[] = [];
    if (!guidance) gaps.push("Write the guidance for AI-generated content.");
    if (rules === 0) gaps.push("Add hard rules or words to avoid.");
    add({
      key: "rules",
      label: "Content rules",
      summary: `${guidance ? "AI guidance written" : "No AI guidance"}; ${plural(rules, "rule")}.`,
      gaps,
      blocking: true,
      status: !guidance && rules === 0 ? "missing" : undefined,
    });
  }

  return areas;
}

// Ready for a drafting pilot when every blocking area is ready. Offers only
// block content that needs one (an offer post): pass { needsOffer: true }.
export function pilotReadiness(areas: AreaReport[], { needsOffer = false }: { needsOffer?: boolean } = {}) {
  const blocking = areas.filter((a) => a.blocking || (needsOffer && a.key === "offers"));
  const ready = blocking.filter((a) => a.status === "ready").length;
  return { ready, total: blocking.length, isReady: ready === blocking.length };
}
