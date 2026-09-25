// AI Drafter v1: the Governed Brief Builder. Pure; reads nothing, writes
// nothing, knows no model.
//
// Takes the canonical Client Intelligence input (the same rows the
// Intelligence tab assesses) and one named target, and returns either the
// brief a model may write from or every reason the draft is not eligible.
//
// The gate is per draft (approved Sept 25 2026): what THIS draft needs must be
// ready — approved brand board, business facts, content rules, an approved
// service with an approved target page, a valid keyword / intent when given,
// a relevant usable claim for non-navigational content, and a confirmed
// current offer only for an offer post. Unrelated gaps (unlabelled keywords,
// missing photos, other services) do not block.
//
// The brief is the whole of what a draft may say: CRM facts (name, phone,
// website, approved services, ACTIVE locations only — never the free-text
// service area) and the usable claims listed. Brand Board differentiators
// shape tone and topic but are not evidence (differentiators_citable: false).
import {
  assessIntelligence,
  currentOffers,
  normalizeIntent,
  usableClaims,
  type IntelligenceInput,
} from "../../../src/lib/client-intelligence.ts";
import { GBP_CTA_TYPES, GBP_SUMMARY_MAX } from "../post-publisher/channel.ts";
import {
  DRAFT_CHANNELS,
  DRAFTER_VERSION,
  type Brief,
  type BriefClaim,
  type BriefResult,
  type DrafterInput,
  type DraftTarget,
  type Refusal,
} from "./types.ts";
import { claimCategories, hostOf, normalizeUrl, stableJson, words } from "./rules.ts";

export const MAX_CLAIMS = 2;
export const KEYWORD_MAX_EXACT_USES = 1;
// Compass's own quality range for a Business Profile post (Sept 25 2026):
// at least 300, aim for about 450–700, normally no more than 900. Google's
// limit (GBP_SUMMARY_MAX, 1500) is the channel's hard maximum, separately.
export const GBP_RULES = { min_chars: 300, preferred_min_chars: 450, preferred_max_chars: 700, max_chars: 900, lead_chars: 100 } as const;

// Claim categories never cited in v1, and categories the hard rules allow
// only once the client has confirmed them.
const EXCLUDED_CATEGORIES: Record<string, string> = {
  review: "Reviews and ratings are not cited in v1 (hard rule on review counts and testimonials).",
  address: "A street address is never stated (hard rule).",
  phone: "The phone is a CRM fact, not a claim.",
  pricing: "Pricing, discounts and free offers are never stated (hard rule); offers go through the offers table.",
};
const CONFIRMED_ONLY: Record<string, string> = {
  tenure: "States a year, tenure or ownership; the hard rules allow that only once the client has confirmed it.",
  response: "States a response time; the hard rules allow that only once the client has confirmed it.",
};

const filled = (s: string | null | undefined) => (s ?? "").trim().length > 0;

function toIntelligence(input: DrafterInput): IntelligenceInput {
  return {
    client: input.client,
    brand: input.brand,
    board: input.board,
    services: input.services,
    keywords: input.keywords,
    claims: input.claims,
    locations: input.locations,
    assets: input.assets,
    offers: input.offers,
    asOf: input.asOf,
  };
}

// Words that tie a claim to a service (≥ 4 letters, from its name and segment).
function serviceTokens(service: { name: string; segment?: string | null }): string[] {
  return [...new Set(words(`${service.name} ${service.segment ?? ""}`).filter((w) => w.length >= 4))];
}
function sourcePath(source: string | null): string {
  try {
    return new URL(source ?? "").pathname.replace(/[/_-]/g, " ");
  } catch {
    return "";
  }
}
const mentions = (text: string, tokens: string[]) =>
  words(text).some((w) => tokens.some((t) => w.startsWith(t) || (w.length >= 4 && t.startsWith(w))));

export function buildBrief(input: DrafterInput, target: DraftTarget): BriefResult {
  const refusals: Refusal[] = [];
  const refuse = (code: string, message: string) => refusals.push({ code, message });
  const areas = assessIntelligence(toIntelligence(input));
  const area = (key: string) => areas.find((a) => a.key === key);

  // ── Channel and intent ──
  if (!(DRAFT_CHANNELS as readonly string[]).includes(target.channel)) {
    refuse("channel_unsupported", `The drafter writes ${DRAFT_CHANNELS.join(", ")} posts in v1, not ${target.channel}.`);
  }
  const intent = normalizeIntent(target.intent);
  if (!intent) refuse("intent_invalid", `"${target.intent}" is not a search intent.`);
  if (target.postType !== "standard" && target.postType !== "offer") refuse("post_type_invalid", `"${target.postType}" is not a post type.`);

  // ── Per-draft gate ──
  const gate: Record<string, string> = {};
  if (!input.board) refuse("brand_board_missing", "The client has no brand board.");
  else if (input.board.status !== "approved") refuse("brand_board_not_approved", `The brand board is ${input.board.status}, not approved.`);
  gate.brand_board = input.board?.status ?? "missing";
  if (!input.brand || !filled(input.brand.positioning) || !filled(input.brand.voice_tone)) {
    refuse("brand_voice_missing", "Positioning and voice must be written before drafting.");
  }
  for (const [key, label] of [["facts", "Business facts"], ["rules", "Content rules"]] as const) {
    const a = area(key);
    gate[key === "facts" ? "business_facts" : "content_rules"] = a?.status ?? "missing";
    if (a?.status !== "ready") refuse(`${key}_not_ready`, `${label} are not ready: ${(a?.gaps ?? []).join(" ") || "missing."}`);
  }

  // ── Offer ──
  let offer: Brief["target"]["offer"] = null;
  if (target.postType === "offer") {
    const current = currentOffers(input.offers, input.asOf);
    const o = current.find((x) => x.id === target.offerId);
    if (!target.offerId) refuse("offer_missing", "An offer post needs one of the client's offers.");
    else if (!o) refuse("offer_not_current", "The offer is not confirmed and current.");
    else offer = { id: o.id, title: o.title, terms: o.terms, starts_on: o.starts_on, ends_on: o.ends_on };
    gate.offer = o ? "confirmed_current" : "not_usable";
  } else {
    if (target.offerId) refuse("offer_not_applicable", "Offers go only on offer posts.");
    gate.offer = "not_applicable";
  }

  // ── Service and target page ──
  const needsService = target.postType === "standard" && intent !== "navigational";
  let service: DrafterInput["services"][number] | null = null;
  let pageUrl: string | null = null;
  let pageGroupId: string | null = null;
  if (target.serviceId) {
    service = input.services.find((s) => s.id === target.serviceId) ?? null;
    if (!service) refuse("service_unknown", "The service is not one of this client's services.");
    else if (service.status !== "approved") refuse("service_not_approved", `${service.name} is ${service.status}, not approved.`);
  } else if (needsService) {
    refuse("service_missing", `A standard ${intent} post needs an approved service as its topic.`);
  }
  if (service) {
    const page = normalizeUrl(service.page_url);
    const siteHost = hostOf(input.client.website_url);
    if (!page) refuse("target_page_missing", `${service.name} has no page to link to.`);
    else if (!page.startsWith("https://")) refuse("target_page_invalid", `${service.page_url} is not an https page.`);
    else if (!siteHost || hostOf(page) !== siteHost) refuse("target_page_invalid", `${service.page_url} is not on the client's website (${input.client.website_url}).`);
    else {
      const group = input.pageGroups.find((g) => normalizeUrl(g.target_url) === page);
      if (!group) refuse("target_page_unapproved", `No page group targets ${service.page_url}.`);
      else if (group.status !== "approved") refuse("target_page_unapproved", `The page group for ${service.page_url} is ${group.status}, not approved.`);
      else {
        pageUrl = service.page_url;
        pageGroupId = group.id;
      }
    }
    gate.service = service.status === "approved" && pageUrl ? "approved_with_page" : "not_ready";
  }

  // ── CTA ──
  const ctaType = target.ctaType?.trim() || null;
  let ctaUrl: string | null = null;
  if (target.postType === "standard" && ctaType) {
    if (!(GBP_CTA_TYPES as readonly string[]).includes(ctaType)) refuse("cta_invalid", `"${ctaType}" is not a Business Profile button.`);
    else if (ctaType === "CALL") {
      if (target.ctaUrl) refuse("cta_invalid", "A Call button takes no link.");
    } else {
      const want = pageUrl ?? (intent === "navigational" ? input.client.website_url : null);
      if (!want) refuse("cta_invalid", "The button needs the approved target page.");
      else if (target.ctaUrl && normalizeUrl(target.ctaUrl) !== normalizeUrl(want)) refuse("cta_invalid", `The button must link to the target page ${want}, not ${target.ctaUrl}.`);
      else ctaUrl = want;
    }
  }

  // ── Keyword (optional) ──
  let keyword: Brief["target"]["keyword"] = null;
  if (target.keywordId) {
    const k = input.keywords.find((x) => x.id === target.keywordId);
    if (!k) refuse("keyword_unknown", "The keyword is not one of this client's keywords.");
    else {
      if (!k.is_active) refuse("keyword_inactive", `"${k.keyword}" is not active.`);
      if (service && k.service_id !== service.id && service.primary_keyword_id !== k.id) refuse("keyword_wrong_service", `"${k.keyword}" is not mapped to ${service.name}.`);
      if (normalizeIntent(k.intent) !== intent) refuse("keyword_intent_mismatch", `"${k.keyword}" is ${k.intent ?? "unlabelled"}, not ${intent}.`);
      if (k.target_url && pageUrl && normalizeUrl(k.target_url) !== normalizeUrl(pageUrl)) refuse("keyword_wrong_page", `"${k.keyword}" targets ${k.target_url}, not ${pageUrl}.`);
      keyword = { id: k.id, text: k.keyword, tracked: !!k.is_tracked, money: !!k.is_money, max_exact_uses: KEYWORD_MAX_EXACT_USES };
    }
  }

  // ── Claims ──
  const usable = new Set(usableClaims(input.claims).map((c) => c.id));
  const differentiators = (input.brand?.differentiators ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const diffSet = new Set(differentiators.map((d) => d.toLowerCase()));
  const tokens = service ? serviceTokens(service) : [];
  const eligible: BriefClaim[] = [];
  const excludedClaims: Brief["excluded"]["claims"] = [];
  for (const c of input.claims) {
    if (!usable.has(c.id)) {
      excludedClaims.push({ id: c.id, text: c.claim, reason: c.status === "sourced" ? "Marked sourced but has no source." : `${c.status}: never cited.` });
      continue;
    }
    const cats = claimCategories(c.claim);
    const hard = cats.find((x) => EXCLUDED_CATEGORIES[x]);
    if (hard) { excludedClaims.push({ id: c.id, text: c.claim, reason: EXCLUDED_CATEGORIES[hard] }); continue; }
    const needsConfirm = cats.find((x) => CONFIRMED_ONLY[x]);
    if (needsConfirm && c.status !== "confirmed") { excludedClaims.push({ id: c.id, text: c.claim, reason: CONFIRMED_ONLY[needsConfirm] }); continue; }
    // Relevance to the topic (deterministic; a person reviews the result).
    const why: string[] = [];
    let score = 0;
    if (pageUrl && normalizeUrl(c.source) === normalizeUrl(pageUrl)) { score += 3; why.push("sourced from the target page"); }
    if (tokens.length && mentions(c.claim, tokens)) { score += 2; why.push("names the service"); }
    if (diffSet.has(c.claim.trim().toLowerCase())) { score += 2; why.push("matches an approved brand differentiator"); }
    if (tokens.length && mentions(sourcePath(c.source), tokens)) { score += 1; why.push("source is about the service's segment"); }
    if (service && score === 0) { excludedClaims.push({ id: c.id, text: c.claim, reason: `Not related to ${service.name}.` }); continue; }
    eligible.push({ id: c.id, text: c.claim, status: c.status, source: c.source, relevance: score, why });
  }
  eligible.sort((a, b) => b.relevance - a.relevance || a.text.localeCompare(b.text));
  const minClaims = intent === "navigational" ? 0 : 1;
  if (intent && intent !== "navigational" && eligible.length === 0) {
    refuse("no_usable_claim", `A ${intent} post needs at least one relevant confirmed or sourced claim${service ? ` about ${service.name}` : ""}.`);
  }
  gate.usable_claims = String(eligible.length);

  // ── Assets (optional, approved brand photos with a stored file) ──
  const assets: Brief["target"]["assets"] = [];
  for (const id of target.assetIds ?? []) {
    const a = input.assets.find((x) => x.id === id);
    if (!a) refuse("asset_unknown", "The photo is not one of this client's brand assets.");
    else if (a.kind !== "photo" || !a.storage_path) refuse("asset_unusable", `Asset ${a.label ?? a.id} is not a stored photo.`);
    else assets.push({ id: a.id, kind: a.kind, label: a.label, storage_path: a.storage_path });
  }
  if (assets.length > 1) refuse("too_many_assets", "Business Profile posts take one photo in v1.");

  // ── Facts a draft may state; what it may not ──
  const places = [...new Set(input.locations.filter((l) => l.is_active).map((l) => l.city ?? l.name).filter(Boolean) as string[])];
  const excludedFacts: Brief["excluded"]["facts"] = [];
  if (filled(input.client.service_area)) {
    excludedFacts.push({ fact: `Service area text: "${input.client.service_area}"`, reason: "Only active locations are approved places; the free-text service area is not." });
  }
  if (filled(input.client.address_line1)) excludedFacts.push({ fact: "Street address", reason: "Never stated (hard rule)." });
  for (const d of differentiators) {
    if (!eligible.some((c) => c.text.toLowerCase() === d.toLowerCase())) {
      excludedFacts.push({ fact: `Differentiator: "${d}"`, reason: "Brand guidance, not evidence: stating it as fact needs its own usable claim." });
    }
  }

  if (refusals.length || !intent) return { ok: false, refusals };

  const brief: Brief = {
    version: DRAFTER_VERSION,
    as_of: input.asOf,
    client: { id: input.client.id, name: input.client.name, phone: input.client.phone ?? "", website: input.client.website_url ?? "" },
    gate,
    target: {
      channel: target.channel as Brief["target"]["channel"],
      post_type: target.postType,
      search_intent: intent,
      service: service && pageUrl && pageGroupId ? { id: service.id, name: service.name, page_url: pageUrl, page_group_id: pageGroupId } : null,
      keyword,
      cta: { type: ctaType, url: ctaUrl, in_copy_phrase: input.board?.standing_cta ?? null },
      offer,
      assets,
    },
    allowed_facts: {
      crm: {
        business_name: input.client.name,
        phone: input.client.phone ?? "",
        website: input.client.website_url ?? "",
        places,
        services: service ? [service.name] : input.services.filter((s) => s.status === "approved").map((s) => s.name),
      },
      claims: eligible,
      recommended_claim_ids: eligible.slice(0, MAX_CLAIMS).map((c) => c.id),
      min_claims: minClaims,
      max_claims: MAX_CLAIMS,
    },
    excluded: { claims: excludedClaims, facts: excludedFacts },
    brand: {
      positioning: input.brand?.positioning ?? null,
      voice_tone: input.brand?.voice_tone ?? null,
      audience: input.brand?.audience ?? null,
      tagline: input.brand?.tagline ?? null,
      words_we_use: input.brand?.words_we_use ?? [],
      words_we_avoid: input.brand?.words_we_avoid ?? [],
      ai_guidance: input.brand?.ai_guidance ?? null,
      hard_rules: (input.board?.hard_rules ?? []) as string[],
      standing_cta: input.board?.standing_cta ?? null,
      differentiators,
      differentiators_citable: false,
    },
    channel_rules: {
      min_chars: GBP_RULES.min_chars,
      preferred_min_chars: GBP_RULES.preferred_min_chars,
      preferred_max_chars: GBP_RULES.preferred_max_chars,
      max_chars: GBP_RULES.max_chars,
      hard_max_chars: GBP_SUMMARY_MAX,
      lead_chars: GBP_RULES.lead_chars,
      hashtags: false,
      urls_in_body: false,
      keyword_max_exact_uses: KEYWORD_MAX_EXACT_USES,
    },
  };
  return { ok: true, brief };
}

// sha256 of the brief's stable JSON (Web Crypto: Node and Deno alike).
export async function briefHash(brief: Brief): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(brief));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
