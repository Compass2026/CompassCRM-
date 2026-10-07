"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { requestDraftAction, restartDraftAction, type DraftAnswer } from "@/app/authority-draft-actions";
import type { Card } from "@/lib/authority-view";
import { cn } from "@/lib/utils";

// Draft with AI on a Ready Business Profile post (0053). The request is the
// worker's work item; the post it produces is what moves the opportunity
// (in review → in progress, approved → completed). Nothing is published.
export function OpportunityDraft({ clientId, card }: { clientId: string; card: Card }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<DraftAnswer | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const d = card.draft;
  const w = card.workflow;
  if (!d || !w) return null;

  const run = (fn: () => Promise<DraftAnswer>) => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      const r = await fn();
      busy.current = false;
      setMessage(r);
      setOpen(false);
      router.refresh();
    });
  };
  const request = () => (d.state === "available" || d.state === "blocked")
    && run(() => requestDraftAction(clientId, w.opportunityId, { status: w.status, suppressed: w.suppressed, dismissed_until: w.dismissed_until, runId: d.runId }));

  return (
    <div className="mt-2 space-y-1.5" data-draft={d.state}>
      {(d.state === "available" || d.state === "blocked") && (
        <div className="space-y-1">
          {d.state === "blocked" && <p className="text-xs text-amber-900" data-draft-blocked>{d.label}: {d.detail}</p>}
          <Button type="button" size="xs" onClick={() => { setMessage(null); setOpen(true); }} data-open-draft>
            {d.state === "blocked" ? "Draft with AI again" : "Draft with AI"}
          </Button>
        </div>
      )}
      {d.state === "requested" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-navy-800" data-draft-status>{d.label}</span>
          <Button loading={pending} type="button" size="xs" variant="outline" disabled={pending} data-restart-draft
            onClick={() => run(() => restartDraftAction(clientId, d.taskId))}>
            {pending ? "Restarting…" : "Restart"}
          </Button>
          <p className="basis-full text-[11px] text-muted-foreground">{d.detail}</p>
        </div>
      )}
      {(d.state === "in_review" || d.state === "completed") && (
        <p className="text-xs" data-draft-status>
          <span className={cn("font-medium", d.state === "completed" ? "text-green-800" : "text-navy-800")}>{d.label}</span>{" · "}
          <Link className="underline underline-offset-2" href={`/clients/${clientId}/social/${d.postId}`} data-draft-post>Open the post</Link>
        </p>
      )}
      {d.state === "waiting" && <p className="text-xs text-muted-foreground" data-draft-status>{d.label}: {d.detail}</p>}
      {message && (
        <p role="status" data-draft-message={message.ok ? "ok" : "refused"} className={cn("break-words text-xs", message.ok ? "text-green-800" : "text-amber-900")}>
          {message.text}
        </p>
      )}
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o && !pending) setOpen(false); }}>
          <DialogContent data-draft-dialog className="w-[calc(100vw-2rem)] max-w-lg">
            <DialogHeader>
              <DialogTitle>Draft with AI</DialogTitle>
              <DialogDescription className="break-words">
                {card.topic} · {card.intent} Business Profile post{card.keyword ? ` for “${card.keyword}”` : ""}
              </DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>The worker drafts it through the AI Drafter, which rebuilds its own brief from Client Intelligence and checks it against this recommendation.</li>
              <li>The draft stops in review for a person. Nothing is approved, scheduled or published.</li>
              <li>If this recommendation changes before the draft is written, the Drafter refuses and the request says why.</li>
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
              <Button loading={pending} type="button" disabled={pending} onClick={request} data-confirm-draft>{pending ? "Requesting…" : "Request the draft"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
