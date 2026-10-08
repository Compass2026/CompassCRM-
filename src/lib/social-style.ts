// Client Social Style Profiles (Social History SH2): what the Social › Style
// page shows of a proposed or approved profile. Pure, so the page and the
// tests read the analyzer's output the same way. A profile is style and
// performance evidence only: nothing here turns a historical post into a
// claim, and the AI Drafter does not read profiles yet (SH3).

export type StyleStatus = "proposed" | "approved" | "rejected" | "superseded";
export const STYLE_STATUSES: StyleStatus[] = ["proposed", "approved", "rejected", "superseded"];
export type Confidence = "high" | "medium" | "low";

export type StyleProfileRow = {
  id: string;
  version: number;
  status: StyleStatus;
  analyzer_version: string;
  as_of: string;
  posts_imported: number;
  posts_learnable: number;
  posts_voice: number;
  posts_performance: number;
  profile: unknown;
  profile_hash: string;
  requested_by: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  superseded_at: string | null;
};
export const STYLE_PROFILE_COLUMNS =
  "id, version, status, analyzer_version, as_of, posts_imported, posts_learnable, posts_voice, posts_performance, profile, profile_hash, requested_by, created_at, reviewed_by, reviewed_at, review_note, superseded_at";

export const statusLabels: Record<StyleStatus, string> = {
  proposed: "Proposed — waiting for a teammate",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export type ExamplePost = {
  post_id: string;
  permalink: string | null;
  published_at: string;
  format: string;
  category: string;
  opening_type: string;
  why: string[];
  masked_copy: string;
  masked: Record<string, number>;
  metrics: { reach: number | null; reactions: number | null; comments: number | null; shares: number | null; clicks: number | null; engagement_per_reach: number | null; lift: number | null } | null;
};
export type DoNotLearnPost = { post_id: string; permalink: string | null; published_at: string; format: string; opening: string; reasons: { code: string; detail: string }[] };
export type DoNotLearnPhrase = { category: string; label: string; posts: number; examples: { text: string; count: number }[]; why: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const pct = (v: unknown) => { const n = num(v); return n == null ? "—" : `${Math.round(n * 100)}%`; };
const words = (k: string) => k.replace(/_/g, " ");
const top = (v: unknown, n: number) => Object.entries(obj(v)).slice(0, n).map(([k, c]) => `${words(k)} ${c}`).join(", ");
const isConfidence = (v: unknown): v is Confidence => v === "high" || v === "medium" || v === "low";

export function readProfile(p: unknown) {
  const o = obj(p);
  return {
    schema: str(o.schema),
    boundary: str(o.boundary) ?? "",
    corpus: obj(o.corpus),
    metricAvailability: obj(o.metric_availability),
    traits: obj(o.traits),
    representative: arr<ExamplePost>(o.representative),
    topPerformers: arr<ExamplePost>(o.top_performers),
    outliers: arr<ExamplePost & { also_do_not_learn?: string[] }>(o.outliers),
    doNotLearnPosts: arr<DoNotLearnPost>(obj(o.do_not_learn).posts),
    doNotLearnPhrases: arr<DoNotLearnPhrase>(obj(o.do_not_learn).phrases),
    notes: arr<string>(o.notes).filter((x) => typeof x === "string"),
  };
}

export type TraitView = { key: string; label: string; confidence: Confidence; n: number | null; lines: string[]; basis: string; descriptive: boolean };

// Style, never strategy (docs/social-history.md, "Influence rule"). These
// traits describe the client's history; no consumer may use them to choose,
// rank, schedule or weight what gets created. They never override Authority
// topic selection, search-intent coverage, service priorities, E-E-A-T /
// evidence needs or Content Planner strategy.
export const DESCRIPTIVE_TRAITS: readonly string[] = ["content_mix", "cadence", "media_mix", "engagement", "locations"];
// What an approved profile may shape in a draft.
export const STYLE_INFLUENCE = ["voice and tone", "hooks and openings", "sentence rhythm", "CTA phrasing",
  "emoji and hashtag tendencies", "presentation (length, line breaks, layout)"] as const;
const TRAIT_LABELS: [string, string][] = [
  ["caption_length", "Caption length"], ["structure", "Structure"], ["openings", "Openings / hooks"],
  ["sentences", "Sentences and rhythm"], ["tone", "Conversational vs promotional"], ["emoji", "Emoji"],
  ["hashtags", "Hashtags"], ["cta", "Calls to action"], ["locations", "Location mentions"],
  ["content_mix", "Content mix"], ["media_mix", "Media mix"], ["cadence", "Posting cadence"],
  ["recurring_language", "Recurring language"], ["engagement", "Engagement (own baseline)"],
];

function traitLines(key: string, t: Obj): string[] {
  const d = (v: unknown) => obj(v);
  switch (key) {
    case "caption_length": {
      const c = d(t.chars), w = d(t.words);
      return [`Median ${c.median ?? "—"} characters (${w.median ?? "—"} words); middle half ${c.p25 ?? "—"}–${c.p75 ?? "—"}.`,
        `Lengths: ${top(t.buckets, 4) || "—"}.`,
        `Video median ${d(d(t.by_format_family).video).median ?? "—"} · static median ${d(d(t.by_format_family).static).median ?? "—"} characters.`];
    }
    case "structure":
      return [`Median ${d(t.lines_per_post).median ?? "—"} lines a post.`,
        `Checklist of short bullet lines in ${pct(t.posts_with_checklist)}; contact signature block in ${pct(t.posts_with_signature_block)}; closing hashtag block in ${pct(t.posts_with_hashtag_block)}.`];
    case "openings":
      return [`First lines: ${top(t.types, 5) || "—"}.`];
    case "sentences": {
      const p = d(t.person);
      return [`Median ${d(t.words_per_sentence).median ?? "—"} words a sentence; ${pct(t.short_sentence_share)} are 8 words or fewer.`,
        `Exclamations in ${pct(t.posts_with_exclamation)}, questions in ${pct(t.posts_with_question)} of posts.`,
        `Per post: "we / our" ${p.we_our_per_post ?? "—"}, "you / your" ${p.you_your_per_post ?? "—"}, the business name ${p.brand_name_per_post ?? "—"}.`];
    }
    case "tone":
      return [`Posts read as: ${top(t.labels, 3) || "—"}.`, `Median markers: conversational ${t.median_conversational ?? "—"}, promotional ${t.median_promotional ?? "—"}.`];
    case "emoji":
      return [`Emoji in ${pct(t.posts_with_any)} of posts (median ${d(t.per_post_when_used).median ?? "—"} when used); first line starts with one in ${pct(t.leads_first_line)}.`,
        `Most used: ${arr<Obj>(t.top).slice(0, 8).map((e) => `${e.emoji} ${e.count}`).join("  ") || "—"}.`];
    case "hashtags":
      return [`Hashtags in ${pct(t.posts_with_any)} of posts (median ${d(t.per_post_when_used).median ?? "—"}), in a closing block ${pct(t.in_closing_block)} of the time.`,
        `Most used: ${arr<Obj>(t.top).slice(0, 8).map((h) => `${h.tag}${h.do_not_learn ? " (do not learn)" : ""}`).join(", ") || "—"}.`];
    case "cta":
      return [`A call to action in ${pct(t.posts_with_any)} of posts: ${Object.entries(d(t.types)).map(([k, v]) => `${words(k)} ${pct(v)}`).join(", ") || "—"}.`,
        ...arr<Obj>(t.common_lines).slice(0, 3).map((l) => `Recurring line: "${l.line}" (${l.count}×).`)];
    case "locations":
      return [`A place is named in ${pct(t.posts_naming_a_place)} of posts.`,
        `Approved: ${top(t.approved, 6) || "none"}.`,
        `Service area but not approved (masked): ${top(t.in_service_area_not_approved, 6) || "none"}.`,
        ...(Object.keys(d(t.other)).length ? [`Other places (masked): ${top(t.other, 6)}.`] : [])];
    case "content_mix":
      return [`${Object.entries(d(t.share)).map(([k, v]) => `${words(k)} ${pct(v)}`).join(", ") || "—"}.`];
    case "media_mix":
      return [`${top(t.formats, 6) || "—"}.`];
    case "cadence":
      return [`${t.posts_per_week ?? "—"} posts a week over ${t.span_days ?? "—"} days; median gap ${d(t.gap_days).median ?? "—"} days.`,
        `Weekdays: ${top(t.weekday, 3) || "—"}; time of day (${t.timezone ?? "local"}): ${top(t.hour_local, 3) || "—"}.`];
    case "recurring_language": {
      const keep = arr<Obj>(t.phrases).filter((p) => !p.do_not_learn).slice(0, 5);
      return [keep.length ? `Recurring phrases: ${keep.map((p) => `"${p.phrase}" (${p.posts})`).join(", ")}.` : "No recurring phrase in a fifth of the posts.",
        `${t.near_duplicate_pairs ?? 0} near-duplicate pairs of posts.`];
    }
    case "engagement": {
      const b = d(t.baseline);
      const cats = Object.entries(d(t.lift_by_category)).filter(([, v]) => num(d(v).median_lift) != null)
        .map(([k, v]) => `${words(k)} ${d(v).median_lift}×`);
      const fmts = Object.entries(d(t.lift_by_format)).filter(([, v]) => num(d(v).median_lift) != null)
        .map(([k, v]) => `${words(k)} ${d(v).median_lift}×`);
      return [`Baseline engagement per reach: overall ${b.overall == null ? "unavailable" : `${(Number(b.overall) * 100).toFixed(1)}%`}` +
          ` (video ${b.video == null ? "—" : `${(Number(b.video) * 100).toFixed(1)}%`}, static ${b.static == null ? "—" : `${(Number(b.static) * 100).toFixed(1)}%`}); ${t.eligible_posts ?? 0} posts eligible.`,
        `Median reach ${d(t.reach).median ?? "—"}; comments on ${pct(t.posts_with_comments)}, shares on ${pct(t.posts_with_shares)} of posts.`,
        ...(cats.length ? [`Lift by content (5+ posts): ${cats.join(", ")}.`] : ["Too few posts per content type to compare lift."]),
        ...(fmts.length ? [`Lift by format: ${fmts.join(", ")}.`] : [])];
    }
    default:
      return [];
  }
}

export function traitViews(profile: unknown): TraitView[] {
  const traits = readProfile(profile).traits;
  return TRAIT_LABELS.filter(([k]) => traits[k]).map(([key, label]) => {
    const t = obj(traits[key]);
    return { key, label, confidence: isConfidence(t.confidence) ? t.confidence : "low", n: num(t.n), lines: traitLines(key, t), basis: str(t.basis) ?? "",
      descriptive: DESCRIPTIVE_TRAITS.includes(key) };
  });
}

export const confidenceTone: Record<Confidence, string> = {
  high: "bg-green-100 text-green-800 border-green-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  low: "bg-muted text-muted-foreground",
};

// The review a teammate submits. Rejecting needs a reason (the database
// refuses it otherwise; this only says so before the round trip).
export function validateStyleReview(decision: string, note: string): { ok: true; decision: "approve" | "reject"; note: string | null } | { ok: false; error: string } {
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Choose approve or reject." };
  const n = note.trim();
  if (decision === "reject" && !n) return { ok: false, error: "Say why the profile is rejected." };
  if (n.length > 1000) return { ok: false, error: "Keep the note under 1,000 characters." };
  return { ok: true, decision, note: n || null };
}

// What the analyze call answered, for the teammate.
export function analyzeMessage(status: number | null, body: Record<string, unknown> | null): { ok: boolean; text: string } {
  const b = body ?? {};
  const message = typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : null;
  if (status === 201) return { ok: true, text: `Analysis recorded as proposed version ${b.version}. Review it below; nothing uses it until a teammate approves.` };
  if (status === 200) return { ok: true, text: `Nothing changed since version ${b.version}; that analysis stands.` };
  if (status === null) return { ok: false, text: "The analysis did not answer in time. Reload in a minute." };
  if (status === 401) return { ok: false, text: "Your session expired. Sign in again and retry." };
  if (status === 403) return { ok: false, text: "Only Compass team members can run the analysis." };
  if (status === 404 && !message) return { ok: false, text: "The social-history function is not deployed." };
  if (status === 409) return { ok: false, text: message ?? "Nothing to analyze yet." };
  return { ok: false, text: `The analysis failed${message ? `: ${message}` : ""}. Nothing was recorded.` };
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" });
}
