"use client";

import { useActionState } from "react";
import { savePublisherSettingsAction, type ActionState } from "@/app/settings-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Settings › Publisher (0046): the Business Profile publisher's switch and
// pilot list. Both must name a client before anything of theirs is sent.
export function PublisherSettingsForm({
  enabled,
  selected,
  clients,
  googleConnected,
}: {
  enabled: boolean;
  selected: string[];
  clients: { id: string; name: string; hasLocation: boolean }[];
  googleConnected: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(savePublisherSettingsAction, null);
  const chosen = new Set(selected);
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="size-4" />
        Publish approved, scheduled Business Profile posts
      </label>
      {!googleConnected && (
        <p className="text-xs text-amber-900">
          Google is not connected (Google hands above): every post will be blocked until it is.
        </p>
      )}
      <fieldset className="space-y-1">
        <legend className="text-xs text-muted-foreground">Pilot clients (only these are published)</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {clients.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input type="checkbox" name="clients" value={c.id} defaultChecked={chosen.has(c.id)} className="size-4" />
              <span>{c.name}</span>
              {!c.hasLocation && <span className="text-xs text-muted-foreground">(profile found on first run)</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Runs every 5 minutes, at most 5 posts a run and one per Business Profile; 429, 5xx and network errors are retried
        up to 3 attempts. Other platforms are never published: their scheduled time opens a “post this by hand” task.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save</Button>
        {state && <span className={cn("text-xs", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</span>}
      </div>
    </form>
  );
}
