"use client";

import { useActionState, useState } from "react";
import {
  approvePostAction,
  createPostAction,
  linkClaimAction,
  rejectPostAction,
  schedulePostAction,
  updatePostAction,
  type PostFormState,
} from "@/app/social-post-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  COPY_MAX,
  CRM_FACTS_HELP,
  intentHelp,
  platformLabels,
  POST_INTENTS,
  POST_PLATFORMS,
  POST_TYPES,
  type PostIntent,
  type PostPlatform,
} from "@/lib/social-posts";

const selectClass = "field w-full";

type Option = { id: string; label: string };

function FormMessage({ state }: { state: PostFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  return null;
}

export type DraftValues = {
  platform: string;
  post_type: string;
  search_intent: string;
  copy: string | null;
  cta_type: string | null;
  cta_url: string | null;
  crm_facts_only: boolean;
  service_id: string | null;
  offer_id: string | null;
  keyword_id: string | null;
  asset_url: string | null;
  notes: string | null;
};

// New draft (no postId) or edit a draft. Frozen posts never render this.
export function PostDraftForm({
  clientId,
  postId,
  post,
  services,
  offers,
  keywords,
}: {
  clientId: string;
  postId?: string;
  post?: DraftValues;
  services: Option[];
  offers: Option[];
  keywords: Option[];
}) {
  const bound = postId
    ? updatePostAction.bind(null, clientId, postId)
    : createPostAction.bind(null, clientId);
  const [state, action, pending] = useActionState(bound, {});
  const [platform, setPlatform] = useState<PostPlatform>((post?.platform as PostPlatform) ?? "google_business");
  const [intent, setIntent] = useState<PostIntent>((post?.search_intent as PostIntent) ?? "informational");
  const [postType, setPostType] = useState(post?.post_type ?? "standard");
  const gbp = platform === "google_business";

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="platform">Platform</Label>
          <select
            id="platform"
            name="platform"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as PostPlatform);
              if (e.target.value !== "google_business") setPostType("standard");
            }}
            className={selectClass}
          >
            {POST_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {platformLabels[p].label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="post_type">Post type</Label>
          <select
            id="post_type"
            name="post_type"
            value={postType}
            onChange={(e) => setPostType(e.target.value)}
            className={selectClass}
            disabled={!gbp}
          >
            {POST_TYPES.filter((t) => gbp || t === "standard").map((t) => (
              <option key={t} value={t}>
                {t === "standard" ? "Standard" : t === "offer" ? "Offer" : "Event"}
              </option>
            ))}
          </select>
          {!gbp && <input type="hidden" name="post_type" value="standard" />}
        </div>
        <div className="space-y-1">
          <Label htmlFor="search_intent">Search intent</Label>
          <select
            id="search_intent"
            name="search_intent"
            value={intent}
            onChange={(e) => setIntent(e.target.value as PostIntent)}
            className={selectClass}
          >
            {POST_INTENTS.map((i) => (
              <option key={i} value={i}>
                {i[0].toUpperCase() + i.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{intentHelp[intent]}</p>

      <div className="space-y-1">
        <Label htmlFor="copy">Copy</Label>
        <Textarea id="copy" name="copy" rows={5} maxLength={COPY_MAX} defaultValue={post?.copy ?? ""} required />
      </div>

      {intent === "navigational" && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="crm_facts_only" defaultChecked={post?.crm_facts_only ?? false} className="mt-1" />
          <span>
            <span className="font-medium">CRM facts only</span>
            <span className="block text-xs text-muted-foreground">{CRM_FACTS_HELP}</span>
          </span>
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="service_id">Service</Label>
          <select id="service_id" name="service_id" defaultValue={post?.service_id ?? ""} className={selectClass}>
            <option value="">None</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="offer_id">Offer</Label>
          <select id="offer_id" name="offer_id" defaultValue={post?.offer_id ?? ""} className={selectClass}>
            <option value="">None</option>
            {offers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="keyword_id">Keyword</Label>
          <select id="keyword_id" name="keyword_id" defaultValue={post?.keyword_id ?? ""} className={selectClass}>
            <option value="">None</option>
            {keywords.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor="cta_type">Button</Label>
          <select id="cta_type" name="cta_type" defaultValue={post?.cta_type ?? ""} className={selectClass}>
            <option value="">None</option>
            {["LEARN_MORE", "CALL", "BOOK", "ORDER", "SIGN_UP", "SHOP"].map((c) => (
              <option key={c} value={c}>
                {c.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cta_url">Link</Label>
          <Input id="cta_url" name="cta_url" type="url" placeholder="https://" defaultValue={post?.cta_url ?? ""} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="asset_url">Image link</Label>
          <Input id="asset_url" name="asset_url" placeholder="Drive or Canva link" defaultValue={post?.asset_url ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" name="notes" defaultValue={post?.notes ?? ""} />
        </div>
      </div>

      <FormMessage state={state} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {postId ? "Save draft" : "Create draft"}
        </Button>
        {state.ok && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </form>
  );
}

export function LinkClaimForm({ clientId, postId, claims }: { clientId: string; postId: string; claims: Option[] }) {
  const [state, action, pending] = useActionState(linkClaimAction.bind(null, clientId, postId), {});
  if (claims.length === 0) {
    return <p className="text-xs text-muted-foreground">No other usable claims on file for this client.</p>;
  }
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="claim_id">Link a claim</Label>
          <select id="claim_id" name="claim_id" className={selectClass} defaultValue="">
            <option value="" disabled>
              Confirmed or sourced claims…
            </option>
            {claims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          Link
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

// A one-button step (submit, withdraw, revise, reopen, unschedule).
export function PostStepButton({
  action,
  label,
  variant = "default",
  confirm,
}: {
  action: (prev: PostFormState) => Promise<PostFormState>;
  label: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  confirm?: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="space-y-1"
    >
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ReviewForms({
  clientId,
  postId,
  submittedAt,
  ready,
}: {
  clientId: string;
  postId: string;
  submittedAt: string;
  ready: boolean;
}) {
  const [approveState, approve, approving] = useActionState(
    approvePostAction.bind(null, clientId, postId, submittedAt),
    {}
  );
  const [rejectState, reject, rejecting] = useActionState(
    rejectPostAction.bind(null, clientId, postId, submittedAt),
    {}
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <form action={approve} className="space-y-2">
        <Label htmlFor="approve_note">Approve</Label>
        <Textarea id="approve_note" name="review_note" rows={2} placeholder="Optional note" />
        <p className="text-xs text-muted-foreground">
          Approving says every fact in the copy is backed by a linked claim or, for a “CRM facts only” post, by what the
          CRM stores. It does not publish anything.
        </p>
        <Button type="submit" disabled={approving || !ready}>
          Approve
        </Button>
        <FormMessage state={approveState} />
      </form>
      <form action={reject} className="space-y-2">
        <Label htmlFor="reject_note">Reject</Label>
        <Textarea id="reject_note" name="review_note" rows={2} placeholder="What needs to change (required)" required />
        <Button type="submit" variant="outline" disabled={rejecting}>
          Reject
        </Button>
        <FormMessage state={rejectState} />
      </form>
    </div>
  );
}

export function ScheduleForm({
  clientId,
  postId,
  fromPublish,
  defaultValue,
}: {
  clientId: string;
  postId: string;
  fromPublish: string;
  defaultValue?: string;
}) {
  const [state, action, pending] = useActionState(schedulePostAction.bind(null, clientId, postId, fromPublish), {});
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="scheduled_at">Publish at (Central)</Label>
          <Input id="scheduled_at" name="scheduled_at" type="datetime-local" defaultValue={defaultValue} className="w-56" required />
        </div>
        <Button type="submit" disabled={pending}>
          {fromPublish === "failed" ? "Retry at this time" : "Schedule"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Scheduling keeps the approval as it is. Nothing publishes yet: the publisher is not built.
      </p>
      <FormMessage state={state} />
    </form>
  );
}
