"use server";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
export async function startMapGridAction(
  clientId: string,
  profileId: string,
  requestKey: string,
): Promise<{ runId?: string; error?: string }> {
  const db = await createClient();
  const { data: profile, error } = await db
    .from("map_grid_profiles")
    .select("id")
    .eq("id", profileId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !profile)
    return { error: "Grid is unavailable for this client" };
  const {
    data: { session },
  } = await db.auth.getSession();
  if (!session) return { error: "Sign in again to start a scan" };
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/map-grid-sync`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "start",
          profile_id: profileId,
          request_key: requestKey,
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    const result = await res.json();
    if (!res.ok) return { error: result.error || "Unable to start scan" };
    revalidatePath(`/clients/${clientId}/maps`);
    return { runId: result.run_id };
  } catch {
    return {
      error: "Could not confirm the scan. Refresh before trying again.",
    };
  }
}
