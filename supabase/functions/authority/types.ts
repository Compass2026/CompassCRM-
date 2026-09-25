// Authority Engine v1 (D1): shapes. Pure and deterministic; no model, no
// network, no database. The engine reads what Compass already knows (the
// canonical Client Intelligence loader plus coverage and performance) and a
// snapshot of the client's own public site, and decides what the client
// should become known for, what exists, what is missing and what to do next.
//
// Boundary (Sept 25 2026 decision): this engine is the source of truth for
// facts, services, locations, keyword targets, evidence, credentials, offers
// and page ownership. A future Strategy Synthesizer may add angle, hook,
// objective, audience framing and differentiation on top of an opportunity;
// it may never introduce any of the above.
import type { DrafterInput } from "../post-drafter/types.ts";

export const AUTHORITY_VERSION = "authority-v1.1";

// Every statement the engine makes carries one of these.
export type Tag = "FACT" | "HEURISTIC" | "RESEARCH_REQUIRED" | "REQUIRES_CONFIRMATION";
export type Reason = { tag: Tag; text: string };

export const ACTIONS = [
  "create", "improve", "refresh", "consolidate", "avoid",
  "insufficient_evidence", "research_required", "requires_confirmation",
  // Compass already holds the underlying reality, but a CRM / system
  // relationship must be reconciled before the downstream writer can run
  // (e.g. a live owner page the service record does not name).
  "blocked_data_prerequisite",
] as const;
export type Action = (typeof ACTIONS)[number];

export type ContentType =
  | "gbp_post" | "blog_post" | "blog_refresh" | "service_page" | "location_page" | "page_improvement" | "data_fix";

export type Tier = "A" | "B" | "C" | "none";

// Where an opportunity sits on the Authority tab (D2). Derived from the
// action and content type only, so the UI, the database and the Drafter
// handoff always agree.
export const SECTIONS = ["fix_now", "ready", "needs_decision", "research", "blocked", "avoid"] as const;
export type Section = (typeof SECTIONS)[number];

// Search Console coverage of the latest window. gsc-sync asks for at most
// GSC_ROW_CAP query+page rows per window without pagination, so a window at
// the cap is partial: demand numbers are a floor, never exhaustive.
export type GscCoverage = "complete" | "partial" | "unknown";

// ── Input ──────────────────────────────────────────────────────────────────

export type PageGroupRow = {
  id: string; name: string; page_type: string; status: string; city_tier: string | null;
  target_url: string | null; primary_keyword_id: string | null; supporting_keyword_ids: string[];
};
export type KeywordExtra = { id: string; volume: number | null; cpc: number | null; city: string | null };
export type GscRow = {
  query: string; page: string | null; impressions: number; clicks: number; avg_position: number | null;
  period_start: string; period_end: string; keyword_id: string | null;
};
export type RankRow = { keyword_id: string; result_type: string; position: number | null; url_ranked: string | null; recorded_at: string };
export type SocialPostRow = {
  id: string; platform: string; search_intent: string | null; service_id: string | null; keyword_id: string | null;
  review_status: string; publish_status: string; review_note: string | null; created_at: string;
  reviewed_at: string | null; drafter_run_id: string | null; claim_ids: string[]; copy: string | null;
};
export type ContentPostRow = { id: string; title: string; status: string; url: string | null; keyword_id: string | null; published_at: string | null };
export type ChangeLogRow = { change_type: string; object_type: string; status: string; after: unknown; created_at: string };

// One URL on the client's own site, as fetched (read-only) at inventory time.
export type SitePage = {
  url: string;                 // as requested (absolute)
  status: number | null;       // first response
  final_url: string | null;    // after following redirects (null if it never settled)
  final_status: number | null;
  redirect_loop: boolean;
  in_sitemap: boolean;
  title: string | null;
  h1: string | null;
  h2: string[];
  canonical: string | null;
  words: number | null;
  text: string | null;         // visible text, truncated
};

export type AuthorityInput = DrafterInput & {
  authority: {
    now: string;                                   // ISO timestamp the run is judged at
    site: { url: string | null; content_paths: Record<string, string> | null; work_mode: string | null; adapter: string | null } | null;
    pageGroupsFull: PageGroupRow[];
    keywordExtras: KeywordExtra[];
    moneyKeywordIds: string[];
    gsc: GscRow[];
    ranks: RankRow[];
    socialPosts: SocialPostRow[];
    contentPosts: ContentPostRow[];
    changeLog: ChangeLogRow[];
    inventory: { fetched_at: string; pages: SitePage[] } | null;
    places?: string[];                             // gazetteer names for the client's state
  };
};

// ── Output ─────────────────────────────────────────────────────────────────

export type PageState = "live" | "missing" | "redirect_loop" | "redirects" | "error" | "not_checked";
export type OwnerCandidate = { source: "page_group" | "service" | "keywords"; url: string; path: string; state: PageState; final_path: string | null };
export type OwnerResolution = {
  path: string | null; state: PageState | "none"; source: OwnerCandidate["source"] | null;
  candidates: OwnerCandidate[]; conflict: boolean; pending_proposal: boolean; reasons: Reason[];
};

export type KeywordRole =
  | "primary" | "supporting" | "homepage_pollution" | "mis_targeted" | "location_unapproved"
  | "material_supported" | "material_unsupported" | "avoid_risky" | "requires_confirmation" | "unmapped"
  | "intent_conflict";   // a flag only: never a keyword's role
export type KeywordAssignment = {
  keyword_id: string; keyword: string; service_id: string | null; intent: string | null; money: boolean;
  priority: string | null; volume: number | null; target_path: string | null; role: KeywordRole; flags: string[]; reasons: Reason[];
  // Stored intent (FACT) vs a conservative assessment of the query text
  // (HEURISTIC). Never written back.
  intent_check: { stored: string | null; assessed: "navigational" | "informational" | "commercial_or_transactional" | "ambiguous"; conflict: boolean; reason: string };
};

export type ClaimRef = { id: string; text: string };
export type Evidence = { usable: ClaimRef[]; relevant: ClaimRef[]; excluded: { id: string; text: string; reason: string }[] };

export type CoverageItem = {
  kind: "owner_page" | "location_page" | "blog" | "content_post" | "gbp_post" | "social_post" | "pending_proposal";
  ref: string; label: string; state: string; date?: string | null; tag: Tag;
};

export type GscSummary = {
  window: string | null; coverage: GscCoverage; impressions: number; clicks: number; best_position: number | null;
  owner_impressions: number; landing_pages: { path: string; impressions: number }[];
  queries: { query: string; impressions: number; position: number | null; path: string | null }[];
  rank: { keyword: string; organic: number | null; map_pack: number | null; url_path: string | null; recorded_at: string | null } | null;
};

export type Pillar = {
  service_id: string; name: string; segment: string | null; parent: string | null;
  owner: OwnerResolution; evidence: Evidence; keywords: { total: number; by_role: Record<string, number> };
  coverage: CoverageItem[]; gsc: GscSummary; page_issues: Reason[];
};

export type Conflict = { kind: string; subject: string; reasons: Reason[] };

export type SupportingTopic = {
  key: string; name: string; service_ids: string[]; action: Action; reasons: Reason[];
  evidence: ClaimRef[]; coverage: CoverageItem[];
};

export type Gate = { gate: string; pass: boolean; detail: string };
export type Opportunity = {
  // id: readable label (names may change). key: stable identity for
  // persistence, built from database ids (or a path / place / template key
  // where no row exists yet). Keys survive renaming a service.
  id: string; key: string; section: Section; objective: string | null; topic: string; service_id: string | null; action: Action; content_type: ContentType;
  target: { keyword_id: string | null; keyword: string | null; intent: string | null; location: string | null; owner_path: string | null; cta: string | null };
  evidence_claim_ids: string[]; existing_coverage: CoverageItem[]; gap: string; blockers: string[];
  gates: Gate[]; tier: Tier; eligible_from: string | null; order: number[];
  reasons: Reason[]; provenance: Record<Tag, string[]>;
};

export type AuthorityReport = {
  version: typeof AUTHORITY_VERSION; client: { id: string; name: string }; as_of: string; generated_at: string;
  inventory: { fetched_at: string | null; pages: number; live: number; by_kind: Record<string, number>; blind_spots: Reason[] };
  sources: {
    gsc: { window: string | null; rows: number; row_cap: number; coverage: GscCoverage };
    ranks: { recorded_at: string | null };
    inventory: { fetched_at: string | null; pages: number };
  };
  pillars: Pillar[]; keywords: KeywordAssignment[]; conflicts: Conflict[]; supporting: SupportingTopic[];
  opportunities: Opportunity[]; judgments: string[];
};
