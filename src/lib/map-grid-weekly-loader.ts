import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { completeRead } from "./integration-health.ts";
import { weeklyScanStatus, type WeeklyAttempt } from "./map-grid-weekly.ts";
import type { MapGridWeekly } from "./operations-readiness";

// Weekly-scheduled map-grid profiles and their schedule health. Team RLS
// reads only; null means a read failed or was truncated (never "healthy").
export async function loadMapGridWeekly(
  db: SupabaseClient<Database>,
  clientIds: string[],
  now: string,
): Promise<MapGridWeekly[] | null> {
  if (!clientIds.length) return [];
  const profilesQ = await db
    .from("map_grid_profiles")
    .select("id,client_id,label,enabled,weekly_enabled", { count: "exact" })
    .in("client_id", clientIds)
    .eq("weekly_enabled", true)
    .limit(500);
  const profiles = completeRead(profilesQ);
  if (profiles === null) return null;
  if (!profiles.length) return [];
  const ids = profiles.map((p) => p.id);
  const since = new Date(Date.parse(now) - 60 * 86400000).toISOString();
  const [runsQ, attemptsQ] = await Promise.all([
    db
      .from("map_grid_runs")
      .select("profile_id,started_at,status,error", { count: "exact" })
      .in("profile_id", ids)
      .gte("started_at", since)
      .limit(3000),
    db
      .from("map_grid_weekly_attempts")
      .select("profile_id,outcome,message,attempted_at,run_id", { count: "exact" })
      .in("profile_id", ids)
      .gte("attempted_at", since)
      .limit(3000),
  ]);
  const runs = completeRead(runsQ),
    attempts = completeRead(attemptsQ);
  if (runs === null || attempts === null) return null;
  return profiles.map((p) => ({
    clientId: p.client_id,
    profileId: p.id,
    label: p.label,
    status: weeklyScanStatus({
      enabled: p.enabled,
      weeklyEnabled: p.weekly_enabled,
      runs: runs.filter((r) => r.profile_id === p.id),
      attempts: attempts.filter((a) => a.profile_id === p.id) as WeeklyAttempt[],
      now,
    }),
  }));
}
