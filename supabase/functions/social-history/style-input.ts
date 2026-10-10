// The Social Style Analyzer's input (SH2), built from what the store read:
// the client's imported history with each post's newest snapshot, which of
// those posts the learnable view admits, and the client's governed rules
// from client_intelligence_input. Pure, so the same rows give the same input
// and the same fingerprint.
//
// Direction matters: the rules flow INTO the analysis (to mask what Compass
// may not state); nothing from history flows back. The usable claims are
// read only to leave their exact words unmasked in example posts.
import { usableClaims, type IntelligenceInput } from "../../../src/lib/client-intelligence.ts";
import { fingerprintSource, type StyleInput, type StylePost } from "./analyze.ts";

export const STYLE_TIMEZONE = "America/Chicago";

// A row of social_history_post_latest (the columns the analyzer needs).
export type HistoryRow = {
  id: string;
  platform: string;
  platform_post_id: string;
  published_at: string;
  copy: string | null;
  copy_hash: string;
  format: string;
  permalink: string | null;
  media: unknown[] | null;
  origin: string;
  learning_status: string;
  learning_note: string | null;
  is_paid: boolean;
  is_owner: boolean | null;
  missing_since: string | null;
  metrics_captured_at: string | null;
  metrics_age_hours: number | null;
  impressions: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  views: number | null;
  metrics_unavailable: string[] | null;
};

export type StyleIntelligence = Pick<IntelligenceInput, "client" | "claims" | "locations"> & {
  client: IntelligenceInput["client"] & { id: string };
  brand: { words_we_avoid: string[] | null } | null;
  board: { hard_rules: unknown } | null;
};

// Why the learnable view leaves a post out, in the order the view tests it.
export function exclusionOf(r: HistoryRow, learnable: boolean): string | null {
  if (learnable) return null;
  if (r.origin === "compass") return "Compass-generated: never feeds style learning.";
  if (r.learning_status === "excluded") return `Excluded by a teammate${r.learning_note ? `: ${r.learning_note}` : "."}`;
  if (r.is_paid) return "Paid delivery: reach is bought, not earned.";
  if (r.is_owner === false) return "Not authored by the Page.";
  if (r.missing_since) return "No longer listed on the platform.";
  return "Matches a Compass post: never feeds style learning.";
}

export function buildStyleInput(intel: StyleIntelligence, rows: HistoryRow[], learnableIds: Set<string>,
  platform: "facebook" = "facebook"): StyleInput {
  const posts: StylePost[] = rows.filter((r) => r.platform === platform).map((r) => {
    const learnable = learnableIds.has(r.id);
    const age = r.metrics_age_hours ?? (r.metrics_captured_at
      ? (Date.parse(r.metrics_captured_at) - Date.parse(r.published_at)) / 3_600_000 : null);
    return {
      id: r.id,
      platform_post_id: r.platform_post_id,
      published_at: new Date(r.published_at).toISOString(),
      copy: r.copy ?? "",
      copy_hash: r.copy_hash,
      format: r.format,
      permalink: r.permalink,
      media_count: Array.isArray(r.media) ? r.media.length : 0,
      learnable,
      exclusion: exclusionOf(r, learnable),
      metrics: r.metrics_captured_at ? {
        captured_at: new Date(r.metrics_captured_at).toISOString(),
        age_hours: age == null ? null : Math.round(age * 10) / 10,
        impressions: r.impressions, reach: r.reach, reactions: r.reactions, comments: r.comments,
        shares: r.shares, clicks: r.clicks, views: r.views, unavailable: [...(r.metrics_unavailable ?? [])].sort(),
      } : null,
    };
  });
  // As of the newest data, never the clock: re-running on the same rows gives
  // the same profile and the same fingerprint.
  const stamps = posts.flatMap((p) => [p.published_at, p.metrics?.captured_at ?? ""]).filter(Boolean).sort();
  const hardRules = Array.isArray(intel.board?.hard_rules) ? (intel.board!.hard_rules as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const approved = [...new Set(intel.locations.filter((l) => l.is_active)
    .map((l) => [l.city ?? l.name, l.state].filter(Boolean).join(", ")).filter(Boolean))].sort();
  return {
    client: {
      id: intel.client.id, name: intel.client.name, phone: intel.client.phone ?? null, website_url: intel.client.website_url ?? null,
      city: intel.client.city ?? null, state: intel.client.state ?? null, service_area: intel.client.service_area ?? null,
    },
    platform,
    as_of: stamps.at(-1) ?? new Date(0).toISOString(),
    timezone: STYLE_TIMEZONE,
    posts,
    rules: { words_we_avoid: [...(intel.brand?.words_we_avoid ?? [])], hard_rules: hardRules },
    places: { approved },
    usable_claims: usableClaims(intel.claims).map((c) => c.claim).sort(),
  };
}

export async function fingerprint(input: StyleInput): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprintSource(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
