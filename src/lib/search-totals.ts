import type { GrowthMeasurement } from "./client-growth.ts";

// Search Console property totals come only from the verified property
// imports (report_measurements, source below). Summing gsc_snapshots query
// rows is a sample of the top queries, never the property's total.
export const GSC_PROPERTY_SOURCE = "Google Search Console property totals";
export type SearchTotals =
  | { state: "ok"; scope: string; start: string; end: string; clicks: number; impressions: number }
  | { state: "none" | "several"; scopes: number };

export function propertySearchTotals(rows: Pick<GrowthMeasurement, "metric" | "scope" | "source" | "status" | "value" | "window_start" | "window_end" | "sequence">[]): SearchTotals {
  const gsc = rows.filter(r => r.source === GSC_PROPERTY_SOURCE && r.status === "measured" && r.value !== null && (r.metric === "search_clicks" || r.metric === "search_impressions"));
  const scopes = new Set(gsc.map(r => r.scope));
  // Several properties (brand websites) are never added together here.
  if (scopes.size !== 1) return { state: scopes.size ? "several" : "none", scopes: scopes.size };
  const latest = (metric: string, end: string) => gsc.filter(r => r.metric === metric && r.window_end === end).toSorted((a, b) => b.sequence - a.sequence)[0];
  // The newest window that has both measures; the newest receipt for it wins.
  const ends = [...new Set(gsc.map(r => r.window_end))].sort().reverse();
  for (const end of ends) {
    const clicks = latest("search_clicks", end), impressions = latest("search_impressions", end);
    if (clicks && impressions && clicks.window_start === impressions.window_start)
      return { state: "ok", scope: clicks.scope, start: clicks.window_start, end, clicks: clicks.value!, impressions: impressions.value! };
  }
  return { state: "none", scopes: 1 };
}
