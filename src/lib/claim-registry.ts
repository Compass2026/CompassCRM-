// Claims Registry v1 (20261103220000): the shape claim_registry(client)
// returns and the words the Intelligence tab uses for it. Pure; imported by
// tests/claim-registry.test.mjs directly, so no "@/" imports.
//
// The registry is read-only and changes no gate: what a post or draft may
// cite is still today's rule (legacy_usable). Unknown figures arrive as null
// and are shown as "—", never 0.

export type ClaimBucket =
  | "superseded"
  | "unverified"
  | "missing_source"
  | "stale"
  | "needs_review"
  | "due"
  | "verified";

export type SourceClass =
  | "none"
  | "search_summary"
  | "client_site"
  | "google"
  | "government"
  | "third_party_web"
  | "confirmation_note"
  | "text_note";

export type RegistryCounts = {
  total: number;
  verified: number;
  due: number;
  stale: number;
  needs_review: number;
  unverified: number;
  missing_source: number;
  superseded: number;
  legacy_usable: number;
  shared: number | null;
  cited_while_unusable: number;
};

export type RegistryPost = {
  id: string;
  platform: string;
  review_status: string;
  publish_status: string;
  published_at: string | null;
  published_url: string | null;
};

export type RegistryDraft = {
  id: string;
  deliverable: string;
  status: string;
  title: string | null;
  published_url: string | null;
  published_at: string | null;
};

export type RegistryClaim = {
  id: string;
  claim: string;
  status: "confirmed" | "sourced" | "unverified";
  legacy_usable: boolean;
  bucket: ClaimBucket;
  reasons: string[];
  kind: string | null;
  kind_label: string;
  recorded_at: string;
  verification: {
    method: string | null;
    authoritative: boolean | null;
    authoritative_methods: string[];
    verified_at: string | null;
    verified_by: string | null;
    verified_by_name: string | null;
    confirmed_by: string | null;
    confirmed_on: string | null;
    last_verified_at: string | null;
    changed_since_verified: boolean;
  };
  freshness: {
    state: "never_verified" | "overdue" | "due" | "current";
    interval_days: number;
    review_by: string | null;
    due_on: string | null;
    days_left: number | null;
  };
  source: { text: string | null; url: string | null; host: string | null; class: SourceClass };
  scope: { programs: string[]; shared: boolean | null; unassigned: boolean | null };
  superseded_by: string | null;
  supersedes: string[];
  named_superseded_by: string[];
  affected: { posts: RegistryPost[]; drafts: RegistryDraft[]; published: number; total: number };
};

export type RegistryProgram = {
  workspace_id: string | null;
  slug: string | null;
  name: string;
  website_url: string | null;
  scope: "brand_workspace" | "client";
  workspace_status: string | null;
  scope_authoritative: boolean;
  claim_ids: string[];
  counts: RegistryCounts | null;
};

export type ClaimRegistry = {
  version: "claim-registry/v1";
  client_id: string;
  client: string;
  as_of: string;
  today: string;
  multi_site: boolean;
  intervals: { kind: string; label: string; review_days: number; authoritative_methods: string[] }[];
  totals: RegistryCounts & { published_while_unusable: number; unassigned: number | null };
  programs: RegistryProgram[];
  claims: RegistryClaim[];
};

// Worst first: the order the registry sorts claims in.
export const BUCKET_ORDER: ClaimBucket[] = [
  "superseded",
  "unverified",
  "missing_source",
  "stale",
  "needs_review",
  "due",
  "verified",
];

export const BUCKET_LABEL: Record<ClaimBucket, string> = {
  superseded: "Superseded",
  unverified: "Unverified",
  missing_source: "Missing source",
  stale: "Stale",
  needs_review: "Needs review",
  due: "Review due",
  verified: "Verified",
};

export const BUCKET_HELP: Record<ClaimBucket, string> = {
  superseded: "Replaced by another claim. Content that cites it should be reconciled.",
  unverified: "Today's rules never let a post or draft cite it.",
  missing_source: "Marked sourced with no source recorded, so today's rules refuse it.",
  stale: "Its last verification is past its review date.",
  needs_review:
    "Usable today, but not yet verified for the registry: never verified, not classified, or verified by a method that does not settle this kind of fact.",
  due: "Verified; its review date is within 14 days.",
  verified: "Classified, verified by an authoritative method, and current.",
};

export const BUCKET_TONE: Record<ClaimBucket, "bad" | "warn" | "ok"> = {
  superseded: "bad",
  unverified: "bad",
  missing_source: "bad",
  stale: "warn",
  needs_review: "warn",
  due: "warn",
  verified: "ok",
};

export const STATUS_LABEL: Record<RegistryClaim["status"], string> = {
  confirmed: "Confirmed",
  sourced: "Sourced",
  unverified: "Unverified",
};

export const SOURCE_CLASS_LABEL: Record<SourceClass, string> = {
  none: "No source",
  search_summary: "Search or listing summary",
  client_site: "Client's own website",
  google: "Google listing",
  government: "Government site",
  third_party_web: "Third-party website",
  confirmation_note: "Confirmation note",
  text_note: "Note",
};

export const METHOD_LABEL: Record<string, string> = {
  client_contract: "Client contract",
  manufacturer_document: "Manufacturer document",
  issuer_record: "Issuer record",
  structured_record: "Verified CRM record",
  platform_record: "Platform record",
  client_confirmation: "Client confirmation",
  client_published: "Client's published page",
  third_party: "Third party",
};

// Indicators, not decisions: none of them changes what may be cited today.
export const REASON_TEXT: Record<string, string> = {
  superseded: "Replaced by another claim.",
  unverified: "Unverified.",
  missing_source: "No source recorded.",
  overdue: "Past its review date.",
  due_soon: "Review due within 14 days.",
  never_verified: "Never verified by a teammate; a source URL alone is not verification.",
  unclassified: "Not classified yet, so it is reviewed every 90 days and never counted as verified.",
  method_unrecorded: "Confirmed before the registry; how it was verified is not recorded.",
  method_not_authoritative: "Verified by a method that does not settle this kind of fact.",
  changed_since_verified: "Its text or source changed after it was verified.",
  cited_while_unusable: "Cited by content although today's rules would refuse it.",
  published_while_unusable: "Cited by published content although today's rules would refuse it.",
  cited_while_superseded: "Cited by content although it has been replaced.",
  named_as_superseded: "Another claim's note says it supersedes this one.",
  conflict_noted: "Its text or source notes a conflict.",
  summary_source: "Its source is a search or listing summary: supporting evidence only.",
  duplicates_structured_phone: "Repeats the phone on the client's record; the record governs.",
  phone_differs_from_structured: "Names a phone that differs from the client's record.",
  phone_without_structured_record: "Names a phone, and the client has none on record.",
  unassigned_to_site: "Assigned to no brand site, so no site may use it.",
  shared_across_sites: "Shared by more than one brand site.",
};

// Reasons already said by the bucket badge are not repeated under the claim.
const SAID_BY_BUCKET: Partial<Record<ClaimBucket, string[]>> = {
  superseded: ["superseded"],
  unverified: ["unverified"],
  missing_source: ["missing_source"],
  stale: ["overdue"],
  due: ["due_soon"],
};
// Said by the verification and review lines (verificationLine, reviewLine).
const SAID_BY_LINES = ["never_verified", "unclassified", "method_unrecorded"];

export function reasonLines(c: Pick<RegistryClaim, "bucket" | "reasons">): string[] {
  const said = [...(SAID_BY_BUCKET[c.bucket] ?? []), ...SAID_BY_LINES];
  // "By published content" says everything "by content" does, and more.
  if (c.reasons.includes("published_while_unusable")) said.push("cited_while_unusable");
  return c.reasons.filter((r) => !said.includes(r)).map((r) => REASON_TEXT[r] ?? r);
}

/** A count, or "—" when the registry could not know it. Never 0 for unknown. */
export function fig(n: number | null | undefined): string {
  return typeof n === "number" ? String(n) : "—";
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const day = value.length === 10 ? `${value}T12:00:00Z` : value;
  return new Date(day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: value.length === 10 ? "UTC" : "America/Chicago",
  });
}

/** "Confirmed by … on …", "Verified by … on … (method)", or "Never verified". */
export function verificationLine(c: RegistryClaim): string {
  const v = c.verification;
  if (v.verified_at && v.method) {
    const who = v.verified_by_name ?? "a former teammate";
    return `Verified by ${who} on ${formatDay(v.verified_at)} · ${METHOD_LABEL[v.method] ?? v.method}`;
  }
  if (c.status === "confirmed" && v.confirmed_on) {
    return `Confirmed${v.confirmed_by ? ` by ${v.confirmed_by}` : ""} on ${formatDay(v.confirmed_on)} · method not recorded`;
  }
  return `Never verified · recorded ${formatDay(c.recorded_at)}`;
}

/** The review rule and where the claim stands against it. */
export function reviewLine(c: RegistryClaim): string {
  const f = c.freshness;
  const rule = `${c.kind_label} · review every ${f.interval_days} days`;
  if (f.due_on === null || f.days_left === null) return `${rule} · no review date until verified`;
  if (f.days_left < 0) return `${rule} · was due ${formatDay(f.due_on)} (${-f.days_left} days ago)`;
  if (f.days_left === 0) return `${rule} · due today`;
  return `${rule} · due ${formatDay(f.due_on)} (in ${f.days_left} days)`;
}

const PLATFORM_LABEL: Record<string, string> = {
  google_business: "Business Profile post",
  facebook: "Facebook post",
  instagram: "Instagram post",
};

const STATE_LABEL: Record<string, string> = {
  published: "published",
  approved: "approved",
  in_review: "in review",
  rejected: "rejected",
  draft: "draft",
  requested: "requested",
  scheduled: "scheduled",
  publishing: "publishing",
  failed: "failed",
};

export type AffectedLink = {
  key: string;
  label: string;
  state: string;
  href: string;
  external: string | null;
  published: boolean;
};

/** Every post and draft standing on a claim, published first, with CRM links. */
export function affectedLinks(clientId: string, c: Pick<RegistryClaim, "affected">): AffectedLink[] {
  const posts = c.affected.posts.map((p) => {
    const published = p.publish_status === "published";
    const state = published ? "published" : p.publish_status === "not_scheduled" ? p.review_status : p.publish_status;
    return {
      key: `post:${p.id}`,
      label: PLATFORM_LABEL[p.platform] ?? `${p.platform} post`,
      state: `${STATE_LABEL[state] ?? state}${published && p.published_at ? ` ${formatDay(p.published_at)}` : ""}`,
      href: `/clients/${clientId}/social/${p.id}`,
      external: p.published_url,
      published,
    };
  });
  const drafts = c.affected.drafts.map((d) => {
    const published = d.published_url !== null;
    return {
      key: `draft:${d.id}`,
      label: `${d.deliverable === "web_page" ? "Page" : "Blog"} draft${d.title ? `: ${d.title}` : ""}`,
      state: published ? `published${d.published_at ? ` ${formatDay(d.published_at)}` : ""}` : (STATE_LABEL[d.status] ?? d.status),
      href: `/clients/${clientId}/drafts/${d.id}`,
      external: d.published_url,
      published,
    };
  });
  return [...posts, ...drafts].sort((a, b) => Number(b.published) - Number(a.published));
}

/** Claims grouped by bucket in BUCKET_ORDER, empty buckets left out. */
export function groupByBucket(claims: RegistryClaim[]): { bucket: ClaimBucket; claims: RegistryClaim[] }[] {
  return BUCKET_ORDER.map((bucket) => ({ bucket, claims: claims.filter((c) => c.bucket === bucket) })).filter(
    (g) => g.claims.length > 0,
  );
}

/** The tiles a program shows, in BUCKET_ORDER reversed (good news first). */
export const COUNT_TILES: { key: keyof RegistryCounts; label: string; tone: "bad" | "warn" | "ok" }[] = [
  { key: "verified", label: "Verified", tone: "ok" },
  { key: "due", label: "Review due", tone: "warn" },
  { key: "needs_review", label: "Needs review", tone: "warn" },
  { key: "stale", label: "Stale", tone: "warn" },
  { key: "unverified", label: "Unverified", tone: "bad" },
  { key: "missing_source", label: "Missing source", tone: "bad" },
  { key: "superseded", label: "Superseded", tone: "bad" },
];
