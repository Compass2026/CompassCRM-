import type { GrowthRanking } from "./growth-rankings.ts";
import type { growthSeries } from "./client-growth.ts";

export const RANK_BUCKETS = [
  { key: "top3", label: "Top 3", color: "#2563eb" },
  { key: "top10", label: "Positions 4–10", color: "#14b8a6" },
  { key: "beyond", label: "Position 11+", color: "#f97316" },
  { key: "missing", label: "Not found", color: "#94a3b8" },
  { key: "unchecked", label: "Not checked", color: "#e2e8f0" },
] as const;
export function rankingDistribution(rows: GrowthRanking[], type: "organic" | "map_pack") {
  return RANK_BUCKETS.map(bucket => ({ ...bucket, keywordIds: [...new Set(rows.map(r => r.keyword_id))].filter(id => {
    const checks = rows.filter(r => r.keyword_id === id && r.result_type === type && r.checked_at);
    const positions = checks.flatMap(r => r.position !== null && r.position > 0 ? [r.position] : []);
    const best = positions.length ? Math.min(...positions) : null;
    return bucket.key === (!checks.length ? "unchecked" : best === null ? "missing" : best <= 3 ? "top3" : best <= 10 ? "top10" : "beyond");
  }) })).map(bucket => ({ ...bucket, value: bucket.keywordIds.length }));
}

// A pie may combine action types only when their source, scope and windows match.
export function interactionMix(series: ReturnType<typeof growthSeries>) {
  const metrics = ["gbp_clicks", "gbp_call_clicks", "gbp_directions"];
  for (const anchor of series.filter(s => s.metric.key === metrics[0])) {
    const match = metrics.map(metric => series.find(s => s.metric.key === metric && s.definition.source === anchor.definition.source && s.definition.scope === anchor.definition.scope && s.definition.platform === anchor.definition.platform && s.definition.channel === anchor.definition.channel));
    if (match.every(s => s?.current?.status === "measured" && s.current.value !== null && s.current.value >= 0 && s.current.window_start === anchor.current?.window_start && s.current.window_end === anchor.current?.window_end)) {
      return { start: anchor.current!.window_start, end: anchor.current!.window_end, source: anchor.definition.source, items: match.map((s, i) => ({ key: metrics[i], label: ["Website clicks", "Call-button clicks", "Direction requests"][i], color: ["#2563eb", "#f97316", "#14b8a6"][i], value: s!.current!.value! })) };
    }
  }
  return null;
}
