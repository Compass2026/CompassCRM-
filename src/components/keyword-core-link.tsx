"use client";

import { useActionState } from "react";
import { linkCoreParent, unlinkCoreParent, type CoreLinkActionState } from "@/app/core-keyword-actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { coreParentLabel, CORE_LINK_REASON_MAX, type CoreLinkState } from "@/lib/keyword-core-link";
import { cn } from "@/lib/utils";

const selectClass = "field-sm";

function Result({ state }: { state: CoreLinkActionState }) {
  if (!state) return null;
  return (
    <span role="status" className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>
      {state.message}
    </span>
  );
}

// The core link of one active keyword outside its site's approved core list
// (20261120200000): its current parent with an unlink control, and a form that
// offers only the parents the database says are eligible (same service and
// intent, compatible city or market, in the approved list).
export function KeywordCoreLink({ clientId, keywordId, state }: { clientId: string; keywordId: string; state: CoreLinkState }) {
  const [linked, linkAction] = useActionState<CoreLinkActionState, FormData>(
    linkCoreParent.bind(null, clientId, keywordId), null);
  const [unlinked, unlinkAction] = useActionState<CoreLinkActionState, FormData>(
    unlinkCoreParent.bind(null, clientId, keywordId), null);
  const { current, candidates } = state;

  return (
    <div className="mt-1 space-y-1 text-xs" data-core-link={keywordId}>
      {current && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            Serves core keyword <span className="font-medium text-foreground">{coreParentLabel(current)}</span>
          </span>
          {current.problem && (
            <span className="text-amber-700" data-core-link-problem>
              This link no longer meets the rule: {current.problem.replace(/^[a-z_]+:\s*/, "")}
            </span>
          )}
          <details>
            <summary className="cursor-pointer text-muted-foreground underline-offset-2 hover:underline">Unlink</summary>
            <form action={unlinkAction} className="mt-1 flex flex-wrap items-center gap-2">
              <Input name="reason" required minLength={3} maxLength={CORE_LINK_REASON_MAX} placeholder="Why clear this link?"
                aria-label="Reason for clearing the core link" className="h-8 min-w-56 text-xs" />
              <Button type="submit" variant="outline" size="sm" loadingLabel="Clearing…">
                Unlink
              </Button>
              <Result state={unlinked} />
            </form>
          </details>
        </div>
      )}
      {candidates.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground underline-offset-2 hover:underline">
            {current ? "Change core keyword" : "Link to core keyword"}
          </summary>
          <form action={linkAction} className="mt-1 flex flex-wrap items-center gap-2">
            <select name="parent_id" required defaultValue="" aria-label="Core keyword" className={selectClass}>
              <option value="" disabled>Choose a core keyword…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{coreParentLabel(c)}</option>
              ))}
            </select>
            <Input name="reason" required minLength={3} maxLength={CORE_LINK_REASON_MAX}
              placeholder="Why does this keyword serve it?" aria-label="Reason for the core link" className="h-8 min-w-56 text-xs" />
            <Button type="submit" size="sm" loadingLabel="Linking…">
              {current ? "Change link" : "Link"}
            </Button>
            <Result state={linked} />
          </form>
        </details>
      )}
      {!current && candidates.length === 0 && (
        <span className="text-muted-foreground">
          Not in the approved core list, and no core keyword shares its service, intent and city.
        </span>
      )}
    </div>
  );
}
