import type { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import { workerLanes, type TaskView } from "@/lib/tasks";

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Enums = Database["public"]["Enums"];

// tasks has three FKs to team_members (assignee, created_by, updated_by), so
// every embed names its constraint.
const TASK_LIST_SELECT =
  "id, title, owner, status, due_date, client_id, autonomy_level, flagged_for_review, recommendation, playbook_step, completed_at, notes, created_at, updated_at, assignee_id, monthly_cycle_id, clients(id, name), client_stages(stages(name)), assignee:team_members!tasks_assignee_id_fkey(id, name), updater:team_members!tasks_updated_by_fkey(name)";

export type TaskListFilters = {
  view: TaskView;
  meId: string | null;
  today: string;
  clientId?: string;
  owner?: Enums["owner_type"];
  autonomy?: Enums["autonomy_level"];
  flagged?: boolean;
  limit?: number;
};

// One query for every work view, so the global Tasks page and a client's
// Tasks tab agree on what "mine", "unassigned" and "overdue" mean.
export async function fetchTaskList(supabase: Supabase, f: TaskListFilters) {
  let query = supabase
    .from("tasks")
    .select(TASK_LIST_SELECT)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(f.limit ?? 300);

  // Flagged is a review view: it includes work that is already done — "done,
  // review if you want". Everything else is open work.
  if (f.flagged) {
    query = query.eq("flagged_for_review", true).order("completed_at", { ascending: false });
  } else {
    query = query.neq("status", "done");
  }

  switch (f.view) {
    case "mine":
      // No team row (should not happen behind the layout) → an empty list, not everyone's.
      query = f.meId ? query.eq("assignee_id", f.meId) : query.eq("id", "00000000-0000-0000-0000-000000000000");
      break;
    case "unassigned":
      query = query.is("assignee_id", null).not("owner", "in", `(${workerLanes.join(",")})`);
      break;
    case "overdue":
      query = query.lt("due_date", f.today);
      break;
  }

  if (f.clientId) query = query.eq("client_id", f.clientId);
  if (f.owner) query = query.eq("owner", f.owner);
  if (f.autonomy) query = query.eq("autonomy_level", f.autonomy);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export type TaskListRow = Awaited<ReturnType<typeof fetchTaskList>>[number];

// Badge counts for the view tabs (open work only).
export async function fetchViewCounts(
  supabase: Supabase,
  f: { meId: string | null; today: string; clientId?: string }
) {
  const base = () => {
    let q = supabase.from("tasks").select("id", { count: "exact", head: true }).neq("status", "done");
    if (f.clientId) q = q.eq("client_id", f.clientId);
    return q;
  };
  const [mine, unassigned, overdue] = await Promise.all([
    f.meId ? base().eq("assignee_id", f.meId) : Promise.resolve({ count: 0 }),
    base().is("assignee_id", null).not("owner", "in", `(${workerLanes.join(",")})`),
    base().lt("due_date", f.today),
  ]);
  return { mine: mine.count ?? 0, unassigned: unassigned.count ?? 0, overdue: overdue.count ?? 0 };
}
