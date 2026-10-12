export type GrowthRanking = {
  client_id: string;
  keyword_id: string;
  keyword: string;
  keyword_city: string | null;
  location_id: string | null;
  location_name: string | null;
  result_type: "organic" | "map_pack" | null;
  first_position: number | null;
  first_checked_at: string | null;
  position: number | null;
  checked_at: string | null;
  previous_position: number | null;
  previous_checked_at: string | null;
};

const uniqueKeywords = (rows: GrowthRanking[]) => new Set(rows.map(r => r.keyword_id)).size;
export function rankingSummary(rows: GrowthRanking[], now = Date.now()) {
  const summarize = (type: "organic" | "map_pack") => {
    const checked = rows.filter(r => r.result_type === type && r.checked_at);
    const ranked = checked.filter(r => r.position !== null && r.position > 0);
    return {
      checked: uniqueKeywords(checked),
      top3: checked.length ? uniqueKeywords(ranked.filter(r => r.position! <= 3)) : null,
      top10: checked.length ? uniqueKeywords(ranked.filter(r => r.position! <= 10)) : null,
      average: ranked.length ? ranked.reduce((sum, r) => sum + r.position!, 0) / ranked.length : null,
      rankedChecks: ranked.length,
      checks: checked.length,
      stale: checked.filter(r => now - Date.parse(r.checked_at!) > 14 * 86400000).length,
    };
  };
  return {
    tracked: uniqueKeywords(rows),
    unchecked: uniqueKeywords(rows.filter(r => !r.checked_at)),
    organic: summarize("organic"),
    maps: summarize("map_pack"),
  };
}

export function rankingMovement(first: number | null, latest: number | null, firstDate: string | null, latestDate: string | null) {
  if (!firstDate || !latestDate || firstDate === latestDate) return "Awaiting another check";
  if (first === null || latest === null) return "Not comparable";
  const change = first - latest;
  return change > 0 ? `Up ${change}` : change < 0 ? `Down ${-change}` : "No change";
}
