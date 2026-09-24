// Social and Business Profile posts (0045): the review gate and the
// publishing state, as the app shows and edits them. The database enforces
// every rule here again (social_posts_before_update); this module decides
// which buttons to show and turns form input into a row, nothing more.

export const REVIEW_STATUSES = ["draft", "in_review", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const PUBLISH_STATUSES = ["not_scheduled", "scheduled", "publishing", "published", "failed"] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const POST_PLATFORMS = ["google_business", "facebook", "instagram", "linkedin", "x", "tiktok"] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];

// Event posts come later, with their own fields and publishing adapter.
export const POST_TYPES = ["standard", "offer"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_INTENTS = ["navigational", "informational", "commercial", "transactional"] as const;
export type PostIntent = (typeof POST_INTENTS)[number];

export const COPY_MAX = 3000;

export const platformLabels: Record<PostPlatform, { label: string; short: string }> = {
  google_business: { label: "Business Profile", short: "GBP" },
  facebook: { label: "Facebook", short: "FB" },
  instagram: { label: "Instagram", short: "IG" },
  linkedin: { label: "LinkedIn", short: "LI" },
  x: { label: "X", short: "X" },
  tiktok: { label: "TikTok", short: "TT" },
};

export const reviewLabels: Record<ReviewStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-zinc-100 text-zinc-700" },
  in_review: { label: "In review", className: "bg-amber-100 text-amber-900" },
  approved: { label: "Approved", className: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800" },
};

export const publishLabels: Record<PublishStatus, { label: string; className: string }> = {
  not_scheduled: { label: "Not scheduled", className: "bg-zinc-100 text-zinc-600" },
  scheduled: { label: "Scheduled", className: "bg-blue-100 text-blue-800" },
  publishing: { label: "Publishing", className: "bg-purple-100 text-purple-800" },
  published: { label: "Published", className: "bg-green-100 text-green-800" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
};

export const intentHelp: Record<PostIntent, string> = {
  navigational: "Finding the business itself: name, phone, website, hours, where it works.",
  informational: "Answering a question or explaining something.",
  commercial: "Comparing options: why this service, why this company.",
  transactional: "Ready to act: book, call, claim an offer.",
};

// Platforms a person may publish by hand and then record. Business Profile
// posts go out only through the publisher (0045 refuses a manual flip).
export const MANUAL_PUBLISH_PLATFORMS = ["facebook", "instagram", "linkedin", "x", "tiktok"] as const;
export const canPublishByHand = (platform: string): boolean =>
  (MANUAL_PUBLISH_PLATFORMS as readonly string[]).includes(platform);

// The topic a post needs before it leaves draft (checked again by 0045).
export function topicProblem(post: { post_type: string; search_intent: string; service_id: string | null; offer_id: string | null }): string | null {
  if (post.post_type === "offer") return post.offer_id ? null : "An offer post needs one of the client's offers.";
  if (post.search_intent !== "navigational" && !post.service_id) {
    return `${post.search_intent === "informational" ? "An" : "A"} ${post.search_intent} post needs an approved service as its topic.`;
  }
  return null;
}

export const CRM_FACTS_HELP =
  "Only facts stored in the CRM: business name, phone, website, approved services, locations and service area, other explicit client fields. Anything else needs a claim.";

const isOne = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export const isReviewStatus = (v: unknown): v is ReviewStatus => isOne(REVIEW_STATUSES, v);
export const isPublishStatus = (v: unknown): v is PublishStatus => isOne(PUBLISH_STATUSES, v);
export const isPlatform = (v: unknown): v is PostPlatform => isOne(POST_PLATFORMS, v);
export const isIntent = (v: unknown): v is PostIntent => isOne(POST_INTENTS, v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const optionalId = (v: string | null): string | null | undefined =>
  v === null ? null : UUID.test(v) ? v : undefined;

export type PostFields = {
  platform: PostPlatform;
  post_type: PostType;
  search_intent: PostIntent;
  copy: string;
  cta_type: string | null;
  cta_url: string | null;
  crm_facts_only: boolean;
  service_id: string | null;
  offer_id: string | null;
  keyword_id: string | null;
  notes: string | null;
};

// Reads the draft form. The same rules as the table constraints, said in
// words a person can act on before the database has to refuse.
export function parsePostFields(
  get: (key: string) => FormDataEntryValue | null
): { ok: true; value: PostFields } | { ok: false; error: string } {
  const text = (k: string) => {
    const v = get(k);
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
  };
  const platform = text("platform");
  if (!isPlatform(platform)) return { ok: false, error: "Pick a platform." };
  const postType = text("post_type") ?? "standard";
  if (!isOne(POST_TYPES, postType)) return { ok: false, error: "Pick a post type." };
  const intent = text("search_intent");
  if (!isIntent(intent)) return { ok: false, error: "Pick the search intent the post serves." };
  const copy = text("copy");
  if (!copy) return { ok: false, error: "Write the post copy." };
  if (copy.length > COPY_MAX) return { ok: false, error: `Keep the copy under ${COPY_MAX} characters.` };
  if (postType !== "standard" && platform !== "google_business") {
    return { ok: false, error: "Offer posts are Business Profile posts." };
  }
  const crmFactsOnly = get("crm_facts_only") === "on" || get("crm_facts_only") === "true";
  if (crmFactsOnly && intent !== "navigational") {
    return { ok: false, error: "“CRM facts only” is for navigational posts; link a claim instead." };
  }
  const ctaUrl = text("cta_url");
  if (ctaUrl && !/^https:\/\/[^\s]+$/i.test(ctaUrl)) {
    return { ok: false, error: "The link must be a full https:// address." };
  }
  const serviceId = optionalId(text("service_id"));
  const offerId = optionalId(text("offer_id"));
  const keywordId = optionalId(text("keyword_id"));
  if (serviceId === undefined || offerId === undefined || keywordId === undefined) {
    return { ok: false, error: "That service, offer or keyword is not valid." };
  }
  if (postType === "offer" && !offerId) return { ok: false, error: "An offer post needs one of the client's offers." };
  return {
    ok: true,
    value: {
      platform,
      post_type: postType,
      search_intent: intent,
      copy,
      cta_type: text("cta_type"),
      cta_url: ctaUrl,
      crm_facts_only: crmFactsOnly,
      service_id: serviceId,
      offer_id: offerId,
      keyword_id: keywordId,
      notes: text("notes"),
    },
  };
}

// Rows arrive with plain strings; the checks below only match known values.
export type PostState = {
  review_status: string;
  publish_status: string;
  platform?: string;
};

export type PostAction =
  | "edit"
  | "submit"
  | "withdraw"
  | "approve"
  | "reject"
  | "revise"
  | "reopen"
  | "schedule"
  | "unschedule"
  | "mark_published"
  | "publish_now"
  | "delete";

// What a signed-in team member may do next. Approve / reject / reopen are
// theirs alone (the database checks it is a person, not the worker); the
// publisher's steps (publishing, published, failed) never appear here.
export function availableActions(post: PostState): PostAction[] {
  const out: PostAction[] = [];
  const { review_status: r, publish_status: p } = post;
  if (r === "draft") out.push("edit", "submit");
  if (r === "in_review") out.push("approve", "reject", "withdraw");
  if (r === "rejected") out.push("revise");
  if (r === "approved" && (p === "not_scheduled" || p === "failed")) out.push("schedule");
  if (r === "approved" && p === "scheduled") out.push("unschedule");
  if (r === "approved" && (p === "not_scheduled" || p === "scheduled" || p === "failed")) {
    if (post.platform && canPublishByHand(post.platform)) out.push("mark_published");
    // Business Profile: the same governed publisher path as a scheduled post (0046).
    if (post.platform === "google_business") out.push("publish_now");
    out.push("reopen");
  }
  if ((r === "draft" || r === "rejected") && p === "not_scheduled") out.push("delete");
  return out;
}

// The one word a list shows: publishing wins once a post is approved.
export function displayState(post: PostState): { label: string; className: string } {
  if (post.review_status === "approved" && isPublishStatus(post.publish_status) && post.publish_status !== "not_scheduled") {
    return publishLabels[post.publish_status];
  }
  return isReviewStatus(post.review_status) ? reviewLabels[post.review_status] : { label: post.review_status, className: "" };
}

export type PostEvent = {
  kind: string;
  actor_kind: string;
  actor_id: string | null;
  from_value: string | null;
  to_value: string | null;
  detail: unknown;
};

const eventText: Record<string, string> = {
  created: "Drafted",
  edited: "Edited",
  claim_linked: "Linked a claim",
  claim_unlinked: "Unlinked a claim",
  asset_linked: "Added an asset",
  asset_unlinked: "Removed an asset",
  submitted: "Submitted for review",
  withdrawn: "Withdrew it from review",
  approved: "Approved",
  rejected: "Rejected",
  revised: "Reopened the rejected draft to revise it",
  reopened: "Reopened the approved post (approval cleared)",
  grounding_lapsed: "What the post stands on changed",
  scheduled: "Scheduled",
  rescheduled: "Moved the scheduled time",
  unscheduled: "Unscheduled",
  publishing: "Started publishing",
  published: "Published",
  failed: "Publishing failed",
  retried: "Scheduled a retry",
};

export function describePostEvent(e: PostEvent, names: Map<string, string>): string {
  const who =
    e.actor_kind === "team"
      ? (e.actor_id && names.get(e.actor_id)) || "A former teammate"
      : e.actor_kind === "publisher"
        ? "Publisher"
        : e.actor_kind === "system"
          ? "System"
          : "Worker";
  const base = eventText[e.kind] ?? e.kind;
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
  const extra: string[] = [];
  if (e.kind === "rejected" && typeof d.note === "string") extra.push(`“${d.note}”`);
  if (e.kind === "approved" && typeof d.note === "string") extra.push(`“${d.note}”`);
  if (e.kind === "grounding_lapsed") {
    if (Array.isArray(d.problems) && d.problems.length) extra.push(d.problems.join(" "));
    extra.push(e.to_value === "in_review" && e.from_value === "approved" ? "Sent back to review." : "Recorded only; the post was not moved.");
  }
  if (e.kind === "failed" && typeof d.error === "string") extra.push(d.error);
  if (e.kind === "published" && d.manual === true) extra.push("by hand");
  if (e.kind === "published" && typeof d.published_url === "string") extra.push(d.published_url);
  if (e.kind === "edited" && Array.isArray(d.fields)) extra.push(`(${d.fields.join(", ")})`);
  return [`${who}: ${base}`, ...extra].join(" — ");
}

// Postgres words the triggers raise, shown as they are (they are written for
// people); only the SQLSTATE prefix and the constraint jargon are reworded.
export function postErrorMessage(message: string | undefined): string {
  if (!message) return "That did not work.";
  const known: [RegExp, string][] = [
    [/social_posts_execution_needs_approval/, "Only an approved post can be scheduled."],
    [/social_posts_scheduled_has_time/, "Pick a date and time to schedule it."],
    [/social_posts_rejection_explained/, "Say why the post is rejected."],
    [/social_posts_gbp_types/, "Offer posts are Business Profile posts."],
    [/social_posts_post_type_known/, "A post is a standard or an offer post."],
    [/social_posts_published_complete/, "Say where and when it was published."],
    [/social_posts_offer_post_has_offer/, "An offer post needs one of the client's offers."],
    [/social_posts_crm_facts_navigational/, "“CRM facts only” is for navigational posts."],
    [/violates foreign key constraint/, "That belongs to another client or no longer exists."],
    [/row-level security|permission denied/, "Only the Compass team can change posts."],
  ];
  for (const [re, text] of known) if (re.test(message)) return text;
  return message;
}
