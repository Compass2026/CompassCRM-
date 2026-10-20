// Keyword-to-results report: pure calculations over stored provider records.
// Nothing here calls a provider. Missing data stays missing; it never becomes
// zero, and a third-party page matched by business name is never counted as
// the website's organic rank.
import { reportingHost } from "./integration-health.ts";

export const RANK_STALE_DAYS = 14;
const DAY = 86400000;

export type ReportKeyword = {
  id: string; keyword: string; city: string | null; intent: string | null; priority: string | null;
  is_money: boolean | null; target_url: string | null; service: string | null; segment: string | null;
};
export type RankObservation = {
  keyword_id: string; location_id: string | null; result_type: "organic" | "map_pack";
  position: number | null; url_ranked: string | null; recorded_at: string; run_id: string | null;
};
export type RankRun = { id: string; status: string; started_at: string; completed_at: string | null; checks_count: number | null; error: string | null };

// ranked: the client's own website, position verified by host.
// not_found: checked, and neither the site nor its name was in the top 100.
// third_party: a directory, social or review page matched by business name;
// the website's own position for that check is unknown.
export type OrganicState = "ranked" | "not_found" | "third_party";
export type KeywordStatus = "current" | "stale" | "pending" | "not_checked";

const time = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function sameSite(url: string | null | undefined, siteHost: string | null) {
  const h = reportingHost(url);
  return !!h && !!siteHost && (h === siteHost || h.endsWith(`.${siteHost}`));
}
export function organicState(o: Pick<RankObservation, "position" | "url_ranked">, siteHost: string | null): OrganicState {
  if (o.position === null) return "not_found";
  return sameSite(o.url_ranked, siteHost) ? "ranked" : "third_party";
}
// Path comparison only; the host is already verified.
export function samePage(a: string | null, b: string | null) {
  const path = (u: string | null) => {
    if (!u) return null;
    try { return new URL(u).pathname.replace(/\/+$/, "") || "/"; } catch { return null; }
  };
  const pa = path(a), pb = path(b);
  return pa !== null && pb !== null && pa === pb;
}

export type Movement =
  | { kind: "up" | "down" | "same"; change: number; label: string }
  | { kind: "entered" | "dropped" | "absent_both" | "not_comparable" | "awaiting"; change: null; label: string };

export function organicMovement(base: { state: OrganicState; position: number | null; location_id: string | null; recorded_at: string } | null,
  latest: { state: OrganicState; position: number | null; location_id: string | null; recorded_at: string } | null): Movement {
  if (!base || !latest || base.recorded_at === latest.recorded_at) return { kind: "awaiting", change: null, label: "Awaiting a second check" };
  if (base.location_id !== latest.location_id) return { kind: "not_comparable", change: null, label: "Not comparable: checked from a different location" };
  if (base.state === "third_party" || latest.state === "third_party") return { kind: "not_comparable", change: null, label: "Not comparable: a third-party page was matched" };
  if (base.state === "not_found" && latest.state === "not_found") return { kind: "absent_both", change: null, label: "Not in the top 100 at either check" };
  if (base.state === "not_found") return { kind: "entered", change: null, label: `Entered the top 100 at #${latest.position}` };
  if (latest.state === "not_found") return { kind: "dropped", change: null, label: "Dropped out of the top 100" };
  const change = base.position! - latest.position!;
  return change > 0 ? { kind: "up", change, label: `Up ${change}` } : change < 0 ? { kind: "down", change, label: `Down ${-change}` } : { kind: "same", change: 0, label: "No change" };
}

export type KeywordRow = ReportKeyword & {
  location_id: string | null;
  baseline: (RankObservation & { state: OrganicState }) | null;
  latest: (RankObservation & { state: OrganicState }) | null;
  movement: Movement;
  status: KeywordStatus;
  pageMismatch: boolean;
  mapPack: { baseline: RankObservation | null; latest: RankObservation | null };
};

export type RunSummary = {
  run: RankRun; keywords: number; verified: number; thirdParty: number; notFound: number;
  top3: number; top10: number; top20: number;
};

// A run belongs to the DataForSEO organic tracker if it produced its
// observations or names the provider in its outcome (failed runs write none).
export function trackerRuns(runs: RankRun[], observations: RankObservation[]) {
  const withRows = new Set(observations.map(o => o.run_id).filter(Boolean));
  return runs.filter(r => withRows.has(r.id) || /^dataforseo\b/.test(r.error ?? "")).toSorted((a, b) => time(a.started_at) - time(b.started_at));
}

export function keywordReport(input: { keywords: ReportKeyword[]; observations: RankObservation[]; runs: RankRun[]; siteHost: string | null; now: string }) {
  const { keywords, siteHost } = input;
  const now = time(input.now);
  const ids = new Set(keywords.map(k => k.id));
  // Exactly one observation per keyword/location/type/time. A duplicate is a
  // data defect to surface, never two votes.
  const seen = new Set<string>(); let duplicates = 0;
  const observations = input.observations.filter(o => {
    if (!ids.has(o.keyword_id) || !Number.isFinite(time(o.recorded_at)) || time(o.recorded_at) > now) return false;
    const key = `${o.keyword_id}/${o.location_id}/${o.result_type}/${time(o.recorded_at)}`;
    if (seen.has(key)) { duplicates++; return false; }
    seen.add(key); return true;
  }).toSorted((a, b) => time(a.recorded_at) - time(b.recorded_at));
  const runs = trackerRuns(input.runs, observations);
  const complete = runs.filter(r => r.status === "complete");
  const running = runs.filter(r => r.status === "running");
  const latestRun = complete.at(-1) ?? null;

  const rows: KeywordRow[] = keywords.map(k => {
    const organic = observations.filter(o => o.keyword_id === k.id && o.result_type === "organic").map(o => ({ ...o, state: organicState(o, siteHost) }));
    const latest = organic.at(-1) ?? null;
    // The baseline is the first observation from the same location as the latest.
    const baseline = latest ? organic.find(o => o.location_id === latest.location_id)! : null;
    const pack = observations.filter(o => o.keyword_id === k.id && o.result_type === "map_pack" && (!latest || o.location_id === latest.location_id));
    const status: KeywordStatus = !latest ? (running.length ? "pending" : "not_checked")
      : now - time(latest.recorded_at) > RANK_STALE_DAYS * DAY ? "stale"
      : latestRun && latest.run_id && latest.run_id !== latestRun.id && time(latest.recorded_at) < time(latestRun.started_at) ? "stale" : "current";
    return {
      ...k, location_id: latest?.location_id ?? null, baseline, latest,
      movement: organicMovement(baseline, latest), status,
      pageMismatch: latest?.state === "ranked" && !!k.target_url && !samePage(latest.url_ranked, k.target_url),
      mapPack: { baseline: pack[0] ?? null, latest: pack.at(-1) ?? null },
    };
  });

  const perRun: RunSummary[] = complete.map(run => {
    const obs = observations.filter(o => o.run_id === run.id && o.result_type === "organic");
    const ranked = obs.filter(o => organicState(o, siteHost) === "ranked");
    return {
      run, keywords: new Set(obs.map(o => o.keyword_id)).size,
      verified: obs.filter(o => organicState(o, siteHost) !== "third_party").length,
      thirdParty: obs.filter(o => organicState(o, siteHost) === "third_party").length,
      notFound: obs.filter(o => o.position === null).length,
      top3: ranked.filter(o => o.position! <= 3).length,
      top10: ranked.filter(o => o.position! <= 10).length,
      top20: ranked.filter(o => o.position! <= 20).length,
    };
  });

  // Stable cohort: keywords verified (ranked or not found) in BOTH the first
  // and the latest complete run, from the same location. Anything else is
  // disclosed as excluded rather than silently changing the denominator.
  const first = complete[0] ?? null;
  const cohort = { baselineRun: first, latestRun, size: 0, improved: 0, declined: 0, unchanged: 0, entered: 0, dropped: 0, absentBoth: 0, excludedThirdParty: 0, excludedMissing: 0, top10Before: 0, top10After: 0, top3Before: 0, top3After: 0 };
  if (first && latestRun && first.id !== latestRun.id) {
    for (const k of keywords) {
      const a = observations.find(o => o.run_id === first.id && o.keyword_id === k.id && o.result_type === "organic");
      const b = observations.find(o => o.run_id === latestRun.id && o.keyword_id === k.id && o.result_type === "organic");
      if (!a || !b || a.location_id !== b.location_id) { cohort.excludedMissing++; continue; }
      const sa = organicState(a, siteHost), sb = organicState(b, siteHost);
      if (sa === "third_party" || sb === "third_party") { cohort.excludedThirdParty++; continue; }
      cohort.size++;
      if (sa === "ranked" && a.position! <= 10) cohort.top10Before++;
      if (sb === "ranked" && b.position! <= 10) cohort.top10After++;
      if (sa === "ranked" && a.position! <= 3) cohort.top3Before++;
      if (sb === "ranked" && b.position! <= 3) cohort.top3After++;
      const m = organicMovement({ ...a, state: sa }, { ...b, state: sb });
      if (m.kind === "up") cohort.improved++; else if (m.kind === "down") cohort.declined++; else if (m.kind === "same") cohort.unchanged++;
      else if (m.kind === "entered") cohort.entered++; else if (m.kind === "dropped") cohort.dropped++; else if (m.kind === "absent_both") cohort.absentBoth++;
    }
  }
  const failed = runs.filter(r => r.status === "failed");
  return {
    rows, perRun, cohort, duplicates,
    tracked: keywords.length,
    lastSuccess: latestRun,
    lastFailure: failed.at(-1) ?? null,
    running: running.at(-1) ?? null,
    statusCounts: {
      current: rows.filter(r => r.status === "current").length, stale: rows.filter(r => r.status === "stale").length,
      pending: rows.filter(r => r.status === "pending").length, notChecked: rows.filter(r => r.status === "not_checked").length,
    },
  };
}

// Next scheduled UTC slot for a weekly pg_cron job ("m h * * dow").
export function nextWeekly(dow: number, hourUtc: number, now: string) {
  const t = new Date(now);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hourUtc));
  d.setUTCDate(d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= t.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

// Monthly series from import receipts: the newest receipt per period wins,
// and a period is "complete" only when the provider said so (or it ends on
// the month's last day for sources that import complete months only).
export type MonthlyPoint = { period: string; period_end: string; created_at: string; values: Record<string, number>; complete: boolean };
export function latestPerPeriod<T extends { period: string; period_end: string; created_at: string }>(rows: T[]) {
  const by = new Map<string, T>();
  for (const r of rows) {
    const cur = by.get(r.period);
    if (!cur || r.period_end > cur.period_end || (r.period_end === cur.period_end && r.created_at > cur.created_at)) by.set(r.period, r);
  }
  return [...by.values()].toSorted((a, b) => a.period.localeCompare(b.period));
}
export function monthEnd(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function compareMonths(points: MonthlyPoint[], key: string) {
  const complete = points.filter(p => p.complete && Number.isFinite(p.values[key]));
  const latest = complete.at(-1) ?? null, previous = complete.at(-2) ?? null, first = complete[0] ?? null;
  const delta = (a: MonthlyPoint | null, b: MonthlyPoint | null) => a && b && a !== b ? a.values[key] - b.values[key] : null;
  return { first, previous, latest, vsPrevious: delta(latest, previous), vsFirst: delta(latest, first) };
}

export type GbpImport = { period: string; period_end: string; created_at: string; data: unknown };
const GBP_KEYS = {
  calls: ["CALL_CLICKS"], website: ["WEBSITE_CLICKS"], directions: ["BUSINESS_DIRECTION_REQUESTS"],
  views: ["BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH"],
} as const;
// A metric with no daily series is absent, not zero.
export function gbpTotals(data: unknown): Record<string, number> {
  const daily = (data && typeof data === "object" ? (data as { daily?: Record<string, { value: number }[]> }).daily : null) ?? {};
  const out: Record<string, number> = {};
  for (const [name, keys] of Object.entries(GBP_KEYS)) {
    const series = keys.map(k => daily[k]).filter(Array.isArray);
    if (series.length === keys.length) out[name] = series.flat().reduce((s, d) => s + (Number(d?.value) || 0), 0);
  }
  return out;
}

export type InquiryRow = { submitted_at: string; service_type: string | null; page_url: string | null; source: string | null };
export function inquirySummary(rows: InquiryRow[], timeZone = "America/Chicago") {
  const month = (s: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(new Date(s));
  const count = (key: (r: InquiryRow) => string) => [...rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map<string, number>())].toSorted((a, b) => b[1] - a[1]);
  const page = (u: string | null) => { try { return u ? new URL(u).pathname : "Page not recorded"; } catch { return "Page not recorded"; } };
  return {
    total: rows.length,
    first: rows.map(r => r.submitted_at).sort()[0] ?? null,
    latest: rows.map(r => r.submitted_at).sort().at(-1) ?? null,
    byMonth: count(r => month(r.submitted_at)).toSorted((a, b) => a[0].localeCompare(b[0])),
    byPage: count(r => page(r.page_url)),
    byForm: count(r => r.service_type || "Form not named"),
  };
}

type Receipt = { period: string; period_end: string; created_at: string; data: unknown };
const values = (data: unknown) => {
  const v = data && typeof data === "object" ? (data as { values?: Record<string, unknown> }).values : null;
  return Object.fromEntries(Object.entries(v ?? {}).filter(([, n]) => typeof n === "number" && Number.isFinite(n))) as Record<string, number>;
};
// Search Console imports complete months only.
export const gscMonths = (rows: Receipt[]): MonthlyPoint[] =>
  latestPerPeriod(rows).map(r => ({ ...r, values: values(r.data), complete: r.period_end === monthEnd(r.period) }));
// Analytics writes a month-to-date receipt daily; only the provider's own
// "complete_month" coverage counts as a full month.
export const ga4Months = (rows: Receipt[]): MonthlyPoint[] =>
  latestPerPeriod(rows).map(r => ({ ...r, values: values(r.data), complete: (r.data as { coverage?: string } | null)?.coverage === "complete_month" }));
export const gbpMonths = (rows: GbpImport[]): MonthlyPoint[] =>
  latestPerPeriod(rows).map(r => ({ ...r, values: gbpTotals(r.data), complete: r.period_end === monthEnd(r.period) }));
