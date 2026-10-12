import { agencyToday, compareMeasurements, METRICS, seriesKey, validDate, type Measurement } from "./reporting.ts";

export type GrowthMeasurement = Omit<Measurement, "evidence" | "meaning" | "next_action" | "recorded_by">;
export type GrowthRange = { start: string; end: string; mode: string; error?: string };
export type SearchHistory = { client_id: string; period_start: string; period_end: string; clicks: number; impressions: number; imported_rows: number };
export function growthRange(query: { range?: string; month?: string; start?: string; end?: string }, today = agencyToday()): GrowthRange {
  if (query.range === "month") {
    const start = `${query.month}-01`;
    if (!validDate(start) || start > today) return { start: "0001-01-01", end: today, mode: "all", error: "Choose a valid month ending today or earlier." };
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1, 0);
    return { start, end: [date.toISOString().slice(0, 10), today].sort()[0], mode: "month" };
  }
  if (query.range === "custom") {
    const { start = "", end = "" } = query;
    if (!validDate(start) || !validDate(end) || start > end || end > today) return { start: "0001-01-01", end: today, mode: "all", error: "Choose valid dates ending today or earlier." };
    return { start, end, mode: "custom" };
  }
  return { start: "0001-01-01", end: today, mode: "all" };
}

const asMeasurement = (r?: GrowthMeasurement): Measurement | undefined => r && ({ ...r, evidence: "", meaning: "", next_action: "", recorded_by: null });
export function growthSeries(rows: GrowthMeasurement[], range: GrowthRange) {
  const groups = new Map<string, GrowthMeasurement[]>();
  for (const row of [...rows].sort((a,b) => a.sequence-b.sequence)) {
    const key = seriesKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, history]) => {
    // Preserve the first recorded measurement, even when later entries are backdated.
    const first = history.find(r => r.status === "measured");
    const baseline = first && first.window_end <= range.end ? first : undefined;
    // A correction wins for its dates, but a later-entered old month isn't current.
    const byDate = new Map<string, GrowthMeasurement>();
    for (const r of history) byDate.set(`${r.window_start}/${r.window_end}`, r);
    const points = [...byDate.values()].filter(r => r.window_start >= range.start && r.window_end <= range.end)
      .sort((a,b) => a.window_end.localeCompare(b.window_end) || a.sequence-b.sequence);
    const current = points.at(-1);
    const change = compareMeasurements(asMeasurement(current), asMeasurement(baseline));
    const metric = METRICS.find(m => m.key === history[0].metric)!;
    const stale = !!current && (Date.parse(range.end)-Date.parse(current.window_end))/86400000 > 45;
    const lowerIsBetter = ["broken_links", "citations_incorrect", "citations_missing", "links_lost", "reviews_unanswered"].includes(metric.key);
    return { key, definition: history[0], metric, baseline, current, points, change, stale, lowerIsBetter };
  });
}

export function deltaLabel(delta: number | null, baseline?: number | null): string {
  if (delta === null) return "Comparison unavailable";
  const amount = `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (!baseline || baseline < 0) return `${amount} since baseline`;
  const percent = delta / baseline * 100;
  return `${amount} (${percent > 0 ? "+" : ""}${percent.toFixed(1)}%) since baseline`;
}
export function growthDate(date?: string | null): string {
  return date ? new Date(`${date.slice(0,10)}T12:00:00Z`).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric", timeZone:"UTC" }) : "Not measured";
}

export type GrowthWork = { id: string; client_id: string; kind: "blog" | "gbp" | "social"; title: string; published_on: string; url: string | null };
