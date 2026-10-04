"use client";

import { useActionState } from "react";
import {
  decideClientTemplateAction,
  recordTemplatePreviewAction,
  setChannelCreativePolicyAction,
  type CreativeFormState,
} from "@/app/creative-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CREATIVE_POLICIES, policyLabels, type CreativePolicy } from "@/lib/creative-post";

function Message({ state }: { state: CreativeFormState }) {
  if (state.error) return <p role="alert" className="text-xs text-red-700">{state.error}</p>;
  if (state.text) return <p role="status" className="text-xs text-green-800">{state.text}</p>;
  return null;
}

export function RecordPreviewButton({ clientId, templateKey, again }: { clientId: string; templateKey: string; again: boolean }) {
  const [state, action, pending] = useActionState(recordTemplatePreviewAction.bind(null, clientId, templateKey), {});
  return (
    <form action={action} className="space-y-1" data-record-preview={templateKey}>
      <Button type="submit" size="sm" variant={again ? "outline" : "default"} disabled={pending}>
        {pending ? "Recording…" : again ? "Record preview again" : "Record preview for approval"}
      </Button>
      <Message state={state} />
    </form>
  );
}

export function TemplateDecisionButtons({ clientId, rowId, status }: { clientId: string; rowId: string; status: string }) {
  const [approveState, approve, approving] = useActionState(decideClientTemplateAction.bind(null, clientId, rowId, "approve", status), {});
  const [revokeState, revoke, revoking] = useActionState(decideClientTemplateAction.bind(null, clientId, rowId, "revoke", status), {});
  return (
    <div className="space-y-1" data-template-decision={status}>
      <div className="flex flex-wrap gap-2">
        {status === "proposed" && (
          <form action={approve}>
            <Button type="submit" size="sm" disabled={approving}>Approve for this client</Button>
          </form>
        )}
        {status !== "revoked" && (
          <form
            action={revoke}
            onSubmit={(e) => {
              if (status === "approved" && !window.confirm("Revoke this template for the client? Posts can no longer render with it.")) e.preventDefault();
            }}
          >
            <Button type="submit" size="sm" variant="outline" disabled={revoking}>Revoke</Button>
          </form>
        )}
      </div>
      <Message state={approveState.error || approveState.text ? approveState : revokeState} />
    </div>
  );
}

export function ChannelPolicyForm({ clientId, channel, label, policy }: { clientId: string; channel: string; label: string; policy: CreativePolicy }) {
  const [state, action, pending] = useActionState(setChannelCreativePolicyAction.bind(null, clientId), {});
  return (
    <form action={action} className="space-y-1" data-channel-policy={channel}>
      <input type="hidden" name="channel" value={channel} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`policy_${channel}`}>{label}</Label>
          <select id={`policy_${channel}`} name="creative_policy" defaultValue={policy} className="field w-48">
            {CREATIVE_POLICIES.map((p) => (
              <option key={p} value={p}>{policyLabels[p].label}</option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Save</Button>
      </div>
      <Message state={state} />
    </form>
  );
}
