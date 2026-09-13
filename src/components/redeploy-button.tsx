"use client";

import { useActionState } from "react";
import { redeploySiteAction, type RedeployState } from "@/app/foundation-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Tom's manual redeploy: asks site-push to start a production deployment of
// the branch it last pushed, without a new commit. Also the retry when the
// push succeeded but Vercel did not.
export function RedeployButton({ clientId }: { clientId: string }) {
  const bound = redeploySiteAction.bind(null, clientId);
  const [state, action, pending] = useActionState<RedeployState, FormData>(bound, null);

  return (
    <form action={action} className="flex items-center gap-2 flex-wrap">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Deploying…" : "Redeploy on Vercel"}
      </Button>
      {state && (
        <span className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>
          {state.message}
        </span>
      )}
    </form>
  );
}
