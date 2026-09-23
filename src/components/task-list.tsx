import Link from "next/link";
import { toggleTaskAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { AssigneeSelect } from "@/components/task-forms";
import { ownerLabels } from "@/lib/labels";
import type { TaskListRow } from "@/lib/task-queries";
import { canAssignLane, formatStamp, isOverdue, taskStatusLabels, WORKER_ACTOR } from "@/lib/tasks";
import type { Database } from "@/lib/database.types";
import { cn } from "@/lib/utils";

type Autonomy = Database["public"]["Enums"]["autonomy_level"];

export const autonomyLabels: Record<Autonomy, { label: string; hint: string }> = {
  run: { label: "Run", hint: "Claude does it and logs it" },
  run_flag: { label: "Run + flag", hint: "Claude does it; review if you want" },
  hold: { label: "Hold", hint: "waits on a decision" },
};

const autonomyStyles: Record<Autonomy, string> = {
  run: "bg-zinc-100 text-zinc-600 border-zinc-200",
  run_flag: "bg-amber-100 text-amber-800 border-amber-200",
  hold: "bg-red-100 text-red-800 border-red-200",
};

type Member = { id: string; name: string };

export function TaskList({
  tasks,
  members,
  meId,
  today,
  showClient = true,
  showRecommendation = false, // also show notes (the flagged review view)
  empty = "No open tasks.",
}: {
  tasks: TaskListRow[];
  members: Member[];
  meId: string | null;
  today: string;
  showClient?: boolean;
  showRecommendation?: boolean;
  empty?: string;
}) {
  return (
    <div className="surface divide-y overflow-hidden">
      {tasks.length === 0 && <p className="p-4 text-sm text-muted-foreground">{empty}</p>}
      {tasks.map((task) => {
        const done = task.status === "done";
        const overdue = isOverdue(task, today);
        const toggle = toggleTaskAction.bind(null, task.client_id, task.id, !done);
        const where = task.client_stages?.stages?.name ?? (task.monthly_cycle_id ? "Monthly cycle" : null);
        return (
          <div
            key={task.id}
            className="grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_10rem] gap-x-3 gap-y-2 px-4 py-3.5 text-sm transition-colors hover:bg-mist-50"
          >
            <form action={toggle} className="pt-0.5">
              <button
                type="submit"
                className={cn("size-4 rounded-[5px] border border-input bg-card hover:border-navy-500", done && "border-primary bg-primary")}
                title={done ? "Reopen" : "Mark done"}
                aria-label={done ? `Reopen “${task.title}”` : `Mark “${task.title}” done`}
              />
            </form>
            <div className="min-w-0 space-y-1">
              <Link
                href={`/tasks/${task.id}`}
                className={cn("font-medium hover:underline break-words", done && "line-through text-muted-foreground")}
              >
                {task.title}
              </Link>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {showClient && task.clients && (
                  <Link href={`/clients/${task.clients.id}/tasks`} className="hover:underline">
                    {task.clients.name}
                  </Link>
                )}
                {where && <span>{where}</span>}
                {task.status !== "open" && !done && (
                  <span className={cn(task.status === "blocked" && "text-red-700 font-medium")}>
                    {taskStatusLabels[task.status]}
                  </span>
                )}
                <Badge variant="outline" className="text-[10px]" title="Worker lane">
                  {ownerLabels[task.owner]}
                </Badge>
                {task.autonomy_level && (
                  <Badge
                    variant="outline"
                    className={cn("text-[10px]", autonomyStyles[task.autonomy_level])}
                    title={task.playbook_step ?? autonomyLabels[task.autonomy_level].hint}
                  >
                    {autonomyLabels[task.autonomy_level].label}
                  </Badge>
                )}
                {task.flagged_for_review && (
                  <Badge variant="outline" className="text-[10px] bg-amber-100 text-amber-800 border-amber-200">
                    flagged
                  </Badge>
                )}
                {task.due_date && (
                  <span className={cn(overdue && "text-red-700 font-medium")}>
                    {overdue ? "Overdue · " : "Due "}
                    {task.due_date}
                  </span>
                )}
                {task.updated_at && (
                  <span title={task.updated_at}>
                    Updated by {task.updater?.name ?? WORKER_ACTOR}, {formatStamp(task.updated_at)}
                  </span>
                )}
              </div>
              {(task.recommendation || (showRecommendation && task.notes)) && (
                <p className="text-xs text-muted-foreground">{task.recommendation ?? task.notes}</p>
              )}
            </div>
            {canAssignLane(task.owner) ? (
              <AssigneeSelect
                taskId={task.id}
                assigneeId={task.assignee_id}
                members={members}
                meId={meId}
                className="col-start-2 sm:col-start-3 sm:row-start-1"
              />
            ) : (
              <p
                className="col-start-2 sm:col-start-3 sm:row-start-1 text-xs text-muted-foreground sm:pt-1.5"
                title="The worker runs CLAUDE tasks; they are not assigned to a person"
              >
                Worker runs this
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
