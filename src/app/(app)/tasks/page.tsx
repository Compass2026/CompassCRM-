import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { toggleTaskAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { ownerLabels, owners, type OwnerType } from "@/lib/labels";
import { cn } from "@/lib/utils";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string }>;
}) {
  const { owner } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("tasks")
    .select(
      "id, title, owner, status, due_date, client_id, clients(id, name), client_stages(stages(name))"
    )
    .neq("status", "done")
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(200);

  if (owner && owners.includes(owner as OwnerType)) {
    query = query.eq("owner", owner as OwnerType);
  }

  const { data: tasks } = await query;

  return (
    <div className="space-y-4">
      <h1 className="page-title kicker">Tasks</h1>
      <div className="flex gap-2 flex-wrap">
        <Link
          href="/tasks"
          className={cn(
            "text-sm px-3 py-1 rounded-full border",
            !owner ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"
          )}
        >
          All
        </Link>
        {owners.map((o) => (
          <Link
            key={o}
            href={`/tasks?owner=${o}`}
            className={cn(
              "text-sm px-3 py-1 rounded-full border",
              owner === o
                ? "bg-primary text-primary-foreground border-primary"
                : "text-muted-foreground"
            )}
          >
            {ownerLabels[o]}
          </Link>
        ))}
      </div>

      <div className="rounded-md border bg-card divide-y">
        {(tasks ?? []).length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No open tasks.</p>
        )}
        {(tasks ?? []).map((task) => {
          const toggle = toggleTaskAction.bind(null, task.client_id, task.id, true);
          return (
            <div key={task.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <form action={toggle}>
                <button
                  type="submit"
                  className="size-4 rounded border border-input hover:bg-muted"
                  title="Mark done"
                />
              </form>
              <span className="flex-1">{task.title}</span>
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
              {task.due_date && (
                <span className="text-xs text-muted-foreground w-20 text-right">
                  {task.due_date}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
