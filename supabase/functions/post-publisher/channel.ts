// Business Profile channel rules for the post publisher (0046). Pure: no
// Deno, no network. The Edge Function uses it to check and build every
// request; the app imports it to show the same problems before scheduling.
//
// Everything reads the approved snapshot (0045's approved_snapshot), never
// the live row: what a person approved is what goes to Google.

export const GBP_SUMMARY_MAX = 1500;
export const GBP_CTA_TYPES = ["LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL"] as const;
export const MAX_ATTEMPTS = 3;
// Backoff before the next automatic attempt, by attempts already made.
export const RETRY_BACKOFF_MINUTES = [10, 30, 120];
export const STUCK_AFTER_MINUTES = 10;
export const MAX_POSTS_PER_TICK = 5;
export const SIGNED_URL_SECONDS = 15 * 60;

export type SnapshotAsset = { id: string; storage_path: string | null; url: string | null; sort_order: number; content_hash?: string | null };
export type SnapshotOffer = { id: string; title: string; terms: string; starts_on: string | null; ends_on: string | null } | null;
export type Snapshot = {
  platform: string;
  post_type: string;
  copy: string | null;
  cta_type: string | null;
  cta_url: string | null;
  offer?: SnapshotOffer;
  assets?: SnapshotAsset[];
};

export type ProblemCode =
  | "not_gbp"
  | "no_copy"
  | "too_long"
  | "cta_unknown"
  | "cta_needs_link"
  | "cta_call_has_link"
  | "link_without_cta"
  | "link_not_https"
  | "too_many_photos"
  | "photo_unusable"
  | "offer_missing"
  | "offer_terms_missing";

export type Problem = { code: ProblemCode; message: string };

const isHttps = (u: string) => /^https:\/\/[^\s]+$/i.test(u);

// What stops this snapshot from going to Google as it is. Empty = ready.
export function channelProblems(s: Snapshot): Problem[] {
  const out: Problem[] = [];
  const add = (code: ProblemCode, message: string) => out.push({ code, message });
  if (s.platform !== "google_business") add("not_gbp", "Only Business Profile posts are published by the publisher.");
  const copy = (s.copy ?? "").trim();
  if (!copy) add("no_copy", "The post has no text.");
  else if (copy.length > GBP_SUMMARY_MAX) add("too_long", `Business Profile posts are at most ${GBP_SUMMARY_MAX} characters (this one is ${copy.length}).`);

  const cta = s.cta_type?.trim() || null;
  const url = s.cta_url?.trim() || null;
  if (s.post_type === "offer") {
    // Offer posts carry a redeem link, not a button.
    if (url && !isHttps(url)) add("link_not_https", "The offer link must be an https:// address.");
    if (!s.offer) add("offer_missing", "An offer post needs its offer.");
    else if (!(s.offer.terms ?? "").trim()) add("offer_terms_missing", "The offer has no terms.");
  } else if (cta) {
    if (!(GBP_CTA_TYPES as readonly string[]).includes(cta)) add("cta_unknown", `"${cta}" is not a Business Profile button.`);
    else if (cta === "CALL") {
      if (url) add("cta_call_has_link", "A Call button takes no link; Google calls the profile's phone number.");
    } else if (!url) add("cta_needs_link", "The button needs a link.");
    else if (!isHttps(url)) add("link_not_https", "The button link must be an https:// address.");
  } else if (url) {
    add("link_without_cta", "The post has a link but no button; pick a button.");
  }

  const assets = s.assets ?? [];
  if (assets.length > 1) add("too_many_photos", "Business Profile posts take one photo in v1; remove the others.");
  for (const a of assets.slice(0, 1)) {
    if (!a.storage_path && !(a.url && isHttps(a.url))) add("photo_unusable", "The photo has no stored file or https link.");
  }
  return out;
}

const ymd = (d: string) => {
  const [year, month, day] = d.split("-").map(Number);
  return { year, month, day };
};

// The localPosts create body. photoUrl is a signed (or https) URL for the
// single asset, resolved by the caller.
export function buildLocalPost(s: Snapshot, photoUrl: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    languageCode: "en-US",
    summary: (s.copy ?? "").trim(),
  };
  const url = s.cta_url?.trim() || null;
  if (s.post_type === "offer" && s.offer) {
    body.topicType = "OFFER";
    body.offer = {
      termsConditions: s.offer.terms.trim(),
      ...(url ? { redeemOnlineUrl: url } : {}),
    };
    // Dates stay optional on the offer (0044). A schedule is sent only when
    // the offer has both; if Google insists on one, its error says so.
    body.event = {
      title: s.offer.title,
      ...(s.offer.starts_on && s.offer.ends_on
        ? { schedule: { startDate: ymd(s.offer.starts_on), endDate: ymd(s.offer.ends_on) } }
        : {}),
    };
  } else {
    body.topicType = "STANDARD";
    const cta = s.cta_type?.trim() || null;
    if (cta) body.callToAction = cta === "CALL" ? { actionType: "CALL" } : { actionType: cta, url };
  }
  if (photoUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: photoUrl }];
  return body;
}

// 429, 5xx and network / timeout failures are worth another automatic try;
// every other answer is final until a person acts.
export function isTransient(status: number | null): boolean {
  return status === null || status === 429 || (status >= 500 && status <= 599);
}

export function nextRetryAt(lastAttemptAt: string, attempts: number): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const minutes = RETRY_BACKOFF_MINUTES[Math.max(0, attempts - 1)] ?? RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length - 1];
  return new Date(Date.parse(lastAttemptAt) + minutes * 60_000);
}

export type GooglePost = { name: string; summary?: string; createTime?: string; searchUrl?: string };

const norm = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

// The post an earlier attempt may already have created: same text, created
// after that attempt began (a minute of clock slack).
export function findExistingPost(posts: GooglePost[], copy: string | null, since: string | null): GooglePost | null {
  if (!since) return null;
  const want = norm(copy);
  const after = Date.parse(since) - 60_000;
  return (
    posts.find((p) => norm(p.summary) === want && (!p.createTime || Date.parse(p.createTime) >= after)) ?? null
  );
}
