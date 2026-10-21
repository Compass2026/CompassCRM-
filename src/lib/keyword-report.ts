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
export type RankRun = { id: string; status: string; started_at: string; completed_at: string | null; checks_count: number | null; error: string | null; triggered_by?: string | null };

// ── Source identity ─────────────────────────────────────────────────────────
// Every series is read for exactly one website, Search Console property,
// Analytics property + host and Business Profile location. Anything the
// pilot cannot resolve to one of each is unavailable, never a fallback.
export type GbpBindingRow = { publish_account_id: string | null; publish_page_id: string | null; external_account_id: string | null };
export type ReportScope = {
  siteHost: string | null; gscProperty: string | null; ga4Property: string | null;
  gbp: { accountId: string; locationId: string } | null;
  problems: { site: string | null; gsc: string | null; ga4: string | null; gbp: string | null; brands: string | null };
};
export function resolveScope(input: { websiteUrl: string | null; gscProperty: string | null; ga4Property: string | null; siteUrls: (string | null)[]; brandCount: number; gbpBindings: GbpBindingRow[] }): ReportScope {
  const brands = input.brandCount > 0 ? `This client reports per brand website (${input.brandCount}). The pilot covers single-website clients only, so website, Search Console, Analytics and Business Profile figures are not shown.` : null;
  const hosts = [...new Set([input.websiteUrl, ...input.siteUrls].map(u => reportingHost(u)).filter((h): h is string => !!h))];
  const siteHost = !brands && hosts.length === 1 ? hosts[0] : null;
  const site = brands ?? (hosts.length === 0 ? "No website is recorded for this client." : hosts.length > 1 ? `The client record and site rows name ${hosts.length} different websites (${hosts.join(", ")}). Which one to report is unresolved.` : null);
  const valid = input.gbpBindings.filter(r => /^[0-9a-f]{24}$/.test(r.publish_account_id ?? "") && /^locations\/[0-9]{1,30}$/.test(r.publish_page_id ?? "") && r.publish_page_id === r.external_account_id);
  const locations = [...new Map(valid.map(r => [`${r.publish_account_id}|${r.publish_page_id}`, r])).values()];
  const gbp = !brands && locations.length === 1 ? { accountId: locations[0].publish_account_id!, locationId: locations[0].publish_page_id! } : null;
  return {
    siteHost,
    gscProperty: !brands ? input.gscProperty || null : null,
    ga4Property: !brands && siteHost ? input.ga4Property || null : null,
    gbp,
    problems: {
      site, brands,
      gsc: brands ?? (input.gscProperty ? null : "No Search Console property is recorded for this client."),
      ga4: brands ?? (!input.ga4Property ? "No Analytics property is recorded for this client." : !siteHost ? "Analytics needs one resolved website host." : null),
      gbp: brands ?? (locations.length === 0 ? "No verified Business Profile connection." : locations.length > 1 ? `${locations.length} Business Profile locations are connected; the pilot reports one.` : null),
    },
  };
}

// ── Organic rank ────────────────────────────────────────────────────────────
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
  // The keyword has no observation in the baseline run (added later).
  baselineLate: boolean;
  latest: (RankObservation & { state: OrganicState }) | null;
  movement: Movement;
  status: KeywordStatus;
  pageMismatch: boolean;
  mapPack: { baseline: RankObservation | null; latest: RankObservation | null };
};

export type RunSummary = {
  run: RankRun; beforeBaseline: boolean; keywords: number; verified: number; thirdParty: number; notFound: number;
  top3: number; top10: number; top20: number;
};

// A run belongs to the DataForSEO organic tracker if it produced its
// observations or names the provider in its outcome (failed runs write none).
export function trackerRuns(runs: RankRun[], observations: RankObservation[]) {
  const withRows = new Set(observations.map(o => o.run_id).filter(Boolean));
  return runs.filter(r => withRows.has(r.id) || /^dataforseo\b/.test(r.error ?? "")).toSorted((a, b) => time(a.started_at) - time(b.started_at));
}

// The baseline is the first complete SCHEDULED run. Request settings are not
// stored per run, so a manual run posted while the tracker was being set up
// cannot be shown to match later checks; it stays visible but is not the
// baseline. With no scheduled run, the first complete run is used.
export function baselineRun(complete: RankRun[]) {
  return complete.find(r => r.triggered_by === "cron") ?? complete[0] ?? null;
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
  const base = baselineRun(complete);
  const baseAt = base ? time(base.started_at) : -Infinity;

  const rows: KeywordRow[] = keywords.map(k => {
    const organic = observations.filter(o => o.keyword_id === k.id && o.result_type === "organic").map(o => ({ ...o, state: organicState(o, siteHost) }));
    const latest = organic.at(-1) ?? null;
    // Baseline: this keyword's observation in the baseline run, else its first
    // later one, always from the same location as the latest.
    const sameLoc = latest ? organic.filter(o => o.location_id === latest.location_id) : [];
    const baseline = sameLoc.find(o => time(o.recorded_at) >= baseAt) ?? null;
    const pack = observations.filter(o => o.keyword_id === k.id && o.result_type === "map_pack" && (!latest || o.location_id === latest.location_id) && time(o.recorded_at) >= baseAt);
    const status: KeywordStatus = !latest ? (running.length ? "pending" : "not_checked")
      : now - time(latest.recorded_at) > RANK_STALE_DAYS * DAY ? "stale"
      : latestRun && latest.run_id && latest.run_id !== latestRun.id && time(latest.recorded_at) < time(latestRun.started_at) ? "stale" : "current";
    return {
      ...k, location_id: latest?.location_id ?? null, baseline, latest,
      baselineLate: !!baseline && !!base && baseline.run_id !== base.id,
      movement: organicMovement(baseline, latest), status,
      pageMismatch: latest?.state === "ranked" && !!k.target_url && !samePage(latest.url_ranked, k.target_url),
      mapPack: { baseline: pack[0] ?? null, latest: pack.at(-1) ?? null },
    };
  });

  const perRun: RunSummary[] = complete.map(run => {
    const obs = observations.filter(o => o.run_id === run.id && o.result_type === "organic");
    const ranked = obs.filter(o => organicState(o, siteHost) === "ranked");
    return {
      run, beforeBaseline: time(run.started_at) < baseAt, keywords: new Set(obs.map(o => o.keyword_id)).size,
      verified: obs.filter(o => organicState(o, siteHost) !== "third_party").length,
      thirdParty: obs.filter(o => organicState(o, siteHost) === "third_party").length,
      notFound: obs.filter(o => o.position === null).length,
      top3: ranked.filter(o => o.position! <= 3).length,
      top10: ranked.filter(o => o.position! <= 10).length,
      top20: ranked.filter(o => o.position! <= 20).length,
    };
  });

  // Stable cohort: keywords verified (ranked or not found) in BOTH the
  // baseline and the latest complete run, from the same location record.
  // Anything else is disclosed as excluded rather than silently changing the
  // denominator.
  const cohort = { baselineRun: base, latestRun, size: 0, improved: 0, declined: 0, unchanged: 0, entered: 0, dropped: 0, absentBoth: 0, excludedThirdParty: 0, excludedMissing: 0, top10Before: 0, top10After: 0, top3Before: 0, top3After: 0 };
  if (base && latestRun && base.id !== latestRun.id) {
    for (const k of keywords) {
      const a = observations.find(o => o.run_id === base.id && o.keyword_id === k.id && o.result_type === "organic");
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
  // Attempts for source health. A failed run that still stored some
  // observations is partial, not a clean failure.
  const answered = (id: string) => observations.some(o => o.run_id === id);
  const attempts: Attempt[] = runs.map(r => ({ at: r.started_at, finishedAt: r.completed_at, outcome: r.status === "complete" ? "complete" : r.status === "running" ? "running" : answered(r.id) ? "partial" : "failed", detail: r.error }));
  return {
    rows, perRun, cohort, duplicates, attempts,
    tracked: keywords.length,
    lastSuccess: latestRun,
    lastFailure: runs.filter(r => r.status === "failed").at(-1) ?? null,
    running: running.at(-1) ?? null,
    statusCounts: {
      current: rows.filter(r => r.status === "current").length, stale: rows.filter(r => r.status === "stale").length,
      pending: rows.filter(r => r.status === "pending").length, notChecked: rows.filter(r => r.status === "not_checked").length,
    },
  };
}

// ── Source health ───────────────────────────────────────────────────────────
// One state per tracker from its attempts. A failure newer than the last
// success is "failed" even if that success is still recent; the last success
// is kept alongside as evidence. Nothing here promises a future run.
export type Attempt = { at: string; finishedAt: string | null; outcome: "complete" | "partial" | "failed" | "running"; detail: string | null };
export type TrackerState = "current" | "stale" | "failed" | "partial" | "running" | "missing" | "unconfigured";
export function trackerHealth(input: { attempts: Attempt[]; configured: boolean; staleDays: number; now: string }) {
  const sorted = input.attempts.filter(a => Number.isFinite(time(a.at)) && time(a.at) <= time(input.now)).toSorted((a, b) => time(a.at) - time(b.at));
  const lastSuccess = sorted.filter(a => a.outcome === "complete").at(-1) ?? null;
  const lastProblem = sorted.filter(a => a.outcome === "failed" || a.outcome === "partial").at(-1) ?? null;
  const latest = sorted.at(-1) ?? null;
  const state: TrackerState = !input.configured && !latest ? "unconfigured"
    : latest?.outcome === "running" ? "running"
    : latest && (latest.outcome === "failed" || latest.outcome === "partial") ? latest.outcome
    : !lastSuccess ? "missing"
    : time(input.now) - time(lastSuccess.finishedAt ?? lastSuccess.at) > input.staleDays * DAY ? "stale" : "current";
  return { state, lastSuccess, lastProblem, latest };
}

// Next slot of a weekly pg_cron schedule ("m h * * dow"), in UTC. This is the
// configured schedule, not evidence that a run will happen.
export function nextWeekly(dow: number, hourUtc: number, now: string) {
  const t = new Date(now);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hourUtc));
  d.setUTCDate(d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= t.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

// ── Maps grid ───────────────────────────────────────────────────────────────
// Two scans are comparable only when every frozen input that shapes the
// result is known and identical. Unknown is never treated as equal.
export type ScanConfig = { target_place_id?: string | null; points?: unknown; keywords?: { id: string; keyword: string }[]; zoom?: number | null; search_this_area?: boolean | null; geometry?: unknown };
export function scanComparability(a: { profile_id?: string; config: ScanConfig }, b: { profile_id?: string; config: ScanConfig }) {
  // a is the earlier scan, b the later one.
  const reasons: string[] = [];
  const known = (v: unknown) => v !== undefined && v !== null;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (a.profile_id !== undefined && b.profile_id !== undefined && a.profile_id !== b.profile_id) reasons.push("different scan profile");
  const check = (label: string, x: unknown, y: unknown) => {
    if (!known(x) || !known(y)) reasons.push(`${label} unknown for ${!known(x) && !known(y) ? "both scans" : !known(x) ? "the earlier scan" : "the later scan"}`);
    else if (!same(x, y)) reasons.push(`different ${label}`);
  };
  check("business (place id)", a.config.target_place_id, b.config.target_place_id);
  check("search mode", a.config.search_this_area, b.config.search_this_area);
  check("map zoom", a.config.zoom, b.config.zoom);
  check("grid geometry", a.config.geometry, b.config.geometry);
  check("points", a.config.points, b.config.points);
  check("keywords", a.config.keywords?.map(k => k.id), b.config.keywords?.map(k => k.id));
  return { comparable: reasons.length === 0, reasons };
}

// ── Monthly provider imports ───────────────────────────────────────────────
// Each series is filtered to its one resolved identity before months are
// chosen, so two properties, hosts or locations can never overwrite each
// other. The newest receipt per period wins. A period is "complete" only when
// the provider said so (or it ends on the month's last day for sources that
// import complete months only).
export type MonthlyPoint = { period: string; period_end: string; created_at: string; values: Record<string, number>; complete: boolean };
export function latestPerPeriod<T extends { period: string; period_end: string; created_at: string }>(rows: T[], identity: (r: T) => string = () => "") {
  const by = new Map<string, T>();
  for (const r of rows) {
    const key = `${identity(r)}|${r.period}`, cur = by.get(key);
    if (!cur || r.period_end > cur.period_end || (r.period_end === cur.period_end && r.created_at > cur.created_at)) by.set(key, r);
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

export type GbpImport = { account_id?: string | null; location_id?: string | null; period: string; period_end: string; created_at: string; data: unknown };
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

type Receipt = { property?: string | null; period: string; period_end: string; created_at: string; data: unknown };
const values = (data: unknown) => {
  const v = data && typeof data === "object" ? (data as { values?: Record<string, unknown> }).values : null;
  return Object.fromEntries(Object.entries(v ?? {}).filter(([, n]) => typeof n === "number" && Number.isFinite(n))) as Record<string, number>;
};
const bareHost = (h: unknown) => typeof h === "string" ? h.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "") : null;
// Search Console imports complete months only, for exactly this property.
export const gscMonths = (rows: Receipt[], property: string | null): MonthlyPoint[] => !property ? [] :
  latestPerPeriod(rows.filter(r => r.property === property), r => r.property ?? "").map(r => ({ ...r, values: values(r.data), complete: r.period_end === monthEnd(r.period) }));
// Analytics: this property AND this website host. A month-to-date receipt is
// written daily; only the provider's own "complete_month" counts as full.
export const ga4Months = (rows: Receipt[], property: string | null, host: string | null): MonthlyPoint[] => !property || !host ? [] :
  latestPerPeriod(rows.filter(r => r.property === property && bareHost((r.data as { host?: unknown } | null)?.host) === host), r => `${r.property}|${host}`)
    .map(r => ({ ...r, values: values(r.data), complete: (r.data as { coverage?: string } | null)?.coverage === "complete_month" }));
// Business Profile: exactly this account and location.
export const gbpMonths = (rows: GbpImport[], binding: { accountId: string; locationId: string } | null): MonthlyPoint[] => !binding ? [] :
  latestPerPeriod(rows.filter(r => r.account_id === binding.accountId && r.location_id === binding.locationId), r => `${r.account_id}|${r.location_id}`)
    .map(r => ({ ...r, values: gbpTotals(r.data), complete: r.period_end === monthEnd(r.period) }));

// ── Inquiries ───────────────────────────────────────────────────────────────
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
