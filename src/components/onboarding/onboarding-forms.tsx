"use client";
import { useActionState } from "react";
import { enrollOnboardingAction, updateOnboardingItemAction, type OnboardingActionState } from "@/app/onboarding-actions";
import { ACCOUNT_SOURCES, STATUSES, statusOptions, type OnboardingRow } from "@/lib/client-onboarding";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export type AccountOption = { id: string; platform: string; label: string };

function Outcome({ state }: { state: OnboardingActionState }) {
  return <>{state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    {state.saved && <p role="status" className="text-sm text-emerald-700">Saved.</p>}
    {state.added !== undefined && <p role="status" className="text-sm text-emerald-700">{state.added ? `${state.added} items added.` : "Nothing missing; no item was changed."}</p>}</>;
}

export function EnrollButton({ clientId, label }: { clientId: string; label: string }) {
  const [state, action, pending] = useActionState(enrollOnboardingAction.bind(null, clientId), {});
  return <form action={action} className="flex flex-wrap items-center gap-3" data-onboarding-enroll>
    <Button size="sm" variant="outline" disabled={pending}>{pending ? "Checking…" : label}</Button><Outcome state={state} />
  </form>;
}

export function ItemForm({ clientId, row, accounts }: { clientId: string; row: OnboardingRow; accounts: AccountOption[] }) {
  const [state, action, pending] = useActionState(updateOnboardingItemAction.bind(null, clientId, row.id), {});
  return <form action={action} className="mt-3 space-y-3 border-t pt-3" data-onboarding-form={row.item_key}>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm">Status
        <select name="status" defaultValue={row.status} className="field-sm block w-full">
          {statusOptions(row).map((s) => <option key={s} value={s}>{STATUSES[s]}</option>)}
        </select></label>
      <label className="space-y-1 text-sm">Due<Input name="due_on" type="date" defaultValue={row.due_on ?? ""} /></label>
      <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="required" defaultChecked={row.required} /> Required for this client</label>
    </div>
    {row.evidence_source && ACCOUNT_SOURCES[row.evidence_source] && <label className="block space-y-1 text-sm">
      {ACCOUNT_SOURCES[row.evidence_source] === "google_business" ? "This location's Business Profile" : "This site's Facebook Page"}
      <select name="social_account_id" defaultValue={row.social_account_id ?? ""} className="field-sm block w-full">
        <option value="">Not named yet</option>
        {accounts.filter((a) => a.platform === ACCOUNT_SOURCES[row.evidence_source!]).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <span className="block text-xs text-muted-foreground">Exact match: one profile or Page credits one location or site. Another location&apos;s binding never counts.</span>
    </label>}
    <label className="block space-y-1 text-sm">Evidence URL<Input name="evidence_url" type="url" maxLength={2000} defaultValue={row.evidence_url ?? ""} placeholder="https:// (listing, screenshot in Drive, property settings)" /></label>
    <label className="block space-y-1 text-sm">Evidence: what was seen, or why it does not apply
      <Textarea name="evidence_note" maxLength={2000} defaultValue={row.evidence_note} /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Blocking reason<Input name="blocking_reason" maxLength={1000} defaultValue={row.blocking_reason} /></label>
      <label className="space-y-1 text-sm">Next action<Input name="next_action" maxLength={1000} defaultValue={row.next_action} /></label>
    </div>
    <p className="text-xs text-muted-foreground">Record who has access, never a password or key. Verified is signed with your name; a connected account never signs anything off.</p>
    <Outcome state={state} /><Button size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
  </form>;
}
