// AI Drafter v1: shared shapes. Vendor- and runtime-neutral.
//
//   Governed Brief Builder (brief.ts)  →  Model Adapter  →  Deterministic
//   Linter (lint.ts)  →  Governed Write Path (Deliverable 2)
//
// Nothing in this directory knows which model writes the copy. A model
// adapter receives a ModelRequest (prompt.ts renders it from the brief) and
// must return a ModelDraft; the linter judges that draft against the same
// brief. In v1 the adapter is the Claude worker skill; an API model, a
// Compass-native agent or a router can replace it without touching the brief,
// the linter or the post records.
//
// Write boundary (Deliverable 2): no model runtime — the Claude worker or any
// successor — ever persists drafter records by direct SQL. Persistent drafter
// operations go only through the governed Edge Function write path, and
// migration 0045's grounding plus a person's approval stay mandatory.
import type { IntelligenceInput, OfferRow, SearchIntent } from "../../../src/lib/client-intelligence.ts";

export const DRAFTER_VERSION = "drafter-v1";

// Channels the drafter writes for in v1.
export const DRAFT_CHANNELS = ["google_business"] as const;
export type DraftChannel = (typeof DRAFT_CHANNELS)[number];

// Everything the brief builder reads: the canonical Client Intelligence input
// plus the ids and page groups a draft has to point at. Loaded read-only.
export type DrafterInput = {
  client: IntelligenceInput["client"] & { id: string };
  brand:
    | (NonNullable<IntelligenceInput["brand"]> & { tagline?: string | null })
    | null;
  board: (NonNullable<IntelligenceInput["board"]> & { id: string; version: number }) | null;
  services: (IntelligenceInput["services"][number] & { segment?: string | null })[];
  keywords: IntelligenceInput["keywords"];
  claims: IntelligenceInput["claims"];
  locations: IntelligenceInput["locations"];
  assets: (IntelligenceInput["assets"][number] & { id: string; label: string | null; storage_path: string | null })[];
  offers: OfferRow[];
  pageGroups: { id: string; name: string; status: string; target_url: string | null; primary_keyword_id: string | null }[];
  // The day offers are judged against (YYYY-MM-DD, Compass's Central day).
  asOf: string;
};

// The fields client_intelligence_input() (migration 0047) returns, section
// by section. The type checks below fail to compile if this list and
// DrafterInput drift apart; tests/client-intelligence-loader.test.mjs fails
// if the SQL and this list drift apart. Together: SQL ≡ list ≡ type.
export const DRAFTER_INPUT_FIELDS = {
  asOf: null,
  client: ["id", "name", "phone", "website_url", "city", "state", "service_area", "business_type", "address_line1"],
  brand: ["positioning", "voice_tone", "audience", "differentiators", "ai_guidance", "words_we_use", "words_we_avoid", "content_pillars", "tagline"],
  board: ["id", "version", "status", "hard_rules", "standing_cta"],
  services: ["id", "name", "status", "page_url", "primary_keyword_id", "parent_service_id", "segment"],
  keywords: ["id", "keyword", "intent", "intent_note", "is_active", "is_tracked", "is_money", "service_id", "target_url", "priority"],
  claims: ["id", "claim", "status", "source"],
  locations: ["name", "city", "state", "is_active"],
  assets: ["id", "kind", "label", "storage_path"],
  offers: ["id", "title", "terms", "source", "status", "starts_on", "ends_on", "confirmed_by", "confirmed_on", "service_id"],
  pageGroups: ["id", "name", "status", "target_url", "primary_keyword_id"],
} as const;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Item<T> = T extends readonly (infer U)[] ? U : NonNullable<T>;
type Listed<K extends keyof typeof DRAFTER_INPUT_FIELDS> = (typeof DRAFTER_INPUT_FIELDS)[K] extends readonly (infer F)[] ? F : never;
export type DrafterInputFieldsMatch = {
  [K in keyof DrafterInput]-?: K extends "asOf" ? true : Exact<Listed<K>, keyof Item<DrafterInput[K]>>;
};
// Compile-time: every section's listed fields are exactly the type's keys,
// and the sections are exactly DrafterInput's keys.
const _fieldsMatch: DrafterInputFieldsMatch = {
  asOf: true, client: true, brand: true, board: true, services: true, keywords: true, claims: true,
  locations: true, assets: true, offers: true, pageGroups: true,
};
const _sectionsMatch: Exact<keyof typeof DRAFTER_INPUT_FIELDS, keyof DrafterInput> = true;
void _fieldsMatch;
void _sectionsMatch;

// What a person or the worker asks for. Nothing is inferred: v1 drafts one
// named topic at a time.
export type DraftTarget = {
  channel: string;
  postType: "standard" | "offer";
  intent: string;
  serviceId: string | null;
  keywordId?: string | null;
  ctaType: string | null;
  ctaUrl?: string | null;
  offerId?: string | null;
  assetIds?: string[];
};

export type Refusal = { code: string; message: string };

export type BriefClaim = {
  id: string;
  text: string;
  status: string;
  source: string | null;
  relevance: number;
  why: string[];
};

export type Brief = {
  version: typeof DRAFTER_VERSION;
  as_of: string;
  client: { id: string; name: string; phone: string; website: string };
  gate: Record<string, string>;
  target: {
    channel: DraftChannel;
    post_type: "standard" | "offer";
    search_intent: SearchIntent;
    service: { id: string; name: string; page_url: string; page_group_id: string } | null;
    keyword: { id: string; text: string; tracked: boolean; money: boolean; max_exact_uses: number } | null;
    cta: { type: string | null; url: string | null; in_copy_phrase: string | null };
    offer: { id: string; title: string; terms: string; starts_on: string | null; ends_on: string | null } | null;
    assets: { id: string; kind: string; label: string | null; storage_path: string }[];
  };
  allowed_facts: {
    crm: { business_name: string; phone: string; website: string; places: string[]; services: string[] };
    // Claims the draft may link, most relevant first; recommended = the ones
    // to prefer, at most max_claims.
    claims: BriefClaim[];
    recommended_claim_ids: string[];
    min_claims: number;
    max_claims: number;
  };
  excluded: {
    claims: { id: string; text: string; reason: string }[];
    facts: { fact: string; reason: string }[];
  };
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
    // Tone and topic only. A differentiator stated as a fact needs its own
    // usable claim; brand approval is not claim confirmation.
    differentiators: string[];
    differentiators_citable: false;
  };
  // A Compass quality rule, not Google's API limit (hard_max_chars is that).
  channel_rules: {
    min_chars: number;
    preferred_min_chars: number;
    preferred_max_chars: number;
    max_chars: number;
    hard_max_chars: number;
    lead_chars: number;
    hashtags: false;
    urls_in_body: false;
    keyword_max_exact_uses: number;
  };
};

export type BriefResult = { ok: true; brief: Brief } | { ok: false; refusals: Refusal[] };

// What a model adapter must hand back. Nothing else from the model is used.
export type ModelDraft = { copy: string; claim_ids: string[]; asset_ids?: string[] };

export type LintProblem = { code: string; message: string; match?: string };
export type LintResult = { ok: boolean; problems: LintProblem[]; warnings: LintProblem[] };
