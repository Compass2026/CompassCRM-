"use client";

import { useActionState } from "react";
import {
  createPlanItemAction,
  deletePlanItemAction,
  linkOutputAction,
  planFromAuthorityAction,
  setHoldAction,
  unlinkOutputAction,
  updatePlanItemAction,
  type PlanFormState,
} from "@/app/planner-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { platformLabels, POST_INTENTS } from "@/lib/social-posts";
import { PURPOSES, purposeLabels, SOCIAL_CHANNELS, type Deliverable } from "@/lib/content-planner";

type Option = { id: string; label: string };
const field = "field w-full";

function Message({ state }: { state: PlanFormState }) {
  return state.error ? <p role="alert" className="text-xs text-red-700">{state.error}</p> : null;
}

type Item = {
  id: string;
  deliverable: string;
  purpose: string;
  topic: string;
  search_intent: string | null;
  service_id: string | null;
  keyword_id: string | null;
  target_url: string | null;
  planned_date: string | null;
  notes: string | null;
};

// The fields a teammate fills for a slot (shared by add and edit).
function PlanFields({ deliverable, services, keywords, week, item, idPrefix }: {
  deliverable: Deliverable; services: Option[]; keywords: Option[]; week: string; item?: Item; idPrefix: string;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const sunday = new Date(`${week}T00:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={id("topic")}>Topic or target keyword</Label>
        <Input id={id("topic")} name="topic" defaultValue={item?.topic} maxLength={200} required placeholder="e.g. Roof replacement before winter" />
      </div>
      {!item && (
        <div className="space-y-1">
          <Label htmlFor={id("purpose")}>Purpose</Label>
          <select id={id("purpose")} name="purpose" className={field} defaultValue="service" required>
            {PURPOSES.filter((p) => p !== "authority").map((p) => <option key={p} value={p}>{purposeLabels[p]}</option>)}
          </select>
        </div>
      )}
      {!item && deliverable === "social" && (
        <div className="space-y-1">
          <Label htmlFor={id("channel")}>Channel</Label>
          <select id={id("channel")} name="channel" className={field} defaultValue="facebook" required>
            {SOCIAL_CHANNELS.map((c) => <option key={c} value={c}>{platformLabels[c].label}</option>)}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={id("intent")}>Search intent</Label>
        <select id={id("intent")} name="search_intent" className={field} defaultValue={item?.search_intent ?? ""}>
          <option value="">Not set yet</option>
          {POST_INTENTS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("service")}>Service</Label>
        <select id={id("service")} name="service_id" className={field} defaultValue={item?.service_id ?? ""}>
          <option value="">None</option>
          {services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("keyword")}>Tracked keyword</Label>
        <select id={id("keyword")} name="keyword_id" className={field} defaultValue={item?.keyword_id ?? ""}>
          <option value="">None</option>
          {keywords.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("date")}>Planned date</Label>
        <Input id={id("date")} name="planned_date" type="date" min={week} max={sunday.toISOString().slice(0, 10)} defaultValue={item?.planned_date ?? ""} />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={id("target")}>Target page / destination</Label>
        <Input id={id("target")} name="target_url" type="url" defaultValue={item?.target_url ?? ""} placeholder="https://…" />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={id("notes")}>Notes</Label>
        <Input id={id("notes")} name="notes" defaultValue={item?.notes ?? ""} maxLength={2000} />
      </div>
    </div>
  );
}

export function AddPlanItemForm({ clientId, week, deliverable, services, keywords, remaining }: {
  clientId: string; week: string; deliverable: Deliverable; services: Option[]; keywords: Option[]; remaining: number;
}) {
  const [state, action, pending] = useActionState(createPlanItemAction.bind(null, clientId, week), {});
  return (
    <details className="rounded-md border border-dashed p-3" data-add-plan-item={deliverable}>
      <summary className="cursor-pointer text-sm font-medium">
        {remaining > 0 ? `Plan ${remaining} more` : "Plan another"}
      </summary>
      <form action={action} className="mt-3 space-y-3" key={state.n ?? 0}>
        <input type="hidden" name="deliverable" value={deliverable} />
        <PlanFields deliverable={deliverable} services={services} keywords={keywords} week={week} idPrefix={`add-${deliverable}`} />
        <Button type="submit" size="sm" disabled={pending}>Add to the plan</Button>
        <Message state={state} />
      </form>
    </details>
  );
}

export function EditPlanItemForm({ clientId, week, item, services, keywords }: {
  clientId: string; week: string; item: Item; services: Option[]; keywords: Option[];
}) {
  const [state, action, pending] = useActionState(updatePlanItemAction.bind(null, clientId, item.id, week), {});
  return (
    <details className="text-xs" data-edit-plan-item>
      <summary className="cursor-pointer text-muted-foreground">Edit details</summary>
      <form action={action} className="mt-2 space-y-2">
        <PlanFields deliverable={item.deliverable as Deliverable} services={services} keywords={keywords} week={week} item={item} idPrefix={`edit-${item.id}`} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Save</Button>
        <Message state={state} />
      </form>
    </details>
  );
}

export function LinkOutputForm({ clientId, itemId, outputs }: { clientId: string; itemId: string; outputs: Option[] }) {
  const [state, action, pending] = useActionState(linkOutputAction.bind(null, clientId, itemId), {});
  if (outputs.length === 0) return null;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-link-output>
      <select name="output" className="field w-72 max-w-full" aria-label="Draft to link" required defaultValue="">
        <option value="" disabled>Link an existing draft…</option>
        {outputs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Link</Button>
      <Message state={state} />
    </form>
  );
}

export function HoldForm({ clientId, itemId, hold }: { clientId: string; itemId: string; hold: string | null }) {
  const [state, action, pending] = useActionState(setHoldAction.bind(null, clientId, itemId), {});
  if (hold) {
    return (
      <form action={action} data-hold-form>
        <input type="hidden" name="hold" value="clear" />
        <Button type="submit" size="sm" variant="ghost" disabled={pending}>{hold === "blocked" ? "Unblock" : "Undo delivered"}</Button>
        <Message state={state} />
      </form>
    );
  }
  return (
    <details className="text-xs" data-hold-form>
      <summary className="cursor-pointer text-muted-foreground">Block or mark delivered</summary>
      <form action={action} className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1"><input type="radio" name="hold" value="delivered" defaultChecked /> Delivered</label>
          <label className="flex items-center gap-1"><input type="radio" name="hold" value="blocked" /> Blocked</label>
        </div>
        <Input name="hold_reason" placeholder="What it is waiting on (blocked) or a note" maxLength={500} />
        <Input name="output_url" type="url" placeholder="Where it went live (optional), https://…" />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Save</Button>
        <Message state={state} />
      </form>
    </details>
  );
}

export function ItemStepButton({ action, label, confirm }: { action: () => Promise<PlanFormState>; label: string; confirm?: string }) {
  const [state, run, pending] = useActionState(async () => action(), {});
  return (
    <form action={run} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>{label}</Button>
      <Message state={state} />
    </form>
  );
}

export function DeletePlanItemButton({ clientId, itemId }: { clientId: string; itemId: string }) {
  return <ItemStepButton action={deletePlanItemAction.bind(null, clientId, itemId)} label="Remove" confirm="Remove this item from the plan?" />;
}
export function UnlinkOutputButton({ clientId, itemId }: { clientId: string; itemId: string }) {
  return <ItemStepButton action={unlinkOutputAction.bind(null, clientId, itemId)} label="Unlink draft" />;
}

export function PlanFromAuthorityForm({ clientId, week, opportunityId }: { clientId: string; week: string; opportunityId: string }) {
  const [state, action, pending] = useActionState(planFromAuthorityAction.bind(null, clientId, week, opportunityId), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-plan-opportunity={opportunityId}>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Plan this week</Button>
      <Message state={state} />
    </form>
  );
}
