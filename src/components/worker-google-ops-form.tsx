"use client";

import { useActionState } from "react";
import { saveWorkerGoogleOpsAction, type ActionState } from "@/app/settings-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Settings › Worker Google operations. A connected Google account is only a
// credential; this switch is what lets the unattended worker write with it.
export function WorkerGoogleOpsForm({
  enabled,
  changedBy,
  changedAt,
  googleConnected,
}: {
  enabled: boolean;
  changedBy: string | null;
  changedAt: string | null;
  googleConnected: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveWorkerGoogleOpsAction, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const on = (e.currentTarget.elements.namedItem("enabled") as HTMLInputElement | null)?.checked;
        if (on && !enabled && !window.confirm("Let the worker write to clients' Google properties (Business Profile edits, GA4, Gmail drafts, Q&A, sitemaps) without a person pressing a button?")) {
          e.preventDefault();
        }
      }}
      className="space-y-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        {enabled ? (
          <Badge variant="outline" className="border-amber-200 bg-amber-100 text-[10px] text-amber-900">on — the worker may write to Google</Badge>
        ) : (
          <Badge variant="outline" className="border-emerald-200 bg-emerald-100 text-[10px] text-emerald-800">off — the worker cannot write to Google</Badge>
        )}
        {changedAt && (
          <span className="text-xs text-muted-foreground">
            last changed by {changedBy ?? "someone"} on {new Date(changedAt).toLocaleString("en-US", { timeZone: "America/Chicago" })}
          </span>
        )}
      </div>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="size-4" />
        Allow the worker to write to Google
      </label>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
        <li>Off: <code>gbp_apply</code>, <code>ga4_provision</code>, <code>gmail_draft</code>, <code>gbp_qa</code>, Search Console sitemap submission and any new Google write are refused for the worker; those steps become your tasks.</li>
        <li>Read-only checks (finding a client&apos;s Business Profile, Check access, the monthly Search Console sync) run either way.</li>
        <li>Connecting Google does not turn this on{googleConnected ? "" : " (Google is not connected yet)"}. Business Profile posts are governed by the Publisher switch below, not this one.</li>
      </ul>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save</Button>
        {state && <span className={cn("text-xs", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</span>}
      </div>
    </form>
  );
}
