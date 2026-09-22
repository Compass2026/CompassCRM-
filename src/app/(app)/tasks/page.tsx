import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { NewTaskForm } from "@/components/task-forms";
import { autonomyLabels, TaskList } from "@/components/task-list";
import { ownerLabels, owners, type OwnerType } from "@/lib/labels";
import { fetchTaskList, fetchViewCounts } from "@/lib/task-queries";
import { getCurrentTeamMember, listTeamMembers } from "@/lib/team";
import { groupByClient, parseTaskView, taskViews, todayIn } from "@/lib/tasks";
import type { Database } from "@/lib/database.types";
import { cn } from "@/lib/utils";

type Autonomy = Database["public"]["Enums"]["autonomy_level"];
const autonomyLevels = Object.keys(autonomyLabels) as Autonomy[];

function chip(active: boolean): string {
  return cn(
    "text-sm px-3 py-1 rounded-full border",
    active ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"
  );
}

function href(params: Record<string, string | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");
  return qs ? `/tasks?${qs}` : "/tasks";
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; owner?: string; autonomy?: string; flagged?: string }>;
}) {
  const { view: rawView, owner, autonomy, flagged } = await searchParams;
  const supabase = await createClient();

  const view = parseTaskView(rawView);
  const ownerFilter = owner && owners.includes(owner as OwnerType) ? (owner as OwnerType) : undefined;
  const autonomyFilter = autonomyLevels.includes(autonomy as Autonomy) ? (autonomy as Autonomy) : undefined;
  const flaggedOnly = flagged === "1";
  const today = todayIn();

  const [me, members, { data: clients }] = await Promise.all([
    getCurrentTeamMember(supabase),
    listTeamMembers(supabase),
    supabase.from("clients").select("id, name").neq("status", "offboarded").order("name"),
  ]);
  const meId = me?.id ?? null;
  const [tasks, counts] = await Promise.all([
    fetchTaskList(supabase, {
      view,
      meId,
      today,
      owner: ownerFilter,
      autonomy: autonomyFilter,
      flagged: flaggedOnly,
    }),
    fetchViewCounts(supabase, { meId, today }),
  ]);

  const current = {
    view: view === "all" ? undefined : view,
    owner: ownerFilter,
    autonomy: autonomyFilter,
    flagged: flaggedOnly ? "1" : undefined,
  };
  const badge: Partial<Record<string, number>> = counts;
  const emptyText = flaggedOnly
    ? "Nothing flagged."
    : view === "mine"
      ? "Nothing assigned to you."
      : view === "unassigned"
        ? "Every piece of human work has someone on it."
        : view === "overdue"
          ? "Nothing overdue."
          : "No open tasks.";

  return (
    <div className="space-y-4">
      <h1 className="page-title kicker">Tasks</h1>

      <details className="rounded-md border bg-card p-4 group">
        <summary className="cursor-pointer text-sm font-medium">New task</summary>
        <div className="pt-3">
          <NewTaskForm members={members} meId={meId} clients={clients ?? []} />
        </div>
      </details>

      <nav aria-label="Work views" className="flex gap-1 border-b overflow-x-auto">
        {taskViews.map((v) => (
          <Link
            key={v.value}
            href={href({ ...current, view: v.value === "all" ? undefined : v.value })}
            title={v.hint}
            aria-current={view === v.value ? "page" : undefined}
            className={cn(
              "px-3 py-2 font-heading text-sm whitespace-nowrap border-b-2 -mb-px transition-colors",
              view === v.value
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {v.label}
            {badge[v.value] ? (
              <span
                className={cn(
                  "ml-1.5 rounded-full px-1.5 text-xs",
                  v.value === "overdue" ? "bg-red-100 text-red-800" : "bg-muted text-muted-foreground"
                )}
              >
                {badge[v.value]}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      <div className="flex gap-2 flex-wrap">
        <Link href={href({ ...current, owner: undefined })} className={chip(!ownerFilter)}>
          All lanes
        </Link>
        {owners.map((o) => (
          <Link key={o} href={href({ ...current, owner: o })} className={chip(ownerFilter === o)}>
            {ownerLabels[o]}
          </Link>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <Link href={href({ ...current, autonomy: undefined })} className={chip(!autonomyFilter)}>
          Any autonomy
        </Link>
        {autonomyLevels.map((a) => (
          <Link
            key={a}
            href={href({ ...current, autonomy: a })}
            className={chip(autonomyFilter === a)}
            title={autonomyLabels[a].hint}
          >
            {autonomyLabels[a].label}
          </Link>
        ))}
        <span className="mx-1 text-muted-foreground">·</span>
        <Link
          href={href({ ...current, flagged: flaggedOnly ? undefined : "1" })}
          className={chip(flaggedOnly)}
          title="Work Claude did and flagged for a look, done included"
        >
          Flagged for review
        </Link>
      </div>

      {view === "by_client" ? (
        <div className="space-y-6">
          {tasks.length === 0 && <TaskList tasks={[]} members={members} meId={meId} today={today} empty={emptyText} />}
          {groupByClient(tasks).map((g) => (
            <section key={g.clientId} className="space-y-2">
              <h2 className="text-sm font-semibold">
                <Link href={`/clients/${g.clientId}/tasks`} className="hover:underline">
                  {g.name}
                </Link>{" "}
                <span className="font-normal text-muted-foreground">({g.tasks.length})</span>
              </h2>
              <TaskList
                tasks={g.tasks}
                members={members}
                meId={meId}
                today={today}
                showClient={false}
                showRecommendation={flaggedOnly}
              />
            </section>
          ))}
        </div>
      ) : (
        <TaskList
          tasks={tasks}
          members={members}
          meId={meId}
          today={today}
          showRecommendation={flaggedOnly}
          empty={emptyText}
        />
      )}
    </div>
  );
}
