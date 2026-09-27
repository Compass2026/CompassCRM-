// AI Drafter v2: Authority mode. Pure; reads nothing, writes nothing.
//
// A draft for an Authority opportunity (migration 0053). The caller names the
// opportunity and nothing else about it: the target is derived here from the
// opportunity the latest completed analysis reports, the Drafter rebuilds its
// own governed brief for that target (buildBrief, unchanged), and the two are
// compared. Authority only narrows: every Drafter refusal stays, and any
// disagreement between the opportunity and the Drafter's own brief refuses —
// the Drafter never adapts one to the other.
//
// The same checks run in the database (drafter_write, 0053) inside the write
// transaction; these run first so brief and check refuse the same way submit
// would, and so a conflict is reported without recording a Drafter run.
import { normPath } from "../authority/urls.ts";
import type { Brief, DraftTarget, LintProblem } from "./types.ts";
import { words } from "./rules.ts";

// Mirrors authority/coverage.ts (GBP_CADENCE_DAYS) and drafter_write's live check.
export const CADENCE_DAYS = 21;
// Posts the duplicate rule compares a draft with.
export const DUPLICATE_WINDOW_DAYS = 90;
export const DUPLICATE_SHINGLE = 5;
export const DUPLICATE_OVERLAP = 0.5;
export const DUPLICATE_LEAD_CHARS = 100;

export type AuthorityOpportunity = {
  id: string;
  client_id: string;
  key: string;
  present: boolean;
  last_seen_run_id: string;
  status: "open" | "accepted" | "dismissed";
  section: string;
  action: string;
  tier: string;
  content_type: string;
  topic: string;
  service_id: string | null;
  keyword_id: string | null;
  intent: string | null;
  target_path: string | null;
  eligible_from: string | null;
  cycle_started_at: string | null;
  opportunity: {
    objective?: string | null;
    gap?: string | null;
    target?: { keyword?: string | null; cta?: string | null; owner_path?: string | null } | null;
    evidence_claim_ids?: string[] | null;
    reasons?: { tag?: string; text?: string }[] | null;
  };
};

export type RecentPost = {
  id: string;
  service_id: string | null;
  search_intent: string | null;
  review_status: string;
  publish_status: string;
  created_at: string;
  copy: string;
};

// Everything Authority mode reads (store.authority), read-only.
export type AuthorityState = {
  opportunity: AuthorityOpportunity | null;
  // The client's latest completed analysis run.
  latest_run: { id: string; engine_version: string | null; site: string | null } | null;
  // This opportunity's social_post links, with the linked post's review state.
  post_links: { created_at: string; review_status: string | null; publish_status: string | null }[];
  // The open Draft with AI request (a tasks row keyed authority_draft:<id>)
  // and whether a teammate's request_draft decision names it.
  request: { task_id: string; status: string; requested_by_team: boolean } | null;
  // The client's Business Profile posts of the last DUPLICATE_WINDOW_DAYS.
  recent_posts: RecentPost[];
};

export type AuthorityConflict = { code: string; message: string };

export type AuthoritySection = {
  opportunity_id: string;
  key: string;
  run_id: string;
  engine_version: string | null;
  topic: string;
  tier: string;
  objective: string | null;
  gap: string | null;
  reasons: string[];
  target: { keyword: string | null; intent: string; owner_path: string | null; cta: string | null };
  // The analysis's evidence, every one of them a claim this brief allows.
  preferred_claim_ids: string[];
  cadence: { days: number; eligible_from: string | null };
  // Recent Business Profile posts, so the draft says something new.
  recent_posts: { id: string; created_at: string; review_status: string; opening: string }[];
};

export type AuthorityBrief = Brief & { authority: AuthoritySection };

const day = (iso: string) => iso.slice(0, 10);
const daysAgo = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 86_400_000;
const LIVE = new Set(["draft", "in_review", "approved"]);

// Where a linked post leaves the opportunity (authority_link_state, 0048).
function linkState(l: AuthorityState["post_links"][number]): "done" | "active" | "dead" {
  if (l.publish_status === "published" || l.review_status === "approved") return "done";
  if (l.review_status === "draft" || l.review_status === "in_review") return "active";
  return "dead";
}

// The only target an Authority draft can have. Nothing comes from the caller.
export function deriveTarget(o: AuthorityOpportunity): DraftTarget {
  return {
    channel: "google_business",
    postType: "standard",
    intent: o.intent ?? "",
    serviceId: o.service_id,
    keywordId: o.keyword_id,
    ctaType: o.opportunity?.target?.cta ?? null,
    ctaUrl: null,
    offerId: null,
    assetIds: [],
  };
}

// The opportunity's own state, before any brief is built. today is the
// Chicago calendar day (YYYY-MM-DD); now is the instant, for the live cadence.
export function opportunityConflicts(
  s: AuthorityState,
  clientId: string,
  opts: { expectedRunId?: string | null; today: string; now: Date },
): AuthorityConflict[] {
  const o = s.opportunity;
  if (!o || o.client_id !== clientId) return [{ code: "opportunity_not_found", message: "No such Authority opportunity for this client." }];
  const out: AuthorityConflict[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  if (!o.present || !s.latest_run || o.last_seen_run_id !== s.latest_run.id) {
    add("opportunity_not_current", "The latest analysis no longer reports this opportunity.");
  }
  if (opts.expectedRunId && opts.expectedRunId !== o.last_seen_run_id) {
    add("authority_stale", `Requested against analysis run ${opts.expectedRunId}; the opportunity's current run is ${o.last_seen_run_id}.`);
  }
  if (o.status === "dismissed") add("dismissed", "The opportunity is dismissed.");
  if (o.content_type !== "gbp_post" || o.section !== "ready" || o.action !== "create") {
    add("not_ready", `The analysis does not mark this post ready to create (it is ${o.content_type} ${o.section} / ${o.action}).`);
  }
  if (!o.service_id || !o.intent) add("not_ready", "The opportunity names no service or intent.");
  if (o.eligible_from && o.eligible_from > opts.today) add("cadence_active", `Not eligible until ${o.eligible_from}.`);
  const cycle = o.cycle_started_at ? new Date(o.cycle_started_at).getTime() : -Infinity;
  const inCycle = s.post_links.filter((l) => new Date(l.created_at).getTime() >= cycle).map(linkState);
  if (inCycle.includes("done") || inCycle.includes("active")) {
    add("already_in_progress", "A draft for this opportunity is already in review or approved this cycle.");
  }
  // Cadence, live: the analysis may be older than the last post.
  const recent = s.recent_posts.find((p) =>
    p.service_id === o.service_id && p.search_intent === o.intent && daysAgo(p.created_at, opts.now) < CADENCE_DAYS
    && (LIVE.has(p.review_status) || p.publish_status === "published"));
  if (recent) {
    add("cadence_active", `A Business Profile post for this service and intent was created on ${day(recent.created_at)}; the next is due ${CADENCE_DAYS} days later.`);
  }
  return out;
}

// Submit also needs a teammate's open request (0053: the request task plus
// the team's request_draft decision event). brief and check report it only.
export function requestConflict(s: AuthorityState): AuthorityConflict | null {
  if (!s.request || !["open", "in_progress"].includes(s.request.status) || !s.request.requested_by_team) {
    return { code: "not_requested", message: "No open Draft with AI request from a teammate for this opportunity." };
  }
  return null;
}

// The opportunity against the brief the Drafter built on its own.
export function briefConflicts(s: AuthorityState, brief: Brief): AuthorityConflict[] {
  const o = s.opportunity!;
  const out: AuthorityConflict[] = [];
  const t = brief.target;
  const mismatch: string[] = [];
  if (o.key !== `gbp_post:${t.service?.id ?? ""}:${t.search_intent}`) mismatch.push("key");
  if (o.service_id !== (t.service?.id ?? null)) mismatch.push("service");
  if (o.intent !== t.search_intent) mismatch.push("intent");
  if (o.keyword_id !== (t.keyword?.id ?? null)) mismatch.push("keyword");
  if ((o.opportunity?.target?.cta ?? null) !== t.cta.type) mismatch.push("button");
  if (t.post_type !== "standard" || t.offer) mismatch.push("post type");
  if (o.target_path !== normPath(t.service?.page_url ?? null, s.latest_run?.site ?? null)) {
    mismatch.push(`page (${o.target_path ?? "none"} vs ${t.service?.page_url ?? "none"})`);
  }
  if (mismatch.length) {
    out.push({ code: "target_mismatch", message: `The Drafter's own target differs from the Authority opportunity: ${mismatch.join(", ")}.` });
  }
  const allowed = new Set(brief.allowed_facts.claims.map((c) => c.id));
  const outside = (o.opportunity?.evidence_claim_ids ?? []).filter((id) => !allowed.has(id));
  if (outside.length) {
    const why = outside.map((id) => {
      const x = brief.excluded.claims.find((c) => c.id === id);
      return x ? `"${x.text}" (${x.reason})` : `${id} (not a claim this brief knows)`;
    });
    out.push({ code: "evidence_ineligible", message: `Authority's evidence includes claims the Drafter does not allow: ${why.join("; ")}.` });
  }
  return out;
}

// The brief plus its Authority section. Preferred claims are the analysis's
// evidence, all of which briefConflicts has checked the brief allows; they
// become the brief's recommended claims.
export function withAuthority(brief: Brief, s: AuthorityState, now: Date): AuthorityBrief {
  const o = s.opportunity!;
  const preferred = [...(o.opportunity?.evidence_claim_ids ?? [])];
  const cutoff = now.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000;
  const recent = s.recent_posts
    .filter((p) => new Date(p.created_at).getTime() >= cutoff)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, created_at: p.created_at, review_status: p.review_status, opening: p.copy.trim().slice(0, DUPLICATE_LEAD_CHARS) }));
  return {
    ...brief,
    allowed_facts: {
      ...brief.allowed_facts,
      recommended_claim_ids: preferred.length ? preferred.slice(0, brief.allowed_facts.max_claims) : brief.allowed_facts.recommended_claim_ids,
    },
    authority: {
      opportunity_id: o.id,
      key: o.key,
      run_id: o.last_seen_run_id,
      engine_version: s.latest_run?.engine_version ?? null,
      topic: o.topic,
      tier: o.tier,
      objective: o.opportunity?.objective ?? null,
      gap: o.opportunity?.gap ?? null,
      reasons: (o.opportunity?.reasons ?? []).map((r) => r.text ?? "").filter(Boolean),
      target: { keyword: o.opportunity?.target?.keyword ?? null, intent: o.intent ?? "", owner_path: o.target_path, cta: o.opportunity?.target?.cta ?? null },
      preferred_claim_ids: preferred,
      cadence: { days: CADENCE_DAYS, eligible_from: o.eligible_from },
      recent_posts: recent,
    },
  };
}

// ── duplicate_recent_post (deterministic) ────────────────────────────────────
// A draft that repeats a recent Business Profile post of this client: the
// same opening, or half of its five-word sequences found in the other post.
function shingles(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + DUPLICATE_SHINGLE <= w.length; i++) out.add(w.slice(i, i + DUPLICATE_SHINGLE).join(" "));
  return out;
}
const lead = (text: string) => words(text.trim().slice(0, DUPLICATE_LEAD_CHARS)).join(" ");

export function duplicateProblems(copy: string, recent: AuthoritySection["recent_posts"], posts: RecentPost[]): LintProblem[] {
  const mine = shingles(copy);
  const out: LintProblem[] = [];
  for (const r of recent) {
    const p = posts.find((x) => x.id === r.id);
    if (!p) continue;
    const theirs = shingles(p.copy);
    const shared = [...mine].filter((g) => theirs.has(g)).length;
    const overlap = mine.size && theirs.size ? shared / Math.min(mine.size, theirs.size) : 0;
    const sameLead = lead(copy) !== "" && lead(copy) === lead(p.copy);
    if (sameLead || overlap >= DUPLICATE_OVERLAP) {
      out.push({
        code: "duplicate_recent_post",
        message: `This repeats the Business Profile post of ${day(p.created_at)} (${sameLead ? "same opening" : `${Math.round(overlap * 100)}% of its phrasing`}); write something new.`,
        match: p.id,
      });
    }
  }
  return out;
}
