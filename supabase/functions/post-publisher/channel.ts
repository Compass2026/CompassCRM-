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

// What the post's request looks like for comparison against the profile:
// the photo's signed URL is irrelevant (Google rehosts it), its count is not.
export function expectedLocalPost(s: Snapshot): Record<string, unknown> {
  return buildLocalPost(s, (s.assets ?? []).length ? "photo" : null);
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

// A LocalPost as Google returns it (v4). Every field may be absent.
export type GooglePost = {
  name?: string;
  summary?: string;
  createTime?: string;
  searchUrl?: string;
  state?: string;
  topicType?: string;
  callToAction?: { actionType?: string; url?: string };
  offer?: { termsConditions?: string; redeemOnlineUrl?: string; couponCode?: string };
  event?: { title?: string; schedule?: { startDate?: { year?: number; month?: number; day?: number }; endDate?: { year?: number; month?: number; day?: number } } };
  media?: { mediaFormat?: string }[];
};

const LOCAL_POST_NAME = /^accounts\/[^/\s]+\/locations\/[^/\s]+\/localPosts\/[^/\s]+$/;

// A create answer is a publication only when it names the LocalPost it made.
// A 2xx without a well-formed name is an uncertain attempt, never a record.
export function createdPostName(json: unknown): string | null {
  const name = (json as { name?: unknown } | null)?.name;
  return typeof name === "string" && LOCAL_POST_NAME.test(name.trim()) ? name.trim() : null;
}

const norm = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const normUrl = (u: string | undefined | null) => {
  const t = (u ?? "").trim();
  if (!t) return "";
  try { return new URL(t).href.replace(/\/$/, ""); } catch { return t.replace(/\/$/, ""); }
};
const sameDate = (a?: { year?: number; month?: number; day?: number }, b?: { year?: number; month?: number; day?: number }) =>
  !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;

// How one LocalPost on the profile relates to the request this post sends
// (buildLocalPost of the approved snapshot):
//   match   — same text, created inside the window (since the post was
//             approved), and every
//             characteristic Google returns agrees (topic, button, offer,
//             event, photo count, not rejected), with a usable name;
//   partial — same text inside (or with no) creation time, but something
//             differs or cannot be confirmed: a person must look;
//   none    — different text, or created before the window (an earlier,
//             legitimate post with the same copy).
export type Candidate = { kind: "match" | "partial" | "none"; post: GooglePost; reasons: string[] };

export function classifyLocalPost(p: GooglePost, expected: Record<string, unknown>, since: string): Candidate {
  const want = expected as {
    summary?: string; topicType?: string;
    callToAction?: { actionType: string; url?: string | null };
    offer?: { termsConditions?: string; redeemOnlineUrl?: string };
    event?: { title?: string; schedule?: { startDate: { year: number; month: number; day: number }; endDate: { year: number; month: number; day: number } } };
    media?: unknown[];
  };
  if (norm(p.summary) !== norm(want.summary)) return { kind: "none", post: p, reasons: [] };
  const after = Date.parse(since) - 60_000;
  const reasons: string[] = [];
  if (!p.createTime || Number.isNaN(Date.parse(p.createTime))) reasons.push("no creation time");
  else if (Date.parse(p.createTime) < after) return { kind: "none", post: p, reasons: [] };
  if (!p.name || !LOCAL_POST_NAME.test(p.name)) reasons.push("no post name");
  if (p.state === "REJECTED") reasons.push("rejected by Google");

  // Topic.
  if (!p.topicType) reasons.push("topic not returned");
  else if (p.topicType !== want.topicType) reasons.push(`topic ${p.topicType}, expected ${want.topicType}`);

  // Button.
  if (want.callToAction) {
    if (!p.callToAction) reasons.push("button not returned");
    else {
      if (p.callToAction.actionType !== want.callToAction.actionType) reasons.push(`button ${p.callToAction.actionType ?? "none"}, expected ${want.callToAction.actionType}`);
      if (normUrl(p.callToAction.url) !== normUrl(want.callToAction.url ?? null)) reasons.push("button link differs");
    }
  } else if (p.callToAction?.actionType) reasons.push(`has a ${p.callToAction.actionType} button; none was sent`);

  // Offer.
  if (want.offer) {
    if (!p.offer) reasons.push("offer not returned");
    else {
      if (norm(p.offer.termsConditions) !== norm(want.offer.termsConditions)) reasons.push("offer terms differ");
      if (normUrl(p.offer.redeemOnlineUrl) !== normUrl(want.offer.redeemOnlineUrl)) reasons.push("redeem link differs");
    }
  } else if (p.offer && (p.offer.termsConditions || p.offer.redeemOnlineUrl || p.offer.couponCode)) reasons.push("has an offer; none was sent");

  // Event (offer title and dates).
  if (want.event) {
    if (!p.event) reasons.push("event not returned");
    else {
      if (norm(p.event.title) !== norm(want.event.title)) reasons.push("offer title differs");
      if (want.event.schedule) {
        if (!sameDate(p.event.schedule?.startDate, want.event.schedule.startDate) || !sameDate(p.event.schedule?.endDate, want.event.schedule.endDate)) reasons.push("offer dates differ");
      } else if (p.event.schedule?.startDate || p.event.schedule?.endDate) reasons.push("has dates; none were sent");
    }
  } else if (p.event?.title) reasons.push("has an event; none was sent");

  // Photo count (Google rehosts the image, so only the count is comparable).
  const wantPhotos = (want.media ?? []).length;
  if (p.media === undefined) { if (wantPhotos > 0) reasons.push("photo not returned"); }
  else if (p.media.length !== wantPhotos) reasons.push(`${p.media.length} photo(s), expected ${wantPhotos}`);

  return { kind: reasons.length ? "partial" : "match", post: p, reasons };
}

// The check before a re-send, and the stuck / uncertain sweep. Prefers a
// person over a possible duplicate:
//   reconciled — exactly one match and nothing else that could be it;
//   absent     — nothing with this text in the window, the listing was
//                complete, and the attempt is not one Google claimed to
//                have accepted: safe to send (again);
//   ambiguous  — anything else. Never re-sent, never recorded published.
export type Reconciliation =
  | { kind: "reconciled"; post: GooglePost & { name: string } }
  | { kind: "absent" }
  | { kind: "ambiguous"; detail: string };

export function reconcileAttempt(
  posts: GooglePost[],
  expected: Record<string, unknown>,
  since: string,
  opts: { complete: boolean; acceptedByGoogle: boolean },
): Reconciliation {
  const seen = posts.map((p) => classifyLocalPost(p, expected, since));
  const matches = seen.filter((c) => c.kind === "match");
  const partials = seen.filter((c) => c.kind === "partial");
  if (matches.length === 1 && partials.length === 0) {
    return { kind: "reconciled", post: matches[0].post as GooglePost & { name: string } };
  }
  if (matches.length === 0 && partials.length === 0) {
    if (opts.complete && !opts.acceptedByGoogle) return { kind: "absent" };
    return {
      kind: "ambiguous",
      detail: opts.acceptedByGoogle
        ? "Google accepted the last attempt without naming the post, and no matching post was found on the profile."
        : "The profile's post list was too long to check completely, and no matching post was found in what was read.",
    };
  }
  const describe = (c: Candidate) => `${c.post.name ?? "unnamed post"}${c.reasons.length ? ` (${c.reasons.join("; ")})` : ""}`;
  const parts = [
    matches.length ? `${matches.length} exact match${matches.length === 1 ? "" : "es"}: ${matches.map(describe).join(", ")}` : "",
    partials.length ? `${partials.length} post${partials.length === 1 ? "" : "s"} with the same text that could not be confirmed: ${partials.map(describe).join(", ")}` : "",
  ].filter(Boolean);
  return { kind: "ambiguous", detail: `Not exactly one safe match on the profile — ${parts.join("; ")}.` };
}
