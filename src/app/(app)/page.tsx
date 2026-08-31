import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { clientStatusStyles, ownerLabels } from "@/lib/labels";

export default async function DashboardPage() {
  const supabase = await createClient();

  const [
    { data: clients },
    { data: blockedStages },
    { data: attentionTasks },
    { data: pastDueSubs },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(
        "id, name, status, client_pipelines(id, status, pipelines(name, key, is_recurring), client_stages(status))"
      )
      .order("name"),
    supabase
      .from("client_stages")
      .select(
        "id, status, stages(name), client_pipelines!inner(client_id, pipelines(name), clients(id, name))"
      )
      .eq("status", "blocked"),
    supabase
      .from("tasks")
      .select("id, title, owner, status, due_date, clients(id, name)")
      .neq("status", "done")
      .or(`owner.eq.CLAUDE_APPROVAL,due_date.lt.${new Date().toISOString().slice(0, 10)}`)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(20),
    supabase
      .from("subscriptions")
      .select("id, client_id, amount, current_period_end, clients(id, name)")
      .eq("paid_status", "past_due"),
  ]);

  const pastDueClientIds = new Set((pastDueSubs ?? []).map((s) => s.client_id));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight mb-4">Dashboard</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(clients ?? []).map((client) => {
            const launch = client.client_pipelines.filter(
              (cp) => !cp.pipelines?.is_recurring
            );
            const completed = launch.filter((cp) => cp.status === "complete").length;
            return (
              <Link key={client.id} href={`/clients/${client.id}`}>
                <Card className="hover:border-primary/50 transition-colors h-full">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{client.name}</CardTitle>
                      <div className="flex items-center gap-1">
                        {pastDueClientIds.has(client.id) && (
                          <Badge
                            variant="outline"
                            className="bg-red-100 text-red-800 border-red-200"
                          >
                            past due
                          </Badge>
                        )}
                        <Badge variant="outline" className={clientStatusStyles[client.status]}>
                          {client.status}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {launch.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No pipelines enrolled yet
                      </p>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {completed} of {launch.length} pipeline
                          {launch.length === 1 ? "" : "s"} complete
                        </p>
                        <div className="space-y-1">
                          {launch.map((cp) => {
                            const total = cp.client_stages.length;
                            const done = cp.client_stages.filter((s) =>
                              ["complete", "skipped"].includes(s.status)
                            ).length;
                            return (
                              <div key={cp.id} className="flex items-center gap-2">
                                <span className="text-xs w-24 shrink-0 text-muted-foreground">
                                  {cp.pipelines?.name}
                                </span>
                                <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                                  <div
                                    className="h-full bg-primary"
                                    style={{
                                      width: total ? `${(done / total) * 100}%` : 0,
                                    }}
                                  />
                                </div>
                                <span className="text-xs text-muted-foreground w-8 text-right">
                                  {done}/{total}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold tracking-tight mb-3">Needs attention</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {(pastDueSubs ?? []).length > 0 && (
            <Card className="lg:col-span-2 border-red-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-red-800">
                  Payments past due
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {(pastDueSubs ?? []).map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <Link
                        className="hover:underline font-medium"
                        href={`/clients/${s.client_id}/billing`}
                      >
                        {s.clients?.name}
                      </Link>
                      <span className="text-muted-foreground">
                        {s.amount != null ? `$${s.amount}/mo` : ""}
                        {s.current_period_end
                          ? ` — period ended ${s.current_period_end.slice(0, 10)}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Blocked stages</CardTitle>
            </CardHeader>
            <CardContent>
              {(blockedStages ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing blocked.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {(blockedStages ?? []).map((s) => (
                    <li key={s.id}>
                      <Link
                        className="hover:underline"
                        href={`/clients/${s.client_pipelines?.clients?.id}/pipelines`}
                      >
                        <span className="font-medium">
                          {s.client_pipelines?.clients?.name}
                        </span>{" "}
                        — {s.client_pipelines?.pipelines?.name} / {s.stages?.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Overdue &amp; awaiting approval
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(attentionTasks ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">All clear.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {(attentionTasks ?? []).map((t) => (
                    <li key={t.id} className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs shrink-0">
                        {ownerLabels[t.owner]}
                      </Badge>
                      <span className="truncate">
                        <span className="font-medium">{t.clients?.name}</span> — {t.title}
                      </span>
                      {t.due_date && (
                        <span className="ml-auto text-xs text-muted-foreground shrink-0">
                          due {t.due_date}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
