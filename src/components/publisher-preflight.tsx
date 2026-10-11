"use client";

import { useActionState } from "react";
import type { PreflightState } from "@/app/social-post-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The publisher's no-write preflight for one post: every gate it would check,
// the exact Zernio request it would send (the key is never shown), and
// whether it would publish. Nothing is sent or recorded.
export function PublisherPreflight({ action }: { action: (prev: PreflightState) => Promise<PreflightState> }) {
  const [state, run, running] = useActionState<PreflightState>(action, null);
  return (
    <div className="space-y-2" data-preflight>
      <form action={run}>
        <Button type="submit" size="sm" variant="outline" disabled={running}>Check without sending</Button>
      </form>
      {state && !state.ok && <p role="alert" className="text-xs text-red-700">{state.message}</p>}
      {state?.ok && (
        <div className="space-y-2 text-xs">
          <p className={cn("font-medium", state.wouldPublish ? "text-green-800" : "text-amber-800")} data-preflight-verdict>
            {state.wouldPublish
              ? "Would publish: every gate passes. Nothing was sent."
              : `Would not publish yet: ${(state.blocking ?? []).join("; ")}. Nothing was sent.`}
          </p>
          <ul className="space-y-0.5">
            {(state.checks ?? []).map((c) => (
              <li key={c.gate} className={cn(c.ok === false ? "text-red-700" : c.ok ? "text-muted-foreground" : "text-muted-foreground italic")}>
                {c.ok === false ? "✗" : c.ok ? "✓" : "–"} {c.gate}{c.detail ? `: ${c.detail}` : ""}
              </li>
            ))}
          </ul>
          {state.request && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">The exact request ({state.request.steps.join(" → ")})</summary>
              <p className="mt-1 font-mono">POST {state.request.url} · Idempotency-Key {state.request.idempotencyKey}</p>
              <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">{JSON.stringify(state.request.body, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
