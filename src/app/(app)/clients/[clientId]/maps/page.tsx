import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  MapGridDashboard,
  type GridRunView,
  type GridBaseline,
} from "@/components/map-grid-dashboard";
import type { GridCheck, GridConfig } from "@/lib/map-grid";
import { MapGridWeeklyNotice } from "@/components/map-grid-weekly-notice";
import { weeklyScanStatus, type WeeklyAttempt } from "@/lib/map-grid-weekly";
export default async function MapsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ run?: string; profile?: string }>;
}) {
  const { clientId } = await params;
  const { run: runId, profile: profileId } = await searchParams;
  const db = await createClient();
  // A client can have one profile per location (Logic Solar: Overland Park
  // and Wichita). Only this client's profiles are candidates, so a profile
  // id from another client is a 404, never a silent switch to other data.
  const { data: profiles, error } = await db
    .from("map_grid_profiles")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at");
  if (error) throw Error("Map grid configuration could not be loaded");
  const profile = profileId
    ? (profiles ?? []).find((p) => p.id === profileId)
    : profiles?.[0];
  if (profileId && !profile) notFound();
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
  const [checksResult, baselineResult, gridResult, attemptsResult] =
    await Promise.all([
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
      db
        .from("grid_configs")
        .select("center_lat,center_lng")
        .eq("id", profile.grid_config_id)
        .maybeSingle(),
      db
        .from("map_grid_weekly_attempts")
        .select("outcome,message,attempted_at,run_id")
        .eq("profile_id", profile.id)
        .order("attempted_at", { ascending: false })
        .limit(20),
    ]);
  if (checksResult.error || baselineResult.error || gridResult.error)
    throw Error("Grid results could not be loaded");
  const attempts = (attemptsResult.data ?? []) as WeeklyAttempt[];
  const weekly = weeklyScanStatus({
    enabled: profile.enabled,
    weeklyEnabled: profile.weekly_enabled,
    runs: runs ?? [],
    attempts,
    now: new Date().toISOString(),
  });
  const baselines: GridBaseline[] = [];
  const seen = new Set<string>();
  for (const b of baselineResult.data ?? []) {
    if (!seen.has(b.keyword_id)) {
      seen.add(b.keyword_id);
      baselines.push(b as unknown as GridBaseline);
    }
  }
  return (
    <div className="space-y-4">
      {attemptsResult.error ? (
        <p
          role="alert"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Weekly scan history could not be loaded; schedule health is unknown.
        </p>
      ) : (
        <MapGridWeeklyNotice status={weekly} attempts={attempts} />
      )}
      <MapGridDashboard
        key={`${profile.id}:${run?.id ?? "latest"}`}
        clientId={clientId}
        profiles={(profiles ?? []).map((p) => ({ id: p.id, label: p.label }))}
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
        homeCenter={
          gridResult.data?.center_lat != null &&
          gridResult.data?.center_lng != null
            ? {
                lat: Number(gridResult.data.center_lat),
                lng: Number(gridResult.data.center_lng),
              }
            : null
        }
      />
    </div>
  );
}
