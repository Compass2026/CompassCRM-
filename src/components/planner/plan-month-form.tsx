"use client";

import { useActionState } from "react";
import { planDeliveryMonthAction, type PlanFormState } from "@/app/planner-actions";
import { Button } from "@/components/ui/button";

// Opens the month's missing standard slots (plan_delivery_month): spread over
// the remaining weekdays, never in the past, never twice. Nothing is drafted
// or scheduled.
export function PlanMonthForm({ clientId, month, remaining }: { clientId: string; month: string; remaining: number }) {
  const [state, action, pending] = useActionState(planDeliveryMonthAction.bind(null, clientId, month), {} as PlanFormState & { opened?: number });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-plan-month={month}>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Open this month&apos;s {remaining} remaining slots</Button>
      {state.error && <p role="alert" className="text-xs text-red-700">{state.error}</p>}
      {state.ok && <p className="text-xs text-muted-foreground" data-plan-month-opened={state.opened ?? 0}>{state.opened ?? 0} slots opened.</p>}
    </form>
  );
}
