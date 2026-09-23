import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { TaskCommentForm, TaskEditForm } from "@/components/task-forms";
import { autonomyLabels } from "@/components/task-list";
import { ownerLabels } from "@/lib/labels";
import { getCurrentTeamMember, listTeamMembers } from "@/lib/team";
import {
  actorName,
  describeEvent,
  formatStamp,
  isOverdue,
  isUuid,
  todayIn,
  WORKER_ACTOR,
} from "@/lib/tasks";

type Entry =
  | { type: "event"; at: string; id: string; text: string }
  | { type: "comment"; at: string; id: string; author: string; body: string };

export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  if (!isUuid(taskId)) notFound();
  const supabase = await createClient();

  const [{ data: task }, me, members, { data: events }, { data: comments }] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, title, status, owner, autonomy_level, playbook_step, flagged_for_review, recommendation, due_date, notes, created_at, updated_at, completed_at, assignee_id, created_by, updated_by, client_id, monthly_cycle_id, clients(id, name), client_stages(stages(name)), monthly_cycles(period)"
      )
      .eq("id", taskId)
      .maybeSingle(),
    getCurrentTeamMember(supabase),
    listTeamMembers(supabase),
    supabase
      .from("task_events")
      .select("id, kind, from_value, to_value, actor_id, created_at")
      .eq("task_id", taskId)
      .order("created_at"),
    supabase
      .from("task_comments")
      .select("id, body, author_id, created_at")
      .eq("task_id", taskId)
      .order("created_at"),
  ]);
  if (!task) notFound();

  const names = new Map(members.map((m) => [m.id, m.name]));
  const today = todayIn();
  const where = task.client_stages?.stages?.name
    ? `${task.client_stages.stages.name} (pipeline stage)`
    : task.monthly_cycles?.period
      ? `Monthly cycle ${task.monthly_cycles.period.slice(0, 7)}`
      : null;

  // Tasks that predate 0043 have no events; their creation still shows.
  const entries: Entry[] = [
    ...(events ?? []).map((e) => ({
      type: "event" as const,
      at: e.created_at,
      id: e.id,
      text: describeEvent(e, names),
    })),
    ...(comments ?? []).map((c) => ({
      type: "comment" as const,
      at: c.created_at,
      id: c.id,
      author: actorName(c.author_id, names),
      body: c.body,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!(events ?? []).some((e) => e.kind === "created")) {
    entries.unshift({ type: "event", at: task.created_at, id: "created", text: "Created (before task history was recorded)" });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-1">
        <Link
          href="/tasks"
          className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors"
        >
          &larr; Tasks
        </Link>
        <h1 className="page-title kicker break-words">{task.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {task.clients && (
            <Link href={`/clients/${task.clients.id}/tasks`} className="hover:underline text-foreground">
              {task.clients.name}
            </Link>
          )}
          {where && <span>{where}</span>}
          {isOverdue(task, today) && <span className="text-red-700 font-medium">Overdue</span>}
        </div>
      </div>

      <section className="surface p-4 sm:p-5 space-y-3">
        <TaskEditForm task={task} members={members} meId={me?.id ?? null} />
      </section>

      <section className="surface p-4 sm:p-5 text-sm space-y-2">
        <h2 className="font-semibold">Worker fields</h2>
        <p className="text-xs text-muted-foreground">
          Set by the pipelines and the worker. The assignee above is separate and never changes these.
        </p>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
          <dt className="text-muted-foreground">Lane</dt>
          <dd>
            <Badge variant="outline" className="text-[10px]">
              {ownerLabels[task.owner]}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">Autonomy</dt>
          <dd>{task.autonomy_level ? autonomyLabels[task.autonomy_level].label : "—"}</dd>
          {task.playbook_step && (
            <>
              <dt className="text-muted-foreground">Playbook step</dt>
              <dd>{task.playbook_step}</dd>
            </>
          )}
          {task.flagged_for_review && (
            <>
              <dt className="text-muted-foreground">Flagged</dt>
              <dd>{task.recommendation ?? "for review"}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Created</dt>
          <dd>
            {formatStamp(task.created_at)} by {actorName(task.created_by, names)}
          </dd>
          <dt className="text-muted-foreground">Last change</dt>
          <dd>
            {task.updated_at
              ? `${formatStamp(task.updated_at)} by ${actorName(task.updated_by, names)}`
              : "—"}
          </dd>
        </dl>
      </section>

      <section className="surface p-4 sm:p-5 space-y-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        <ol className="space-y-3 border-l pl-4">
          {entries.map((e) =>
            e.type === "event" ? (
              <li key={`e-${e.id}`} className="text-xs text-muted-foreground">
                <span>{e.text}</span> · <time dateTime={e.at}>{formatStamp(e.at)}</time>
              </li>
            ) : (
              <li key={`c-${e.id}`} className="surface p-3.5 text-sm">
                <div className="text-xs text-muted-foreground mb-1">
                  <span className="font-medium text-foreground">{e.author}</span> ·{" "}
                  <time dateTime={e.at}>{formatStamp(e.at)}</time>
                </div>
                <p className="whitespace-pre-wrap break-words">{e.body}</p>
              </li>
            )
          )}
        </ol>
        <TaskCommentForm taskId={task.id} />
        <p className="text-xs text-muted-foreground">
          Changes made by the worker or a system job show as “{WORKER_ACTOR}”.
        </p>
      </section>
    </div>
  );
}
