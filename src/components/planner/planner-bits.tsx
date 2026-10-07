import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  addDays,
  currentWeek,
  DELIVERABLES,
  deliverableLabels,
  isPlanStatus,
  PLAN_STATUSES,
  planStatusLabels,
  weekLabel,
  type Deliverable,
  type SlotSummary,
} from "@/lib/content-planner";
import { cn } from "@/lib/utils";

export function PlanStatusBadge({ status }: { status: string | null }) {
  const s = isPlanStatus(status) ? planStatusLabels[status] : { label: status ?? "—", className: "" };
  return <Badge variant="outline" className={cn("text-[10px]", s.className)} data-plan-status={status}>{s.label}</Badge>;
}

// Previous / this / next week, keeping the rest of the page's path.
export function WeekNav({ basePath, week }: { basePath: string; week: string }) {
  const thisWeek = currentWeek();
  const link = (w: string, label: string) => (
    <Link href={`${basePath}?week=${w}`} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">{label}</Link>
  );
  return (
    <div className="flex flex-wrap items-center gap-2" data-week={week}>
      {link(addDays(week, -7), "← Previous")}
      <span className="text-sm font-medium tabular-nums">Week of {weekLabel(week)}</span>
      {link(addDays(week, 7), "Next →")}
      {week !== thisWeek && link(thisWeek, "This week")}
    </div>
  );
}

// "Social 1/2": approved or delivered against the target, with the rest by status.
export function SlotCount({ summary, compact = false }: { summary: SlotSummary; compact?: boolean }) {
  const met = summary.done >= summary.target;
  return (
    <div className="min-w-0 space-y-1" data-slot={summary.deliverable}>
      <div className="flex items-baseline gap-1.5">
        {!compact && <span className="text-xs text-muted-foreground">{deliverableLabels[summary.deliverable].short}</span>}
        <span className={cn("text-lg font-semibold tabular-nums", met ? "text-green-700" : "")} data-slot-count>
          {summary.done}/{summary.target}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {PLAN_STATUSES.filter((s) => s !== "approved" && s !== "delivered" && summary.byStatus[s]).map((s) => (
          <span key={s} className={cn("rounded px-1 text-[10px]", planStatusLabels[s].className)}>
            {summary.byStatus[s]} {planStatusLabels[s].label.toLowerCase()}
          </span>
        ))}
        {summary.unplanned > 0 && (
          <span className="rounded border border-dashed px-1 text-[10px] text-muted-foreground">{summary.unplanned} to plan</span>
        )}
      </div>
    </div>
  );
}

export function SlotStrip({ summaries }: { summaries: Record<Deliverable, SlotSummary> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-slot-strip>
      {DELIVERABLES.map((d) => (
        <div key={d} className="surface p-3"><SlotCount summary={summaries[d]} /></div>
      ))}
    </div>
  );
}
