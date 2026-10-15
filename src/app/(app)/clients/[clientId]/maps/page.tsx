import { createClient } from "@/lib/supabase/server";
import {
  MapGridDashboard,
  type GridRunView,
  type GridBaseline,
} from "@/components/map-grid-dashboard";
import type { GridCheck, GridConfig } from "@/lib/map-grid";
export default async function MapsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { clientId } = await params;
  const { run: runId } = await searchParams;
  const db = await createClient();
  const { data: profile, error } = await db
    .from("map_grid_profiles")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw Error("Map grid configuration could not be loaded");
  if (!profile)
    return (
      <div className="rounded-2xl border bg-card p-8">
        <h2 className="text-xl font-semibold">Map rankings</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This client is not enrolled in the grid pilot yet. Existing keyword
          tracking continues in Keywords.
        </p>
      </div>
    );
  const { data: runs, error: runsError } = await db
    .from("map_grid_runs")
    .select("id,started_at,status,error,config")
    .eq("profile_id", profile.id)
    .order("started_at", { ascending: false })
    .limit(30);
  if (runsError) throw Error("Scan history could not be loaded");
  const run = (runs ?? []).find((r) => r.id === runId) ?? runs?.[0] ?? null;
  const [checksResult, baselineResult] = await Promise.all([
    run
      ? db
          .from("map_grid_checks")
          .select(
            "id,keyword_id,keyword,point_index,lat,lng,state,position,results,cost,error,checked_at",
          )
          .eq("run_id", run.id)
          .order("point_index")
          .limit(1000)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("grid_snapshots")
      .select("keyword_id,recorded_at,points")
      .eq("grid_config_id", profile.grid_config_id)
      .order("recorded_at", { ascending: false })
      .limit(100),
  ]);
  if (checksResult.error || baselineResult.error)
    throw Error("Grid results could not be loaded");
  const baselines: GridBaseline[] = [];
  const seen = new Set<string>();
  for (const b of baselineResult.data ?? []) {
    if (!seen.has(b.keyword_id)) {
      seen.add(b.keyword_id);
      baselines.push(b as unknown as GridBaseline);
    }
  }
  return (
    <MapGridDashboard
      key={run?.id ?? profile.id}
      clientId={clientId}
      profile={{
        id: profile.id,
        label: profile.label,
        enabled: profile.enabled,
        weekly_enabled: profile.weekly_enabled,
        config: profile as unknown as GridConfig,
      }}
      runs={(runs ?? []) as unknown as GridRunView[]}
      run={run as unknown as GridRunView | null}
      checks={(checksResult.data ?? []) as unknown as GridCheck[]}
      baselines={baselines}
    />
  );
}
