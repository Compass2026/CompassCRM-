import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { toggleTaskAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { ownerLabels, owners, type OwnerType } from "@/lib/labels";
import type { Database } from "@/lib/database.types";
import { cn } from "@/lib/utils";

type Autonomy = Database["public"]["Enums"]["autonomy_level"];

// The autonomy filter (reconciliation build-order step 8): what Claude runs
// unattended, what it runs and flags for a look, and what waits on a decision.
const autonomyLevels: { value: Autonomy; label: string; hint: string }[] = [
  { value: "run", label: "Run", hint: "Claude does it and logs it" },
  { value: "run_flag", label: "Run + flag", hint: "Claude does it; review if you want" },
  { value: "hold", label: "Hold", hint: "waits on a decision" },
];

const autonomyStyles: Record<Autonomy, string> = {
  run: "bg-zinc-100 text-zinc-600 border-zinc-200",
  run_flag: "bg-amber-100 text-amber-800 border-amber-200",
  hold: "bg-red-100 text-red-800 border-red-200",
};

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
  searchParams: Promise<{ owner?: string; autonomy?: string; flagged?: string }>;
}) {
  const { owner, autonomy, flagged } = await searchParams;
  const supabase = await createClient();

  const ownerFilter = owner && owners.includes(owner as OwnerType) ? (owner as OwnerType) : undefined;
  const autonomyFilter = autonomyLevels.some((a) => a.value === autonomy)
    ? (autonomy as Autonomy)
    : undefined;
  const flaggedOnly = flagged === "1";

  let query = supabase
    .from("tasks")
    .select(
      "id, title, owner, status, due_date, client_id, autonomy_level, flagged_for_review, recommendation, playbook_step, completed_at, notes, clients(id, name), client_stages(stages(name))"
    )
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(200);

  // Flagged is a review view: it includes work that is already done, which
  // is the point — "done, review if you want". Everything else is open work.
  if (flaggedOnly) {
    query = query.eq("flagged_for_review", true).order("completed_at", { ascending: false });
  } else {
    query = query.neq("status", "done");
  }
  if (ownerFilter) query = query.eq("owner", ownerFilter);
  if (autonomyFilter) query = query.eq("autonomy_level", autonomyFilter);

  const { data: tasks } = await query;

  const current = { owner: ownerFilter, autonomy: autonomyFilter, flagged: flaggedOnly ? "1" : undefined };

  return (
    <div className="space-y-4">
      <h1 className="page-title kicker">Tasks</h1>

      <div className="flex gap-2 flex-wrap">
        <Link href={href({ ...current, owner: undefined })} className={chip(!ownerFilter)}>
          All owners
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
            key={a.value}
            href={href({ ...current, autonomy: a.value })}
            className={chip(autonomyFilter === a.value)}
            title={a.hint}
          >
            {a.label}
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

      <div className="rounded-md border bg-card divide-y">
        {(tasks ?? []).length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {flaggedOnly ? "Nothing flagged." : "No open tasks."}
          </p>
        )}
        {(tasks ?? []).map((task) => {
          const done = task.status === "done";
          const toggle = toggleTaskAction.bind(null, task.client_id, task.id, !done);
          return (
            <div key={task.id} className="px-4 py-2 text-sm">
              <div className="flex items-center gap-3">
                <form action={toggle}>
                  <button
                    type="submit"
                    className={cn(
                      "size-4 rounded border border-input hover:bg-muted",
                      done && "bg-primary"
                    )}
                    title={done ? "Reopen" : "Mark done"}
                  />
                </form>
                <span className={cn("flex-1", done && "line-through text-muted-foreground")}>
                  {task.title}
                </span>
                {task.client_stages?.stages?.name && (
                  <span className="text-xs text-muted-foreground">
                    {task.client_stages.stages.name}
                  </span>
                )}
                <Link
                  href={`/clients/${task.clients?.id}`}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {task.clients?.name}
                </Link>
                <Badge variant="outline" className="text-[10px]">
                  {ownerLabels[task.owner]}
                </Badge>
                {task.autonomy_level && (
                  <Badge
                    variant="outline"
                    className={cn("text-[10px]", autonomyStyles[task.autonomy_level])}
                    title={task.playbook_step ?? undefined}
                  >
                    {autonomyLevels.find((a) => a.value === task.autonomy_level)?.label}
                  </Badge>
                )}
                {task.flagged_for_review && (
                  <Badge variant="outline" className="text-[10px] bg-amber-100 text-amber-800 border-amber-200">
                    flagged
                  </Badge>
                )}
                {task.due_date && (
                  <span className="text-xs text-muted-foreground w-20 text-right">
                    {task.due_date}
                  </span>
                )}
              </div>
              {(task.recommendation || (flaggedOnly && task.notes)) && (
                <p className="mt-1 pl-7 text-xs text-muted-foreground">
                  {task.recommendation ?? task.notes}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
