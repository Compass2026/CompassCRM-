"use client";

import { useActionState } from "react";
import { setWorkModeAction, type WorkModeState } from "@/app/foundation-actions";
import { cn } from "@/lib/utils";

const OPTIONS: { value: "new_build" | "upgrade_existing" | "client_retains"; label: string }[] = [
  { value: "new_build", label: "new build (Foundation)" },
  { value: "upgrade_existing", label: "upgrade existing (previews + PRs)" },
  { value: "client_retains", label: "client retains (documents only)" },
];

// The website work mode, editable on the Foundation tab for clients created
// before it existed. Changing it never enrolls or drops a pipeline — that
// stays a Plan-tab decision — it only tells the worker and site-push how to
// treat the site.
export function WorkModeSelect({ clientId, value }: { clientId: string; value: string | null }) {
  const bound = setWorkModeAction.bind(null, clientId);
  const [state, action, pending] = useActionState<WorkModeState, FormData>(bound, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <select
        name="work_mode"
        defaultValue={value ?? ""}
        disabled={pending}
        className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
        aria-label="Website work mode"
      >
        <option value="">work mode not set</option>
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="submit" className="text-xs underline underline-offset-2 disabled:opacity-50" disabled={pending}>
        save
      </button>
      {state && <span className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>{state.message}</span>}
    </form>
  );
}
