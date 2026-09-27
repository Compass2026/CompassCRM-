"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { sameSnapshot, type WorkflowSnapshot } from "@/lib/authority-lifecycle";

// Draft with AI (0053). The request is authority_apply('request_draft') as
// the signed-in teammate: one CLAUDE request task per opportunity (reused and
// restarted if one is open or blocked), the opportunity accepted, the team's
// decision recorded and the worker started. The worker drafts through
// post-drafter v2; the draft stops in human review. Nothing here writes a
// post, approves, schedules or publishes.

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const CHANGED = "This opportunity changed since the page loaded. The page now shows its current state.";

export type DraftAnswer = { ok: true; text: string } | { ok: false; text: string; changed?: boolean };

async function teammate(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  try { await requireTeamMember(supabase); return true; } catch { return false; }
}
const started = (fired: unknown) => (fired
  ? "The worker was started; the draft will appear here in review."
  : "The request is saved, but the worker did not start just now (it was started moments ago, or the Routine isn't configured). Use Restart in a few minutes.");

export async function requestDraftAction(clientId: string, opportunityId: string, page: WorkflowSnapshot & { runId: string }): Promise<DraftAnswer> {
  if (!isUuid(clientId) || !isUuid(opportunityId) || !isUuid(page.runId)) return { ok: false, text: "Unknown opportunity." };
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { ok: false, text: NOT_TEAM };
  const { data: o } = await supabase.from("authority_opportunities")
    .select("id, status, suppressed, dismissed_until, present, last_seen_run_id")
    .eq("id", opportunityId).eq("client_id", clientId).maybeSingle();
  if (!o) return { ok: false, text: "This opportunity no longer exists.", changed: true };
  if (!o.present || o.last_seen_run_id !== page.runId || !sameSnapshot(o as WorkflowSnapshot, page)) {
    revalidatePath(`/clients/${clientId}/authority`);
    return { ok: false, text: CHANGED, changed: true };
  }
  const { data, error } = await supabase.rpc("authority_apply", {
    p_opportunity_id: opportunityId, p_action: "request_draft", p_payload: {},
    p_expected: { run_id: o.last_seen_run_id, status: o.status, suppressed: o.suppressed, dismissed_until: o.dismissed_until },
  });
  revalidatePath(`/clients/${clientId}/authority`);
  if (error) {
    if (error.code === "AU409") return { ok: false, text: `${error.message.replace(/^Changed since the preview: /, "Changed since the page loaded: ")}.`, changed: true };
    if (error.code === "42501") return { ok: false, text: NOT_TEAM };
    return { ok: false, text: error.message };
  }
  const row = ((data as { rows?: { reused?: boolean; started?: { fired?: boolean } }[] })?.rows ?? [])[0];
  return { ok: true, text: `${row?.reused ? "The open request was restarted." : "Draft with AI requested."} ${started(row?.started?.fired)}` };
}

// Restart the worker for an open request (a start that failed or never ran).
// Never a second request: the same task, the same eventual post.
export async function restartDraftAction(clientId: string, taskId: string): Promise<DraftAnswer> {
  if (!isUuid(clientId) || !isUuid(taskId)) return { ok: false, text: "Unknown request." };
  const supabase = await createClient();
  if (!(await teammate(supabase))) return { ok: false, text: NOT_TEAM };
  const { data: t } = await supabase.from("tasks").select("id, key, status").eq("id", taskId).eq("client_id", clientId).maybeSingle();
  if (!t || !t.key?.startsWith("authority_draft:")) return { ok: false, text: "This request no longer exists.", changed: true };
  const { data, error } = await supabase.rpc("authority_draft_start", { p_task_id: taskId });
  revalidatePath(`/clients/${clientId}/authority`);
  if (error) return { ok: false, text: error.code === "42501" ? NOT_TEAM : error.message };
  const r = data as { fired?: boolean; reason?: string };
  if (!r?.fired && r?.reason && !r.reason.startsWith("Authority draft request")) return { ok: false, text: `Not restarted: ${r.reason}.`, changed: true };
  return { ok: true, text: started(r?.fired) };
}
