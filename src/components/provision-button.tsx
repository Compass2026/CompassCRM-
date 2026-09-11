"use client";

import { useActionState } from "react";
import { provisionClientAction, type ProvisionState } from "@/app/foundation-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ProvisionButton({ clientId }: { clientId: string }) {
  const bound = provisionClientAction.bind(null, clientId);
  const [state, action, pending] = useActionState<ProvisionState, FormData>(bound, null);

  return (
    <form action={action} className="flex items-center gap-2 flex-wrap">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Provisioning…" : "Create Drive folders + repo"}
      </Button>
      {state && (
        <span
          className={cn(
            "text-xs",
            state.ok ? "text-muted-foreground" : "text-destructive"
          )}
        >
          {state.message}
        </span>
      )}
    </form>
  );
}
