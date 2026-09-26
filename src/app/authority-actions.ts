"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { START_TIMEOUT_MS, startOutcome, type Mode, type RunStatus, type StartOutcome } from "@/lib/authority-controls";

// The Authority tab's two controls. Neither writes to the database: starting a
// run is the authority-run Edge Function's job (authority_begin_run makes the
// row, one running run per client), and the status read is the teammate's
// own under RLS. The function checks the JWT against team_members itself;
// checking here too keeps a non-team sign-in from reaching it at all.

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";

export async function startAuthorityRunAction(clientId: string, mode: Mode): Promise<StartOutcome> {
  if (!isUuid(clientId)) return { kind: "error", text: "Unknown client." };
  if (mode !== "full" && mode !== "refresh") return { kind: "error", text: "Unknown analysis mode." };
  const supabase = await createClient();
  if (!(await getCurrentTeamMember(supabase))) return { kind: "error", text: NOT_TEAM };
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { kind: "error", text: NOT_TEAM };

  let status: number | null = null;
  let body: unknown = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/authority-run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode, client_id: clientId }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      cache: "no-store",
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    // Timeout or network error: the run may or may not have begun.
    status = null;
  }
  revalidatePath(`/clients/${clientId}/authority`);
  return startOutcome(mode, status, body);
}

// One run's status, for the watcher: the run, "missing" when it is not
// visible, or a failure to read it (the watcher tries again).
export type RunStatusAnswer = { run: RunStatus } | { missing: true } | { failure: string };

export async function authorityRunStatusAction(clientId: string, runId: string): Promise<RunStatusAnswer> {
  if (!isUuid(clientId) || !isUuid(runId)) return { missing: true };
  const supabase = await createClient();
  if (!(await getCurrentTeamMember(supabase))) return { failure: NOT_TEAM };
  const { data, error } = await supabase
    .from("authority_runs")
    .select("id, status, mode, diff, error, health:inventory->health")
    .eq("id", runId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) return { failure: error.message };
  return data ? { run: data as unknown as RunStatus } : { missing: true };
}
