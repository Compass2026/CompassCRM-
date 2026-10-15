"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { MapPin, RefreshCw, Download, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startMapGridAction } from "@/app/map-grid-actions";
import {
  distanceMiles,
  gridMetrics,
  rankColor,
  scanPreview,
  usableGeometry,
  withinRadius,
  type GridCheck,
  type GridConfig,
  type GridPoint,
} from "@/lib/map-grid";
const MapGridMap = dynamic(() => import("./map-grid-map"), {
  ssr: false,
  loading: () => (
    <div className="h-[570px] animate-pulse rounded-2xl bg-slate-100" />
  ),
});
export type GridRunView = {
  id: string;
  started_at: string;
  status: string;
  error: string | null;
  config: GridConfig;
};
export type GridBaseline = {
  keyword_id: string;
  recorded_at: string;
  points: { lat: number; lng: number; position: number | null }[];
};
const DEFAULT_RADII = [1, 2, 5];
const miles = (n: number) => `${Number(n.toFixed(1))} mi`;
function typicalSpacing(points: GridPoint[]) {
  const nn = points
    .map((p, i) =>
      Math.min(
        ...points.filter((_, j) => j !== i).map((q) => distanceMiles(p, q)),
      ),
    )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return nn.length ? nn[Math.floor(nn.length / 2)] : null;
}
export function MapGridDashboard({
  clientId,
  profile,
  runs,
  run,
  checks,
  baselines,
  homeCenter,
}: {
  clientId: string;
  profile: {
    id: string;
    label: string;
    enabled: boolean;
    weekly_enabled: boolean;
    config: GridConfig;
  };
  runs: GridRunView[];
  run: GridRunView | null;
  checks: GridCheck[];
  baselines: GridBaseline[];
  // The grid config's recorded center, for runs frozen before geometry existed.
  homeCenter: GridPoint | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const config = run?.config ?? profile.config;
  const [keywordId, setKeywordId] = useState(config.keywords[0]?.id ?? "");
  const [source, setSource] = useState<"dataforseo" | "brightlocal">(
    "dataforseo",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const keyword = config.keywords.find((k) => k.id === keywordId);
  const baseline = baselines.find((b) => b.keyword_id === keywordId);
  // Geometry, counts, spacing and coverage always describe the dataset on
  // screen. A BrightLocal baseline never borrows the scan's dense metadata,
  // and the next scan's profile is kept apart (see `next` below).
  const runGeometry = usableGeometry(config);
  const shown = useMemo(
    () =>
      source === "brightlocal"
        ? { points: baseline?.points ?? [], geometry: null }
        : { points: config.points, geometry: runGeometry },
    [source, baseline, config.points, runGeometry],
  );
  const geometry = shown.geometry;
  const center = geometry?.center ?? homeCenter;
  const radii = geometry?.radii_miles ?? DEFAULT_RADII;
  // Broad layouts open at their full extent: their 5-mile slice is nearly empty.
  const [radius, setRadius] = useState<number | null>(
    runGeometry ? runGeometry.default_radius_miles : null,
  );
  // A deliberate source switch resets the radius to that dataset's own default.
  const changeSource = (next: "dataforseo" | "brightlocal") => {
    setSource(next);
    setSelectedId(null);
    setRadius(
      next === "dataforseo" && runGeometry
        ? runGeometry.default_radius_miles
        : null,
    );
  };
  const [showRings, setShowRings] = useState(true);
  const rings = useMemo(
    () => (showRings && center ? radii : []),
    [showRings, center, radii],
  );
  const viewPoints = useMemo<GridCheck[]>(
    () =>
      source === "brightlocal"
        ? (baseline?.points ?? []).map((p, i) => ({
            ...p,
            id: `baseline-${keywordId}-${i}`,
            keyword_id: keywordId,
            keyword: keyword?.keyword ?? "",
            point_index: i,
            state: "complete",
            results: null,
            cost: 0,
            error: null,
            checked_at: baseline!.recorded_at,
          }))
        : checks.filter((c) => c.keyword_id === keywordId),
    [source, baseline, checks, keywordId, keyword],
  );
  const inRadius = useMemo(
    () => (center ? withinRadius(viewPoints, center, radius) : viewPoints),
    [viewPoints, center, radius],
  );
  const pointsWithin = (r: number | null) =>
    center ? withinRadius(shown.points, center, r).length : shown.points.length;
  const spacing = useMemo(
    () => (geometry ? null : typicalSpacing(shown.points)),
    [geometry, shown.points],
  );
  const selected = inRadius.find((c) => c.id === selectedId) ?? null;
  useEffect(() => {
    if (run?.status !== "running") return;
    const timer = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(timer);
  }, [run?.status, router]);
  const selectPoint = useCallback((c: GridCheck) => setSelectedId(c.id), []);
  const metrics = gridMetrics(inRadius);
  const totalCost = checks.reduce((s, c) => s + Number(c.cost), 0);
  // The next scan freezes the profile as it is now, not the scan on screen.
  const next = scanPreview(profile.config);
  const nextGeometry = usableGeometry(profile.config);
  const radiusLabel = radius === null ? "full scan" : `${radius} mi`;
  const scan = () =>
    startTransition(async () => {
      setError(null);
      setConfirming(false);
      const result = await startMapGridAction(clientId, profile.id, requestKey);
      if (result.error) setError(result.error);
      else if (result.runId)
        router.push(`/clients/${clientId}/maps?run=${result.runId}`);
      router.refresh();
    });
  function download() {
    const cell = (v: unknown) =>
      '"' +
      String(v ?? "")
        .replace(/^[=+@-]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const csv = [
      [
        "keyword",
        "source",
        "scan_time",
        "latitude",
        "longitude",
        "distance_miles",
        "status",
        "rank",
      ],
      ...inRadius.map((c) => [
        keyword?.keyword,
        source,
        source === "brightlocal" ? baseline?.recorded_at : run?.started_at,
        c.lat,
        c.lng,
        center ? distanceMiles(center, c).toFixed(3) : "",
        c.state,
        c.state === "complete"
          ? (c.position ?? "100+ / not found")
          : "unavailable",
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `map-grid-${source}-${keywordId}-${radius ?? "full"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-5">
      <section className="rounded-3xl bg-gradient-to-br from-[#0b162a] to-[#183d69] p-6 text-white shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-orange-300">
              <Radar size={16} /> Compass local visibility
            </div>
            <h2 className="text-2xl font-semibold text-white">
              Your rankings, across the map.
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              {profile.label} ·{" "}
              {source === "brightlocal"
                ? "BrightLocal baseline"
                : geometry
                  ? `Dense local scan, ${radii.map((r) => `${r}`).join(" / ")} mi`
                  : "Broad scan"}{" "}
              · {shown.points.length} points · {config.keywords.length}{" "}
              keywords
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
              onClick={() => router.refresh()}
            >
              <RefreshCw size={15} /> Refresh
            </Button>
            <Button
              onClick={() => setConfirming(true)}
              disabled={
                pending ||
                confirming ||
                run?.status === "running" ||
                !profile.enabled
              }
              className="bg-orange-500 text-white hover:bg-orange-600"
            >
              {pending
                ? "Starting…"
                : run?.status === "running"
                  ? "Scan in progress"
                  : "Run scan"}
            </Button>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/15 pt-4 text-xs text-slate-300">
          <span>Source: Google Maps via DataForSEO</span>
          <span>Search mode: {config.search_this_area === false ? "Query-led location" : "Search this area"}</span>
          <span>
            Schedule:{" "}
            {profile.weekly_enabled ? "Thursdays at 14:00 UTC" : "Manual pilot"}
          </span>
          <span>
            Next scan: {next.points} points × {next.keywords} keywords ={" "}
            {next.checks} checks · est. ${next.estimatedCost.toFixed(3)}
          </span>
        </div>
        {confirming && (
          <div
            role="dialog"
            aria-label="Confirm paid scan"
            className="mt-4 rounded-2xl border border-orange-300/40 bg-white/10 p-4 text-sm"
          >
            <p className="font-semibold text-white">
              Start a paid scan of {next.checks} checks (est. $
              {next.estimatedCost.toFixed(3)})?
            </p>
            <p className="mt-1 text-slate-300">
              {nextGeometry
                ? `Dense local layout: ${nextGeometry.radii_miles
                    .map(
                      (r) =>
                        `${withinRadius(profile.config.points, nextGeometry.center, r).length} points within ${r} mi`,
                    )
                    .join(", ")}.`
                : `Broad layout: ${next.points} hand-placed points.`}{" "}
              {next.keywords} keywords · search mode{" "}
              {profile.config.search_this_area === false
                ? "query-led location"
                : "search this area"}
              . One scan covers every radius; switching radius or zooming
              later never starts another.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                onClick={scan}
                disabled={pending}
                className="bg-orange-500 text-white hover:bg-orange-600"
              >
                Start paid scan
              </Button>
              <Button
                variant="outline"
                className="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {run?.error && (
        <p
          role="status"
          className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900"
        >
          {run.error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4 rounded-2xl border bg-card p-4">
        <label className="min-w-56 flex-1 text-xs font-medium text-muted-foreground">
          Keyword
          <select
            aria-label="Map keyword"
            className="field-sm mt-1 block w-full text-foreground"
            value={keywordId}
            onChange={(e) => setKeywordId(e.target.value)}
          >
            {config.keywords.map((k) => (
              <option value={k.id} key={k.id}>
                {k.keyword}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Scan
          <select
            aria-label="Scan history"
            className="field-sm mt-1 block text-foreground"
            value={run?.id ?? ""}
            onChange={(e) =>
              router.push(`/clients/${clientId}/maps?run=${e.target.value}`)
            }
          >
            {!runs.length && <option value="">No scans yet</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.started_at.slice(0, 16).replace("T", " ")} UTC · {r.status}{" "}
                · {usableGeometry(r.config) ? "dense 1/2/5 mi" : "broad"}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Display
          <select
            aria-label="Grid source"
            className="field-sm mt-1 block text-foreground"
            value={source}
            onChange={(e) => changeSource(e.target.value as typeof source)}
          >
            <option value="dataforseo">Compass / DataForSEO</option>
            <option value="brightlocal" disabled={!baseline}>
              BrightLocal baseline
            </option>
          </select>
        </label>
        <fieldset className="text-xs font-medium text-muted-foreground">
          <legend>Radius from business</legend>
          <div
            className="mt-1 flex overflow-hidden rounded-lg border"
            role="group"
            aria-label="Radius from business"
          >
            {[...radii, null].map((r) => (
              <button
                key={r ?? "full"}
                type="button"
                aria-pressed={radius === r}
                disabled={r !== null && !center}
                onClick={() => setRadius(r)}
                className={`whitespace-nowrap px-2.5 py-1.5 text-sm sm:px-3 ${radius === r ? "bg-navy-900 text-white" : "bg-card text-foreground hover:bg-muted"} disabled:opacity-40`}
              >
                {r === null ? "Full scan" : `${r} mi`}
                <span className="ml-1 text-[11px] opacity-70">
                  ({pointsWithin(r)})
                </span>
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground">
          <input
            type="checkbox"
            checked={showRings}
            disabled={!center}
            onChange={(e) => setShowRings(e.target.checked)}
          />
          Distance rings
        </label>
        <Button
          variant="outline"
          onClick={download}
          disabled={!inRadius.length}
        >
          <Download size={15} /> CSV
        </Button>
      </div>
      {!geometry && (
        <p
          role="note"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {source === "brightlocal" ? "This BrightLocal baseline" : "This scan"}{" "}
          has no dense 1/2/5-mile layout: {shown.points.length} points
          {spacing ? `, about ${miles(spacing)} apart` : ""}.{" "}
          {radius !== null
            ? `Only ${inRadius.length} sampled point${inRadius.length === 1 ? " falls" : "s fall"} within ${radius} mi of the business. `
            : ""}
          It holds no neighborhood-level detail, and it is a different
          baseline from the dense 1/2/5-mile layout, so differences between
          the two are not ranking changes.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          [
            "Sampled points",
            `${inRadius.length}`,
            radius === null
              ? "Full scan extent"
              : `Within ${radius} mi of the business`,
          ],
          [
            "Top 3 coverage",
            metrics.top3Percent === null
              ? "No data"
              : `${metrics.top3Percent}%`,
            `${metrics.top3} of ${metrics.complete} completed points, ${radiusLabel}`,
          ],
          [
            "Average rank when found",
            metrics.averageFound?.toFixed(1) ?? "No data",
            `${metrics.found} found in top 100 · ${metrics.complete - metrics.found} not found`,
          ],
          [
            "Checks completed",
            `${metrics.complete} / ${metrics.total}`,
            source === "brightlocal"
              ? "Imported baseline"
              : metrics.total > metrics.complete
                ? `${metrics.total - metrics.complete} pending or unavailable`
                : (run?.status ?? "Ready for first scan"),
          ],
          [
            "Data cost, whole scan",
            source === "brightlocal"
              ? "Not available"
              : `$${totalCost.toFixed(3)}`,
            "Provider charges recorded so far",
          ],
        ].map(([label, value, note]) => (
          <div key={label} className="rounded-2xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-navy-900">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>
      {source === "brightlocal" && (
        <p className="text-sm text-muted-foreground">
          BrightLocal baseline:{" "}
          {baseline?.recorded_at.slice(0, 16).replace("T", " ")} UTC. Provider
          methods and scan dates differ; this is a reference, not a
          like-for-like ranking change.
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="overflow-hidden rounded-2xl border bg-card p-2">
          {viewPoints.length ? (
            <MapGridMap
              checks={inRadius}
              onSelect={selectPoint}
              center={center}
              radiusMiles={radius}
              datasetKey={`${source}:${run?.id ?? "profile"}`}
              rings={rings}
            />
          ) : (
            <div className="grid h-[480px] place-content-center gap-3 text-center text-muted-foreground">
              <MapPin className="mx-auto" />
              <p>Run the first scan to see your geographic rankings.</p>
            </div>
          )}
          <div className="flex flex-wrap gap-4 px-3 py-4 text-xs">
            {[
              ["#15803d", "1–3"],
              ["#b45309", "4–10"],
              ["#dc2626", "11–100"],
              ["#991b1b", "100+ / not found"],
              ["#64748b", "Pending / unavailable"],
            ].map(([color, label]) => (
              <span key={label} className="flex items-center gap-1.5">
                <i
                  className="h-3 w-3 rounded-full"
                  style={{ background: color }}
                />
                {label}
              </span>
            ))}
            {center && (
              <span className="flex items-center gap-1.5">
                <i className="h-3.5 w-3.5 rounded-full border-[3px] border-orange-500" />
                Business location
              </span>
            )}
          </div>
        </div>
        <aside className="rounded-2xl border bg-card p-5">
          <h3 className="font-semibold">
            {selected ? `Point ${selected.point_index + 1}` : "Explore a point"}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {selected
              ? `${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}${center ? ` · ${distanceMiles(center, selected).toFixed(2)} mi from the business` : ""}`
              : "Select a colored marker to see the businesses ranking there."}
          </p>
          {selected && (
            <>
              <p
                className="my-4 rounded-xl p-3 text-sm font-semibold text-white"
                style={{
                  background: rankColor(selected.state, selected.position),
                }}
              >
                {selected.state === "complete"
                  ? selected.position
                    ? `Your position: ${selected.position}`
                    : "Not found in the first 100 results"
                  : `Check ${selected.state}`}
              </p>
              {selected.error && (
                <p className="text-xs text-red-700">{selected.error}</p>
              )}
              <ol className="space-y-3">
                {(selected.results ?? []).slice(0, 20).map((r, i) => (
                  <li key={`${r.place_id}-${i}`} className="flex gap-3 text-sm">
                    <span className="w-5 shrink-0 text-muted-foreground">
                      {r.position}
                    </span>
                    <span
                      className={
                        r.place_id === config.target_place_id
                          ? "font-semibold text-green-700"
                          : ""
                      }
                    >
                      {r.title}
                    </span>
                  </li>
                ))}
              </ol>
              {!selected.results && (
                <p className="text-xs text-muted-foreground">
                  Competitor details are unavailable for this point.
                </p>
              )}
            </>
          )}
        </aside>
      </div>
      <p className="text-xs text-muted-foreground">
        Radius is distance from the business, not diameter. Each radius
        shows the points this one scan actually sampled; nothing is
        interpolated, and switching radius never starts a scan. Top 3 coverage
        uses completed checks only. Average rank excludes points where the
        business was not found. Failed checks never count as ranking losses.{" "}
        <Link href={`/clients/${clientId}/keywords`} className="underline">
          Open keyword tracking
        </Link>
        .
      </p>
    </div>
  );
}
