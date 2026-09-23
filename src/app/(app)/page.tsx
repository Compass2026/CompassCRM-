import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  ClockIcon,
  CreditCardIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { clientStatusStyles, ownerLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";

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

  const allClients = clients ?? [];
  const launching = allClients.filter((c) => c.status === "launching").length;
  const active = allClients.filter((c) => c.status === "active").length;
  const launchPipelines = allClients.flatMap((c) =>
    c.client_pipelines.filter((cp) => !cp.pipelines?.is_recurring)
  );
  const launchDone = launchPipelines.filter((cp) => cp.status === "complete").length;
  const blockedCount = (blockedStages ?? []).length;
  const attentionCount = (attentionTasks ?? []).length;
  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date());

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="space-y-1">
          <h1 className="page-title kicker">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Every client, what is blocked, and what is waiting on a person.
          </p>
        </div>
        <p className="text-sm font-medium text-muted-foreground">{today}</p>
      </div>

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label="Clients"
          value={allClients.length}
          caption={`${active} active · ${launching} launching`}
          icon={<UsersIcon />}
          href="/clients"
        />
        <StatTile
          label="Launch pipelines"
          value={`${launchDone}/${launchPipelines.length}`}
          caption="complete across all clients"
          icon={<WorkflowIcon />}
        />
        <StatTile
          label="Blocked stages"
          value={blockedCount}
          caption={blockedCount ? "need a person to unblock" : "nothing blocked"}
          icon={<CircleAlertIcon />}
          tone={blockedCount ? "alert" : "calm"}
          href="#needs-attention"
        />
        <StatTile
          label="Overdue & approvals"
          // The query stops at 20 rows, so 20 means "at least 20".
          value={attentionCount >= 20 ? "20+" : attentionCount}
          caption={attentionCount ? "tasks waiting on the team" : "all clear"}
          icon={<ClockIcon />}
          tone={attentionCount ? "warn" : "calm"}
          href="#needs-attention"
        />
      </section>

      <section id="needs-attention" className="scroll-mt-24 space-y-3">
        <SectionHeading title="Needs attention" />
        <div className="grid gap-4 lg:grid-cols-2">
          {(pastDueSubs ?? []).length > 0 && (
            <Card className="lg:col-span-2 ring-red-200">
              <CardHeader>
                <PanelTitle icon={<CreditCardIcon />} tone="alert" count={(pastDueSubs ?? []).length}>
                  Payments past due
                </PanelTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {(pastDueSubs ?? []).map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-2 py-2 first:pt-0 last:pb-0">
                      <Link
                        className="font-medium hover:underline"
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
            <CardHeader>
              <PanelTitle icon={<CircleAlertIcon />} tone="alert" count={blockedCount}>
                Blocked stages
              </PanelTitle>
            </CardHeader>
            <CardContent>
              {blockedCount === 0 ? (
                <EmptyLine>Nothing blocked.</EmptyLine>
              ) : (
                <ul className="divide-y text-sm">
                  {(blockedStages ?? []).map((s) => (
                    <li key={s.id} className="py-2 first:pt-0 last:pb-0">
                      <Link
                        className="group/row flex items-baseline gap-2 hover:underline"
                        href={`/clients/${s.client_pipelines?.clients?.id}/pipelines`}
                      >
                        <span className="font-medium">
                          {s.client_pipelines?.clients?.name}
                        </span>
                        <span className="text-muted-foreground">
                          {s.client_pipelines?.pipelines?.name} / {s.stages?.name}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <PanelTitle icon={<ClockIcon />} tone="warn" count={attentionCount}>
                Overdue &amp; awaiting approval
              </PanelTitle>
            </CardHeader>
            <CardContent>
              {attentionCount === 0 ? (
                <EmptyLine>All clear.</EmptyLine>
              ) : (
                <ul className="divide-y text-sm">
                  {(attentionTasks ?? []).map((t) => (
                    <li key={t.id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {ownerLabels[t.owner]}
                      </Badge>
                      <span className="min-w-0 truncate">
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
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Clients"
          action={
            <Link href="/clients" className="text-sm font-medium text-navy-600 hover:underline">
              View all
            </Link>
          }
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allClients.map((client) => {
            const launch = client.client_pipelines.filter(
              (cp) => !cp.pipelines?.is_recurring
            );
            const completed = launch.filter((cp) => cp.status === "complete").length;
            return (
              <Link
                key={client.id}
                href={`/clients/${client.id}`}
                className="group/client rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Card className="h-full transition-all duration-200 group-hover/client:-translate-y-0.5 group-hover/client:shadow-card-hover">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <span
                        className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent font-heading text-sm font-semibold text-navy-700"
                        aria-hidden="true"
                      >
                        {client.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="truncate">{client.name}</CardTitle>
                        <p className="text-xs text-muted-foreground">
                          {launch.length === 0
                            ? "No pipelines enrolled yet"
                            : `${completed} of ${launch.length} pipeline${launch.length === 1 ? "" : "s"} complete`}
                        </p>
                      </div>
                      <ArrowUpRightIcon
                        className="size-4 shrink-0 self-start text-muted-foreground opacity-0 transition-opacity group-hover/client:opacity-100"
                        aria-hidden="true"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <Badge variant="outline" className={clientStatusStyles[client.status]}>
                        {client.status}
                      </Badge>
                      {pastDueClientIds.has(client.id) && (
                        <Badge
                          variant="outline"
                          className="bg-red-100 text-red-800 border-red-200"
                        >
                          past due
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  {launch.length > 0 && (
                    <CardContent className="space-y-2.5">
                      {launch.map((cp) => {
                        const total = cp.client_stages.length;
                        const done = cp.client_stages.filter((s) =>
                          ["complete", "skipped"].includes(s.status)
                        ).length;
                        return (
                          <div key={cp.id} className="flex items-center gap-3">
                            <span className="w-20 shrink-0 truncate text-xs font-medium text-muted-foreground">
                              {cp.pipelines?.name}
                            </span>
                            <div
                              className="h-2 flex-1 overflow-hidden rounded-full bg-mist-200"
                              role="progressbar"
                              aria-label={`${cp.pipelines?.name} stages complete`}
                              aria-valuemin={0}
                              aria-valuemax={total}
                              aria-valuenow={done}
                            >
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-400"
                                style={{
                                  width: total ? `${(done / total) * 100}%` : 0,
                                }}
                              />
                            </div>
                            <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                              {done}/{total}
                            </span>
                          </div>
                        );
                      })}
                    </CardContent>
                  )}
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

type Tone = "calm" | "warn" | "alert";

const toneStyles: Record<Tone, { chip: string; value: string }> = {
  calm: { chip: "bg-accent text-navy-700", value: "text-foreground" },
  warn: { chip: "bg-orange-50 text-orange-600", value: "text-foreground" },
  alert: { chip: "bg-red-50 text-red-700", value: "text-red-800" },
};

function StatTile({
  label,
  value,
  caption,
  icon,
  tone = "calm",
  href,
}: {
  label: string;
  value: React.ReactNode;
  caption: string;
  icon: React.ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <div className="surface flex h-full flex-col gap-2 p-4 transition-all duration-200 sm:p-5 [a:hover>&]:-translate-y-0.5 [a:hover>&]:shadow-card-hover">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4",
            toneStyles[tone].chip
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <p className={cn("font-heading text-3xl font-semibold tabular-nums tracking-tight", toneStyles[tone].value)}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
  return href ? (
    <Link href={href} className="rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}

function SectionHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 className="font-heading text-lg font-semibold tracking-tight">{title}</h2>
      {action}
    </div>
  );
}

function PanelTitle({
  icon,
  tone,
  count,
  children,
}: {
  icon: React.ReactNode;
  tone: Tone;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4",
          count ? toneStyles[tone].chip : toneStyles.calm.chip
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <CardTitle className="text-sm">{children}</CardTitle>
      <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
