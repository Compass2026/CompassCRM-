"use client";

import Link from "next/link";
import { useActionState } from "react";
import { approvePostAction, rejectPostAction, type PostFormState } from "@/app/social-post-actions";
import { approveAndScheduleAction, setNoImageReasonAction } from "@/app/review-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { centralLocalInput, decisionsFor, formatCentral, stageLabels, type QueueItem } from "@/lib/review-queue";
import { cn } from "@/lib/utils";

const channel: Record<string, string> = { facebook: "Facebook", google_business: "Business Profile" };
const rejectWhat = [
  { value: "copy", label: "The copy" },
  { value: "creative", label: "The image" },
  { value: "both", label: "Both" },
] as const;

function Message({ state }: { state: PostFormState }) {
  if (state.error) return <p role="alert" className="text-sm text-red-700">{state.error}</p>;
  if (state.ok) return <p role="status" className="text-sm text-green-700">Done.</p>;
  return null;
}

export type CardImage = { label: string; src: string | null; width: number | null; height: number | null };

export function ReviewCard({ item, proposedAt, images }: { item: QueueItem; proposedAt: string | null; images: CardImage[] }) {
  const d = decisionsFor(item);
  const stage = stageLabels[item.stage];
  const submittedAt = item.submitted_at ?? "";
  const [schedState, schedule, scheduling] = useActionState(approveAndScheduleAction.bind(null, item.client_id, item.id, submittedAt), {});
  const [approveState, approve, approving] = useActionState(approvePostAction.bind(null, item.client_id, item.id, submittedAt), {});
  const [rejectState, reject, rejecting] = useActionState(rejectPostAction.bind(null, item.client_id, item.id, submittedAt), {});
  const [reasonState, setReason, savingReason] = useActionState(setNoImageReasonAction.bind(null, item.client_id, item.id), {});
  const when = item.scheduled_at ?? proposedAt;
  const problems = [...(item.grounding_problems ?? []), ...(item.client_hold ? [item.client_hold] : [])];

  return (
    <article className="surface space-y-3 p-4" data-review-card={item.id} data-card-stage={item.stage}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">{item.client_name}</p>
          <p className="text-xs text-muted-foreground" data-destination>
            {channel[item.platform] ?? item.platform} → {item.destination_name ?? "no account named"}
            {item.service_name && <> · {item.service_name}</>}
            {item.keyword && <> · “{item.keyword}”</>}
          </p>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", stage.className)}>{stage.label}</span>
      </header>

      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-review-images>
          {images.map((im, n) =>
            im.src ? (
              <a key={n} href={im.src} target="_blank" rel="noreferrer" title="Open the full-size image" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={im.src} alt={im.label} className="max-h-72 w-auto max-w-full rounded-md border bg-muted object-contain" />
                <span className="mt-1 block text-xs text-muted-foreground">
                  {im.label}{im.width && im.height ? ` · ${im.width}×${im.height}` : ""}
                </span>
              </a>
            ) : (
              <p key={n} role="alert" className="text-xs text-red-700">{im.label}: the file could not be shown.</p>
            )
          )}
        </div>
      ) : item.no_image_reason ? (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground" data-no-image-reason>
          No image, on purpose: {item.no_image_reason}
        </p>
      ) : (
        item.review_status === "in_review" && (
          <form action={setReason} className="space-y-1 rounded-md border border-dashed border-amber-300 p-2" data-no-image-form>
            <Label htmlFor={`noimg-${item.id}`} className="text-xs">No image attached. Attach one on the post page, or say why it goes without:</Label>
            <div className="flex gap-2">
              <Input id={`noimg-${item.id}`} name="no_image_reason" placeholder="e.g. no verified photo of this location yet" className="h-8 text-xs" />
              <Button type="submit" size="sm" variant="outline" disabled={savingReason}>Save</Button>
            </div>
            <Message state={reasonState} />
          </form>
        )
      )}

      <p className="whitespace-pre-wrap text-sm leading-relaxed" data-review-copy>{item.copy}</p>
      {item.cta_type && <p className="text-xs text-muted-foreground">Button: {item.cta_type}{item.cta_url ? ` → ${item.cta_url}` : ""}</p>}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {item.planned_date && (<><dt className="text-muted-foreground">Slot</dt><dd>{item.planned_date}</dd></>)}
        {when && (
          <>
            <dt className="text-muted-foreground">{item.scheduled_at ? "Publishes" : "Proposed"}</dt>
            <dd data-publish-time>{formatCentral(when)}{item.approved_publish_at ? " (approved for this time)" : ""}</dd>
          </>
        )}
        {item.published_url && (<><dt className="text-muted-foreground">Published</dt><dd><a href={item.published_url} target="_blank" rel="noreferrer" className="underline">{item.published_url}</a> · {formatCentral(item.published_at)}</dd></>)}
        {item.external_post_id && (<><dt className="text-muted-foreground">Provider id</dt><dd className="font-mono">{item.external_post_id}</dd></>)}
        {item.error && (<><dt className="text-muted-foreground">Error</dt><dd className="text-red-700">{item.error} (attempt {item.publish_attempts})</dd></>)}
      </dl>

      {problems.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-900" data-review-problems>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {item.stage === "revising" && item.last_feedback && (
        <p className="rounded-md bg-orange-50 p-2 text-xs text-orange-900" data-feedback>
          Feedback ({item.rejection_category === "creative" ? "image" : item.rejection_category ?? "copy"}): {item.last_feedback}
        </p>
      )}
      {d.why && <p className="text-xs text-muted-foreground" data-publish-blocked>{d.why}</p>}

      {d.approveOnly && (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          {d.approveAndSchedule && (
            <form action={schedule} className="space-y-1.5" data-approve-schedule>
              <Label htmlFor={`at-${item.id}`} className="text-xs">Publish at (Central)</Label>
              <Input id={`at-${item.id}`} type="datetime-local" name="publish_at" required className="h-8 text-xs"
                defaultValue={proposedAt ? centralLocalInput(proposedAt) : undefined} />
              <Input name="review_note" placeholder="Optional note" className="h-8 text-xs" />
              <Button type="submit" size="sm" disabled={scheduling}>Approve &amp; schedule</Button>
              <p className="text-xs text-muted-foreground">Approves this exact copy, image and destination for this time.</p>
              <Message state={schedState} />
            </form>
          )}
          <div className="space-y-3">
            <form action={approve} className="space-y-1" data-approve-only>
              <Button type="submit" size="sm" variant="outline" disabled={approving}>Approve only (no schedule)</Button>
              <p className="text-xs text-muted-foreground">Approval alone never publishes.</p>
              <Message state={approveState} />
            </form>
            <form action={reject} className="space-y-1.5" data-reject>
              <Textarea name="review_note" rows={2} required placeholder="What needs to change (required)" className="text-xs" />
              {images.length > 0 && (
                <fieldset className="flex flex-wrap gap-3 text-xs">
                  <legend className="sr-only">What is rejected</legend>
                  {rejectWhat.map((c) => (
                    <label key={c.value} className="flex items-center gap-1">
                      <input type="radio" name="rejection_category" value={c.value} defaultChecked={c.value === "copy"} /> {c.label}
                    </label>
                  ))}
                </fieldset>
              )}
              <Button type="submit" size="sm" variant="outline" disabled={rejecting}>Reject with feedback</Button>
              <Message state={rejectState} />
            </form>
          </div>
        </div>
      )}

      <p className="text-xs">
        <Link href={`/clients/${item.client_id}/social/${item.id}`} className="underline">Open the post</Link>
      </p>
    </article>
  );
}
