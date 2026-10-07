"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { decideAuthorityAction } from "@/app/authority-actions";
import {
  dismissUntil,
  formatDay,
  lifecycleMenu,
  REASON_MAX,
  type MenuItem,
  type Workflow,
} from "@/lib/authority-lifecycle";
import { cn } from "@/lib/utils";

// The lifecycle menu on one opportunity: Accept / Release / Dismiss for 30,
// 60 or 90 days / Never recommend again / Reopen. Authority workflow only:
// nothing here changes client data or starts an analysis.
export function OpportunityLifecycle({ clientId, topic, workflow }: { clientId: string; topic: string; workflow: Workflow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<MenuItem | null>(null);
  const [reason, setReason] = useState("");
  const [permanentOk, setPermanentOk] = useState(false);
  const busy = useRef(false);
  const items = lifecycleMenu(workflow);
  if (!items.length) return null;

  const expected = { status: workflow.status, suppressed: workflow.suppressed, dismissed_until: workflow.dismissed_until };

  function run(item: MenuItem, why?: string) {
    if (busy.current) return; // one decision at a time, whatever the clicks
    busy.current = true;
    setMessage(null);
    startTransition(async () => {
      const r = await decideAuthorityAction(clientId, workflow.opportunityId, { verb: item.verb, days: item.days, reason: why, expected });
      busy.current = false;
      setMessage({ ok: r.ok, text: r.text });
      if (r.ok || ("changed" in r && r.changed)) {
        setDialog(null);
        router.refresh();
      }
    });
  }

  function choose(item: MenuItem) {
    if (!item.enabled) return;
    if (!item.dialog) return run(item);
    setReason("");
    setPermanentOk(false);
    setMessage(null);
    setDialog(item);
  }

  const primary = items.find((i) => (i.verb === "accept" || i.verb === "reopen") && i.enabled) ?? null;
  const rest = items.filter((i) => i !== primary);
  const disabledReason = rest.find((i) => !i.enabled)?.reason ?? null;
  const suppress = dialog?.verb === "suppress";
  const until = dialog?.days ? dismissUntil(dialog.days, new Date()) : null;
  const canConfirm = reason.trim().length > 0 && reason.trim().length <= REASON_MAX && (!suppress || permanentOk) && !pending;

  return (
    <div className="mt-2 space-y-1.5" data-lifecycle={workflow.opportunityId}>
      <div className="flex flex-wrap items-center gap-2">
        {primary && (
          <Button loading={pending} type="button" size="xs" variant="outline" disabled={pending} data-verb={primary.verb} onClick={() => choose(primary)}>
            {primary.label}
          </Button>
        )}
        {rest.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" size="xs" variant="ghost" disabled={pending} data-menu="lifecycle" />}>
              {primary ? "More…" : "Actions…"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              {rest.map((i) => (
                <DropdownMenuItem
                  key={i.id}
                  disabled={!i.enabled}
                  data-item={i.id}
                  variant={i.verb === "suppress" ? "destructive" : "default"}
                  onClick={() => choose(i)}
                >
                  {i.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {disabledReason && <span className="text-[11px] text-muted-foreground" data-disabled-reason>{disabledReason}</span>}
      </div>
      <div role="status" aria-live="polite" data-lifecycle-message={message ? (message.ok ? "ok" : "error") : ""}>
        {message && (
          <p className={cn("text-xs", message.ok ? "text-green-800" : "text-red-800")}>{message.text}</p>
        )}
      </div>

      <Dialog open={!!dialog} onOpenChange={(open) => { if (!open && !pending) setDialog(null); }}>
        {dialog && (
          <DialogContent data-dialog={dialog.id}>
            <DialogHeader>
              <DialogTitle>{suppress ? "Never recommend again" : `Dismiss for ${dialog.days} days`}</DialogTitle>
              <DialogDescription>
                {suppress ? (
                  <>
                    <span className="font-medium text-foreground">{topic}</span> will not be recommended again, whatever
                    later analyses find, until someone reopens it from the Dismissed group.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">{topic}</span> leaves the work queue until{" "}
                    <span className="font-medium text-foreground" data-until={until}>{formatDay(until)}</span>. After that
                    date it returns if the analysis still reports it.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Reason (required)</span>
              <Textarea
                value={reason}
                maxLength={REASON_MAX}
                onChange={(e) => setReason(e.target.value)}
                placeholder={suppress ? "Why this should never be recommended" : "Why this can wait"}
                data-reason-input
              />
            </label>
            {suppress && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={permanentOk} onChange={(e) => setPermanentOk(e.target.checked)} data-permanent />
                <span>I understand this is permanent until someone reopens it.</span>
              </label>
            )}
            {message && !message.ok && <p className="text-xs text-red-800" role="alert">{message.text}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                type="button"
                variant={suppress ? "destructive" : "default"}
                loading={pending}
                disabled={!canConfirm}
                data-confirm
                onClick={() => run(dialog, reason)}
              >
                {suppress ? "Never recommend again" : `Dismiss until ${formatDay(until)}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
