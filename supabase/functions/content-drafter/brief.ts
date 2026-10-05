// content-drafter: the governed brief for a blog draft (0067). Pure.
//
// Built from the same canonical Client Intelligence input as the post
// drafter (client_intelligence_input, 0047) and the same gate and claim
// rules (post-drafter/brief.ts eligibleClaims), plus what a long-form piece
// needs: the topic and keyword from the request, the internal pages it may
// link to (the client's own approved pages only), the standing CTA, and
// structure rules. The brief is the whole of what a draft may say.
import { assessIntelligence, normalizeIntent, type IntelligenceInput } from "../../../src/lib/client-intelligence.ts";
import { eligibleClaims } from "../post-drafter/brief.ts";
import { hostOf, normalizeUrl, stableJson } from "../post-drafter/rules.ts";
import type { BriefClaim, DrafterInput, Refusal } from "../post-drafter/types.ts";

export const CONTENT_DRAFTER_VERSION = "content-drafter-v1";

// Compass's blog rules (v1). The weekly blog has always been 700–1,100
// words; a long piece may run to 2,000.
export const BLOG_RULES = {
  min_words: 700,
  preferred_min_words: 800,
  preferred_max_words: 1400,
  max_words: 2000,
  meta_title_preferred_max: 60,
  meta_title_max: 70,
  meta_description_min: 70,
  meta_description_preferred_min: 120,
  meta_description_preferred_max: 160,
  meta_description_max: 170,
  slug_max: 80,
  h1_max: 120,
  min_sections: 3,
  min_claims: 1,
  max_claims: 4,
  keyword_max_exact_uses: 5,
} as const;

// The draft row the request opened (0067), as the store reads it.
export type DraftRow = {
  id: string;
  client_id: string;
  plan_item_id: string | null;
  deliverable: string;
  status: string;
  topic: string;
  primary_keyword: string | null;
  keyword_id: string | null;
  search_intent: string | null;
  service_id: string | null;
  authority_opportunity_id: string | null;
  target_url: string | null;
  request_note: string | null;
};

// Other pages on the client's site the store found (published articles).
export type SitePage = { url: string; title: string };

export type LinkTarget = { url: string; label: string; kind: "service" | "page" | "article" | "home" };

export type BlogBrief = {
  version: typeof CONTENT_DRAFTER_VERSION;
  kind: "blog";
  as_of: string;
  client: { id: string; name: string; phone: string; website: string };
  gate: Record<string, string>;
  target: {
    draft_id: string;
    topic: string;
    primary_keyword: string | null;
    search_intent: string;
    service: { id: string; name: string; page_url: string | null } | null;
    authority_opportunity_id: string | null;
    request_note: string | null;
  };
  allowed_facts: {
    crm: { business_name: string; phone: string; website: string; places: string[]; services: string[] };
    claims: BriefClaim[];
    recommended_claim_ids: string[];
    min_claims: number;
    max_claims: number;
  };
  excluded: { claims: { id: string; text: string; reason: string }[]; facts: { fact: string; reason: string }[] };
  brand: {
    positioning: string | null;
    voice_tone: string | null;
    audience: string | null;
    tagline: string | null;
    words_we_use: string[];
    words_we_avoid: string[];
    ai_guidance: string | null;
    hard_rules: string[];
    standing_cta: string | null;
    differentiators: string[];
    differentiators_citable: false;
  };
  links: { site: string | null; required: LinkTarget[]; allowed: LinkTarget[] };
  cta: { text: string | null; url: string | null };
  rules: typeof BLOG_RULES;
};

export type BlogBriefResult = { ok: true; brief: BlogBrief } | { ok: false; refusals: Refusal[] };

const filled = (s: string | null | undefined) => (s ?? "").trim().length > 0;

export function buildBlogBrief(input: DrafterInput, draft: DraftRow, sitePages: SitePage[] = []): BlogBriefResult {
  const refusals: Refusal[] = [];
  const refuse = (code: string, message: string) => refusals.push({ code, message });

  if (draft.deliverable !== "blog") refuse("deliverable_unsupported", "The content drafter writes blogs in v1; web pages come next.");
  const intent = normalizeIntent(draft.search_intent);
  if (!intent) refuse("intent_missing", "Set the search intent on the plan item before generating.");

  // ── The same per-draft gate as the post drafter ──
  const areas = assessIntelligence(input as unknown as IntelligenceInput);
  const area = (key: string) => areas.find((a) => a.key === key);
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

  // ── Service and its page ──
  const site = filled(input.client.website_url) ? input.client.website_url! : null;
  const siteHost = hostOf(site);
  let service: DrafterInput["services"][number] | null = null;
  let pageUrl: string | null = null;
  if (draft.service_id) {
    service = input.services.find((s) => s.id === draft.service_id) ?? null;
    if (!service) refuse("service_unknown", "The service is not one of this client's services.");
    else if (service.status !== "approved") refuse("service_not_approved", `${service.name} is ${service.status}, not approved.`);
    else if (service.page_url) {
      const page = normalizeUrl(service.page_url);
      if (!page || !siteHost || hostOf(page) !== siteHost) refuse("target_page_invalid", `${service.page_url} is not on the client's website.`);
      else pageUrl = service.page_url;
    }
  }
  gate.service = service ? (pageUrl ? "approved_with_page" : "approved_no_page") : "none";

  // ── Claims: the post drafter's rule ──
  const { eligible, excluded } = eligibleClaims(input, service, pageUrl);
  if (intent && intent !== "navigational" && eligible.length === 0) {
    refuse("no_usable_claim", `A ${intent} article needs at least one relevant confirmed or sourced claim${service ? ` about ${service.name}` : ""}.`);
  }
  gate.usable_claims = String(eligible.length);

  // ── Links: the client's own approved pages, nothing else ──
  const allowed: LinkTarget[] = [];
  const add = (url: string | null | undefined, label: string, kind: LinkTarget["kind"]) => {
    const n = normalizeUrl(url);
    if (!n || !siteHost || hostOf(n) !== siteHost || allowed.some((l) => normalizeUrl(l.url) === n)) return;
    allowed.push({ url: url!, label, kind });
  };
  if (site) add(site, `${input.client.name} home page`, "home");
  for (const s of input.services) if (s.status === "approved") add(s.page_url, s.name, "service");
  for (const g of input.pageGroups) if (g.status === "approved") add(g.target_url, g.name, "page");
  for (const p of sitePages) add(p.url, p.title, "article");
  const required = pageUrl ? allowed.filter((l) => normalizeUrl(l.url) === normalizeUrl(pageUrl)) : [];

  const differentiators = (input.brand?.differentiators ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const places = [...new Set(input.locations.filter((l) => l.is_active).map((l) => l.city ?? l.name).filter(Boolean) as string[])];
  const excludedFacts: BlogBrief["excluded"]["facts"] = [];
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

  return {
    ok: true,
    brief: {
      version: CONTENT_DRAFTER_VERSION,
      kind: "blog",
      as_of: input.asOf,
      client: { id: input.client.id, name: input.client.name, phone: input.client.phone ?? "", website: site ?? "" },
      gate,
      target: {
        draft_id: draft.id,
        topic: draft.topic,
        primary_keyword: draft.primary_keyword,
        search_intent: intent,
        service: service ? { id: service.id, name: service.name, page_url: pageUrl } : null,
        authority_opportunity_id: draft.authority_opportunity_id,
        request_note: draft.request_note,
      },
      allowed_facts: {
        crm: {
          business_name: input.client.name,
          phone: input.client.phone ?? "",
          website: site ?? "",
          places,
          services: input.services.filter((s) => s.status === "approved").map((s) => s.name),
        },
        claims: eligible,
        recommended_claim_ids: eligible.slice(0, BLOG_RULES.max_claims).map((c) => c.id),
        min_claims: intent === "navigational" ? 0 : BLOG_RULES.min_claims,
        max_claims: BLOG_RULES.max_claims,
      },
      excluded: { claims: excluded, facts: excludedFacts },
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
      links: { site, required, allowed },
      cta: { text: input.board?.standing_cta ?? null, url: pageUrl ?? site },
      rules: BLOG_RULES,
    },
  };
}

export async function blogBriefHash(brief: BlogBrief): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(brief)));
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
