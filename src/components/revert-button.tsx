"use client";

import { useActionState } from "react";
import { revertSiteAction, type RedeployState } from "@/app/foundation-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Tom's safety net for publish-without-a-look: one commit that restores the
// previous state of the site. Each press goes back one more step.
export function RevertButton({ clientId, lastChange }: { clientId: string; lastChange: string | null }) {
  const bound = revertSiteAction.bind(null, clientId);
  const [state, action, pending] = useActionState<RedeployState, FormData>(bound, null);

  return (
    <form
      action={action}
      className="flex items-center gap-2 flex-wrap"
      onSubmit={(e) => {
        if (!confirm(`Put the site back to before${lastChange ? `: ${lastChange}` : " the last change"}?`)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Putting back…" : "Put it back"}
      </Button>
      {state && (
        <span className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>{state.message}</span>
      )}
    </form>
  );
}
