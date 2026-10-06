"use client";

import { useActionState } from "react";
import {
  generatePostCreativeAction,
  requestNewCreativeAction,
  setPostCreativePolicyAction,
  type CreativeFormState,
} from "@/app/creative-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CREATIVE_POLICIES, policyLabels, type CreativePolicy } from "@/lib/creative-post";

function Message({ state }: { state: CreativeFormState }) {
  if (state.error) return <p role="alert" className="text-sm text-red-700">{state.error}</p>;
  if (state.text) return <p role="status" className="text-sm text-green-800">{state.text}</p>;
  return null;
}

export function CreativePolicyForm({ clientId, postId, policy }: { clientId: string; postId: string; policy: CreativePolicy }) {
  const [state, action, pending] = useActionState(setPostCreativePolicyAction.bind(null, clientId, postId), {});
  return (
    <form action={action} className="space-y-1" data-creative-policy-form>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="creative_policy">Graphic</Label>
          <select id="creative_policy" name="creative_policy" defaultValue={policy} className="field w-56">
            {CREATIVE_POLICIES.map((p) => (
              <option key={p} value={p}>{policyLabels[p].label}</option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" disabled={pending}>Save</Button>
      </div>
      <p className="text-xs text-muted-foreground">{policyLabels[policy].help}</p>
      <Message state={state} />
    </form>
  );
}

export function GenerateCreativeForm({
  clientId,
  postId,
  templates,
  hasCreative,
}: {
  clientId: string;
  postId: string;
  templates: { id: string; label: string }[];
  hasCreative: boolean;
}) {
  const [state, action, pending] = useActionState(generatePostCreativeAction.bind(null, clientId, postId), {});
  return (
    <form action={action} className="space-y-1" data-generate-creative-form>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="template_id">Template</Label>
          <select id="template_id" name="template_id" className="field w-72 max-w-full" required>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Rendering…" : hasCreative ? "Render again" : "Generate graphic"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The graphic carries only governed words — the post&apos;s service, the claims linked to it, the tagline, the
        standing CTA, phone and website — and the client&apos;s approved own-work photos. It is linked to this draft for review.
      </p>
      <Message state={state} />
    </form>
  );
}

export function RequestNewCreativeForm({ clientId, postId, from }: { clientId: string; postId: string; from: string }) {
  const [state, action, pending] = useActionState(requestNewCreativeAction.bind(null, clientId, postId), {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (from === "approved" && !window.confirm("This clears the approval and unlinks the graphic. Continue?")) e.preventDefault();
      }}
      className="space-y-1"
      data-request-new-creative-form
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="creative_note">Request new graphic</Label>
          <Input id="creative_note" name="note" placeholder="What should change (optional)" maxLength={500} />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>Request new graphic</Button>
      </div>
      <p className="text-xs text-muted-foreground">Keeps the copy; unlinks the graphic and returns the post to draft.</p>
      <Message state={state} />
    </form>
  );
}
