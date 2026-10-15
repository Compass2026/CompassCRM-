export type GridPoint = { lat: number; lng: number };
export type GridKeyword = { id: string; keyword: string };
// Radius is distance from the business center, never diameter.
export type GridTier = { max_miles: number; spacing_miles: number };
export type GridGeometry = {
  version: typeof LOCAL_GEOMETRY_VERSION;
  center: GridPoint;
  tiers: GridTier[];
  radii_miles: number[];
  default_radius_miles: number;
  point_count: number;
};
export type GridConfig = {
  target_place_id: string;
  points: GridPoint[];
  keywords: GridKeyword[];
  zoom: number;
  search_this_area?: boolean;
  // Absent or null on runs frozen before the local layout existed.
  geometry?: GridGeometry | null;
};
export const LOCAL_GEOMETRY_VERSION = "local-multiscale-v1";
export const LOCAL_TIERS: GridTier[] = [
  { max_miles: 1, spacing_miles: 0.25 },
  { max_miles: 2, spacing_miles: 0.5 },
  { max_miles: 5, spacing_miles: 1 },
];
export const COST_PER_CHECK = 0.0006;
const EARTH_MILES = 3958.7613;
// Absorbs 7-decimal coordinate rounding (~1 cm), never a whole lattice step.
export const RADIUS_TOLERANCE_MILES = 0.001;
const rad = (d: number) => (d * Math.PI) / 180;
export function distanceMiles(a: GridPoint, b: GridPoint) {
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) *
      Math.cos(rad(b.lat)) *
      Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Great-circle destination, so a lattice offset of d miles is d miles away.
function destination(center: GridPoint, north: number, east: number) {
  const d = Math.hypot(north, east) / EARTH_MILES;
  if (d === 0) return { lat: center.lat, lng: center.lng };
  const bearing = Math.atan2(east, north),
    lat1 = rad(center.lat),
    lng1 = rad(center.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    lat: Number(((lat2 * 180) / Math.PI).toFixed(7)),
    lng: Number(((lng2 * 180) / Math.PI).toFixed(7)),
  };
}
// One deterministic, deduplicated nested scan: each tier fills the ring between
// the previous tier's radius and its own, so the center is charged once.
export function localGrid(center: GridPoint, tiers: GridTier[] = LOCAL_TIERS) {
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng))
    throw Error("Invalid center");
  const points: GridPoint[] = [],
    seen = new Set<string>();
  let inner = -1;
  for (const tier of tiers) {
    const steps = Math.round(tier.max_miles / tier.spacing_miles);
    if (steps * tier.spacing_miles !== tier.max_miles || tier.max_miles <= inner)
      throw Error("Tier radius must be a whole number of steps and increase");
    const ring: { i: number; j: number; d2: number }[] = [];
    for (let i = -steps; i <= steps; i++)
      for (let j = -steps; j <= steps; j++) {
        // Integer lattice arithmetic keeps boundary membership exact.
        const d2 = i * i + j * j;
        if (d2 <= steps * steps && Math.sqrt(d2) * tier.spacing_miles > inner)
          ring.push({ i, j, d2 });
      }
    ring.sort((a, b) => a.d2 - b.d2 || b.i - a.i || a.j - b.j);
    for (const { i, j } of ring) {
      const p = destination(
        center,
        i * tier.spacing_miles,
        j * tier.spacing_miles,
      );
      const key = `${p.lat},${p.lng}`;
      if (!seen.has(key)) {
        seen.add(key);
        points.push(p);
      }
    }
    inner = tier.max_miles;
  }
  const geometry: GridGeometry = {
    version: LOCAL_GEOMETRY_VERSION,
    center: { lat: center.lat, lng: center.lng },
    tiers: tiers.map((t) => ({ ...t })),
    radii_miles: tiers.map((t) => t.max_miles),
    default_radius_miles: tiers[tiers.length - 1].max_miles,
    point_count: points.length,
  };
  return { points, geometry };
}
export function withinRadius<T extends GridPoint>(
  points: T[],
  center: GridPoint,
  miles: number | null,
) {
  if (miles === null) return points;
  return points.filter(
    (p) => distanceMiles(center, p) <= miles + RADIUS_TOLERANCE_MILES,
  );
}
export function scanPreview(config: Pick<GridConfig, "points" | "keywords">) {
  const checks = config.points.length * config.keywords.length;
  return {
    points: config.points.length,
    keywords: config.keywords.length,
    checks,
    estimatedCost: checks * COST_PER_CHECK,
  };
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
// Why a declared geometry cannot be trusted, or null when it is complete and
// consistent. Legacy configs (geometry absent or null) are not checked here.
export function geometryProblem(
  g: unknown,
  points: GridPoint[],
): string | null {
  if (typeof g !== "object" || g === null || Array.isArray(g))
    return "Invalid grid geometry";
  const x = g as Record<string, unknown>;
  if (x.version !== LOCAL_GEOMETRY_VERSION)
    return "Unknown grid geometry version";
  const c = x.center as Record<string, unknown> | null | undefined;
  if (
    typeof c?.lat !== "number" ||
    typeof c?.lng !== "number" ||
    !Number.isFinite(c.lat) ||
    !Number.isFinite(c.lng) ||
    Math.abs(c.lat) > 85 ||
    Math.abs(c.lng) > 180
  )
    return "Invalid grid geometry center";
  const tiers = x.tiers,
    radii = x.radii_miles;
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 5)
    return "Invalid grid geometry tiers";
  if (!Array.isArray(radii) || radii.length !== tiers.length)
    return "Grid geometry radii do not match its tiers";
  let previous = 0;
  for (const [i, t] of tiers.entries()) {
    const tier = t as Record<string, unknown> | null;
    if (
      !positive(tier?.max_miles) ||
      !positive(tier?.spacing_miles) ||
      tier.spacing_miles > tier.max_miles ||
      tier.max_miles <= previous
    )
      return "Invalid grid geometry tiers";
    if (radii[i] !== tier.max_miles)
      return "Grid geometry radii do not match its tiers";
    previous = tier.max_miles;
  }
  if (!radii.includes(x.default_radius_miles))
    return "Grid geometry default radius is not one of its radii";
  if (x.point_count !== points.length)
    return "Grid geometry point count does not match its points";
  for (const p of points)
    if (distanceMiles(c as GridPoint, p) > previous + RADIUS_TOLERANCE_MILES)
      return "Grid point outside declared radius";
  return null;
}
// The dense layout a viewer may rely on, or null for legacy and untrustworthy metadata.
export function usableGeometry(config: Pick<GridConfig, "geometry" | "points">) {
  const g = config.geometry;
  if (g === undefined || g === null) return null;
  return geometryProblem(g, config.points) ? null : g;
}
function validateGeometry(config: GridConfig) {
  const g = config.geometry;
  if (g === undefined || g === null) return;
  const problem = geometryProblem(g, config.points);
  if (problem) throw Error(problem);
}
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
  if (config.search_this_area !== undefined && typeof config.search_this_area !== "boolean")
    throw Error("Invalid Maps search mode");
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
  validateGeometry(config);
}
export function mapTask(
  check: Pick<GridCheck, "id" | "keyword" | "lat" | "lng">,
  zoom: number,
  searchThisArea = true,
) {
  return {
    keyword: check.keyword.replace(/%/g, "%25").replace(/\+/g, "%2B"),
    location_coordinate: `${check.lat.toFixed(7)},${check.lng.toFixed(7)},${zoom}z`,
    language_code: "en",
    device: "desktop",
    depth: 100,
    priority: 1,
    search_places: false,
    search_this_area: searchThisArea,
    tag: check.id,
  };
}
export function parseMapsTask(
  task: {
    status_code?: number;
    result?: { items?: Record<string, unknown>[] | null }[] | null;
  },
  placeId: string,
) {
  if (task.status_code === 40601 || task.status_code === 40602)
    return { pending: true as const };
  // DataForSEO returns 40102 for a completed search with no listings.
  // Keep validating its result envelope so malformed responses stay retryable.
  if (task.status_code !== 20000 && task.status_code !== 40102)
    throw Error(`Provider status ${task.status_code ?? "missing"}`);
  if (!Array.isArray(task.result) || task.result.length !== 1)
    throw Error("Missing Maps result");
  const raw = task.result[0].items;
  if (raw !== null && !Array.isArray(raw)) throw Error("Malformed Maps items");
  if (task.status_code === 40102 && raw?.length)
    throw Error("No-results status contains Maps items");
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
