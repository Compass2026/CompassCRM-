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
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  CreditCardIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { clientStatusStyles, ownerLabels } from "@/lib/labels";
import { attentionLabel, billingState, billingStateLabels, formatMoney } from "@/lib/billing";
import { cn } from "@/lib/utils";

// The overdue / approval list stops here; the tile reads "20+" at the cap.
const ATTENTION_LIMIT = 20;

export default async function DashboardPage() {
  const supabase = await createClient();
  const todayIso = new Date().toISOString().slice(0, 10);

  const [
    { data: clients },
    { data: blockedStages },
    { data: attentionTasks },
    { data: billingAttention },
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
      .or(`owner.eq.CLAUDE_APPROVAL,due_date.lt.${todayIso}`)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(ATTENTION_LIMIT),
    // Derived from Stripe's own state (0058); Stripe decides past due.
    supabase
      .from("client_billing_status")
      .select("client_id, billing_state, attention_reasons, latest_invoice_remaining_cents, latest_invoice_currency")
      .eq("billing_attention", true),
  ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const billingAlerts = (billingAttention ?? []).filter((b) => b.client_id);
  const pastDueClientIds = new Set(billingAlerts.map((b) => b.client_id));

  const allClients = (clients ?? []).map((c) => ({
    ...c,
    launch: c.client_pipelines.filter((cp) => !cp.pipelines?.is_recurring),
  }));
  const launching = allClients.filter((c) => c.status === "launching").length;
  const active = allClients.filter((c) => c.status === "active").length;
  const launchPipelines = allClients.flatMap((c) => c.launch);
  const launchDone = launchPipelines.filter((cp) => cp.status === "complete").length;
  // Paused, offboarded and unenrolled clients have no progress to show;
  // they get one compact row each instead of a mostly empty card.
  const inFlight = allClients.filter(
    (c) => c.launch.length > 0 && c.status !== "paused" && c.status !== "offboarded"
  );
  const parked = allClients.filter((c) => !inFlight.includes(c));

  const blocked = blockedStages ?? [];
  const blockedCount = blocked.length;
  const attention = attentionTasks ?? [];
  const attentionCount = attention.length;
  const attentionGroups = groupByClient(attention);
  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date());

  return (
    // data-wide-page lets the app shell widen past its default column.
    <div data-wide-page className="space-y-6 sm:space-y-8">
      <div className="surface-tint space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="space-y-1">
            <p className="eyebrow">Compass Client Platform</p>
            <h1 className="page-title kicker">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Every client, what is blocked, and what is waiting on a person.
            </p>
          </div>
          <p className="rounded-full bg-card px-3 py-1 text-sm font-medium text-navy-700 ring-1 ring-royal-100">{today}</p>
        </div>

        <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
            value={attentionCount >= ATTENTION_LIMIT ? `${ATTENTION_LIMIT}+` : attentionCount}
            caption={attentionCount ? "tasks waiting on the team" : "all clear"}
            icon={<ClockIcon />}
            tone={attentionCount ? "warn" : "calm"}
            href="#needs-attention"
          />
        </section>
      </div>

      <section id="needs-attention" className="scroll-mt-24 space-y-3">
        {/* Empty panels collapse into a chip beside the heading, so an
            all-clear day doesn't hold open a blank card. */}
        <SectionHeading title="Needs attention">
          {blockedCount === 0 && <ClearChip>Nothing blocked</ClearChip>}
          {attentionCount === 0 && <ClearChip>No overdue tasks or approvals</ClearChip>}
          {billingAlerts.length === 0 && <ClearChip>Billing clear</ClearChip>}
        </SectionHeading>

        {billingAlerts.length > 0 && (
          <Card size="sm" className="ring-red-200">
            <CardHeader>
              <PanelTitle icon={<CreditCardIcon />} tone="alert" count={billingAlerts.length}>
                Billing needs attention
              </PanelTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {billingAlerts.map((b) => (
                  <li key={b.client_id} className="flex flex-wrap items-center gap-x-2 py-2 first:pt-0 last:pb-0">
                    <Link
                      className="font-medium hover:underline"
                      href={`/clients/${b.client_id}/billing`}
                    >
                      {clientName.get(b.client_id!) ?? "Client"}
                    </Link>
                    <span className="text-muted-foreground">
                      {billingStateLabels[billingState(b.billing_state)]}
                      {b.latest_invoice_remaining_cents
                        ? ` — ${formatMoney(b.latest_invoice_remaining_cents, b.latest_invoice_currency)} open`
                        : ""}
                      {" · "}
                      {(b.attention_reasons ?? []).map(attentionLabel).join("; ")}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {blockedCount > 0 && (
          <Card size="sm" className="ring-red-200">
            <CardHeader>
              <PanelTitle icon={<CircleAlertIcon />} tone="alert" count={blockedCount}>
                Blocked stages
              </PanelTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-x-6 text-sm md:grid-cols-2 xl:grid-cols-3">
                {blocked.map((s) => (
                  <li key={s.id} className="min-w-0 border-b py-2 last:border-b-0">
                    <Link
                      className="flex min-w-0 items-baseline gap-2 hover:underline"
                      href={`/clients/${s.client_pipelines?.clients?.id}/pipelines`}
                    >
                      <span className="shrink-0 font-medium">
                        {s.client_pipelines?.clients?.name}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {s.client_pipelines?.pipelines?.name} / {s.stages?.name}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {attentionCount > 0 && (
          <Card size="sm">
            <CardHeader>
              <PanelTitle
                icon={<ClockIcon />}
                tone="warn"
                count={attentionCount}
                countLabel={attentionCount >= ATTENTION_LIMIT ? `${ATTENTION_LIMIT}+` : undefined}
                action={
                  <Link href="/tasks" className="whitespace-nowrap text-xs font-semibold text-royal-600 hover:underline">
                    All tasks
                  </Link>
                }
              >
                Overdue &amp; awaiting approval
              </PanelTitle>
            </CardHeader>
            <CardContent>
              {/* Grouped by client and flowed into columns: one client's
                  long run of reviews sits beside the short groups instead
                  of stretching the page. */}
              <div className="gap-x-8 md:columns-2 2xl:columns-3">
                {attentionGroups.map((group) => (
                  <div key={group.key} className="mb-4 break-inside-avoid last:mb-0">
                    <div className="flex items-center gap-2 border-b pb-1.5">
                      {group.clientId ? (
                        <Link
                          href={`/clients/${group.clientId}`}
                          className="truncate text-sm font-semibold text-navy-900 hover:underline"
                        >
                          {group.clientName}
                        </Link>
                      ) : (
                        <span className="truncate text-sm font-semibold text-navy-900">
                          {group.clientName}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                        {group.tasks.length}
                      </span>
                    </div>
                    <ul className="text-sm">
                      {group.tasks.map((t) => {
                        const overdue = !!t.due_date && t.due_date < todayIso;
                        return (
                          <li
                            key={t.id}
                            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                          >
                            <Badge
                              variant="outline"
                              className="col-span-2 w-fit text-[10px] sm:col-span-1"
                            >
                              {ownerLabels[t.owner]}
                            </Badge>
                            <span className="truncate" title={t.title}>
                              {t.title}
                            </span>
                            <span
                              className={cn(
                                "text-xs tabular-nums",
                                overdue ? "font-medium text-orange-700" : "text-muted-foreground"
                              )}
                            >
                              {t.due_date && (
                                <>
                                  {overdue && <span className="sr-only">overdue, </span>}
                                  {formatDue(t.due_date)}
                                </>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Clients"
          action={
            <Link href="/clients" className="text-sm font-semibold text-royal-600 hover:underline">
              View all
            </Link>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {inFlight.map((client) => {
            const completed = client.launch.filter((cp) => cp.status === "complete").length;
            return (
              <Link
                key={client.id}
                href={`/clients/${client.id}`}
                className="group/client rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Card size="sm" className="h-full transition-all duration-200 group-hover/client:-translate-y-0.5 group-hover/client:shadow-card-hover">
                  <CardHeader>
                    <div className="flex min-w-0 items-center gap-3">
                      <ClientMark name={client.name} />
                      <div className="min-w-0 flex-1">
                        <CardTitle className="truncate" title={client.name}>{client.name}</CardTitle>
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                          <Badge variant="outline" className={clientStatusStyles[client.status]}>
                            {client.status}
                          </Badge>
                          {pastDueClientIds.has(client.id) && <PastDueBadge />}
                          <span>
                            {`${completed} of ${client.launch.length} pipeline${client.launch.length === 1 ? "" : "s"} complete`}
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {client.launch.map((cp) => {
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
                            className="h-2 flex-1 overflow-hidden rounded-full bg-royal-50 ring-1 ring-royal-100"
                            role="progressbar"
                            aria-label={`${cp.pipelines?.name} stages complete`}
                            aria-valuemin={0}
                            aria-valuemax={total}
                            aria-valuenow={done}
                          >
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-royal-700 via-royal-500 to-orange-400"
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
                </Card>
              </Link>
            );
          })}
        </div>

        {parked.length > 0 && (
          <div className="space-y-2 pt-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              Paused, offboarded or not enrolled{" "}
              <span className="font-normal tabular-nums">({parked.length})</span>
            </h3>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {parked.map((client) => (
                <li key={client.id}>
                  <Link
                    href={`/clients/${client.id}`}
                    className="surface flex items-center gap-2.5 px-3 py-2 outline-none transition-shadow hover:shadow-card-hover focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <ClientMark name={client.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-navy-900" title={client.name}>
                        {client.name}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge variant="outline" className={clientStatusStyles[client.status]}>
                          {client.status}
                        </Badge>
                        {pastDueClientIds.has(client.id) && <PastDueBadge />}
                        <span className="truncate">
                          {client.launch.length === 0
                            ? "no pipelines"
                            : `${client.launch.filter((cp) => cp.status === "complete").length}/${client.launch.length} pipelines`}
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

type AttentionTask = {
  id: string;
  title: string;
  owner: keyof typeof ownerLabels;
  due_date: string | null;
  clients: { id: string; name: string } | null;
};

// Groups keep the query's order (earliest due first), so the most overdue
// client leads.
function groupByClient<T extends AttentionTask>(tasks: T[]) {
  const groups = new Map<string, { key: string; clientId: string | null; clientName: string; tasks: T[] }>();
  for (const t of tasks) {
    const key = t.clients?.id ?? "none";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        clientId: t.clients?.id ?? null,
        clientName: t.clients?.name ?? "No client",
        tasks: [],
      };
      groups.set(key, group);
    }
    group.tasks.push(t);
  }
  return [...groups.values()];
}

function formatDue(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

type Tone = "calm" | "warn" | "alert";

const toneStyles: Record<Tone, { chip: string; value: string }> = {
  calm: { chip: "bg-royal-50 text-royal-600 ring-1 ring-royal-100", value: "text-navy-900" },
  warn: { chip: "bg-orange-50 text-orange-600 ring-1 ring-orange-100", value: "text-navy-900" },
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
    <div className="surface relative flex h-full flex-col gap-1 overflow-hidden bg-[radial-gradient(160px_90px_at_100%_100%,rgba(42,92,184,0.08),transparent_70%)] px-4 pt-4 pb-3 transition-all duration-200 [a:hover>&]:-translate-y-0.5 [a:hover>&]:shadow-card-hover">
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 top-0 h-1",
          tone === "alert" ? "bg-red-500" : tone === "warn" ? "bg-gradient-to-r from-orange-500 to-orange-300" : "bg-gradient-to-r from-royal-600 to-royal-500"
        )}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-3.5",
            toneStyles[tone].chip
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <p className={cn("text-2xl font-bold tabular-nums tracking-tight sm:text-3xl", toneStyles[tone].value)}>
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

function SectionHeading({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function ClearChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground ring-1 ring-border">
      <CircleCheckIcon className="size-3.5 text-green-600" aria-hidden="true" />
      {children}
    </span>
  );
}

function ClientMark({ name, size = "default" }: { name: string; size?: "default" | "sm" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center bg-gradient-to-br from-royal-500 to-navy-700 font-semibold text-white shadow-[0_4px_10px_-4px_rgba(26,63,132,0.6)]",
        size === "sm" ? "size-8 rounded-lg text-xs" : "size-10 rounded-xl text-sm"
      )}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function PastDueBadge() {
  return (
    <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">
      past due
    </Badge>
  );
}

function PanelTitle({
  icon,
  tone,
  count,
  countLabel,
  action,
  children,
}: {
  icon: React.ReactNode;
  tone: Tone;
  count: number;
  countLabel?: string;
  action?: React.ReactNode;
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
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
          count ? "bg-orange-100 text-orange-600" : "bg-muted text-muted-foreground"
        )}
      >
        {countLabel ?? count}
      </span>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}
