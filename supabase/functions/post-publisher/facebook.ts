// Facebook through Zernio: the publisher's pure rules (Zernio Social
// Publisher v1; docs/zernio-publisher.md). No Deno, no network; the handler
// and the app both import it.
//
// Everything is built from the post's approved snapshot (0045) and the
// account's explicit binding — never from the live row, never from a search
// of Zernio. v1 is Facebook feed posts only: text, or text with one image.

import type { Snapshot } from "./channel.ts";

export const FACEBOOK_MAX_CHARS = 63_206;
export const ZERNIO_ACCOUNT_RE = /^[0-9a-f]{24}$/;
export const ZERNIO_PUBLISH_KEY_SECRET = "ZERNIO_PUBLISH_API_KEY";
export const ZERNIO_READ_KEY_SECRET = "ZERNIO_READ_API_KEY";
export const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
// A Zernio post still pending this long is a person's to look at.
export const PENDING_TOO_LONG_HOURS = 24;

export type FacebookSnapshot = Snapshot & {
  social_account_id?: string | null;
  creative?: { id: string; content_hash: string | null; storage_path: string | null; mime_type?: string | null; sort_order?: number }[];
};

export type Binding = {
  id: string;
  client_id: string;
  platform: string;
  external_account_id: string | null;
  display_name: string | null;
  publish_provider: string | null;
  publish_account_id: string | null;
  publish_page_id: string | null;
  publish_account_name: string | null;
  publish_enabled: boolean;
  publish_verified_at: string | null;
  publish_health: { status?: string } | null;
};

// The one image a v1 post may carry: a brand asset or a Creative Engine asset
// from the approved snapshot, with the hash it was approved with.
export type MediaRef = { kind: "brand" | "creative"; id: string; bucket: "brand-assets" | "creative-assets"; storage_path: string; content_hash: string };

export type FbProblem = { code: string; message: string };

export function mediaOf(s: FacebookSnapshot): MediaRef[] {
  const out: MediaRef[] = [];
  for (const a of s.assets ?? []) {
    out.push({ kind: "brand", id: a.id, bucket: "brand-assets", storage_path: a.storage_path ?? "", content_hash: a.content_hash ?? "" });
  }
  for (const c of s.creative ?? []) {
    out.push({ kind: "creative", id: c.id, bucket: "creative-assets", storage_path: c.storage_path ?? "", content_hash: c.content_hash ?? "" });
  }
  return out;
}

// What stops the approved content from going to Facebook as it is.
export function facebookProblems(s: FacebookSnapshot): FbProblem[] {
  const out: FbProblem[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  if (s.platform !== "facebook") add("not_facebook", "Only Facebook posts are published through Zernio in v1.");
  const copy = (s.copy ?? "").trim();
  if (!copy) add("no_copy", "The post has no text.");
  else if (copy.length > FACEBOOK_MAX_CHARS) add("too_long", `Facebook posts are at most ${FACEBOOK_MAX_CHARS} characters.`);
  if (s.post_type && s.post_type !== "standard") add("post_type", "Only standard Facebook posts are published in v1 (no offer posts).");
  if (s.cta_type) add("cta", "Facebook posts carry no Business Profile button; reopen the post and clear the button.");
  if (!s.social_account_id) add("no_account", "The post names no Facebook Page; reopen it and attach the client's Page.");
  const media = mediaOf(s);
  if (media.length > 1) add("too_many_images", "v1 publishes one image at most; remove the others.");
  for (const m of media.slice(0, 1)) {
    if (!m.storage_path) add("image_unstored", "The image has no stored file.");
    if (!/^[0-9a-f]{64}$/.test(m.content_hash)) add("image_unhashed", "The image has no recorded hash to check it against.");
  }
  return out;
}

// Why this post may not go to this binding. Empty = it may.
export function bindingProblems(post: { client_id: string; platform: string; social_account_id: string | null }, b: Binding | null): string[] {
  if (!post.social_account_id) return ["The post names no Facebook Page."];
  if (!b) return ["The post's Facebook Page is not in Compass."];
  const out: string[] = [];
  if (b.client_id !== post.client_id) out.push("The Facebook Page belongs to another client.");
  if (b.platform !== "facebook" || post.platform !== "facebook") out.push("Only Facebook Pages are published through Zernio.");
  if (b.publish_provider !== "zernio" || !b.publish_account_id || !ZERNIO_ACCOUNT_RE.test(b.publish_account_id)) {
    out.push("This Facebook Page has no verified Zernio account binding (Settings → Publisher).");
  } else {
    if (!b.publish_page_id || b.publish_page_id !== b.external_account_id) out.push("The Zernio binding names a different Page.");
    if (!b.publish_enabled) out.push("Publishing to this Facebook Page is switched off (Settings → Publisher).");
    if (b.publish_health?.status === "error") out.push("Zernio reported this account unhealthy at the last check; verify it again.");
  }
  return out;
}

// Zernio's Idempotency-Key: stable for one logical attempt across retries of
// the same request. The generation moves on only after Zernio has a post for
// this key that ended failed, so a deliberate retry is a new post while a
// retry after no answer returns the original.
export function idempotencyKey(publishKey: string, generation: number): string {
  return `compass-${publishKey}-g${generation}`;
}

export type CreateBody = {
  content: string;
  platforms: { platform: "facebook"; accountId: string; platformSpecificData: { pageId: string } }[];
  mediaItems?: { type: "image"; url: string }[];
  publishNow: true;
};

// The exact request. Content is the approved copy, unchanged; the Page is
// pinned so Zernio never falls back to an account's default Page.
export function buildCreateBody(s: FacebookSnapshot, b: Binding, imageUrl: string | null): CreateBody {
  const body: CreateBody = {
    content: s.copy ?? "",
    platforms: [{ platform: "facebook", accountId: b.publish_account_id!, platformSpecificData: { pageId: b.publish_page_id! } }],
    publishNow: true,
  };
  if (imageUrl) body.mediaItems = [{ type: "image", url: imageUrl }];
  return body;
}

// ── Reading Zernio's answers ─────────────────────────────────────────────────
export type ZPlatform = {
  platform?: string; accountId?: string | { _id?: string }; status?: string;
  platformPostId?: string | null; platformPostUrl?: string | null; publishedAt?: string | null;
  errorMessage?: string | null; errorCategory?: string | null; errorSource?: string | null;
};
export type ZPost = { _id?: string; status?: string; content?: string; platforms?: ZPlatform[] };

const TRANSIENT_CATEGORIES = new Set(["platform_rate_limit", "platform_error", "system_error", "quota_exhausted"]);
const RECONNECT_CATEGORIES = new Set(["auth_expired", "account_issue"]);

export type PostState =
  | { state: "published"; platformPostId: string | null; platformPostUrl: string; publishedAt: string | null; zernioStatus: string }
  | { state: "failed"; message: string; transient: boolean; needs: "reconnect" | "fix" | null; zernioStatus: string }
  | { state: "pending"; zernioStatus: string }
  | { state: "missing" };

const accountOf = (p: ZPlatform) => (typeof p.accountId === "string" ? p.accountId : p.accountId?._id ?? null);

// Our Facebook entry in a Zernio post: the platform result is the truth, not
// the HTTP status (a 207 is 2xx and may be a failure).
export function interpretPost(post: ZPost | null | undefined, accountId: string): PostState {
  const entry = (post?.platforms ?? []).find((p) => p.platform === "facebook" && accountOf(p) === accountId);
  if (!post || !entry) return { state: "missing" };
  const status = entry.status ?? "pending";
  const zernioStatus = `${post.status ?? "?"}/${status}`;
  if (status === "published") {
    if (entry.platformPostUrl && /^https:\/\//i.test(entry.platformPostUrl)) {
      return { state: "published", platformPostId: entry.platformPostId ?? null, platformPostUrl: entry.platformPostUrl,
        publishedAt: entry.publishedAt ?? null, zernioStatus };
    }
    return { state: "pending", zernioStatus }; // published without a link yet: read it again
  }
  if (status === "failed" || status === "cancelled") {
    const category = entry.errorCategory ?? "unknown";
    return {
      state: "failed", zernioStatus,
      message: `Facebook (via Zernio) ${status}: ${(entry.errorMessage ?? "no message").slice(0, 300)}${category !== "unknown" ? ` [${category}]` : ""}`,
      transient: status === "failed" && TRANSIENT_CATEGORIES.has(category),
      needs: RECONNECT_CATEGORIES.has(category) ? "reconnect" : status === "failed" && !TRANSIENT_CATEGORIES.has(category) ? "fix" : null,
    };
  }
  return { state: "pending", zernioStatus }; // pending / processing / uploading, or Zernio retrying
}

export type Answer = { ok: boolean; status: number; json: unknown; code: string | null; message: string; retryAfterS: number | null };

export type CreateOutcome =
  | { kind: "result"; postId: string; post: ZPost; state: PostState }
  | { kind: "duplicate"; existingPostId: string }
  | { kind: "in_progress"; message: string }
  | { kind: "disconnected"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "transient"; message: string };

export function interpretCreate(a: Answer, accountId: string): CreateOutcome {
  const body = (a.json ?? {}) as { post?: ZPost; details?: { existingPostId?: string; accountId?: string }; code?: string; error?: string };
  if (a.status === 200 || a.status === 201 || a.status === 207) {
    const post = body.post;
    if (post?._id) return { kind: "result", postId: post._id, post, state: interpretPost(post, accountId) };
    return { kind: "transient", message: `Zernio answered ${a.status} without a post id.` };
  }
  if (a.status === 409) {
    if (body.code === "idempotency_conflict" || a.code === "idempotency_conflict") {
      return { kind: "in_progress", message: "Zernio is still processing the first request with this key." };
    }
    const existing = body.details?.existingPostId;
    if (existing) return { kind: "duplicate", existingPostId: existing };
    return { kind: "rejected", message: `Zernio refused it as a duplicate: ${a.message}` };
  }
  if (a.status === 401) return { kind: "unauthorized", message: `The Zernio publish key was refused: ${a.message}` };
  if (a.status === 403 && (a.code === "ACCOUNT_DISCONNECTED" || a.code === "ACCOUNT_NOT_ENABLED_FOR_POSTING")) {
    return { kind: "disconnected", message: `Zernio: ${a.code} — ${a.message}` };
  }
  if (a.status === 0 || a.status === 429 || a.status >= 500) return { kind: "transient", message: a.message };
  return { kind: "rejected", message: a.message };
}

// A 409 duplicate points at an existing post. It is ours only when it is on
// the same account with exactly the same content.
export function sameContent(post: ZPost | null | undefined, content: string, accountId: string): boolean {
  if (!post) return false;
  return (post.content ?? "") === content && (post.platforms ?? []).some((p) => p.platform === "facebook" && accountOf(p) === accountId);
}

export type HealthSummary = { status: string; tokenValid: boolean | null; postingGranted: boolean | null; checked_at: string };

export function summarizeHealth(h: unknown, at: Date): HealthSummary {
  const x = (h ?? {}) as { status?: string; tokenStatus?: { valid?: boolean }; permissions?: { posting?: { granted?: boolean; required?: boolean }[] } };
  const posting = x.permissions?.posting;
  return {
    status: x.status ?? "unknown",
    tokenValid: typeof x.tokenStatus?.valid === "boolean" ? x.tokenStatus.valid : null,
    postingGranted: Array.isArray(posting) ? posting.filter((p) => p.required !== false).every((p) => p.granted === true) : null,
    checked_at: at.toISOString(),
  };
}

// The Chicago wall-clock reading of a time, for people reading a preflight.
export function chicago(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
}

// ── What to do with a post's next Zernio request ─────────────────────────────
// From this approval's Zernio runs (oldest first; keys start with
// compass-<publish_key>-), decide whether the next step is to read a post
// Zernio already has, to send, and with which key.
//
// - Nothing sent yet: generation 1.
// - The latest generation has a Zernio post: read it first ("check"); the
//   caller sends generation + 1 only if Zernio says it failed or was cancelled.
// - The latest generation got a definite answer that created nothing (a 4xx,
//   429 or 5xx, no post id): generation + 1.
// - The latest generation has no definite answer (timeout, still processing,
//   or the run was cut off after the request went out): the same key again,
//   with the same image URL, so Zernio returns the original instead of
//   creating a second post — only inside its 24-hour idempotency window
//   (23 h here). Past it, a person looks.
export const IDEMPOTENCY_WINDOW_HOURS = 23;
export type RunLike = {
  outcome: string; created_at: string; http_status?: number | null; provider_post_id: string | null;
  request_key: string | null; provider_media_url: string | null;
};
export type SendPlan =
  | { kind: "send"; generation: number; mediaUrl: string | null; sameKey: boolean }
  | { kind: "check"; generation: number; postId: string }
  | { kind: "person"; detail: string };

export function generationOf(key: string | null, publishKey: string): number | null {
  if (!key) return null;
  const m = key.match(/^compass-(.+)-g(\d+)$/);
  return m && m[1] === publishKey ? Number(m[2]) : null;
}

export function planSend(runs: RunLike[], publishKey: string, at: Date): SendPlan {
  const mine = runs.filter((r) => generationOf(r.request_key, publishKey) !== null);
  if (!mine.length) return { kind: "send", generation: 1, mediaUrl: null, sameKey: false };
  const gen = Math.max(...mine.map((r) => generationOf(r.request_key, publishKey)!));
  const latest = mine.filter((r) => generationOf(r.request_key, publishKey) === gen);
  const withPost = [...latest].reverse().find((r) => r.provider_post_id);
  if (withPost) return { kind: "check", generation: gen, postId: withPost.provider_post_id! };
  const last = latest[latest.length - 1];
  const definite = (last.outcome === "failed" || last.outcome === "blocked") && !!last.http_status && last.http_status !== 0;
  if (definite) return { kind: "send", generation: gen + 1, mediaUrl: null, sameKey: false };
  const first = Date.parse(latest[0].created_at);
  if (at.getTime() - first > IDEMPOTENCY_WINDOW_HOURS * 3_600_000) {
    return { kind: "person", detail: `An earlier request to Zernio (key g${gen}) never got a definite answer and Zernio's 24-hour idempotency window has passed, so a re-send could post twice.` };
  }
  return { kind: "send", generation: gen, mediaUrl: [...latest].reverse().find((r) => r.provider_media_url)?.provider_media_url ?? null, sameKey: true };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The image's type from its bytes (never from a name or a header alone).
export function sniffImage(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
