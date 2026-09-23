import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { NewTaskForm } from "@/components/task-forms";
import { TaskList } from "@/components/task-list";
import { fetchTaskList, fetchViewCounts } from "@/lib/task-queries";
import { getCurrentTeamMember, listTeamMembers } from "@/lib/team";
import { parseTaskView, taskViews, todayIn } from "@/lib/tasks";
import { chip } from "@/lib/nav-styles";

// The client's work in one place: pipeline checklists, monthly-cycle tasks
// and anything the team adds by hand. "By client" makes no sense here.
const views = taskViews.filter((v) => v.value !== "by_client");

export default async function ClientTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { clientId } = await params;
  const { view: rawView } = await searchParams;
  const view = parseTaskView(rawView === "by_client" ? undefined : rawView);
  const supabase = await createClient();
  const today = todayIn();

  const [me, members] = await Promise.all([getCurrentTeamMember(supabase), listTeamMembers(supabase)]);
  const meId = me?.id ?? null;
  const [tasks, counts] = await Promise.all([
    fetchTaskList(supabase, { view, meId, today, clientId }),
    fetchViewCounts(supabase, { meId, today, clientId }),
  ]);
  const badge: Partial<Record<string, number>> = counts;
  const base = `/clients/${clientId}/tasks`;

  return (
    <div className="space-y-4">
      <section className="surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold mb-3">New task</h2>
        <NewTaskForm members={members} meId={meId} clientId={clientId} />
      </section>

      <nav aria-label="Work views" className="flex gap-2 flex-wrap">
        {views.map((v) => (
          <Link
            key={v.value}
            href={v.value === "all" ? base : `${base}?view=${v.value}`}
            title={v.hint}
            aria-current={view === v.value ? "page" : undefined}
            className={chip(view === v.value)}
          >
            {v.label}
            {badge[v.value] ? ` · ${badge[v.value]}` : ""}
          </Link>
        ))}
      </nav>

      <TaskList
        tasks={tasks}
        members={members}
        meId={meId}
        today={today}
        showClient={false}
        empty={view === "all" ? "No open tasks for this client." : "Nothing here."}
      />
    </div>
  );
}
