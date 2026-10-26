"use client";

import { useActionState } from "react";
import {
  editCaptionAction,
  reclassifyRevisionAction,
  reopenManualAction,
  requestCorrectionAction,
  resolveRevisionAction,
  type RevisionFormState,
} from "@/app/post-revision-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  categoryLabels,
  obligationLabel,
  REVISION_CATEGORIES,
  requestStatusLabels,
  revisionActions,
  type RevisionCategory,
  type RevisionRequest,
} from "@/lib/post-revisions";
import { cn } from "@/lib/utils";

function Message({ state }: { state: RevisionFormState }) {
  if (state.error) return <p role="alert" className="text-sm text-red-700">{state.error}</p>;
  if (state.message) return <p role="status" className="text-sm text-green-800">{state.message}</p>;
  return null;
}

function StepButton({ action, label, variant = "outline", confirm, testId }: {
  action: (prev: RevisionFormState) => Promise<RevisionFormState>;
  label: string;
  variant?: "default" | "outline";
  confirm?: string;
  testId: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form action={run} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }} className="space-y-1">
      <Button type="submit" variant={variant} disabled={pending} data-revision-action={testId}>{label}</Button>
      <Message state={state} />
    </form>
  );
}

function ResolveForm({ clientId, postId, requestId, obligation }: { clientId: string; postId: string; requestId: string; obligation: "copy" | "image" }) {
  const [state, action, pending] = useActionState(resolveRevisionAction.bind(null, clientId, postId, requestId, obligation), {});
  const what = obligation === "copy" ? "caption" : "image";
  return (
    <form action={action} className="space-y-1" data-revision-resolve={obligation}>
      <Label htmlFor={`resolve_${obligation}`} className="text-xs">The {what} needs no change</Label>
      <div className="flex flex-wrap items-start gap-2">
        <Textarea id={`resolve_${obligation}`} name="note" rows={1} placeholder="Why (required; recorded with your name)" className="min-w-0 flex-1" required />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>Record</Button>
      </div>
      <Message state={state} />
    </form>
  );
}

function ReclassifyForm({ clientId, postId, requestId, category, hasMedia }: {
  clientId: string; postId: string; requestId: string; category: RevisionCategory; hasMedia: boolean;
}) {
  const [state, action, pending] = useActionState(reclassifyRevisionAction.bind(null, clientId, postId, requestId), {});
  return (
    <form action={action} className="space-y-1" data-revision-reclassify>
      <Label htmlFor="revision_category" className="text-xs">Correct what was rejected</Label>
      <div className="flex flex-wrap items-start gap-2">
        <select id="revision_category" name="category" defaultValue={category} className="field w-48">
          {REVISION_CATEGORIES.filter((c) => hasMedia || c === "copy").map((c) => (
            <option key={c} value={c}>{categoryLabels[c]}</option>
          ))}
        </select>
        <Textarea name="note" rows={1} placeholder="Why (required)" className="min-w-0 flex-1" required />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>Change category</Button>
      </div>
      <p className="text-xs text-muted-foreground">The original classification stays in the history; the correction is recorded with your name.</p>
      <Message state={state} />
    </form>
  );
}

// The rejection's correction: feedback, who does each part, where it stands,
// and what a teammate can do. Shown through reopening and review.
export function PostRevisionPanel({
  clientId, postId, request, reviewStatus, rejectedByName, hasMedia, history,
}: {
  clientId: string;
  postId: string;
  request: RevisionRequest;
  reviewStatus: string;
  rejectedByName: string;
  hasMedia: boolean;
  history: { id: number; text: string; at: string }[];
}) {
  const status = requestStatusLabels[request.status] ?? { label: request.status, className: "" };
  const actions = revisionActions(request, reviewStatus);
  const cat = (REVISION_CATEGORIES as readonly string[]).includes(request.category) ? (request.category as RevisionCategory) : "copy";
  const original = (REVISION_CATEGORIES as readonly string[]).includes(request.original_category) ? (request.original_category as RevisionCategory) : "copy";
  const rows: { key: "copy" | "image"; title: string; state: string; detail: string | null }[] = [
    { key: "copy", title: "Caption", state: request.copy_state, detail: request.copy_detail },
    { key: "image", title: "Image", state: request.image_state, detail: request.image_detail },
  ];
  return (
    <section aria-label="Rejection feedback" className="surface space-y-3 p-4 text-sm sm:p-5" data-post-revision data-revision-status={request.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Rejection feedback</h3>
        <Badge variant="outline" className={cn("text-[10px]", status.className)}>{status.label}</Badge>
        <Badge variant="outline" className="text-[10px]">{request.mode === "automatic" ? "Automatic correction" : "Manual"}</Badge>
        {request.legacy && <Badge variant="outline" className="text-[10px]">Recovered</Badge>}
      </div>
      <p role="note" className="whitespace-pre-wrap rounded-md border-l-4 border-red-300 bg-red-50 p-3 text-red-900">
        Rejected by {rejectedByName}: “<span data-revision-feedback>{request.feedback}</span>”
      </p>
      <p className="text-xs text-muted-foreground">
        What was rejected: <span className="font-medium text-foreground">{categoryLabels[cat]}</span>
        {original !== cat && <> (first recorded as {categoryLabels[original].toLowerCase()})</>}.
      </p>
      <ul className="space-y-2" data-revision-obligations>
        {rows.map((o) => {
          const l = obligationLabel(o.key, o.state, request);
          return (
            <li key={o.key} className="flex flex-wrap items-start gap-2" data-obligation={o.key} data-state={o.state}>
              <span className="w-16 shrink-0 font-medium">{o.title}</span>
              <Badge variant="outline" className={cn("text-[10px]", l.className)}>{l.label}</Badge>
              {o.detail && o.state !== "not_needed" && <span className="min-w-0 flex-1 text-xs text-muted-foreground">{o.detail}</span>}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        The post goes back for a fresh review only when every rejected part is corrected or a teammate records that it needs no change.
        Nothing here approves, schedules or publishes it.
      </p>
      {actions.length > 0 && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-start gap-3">
            {actions.includes("request_correction") && (
              <StepButton testId="request_correction" variant="default"
                action={requestCorrectionAction.bind(null, clientId, postId, request.id)}
                label={request.mode === "manual" ? "Request automatic correction" : "Retry automatic correction"} />
            )}
            {actions.includes("reopen_manual") && (
              <StepButton testId="reopen_manual"
                action={reopenManualAction.bind(null, clientId, postId, request.id)}
                label="Reopen to edit by hand"
                confirm="Stop the automatic correction and edit the post yourself? The feedback stays on the post." />
            )}
          </div>
          {actions.includes("resolve_copy") && <ResolveForm clientId={clientId} postId={postId} requestId={request.id} obligation="copy" />}
          {actions.includes("resolve_image") && <ResolveForm clientId={clientId} postId={postId} requestId={request.id} obligation="image" />}
          {actions.includes("reclassify") && (
            <ReclassifyForm clientId={clientId} postId={postId} requestId={request.id} category={cat} hasMedia={hasMedia} />
          )}
        </div>
      )}
      {history.length > 0 && (
        <details className="text-xs" data-revision-history>
          <summary className="cursor-pointer text-muted-foreground">Correction history</summary>
          <ol className="mt-2 space-y-1 border-l pl-3">
            {history.map((h) => (
              <li key={h.id} className="text-muted-foreground">{h.text} · <time dateTime={h.at}>{h.at}</time></li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

// Edit the caption without leaving review: one step that withdraws (or
// reopens), saves only the caption and sends the post back for a fresh review.
export function EditCaptionForm({ clientId, postId, copy, copyHash, reviewStatus }: {
  clientId: string; postId: string; copy: string; copyHash: string; reviewStatus: string;
}) {
  const [state, action, pending] = useActionState(editCaptionAction.bind(null, clientId, postId, copyHash), {});
  return (
    <details className="rounded-md border p-3" data-edit-caption>
      <summary className="cursor-pointer text-sm font-medium">Edit caption</summary>
      <form action={action} className="mt-2 space-y-2">
        <Textarea name="copy" rows={5} defaultValue={copy} aria-label="Caption" required />
        <p className="text-xs text-muted-foreground">
          {reviewStatus === "in_review"
            ? "Saving withdraws the post, changes only the caption and sends it back for a fresh review."
            : "Saving changes only the caption and sends the post back for a fresh review once every rejected part is corrected."}{" "}
          The image, keyword, service, claims and destination stay as they are.
        </p>
        <Button type="submit" disabled={pending}>Save caption</Button>
        <Message state={state} />
      </form>
    </details>
  );
}
