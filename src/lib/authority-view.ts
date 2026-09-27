// The Authority tab's view model (read-only): turns what the database already
// holds (authority_latest, authority_runs, authority_opportunity_state and
// the latest completed run's stored report) into a work queue. Pure: no
// database, no network, no Authority reasoning. The engine decided every
// section, tier, gate and order; this only groups, labels and collapses.
import type { Opportunity, Reason, Section, Tag } from "../../supabase/functions/authority/types.ts";
import { AGENCY_TIME_ZONE } from "./tasks.ts";
import { historyLine, type EffectiveStatus, type EventRow, type HistoryLine, type StoredStatus, type Workflow } from "./authority-lifecycle.ts";
import { RECORD_KEY, reconcileAction, recordProgress, type ReconcileAction, type RecordProgress } from "./authority-reconcile.ts";

export type { Opportunity };

// ── Inputs (rows as the page reads them) ────────────────────────────────────

export type LatestRow = {
  run_id: string;
  finished_at: string | null;
  judged_at: string | null;
  mode: string | null;
  engine_version: string | null;
  counts: { by_section?: Record<string, number>; by_tier?: Record<string, number> } | null;
  sources: {
    gsc?: { window: string | null; rows: number; row_cap: number; coverage: "complete" | "partial" | "unknown" };
    inventory?: { fetched_at: string | null; pages: number };
    ranks?: { recorded_at: string | null };
  } | null;
  inventory_fetched_at: string | null;
  stale_sections: string[] | null;
  inventory_stale: boolean | null;
};

export type RunRow = {
  id: string;
  created_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "degraded" | "failed";
  mode: "full" | "refresh";
  requested_via: "team" | "worker";
  requested_by: string | null;
  inventory_fetched_at: string | null;
  inventory_pages: number | null;
  inventory_errors: number | null;
  diff: Record<string, unknown> | null;
  error: string | null;
  health: { status?: string; reasons?: string[] } | null;
};

export type OpportunityState = {
  id: string;
  key: string;
  effective_status: string | null;
  present: boolean;
  first_seen_run_id: string;
  last_seen_run_id: string;
  // the stored workflow (0048); absent in older callers
  status?: StoredStatus;
  suppressed?: boolean;
  dismissed_until?: string | null;
  status_reason?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
};

export type OpportunityEvent = EventRow;

export type PillarLite = {
  service_id: string;
  name: string;
  owner: { path: string | null; state: string };
  gsc: { impressions: number; owner_impressions: number; window?: string | null };
};

export type ViewInput = {
  latest: LatestRow | null;
  runs: RunRow[];                          // newest first
  opportunities: Opportunity[];            // the latest completed run's report, in engine order
  pillars: PillarLite[];
  states: OpportunityState[];
  events: OpportunityEvent[];
  members: { id: string; name: string | null; email: string }[];
  // C2: content_posts' paths (normalised against the run's site) and how many
  // pages the record-content opportunity has recorded (its content_post links).
  recorded?: { paths: string[]; linked: number };
  now?: Date;
};

// ── Sections, labels, small helpers ─────────────────────────────────────────

export const SUMMARY_SECTIONS = ["fix_now", "ready", "needs_decision", "research", "blocked"] as const;
export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

export const SECTION_META: Record<Section, { label: string; tone: "red" | "green" | "amber" | "blue" | "slate" | "muted"; blurb: string }> = {
  fix_now: { label: "Fix Now", tone: "red", blurb: "Problems on the site or in the CRM to put right first." },
  ready: { label: "Ready for Content", tone: "green", blurb: "Content the governed facts already support." },
  needs_decision: { label: "Needs Decision", tone: "amber", blurb: "A person decides; the engine never guesses." },
  research: { label: "Research", tone: "blue", blurb: "Needs facts Client Intelligence does not hold yet." },
  blocked: { label: "Blocked", tone: "slate", blurb: "Waits on a prerequisite; what unblocks it is shown." },
  avoid: { label: "Avoid", tone: "muted", blurb: "Do not target: the writer could not honour these." },
};

// Plain-English action, from the engine's action and content type.
export function actionLabel(o: Pick<Opportunity, "action" | "content_type">): string {
  switch (o.action) {
    case "create":
      if (o.content_type === "service_page") return "Create the page";
      if (o.content_type === "location_page") return "Create the location page";
      if (o.content_type === "gbp_post") return "Draft a Business Profile post";
      if (o.content_type === "blog_post") return "Write a blog post";
      return "Create";
    case "improve":
      if (o.content_type === "data_fix") return "Fix CRM data";
      if (o.content_type === "page_improvement") return "Fix the page's wording";
      return "Improve";
    case "refresh": return "Refresh the content";
    case "consolidate": return "Merge overlapping posts";
    case "avoid": return "Don't target";
    case "insufficient_evidence": return "Needs a client-confirmed fact";
    case "research_required": return "Research needed";
    case "requires_confirmation": return "Decision needed";
    case "blocked_data_prerequisite": return "Blocked on CRM data";
  }
}

// The engine's ranking vector ends in -impressions (latest Search Console
// window); prioritize() in authority/opportunities.ts builds it. Pinned by
// tests/authority-view.test.mjs.
export const ORDER_IMPRESSIONS_INDEX = 6;
export function demandOf(o: Pick<Opportunity, "order">): number {
  const v = o.order?.[ORDER_IMPRESSIONS_INDEX];
  return typeof v === "number" && v < 0 ? -v : 0;
}

export const TAG_LABEL: Record<Tag, string> = {
  FACT: "FACT", HEURISTIC: "HEURISTIC", RESEARCH_REQUIRED: "RESEARCH REQUIRED", REQUIRES_CONFIRMATION: "REQUIRES CONFIRMATION",
};
const TAG_ORDER: Tag[] = ["FACT", "HEURISTIC", "RESEARCH_REQUIRED", "REQUIRES_CONFIRMATION"];

export function provenanceCounts(reasons: Reason[]): { tag: Tag; count: number }[] {
  const n = new Map<Tag, number>();
  for (const r of reasons) n.set(r.tag, (n.get(r.tag) ?? 0) + 1);
  return TAG_ORDER.filter((t) => n.has(t)).map((t) => ({ tag: t, count: n.get(t)! }));
}

// Formats a timestamp in Compass's time zone ("Sep 26, 3:56 AM").
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: AGENCY_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(d);
}
export function formatDate(day: string | null | undefined): string {
  if (!day) return "—";
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}
function windowLabel(w: string | null | undefined): string | null {
  const m = w?.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (!m) return w ?? null;
  const f = (s: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${s}T12:00:00Z`));
  return `${f(m[1])} – ${f(m[2])}`;
}

// ── Cards ───────────────────────────────────────────────────────────────────

export type PageStatus = { path: string; state: string | null };

export type Card = {
  key: string;
  anchor: string;                          // DOM id (the engine's readable id)
  topic: string;
  action: string;
  tier: Opportunity["tier"];
  reason: string;                          // one line: the engine's gap
  target: PageStatus | null;
  keyword: string | null;
  intent: string | null;
  location: string | null;
  demand: number;
  evidence: number;
  blocker: string | null;
  eligibleFrom: string | null;
  provenance: { tag: Tag; count: number }[];
  lifecycle: string | null;                // effective_status
  workflow: Workflow | null;               // the stored workflow, for the chip and the lifecycle menu
  reconcile: ReconcileAction | null;       // C2: the reconciliation this data fix takes
  progress: RecordProgress;                // C2: record-content while pages remain (overrides the chip)
  details: {
    objective: string | null;
    reasons: Reason[];
    gates: Opportunity["gates"];
    evidenceIds: string[];
    coverage: Opportunity["existing_coverage"];
    key: string;
    id: string;
    order: number[];
    firstSeen: string | null;
    lastSeen: string | null;
    history: (HistoryLine & { when: string })[];
    raw: Opportunity;
  };
};

function pageStatus(o: Opportunity, pillars: PillarLite[]): PageStatus | null {
  const path = o.target.owner_path;
  if (!path) return null;
  const pillar = o.service_id ? pillars.find((p) => p.service_id === o.service_id && p.owner.path === path) : undefined;
  if (pillar) return { path, state: pillar.owner.state };
  const cov = o.existing_coverage.find((c) => c.ref === path && (c.kind === "owner_page" || c.kind === "location_page"));
  if (cov) return { path, state: cov.state };
  if (o.action === "requires_confirmation" && o.reasons.some((r) => r.text.startsWith(`Live page ${path}`))) return { path, state: "live" };
  return { path, state: null };
}

type CardCtx = {
  pillars: PillarLite[]; stateByKey: Map<string, OpportunityState>; eventsById: Map<string, OpportunityEvent[]>; runsById: Map<string, RunRow>;
  members: ViewInput["members"]; recorded: ViewInput["recorded"];
};

function workflowOf(st: OpportunityState | null, members: ViewInput["members"], events: OpportunityEvent[]): Workflow | null {
  if (!st || !st.status) return null;
  const who = st.decided_by ? members.find((m) => m.id === st.decided_by) : null;
  // A suppression bound to the reviewed recommendation (0049) names it in its event.
  const lastSuppressed = [...events].reverse().find((e) => e.kind === "suppressed");
  const basis = st.suppressed ? (lastSuppressed?.detail as { basis?: { stored?: string; assessed?: string } } | undefined)?.basis : undefined;
  return {
    opportunityId: st.id, status: st.status, suppressed: !!st.suppressed, dismissed_until: st.dismissed_until ?? null,
    effective: (st.effective_status ?? st.status) as EffectiveStatus, reason: st.status_reason ?? null,
    decidedBy: who ? who.name ?? who.email : null, decidedAt: st.decided_at ?? null,
    keptIntent: basis?.stored && basis.assessed ? { stored: basis.stored, assessed: basis.assessed } : null,
  };
}

function toCard(o: Opportunity, ctx: CardCtx): Card {
  const st = ctx.stateByKey.get(o.key) ?? null;
  const seen = (id: string | null | undefined) => (id ? formatWhen(ctx.runsById.get(id)?.finished_at ?? ctx.runsById.get(id)?.created_at) : null);
  return {
    key: o.key,
    anchor: `opp-${o.id}`.replace(/[^A-Za-z0-9_:.-]/g, "-"),
    topic: o.topic,
    action: actionLabel(o),
    tier: o.tier,
    reason: o.gap,
    target: pageStatus(o, ctx.pillars),
    keyword: o.target.keyword,
    intent: o.target.intent,
    location: o.target.location,
    demand: demandOf(o),
    evidence: o.evidence_claim_ids.length,
    blocker: o.blockers[0] ?? null,
    eligibleFrom: o.eligible_from,
    provenance: provenanceCounts(o.reasons),
    lifecycle: st?.effective_status ?? null,
    workflow: workflowOf(st, ctx.members, st ? ctx.eventsById.get(st.id) ?? [] : []),
    reconcile: reconcileAction(o.key),
    progress: o.key === RECORD_KEY && ctx.recorded
      ? recordProgress({ candidates: o.candidate_paths, recorded: new Set(ctx.recorded.paths), linked: ctx.recorded.linked })
      : null,
    details: {
      objective: o.objective,
      reasons: o.reasons,
      gates: o.gates,
      evidenceIds: o.evidence_claim_ids,
      coverage: o.existing_coverage,
      key: o.key,
      id: o.id,
      order: o.order,
      firstSeen: seen(st?.first_seen_run_id),
      lastSeen: seen(st?.last_seen_run_id),
      history: (st ? ctx.eventsById.get(st.id) ?? [] : []).map((e) => ({ ...historyLine(e, ctx.members), when: formatWhen(e.created_at) })),
      raw: o,
    },
  };
}

// ── Groups (what is open by default) ────────────────────────────────────────

export type Group = { id: string; label: string; count: number; open: boolean; note?: string; link?: { anchor: string; label: string } | null; cards: Card[] };

export const RESEARCH_VISIBLE = 3;           // research items shown before "N more"
export const DECISION_OPEN_LIMIT = 3;        // a decision group this small starts open

function fixNowGroups(cards: Card[]): Group[] {
  return (["A", "B", "C"] as const)
    .map((t) => ({ id: `fix-now-tier-${t}`, label: `Tier ${t}`, open: t === "A", cards: cards.filter((c) => c.tier === t) }))
    .filter((g) => g.cards.length)
    .map((g) => ({ ...g, count: g.cards.length }));
}

function readyGroups(cards: Card[]): Group[] {
  const now = cards.filter((c) => !c.eligibleFrom);
  const waiting = cards.filter((c) => c.eligibleFrom).sort((a, b) => a.eligibleFrom!.localeCompare(b.eligibleFrom!));
  const out: Group[] = [];
  if (now.length) out.push({ id: "ready-now", label: "Ready now", count: now.length, open: true, cards: now });
  if (waiting.length) {
    out.push({
      id: "ready-waiting", label: "Waiting on cadence", count: waiting.length, open: false,
      note: `Next eligible ${formatDate(waiting[0].eligibleFrom)}`, cards: waiting,
    });
  }
  return out;
}

const DECISION_KINDS: { prefix: string; id: string; label: string }[] = [
  { prefix: "confirm_service:", id: "decide-services", label: "Services" },
  { prefix: "confirm_market:", id: "decide-markets", label: "Markets" },
  { prefix: "confirm_intent:", id: "decide-intents", label: "Intent conflicts" },
  // C3: a Home-like keyword another governed page (or rule) competes for.
  { prefix: "confirm_owner:", id: "decide-owners", label: "Ownership" },
];
function decisionGroups(cards: Card[]): Group[] {
  const used = new Set<string>();
  const groups: Group[] = DECISION_KINDS.map((k) => {
    const cs = cards.filter((c) => c.key.startsWith(k.prefix));
    cs.forEach((c) => used.add(c.key));
    return { id: k.id, label: k.label, count: cs.length, open: cs.length > 0 && cs.length <= DECISION_OPEN_LIMIT, cards: cs };
  });
  const other = cards.filter((c) => !used.has(c.key));
  if (other.length) groups.push({ id: "decide-other", label: "Other decisions", count: other.length, open: other.length <= DECISION_OPEN_LIMIT, cards: other });
  return groups.filter((g) => g.count);
}

function researchGroups(cards: Card[]): Group[] {
  const shown = cards.slice(0, RESEARCH_VISIBLE);
  const more = cards.slice(RESEARCH_VISIBLE);
  const out: Group[] = [];
  if (shown.length) out.push({ id: "research-first", label: "Research", count: shown.length, open: true, cards: shown });
  if (more.length) out.push({ id: "research-more", label: `${more.length} more`, count: more.length, open: false, cards: more });
  return out;
}

// Blocked items grouped by what unblocks them. A data prerequisite names
// the Fix Now item that resolves it ("resolve data_fix:service-page:x
// first"); that item is linked.
const PREREQ = /resolve ([a-z_]+:[A-Za-z0-9_:/.'-]+?) first/;
function blockedGroups(cards: Card[], all: Card[]): Group[] {
  const groups = new Map<string, Group>();
  for (const c of cards) {
    const m = c.blocker?.match(PREREQ);
    const prereq = m ? all.find((x) => x.details.id === m[1]) : undefined;
    const id = prereq ? `blocked-by-${prereq.details.id}` : c.blocker ? `blocked-${c.blocker}` : `blocked-${c.action}`;
    const label = prereq ? prereq.reason : c.blocker ?? (c.details.raw.action === "insufficient_evidence" ? "Needs a usable claim" : c.action);
    const g = groups.get(id) ?? {
      id: id.replace(/[^A-Za-z0-9_:.-]/g, "-"), label, count: 0, open: false, cards: [],
      link: prereq ? { anchor: prereq.anchor, label: `${prereq.topic}: ${prereq.action}` } : null,
    };
    g.cards.push(c);
    g.count = g.cards.length;
    groups.set(id, g);
  }
  return [...groups.values()];
}

// ── Header, banners, staleness ──────────────────────────────────────────────

export const STALE_SECTION_LABELS: Record<string, string> = {
  intelligence: "client facts (services, claims, brand, locations or offers)",
  page_groups: "page groups",
  keywords: "keywords",
  gsc: "a newer Search Console window",
  ranks: "new rank checks",
  posts: "posts",
  content: "content records",
  change_log: "the change log",
  site: "the site record",
};

export type Staleness = { stale: boolean; changed: string[]; inventoryOld: boolean; needs: "refresh" | "full" | null; message: string | null };

export function staleness(latest: Pick<LatestRow, "stale_sections" | "inventory_stale"> | null): Staleness {
  if (!latest) return { stale: false, changed: [], inventoryOld: false, needs: null, message: null };
  const sections = latest.stale_sections ?? [];
  const changed = sections.map((s) => STALE_SECTION_LABELS[s] ?? s);
  const inventoryOld = !!latest.inventory_stale;
  if (!sections.length && !inventoryOld) return { stale: false, changed, inventoryOld, needs: null, message: null };
  const needs = inventoryOld || sections.includes("site") ? "full" : "refresh";
  const parts: string[] = [];
  if (changed.length) parts.push(`Since this analysis: ${changed.join(", ")} changed.`);
  if (inventoryOld) parts.push("The site inventory is more than 14 days old.");
  parts.push(needs === "full"
    ? "A full analysis (a fresh site inventory) is needed to bring it up to date."
    : "A refresh (re-judging with the stored site inventory) will bring it up to date.");
  return { stale: true, changed, inventoryOld, needs, message: parts.join(" ") };
}

export type Header = {
  lastAnalyzed: string;
  mode: string;
  engine: string;
  pagesChecked: number | null;
  urlsRequested: number | null;
  gsc: { coverage: string; rows: number; window: string | null; cap: number | null } | null;
  state: "current" | "stale" | "running" | "stuck" | "attempt_problem";
};

export type Banner = { kind: "running" | "stuck" | "stale" | "degraded" | "failed"; title: string; body: string };

// A run still "running" after this long is stuck: authority_begin_run (0048)
// fails it when the next run begins, so starting a new run clears it.
export const STUCK_AFTER_MS = 15 * 60 * 1000;

export function activeRun<R extends Pick<RunRow, "id" | "mode" | "created_at" | "status">>(runs: R[], now: Date): { running: R | null; stuck: R | null } {
  const r = runs.find((x) => x.status === "running");
  if (!r) return { running: null, stuck: null };
  const age = now.getTime() - new Date(r.created_at).getTime();
  return age >= STUCK_AFTER_MS ? { running: null, stuck: r } : { running: r, stuck: null };
}

// ── Run history ─────────────────────────────────────────────────────────────

export type HistoryRow = {
  id: string;
  when: string;
  mode: string;
  status: RunRow["status"];
  by: string;
  changes: string;
  inventory: string;
  note: string | null;
  current: boolean;
};

const arr = (d: Record<string, unknown> | null, k: string) => (Array.isArray(d?.[k]) ? (d![k] as unknown[]).length : 0);

export function changesText(r: Pick<RunRow, "status" | "diff">): string {
  if (r.status === "running") return "running…";
  if (r.status === "failed") return "—";
  if (!r.diff) return "—";
  if (typeof r.diff.skipped === "string") return "unchanged (degraded)";
  const parts = [
    arr(r.diff, "added") && `+${arr(r.diff, "added")} added`,
    arr(r.diff, "resolved") && `−${arr(r.diff, "resolved")} resolved`,
    arr(r.diff, "section_changed") && `${arr(r.diff, "section_changed")} moved`,
    arr(r.diff, "regressed") && `${arr(r.diff, "regressed")} regressed`,
    arr(r.diff, "reopened") && `${arr(r.diff, "reopened")} reopened`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no change";
}

export function historyRows(runs: RunRow[], currentRunId: string | null, members: ViewInput["members"]): HistoryRow[] {
  const name = (id: string | null) => {
    const m = id ? members.find((x) => x.id === id) : null;
    return m ? m.name ?? m.email : "team";
  };
  return runs.map((r) => {
    const reasons = r.health?.reasons ?? [];
    const inv = r.status === "failed" && r.inventory_pages == null
      ? "—"
      : r.mode === "refresh"
        ? `reused from ${formatWhen(r.inventory_fetched_at)}`
        : r.inventory_pages == null
          ? "—"
          : `${r.inventory_pages} URLs · ${r.inventory_errors ?? 0} errors · ${formatWhen(r.inventory_fetched_at)}`;
    return {
      id: r.id,
      when: formatWhen(r.finished_at ?? r.created_at),
      mode: r.mode === "full" ? "Full" : "Refresh",
      status: r.status,
      by: r.requested_via === "worker" ? "worker" : name(r.requested_by),
      changes: changesText(r),
      inventory: inv,
      note: r.error ?? (r.status === "degraded" && reasons.length ? reasons.join("; ") : null),
      current: r.id === currentRunId,
    };
  });
}

// ── The whole view ──────────────────────────────────────────────────────────

export type AuthorityView = {
  empty: boolean;
  header: Header | null;
  banners: Banner[];
  staleness: Staleness;
  summary: { section: SummarySection; label: string; tone: string; count: number }[];
  sections: { section: Section; label: string; tone: string; blurb: string; count: number; groups: Group[] }[];
  history: HistoryRow[];
  dismissed: Group | null;                 // dismissed and never-recommend items, out of their sections
};

export function buildAuthorityView(input: ViewInput): AuthorityView {
  const { latest, runs } = input;
  const { running, stuck } = activeRun(runs, input.now ?? new Date());
  const currentRun = latest ? runs.find((r) => r.id === latest.run_id) ?? null : null;
  // The newest attempt that did not become the current result.
  const latestFinished = runs.find((r) => r.status !== "running") ?? null;
  const problem = latestFinished && latestFinished.id !== latest?.run_id && (latestFinished.status === "degraded" || latestFinished.status === "failed")
    && (!currentRun || latestFinished.created_at > currentRun.created_at) ? latestFinished : null;

  const st = staleness(latest);
  const banners: Banner[] = [];
  if (running) {
    banners.push({ kind: "running", title: "Analysis running", body: `A ${running.mode} analysis started ${formatWhen(running.created_at)}. This page updates when it finishes; results below are from the last completed run.` });
  }
  if (stuck) {
    banners.push({ kind: "stuck", title: "An analysis appears stuck", body: `A ${stuck.mode} analysis started ${formatWhen(stuck.created_at)} and never finished. Starting a new analysis marks it failed and runs again.` });
  }
  if (problem) {
    const why = problem.status === "failed" ? problem.error ?? "no reason recorded" : (problem.health?.reasons ?? []).join("; ") || "no reason recorded";
    banners.push({
      kind: problem.status === "failed" ? "failed" : "degraded",
      title: `The latest attempt ${problem.status === "failed" ? "failed" : "was degraded"}`,
      body: `${formatWhen(problem.finished_at ?? problem.created_at)}: ${why}. ${latest ? `Showing results from ${formatWhen(latest.finished_at)}; a ${problem.status} run changes no opportunity.` : "No completed analysis yet."}`,
    });
  }
  if (latest && st.stale) banners.push({ kind: "stale", title: "Results may be out of date", body: st.message! });

  const history = historyRows(runs, latest?.run_id ?? null, input.members);
  if (!latest) {
    return { empty: true, header: null, banners, staleness: st, summary: [], sections: [], history, dismissed: null };
  }

  const stateByKey = new Map(input.states.map((s) => [s.key, s]));
  const eventsById = new Map<string, OpportunityEvent[]>();
  for (const e of input.events) eventsById.set(e.opportunity_id, [...(eventsById.get(e.opportunity_id) ?? []), e]);
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const ctx = { pillars: input.pillars, stateByKey, eventsById, runsById, members: input.members, recorded: input.recorded };
  const everything = input.opportunities.map((o) => ({ o, c: toCard(o, ctx) }));
  // A dismissed item (dated or never-recommend) leaves its section for the
  // collapsed Dismissed group; a dismissal whose date has passed reads open again.
  const isDismissed = (c: Card) => c.lifecycle === "dismissed";
  const cards = everything.filter((x) => !isDismissed(x.c));
  const dismissedCards = everything.filter((x) => isDismissed(x.c)).map((x) => x.c);
  const bySection = (s: Section) => cards.filter((x) => x.o.section === s).map((x) => x.c);
  const all = cards.map((x) => x.c);

  const sections: AuthorityView["sections"] = (["fix_now", "ready", "needs_decision", "research", "blocked", "avoid"] as Section[]).map((s) => {
    const cs = bySection(s);
    const groups = s === "fix_now" ? fixNowGroups(cs)
      : s === "ready" ? readyGroups(cs)
      : s === "needs_decision" ? decisionGroups(cs)
      : s === "research" ? researchGroups(cs)
      : s === "blocked" ? blockedGroups(cs, all)
      : cs.length ? [{ id: "avoid-all", label: "Avoid", count: cs.length, open: false, cards: cs }] : [];
    return { section: s, ...SECTION_META[s], count: cs.length, groups };
  });

  // What is still to act on: the engine's counts less what a person dismissed.
  const counts = latest.counts?.by_section ?? {};
  const summary = SUMMARY_SECTIONS.map((s) => ({
    section: s, label: SECTION_META[s].label, tone: SECTION_META[s].tone,
    count: (counts[s] ?? everything.filter((x) => x.o.section === s).length) - dismissedCards.filter((c) => c.details.raw.section === s).length,
  }));
  const dismissed: Group | null = dismissedCards.length
    ? { id: "dismissed", label: "Dismissed", count: dismissedCards.length, open: false, note: "dismissed for a while, or never recommend again", cards: dismissedCards }
    : null;

  const gsc = latest.sources?.gsc;
  const header: Header = {
    lastAnalyzed: formatWhen(latest.finished_at),
    mode: latest.mode === "refresh" ? "Refresh" : "Full",
    engine: latest.engine_version ?? "—",
    pagesChecked: latest.sources?.inventory?.pages ?? null,
    urlsRequested: currentRun?.inventory_pages ?? null,
    gsc: gsc ? { coverage: gsc.coverage, rows: gsc.rows, window: windowLabel(gsc.window), cap: gsc.coverage === "partial" ? gsc.row_cap : null } : null,
    state: running ? "running" : stuck ? "stuck" : problem ? "attempt_problem" : st.stale ? "stale" : "current",
  };

  return { empty: false, header, banners, staleness: st, summary, sections, history, dismissed };
}
