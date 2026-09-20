"use client";

import { useActionState } from "react";
import { generateBuildBriefAction, type BuildBriefState } from "@/app/foundation-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Generates (or refreshes) the website build brief from the CRM rows and
// stores it on the site row. Drive filing is the worker's job (the app has
// no Google credentials); the Foundation tab shows the summary.
export function BuildBriefButton({ clientId, hasBrief }: { clientId: string; hasBrief: boolean }) {
  const bound = generateBuildBriefAction.bind(null, clientId);
  const [state, action, pending] = useActionState<BuildBriefState, FormData>(bound, null);

  return (
    <form action={action} className="flex items-center gap-2 flex-wrap">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Composing…" : hasBrief ? "Refresh build brief" : "Generate build brief"}
      </Button>
      {state && (
        <span className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>{state.message}</span>
      )}
    </form>
  );
}
