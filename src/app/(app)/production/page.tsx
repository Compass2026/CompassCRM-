import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  DELIVERABLES,
  deliverableLabels,
  parseWeek,
  addDays,
  PLANNER_CLIENT_STATUSES,
  standardWeekTargets,
  summarize,
  WEEKLY_TARGETS,
  type Deliverable,
} from "@/lib/content-planner";
import { monthOf } from "@/lib/delivery-standard";
import { SlotCount, WeekNav } from "@/components/planner/planner-bits";

export const dynamic = "force-dynamic";

// Production (0065): every managed client's week in one place — what is due,
// what is ready, what is stuck. Counts are approved or delivered pieces
// against the weekly target; the chips say where the rest stand.
export default async function ProductionPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const week = parseWeek((await searchParams).week);
  const supabase = await createClient();
  const [clientsQ, boardQ, adoptedQ, slotsQ] = await Promise.all([
    supabase.from("clients").select("id, name, status").in("status", [...PLANNER_CLIENT_STATUSES]).order("name"),
    supabase.from("content_plan_board").select("client_id, deliverable, status").eq("week_start", week),
    supabase.from("client_delivery_standards").select("client_id, effective_month").lte("effective_month", monthOf(addDays(week, 6))),
    supabase.from("content_plan_items").select("client_id, deliverable, standard_key").eq("week_start", week).not("standard_key", "is", null),
  ]);
  const failure = clientsQ.error ?? boardQ.error ?? adoptedQ.error ?? slotsQ.error;
  if (failure) return <p className="surface p-4 text-sm text-red-700">Production could not be read: {failure.message}</p>;

  const rows = boardQ.data ?? [];
  const clients = clientsQ.data ?? [];
  // A client on the monthly delivery standard (for either month the week
  // touches) is measured against the week's share of its monthly plan.
  const adopted = new Set((adoptedQ.data ?? []).map((a) => a.client_id));
  const targetsFor = (id: string): Record<Deliverable, number> =>
    adopted.has(id) ? standardWeekTargets((slotsQ.data ?? []).filter((s) => s.client_id === id)) : WEEKLY_TARGETS;
  const perClient = clients.map((c) => ({
    ...c,
    standard: adopted.has(c.id),
    summary: summarize(rows.filter((r) => r.client_id === c.id).map((r) => ({ deliverable: r.deliverable ?? "", status: r.status })), targetsFor(c.id)),
  }));
  const totals = summarize(rows.filter((r) => clients.some((c) => c.id === r.client_id)).map((r) => ({ deliverable: r.deliverable ?? "", status: r.status })),
    Object.fromEntries(DELIVERABLES.map((d) => [d, clients.reduce((n, c) => n + targetsFor(c.id)[d], 0)])) as Record<Deliverable, number>);
  const n = clients.length;
  const blocked = rows.filter((r) => r.status === "blocked").length;
  const inReview = rows.filter((r) => r.status === "in_review").length;

  return (
    <div className="space-y-6" data-production>
      <div className="surface space-y-3 p-4">
        <h1 className="text-base font-semibold">Production</h1>
        <WeekNav basePath="/production" week={week} />
        <p className="text-xs text-muted-foreground">
          Weekly target per managed client: {DELIVERABLES.map((d) => `${WEEKLY_TARGETS[d]} ${deliverableLabels[d].short}`).join(", ")}.
          {adopted.size > 0 && " Clients on the monthly delivery standard are measured against the week's share of their monthly plan."}
          Each count is approved or delivered pieces against the target.
          {inReview > 0 && <> <span className="font-medium text-amber-900">{inReview} waiting for review.</span></>}
          {blocked > 0 && <> <span className="font-medium text-red-700">{blocked} blocked.</span></>}
        </p>
      </div>

      <div className="surface overflow-x-auto" data-overflow-ok>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="p-3 font-medium">Client</th>
              {DELIVERABLES.map((d) => <th key={d} className="p-3 font-medium">{deliverableLabels[d].short}</th>)}
            </tr>
          </thead>
          <tbody>
            {perClient.map((c) => (
              <tr key={c.id} className="border-b align-top last:border-0" data-production-client={c.id}>
                <td className="p-3">
                  <Link href={`/clients/${c.id}/planner?week=${week}`} className="font-medium underline-offset-2 hover:underline">{c.name}</Link>
                  {c.status === "launching" && <span className="block text-[10px] text-muted-foreground">launching</span>}
                  {c.standard && <span className="block text-[10px] text-muted-foreground" data-standard-client>monthly delivery standard</span>}
                </td>
                {DELIVERABLES.map((d) => <td key={d} className="p-3"><SlotCount summary={c.summary[d]} compact /></td>)}
              </tr>
            ))}
            {n === 0 && (
              <tr><td colSpan={5} className="p-3 text-muted-foreground">No active or launching client.</td></tr>
            )}
          </tbody>
          {n > 1 && (
            <tfoot>
              <tr className="border-t text-xs text-muted-foreground" data-production-totals>
                <td className="p-3 font-medium">All clients</td>
                {DELIVERABLES.map((d) => (
                  <td key={d} className="p-3 tabular-nums">{totals[d].done}/{totals[d].target} · {totals[d].planned} planned</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
