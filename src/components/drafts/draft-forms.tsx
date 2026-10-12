"use client";

import { useActionState } from "react";
import {
  approveDraftAction,
  deleteDraftAction,
  generateDraftAction,
  regenerateDraftAction,
  rejectDraftAction,
  reopenDraftAction,
  reviseDraftAction,
  saveDraftAction,
  submitDraftAction,
  withdrawDraftAction,
  type DraftFormState,
} from "@/app/draft-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function Message({ state }: { state: DraftFormState }) {
  if (state.error) return <p role="alert" className="text-sm text-red-700">{state.error}</p>;
  if (state.text) return <p role="status" className="text-sm text-green-800">{state.text}</p>;
  return null;
}

export function GenerateDraftForm({ clientId, planItemId, label = "Generate draft" }: { clientId: string; planItemId: string; label?: string }) {
  const [state, action, pending] = useActionState(generateDraftAction.bind(null, clientId, planItemId), {});
  return (
    <form action={action} className="space-y-1" data-generate-draft>
      <div className="flex flex-wrap items-end gap-2">
        <Input name="note" placeholder="Anything the drafter should know (optional)" maxLength={2000} className="w-72 max-w-full" />
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Requesting…" : label}</Button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function StepButton({ action, label, variant = "default", confirm }: {
  action: () => Promise<DraftFormState>; label: string; variant?: "default" | "outline" | "ghost" | "destructive"; confirm?: string;
}) {
  const [state, run, pending] = useActionState(async () => action(), {});
  return (
    <form action={run} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }} className="space-y-1">
      <Button type="submit" size="sm" variant={variant} disabled={pending}>{label}</Button>
      <Message state={state} />
    </form>
  );
}

export function DraftSteps({ clientId, draftId, status, version, actions }: {
  clientId: string; draftId: string; status: string; version: number; actions: string[];
}) {
  return (
    <div className="flex flex-wrap items-start gap-2" data-draft-steps>
      {actions.includes("submit") && <StepButton action={submitDraftAction.bind(null, clientId, draftId, version)} label="Submit for review" />}
      {actions.includes("withdraw") && <StepButton action={withdrawDraftAction.bind(null, clientId, draftId, version)} label="Withdraw to edit" variant="outline" />}
      {status === "rejected" && <StepButton action={reviseDraftAction.bind(null, clientId, draftId, version)} label="Revise" variant="outline" />}
      {actions.includes("reopen") && (
        <StepButton action={reopenDraftAction.bind(null, clientId, draftId, version)} label="Reopen (clears approval)" variant="outline"
          confirm="Reopening clears the approval. The final article stays and is updated when you approve again. Continue?" />
      )}
      {actions.includes("delete") && (
        <StepButton action={deleteDraftAction.bind(null, clientId, draftId)} label="Delete draft" variant="ghost" confirm="Delete this draft?" />
      )}
    </div>
  );
}

export function ReviewDraftForms({ clientId, draftId, version, ready }: { clientId: string; draftId: string; version: number; ready: boolean }) {
  const [approveState, approve, approving] = useActionState(approveDraftAction.bind(null, clientId, draftId, version), {});
  const [rejectState, reject, rejecting] = useActionState(rejectDraftAction.bind(null, clientId, draftId, version), {});
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-review-draft>
      <form action={approve} className="space-y-2">
        <Label htmlFor="approve_note">Approve</Label>
        <Textarea id="approve_note" name="review_note" rows={2} placeholder="Optional note" />
        <p className="text-xs text-muted-foreground">
          Approving says every fact in the article is backed by a linked claim or what the CRM stores. A blog becomes the
          client&apos;s final article (Content tab). Nothing is published.
        </p>
        <Button type="submit" disabled={approving || !ready}>Approve</Button>
        <Message state={approveState} />
      </form>
      <form action={reject} className="space-y-2">
        <Label htmlFor="reject_note">Reject</Label>
        <Textarea id="reject_note" name="review_note" rows={2} placeholder="What needs to change (required)" required />
        <Button type="submit" variant="outline" disabled={rejecting}>Reject</Button>
        <Message state={rejectState} />
      </form>
    </div>
  );
}

export function RegenerateForm({ clientId, draftId }: { clientId: string; draftId: string }) {
  const [state, action, pending] = useActionState(regenerateDraftAction.bind(null, clientId, draftId), {});
  return (
    <form action={action} className="space-y-1" data-regenerate-draft>
      <Label htmlFor="regen_note">Regenerate</Label>
      <div className="flex flex-wrap items-end gap-2">
        <Input id="regen_note" name="note" placeholder="What the next version should do differently" maxLength={2000} className="w-80 max-w-full" />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Regenerate</Button>
      </div>
      <Message state={state} />
    </form>
  );
}

type Claim = { id: string; claim: string; status: string; source: string | null };
export function EditDraftForm({ clientId, draftId, version, draft, claims, linked }: {
  clientId: string; draftId: string; version: number; claims: Claim[]; linked: string[];
  draft: { title: string | null; slug: string | null; meta_title: string | null; meta_description: string | null; h1: string | null;
    outline: { level: number; heading: string }[]; body_markdown: string | null; internal_links: { url: string; anchor: string }[]; cta: { text?: string; url?: string | null } };
}) {
  const [state, action, pending] = useActionState(saveDraftAction.bind(null, clientId, draftId, version), {});
  const f = "space-y-1";
  return (
    <form action={action} className="space-y-3" data-edit-draft>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={f}><Label htmlFor="d_title">Title</Label><Input id="d_title" name="title" defaultValue={draft.title ?? ""} /></div>
        <div className={f}><Label htmlFor="d_slug">Slug</Label><Input id="d_slug" name="slug" defaultValue={draft.slug ?? ""} /></div>
        <div className={f}><Label htmlFor="d_mt">Meta title</Label><Input id="d_mt" name="meta_title" defaultValue={draft.meta_title ?? ""} /></div>
        <div className={f}><Label htmlFor="d_h1">H1</Label><Input id="d_h1" name="h1" defaultValue={draft.h1 ?? ""} /></div>
        <div className={`${f} sm:col-span-2`}><Label htmlFor="d_md">Meta description</Label><Input id="d_md" name="meta_description" defaultValue={draft.meta_description ?? ""} /></div>
      </div>
      <div className={f}>
        <Label htmlFor="d_outline">Outline (one heading per line, ## or ###)</Label>
        <Textarea id="d_outline" name="outline" rows={4} defaultValue={draft.outline.map((o) => `${"#".repeat(o.level)} ${o.heading}`).join("\n")} />
      </div>
      <div className={f}>
        <Label htmlFor="d_body">Article body (Markdown, from H2)</Label>
        <Textarea id="d_body" name="body_markdown" rows={18} defaultValue={draft.body_markdown ?? ""} className="font-mono text-xs" />
      </div>
      <div className={f}>
        <Label htmlFor="d_links">Internal-link recommendations (URL, then anchor text; one per line)</Label>
        <Textarea id="d_links" name="internal_links" rows={3} defaultValue={draft.internal_links.map((l) => `${l.url} ${l.anchor}`).join("\n")} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={f}><Label htmlFor="d_cta">CTA text</Label><Input id="d_cta" name="cta_text" defaultValue={draft.cta.text ?? ""} /></div>
        <div className={f}><Label htmlFor="d_cta_url">CTA link</Label><Input id="d_cta_url" name="cta_url" type="url" defaultValue={draft.cta.url ?? ""} /></div>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Claims the article stands on</legend>
        {claims.map((c) => (
          <label key={c.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="claim_id" value={c.id} defaultChecked={linked.includes(c.id)} className="mt-1" />
            <span>{c.claim} <span className="text-xs text-muted-foreground">({c.status})</span></span>
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={pending}>Save changes</Button>
      <Message state={state} />
    </form>
  );
}
