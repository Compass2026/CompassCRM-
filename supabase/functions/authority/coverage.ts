// Existing coverage: what already serves a topic — the owner page, location
// pages, blog pages (from the live inventory and content_posts), Business
// Profile / social posts, and pages proposed but not merged. Plus the GBP
// cadence rule. Pure.
import type { AuthorityInput, CoverageItem, SocialPostRow } from "./types.ts";
import { addDays, daysBetween, normPath } from "./urls.ts";
import type { ClassifiedPage } from "./site.ts";

// v1 heuristic constant (Sept 25 2026 decision): one Business Profile post per
// service + search intent per 21 days. A different service or intent may go
// sooner. Later: per client / channel configuration.
export const GBP_CADENCE_DAYS = 21;

const LIVE_REVIEW = new Set(["draft", "in_review", "approved"]);

export function postCoverage(input: AuthorityInput, serviceId: string): CoverageItem[] {
  return input.authority.socialPosts
    .filter((p) => p.service_id === serviceId)
    .map((p) => ({
      kind: p.platform === "google_business" ? "gbp_post" as const : "social_post" as const,
      ref: p.id,
      label: `${p.platform} ${p.search_intent ?? ""} post${p.drafter_run_id ? " (AI Drafter)" : ""}: "${(p.copy ?? "").slice(0, 60)}…"`,
      state: `${p.review_status}/${p.publish_status}`,
      date: p.created_at,
      tag: "FACT" as const,
    }));
}

// Posts that count against the cadence: not rejected (a rejection is not
// coverage), same channel, service and intent.
export function cadence(input: AuthorityInput, serviceId: string, intent: string, platform = "google_business"):
  { blocked: boolean; last: SocialPostRow | null; eligible_from: string | null; days_since: number | null } {
  const now = input.authority.now;
  const posts = input.authority.socialPosts
    .filter((p) => p.platform === platform && p.service_id === serviceId && p.search_intent === intent)
    .filter((p) => LIVE_REVIEW.has(p.review_status) || p.publish_status === "published")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const last = posts[0] ?? null;
  if (!last) return { blocked: false, last: null, eligible_from: null, days_since: null };
  const since = daysBetween(last.created_at, now);
  const eligible = addDays(last.created_at, GBP_CADENCE_DAYS);
  // An open (draft / in review) post always blocks: the drafter refuses a second.
  const open = last.review_status === "draft" || last.review_status === "in_review";
  return { blocked: open || since < GBP_CADENCE_DAYS, last, eligible_from: open ? null : eligible, days_since: Math.floor(since) };
}

export function pageCoverage(pages: ClassifiedPage[], kind: ClassifiedPage["kind"], match?: RegExp): CoverageItem[] {
  return pages
    .filter((p) => p.kind === kind)
    .filter((p) => !match || match.test(`${p.page.title ?? ""} ${p.page.h1 ?? ""} ${p.slug ?? ""}`))
    .map((p) => ({
      kind: kind === "blog" ? "blog" as const : kind === "location" ? "location_page" as const : "owner_page" as const,
      ref: p.path, label: p.page.title ?? p.page.h1 ?? p.path, state: "live", tag: "FACT" as const,
    }));
}

export function contentPostCoverage(input: AuthorityInput, keywordIds: Set<string>): CoverageItem[] {
  const site = input.authority.site?.url ?? input.client.website_url;
  return input.authority.contentPosts
    .filter((c) => c.keyword_id && keywordIds.has(c.keyword_id))
    .map((c) => ({ kind: "content_post" as const, ref: normPath(c.url, site) ?? c.id, label: c.title, state: c.status, date: c.published_at, tag: "FACT" as const }));
}

export function pendingProposals(input: AuthorityInput): { path: string; title: string; type: string }[] {
  const site = input.authority.site?.url ?? input.client.website_url;
  return input.authority.changeLog
    .filter((c) => c.status === "proposed" && ["page_added", "page_rewrite"].includes(c.change_type))
    .map((c) => {
      const a = (c.after ?? {}) as { url?: string; title?: string };
      return { path: normPath(a.url ?? null, site) ?? "", title: a.title ?? "", type: c.change_type };
    })
    .filter((p) => p.path);
}

// Blog pages that are live on the site but absent from content_posts: the
// CRM cannot see them, so nothing downstream would avoid duplicating them.
export function blindSpots(input: AuthorityInput, pages: ClassifiedPage[]): string[] {
  const site = input.authority.site?.url ?? input.client.website_url;
  const known = new Set(input.authority.contentPosts.map((c) => normPath(c.url, site)).filter(Boolean));
  return pages.filter((p) => p.kind === "blog" && !known.has(p.path)).map((p) => p.path);
}
