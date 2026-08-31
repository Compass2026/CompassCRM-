import { createClient } from "@/lib/supabase/server";
import { toggleTaskAction } from "@/app/actions";
import { startCycleAction, updateCycleAction } from "@/app/tracker-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ownerLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();

  const [{ data: cycles }, { data: client }, { data: contentPosts }, { data: socialPosts }] =
    await Promise.all([
      supabase
        .from("monthly_cycles")
        .select("*, tasks(id, title, owner, status)")
        .eq("client_id", clientId)
        .order("period", { ascending: false }),
      supabase.from("clients").select("status").eq("id", clientId).single(),
      supabase
        .from("content_posts")
        .select("published_at")
        .eq("client_id", clientId)
        .eq("status", "published"),
      supabase
        .from("social_posts")
        .select("scheduled_at")
        .eq("client_id", clientId)
        .eq("status", "published"),
    ]);

  const thisMonthFirst = `${new Date().toISOString().slice(0, 7)}-01`;
  const hasCurrentCycle = (cycles ?? []).some((c) => c.period === thisMonthFirst);
  const startCycle = startCycleAction.bind(null, clientId);

  function countInMonth(dates: (string | null)[], period: string) {
    const prefix = period.slice(0, 7);
    return dates.filter((d) => d?.startsWith(prefix)).length;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          One card per monthly Reporting cycle. Cycles are created automatically
          on the 1st for active clients; the button covers mid-month starts.
        </p>
        {!hasCurrentCycle && (
          <form action={startCycle}>
            <Button type="submit" variant="outline" size="sm">
              Start {thisMonthFirst.slice(0, 7)} cycle
            </Button>
          </form>
        )}
      </div>

      {(cycles ?? []).length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No monthly cycles yet
            {client?.status !== "active" &&
              " — cycles begin once the client converges to active/Reporting"}
            .
          </CardContent>
        </Card>
      )}

      {(cycles ?? []).map((cycle) => {
        const doneTasks = cycle.tasks.filter((t) => t.status === "done").length;
        const rank = cycle.rank_summary as {
          organic_index?: number;
          map_index?: number;
          note?: string;
        } | null;
        return (
          <Card key={cycle.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">
                  {cycle.period.slice(0, 7)}
                </CardTitle>
                <Badge
                  variant="outline"
                  className={
                    cycle.status === "complete"
                      ? "bg-green-100 text-green-800 border-green-200"
                      : "bg-blue-100 text-blue-800 border-blue-200"
                  }
                >
                  {cycle.status}
                </Badge>
                <span className="text-xs text-muted-foreground ml-auto">
                  {doneTasks}/{cycle.tasks.length} tasks ·{" "}
                  {countInMonth(contentPosts?.map((p) => p.published_at) ?? [], cycle.period)}{" "}
                  blog ·{" "}
                  {countInMonth(socialPosts?.map((p) => p.scheduled_at) ?? [], cycle.period)}{" "}
                  social
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {rank && (
                <p className="text-xs text-muted-foreground">
                  Rank summary: organic index {rank.organic_index ?? "—"} · map
                  index {rank.map_index ?? "—"}
                  {rank.note ? ` · ${rank.note}` : ""}
                </p>
              )}

              <ul className="space-y-1">
                {cycle.tasks.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 text-sm">
                    <form
                      action={toggleTaskAction.bind(
                        null,
                        clientId,
                        task.id,
                        task.status !== "done"
                      )}
                    >
                      <button
                        type="submit"
                        className={cn(
                          "size-4 rounded border border-input",
                          task.status === "done" && "bg-primary"
                        )}
                        title={task.status === "done" ? "Reopen" : "Mark done"}
                      />
                    </form>
                    <span
                      className={cn(
                        task.status === "done" && "line-through text-muted-foreground"
                      )}
                    >
                      {task.title}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {ownerLabels[task.owner]}
                    </Badge>
                  </li>
                ))}
              </ul>

              <form
                action={updateCycleAction.bind(null, clientId, cycle.id)}
                className="flex gap-2 flex-wrap border-t pt-3"
              >
                <Input
                  name="report_url"
                  placeholder="Report Drive link"
                  defaultValue={cycle.report_url ?? ""}
                  className="h-8 flex-1 min-w-48 text-xs"
                />
                <Textarea
                  name="notes"
                  placeholder="Cycle notes"
                  defaultValue={cycle.notes ?? ""}
                  rows={1}
                  className="text-xs flex-1 min-w-48"
                />
                <select
                  name="status"
                  defaultValue={cycle.status}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="open">open</option>
                  <option value="complete">complete</option>
                </select>
                <Button type="submit" size="sm" variant="outline">
                  Save
                </Button>
              </form>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
