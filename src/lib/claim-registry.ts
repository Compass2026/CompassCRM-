// Claims Registry (20261103220000, v2 since 20261104200000): the shape
// claim_registry(client) returns and the words the Intelligence tab uses for
// it. Pure; imported by tests/claim-registry.test.mjs and
// tests/claim-verification.test.mjs directly, so no "@/" imports.
//
// The registry changes no gate: what a post or draft may cite is still
// today's rule (legacy_usable). Whether a claim has been independently
// verified is a separate answer (verification_state): a decision by the
// verification owner in the ledger (claim_reviews), pinned to evidence.
// Unknown figures arrive as null and are shown as "—", never 0.

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

export type EvidenceType = "document" | "capture";

export type RegistryEvidence = {
  id: string;
  type: EvidenceType;
  label: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  original_name: string | null;
  source_url: string | null;
  captured_on: string | null;
  uploaded_by_name: string | null;
  created_at: string;
  intact: boolean;
};

export type RegistryLocation = {
  id: string;
  label: string;
  phone: string;
  identity_version: number;
  workspace_slug: string | null;
};

export type ReviewAction = "classify" | "verify" | "review" | "revoke";

export type VerificationRecord = {
  review_id: string;
  action: "verify" | "review";
  at: string;
  excerpt: string;
  observed_on: string;
  expires_on: string | null;
  confirmed_by_contact: string | null;
  note: string | null;
  evidence: {
    id: string;
    type: EvidenceType;
    label: string;
    sha256: string;
    mime_type: string;
    size_bytes: number;
    source_url: string | null;
    captured_on: string | null;
    intact: boolean;
  } | null;
  location: { id: string; label: string; identity_version: number; intact: boolean } | null;
};

export type RegistryClaim = {
  id: string;
  claim: string;
  status: "confirmed" | "sourced" | "unverified";
  legacy_usable: boolean;
  verification_state: "independently_verified" | "not_independently_verified";
  bucket: ClaimBucket;
  reasons: string[];
  kind: string | null;
  kind_label: string;
  recorded_at: string;
  /** Pass both back to a writer: a changed claim refuses a stale screen (CV409). */
  fingerprint: string;
  review_id: string | null;
  review_count: number;
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
    record: VerificationRecord | null;
    last_decision: { action: ReviewAction; at: string; by: string | null; reason: string | null; note: string | null } | null;
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
  supersession_mentioned_by: string[];
  phone_location: string | null;
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
  version: "claim-registry/v1" | "claim-registry/v2";
  client_id: string;
  client: string;
  as_of: string;
  today: string;
  multi_site: boolean;
  /** A display hint: the writers decide for themselves. */
  viewer: { can_review: boolean };
  verification_owner: string | null;
  evidence: RegistryEvidence[];
  locations: RegistryLocation[];
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
    "Citable under current rules, but not independently verified: never verified, not classified, or verified by a method that does not settle this kind of fact.",
  due: "Verified; its review date is within 14 days.",
  verified: "Classified, verified by the verification owner with evidence that settles this kind of fact, and current.",
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
  method_unrecorded: "Confirmed under the current rules; not independently verified (no method or evidence recorded).",
  method_not_authoritative: "Verified by a method that does not settle this kind of fact.",
  changed_since_verified: "Its text or source changed after it was verified.",
  verification_unrecorded: "Verification fields were set outside the verification record: not independent verification.",
  evidence_file_changed: "The evidence file is missing or was replaced after it was verified.",
  evidence_location_changed: "The location record changed, or was archived, after it was verified.",
  scope_changed_since_verified: "Its brand sites changed after it was verified.",
  evidence_expired: "The evidence's own expiry has passed.",
  cited_while_unusable: "Cited by content although today's rules would refuse it.",
  published_while_unusable: "Cited by published content although today's rules would refuse it.",
  cited_while_superseded: "Cited by content although it has been replaced.",
  supersession_mentioned:
    "Possibly superseded: another claim's note mentions replacing it. Tentative; not a recorded replacement.",
  conflict_noted: "Its text or source notes a conflict.",
  summary_source: "Its source is a search or listing summary: supporting evidence only.",
  duplicates_structured_phone: "Repeats the phone on the client's record; the record governs.",
  matches_location_phone: "Matches the approved phone of one location; that location's record governs.",
  phone_potential_mismatch:
    "Potential mismatch: the phone is on neither the client-wide nor an approved location record. Other location numbers are not evaluated yet.",
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

export function reasonLines(c: Pick<RegistryClaim, "bucket" | "reasons"> & { phone_location?: string | null }): string[] {
  const said = [...(SAID_BY_BUCKET[c.bucket] ?? []), ...SAID_BY_LINES];
  // "By published content" says everything "by content" does, and more.
  if (c.reasons.includes("published_while_unusable")) said.push("cited_while_unusable");
  return c.reasons
    .filter((r) => !said.includes(r))
    .map((r) =>
      r === "matches_location_phone" && c.phone_location
        ? `Matches the approved phone of the ${c.phone_location} location; that location's record governs.`
        : (REASON_TEXT[r] ?? r),
    );
}

/** The two separate answers the registry gives: today's citability and independent verification. */
export function eligibilityLabels(c: Pick<RegistryClaim, "legacy_usable" | "verification_state">): {
  citable: string;
  verified: string;
} {
  return {
    citable: c.legacy_usable ? "citable under current rules" : "not citable under current rules",
    verified: c.verification_state === "independently_verified" ? "independently verified" : "not independently verified",
  };
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

// ── Verification (20261104200000) ────────────────────────────────────────────

/** What each method needs, as claim_verify enforces it. */
export const METHOD_EVIDENCE: Record<string, { needs: "document" | "capture" | "location"; help: string }> = {
  client_contract: { needs: "document", help: "The signed contract or agreement, uploaded." },
  manufacturer_document: { needs: "document", help: "The manufacturer's warranty or product document, uploaded." },
  client_confirmation: {
    needs: "document",
    help: "A signed form or saved email from the client, uploaded, and the name of the contact who confirmed it.",
  },
  client_published: {
    needs: "capture",
    help: "A capture (PDF or screenshot) of the client's own page for this claim's site, from the last 30 days.",
  },
  platform_record: { needs: "capture", help: "A capture of the listing (for example the Google profile), from the last 30 days." },
  issuer_record: {
    needs: "capture",
    help: "A capture of the issuer's record (licence lookup, certification registry), from the last 30 days.",
  },
  structured_record: { needs: "location", help: "An approved location record whose phone the claim states." },
};

export const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = {
  document: "Document",
  capture: "Page capture",
};

export const DECISION_LABEL: Record<ReviewAction, string> = {
  classify: "Classified",
  verify: "Verified",
  review: "Re-reviewed",
  revoke: "Verification revoked",
};

/** "a1b2c3d4…9f0e": enough to compare by eye; the full hash goes in a title. */
export function shortHash(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 8)}…${sha.slice(-4)}` : sha;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The evidence a verification stands on, in one line, or null. */
export function evidenceLine(c: Pick<RegistryClaim, "verification">): string | null {
  const r = c.verification.record;
  if (!r) return null;
  if (r.evidence) {
    const e = r.evidence;
    return `Evidence: ${e.label} · ${EVIDENCE_TYPE_LABEL[e.type].toLowerCase()} · SHA-256 ${shortHash(e.sha256)}${e.intact ? "" : " · file changed"}`;
  }
  if (r.location) {
    return `Evidence: ${r.location.label} location record, version ${r.location.identity_version}${r.location.intact ? "" : " · record changed"}`;
  }
  return null;
}

/** The last decision when it is not a verification in force (a classification or a revocation). */
export function decisionLine(c: Pick<RegistryClaim, "verification">): string | null {
  const d = c.verification.last_decision;
  if (!d || d.action === "verify" || d.action === "review") return null;
  const who = d.by ?? "a former teammate";
  return `${DECISION_LABEL[d.action]} by ${who} on ${formatDay(d.at)}${d.reason ? `: ${d.reason}` : ""}`;
}

export type ReviewOptions = {
  canClassify: boolean;
  canVerify: boolean;
  canReview: boolean;
  canRevoke: boolean;
  /** Why verifying is not offered, when it is not. */
  verifyBlocked: string | null;
  methods: string[];
};

/** What the verification owner may do with a claim (the writers check again). */
export function reviewOptions(registry: Pick<ClaimRegistry, "intervals">, c: RegistryClaim): ReviewOptions {
  const superseded = c.superseded_by !== null;
  const inForce = c.verification.record !== null;
  const methods = c.kind ? (registry.intervals.find((i) => i.kind === c.kind)?.authoritative_methods ?? []) : [];
  let verifyBlocked: string | null = null;
  if (superseded) verifyBlocked = "A superseded claim is not reviewed.";
  else if (!c.kind) verifyBlocked = "Classify it before verifying it.";
  else if (c.status === "unverified")
    verifyBlocked = "An unverified claim is confirmed in the next release, with a review of the content it affects.";
  return {
    canClassify: !superseded,
    canVerify: verifyBlocked === null && !inForce,
    canReview: !superseded && inForce,
    canRevoke: !superseded && inForce,
    verifyBlocked,
    methods,
  };
}

/** The evidence a method may cite: intact files of the right type, or approved locations on the claim's sites. */
export function evidenceChoices(
  registry: Pick<ClaimRegistry, "evidence" | "locations">,
  c: Pick<RegistryClaim, "scope">,
  method: string,
): { id: string; label: string }[] {
  const needs = METHOD_EVIDENCE[method]?.needs;
  if (needs === "location") {
    return registry.locations
      .filter((l) => l.workspace_slug === null || c.scope.programs.includes(l.workspace_slug))
      .map((l) => ({ id: l.id, label: `${l.label} · ${l.phone} · version ${l.identity_version}` }));
  }
  return registry.evidence
    .filter((e) => e.type === needs && e.intact)
    .map((e) => ({
      id: e.id,
      label: `${e.label} · ${shortHash(e.sha256)}${e.captured_on ? ` · captured ${formatDay(e.captured_on)}` : ""}`,
    }));
}
