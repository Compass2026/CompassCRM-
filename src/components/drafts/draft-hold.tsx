import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { isRoutine, liveHold, type ClaimHolder } from "@/lib/draft-reservations";
import { formatStamp } from "@/lib/tasks";

type Hold = { by: string; until: string };

// The live claim on each draft's task (request task, or the weekly blog_post
// task), keyed by draft id. The teammate's own reads (is_team()).
export async function loadDraftHolds(supabase: SupabaseClient<Database>, draftIds: string[]): Promise<Map<string, Hold>> {
  const out = new Map<string, Hold>();
  if (!draftIds.length) return out;
  const { data: drafts } = await supabase.from("content_drafts").select("id, request_task_id, source_task_id").in("id", draftIds);
  const taskOf = new Map((drafts ?? []).flatMap((d) => {
    const t = d.request_task_id ?? d.source_task_id;
    return t ? [[d.id, t] as const] : [];
  }));
  if (!taskOf.size) return out;
  const { data: tasks } = await supabase.from("tasks").select("id, claimed_by, claimed_at").in("id", [...new Set(taskOf.values())]);
  const byTask = new Map((tasks ?? []).map((t) => [t.id, t as ClaimHolder]));
  for (const [draftId, taskId] of taskOf) {
    const hold = liveHold(byTask.get(taskId));
    if (hold) out.set(draftId, hold);
  }
  return out;
}

// "Held by claude-operator until Oct 18, 5:51 PM" — the Planner and the draft page.
export function DraftHoldNote({ hold, className }: { hold: Hold | null | undefined; className?: string }) {
  if (!hold) return null;
  return (
    <span className={className ?? "text-xs text-muted-foreground"} data-draft-hold={hold.by}>
      {isRoutine(hold.by) ? "The worker Routine holds it" : <>Held by <span className="font-medium text-foreground">{hold.by}</span></>}
      {" "}until {formatStamp(hold.until)}
    </span>
  );
}
