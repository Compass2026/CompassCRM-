"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamMember, requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import {
  CHANGED_SINCE_LOADED,
  decideErrorText,
  doneText,
  planDecision,
  sameSnapshot,
  type DecideInput,
  type WorkflowSnapshot,
} from "@/lib/authority-lifecycle";
import type { Mode, RunStatus, StartOutcome } from "@/lib/authority-controls";
import { callAuthorityRun } from "@/lib/authority-run-call";

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
  const outcome = await callAuthorityRun(supabase, clientId, mode);
  revalidatePath(`/clients/${clientId}/authority`);
  return outcome;
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

// ── Lifecycle decisions (authority_decide, 0048) ────────────────────────────
// Accept, release, dismiss for 30 / 60 / 90 days, never recommend again and
// reopen. Authority workflow only: no client data changes and no analysis
// starts. The page's snapshot of the stored workflow comes back with the
// request, so a second tab or a repeated click cannot act on a state it did
// not see; authority_decide then enforces every rule again.
export type DecideResult = { ok: true; text: string } | { ok: false; text: string; changed?: boolean };

export async function decideAuthorityAction(clientId: string, opportunityId: string, input: DecideInput): Promise<DecideResult> {
  if (!isUuid(clientId) || !isUuid(opportunityId)) return { ok: false, text: "Unknown opportunity." };
  const supabase = await createClient();
  try {
    await requireTeamMember(supabase);
  } catch {
    return { ok: false, text: NOT_TEAM };
  }
  const plan = planDecision(input, new Date());
  if ("error" in plan) return { ok: false, text: plan.error };

  const { data: current, error: readError } = await supabase
    .from("authority_opportunities")
    .select("status, suppressed, dismissed_until")
    .eq("id", opportunityId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (readError) return { ok: false, text: decideErrorText(readError) };
  if (!current) return { ok: false, text: "This opportunity no longer exists." };
  if (!input.expected || !sameSnapshot(current as WorkflowSnapshot, input.expected)) {
    revalidatePath(`/clients/${clientId}/authority`);
    return { ok: false, text: CHANGED_SINCE_LOADED, changed: true };
  }

  const { error } = await supabase.rpc("authority_decide", { p_opportunity_id: opportunityId, p_verb: plan.verb, p_payload: plan.payload });
  revalidatePath(`/clients/${clientId}/authority`);
  if (error) return { ok: false, text: decideErrorText(error) };
  return { ok: true, text: doneText(plan.verb, plan.payload) };
}
