// Zernio → Compass's canonical imported post (SH1). Pure: no network, no
// database. The same mapping feeds the dry run (plan) and the import, so what
// a teammate inspects in the dry run is exactly what would be stored.
//
// Rules:
// - One post per (platform, platform post id); the platform entry used is the
//   one for the account being imported. A post without that entry, a
//   platform id or a publish time is skipped with a reason, never guessed.
// - Copy is stored verbatim. It is style evidence only, never a claim.
// - Media is metadata and links only. Zernio supplies no width or height, so
//   none is recorded.
// - Metrics: NULL means "not supplied", 0 means a real zero. A metric
//   Facebook does not have, or one Zernio reports as 0 only because Page
//   insights were not granted, is NULL and named in `unavailable`. Analytics
//   still pending at Zernio give no snapshot at all.
import type { ZernioAnalyticsPost, ZernioMediaItem, ZernioMetrics, ZernioPlatformEntry } from "./zernio.ts";

export type Format = "text" | "photo" | "album" | "video" | "reel" | "story" | "link" | "other";
export const METRIC_FIELDS = ["impressions", "reach", "reactions", "comments", "shares", "saves", "clicks", "views", "engagement_rate"] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export type MediaRow = {
  type: string;
  url: string | null;
  thumbnail_url: string | null;
  alt: string | null;
  status: string | null;
  width: null;
  height: null;
};
export type MetricsRow = {
  provider_updated_at: string | null;
  sync_status: "synced";
  unavailable: MetricField[];
  raw: Record<string, unknown>;
} & Record<MetricField, number | null>;
export type PostRow = {
  platform_post_id: string;
  provider_post_id: string | null;
  provider_scheduled_id: string | null;
  permalink: string | null;
  published_at: string;
  copy: string;
  format: Format;
  media: MediaRow[];
  thumbnail_url: string | null;
  is_paid: boolean;
  is_owner: boolean | null;
  raw: Record<string, unknown>;
  metrics: MetricsRow | null;
};
export type Mapped =
  | { ok: true; row: PostRow; notes: string[] }
  | { ok: false; reason: string; provider_post_id: string | null };

const https = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/\S+$/.test(u) ? u : null);
// Zernio sends both ISO 8601 ("2026-09-23T20:42:41.000Z") and, for
// analytics.lastUpdated, a bare "2026-10-08 01:23:04" (UTC, no zone); the bare
// form is read as UTC, never as the runtime's local time.
export const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const bare = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v);
  const t = Date.parse(bare ? `${v.replace(" ", "T")}Z` : v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);

export function formatOf(post: ZernioAnalyticsPost, permalink: string | null): Format {
  if (permalink && /\/stories\//.test(permalink)) return "story";
  const items = post.mediaItems ?? [];
  switch (post.mediaType) {
    case "carousel": return "album";
    case "video": return permalink && /\/reels?\//.test(permalink) ? "reel" : "video";
    case "image": case "gif": return items.length > 1 ? "album" : "photo";
    case "text": return items.length ? (items.length > 1 ? "album" : items[0].type === "video" ? "video" : "photo") : "text";
    case "document": return "other";
  }
  if (items.length > 1) return "album";
  if (items.length === 1) return items[0].type === "video" ? "video" : "photo";
  return post.mediaType == null ? "text" : "other";
}

function mediaRow(m: ZernioMediaItem): MediaRow {
  return {
    type: m.type === "video" ? "video" : m.type === "image" ? "image" : "other",
    url: https(m.url),
    thumbnail_url: https(m.thumbnail),
    alt: typeof m.altText === "string" && m.altText.trim() ? m.altText.trim() : null,
    status: typeof m.mediaStatus === "string" ? m.mediaStatus : null,
    width: null,
    height: null,
  };
}

// The platform entry for this account (list: platforms[]; single: platformAnalytics[]).
export function entryFor(post: ZernioAnalyticsPost, accountId: string): ZernioPlatformEntry | null {
  const all = [...(post.platforms ?? []), ...(post.platformAnalytics ?? [])];
  return all.find((p) => p.accountId === accountId && (p.platform ?? "facebook") === "facebook") ?? null;
}

export function metricsOf(entry: ZernioPlatformEntry, post: ZernioAnalyticsPost, format: Format): MetricsRow | null {
  if (entry.syncStatus !== "synced") return null;
  const a: ZernioMetrics | null = entry.analytics ?? post.analytics ?? null;
  if (!a || typeof a !== "object") return null;
  const row: Record<MetricField, number | null> = {
    impressions: count(a.impressions),
    reach: count(a.reach),
    reactions: count(a.likes),            // Facebook: Zernio reports all reactions as likes
    comments: count(a.comments),
    shares: count(a.shares),
    saves: null,                           // not a Facebook metric (Instagram, Pinterest, X)
    clicks: count(a.clicks),
    views: count(a.views),
    engagement_rate: typeof a.engagementRate === "number" && Number.isFinite(a.engagementRate) && a.engagementRate >= 0
      ? a.engagementRate : null,
  };
  const unavailable = new Set<MetricField>(["saves"]);
  // Zernio returns integers, so a 0 reach / impressions next to real
  // engagement means Page insights were not supplied, not that nobody saw it.
  const engaged = (row.reactions ?? 0) + (row.comments ?? 0) + (row.shares ?? 0) > 0;
  if (engaged && row.impressions === 0 && row.reach === 0) {
    row.impressions = null; row.reach = null; row.engagement_rate = null;
    unavailable.add("impressions"); unavailable.add("reach"); unavailable.add("engagement_rate");
  }
  // Meta exposes no link clicks for stories (always 0 in Zernio).
  if (format === "story") { row.clicks = null; unavailable.add("clicks"); }
  for (const k of METRIC_FIELDS) if (row[k] === null) unavailable.add(k);
  const raw: Record<string, unknown> = {};
  for (const k of ["impressions", "reach", "likes", "comments", "shares", "saves", "clicks", "views", "engagementRate", "lastUpdated"]) {
    if (k in a) raw[k] = a[k];
  }
  return {
    ...row,
    provider_updated_at: iso(a.lastUpdated),
    sync_status: "synced",
    unavailable: [...unavailable].sort() as MetricField[],
    raw,
  };
}

export function mapPost(post: ZernioAnalyticsPost, accountId: string): Mapped {
  const providerId = typeof post._id === "string" ? post._id : typeof post.postId === "string" ? post.postId : null;
  const entry = entryFor(post, accountId);
  if (!entry) return { ok: false, reason: "not_this_account", provider_post_id: providerId };
  if (entry.status && entry.status !== "published") return { ok: false, reason: `not_published:${entry.status}`, provider_post_id: providerId };
  const platformPostId = typeof entry.platformPostId === "string" && entry.platformPostId.trim() ? entry.platformPostId.trim() : null;
  if (!platformPostId) return { ok: false, reason: "no_platform_post_id", provider_post_id: providerId };
  const published = iso(post.publishedAt);
  if (!published) return { ok: false, reason: "no_published_at", provider_post_id: providerId };

  const notes: string[] = [];
  const permalink = https(entry.platformPostUrl) ?? https(post.platformPostUrl);
  if (!permalink) notes.push("no_permalink");
  const format = formatOf(post, permalink);
  const media = (post.mediaItems ?? []).map(mediaRow);
  if (media.some((m) => m.status === "unavailable" || (!m.url && !m.thumbnail_url))) notes.push("media_withheld");
  const copy = typeof post.content === "string" ? post.content : "";
  if (!copy.trim()) notes.push("no_copy");
  if (entry.isOwner === false) notes.push("not_authored_by_page");
  if (post.isAd) notes.push("paid_delivery");
  const metrics = metricsOf(entry, post, format);
  if (!metrics) notes.push(`metrics_${entry.syncStatus ?? "missing"}${entry.errorCode ? `:${entry.errorCode}` : ""}`);
  else if (metrics.unavailable.includes("reach")) notes.push("insights_not_supplied");

  return {
    ok: true,
    notes,
    row: {
      platform_post_id: platformPostId,
      provider_post_id: providerId,
      provider_scheduled_id: typeof post.latePostId === "string" && post.latePostId ? post.latePostId : null,
      permalink,
      published_at: published,
      copy,
      format,
      media,
      thumbnail_url: https(post.thumbnailUrl),
      is_paid: post.isAd === true,
      is_owner: typeof entry.isOwner === "boolean" ? entry.isOwner : null,
      // What Zernio said about the post, minus the copy and numbers stored
      // in their own columns. Never a credential, never a comment's text.
      raw: {
        zernio_id: providerId,
        latePostId: post.latePostId ?? null,
        status: post.status ?? null,
        platform: post.platform ?? null,
        isExternal: post.isExternal ?? null,
        isAd: post.isAd ?? null,
        mediaType: post.mediaType ?? null,
        mediaProductType: (post as Record<string, unknown>).mediaProductType ?? null,
        syncStatus: post.syncStatus ?? null,
        entry: {
          status: entry.status ?? null, accountId: entry.accountId ?? null, syncStatus: entry.syncStatus ?? null,
          errorCode: entry.errorCode ?? null, errorMessage: entry.errorMessage ?? null, isOwner: entry.isOwner ?? null,
        },
      },
      metrics,
    },
  };
}

// What the dry run reports about field quality across a sample.
export function fieldReport(posts: ZernioAnalyticsPost[], mapped: Mapped[]) {
  const ok = mapped.filter((m): m is Extract<Mapped, { ok: true }> => m.ok).map((m) => m.row);
  const tally = <T extends string>(xs: T[]) => xs.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {} as Record<string, number>);
  const withMetrics = ok.filter((r) => r.metrics);
  const metric = Object.fromEntries(METRIC_FIELDS.map((k) => [k, {
    present: withMetrics.filter((r) => r.metrics![k] !== null).length,
    zero: withMetrics.filter((r) => r.metrics![k] === 0).length,
    unavailable: withMetrics.filter((r) => r.metrics!.unavailable.includes(k)).length,
  }]));
  const dates = ok.map((r) => r.published_at).sort();
  return {
    returned: posts.length,
    mappable: ok.length,
    skipped: tally(mapped.filter((m): m is Extract<Mapped, { ok: false }> => !m.ok).map((m) => m.reason)),
    newest: dates.at(-1) ?? null,
    oldest: dates[0] ?? null,
    fields: {
      copy: ok.filter((r) => r.copy.trim()).length,
      permalink: ok.filter((r) => r.permalink).length,
      media_items: ok.filter((r) => r.media.length).length,
      media_with_url: ok.filter((r) => r.media.some((m) => m.url)).length,
      media_alt_text: ok.filter((r) => r.media.some((m) => m.alt)).length,
      thumbnail: ok.filter((r) => r.thumbnail_url).length,
      provider_scheduled: ok.filter((r) => r.provider_scheduled_id).length,
      is_owner_false: ok.filter((r) => r.is_owner === false).length,
      paid: ok.filter((r) => r.is_paid).length,
    },
    formats: tally(ok.map((r) => r.format)),
    zernio_media_types: tally(posts.map((p) => String(p.mediaType ?? "null"))),
    metrics: {
      synced: withMetrics.length,
      not_synced: ok.length - withMetrics.length,
      per_metric: metric,
    },
    notes: tally(mapped.flatMap((m) => (m.ok ? m.notes : []))),
  };
}
