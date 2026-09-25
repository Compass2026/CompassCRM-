// Search Console, latest window only. Stored snapshots are overlapping
// rolling 28-day windows, so summing them double-counts. Old URLs are mapped
// through the inventory's redirects so a moved page keeps its history. Pure.
import type { AuthorityInput, GscRow, GscSummary, RankRow } from "./types.ts";
import { normPath, type Inventory } from "./urls.ts";

export function latestWindow(rows: GscRow[]): { rows: GscRow[]; label: string | null } {
  if (!rows.length) return { rows: [], label: null };
  const end = rows.reduce((m, r) => (r.period_end > m ? r.period_end : m), rows[0].period_end);
  const inWin = rows.filter((r) => r.period_end === end);
  const start = inWin.reduce((m, r) => (r.period_start < m ? r.period_start : m), inWin[0].period_start);
  return { rows: inWin, label: `${start}..${end}` };
}

export function landingPath(input: AuthorityInput, inv: Inventory, page: string | null): string | null {
  const site = input.authority.site?.url ?? input.client.website_url;
  const p = normPath(page?.replace(/#.*$/, "") ?? null, site);
  if (!p) return null;
  const r = inv.resolve(p);
  return r.state === "redirects" && r.final_path ? r.final_path : p;
}

const stems = (s: string) => (s.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 5));

export function latestRank(ranks: RankRow[], keywordId: string | null): { organic: RankRow | null; map: RankRow | null } {
  if (!keywordId) return { organic: null, map: null };
  const mine = ranks.filter((r) => r.keyword_id === keywordId).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  return { organic: mine.find((r) => r.result_type === "organic") ?? null, map: mine.find((r) => r.result_type === "map_pack") ?? null };
}

// A service's queries: those mapped to its keywords, plus unmapped queries
// sharing every distinctive (5+ letter) stem of the service name — a
// deterministic but heuristic match, reported as such.
export function gscForService(
  input: AuthorityInput, inv: Inventory, serviceName: string, keywordIds: Set<string>, ownerPath: string | null, primaryKeywordId: string | null,
): GscSummary & { matched_by_name: number } {
  const { rows, label } = latestWindow(input.authority.gsc);
  const want = stems(serviceName);
  let byName = 0;
  const mine = rows.filter((r) => {
    if (r.keyword_id && keywordIds.has(r.keyword_id)) return true;
    if (!r.keyword_id && want.length && want.every((s) => stems(r.query).includes(s))) { byName++; return true; }
    return false;
  });
  const pages = new Map<string, number>();
  let impressions = 0, clicks = 0, owner = 0, best: number | null = null;
  for (const r of mine) {
    impressions += r.impressions; clicks += r.clicks;
    const p = landingPath(input, inv, r.page) ?? "(none)";
    pages.set(p, (pages.get(p) ?? 0) + r.impressions);
    if (ownerPath && p === ownerPath) owner += r.impressions;
    if (r.avg_position != null && (best === null || r.avg_position < best)) best = r.avg_position;
  }
  const rk = latestRank(input.authority.ranks, primaryKeywordId);
  const site = input.authority.site?.url ?? input.client.website_url;
  const kw = input.keywords.find((k) => k.id === primaryKeywordId);
  return {
    window: label, impressions, clicks, best_position: best, owner_impressions: owner,
    landing_pages: [...pages].map(([path, i]) => ({ path, impressions: i })).sort((a, b) => b.impressions - a.impressions),
    queries: mine.sort((a, b) => b.impressions - a.impressions).slice(0, 12)
      .map((r) => ({ query: r.query, impressions: r.impressions, position: r.avg_position, path: landingPath(input, inv, r.page) })),
    rank: kw ? {
      keyword: kw.keyword, organic: rk.organic?.position ?? null, map_pack: rk.map?.position ?? null,
      // organic only: a map-pack result links the Business Profile website, not a page Google chose
      url_path: normPath(rk.organic?.url_ranked ?? null, site),
      recorded_at: (rk.organic ?? rk.map)?.recorded_at ?? null,
    } : null,
    matched_by_name: byName,
  };
}

// Queries in the latest window that no keyword maps and no approved service
// name matches: discovery only; they never create a topic on their own.
export function unclaimedQueries(input: AuthorityInput, serviceNames: string[]): { query: string; impressions: number; position: number | null }[] {
  const { rows } = latestWindow(input.authority.gsc);
  const svcStems = serviceNames.map(stems);
  const agg = new Map<string, { impressions: number; position: number | null }>();
  for (const r of rows) {
    if (r.keyword_id) continue;
    if (svcStems.some((ss) => ss.length && ss.every((s) => stems(r.query).includes(s)))) continue;
    const a = agg.get(r.query) ?? { impressions: 0, position: r.avg_position };
    a.impressions += r.impressions;
    agg.set(r.query, a);
  }
  return [...agg].map(([query, v]) => ({ query, ...v })).sort((a, b) => b.impressions - a.impressions);
}
