import { workspaceGate } from "./workspace.ts";
// AI Drafter v1: the Governed Brief Builder. Pure; reads nothing, writes
// nothing, knows no model.
//
// Takes the canonical Client Intelligence input (the same rows the
// Intelligence tab assesses) and one named target, and returns either the
// brief a model may write from or every reason the draft is not eligible.
//
// The gate is per draft (approved Sept 25 2026): what THIS draft needs must be
// ready — approved brand board, business facts, content rules, a governed
// keyword by default, an approved service with an approved target page,
// matching keyword / intent / service / page mappings, a relevant usable claim,
// and a confirmed
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
import { FACEBOOK_MAX_CHARS } from "../post-publisher/facebook.ts";
import {
  DRAFT_CHANNELS,
  DRAFTER_VERSION,
  type Brief,
  type BriefClaim,
  type BriefResult,
  type DrafterInput,
  type DraftTarget,
  type Refusal,
  type SocialAccountRow,
} from "./types.ts";
import { claimCategories, hostOf, normalizeUrl, stableJson, words } from "./rules.ts";
import { assessIntent } from "../authority/intent.ts";
import { approvedMarketPlaces, normWords, ownerNormUrl, resolveKeywordOwner, type OwnerContext, type OwnerPurpose } from "../authority/keyword-owner.ts";
import { buildPlaceIndex } from "../authority/urls.ts";

export const MAX_CLAIMS = 2;
export const KEYWORD_MAX_EXACT_USES = 1;
// Compass's own quality range for a Business Profile post (Sept 25 2026):
// at least 300, aim for about 450–700, normally no more than 900. Google's
// limit (GBP_SUMMARY_MAX, 1500) is the channel's hard maximum, separately.
export const GBP_RULES = { min_chars: 300, preferred_min_chars: 450, preferred_max_chars: 700, max_chars: 900, lead_chars: 100 } as const;
// Facebook (Oct 11 2026): the same quality floor in spirit, a little more
// room. FACEBOOK_MAX_CHARS is Facebook's own limit, separately.
export const FACEBOOK_RULES = { min_chars: 200, preferred_min_chars: 350, preferred_max_chars: 800, max_chars: 1200, lead_chars: 120 } as const;

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

// The claims a draft may cite, most relevant first, and every other claim
// with the reason it is not citable. Shared with the content-drafter
// (blogs / pages), so both apply one rule: usable (confirmed, or sourced
// with a source), not a never-cited category, confirmation where the hard
// rules ask for it, and — when the draft has a service — related to it.
export function eligibleClaims(
  input: Pick<DrafterInput, "claims" | "brand">,
  service: { name: string; segment?: string | null } | null,
  pageUrl: string | null,
): { eligible: BriefClaim[]; excluded: Brief["excluded"]["claims"] } {
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
  return { eligible, excluded: excludedClaims };
}

// The owner context the loader returns (20261028170000). A fixture or a legacy
// caller without one gets the same resolver over the input's own rows, with
// nothing checked live and every group taken as a service page: enforce is
// off, so only explicit conflicts, wrong pages and holds refuse.
export function ownerContextOf(input: DrafterInput): OwnerContext {
  const given = (input as DrafterInput & { owner_context?: OwnerContext }).owner_context;
  if (given) return given;
  return {
    enforce: false,
    program_id: null,
    site_url: input.client.website_url ?? null,
    workspaces: [],
    keywords: input.keywords.map((k) => ({ id: k.id, keyword: k.keyword, is_active: !!k.is_active, intent: k.intent ?? null,
      service_id: k.service_id ?? null, target_url: k.target_url ?? null, city: null, market_id: null, core_parent_keyword_id: null })),
    services: input.services.map((s) => ({ id: s.id, status: s.status, page_url: s.page_url ?? null, primary_keyword_id: s.primary_keyword_id ?? null })),
    page_groups: input.pageGroups.map((g) => ({ id: g.id, status: g.status, page_type: (g as { page_type?: string }).page_type ?? "service",
      target_url: g.target_url, primary_keyword_id: g.primary_keyword_id })),
    published_posts: [],
    markets: [],
    page_checks: [],
    holds: [],
    as_of: `${input.asOf}T12:00:00Z`,
  };
}

export function buildBrief(
  input: DrafterInput,
  target: DraftTarget,
  extra: { socialAccounts?: SocialAccountRow[]; purpose?: OwnerPurpose } = {},
): BriefResult {
  // Missing target fields inherit from the selected keyword. Explicit
  // disagreements still refuse below; never rewrite the stored keyword.
  const selected = input.keywords.find((k) => k.id === target.keywordId);
  target = { ...target, intent: target.intent?.trim() || selected?.intent || "",
    serviceId: target.serviceId ?? selected?.service_id ?? null };
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

  // ── Campaign foundation ──
  // Every new campaign starts with a governed keyword, including brand and
  // community angles. Retain the old mode in stored records, never as a bypass.
  const campaignMode = "keyword" as const;
  if (!target.keywordId) {
    refuse("keyword_missing", "Choose an active keyword from this client's governed keyword list before generating content.");
  }
  if (target.campaignMode === "non_search") {
    refuse("campaign_mode_retired", "Keyword provenance is required for every new campaign. Choose a governed keyword and use keyword mode.");
  }

  // ── Facebook: a standard post with no button, on a named Page of this client ──
  const facebook = target.channel === "facebook";
  let socialAccount: Brief["target"]["social_account"] | null = null;
  if (facebook) {
    if (target.postType !== "standard") refuse("post_type_invalid", "Facebook drafts are standard posts in v1.");
    if (target.ctaType?.trim() || target.ctaUrl?.trim()) refuse("cta_not_applicable", "Facebook posts carry no button.");
    const account = (extra.socialAccounts ?? []).find((a) => a.id === target.socialAccountId && a.platform === "facebook");
    if (!target.socialAccountId) refuse("social_account_missing", "A Facebook draft names the client's Facebook Page (socialAccountId).");
    else if (!account) refuse("social_account_unknown", "The Facebook Page is not one of this client's Facebook accounts.");
    else socialAccount = { id: account.id, page_id: account.external_account_id, name: account.display_name };
  } else {
    // A Business Profile draft goes to one of the client's verified locations:
    // the one it names, or the only one. With several, it must name one
    // (drafter_write enforces the same; 20261027190935).
    const locations = (extra.socialAccounts ?? []).filter((a) => a.platform === "google_business"
      && a.publish_provider === "zernio" && !!a.publish_page_id && !!a.publish_verified_at);
    if (target.socialAccountId) {
      const location = locations.find((a) => a.id === target.socialAccountId);
      if (!location) refuse("social_account_unknown", "The Business Profile location is not one of this client's verified locations.");
      else socialAccount = { id: location.id, page_id: location.publish_page_id ?? null, name: location.display_name };
    } else if (locations.length > 1) {
      refuse("social_account_missing", `This client has ${locations.length} Business Profile locations; the draft names one (socialAccountId).`);
    }
  }

  // ── Per-draft gate ──
  const gate: Record<string, string> = workspaceGate(input);
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

  // ── Owner page and related service (20261028170000) ──
  // The keyword's owner page is the one page that explicitly claims it; the
  // service is the related topic. One resolver (authority/keyword-owner.ts,
  // SQL's keyword_owner() twin) decides, for this purpose.
  const ownerCtx = ownerContextOf(input);
  // The site program comes from the loader's owner context (the brand site it
  // scoped the input to); a derived legacy context has none.
  const program = ownerCtx.program_id;
  const purpose: OwnerPurpose = extra.purpose ?? "post";
  let service: DrafterInput["services"][number] | null = null;
  let pageUrl: string | null = null;
  let pageGroupId: string | null = null;
  let ownerPage: Brief["target"]["owner_page"] = null;
  if (target.serviceId) {
    service = input.services.find((s) => s.id === target.serviceId) ?? null;
    if (!service) refuse("service_unknown", "The service is not one of this client's services.");
    else if (service.status !== "approved") refuse("service_not_approved", `${service.name} is ${service.status}, not approved.`);
  }
  if (target.keywordId) {
    const owned = resolveKeywordOwner(ownerCtx, target.keywordId, { program, purpose });
    if (!owned.ok) refuse(owned.code, `${owned.message}`);
    else {
      pageUrl = owned.owner.display_url;
      pageGroupId = owned.owner.page_group_id;
      ownerPage = { url: owned.owner.url, display_url: owned.owner.display_url, page_group_id: owned.owner.page_group_id,
        role: owned.owner.role, market: owned.owner.market, program_id: owned.owner.program_id };
      gate.owner_page = `${owned.owner.role}${owned.notes.length ? " (not enforced: " + owned.notes.join("; ") + ")" : ""}`;
    }
  }
  if (service) gate.service = service.status === "approved" && pageUrl ? "approved_with_owner_page" : "not_ready";

  // ── CTA ──
  const ctaType = target.ctaType?.trim() || null;
  let ctaUrl: string | null = null;
  if (target.postType === "standard" && ctaType) {
    if (!(GBP_CTA_TYPES as readonly string[]).includes(ctaType)) refuse("cta_invalid", `"${ctaType}" is not a Business Profile button.`);
    else if (ctaType === "CALL") {
      if (target.ctaUrl) refuse("cta_invalid", "A Call button takes no link.");
    } else {
      const want = pageUrl;
      if (!want) refuse("cta_invalid", "The button needs the keyword's owner page.");
      else if (target.ctaUrl && ownerNormUrl(target.ctaUrl) !== ownerNormUrl(want)) refuse("cta_invalid", `The button must link to the owner page ${want}, not ${target.ctaUrl}.`);
      else ctaUrl = want;
    }
  }

  // ── Keyword foundation ──
  let keyword: Brief["target"]["keyword"] = null;
  if (target.keywordId) {
    const k = input.keywords.find((x) => x.id === target.keywordId);
    if (!k) refuse("keyword_unknown", "The keyword is not one of this client's keywords.");
    else {
      if (!k.is_active) refuse("keyword_inactive", `"${k.keyword}" is not active.`);
      if (service && (k.service_id ? k.service_id !== service.id : service.primary_keyword_id !== k.id)) refuse("keyword_wrong_service", `"${k.keyword}" is not mapped to ${service.name}.`);
      if (normalizeIntent(k.intent) !== intent) refuse("keyword_intent_mismatch", `"${k.keyword}" is ${k.intent ?? "unlabelled"}, not ${intent}.`);
      const places = input.locations.map((l) => l.city || l.name).filter((p): p is string => !!p);
      const assessed = assessIntent(k.keyword, normalizeIntent(k.intent), {
        clientName: input.client.name, places: buildPlaceIndex(places, places, []),
      });
      if (assessed.conflict) refuse("keyword_intent_conflict", `"${k.keyword}": ${assessed.reason} Review the keyword intent before drafting.`);
      keyword = { id: k.id, text: k.keyword, tracked: !!k.is_tracked, money: !!k.is_money, max_exact_uses: KEYWORD_MAX_EXACT_USES };
    }
  }

  // ── Claims ──
  const differentiators = (input.brand?.differentiators ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const { eligible, excluded: excludedClaims } = eligibleClaims(input, service, pageUrl);
  const minClaims = intent === "navigational" ? 0 : 1;
  if (campaignMode === "keyword" && intent && intent !== "navigational" && eligible.length === 0) {
    refuse("no_usable_claim", `A ${intent} post needs at least one relevant confirmed or sourced claim${service ? ` about ${service.name}` : ""}.`);
  }
  gate.usable_claims = String(eligible.length);

  // ── Assets (optional, approved brand photos with a stored file) ──
  const assets: Brief["target"]["assets"] = [];
  // Either channel may carry a stored social graphic (kind social_post)
  // instead of a photo (Tom, Oct 15 2026 for Business Profile). A graphic is
  // presentation, never evidence: it is not a photo of the client's work and
  // supports no claim. The database checks the stored file's hash; the
  // publisher's preflight still enforces Google's format, size and dimensions.
  const kinds = ["photo", "social_post"];
  for (const id of target.assetIds ?? []) {
    const a = input.assets.find((x) => x.id === id);
    if (!a) refuse("asset_unknown", "The photo is not one of this client's brand assets.");
    else if (!kinds.includes(a.kind) || !a.storage_path) refuse("asset_unusable", `Asset ${a.label ?? a.id} is not a stored photo or social graphic.`);
    else assets.push({ id: a.id, kind: a.kind, label: a.label, storage_path: a.storage_path });
  }
  if (assets.length > 1) refuse("too_many_assets", facebook ? "Facebook posts take one image in v1." : "Business Profile posts take one image in v1.");

  // ── Facts a draft may state; what it may not ──
  const places = [...new Set([
    ...input.locations.filter((l) => l.is_active).map((l) => l.city ?? l.name),
    ...approvedMarketPlaces(ownerCtx, program),
  ].filter(Boolean) as string[])];
  // Offerings held from promotion: the linter refuses copy that names them.
  const heldOfferings = ownerCtx.holds.filter((h) => h.brand_workspace_id === null || h.brand_workspace_id === program)
    .map((h) => ({ offering: h.offering, phrases: h.phrases.map(normWords) }));
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
      campaign_mode: campaignMode,
      search_intent: intent,
      // The related service (the topic); its page is not the owner unless the resolver said so.
      service: service ? { id: service.id, name: service.name, page_url: service.page_url ?? null,
        page_group_id: ownerPage && service.page_url && ownerNormUrl(service.page_url) === ownerPage.url ? pageGroupId : null } : null,
      owner_page: ownerPage,
      keyword,
      cta: { type: ctaType, url: ctaUrl, in_copy_phrase: input.board?.standing_cta ?? null },
      offer,
      assets,
      ...(socialAccount ? { social_account: socialAccount } : {}),
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
    excluded: { claims: excludedClaims, facts: excludedFacts, offerings: heldOfferings },
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
      min_chars: (facebook ? FACEBOOK_RULES : GBP_RULES).min_chars,
      preferred_min_chars: (facebook ? FACEBOOK_RULES : GBP_RULES).preferred_min_chars,
      preferred_max_chars: (facebook ? FACEBOOK_RULES : GBP_RULES).preferred_max_chars,
      max_chars: (facebook ? FACEBOOK_RULES : GBP_RULES).max_chars,
      hard_max_chars: facebook ? FACEBOOK_MAX_CHARS : GBP_SUMMARY_MAX,
      lead_chars: (facebook ? FACEBOOK_RULES : GBP_RULES).lead_chars,
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
