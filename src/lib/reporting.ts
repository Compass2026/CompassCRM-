/** Shared reporting contract. No provider calls, estimates, or customer data. */
import { todayIn } from "./tasks.ts";

/** Compass's "today" (America/Chicago), as on the Tasks pages. Timestamps stay UTC. */
export function agencyToday(now: Date = new Date()): string {
  return todayIn("America/Chicago", now);
}
export const REPORT_AREAS = [
  { key: "website", label: "Website pages & links", next: "Audit the agreed priority pages and internal links.", metrics: [
    ["pages_live", "Priority pages live", "point"], ["pages_indexed", "Priority pages indexed", "point"], ["broken_links", "Broken internal links", "point"],
  ] },
  { key: "citations", label: "Citations", next: "Verify the agreed directory list against the business details.", metrics: [
    ["citations_correct", "Accurate listings", "point"], ["citations_incorrect", "Incorrect listings", "point"], ["citations_missing", "Missing listings", "point"],
  ] },
  { key: "backlinks", label: "Backlinks", next: "Review referring websites and relevant new or lost links.", metrics: [
    ["referring_domains", "Unique referring websites", "point"], ["links_new", "Relevant new backlinks", "window"], ["links_lost", "Relevant lost backlinks", "window"],
  ] },
  { key: "gbp", label: "Google Business Profile", next: "Connect or verify a Business Profile performance export.", metrics: [
    ["gbp_views", "Profile views", "window"], ["gbp_clicks", "Website clicks", "window"], ["gbp_call_clicks", "Call-button clicks (not calls)", "window"],
  ] },
  { key: "reviews", label: "Reviews", next: "Record review totals, rating and unanswered reviews for this profile.", metrics: [
    ["reviews_total", "Total reviews", "point"], ["reviews_rating", "Average rating (out of 5)", "point"], ["reviews_new", "New reviews", "window"], ["reviews_unanswered", "Unanswered reviews", "point"],
  ] },
  { key: "rankings", label: "Search rankings", next: "Confirm the keyword set, location, device and search depth before comparing.", metrics: [
    ["organic_top3", "Organic keywords in top 3", "point"], ["organic_top10", "Organic keywords in top 10", "point"], ["maps_top3", "Maps keywords in top 3", "point"],
  ] },
  { key: "search", label: "Search traffic", next: "Verify Search Console totals and GA4 organic sessions for the same dates.", metrics: [
    ["search_impressions", "Search impressions", "window"], ["search_clicks", "Organic search clicks", "window"], ["organic_sessions", "Organic website sessions", "window"],
  ] },
  { key: "leads", label: "Leads & inquiries", next: "Verify successful submissions and tracked calls; review lead quality separately.", metrics: [
    ["forms", "Successful form submissions", "window"], ["calls", "Tracked calls", "window"], ["qualified_leads", "Verified qualified inquiries", "window"],
  ] },
  { key: "social", label: "Social media", next: "Record results per platform and profile, with paid and organic activity separate.", metrics: [
    ["social_posts", "Posts published", "window"], ["social_plan", "Planned posts", "window"], ["social_reach", "Reach", "window"], ["social_engagements", "Engagements", "window"], ["social_clicks", "Website clicks", "window"], ["social_followers", "Net new followers", "window"],
  ] },
] as const;

export const METRICS = REPORT_AREAS.flatMap((area) => area.metrics.map(([key, label, kind]) => ({ key, label, kind, area: area.key })));
export type MetricKey = typeof METRICS[number]["key"];
export const STATUS_LABELS = {
  measured: "Measured", not_measured: "Not measured", not_connected: "Not connected",
  stale: "Stale", not_applicable: "Not applicable",
} as const;
export type MeasurementStatus = keyof typeof STATUS_LABELS;
export const PLATFORMS = ["none", "facebook", "instagram", "linkedin", "youtube", "tiktok", "x", "pinterest", "other"] as const;

export type MeasurementInput = {
  client_id: string;
  id: string;
  metric: MetricKey;
  scope: string;
  source: string;
  platform: typeof PLATFORMS[number];
  channel: "none" | "organic" | "paid";
  context: "before_work" | "existing_client";
  report_period: string | null;
  window_start: string;
  window_end: string;
  status: MeasurementStatus;
  value: number | null;
  evidence: string;
  meaning: string;
  next_action: string;
};
export type Measurement = MeasurementInput & { sequence: number; created_at: string; recorded_by: string | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function parseMeasurement(clientId: string, form: FormData, today = agencyToday()): MeasurementInput {
  const text = (key: string, max = 1000) => {
    const value = form.get(key);
    if (typeof value !== "string" || value.trim().length > max) throw new Error(`Check ${key.replaceAll("_", " ")}.`);
    return value.trim();
  };
  const id = text("id", 36);
  if (!uuid.test(clientId) || !uuid.test(id)) throw new Error("Invalid client or submission identifier. Refresh and try again.");
  const metric = METRICS.find((m) => m.key === text("metric", 50));
  if (!metric) throw new Error("Choose a reporting metric.");
  const status = text("status", 30) as MeasurementStatus;
  if (!Object.hasOwn(STATUS_LABELS, status)) throw new Error("Choose a measurement status.");
  const rawValue = text("value", 30);
  const value = status === "measured" && rawValue !== "" ? Number(rawValue) : null;
  if (status === "measured" && (value === null || !Number.isFinite(value) || Math.abs(value) > 1e12 ||
    (metric.key !== "social_followers" && value < 0) ||
    (metric.key === "reviews_rating" ? value > 5 : !Number.isInteger(value)))) {
    throw new Error("Enter a valid measured value. Leave unavailable metrics unmeasured; zero is a real result.");
  }
  if (status !== "measured" && rawValue !== "") throw new Error("Unavailable measurements must have an empty value.");
  const window_start = text("window_start", 10);
  const window_end = text("window_end", 10);
  if (!validDate(window_start) || !validDate(window_end) || window_start > window_end || window_end > today) throw new Error("Use valid measurement dates ending today or earlier.");
  if (metric.kind === "point" && window_start !== window_end) throw new Error("This is a point-in-time metric. Use the same start and end date.");
  const period = text("report_period", 7);
  const report_period = period === "" ? null : `${period}-01`;
  if (report_period && (!validDate(report_period) || window_end.slice(0, 7) !== period)) throw new Error("The measurement must end in the selected report month.");
  const platform = text("platform", 20) as MeasurementInput["platform"];
  const channel = text("channel", 10) as MeasurementInput["channel"];
  if (!(PLATFORMS as readonly string[]).includes(platform) || !["none", "organic", "paid"].includes(channel) ||
      (metric.area === "social" ? platform === "none" || channel === "none" : platform !== "none" || channel !== "none")) {
    throw new Error("Social metrics need a platform and paid/organic channel. Other metrics use Neither.");
  }
  const context = text("context", 20) as MeasurementInput["context"];
  if (!["before_work", "existing_client"].includes(context)) throw new Error("Identify whether work has already started.");
  const scope = text("scope", 300);
  const source = text("source", 150);
  const evidence = text("evidence");
  const meaning = text("meaning");
  const next_action = text("next_action");
  if (!scope || !source || !meaning || !next_action || (status === "measured" && !evidence)) throw new Error("Add the scope, source, plain-English meaning, next action, and evidence for a measured value.");
  return { client_id: clientId, id, metric: metric.key, scope, source, platform, channel, context, report_period, window_start, window_end, status, value, evidence, meaning, next_action };
}

/** A scope or provider change starts its own series; never silently splice data. */
export function seriesKey(row: Pick<Measurement, "client_id" | "metric" | "scope" | "source" | "platform" | "channel">): string {
  return JSON.stringify([row.client_id, row.metric, row.scope, row.source, row.platform, row.channel]);
}
export function previousMonth(period: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}
function fullCalendarMonth(row: Measurement): boolean {
  const nextDay = new Date(`${row.window_end}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return row.window_start.endsWith("-01") && nextDay.getUTCDate() === 1 && row.window_start.slice(0, 7) === row.window_end.slice(0, 7);
}
export function compareMeasurements(current?: Measurement, previous?: Measurement): { delta: number | null; reason: string } {
  if (!current || !previous || current.status !== "measured" || previous.status !== "measured" || current.value === null || previous.value === null) return { delta: null, reason: "Comparable measurements needed" };
  if (seriesKey(current) !== seriesKey(previous)) return { delta: null, reason: "Source or scope changed" };
  if (current.id === previous.id) return { delta: null, reason: "Starting measurement" };
  if (current.window_start <= previous.window_end) return { delta: null, reason: "Overlapping or reversed dates" };
  const metric = METRICS.find((m) => m.key === current.metric);
  const days = (r: Measurement) => Date.parse(r.window_end) - Date.parse(r.window_start);
  const calendar = fullCalendarMonth(current) && fullCalendarMonth(previous);
  if (metric?.kind === "window" && days(current) !== days(previous) && !calendar) return { delta: null, reason: "Different measurement windows" };
  return { delta: Math.round((current.value - previous.value) * 100) / 100, reason: metric?.kind === "window" && calendar ? "Calendar months (day counts may differ)" : "Same measurement scope" };
}
export function scorecardRows(rows: Measurement[], clientId: string, period: string) {
  const groups = new Map<string, Measurement[]>();
  // sequence is assigned by the database, never a user-supplied or backdated date.
  for (const row of rows.filter((r) => r.client_id === clientId).sort((a, b) => a.sequence - b.sequence)) {
    const key = seriesKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, history]) => {
    const baseline = history.find((r) => r.status === "measured");
    // Never show a baseline from the future in a historical monthly scorecard.
    const visibleBaseline = baseline && baseline.window_end.slice(0, 7) <= period.slice(0, 7) ? baseline : undefined;
    const previous = history.filter((r) => r.report_period === previousMonth(period)).at(-1);
    const current = history.filter((r) => r.report_period === period).at(-1);
    return { key, definition: history[0], baseline: visibleBaseline, previous, current, history, change: compareMeasurements(current, previous), sinceBaseline: compareMeasurements(current, visibleBaseline) };
  });
}

export function formatMeasurement(row?: Measurement): string {
  return row?.status === "measured" && row.value !== null ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(row.value) : row ? STATUS_LABELS[row.status] : "Not measured";
}
