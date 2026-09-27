"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyReconcileAction, previewReconcileAction, type ReconcilePreview } from "@/app/authority-decision-actions";
import {
  ACTION_LABEL,
  MAX_SELECTED,
  buildApply,
  mapChanges,
  type Change,
  type ReconcileAction,
  type ReconcileRow,
  type RowLink,
} from "@/lib/authority-reconcile";
import type { Workflow } from "@/lib/authority-lifecycle";
import type { Card } from "@/lib/authority-view";
import { cn } from "@/lib/utils";
import { useAuthorityRun } from "./authority-run-context";

type Ok = Extract<ReconcilePreview, { ok: true }>;
const snapshot = (w: Workflow) => ({ status: w.status, suppressed: w.suppressed, dismissed_until: w.dismissed_until });

function Changes({ changes }: { changes: Change[] }) {
  if (!changes.length) return null;
  return (
    <ul className="mt-1 space-y-1" data-changes>
      {changes.map((c, i) => (
        <li key={i} className="min-w-0 rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-snug" data-change={`${c.record}.${c.field}`}>
          <span className="block break-words font-mono text-navy-800">{c.record} · {c.field}</span>
          <span className="block break-all" data-before>{c.before}</span>
          <span className="block break-all font-medium" data-after>→ {c.after}</span>
        </li>
      ))}
    </ul>
  );
}

// Takes the teammate to the decision that unblocks a row (it is on this page).
function Links({ links, onGo }: { links: RowLink[]; onGo: (key: string) => void }) {
  if (!links.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1.5">
      {links.map((l) => (
        <button key={l.key} type="button" className="text-[11px] font-medium text-navy-700 underline underline-offset-2" onClick={() => onGo(l.key)} data-link={l.key}>
          Go to {l.label}
        </button>
      ))}
    </span>
  );
}

function ReconcileDialog({ clientId, card, action, onClose, onDone }: {
  clientId: string; card: Card; action: ReconcileAction; onClose: () => void;
  onDone: (m: { tone: "success" | "partial" | "info" | "warning"; text: string }) => void;
}) {
  const router = useRouter();
  const run = useAuthorityRun();
  const [preview, setPreview] = useState<ReconcilePreview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ text: string; changed: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);

  async function fetchPreview() {
    const p = await previewReconcileAction(clientId, card.workflow!.opportunityId, action, snapshot(card.workflow!));
    setPreview(p);
    setTicked(new Set());
    setChoice({});
    if (!p.ok && p.changed) router.refresh();
  }
  const fetched = useRef(false);
  useEffect(() => {
    if (fetched.current) return; // once per opening (StrictMode mounts effects twice in development)
    fetched.current = true;
    startTransition(fetchPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, []);
  function reviewAgain() { setError(null); setPreview(null); startTransition(fetchPreview); }

  const ok = preview?.ok ? (preview as Ok) : null;
  const rows = ok?.rows ?? [];
  const selection = [...ticked].map((id) => ({ id, service_id: choice[id] }));
  const built = ok ? buildApply(action, ok.base, rows, selection) : null;
  const canApply = !!built && !("error" in built) && !pending;
  const count = ok?.selects ? ticked.size : 1;

  function toggle(r: ReconcileRow, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on && next.size < MAX_SELECTED) next.add(r.id); else next.delete(r.id);
      return next;
    });
  }
  function go(key: string) {
    onClose();
    const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el) { const d = el.closest("details"); if (d) d.open = true; }
  }

  function confirm() {
    if (!ok || !built || "error" in built || busy.current) return;
    busy.current = true;
    setError(null);
    const service = card.topic;
    startTransition(async () => {
      const r = await applyReconcileAction(clientId, card.workflow!.opportunityId, action, built.payload, built.expected, { service });
      busy.current = false;
      if (!r.ok) {
        setError({ text: r.text, changed: r.changed });
        if (r.changed) router.refresh();
        return;
      }
      const text = r.refresh ? `${r.outcome.text} ${r.refresh.text}` : r.outcome.text;
      onDone({ tone: r.outcome.tone, text });
      if (r.refresh?.runId) run.watch(r.refresh.runId, { tone: "info", text });
      else if (r.refresh) run.setMessage({ tone: "warning", text });
      onClose();
      router.refresh();
    });
  }

  const enabledCount = rows.filter((r) => r.enabled).length;
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <DialogContent data-reconcile-dialog={action} className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ok?.title ?? "Preparing the preview…"}</DialogTitle>
          <DialogDescription className="break-words">{card.topic}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1">
          {preview && !preview.ok && <p role="alert" className="text-sm text-red-800" data-preview-error>{preview.text}</p>}
          {ok && (
            <div className="space-y-2">
              {ok.note && <p className="text-xs text-muted-foreground" data-note>{ok.note}</p>}
              {ok.selects && (
                <p className="text-xs font-medium text-navy-800" data-selected-count={ticked.size}>
                  {ticked.size} of {MAX_SELECTED} selected · {enabledCount} available of {rows.length}
                </p>
              )}
              <ul className="space-y-1.5" data-rows>
                {rows.map((r) => {
                  const on = ticked.has(r.id);
                  const opt = r.options?.find((o) => o.service_id === choice[r.id]);
                  const changes = r.options ? mapChanges(r, opt) : r.changes;
                  return (
                    <li key={r.id} data-row={r.id} data-enabled={r.enabled ? "1" : "0"}
                      className={cn("min-w-0 rounded-lg px-2.5 py-2 ring-1", r.enabled ? "ring-border" : "bg-muted/40 ring-border/60")}>
                      <div className="flex min-w-0 items-start gap-2">
                        {ok.selects && (
                          <input type="checkbox" className="mt-0.5 size-4 shrink-0" aria-label={`Select ${r.label}`} data-tick={r.id}
                            checked={on} disabled={!r.enabled || (!on && ticked.size >= MAX_SELECTED) || pending}
                            onChange={(e) => toggle(r, e.target.checked)} />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium">{r.label}</p>
                          {r.reason && <p className={cn("text-xs", r.enabled ? "text-muted-foreground" : "text-amber-900")} data-row-reason>{r.reason}</p>}
                          <Links links={r.links} onGo={go} />
                          {r.options && r.enabled && (
                            <label className="mt-1 grid gap-1 text-xs">
                              <span className="font-medium">Service</span>
                              <select className="h-8 w-full min-w-0 rounded-md border bg-card px-2 text-xs" value={choice[r.id] ?? ""} data-choose={r.id}
                                disabled={pending} onChange={(e) => setChoice({ ...choice, [r.id]: e.target.value })}>
                                <option value="">Choose a service…</option>
                                {r.options.map((o) => (
                                  <option key={o.service_id} value={o.service_id} disabled={!o.enabled}>
                                    {o.enabled ? o.name : `${o.name} (${o.reason})`}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <Changes changes={changes} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-sm text-red-800" data-apply-error={error.changed ? "stale" : "refused"}>{error.text}</p>}
          {ok && built && "error" in built && ok.selects && ticked.size > 0 && (
            <p className="mt-2 text-xs text-amber-900" data-apply-blocked>{built.error}</p>
          )}
        </div>
        <DialogFooter className="border-t pt-3">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          {error?.changed || (preview && !preview.ok && preview.changed)
            ? <Button type="button" disabled={pending} onClick={reviewAgain} data-review-again>Preview again</Button>
            : <Button type="button" disabled={!canApply} onClick={confirm} data-confirm-reconcile>
                {pending && ok ? "Saving…" : `Apply ${count} change${count === 1 ? "" : "s"}`}
              </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The Reconcile control on a data-fix card. It stays while the latest analysis
// reports the opportunity (a partly recorded page list included) and it is not dismissed.
export function OpportunityReconcile({ clientId, card }: { clientId: string; card: Card }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: string; text: string } | null>(null);
  const w = card.workflow;
  if (!card.reconcile || !w || w.status === "dismissed") return null;
  return (
    <div className="mt-2 space-y-1.5" data-reconcile={card.reconcile}>
      <Button type="button" size="xs" onClick={() => { setMessage(null); setOpen(true); }} data-open-reconcile={card.reconcile}>
        {ACTION_LABEL[card.reconcile]}
      </Button>
      {message && (
        <p role="status" data-reconcile-message={message.tone}
          className={cn("break-words text-xs", message.tone === "partial" || message.tone === "warning" ? "text-amber-900" : message.tone === "info" ? "text-navy-800" : "text-green-800")}>
          {message.text}
        </p>
      )}
      {open && <ReconcileDialog clientId={clientId} card={card} action={card.reconcile} onClose={() => setOpen(false)} onDone={setMessage} />}
    </div>
  );
}
