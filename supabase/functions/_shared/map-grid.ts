export type GridPoint = { lat: number; lng: number };
export type GridKeyword = { id: string; keyword: string };
export type GridConfig = {
  target_place_id: string;
  points: GridPoint[];
  keywords: GridKeyword[];
  zoom: number;
};
export type MapResult = {
  place_id: string | null;
  title: string;
  position: number;
  domain: string | null;
};
export type GridCheck = GridPoint & {
  id: string;
  keyword_id: string;
  keyword: string;
  point_index: number;
  state: string;
  position: number | null;
  results: MapResult[] | null;
  cost: number;
  error: string | null;
  checked_at: string | null;
};
export function validateGrid(config: GridConfig) {
  if (
    !config.target_place_id ||
    !Number.isInteger(config.zoom) ||
    config.zoom < 3 ||
    config.zoom > 21
  )
    throw Error("Invalid target or zoom");
  if (
    !Array.isArray(config.points) ||
    config.points.length < 1 ||
    config.points.length > 225 ||
    !Array.isArray(config.keywords) ||
    config.keywords.length < 1 ||
    config.keywords.length > 10 ||
    config.points.length * config.keywords.length > 1000
  )
    throw Error("Grid exceeds scan limit");
  const coords = new Set<string>();
  for (const p of config.points) {
    if (
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lng) ||
      Math.abs(p.lat) > 85 ||
      Math.abs(p.lng) > 180
    )
      throw Error("Invalid coordinates");
    const key = `${p.lat},${p.lng}`;
    if (coords.has(key)) throw Error("Duplicate grid point");
    coords.add(key);
  }
  const ids = new Set<string>();
  for (const k of config.keywords) {
    if (
      !/^[0-9a-f-]{36}$/i.test(k.id) ||
      !k.keyword?.trim() ||
      k.keyword.length > 700 ||
      ids.has(k.id)
    )
      throw Error("Invalid or duplicate keyword");
    ids.add(k.id);
  }
}
export function mapTask(
  check: Pick<GridCheck, "id" | "keyword" | "lat" | "lng">,
  zoom: number,
) {
  return {
    keyword: check.keyword.replace(/%/g, "%25").replace(/\+/g, "%2B"),
    location_coordinate: `${check.lat.toFixed(7)},${check.lng.toFixed(7)},${zoom}z`,
    language_code: "en",
    device: "desktop",
    depth: 100,
    priority: 1,
    search_places: false,
    search_this_area: true,
    tag: check.id,
  };
}
export function parseMapsTask(
  task: {
    status_code?: number;
    result?: { items_count?: number; items?: Record<string, unknown>[] | null }[] | null;
  },
  placeId: string,
) {
  if (task.status_code === 40601 || task.status_code === 40602)
    return { pending: true as const };
  // DataForSEO uses 40102 for a processed search with no matching listings.
  // Require the documented empty result envelope, not just the status code.
  if (
    task.status_code === 40102 &&
    task.result?.length === 1 &&
    task.result[0].items_count === 0 &&
    (task.result[0].items === null ||
      (Array.isArray(task.result[0].items) && task.result[0].items.length === 0))
  )
    return { pending: false as const, position: null, results: [] as MapResult[] };
  if (task.status_code !== 20000)
    throw Error(`Provider status ${task.status_code ?? "missing"}`);
  if (!Array.isArray(task.result) || task.result.length !== 1)
    throw Error("Missing Maps result");
  const raw = task.result[0].items;
  if (raw !== null && !Array.isArray(raw)) throw Error("Malformed Maps items");
  const results: MapResult[] = (raw ?? [])
    .filter(
      (i) =>
        i.type === "maps_search" &&
        Number.isInteger(i.rank_group) &&
        Number(i.rank_group) > 0 &&
        Number(i.rank_group) <= 100,
    )
    .map((i) => ({
      place_id: typeof i.place_id === "string" ? i.place_id : null,
      title: String(i.title ?? ""),
      position: Number(i.rank_group),
      domain: typeof i.domain === "string" ? i.domain : null,
    }));
  const match = results.find((i) => i.place_id === placeId);
  return {
    pending: false as const,
    position: match?.position ?? null,
    results,
  };
}
export function gridMetrics(checks: Pick<GridCheck, "state" | "position">[]) {
  const complete = checks.filter((c) => c.state === "complete");
  const found = complete.filter((c) => c.position !== null);
  return {
    total: checks.length,
    complete: complete.length,
    found: found.length,
    top3: complete.filter((c) => c.position !== null && c.position <= 3).length,
    top3Percent: complete.length
      ? Math.round(
          (complete.filter((c) => c.position !== null && c.position <= 3)
            .length /
            complete.length) *
            100,
        )
      : null,
    averageFound: found.length
      ? found.reduce((s, c) => s + c.position!, 0) / found.length
      : null,
  };
}
export function rankColor(state: string, position: number | null) {
  if (state !== "complete") return "#64748b";
  if (position === null) return "#991b1b";
  if (position <= 3) return "#15803d";
  if (position <= 10) return "#b45309";
  return "#dc2626";
}
