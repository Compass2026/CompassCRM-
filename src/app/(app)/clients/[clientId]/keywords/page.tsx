import { createClient } from "@/lib/supabase/server";
import {
  addKeywordAction,
  deleteKeywordAction,
  importRankCsvAction,
  runBrightLocalSyncAction,
  updateKeywordAction,
} from "@/app/rank-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LocationsPanel } from "@/components/locations-panel";
import { GridConfigCard } from "@/components/grid-config-card";
import { cn } from "@/lib/utils";

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs";

function heat(position: number | null | undefined): string {
  if (position == null) return "text-muted-foreground";
  if (position <= 3) return "bg-green-100 text-green-800";
  if (position <= 10) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

export default async function KeywordsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  const [{ data: keywords }, { data: locations }, { data: snapshots }] =
    await Promise.all([
      supabase
        .from("keywords")
        .select("*")
        .eq("client_id", clientId)
        .order("priority")
        .order("keyword"),
      supabase
        .from("locations")
        .select("*")
        .eq("client_id", clientId)
        .order("is_physical_location", { ascending: false })
        .order("name"),
      supabase
        .from("rank_snapshots")
        .select(
          "keyword_id, location_id, result_type, position, recorded_at, keywords!inner(client_id)"
        )
        .eq("keywords.client_id", clientId)
        .order("recorded_at", { ascending: false })
        .limit(4000),
    ]);

  const physicalLocations = (locations ?? []).filter(
    (l) => l.is_physical_location
  );
  const { data: gridConfigs } = physicalLocations.length
    ? await supabase
        .from("grid_configs")
        .select("*")
        .in(
          "location_id",
          physicalLocations.map((l) => l.id)
        )
    : { data: [] };

  const [{ data: lastRun }, { data: gridSnaps }] = await Promise.all([
    supabase
      .from("rank_runs")
      .select("triggered_by, status, started_at, completed_at, checks_count, error")
      .eq("client_id", clientId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    (gridConfigs ?? []).length
      ? supabase
          .from("grid_snapshots")
          .select("grid_config_id, keyword_id, avg_map_rank, recorded_at, report_url, keywords(keyword)")
          .in("grid_config_id", (gridConfigs ?? []).map((g) => g.id))
          .order("recorded_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] }),
  ]);

  // Latest grid snapshot per config × keyword
  const latestGrid = new Map<string, NonNullable<typeof gridSnaps>[number]>();
  for (const g of gridSnaps ?? []) {
    const key = `${g.grid_config_id}:${g.keyword_id}`;
    if (!latestGrid.has(key)) latestGrid.set(key, g);
  }

  // Latest position per keyword × location × result_type (snapshots are
  // ordered newest first, so first hit wins).
  const latest = new Map<string, number | null>();
  for (const s of snapshots ?? []) {
    const key = `${s.keyword_id}:${s.location_id}:${s.result_type}`;
    if (!latest.has(key)) latest.set(key, s.position);
  }

  const activeKeywords = (keywords ?? []).filter((k) => k.is_active);
  const activeLocations = (locations ?? []).filter((l) => l.is_active);
  const hasRankData = latest.size > 0;

  // City Index: per location, average of best positions across P1 keywords.
  function cityIndex(locationId: string, type: "organic" | "map_pack") {
    const positions = activeKeywords
      .filter((k) => k.priority === "p1")
      .map((k) => latest.get(`${k.id}:${locationId}:${type}`))
      .filter((p): p is number => typeof p === "number");
    if (positions.length === 0) return null;
    return (
      Math.round(
        (positions.reduce((a, b) => a + b, 0) / positions.length) * 10
      ) / 10
    );
  }

  const addKeyword = addKeywordAction.bind(null, clientId);
  const importCsv = importRankCsvAction.bind(null, clientId);
  const runSync = runBrightLocalSyncAction.bind(null, clientId);
  const hasBrightLocal = (locations ?? []).some(
    (l) => l.brightlocal_lrt_report_id
  );

  return (
    <div className="space-y-4">
      {hasBrightLocal && (
        <div className="flex items-center gap-3 border rounded-md bg-card px-3 py-2">
          <form action={runSync}>
            <Button type="submit" size="sm">
              Sync BrightLocal now
            </Button>
          </form>
          <span className="text-xs text-muted-foreground">
            {lastRun
              ? `Last sync: ${lastRun.status} · ${lastRun.started_at?.slice(0, 16).replace("T", " ")} UTC · ${lastRun.checks_count ?? 0} snapshots (${lastRun.triggered_by})`
              : "No syncs yet — BrightLocal reports run weekly; sync pulls the latest results."}
            {lastRun?.error && ` · ${lastRun.error.slice(0, 120)}`}
          </span>
        </div>
      )}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Keywords</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-2">Keyword</th>
                  <th className="py-2 pr-2">Target URL</th>
                  <th className="py-2 pr-2">Priority</th>
                  <th className="py-2 pr-2">Dept</th>
                  <th className="py-2 pr-2">Best local</th>
                  <th className="py-2 pr-2">Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(keywords ?? []).map((k) => {
                  const best = activeLocations
                    .flatMap((l) => [
                      latest.get(`${k.id}:${l.id}:organic`),
                      latest.get(`${k.id}:${l.id}:map_pack`),
                    ])
                    .filter((p): p is number => typeof p === "number")
                    .sort((a, b) => a - b)[0];
                  return (
                    <tr key={k.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium">{k.keyword}</td>
                      <td className="py-1.5 pr-2" colSpan={3}>
                        <form
                          action={updateKeywordAction.bind(null, clientId, k.id)}
                          className="flex items-center gap-2"
                        >
                          <Input
                            name="target_url"
                            defaultValue={k.target_url ?? ""}
                            placeholder="/service-page"
                            className="h-8 text-xs min-w-40"
                          />
                          <select name="priority" defaultValue={k.priority} className={selectClass}>
                            <option value="p1">P1</option>
                            <option value="p2">P2</option>
                            <option value="p3">P3</option>
                          </select>
                          <span className="text-xs text-muted-foreground w-16">
                            {k.department}
                          </span>
                          <span className={cn("px-1.5 py-0.5 rounded text-xs", heat(best))}>
                            {best ?? "—"}
                          </span>
                          <label className="text-xs flex items-center gap-1">
                            <input type="checkbox" name="is_active" defaultChecked={k.is_active} />
                          </label>
                          <Button type="submit" variant="ghost" size="sm">
                            Save
                          </Button>
                        </form>
                      </td>
                      <td className="py-1.5 text-right" colSpan={3}>
                        <form action={deleteKeywordAction.bind(null, clientId, k.id)}>
                          <Button variant="ghost" size="sm" type="submit">
                            ✕
                          </Button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
                {(keywords ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-3 text-muted-foreground text-sm">
                      No keywords yet — add the target set below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <form action={addKeyword} className="flex gap-2 flex-wrap border-t pt-3">
            <Input name="keyword" placeholder="New keyword" required className="h-8 flex-1 min-w-48" />
            <Input name="target_url" placeholder="Target URL" className="h-8 w-44" />
            <select name="priority" defaultValue="p2" className={selectClass}>
              <option value="p1">P1</option>
              <option value="p2">P2</option>
              <option value="p3">P3</option>
            </select>
            <select name="department" defaultValue="seo" className={selectClass}>
              <option value="seo">SEO</option>
              <option value="website">Website</option>
              <option value="social">Social</option>
              <option value="paid_ads">Paid Ads</option>
            </select>
            <Button type="submit" size="sm">
              Add keyword
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <LocationsPanel clientId={clientId} locations={locations ?? []} />

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Geo-grids (Mode B)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              One grid per physical location. Use the radius helper — e.g. 5
              miles → a 7×7 grid at 1.7-mile spacing spanning that radius.
            </p>
            {physicalLocations.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No physical locations — mark one as physical (or add via
                search) to configure a grid.
              </p>
            )}
            {physicalLocations.map((loc) => {
              const config =
                (gridConfigs ?? []).find((g) => g.location_id === loc.id) ??
                null;
              const snaps = config
                ? [...latestGrid.entries()]
                    .filter(([k]) => k.startsWith(`${config.id}:`))
                    .map(([, v]) => v)
                : [];
              return (
                <div key={loc.id} className="space-y-1">
                  <GridConfigCard
                    clientId={clientId}
                    locationId={loc.id}
                    locationName={loc.name}
                    locationLat={loc.lat}
                    locationLng={loc.lng}
                    config={config}
                    activeKeywordCount={activeKeywords.length}
                  />
                  {snaps.length > 0 && (
                    <div className="border rounded-md px-3 py-2 bg-muted/30 text-xs space-y-1">
                      <p className="text-muted-foreground">
                        Latest grid run ({snaps[0].recorded_at?.slice(0, 10)}) —
                        avg map rank per keyword:
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {snaps.map((s) => (
                          <span key={s.keyword_id}>
                            {s.keywords?.keyword}:{" "}
                            <span
                              className={cn(
                                "px-1 py-0.5 rounded font-medium",
                                heat(
                                  s.avg_map_rank == null
                                    ? null
                                    : Math.round(Number(s.avg_map_rank))
                                )
                              )}
                            >
                              {s.avg_map_rank ?? "—"}
                            </span>
                          </span>
                        ))}
                        {snaps[0].report_url && (
                          <a
                            href={snaps[0].report_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            View grid →
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Rank matrix — keyword × city (Mode A)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeKeywords.length === 0 || activeLocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add keywords and tracked locations to see the matrix.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left py-2 pr-3 font-normal">
                      organic / map pack
                    </th>
                    {activeLocations.map((l) => (
                      <th key={l.id} className="px-2 py-2 font-medium text-foreground">
                        {l.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeKeywords.map((k) => (
                    <tr key={k.id} className="border-t">
                      <td className="py-1.5 pr-3">
                        {k.keyword}
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          {k.priority.toUpperCase()}
                        </Badge>
                      </td>
                      {activeLocations.map((l) => {
                        const org = latest.get(`${k.id}:${l.id}:organic`);
                        const map = latest.get(`${k.id}:${l.id}:map_pack`);
                        return (
                          <td key={l.id} className="px-2 py-1.5 text-center">
                            <span className={cn("px-1.5 py-0.5 rounded", heat(org))}>
                              {org ?? "—"}
                            </span>
                            <span className="text-muted-foreground mx-0.5">/</span>
                            <span className={cn("px-1.5 py-0.5 rounded", heat(map))}>
                              {map ?? "—"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t bg-muted/40">
                    <td className="py-1.5 pr-3 text-xs font-medium">
                      City Index (P1 avg)
                    </td>
                    {activeLocations.map((l) => (
                      <td key={l.id} className="px-2 py-1.5 text-center text-xs">
                        {cityIndex(l.id, "organic") ?? "—"} /{" "}
                        {cityIndex(l.id, "map_pack") ?? "—"}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {!hasRankData && activeKeywords.length > 0 && activeLocations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              No rank data yet — import a CSV below or wait for the BrightLocal
              sync (next build step).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Import ranks (CSV fallback)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Columns: <code>keyword, location, position, date, type</code> — type
            is <code>organic</code> (default) or <code>map_pack</code>; blank
            position = not in top 100. Rows match existing keywords and
            locations by name.
          </p>
          <form action={importCsv} className="flex gap-2 items-center">
            <Input name="file" type="file" accept=".csv,text/csv" required className="max-w-xs" />
            <Button type="submit" variant="outline" size="sm">
              Import
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
