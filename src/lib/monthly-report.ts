// Monthly client report: one calendar month (America/Chicago), frozen into a
// snapshot that is stored as a version and never recomputed. Pure functions
// over stored records only; nothing here calls a provider. Missing data stays
// missing, a rolling window is never called a month, and nothing claims a
// cause.
import {
  RANK_STALE_DAYS, baselineRun, inquirySummary, organicState, scanComparability, trackerHealth, trackerRuns,
  type Attempt, type InquiryRow, type OrganicState, type RankObservation, type RankRun, type ReportKeyword, type ReportScope, type ScanConfig,
} from "./keyword-report.ts";
import { gridMetrics, type GridCheck } from "../../supabase/functions/_shared/map-grid.ts";
import { GSC_PROPERTY_SOURCE } from "./search-totals.ts";

export const CALCULATION_VERSION = "monthly-report-v1";
export const REPORT_TZ = "America/Chicago";
// A rank observation stands for a month end only if it is at most this old.
export const RANK_FRESH_DAYS = RANK_STALE_DAYS;
// Tom's operating standard per business (delivery_standards v1). Shown for
// reference when a client has not adopted a recorded standard.
export const REFERENCE_STANDARD = { version: 1, blog_posts: 8, facebook_posts: 8, gbp_posts: 8, page_refreshes: 1 } as const;
export type Deliverable = "blog_posts" | "facebook_posts" | "gbp_posts" | "page_refreshes";
export const DELIVERABLES: Deliverable[] = ["blog_posts", "facebook_posts", "gbp_posts", "page_refreshes"];
const DAY = 86400000;
const time = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

// ── Calendar month in America/Chicago ───────────────────────────────────────
// Local midnight converted to an instant with the offset in force at that
// instant, so a month that crosses a DST change keeps its true length.
function offsetMinutes(utcMs: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
function zonedMonthStart(year: number, month: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, 1);
  const first = guess - offsetMinutes(guess, timeZone) * 60000;
  return guess - offsetMinutes(first, timeZone) * 60000;
}
export function localDate(iso: string, timeZone = REPORT_TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
export function monthOfPeriod(period: string) {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(period);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error(`Not a month: ${period}`);
  const y = +m[1], mo = +m[2];
  const prev = mo === 1 ? [y - 1, 12] : [y, mo - 1];
  const next = mo === 12 ? [y + 1, 1] : [y, mo + 1];
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    period: `${y}-${pad(mo)}-01`,
    previous: `${prev[0]}-${pad(prev[1])}-01`,
    start: new Date(zonedMonthStart(y, mo, REPORT_TZ)).toISOString(),
    end: new Date(zonedMonthStart(next[0], next[1], REPORT_TZ)).toISOString(),
    label: new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    lastDay: new Date(Date.UTC(next[0], next[1] - 1, 0)).toISOString().slice(0, 10),
  };
}
// The Chicago month containing `now`, and the months before it.
export function reportPeriods(now: string, count = 6) {
  const [y, m] = localDate(now).split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  });
}
// Data as of: the month's end, or now while the month is still running.
export function reportCutoff(period: string, now: string) {
  const { start, end } = monthOfPeriod(period);
  const t = Math.min(time(end), Math.floor(time(now) / 1000) * 1000);
  if (t <= time(start)) throw new Error("The month has not started");
  return new Date(t).toISOString();
}

// The month's records: [start, end) once the month is over; [start, cutoff]
// while it is running. Dates (no time) end on the last day in either case.
function window(month: ReturnType<typeof monthOfPeriod>, cutoff: string) {
  const partial = time(cutoff) < time(month.end);
  return {
    partial,
    has: (iso: string) => time(iso) >= time(month.start) && (partial ? time(iso) <= time(cutoff) : time(iso) < time(month.end)),
    hasDate: (d: string) => d >= month.period && d <= (partial ? localDate(cutoff) : month.lastDay),
    // Exclusive upper bound for "before the end of the data".
    before: partial ? time(cutoff) + 1 : time(month.end),
  };
}

// ── Inputs ─────────────────────────────────────────────────────────────────
export type Measurement = {
  client_id: string; metric: string; scope: string; source: string; status: string; value: number | null;
  report_period: string | null; window_start: string; window_end: string; sequence: number; created_at: string;
};
export type ScanRunInput = { id: string; profile_id: string; started_at: string; completed_at: string | null; status: string; config: ScanConfig & { points?: unknown[]; keywords?: { id: string; keyword: string }[]; geometry?: { default_radius_miles?: number; point_count?: number; center_kind?: string; center_label?: string } | null } };
export type GridInput = {
  profile: { id: string; label: string; weekly_enabled: boolean; enabled: boolean };
  attempts: Pick<ScanRunInput, "id" | "started_at" | "completed_at" | "status">[];
  current: (ScanRunInput & { checks: Pick<GridCheck, "state" | "position">[] }) | null;
  previous: (ScanRunInput & { checks: Pick<GridCheck, "state" | "position">[] }) | null;
};
export type WorkItem = { id: string; client_id: string; title: string; url: string | null; date: string; service: string | null; segment: string | null };
export type SocialItem = WorkItem & { platform: "facebook" | "google_business" };
export type RefreshItem = { id: string; client_id: string; url: string; verified_at: string; commit: string };
export type DeliveryTargetRow = { deliverable: string; target: number; completed: number; planned: number; unverified: number; standard_version: number; unit_kind: string };
export type QuerySample = { client_id: string; query: string; clicks: number; impressions: number; period_start: string; period_end: string };
export type MonthlyReportInput = {
  client: { id: string; name: string; website_url: string | null };
  brand: { primary: string | null; tagline: string | null };
  scope: ReportScope;
  keywords: ReportKeyword[];
  observations: RankObservation[];
  runs: RankRun[];
  grids: GridInput[];
  measurements: Measurement[];
  querySample: QuerySample[];
  inquiries: (InquiryRow & { client_id: string })[];
  inquiryCapture: { sources: number; enabled: number };
  work: {
    blogs: WorkItem[]; social: SocialItem[]; refreshes: RefreshItem[];
    blogDraftsInReview: number; socialInReview: { facebook: number; gbp: number }; socialApprovedUnpublished: number; socialFailed: number;
    refreshesUnverified: number;
  };
  targets: DeliveryTargetRow[] | null;
};

// ── Rankings ───────────────────────────────────────────────────────────────
type Point = { state: OrganicState; position: number | null; recorded_at: string; location_id: string | null };
export type AnchorSummary = {
  key: "baseline" | "previous" | "current"; label: string; at: string | null; checkedOn: string[];
  tracked: number; eligible: number; ranked: number; notFound: number; thirdParty: number; missing: number;
  top3: number; top10: number; top20: number;
};
export type Comparison = {
  from: string; to: string; comparable: number; excludedThirdParty: number; excludedMissing: number; excludedLocation: number;
  improved: number; declined: number; unchanged: number; entered: number; dropped: number; absentBoth: number;
  top3: [number, number]; top10: [number, number]; top20: [number, number];
  gains: { keyword: string; from: string; to: string }[]; losses: { keyword: string; from: string; to: string }[];
} | { from: string; to: string; unavailable: string };

const rankText = (p: Point) => p.state === "ranked" ? `#${p.position}` : "Not in top 100";

// The last observation strictly before `before` and no older than the
// freshness bound, per keyword. Baseline points come from the baseline run.
function pointsAt(input: { keywords: ReportKeyword[]; observations: RankObservation[]; siteHost: string | null; type: "organic" | "map_pack" },
  pick: { before: number; freshDays: number } | { runId: string }) {
  const out = new Map<string, Point>();
  for (const k of input.keywords) {
    const own = input.observations.filter(o => o.keyword_id === k.id && o.result_type === input.type);
    const found = "runId" in pick
      ? own.find(o => o.run_id === pick.runId)
      : own.filter(o => time(o.recorded_at) < pick.before && time(o.recorded_at) >= pick.before - pick.freshDays * DAY).at(-1);
    if (!found) continue;
    const state: OrganicState = input.type === "organic" ? organicState(found, input.siteHost) : found.position === null ? "not_found" : "ranked";
    out.set(k.id, { state, position: found.position, recorded_at: found.recorded_at, location_id: found.location_id });
  }
  return out;
}
function summarize(key: AnchorSummary["key"], label: string, at: string | null, tracked: number, points: Map<string, Point>): AnchorSummary {
  const all = [...points.values()];
  const ranked = all.filter(p => p.state === "ranked");
  return {
    key, label, at, tracked,
    checkedOn: [...new Set(all.map(p => localDate(p.recorded_at)))].sort(),
    eligible: all.length, ranked: ranked.length,
    notFound: all.filter(p => p.state === "not_found").length,
    thirdParty: all.filter(p => p.state === "third_party").length,
    missing: tracked - all.length,
    top3: ranked.filter(p => p.position! <= 3).length,
    top10: ranked.filter(p => p.position! <= 10).length,
    top20: ranked.filter(p => p.position! <= 20).length,
  };
}
// Like for like: keywords verified at both anchors from the same location.
function compare(keywords: ReportKeyword[], a: Map<string, Point>, b: Map<string, Point>, from: string, to: string): Comparison {
  if (!a.size) return { from, to, unavailable: `No ${from.toLowerCase()} check within ${RANK_FRESH_DAYS} days of that date.` };
  if (!b.size) return { from, to, unavailable: `No ${to.toLowerCase()} check within ${RANK_FRESH_DAYS} days of that date.` };
  const c = { from, to, comparable: 0, excludedThirdParty: 0, excludedMissing: 0, excludedLocation: 0, improved: 0, declined: 0, unchanged: 0, entered: 0, dropped: 0, absentBoth: 0,
    top3: [0, 0] as [number, number], top10: [0, 0] as [number, number], top20: [0, 0] as [number, number],
    gains: [] as { keyword: string; from: string; to: string; d: number }[], losses: [] as { keyword: string; from: string; to: string; d: number }[] };
  for (const k of keywords) {
    const x = a.get(k.id), y = b.get(k.id);
    if (!x || !y) { c.excludedMissing++; continue; }
    if (x.location_id !== y.location_id) { c.excludedLocation++; continue; }
    if (x.state === "third_party" || y.state === "third_party") { c.excludedThirdParty++; continue; }
    c.comparable++;
    for (const [n, arr] of [[3, c.top3], [10, c.top10], [20, c.top20]] as const) {
      if (x.state === "ranked" && x.position! <= n) arr[0]++;
      if (y.state === "ranked" && y.position! <= n) arr[1]++;
    }
    if (x.state === "not_found" && y.state === "not_found") c.absentBoth++;
    else if (x.state === "not_found") { c.entered++; c.gains.push({ keyword: k.keyword, from: rankText(x), to: rankText(y), d: 101 - y.position! }); }
    else if (y.state === "not_found") { c.dropped++; c.losses.push({ keyword: k.keyword, from: rankText(x), to: rankText(y), d: 101 - x.position! }); }
    else if (y.position! < x.position!) { c.improved++; c.gains.push({ keyword: k.keyword, from: rankText(x), to: rankText(y), d: x.position! - y.position! }); }
    else if (y.position! > x.position!) { c.declined++; c.losses.push({ keyword: k.keyword, from: rankText(x), to: rankText(y), d: y.position! - x.position! }); }
    else c.unchanged++;
  }
  const top = (l: typeof c.gains) => l.toSorted((p, q) => q.d - p.d || p.keyword.localeCompare(q.keyword)).slice(0, 5).map(({ keyword, from, to }) => ({ keyword, from, to }));
  return { ...c, gains: top(c.gains), losses: top(c.losses) };
}

function rankings(input: MonthlyReportInput, month: ReturnType<typeof monthOfPeriod>, cutoff: string) {
  const w = window(month, cutoff);
  const obs = input.observations.filter(o => time(o.recorded_at) < w.before);
  const runs = trackerRuns(input.runs.filter(r => time(r.started_at) < w.before), obs);
  const base = baselineRun(runs.filter(r => r.status === "complete"));
  const prevLabel = `End of ${monthOfPeriod(month.previous).label}`;
  const curLabel = time(cutoff) < time(month.end) ? `As of ${localDate(cutoff)}` : `End of ${month.label}`;
  const build = (type: "organic" | "map_pack") => {
    const args = { keywords: input.keywords, observations: obs, siteHost: input.scope.siteHost, type };
    const baseline = base ? pointsAt(args, { runId: base.id }) : new Map<string, Point>();
    const previous = pointsAt(args, { before: time(month.start), freshDays: RANK_FRESH_DAYS });
    const current = pointsAt(args, { before: window(month, cutoff).before, freshDays: RANK_FRESH_DAYS });
    const n = input.keywords.length;
    return {
      anchors: [
        summarize("baseline", base ? `Baseline (${localDate(base.started_at)})` : "Baseline", base?.started_at ?? null, n, baseline),
        summarize("previous", prevLabel, month.start, n, previous),
        summarize("current", curLabel, cutoff, n, current),
      ],
      vsPrevious: compare(input.keywords, previous, current, prevLabel, curLabel),
      vsBaseline: base ? compare(input.keywords, baseline, current, "Baseline", curLabel) : { from: "Baseline", to: curLabel, unavailable: "No complete scheduled tracker run yet." } as Comparison,
    };
  };
  const health = trackerHealth({
    attempts: runs.map(r => ({ at: r.started_at, finishedAt: r.completed_at, outcome: r.status === "complete" ? "complete" : r.status === "running" ? "running" : obs.some(o => o.run_id === r.id) ? "partial" : "failed", detail: r.error } as Attempt)),
    configured: input.keywords.length > 0, staleDays: RANK_FRESH_DAYS, now: cutoff,
  });
  const inMonth = runs.filter(r => w.has(r.started_at));
  return {
    tracked: input.keywords.length, siteHost: input.scope.siteHost, baselineRunAt: base?.started_at ?? null,
    organic: build("organic"), mapPack: build("map_pack"),
    runsInMonth: { complete: inMonth.filter(r => r.status === "complete").length, failed: inMonth.filter(r => r.status === "failed").length, running: inMonth.filter(r => r.status === "running").length },
    health: { state: health.state, lastSuccess: health.lastSuccess?.at ?? null, lastProblem: health.lastProblem ? { at: health.lastProblem.at, detail: health.lastProblem.detail } : null },
  };
}

// ── Maps grid ──────────────────────────────────────────────────────────────
function grids(input: MonthlyReportInput, month: ReturnType<typeof monthOfPeriod>, cutoff: string) {
  const w = window(month, cutoff);
  return input.grids.map(raw => {
    // Only a scan started inside the month counts as the month's scan, and
    // only an earlier one can be its comparison.
    const current = raw.current && w.has(raw.current.started_at) ? raw.current : null;
    const g = { ...raw, current, previous: current && raw.previous && time(raw.previous.started_at) < time(current.started_at) ? raw.previous : null, attempts: raw.attempts.filter(a => w.has(a.started_at)) };
    const geometry = (r: GridInput["current"]) => r && {
      startedAt: r.started_at, completedAt: r.completed_at,
      points: Array.isArray(r.config.points) ? r.config.points.length : null,
      keywords: r.config.keywords?.length ?? null, zoom: r.config.zoom ?? null,
      radiusMiles: r.config.geometry?.default_radius_miles ?? null,
      center: r.config.geometry ? (r.config.geometry.center_kind === "market" ? r.config.geometry.center_label ?? "Market center" : "Business location") : "Not recorded",
      metrics: gridMetrics(r.checks),
    };
    const comparability = g.current && g.previous ? scanComparability({ profile_id: g.previous.profile_id, config: g.previous.config }, { profile_id: g.current.profile_id, config: g.current.config }) : null;
    return {
      profile: g.profile.label, weekly: g.profile.weekly_enabled && g.profile.enabled,
      current: geometry(g.current), previous: geometry(g.previous),
      comparable: comparability?.comparable ?? false,
      notComparable: comparability ? comparability.reasons : [g.current ? "No earlier complete scan." : "No complete scan in this month."],
      attemptsInMonth: g.attempts.length, failedInMonth: g.attempts.filter(a => a.status === "failed").length,
    };
  });
}

// ── Traffic: the measurement pipeline, one identity per source ─────────────
const newest = (rows: Measurement[]) => rows.toSorted((a, b) => b.sequence - a.sequence)[0] ?? null;
function metricSet(rows: Measurement[], metrics: string[]) {
  const out: Record<string, { value: number; window_start: string; window_end: string; recorded: string; scope: string }> = {};
  for (const m of metrics) {
    const r = newest(rows.filter(x => x.metric === m));
    if (r && r.value !== null) out[m] = { value: r.value, window_start: r.window_start, window_end: r.window_end, recorded: r.created_at, scope: r.scope };
  }
  return out;
}
function traffic(input: MonthlyReportInput, month: ReturnType<typeof monthOfPeriod>, cutoff: string) {
  const ok = input.measurements.filter(m => m.client_id === input.client.id && m.status === "measured" && m.value !== null);
  const { gscProperty, ga4Property, siteHost, gbp } = input.scope;
  const gscRows = (p: string) => !gscProperty ? [] : ok.filter(m => m.source === GSC_PROPERTY_SOURCE && m.report_period === p && m.scope.startsWith(`Search Console ${gscProperty} |`) && m.window_end === monthOfPeriod(p).lastDay);
  const lastDate = window(month, cutoff).partial ? localDate(cutoff) : month.lastDay;
  const ga4Rows = (p: string) => !ga4Property || !siteHost ? [] : ok.filter(m => m.source === "Google Analytics 4" && m.report_period === p && m.scope.startsWith(`GA4 ${ga4Property} | ${siteHost} |`) && (p !== month.period || m.window_end <= lastDate));
  const gbpRows = (p: string) => !gbp ? [] : ok.filter(m => m.source === "Google Business Profile via Zernio" && m.report_period === p && m.scope.startsWith(`Google Business Profile ${gbp.locationId} |`) && m.window_end === monthOfPeriod(p).lastDay);
  const ga4 = (p: string) => {
    const rows = ga4Rows(p);
    const complete = rows.filter(r => r.scope.endsWith("| complete_month"));
    const use = complete.length ? complete : rows.filter(r => r.scope.endsWith("| month_to_date"));
    const latestEnd = use.map(r => r.window_end).sort().at(-1);
    const values = metricSet(use.filter(r => r.window_end === latestEnd), ["website_sessions", "website_users", "website_pageviews"]);
    return { coverage: complete.length ? "complete_month" : latestEnd ? "month_to_date" : null, values };
  };
  const qs = input.querySample.filter(q => q.client_id === input.client.id && q.period_end <= lastDate);
  const qEnd = qs.map(q => q.period_end).sort().at(-1);
  const sample = qEnd ? qs.filter(q => q.period_end === qEnd) : [];
  return {
    gsc: {
      property: gscProperty, problem: input.scope.problems.gsc,
      current: metricSet(gscRows(month.period), ["search_clicks", "search_impressions"]),
      previous: metricSet(gscRows(month.previous), ["search_clicks", "search_impressions"]),
    },
    ga4: { property: ga4Property, host: siteHost, problem: input.scope.problems.ga4, current: ga4(month.period), previous: ga4(month.previous), organicSplit: null as null },
    gbp: {
      location: gbp?.locationId ?? null, problem: input.scope.problems.gbp,
      current: metricSet(gbpRows(month.period), ["gbp_views", "gbp_call_clicks", "gbp_clicks", "gbp_directions"]),
      previous: metricSet(gbpRows(month.previous), ["gbp_views", "gbp_call_clicks", "gbp_clicks", "gbp_directions"]),
    },
    querySample: {
      start: sample[0]?.period_start ?? null, end: qEnd ?? null, rows: sample.length,
      top: sample.toSorted((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.query.localeCompare(b.query)).slice(0, 5).map(q => ({ query: q.query, clicks: q.clicks, impressions: q.impressions })),
    },
  };
}

// ── Inquiries: counts only, never a contact ────────────────────────────────
function inquiries(input: MonthlyReportInput, month: ReturnType<typeof monthOfPeriod>, cutoff: string) {
  const own = input.inquiries.filter(i => i.client_id === input.client.id);
  const clean = (rows: typeof own) => rows.map(({ submitted_at, service_type, page_url, source }) => ({ submitted_at, service_type, page_url, source }));
  const w = window(month, cutoff);
  const current = clean(own.filter(i => w.has(i.submitted_at)));
  const cur = inquirySummary(current, REPORT_TZ);
  const prevMonth = monthOfPeriod(month.previous);
  const prev = own.filter(i => time(i.submitted_at) >= time(prevMonth.start) && time(i.submitted_at) < time(prevMonth.end)).length;
  return {
    total: cur.total, previousMonth: prev, captureSources: input.inquiryCapture.enabled,
    bySource: countBy(current, r => r.source || "Source not recorded"),
    byForm: cur.byForm, byPage: cur.byPage.slice(0, 5),
    latest: cur.latest,
    testClassification: "none" as const,
  };
}
function countBy<T>(rows: T[], key: (r: T) => string) {
  return [...rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map<string, number>())].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ── Work completed against the month's targets ─────────────────────────────
function work(input: MonthlyReportInput, month: ReturnType<typeof monthOfPeriod>, cutoff: string) {
  const id = input.client.id;
  const w = window(month, cutoff);
  const inMonth = w.has;
  const blogs = input.work.blogs.filter(b => b.client_id === id && w.hasDate(b.date));
  const fb = input.work.social.filter(s => s.client_id === id && s.platform === "facebook" && inMonth(s.date));
  const gbp = input.work.social.filter(s => s.client_id === id && s.platform === "google_business" && inMonth(s.date));
  const refreshes = input.work.refreshes.filter(r => r.client_id === id && inMonth(r.verified_at));
  const recorded = input.targets && input.targets.length ? input.targets : null;
  const target = (d: Deliverable) => recorded ? recorded.filter(t => t.deliverable === d).reduce((s, t) => s + t.target, 0) : REFERENCE_STANDARD[d];
  const items: Record<Deliverable, { title: string; url: string | null; date: string; segment: string | null }[]> = {
    blog_posts: blogs.map(b => ({ title: b.title, url: b.url, date: b.date, segment: b.segment })),
    facebook_posts: fb.map(s => ({ title: s.title, url: s.url, date: localDate(s.date), segment: s.segment })),
    gbp_posts: gbp.map(s => ({ title: s.title, url: s.url, date: localDate(s.date), segment: s.segment })),
    page_refreshes: refreshes.map(r => ({ title: r.url, url: r.url, date: localDate(r.verified_at), segment: null })),
  };
  const rows = DELIVERABLES.map(d => {
    const done = items[d].length;
    const t = target(d);
    const rec = recorded?.filter(x => x.deliverable === d).reduce((s, x) => s + x.completed, 0) ?? null;
    return {
      deliverable: d, target: t, completed: done, remaining: Math.max(t - done, 0),
      bySegment: countBy(items[d], i => i.segment ?? "Service not recorded"),
      items: items[d].toSorted((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)),
      // The planner's own count, when the client is on a recorded standard,
      // for reconciliation; a difference is shown, never hidden.
      plannerCompleted: rec,
    };
  });
  return {
    standard: recorded ? { recorded: true, version: recorded[0].standard_version } : { recorded: false, version: REFERENCE_STANDARD.version },
    rows,
    notCounted: {
      blogDraftsInReview: input.work.blogDraftsInReview, facebookInReview: input.work.socialInReview.facebook, gbpInReview: input.work.socialInReview.gbp,
      approvedNotPublished: input.work.socialApprovedUnpublished, failedPublishes: input.work.socialFailed, refreshesWithoutReceipt: input.work.refreshesUnverified,
    },
  };
}

// ── The snapshot ───────────────────────────────────────────────────────────
export type Observation = { text: string; evidence: string };
export type NextAction = { action: string; reason: string; owner: string };
export type Editorial = { causes?: string[]; actions?: NextAction[]; note?: string };

export function buildMonthlyReport(input: MonthlyReportInput, period: string, now: string) {
  const month = monthOfPeriod(period);
  const cutoff = reportCutoff(month.period, now);
  const partial = time(cutoff) < time(month.end);
  const rank = rankings(input, month, cutoff);
  const maps = grids(input, month, cutoff);
  const t = traffic(input, month, cutoff);
  const inq = inquiries(input, month, cutoff);
  const w = work(input, month, cutoff);

  // Exceptions: a required source with no data for this month. A partial
  // month lists what is not in yet; nothing is filled in.
  const exceptions: { source: string; problem: string }[] = [];
  const cur = rank.organic.anchors[2];
  if (!input.keywords.length) exceptions.push({ source: "Organic rankings", problem: "No tracked keywords." });
  else if (!cur.eligible) exceptions.push({ source: "Organic rankings", problem: `No check within ${RANK_FRESH_DAYS} days of ${localDate(cutoff)}.` });
  if (!maps.some(g => g.current)) exceptions.push({ source: "Maps grid", problem: "No complete scan in this month." });
  if (t.gsc.problem) exceptions.push({ source: "Search Console", problem: t.gsc.problem });
  else if (!t.gsc.current.search_clicks) exceptions.push({ source: "Search Console", problem: partial ? "Imported after the month ends (complete months only)." : "No import for this month." });
  if (t.ga4.problem) exceptions.push({ source: "Google Analytics", problem: t.ga4.problem });
  else if (t.ga4.current.coverage !== "complete_month") exceptions.push({ source: "Google Analytics", problem: t.ga4.current.coverage ? `Month to date only (through ${t.ga4.current.values.website_sessions?.window_end ?? "unknown"}).` : "No import for this month." });
  if (t.gbp.problem) exceptions.push({ source: "Business Profile", problem: t.gbp.problem });
  else if (!t.gbp.current.gbp_views) exceptions.push({ source: "Business Profile", problem: partial ? "Imported after the month ends (complete months only)." : "No import for this month." });
  if (!inq.captureSources) exceptions.push({ source: "Inquiries", problem: "No enabled website form capture." });
  if (!w.standard.recorded) exceptions.push({ source: "Delivery standard", problem: `No standard is recorded for this client; targets shown are the reference standard v${REFERENCE_STANDARD.version}.` });
  const completeness = !partial && exceptions.length === 0 ? "complete" : "incomplete";

  // Observations: what the records show, each with its evidence. No cause.
  const observations: Observation[] = [];
  const vb = rank.organic.vsBaseline;
  if ("comparable" in vb && vb.comparable) observations.push({
    text: `${vb.top10[1]} of ${vb.comparable} comparable tracked keywords rank on the website's own pages in the top 10, against ${vb.top10[0]} at the baseline check.`,
    evidence: `Organic tracker, ${rank.organic.anchors[0].checkedOn.join(", ")} vs ${cur.checkedOn.join(", ")}; ${vb.excludedThirdParty} excluded (third-party page), ${vb.excludedMissing + vb.excludedLocation} not comparable.`,
  });
  const pack = rank.mapPack.anchors[2];
  if (pack.eligible) observations.push({
    text: `The business appeared in the Google map pack for ${pack.ranked} of ${pack.eligible} tracked keywords checked, ${pack.top3} of them in the top 3.`,
    evidence: `Map pack results from the organic tracker, ${pack.checkedOn.join(", ")}.`,
  });
  if (t.gsc.current.search_clicks) observations.push({
    text: `Search Console recorded ${t.gsc.current.search_clicks.value.toLocaleString("en-US")} clicks and ${t.gsc.current.search_impressions?.value.toLocaleString("en-US") ?? "an unrecorded number of"} impressions for the website in ${month.label}.`,
    evidence: `${t.gsc.property}, ${t.gsc.current.search_clicks.window_start} to ${t.gsc.current.search_clicks.window_end}, property totals.`,
  });
  else if (t.ga4.current.values.website_sessions) observations.push({
    text: `Google Analytics recorded ${t.ga4.current.values.website_sessions.value.toLocaleString("en-US")} sessions from all channels ${t.ga4.current.coverage === "complete_month" ? `in ${month.label}` : `from ${t.ga4.current.values.website_sessions.window_start} to ${t.ga4.current.values.website_sessions.window_end}`}.`,
    evidence: `${t.ga4.property} on ${t.ga4.host}; all channels, not organic only.`,
  });
  observations.push({
    text: `${inq.total} website ${inq.total === 1 ? "inquiry was" : "inquiries were"} recorded ${partial ? `from ${localDate(month.start)} to ${localDate(cutoff)}` : `in ${month.label}`}.`,
    evidence: `Website form capture (${inq.captureSources} enabled ${inq.captureSources === 1 ? "source" : "sources"}); no test classification is stored, so every submission is counted.`,
  });
  const done = (d: Deliverable) => w.rows.find(r => r.deliverable === d)!;
  observations.push({
    text: `Published ${partial ? "so far" : "this month"}: ${done("blog_posts").completed} blog ${done("blog_posts").completed === 1 ? "post" : "posts"}, ${done("facebook_posts").completed} Facebook, ${done("gbp_posts").completed} Business Profile and ${done("page_refreshes").completed} verified page ${done("page_refreshes").completed === 1 ? "refresh" : "refreshes"}, against ${done("blog_posts").target} / ${done("facebook_posts").target} / ${done("gbp_posts").target} / ${done("page_refreshes").target}.`,
    evidence: `Published records with dates and links (Work completed); drafts, posts in review and unverified changes are not counted.`,
  });

  // Next actions, each with its reason and owner. Tom edits these.
  const actions: NextAction[] = [];
  const nc = w.notCounted;
  if (nc.blogDraftsInReview && done("blog_posts").remaining) actions.push({ action: `Review the ${nc.blogDraftsInReview} blog drafts waiting for approval.`, reason: `${done("blog_posts").completed} of ${done("blog_posts").target} blog posts are published.`, owner: "Tom" });
  if ((nc.facebookInReview || nc.gbpInReview) && (done("facebook_posts").remaining || done("gbp_posts").remaining)) actions.push({ action: `Review the ${nc.facebookInReview} Facebook and ${nc.gbpInReview} Business Profile posts in review.`, reason: `${done("facebook_posts").completed} of ${done("facebook_posts").target} Facebook and ${done("gbp_posts").completed} of ${done("gbp_posts").target} Business Profile posts are published.`, owner: "Tom" });
  if (done("page_refreshes").remaining) actions.push({ action: nc.refreshesWithoutReceipt ? `Verify the ${nc.refreshesWithoutReceipt} approved page ${nc.refreshesWithoutReceipt === 1 ? "rewrite" : "rewrites"} with no live receipt, or plan this month's refresh.` : "Plan and publish this month's page refresh.", reason: "A refresh counts only once its live page is verified.", owner: "Claude" });
  if (!w.standard.recorded) actions.push({ action: "Record this client's delivery standard.", reason: "Targets are shown from the reference standard, not a recorded commitment.", owner: "Tom" });
  if ("unavailable" in rank.organic.vsPrevious) actions.push({ action: "Keep the weekly organic check running through month end.", reason: `Last month cannot be compared: ${rank.organic.vsPrevious.unavailable}`, owner: "Claude" });
  actions.push({ action: "Record which inquiries are tests.", reason: "No test classification is stored, so every submission is counted.", owner: "Tom" });

  const health = [
    { source: "Organic rankings", identity: input.scope.siteHost ?? "Website not resolved", latest: rank.health.lastSuccess, state: rank.health.state, note: rank.health.lastProblem ? `Last problem ${localDate(rank.health.lastProblem.at)}: ${rank.health.lastProblem.detail ?? "failed"}` : "" },
    ...maps.map(g => ({ source: `Maps grid — ${g.profile}`, identity: g.current ? `${g.current.points ?? "?"} points, zoom ${g.current.zoom ?? "?"}` : "No scan this month", latest: g.current?.completedAt ?? null, state: g.current ? "current" : "missing", note: g.failedInMonth ? `${g.failedInMonth} failed this month` : "" })),
    { source: "Search Console", identity: t.gsc.property ?? "Not recorded", latest: t.gsc.current.search_clicks?.recorded ?? t.gsc.previous.search_clicks?.recorded ?? null, state: t.gsc.current.search_clicks ? "current" : t.gsc.property ? "pending" : "unconfigured", note: "Complete calendar months, imported after month end." },
    { source: "Google Analytics", identity: t.ga4.property ? `${t.ga4.property} on ${t.ga4.host}` : "Not recorded", latest: t.ga4.current.values.website_sessions?.recorded ?? null, state: t.ga4.current.coverage === "complete_month" ? "current" : t.ga4.current.coverage ? "partial" : t.ga4.property ? "missing" : "unconfigured", note: "All channels; an organic split is not imported." },
    { source: "Business Profile", identity: t.gbp.location ?? "Not connected", latest: t.gbp.current.gbp_views?.recorded ?? t.gbp.previous.gbp_views?.recorded ?? null, state: t.gbp.current.gbp_views ? "current" : t.gbp.location ? "pending" : "unconfigured", note: "Complete calendar months, imported after month end." },
    { source: "Website inquiries", identity: `${inq.captureSources} enabled form ${inq.captureSources === 1 ? "source" : "sources"}`, latest: inq.latest, state: inq.captureSources ? "current" : "unconfigured", note: "Counts only; no contact details; no test classification." },
  ];

  const definitions = [
    `Month: ${month.label} in America/Chicago, ${localDate(month.start)} 00:00 to ${month.lastDay} 24:00 (half-open, DST-aware).`,
    `Organic rank: the client's own website (${input.scope.siteHost ?? "unresolved"}) in Google's top 100, desktop. A directory, social or review page matched by business name is excluded, never counted as the website.`,
    `Month-end rank: each keyword's last check before the month ends, if no older than ${RANK_FRESH_DAYS} days. Older checks are not used.`,
    "Comparable cohort: keywords verified (ranked or not in top 100) at both dates from the same location. The tracked list is today's; keywords without a check at a date are counted as not comparable.",
    "Map pack: the business in Google's local pack on the same tracker checks. The Maps grid is a separate scan and is compared only when every scan setting matches.",
    "Search Console: property totals for complete calendar months. The query sample is a rolling window of top queries and does not add up to the totals.",
    "Google Analytics: sessions from all channels on the website's host; an organic-only figure is not available.",
    "Inquiries: website form submissions received, counted without contact details. Sources are the recorded form source; nothing is attributed to a keyword or revenue.",
    "Work completed: published blog posts, published Facebook and Business Profile posts and verified page refreshes, dated in the month. Drafts, posts in review and failed sends are not counted.",
  ];

  return {
    schema: 1,
    calculation_version: CALCULATION_VERSION,
    client_id: input.client.id,
    brand_workspace_id: null as string | null,
    period: month.period,
    cutoff,
    period_start: month.start,
    period_end: month.end,
    partial,
    completeness,
    exceptions,
    report: {
      client: { name: input.client.name, website: input.client.website_url },
      brand: input.brand,
      period_label: month.label,
      observations: observations.slice(0, 5),
      rankings: rank,
      maps,
      traffic: t,
      inquiries: inq,
      work: w,
      health,
      definitions,
    },
    audit: {
      keywordIds: input.keywords.map(k => k.id),
      rankObservations: input.observations.length,
      rankRunsUsed: rank.organic.anchors.map(a => ({ key: a.key, at: a.at, checkedOn: a.checkedOn })),
      gridRuns: maps.map((g, i) => ({ profile: input.grids[i].profile.id, current: g.current ? input.grids[i].current?.id ?? null : null, previous: g.previous ? input.grids[i].previous?.id ?? null : null })),
      measurementIds: input.measurements.filter(m => m.client_id === input.client.id && (m.report_period === month.period || m.report_period === month.previous)).map(m => `${m.source}|${m.metric}|${m.sequence}`),
      foreignRowsDropped: input.measurements.filter(m => m.client_id !== input.client.id).length + input.inquiries.filter(i => i.client_id !== input.client.id).length
        + input.work.blogs.filter(b => b.client_id !== input.client.id).length + input.work.social.filter(s => s.client_id !== input.client.id).length
        + input.work.refreshes.filter(r => r.client_id !== input.client.id).length + input.querySample.filter(q => q.client_id !== input.client.id).length,
    },
    defaultEditorial: { causes: [], actions: actions.slice(0, 3), note: "" } as Editorial,
  };
}
export type MonthlyReportSnapshot = Omit<ReturnType<typeof buildMonthlyReport>, "defaultEditorial">;
