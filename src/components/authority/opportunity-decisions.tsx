"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  applyAuthorityDecisionAction,
  applyMarketsAction,
  previewAuthorityDecisionAction,
  type ApplyResult,
  type DecisionPreview,
} from "@/app/authority-decision-actions";
import { decideAuthorityAction } from "@/app/authority-actions";
import { decisionKind, intentRecommendation, MAX_SELECTED, type DecisionAction } from "@/lib/authority-decisions";
import { dismissUntil, formatDay, DISMISS_DAYS, type DismissDays, type Workflow } from "@/lib/authority-lifecycle";
import type { Card } from "@/lib/authority-view";
import { cn } from "@/lib/utils";
import { useAuthorityRun } from "./authority-run-context";

type Ok = Extract<DecisionPreview, { ok: true }>;
const snapshot = (w: Workflow) => ({ status: w.status, suppressed: w.suppressed, dismissed_until: w.dismissed_until });
const decidable = (w: Workflow | null): w is Workflow => !!w && (w.effective === "open" || w.effective === "accepted") && w.status !== "dismissed";

// ── Market selection (explicit rows only, at most 25) ───────────────────────
type Selected = { id: string; place: string; workflow: Workflow };
const SelectionContext = createContext<{ selected: Map<string, Selected>; toggle: (s: Selected, on: boolean) => void; clear: () => void } | null>(null);

export function DecisionSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const value = useMemo(() => ({
    selected,
    toggle: (s: Selected, on: boolean) => setSelected((prev) => {
      const next = new Map(prev);
      if (on && next.size < MAX_SELECTED) next.set(s.id, s); else next.delete(s.id);
      return next;
    }),
    clear: () => setSelected(new Map()),
  }), [selected]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
const useSelection = () => useContext(SelectionContext);

// ── The dialog: preview, then apply exactly what was previewed ──────────────
function DecisionDialog({
  open, onClose, clientId, card, action, intent, onDone,
}: {
  open: boolean; onClose: () => void; clientId: string; card: Card; action: DecisionAction; intent?: string;
  onDone: (r: Extract<ApplyResult, { ok: true }>) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<DecisionPreview | null>(null);
  const [error, setError] = useState<{ text: string; changed: boolean } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);

  // Mounted only while open: the preview is read once, and again on "Review again".
  async function fetchPreview() {
    const p = await previewAuthorityDecisionAction(clientId, card.workflow!.opportunityId, action, snapshot(card.workflow!), { intent });
    setPreview(p);
    if (p.ok) setFields({ name: p.fields.name ?? "", segment: p.fields.segment ?? "", title: p.fields.title ?? "", notes: p.fields.notes ?? "", assignee_id: "", reason: "" });
    else if (p.changed) router.refresh();
  }
  const fetched = useRef(false);
  useEffect(() => {
    if (fetched.current) return; // once per opening (StrictMode mounts effects twice in development)
    fetched.current = true;
    startTransition(fetchPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, []);
  function load() {
    setError(null);
    setPreview(null);
    startTransition(fetchPreview);
  }

  const ok = preview?.ok ? (preview as Ok) : null;
  const needsReason = !!ok?.fields.reason?.required;
  const valid = !!ok && (!needsReason || fields.reason.trim().length > 0)
    && (ok.fields.name === undefined || fields.name.trim().length > 0)
    && (ok.fields.title === undefined || fields.title.trim().length > 0);

  function confirm() {
    if (!ok || busy.current) return;
    busy.current = true;
    setError(null);
    const payload: Record<string, unknown> = { ...ok.payload };
    if (needsReason) payload.reason = fields.reason.trim();
    if (ok.fields.name !== undefined) { payload.name = fields.name.trim(); payload.segment = fields.segment || null; }
    if (ok.fields.title !== undefined) { payload.title = fields.title.trim(); payload.notes = fields.notes.trim(); payload.assignee_id = fields.assignee_id || null; }
    startTransition(async () => {
      const r = await applyAuthorityDecisionAction(clientId, card.workflow!.opportunityId, action, payload, ok.expected);
      busy.current = false;
      if (r.ok) { onDone(r); onClose(); router.refresh(); return; }
      setError({ text: r.text, changed: r.changed });
      if (r.changed) router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      {open && (
        <DialogContent data-decision-dialog={action} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ok?.title ?? "Preparing the preview…"}</DialogTitle>
            <DialogDescription>{card.topic}</DialogDescription>
          </DialogHeader>
          {preview && !preview.ok && <p role="alert" className="text-sm text-red-800" data-preview-error>{preview.text}</p>}
          {ok && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-preview>
                  <thead><tr className="text-muted-foreground"><th className="py-1 pr-2 font-medium">Record</th><th className="py-1 pr-2 font-medium">Before</th><th className="py-1 font-medium">After</th></tr></thead>
                  <tbody>
                    {ok.rows.map((r) => (
                      <tr key={r.label} className="border-t align-top">
                        <td className="py-1.5 pr-2 font-mono">{r.label}</td>
                        <td className="py-1.5 pr-2" data-before>{r.before}</td>
                        <td className="py-1.5 font-medium" data-after>{r.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ok.note && <p className="text-xs text-muted-foreground" data-note>{ok.note}</p>}
              {ok.fields.name !== undefined && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm"><span className="font-medium">Service name</span>
                    <Input value={fields.name} maxLength={120} onChange={(e) => setFields({ ...fields, name: e.target.value })} data-field="name" /></label>
                  <label className="grid gap-1 text-sm"><span className="font-medium">Segment</span>
                    <select className="h-9 rounded-lg border bg-card px-2 text-sm" value={fields.segment} onChange={(e) => setFields({ ...fields, segment: e.target.value })} data-field="segment">
                      <option value="">None</option>
                      {(ok.fields.segments ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select></label>
                </div>
              )}
              {ok.fields.title !== undefined && (
                <div className="grid gap-2">
                  <label className="grid gap-1 text-sm"><span className="font-medium">Task</span>
                    <Input value={fields.title} maxLength={200} onChange={(e) => setFields({ ...fields, title: e.target.value })} data-field="title" /></label>
                  <label className="grid gap-1 text-sm"><span className="font-medium">Assignee</span>
                    <select className="h-9 rounded-lg border bg-card px-2 text-sm" value={fields.assignee_id} onChange={(e) => setFields({ ...fields, assignee_id: e.target.value })} data-field="assignee">
                      <option value="">Unassigned</option>
                      {(ok.fields.assignees ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select></label>
                  <label className="grid gap-1 text-sm"><span className="font-medium">Notes</span>
                    <Textarea value={fields.notes} onChange={(e) => setFields({ ...fields, notes: e.target.value })} data-field="notes" /></label>
                </div>
              )}
              {needsReason && (
                <label className="grid gap-1 text-sm"><span className="font-medium">Reason (required)</span>
                  <Textarea value={fields.reason} maxLength={500} placeholder={ok.fields.reason!.placeholder} onChange={(e) => setFields({ ...fields, reason: e.target.value })} data-field="reason" /></label>
              )}
            </>
          )}
          {error && <p role="alert" className="text-sm text-red-800" data-apply-error>{error.text}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            {error?.changed || (preview && !preview.ok && preview.changed)
              ? <Button type="button" disabled={pending} onClick={load} data-review-again>Review again</Button>
              : <Button type="button" disabled={!valid || pending} onClick={confirm} data-confirm-decision>{pending && ok ? "Saving…" : "Confirm"}</Button>}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ── Later (a dated dismissal, from a decision card) ─────────────────────────
function LaterDialog({ open, onClose, clientId, card, onDone }: { open: boolean; onClose: () => void; clientId: string; card: Card; onDone: (t: string) => void }) {
  const router = useRouter();
  const [days, setDays] = useState<DismissDays>(30);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const w = card.workflow!;
  function confirm() {
    startTransition(async () => {
      const r = await decideAuthorityAction(clientId, w.opportunityId, { verb: "dismiss", days, reason, expected: snapshot(w) });
      if (r.ok) { onDone(r.text); onClose(); router.refresh(); } else setError(r.text);
    });
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      {open && (
        <DialogContent data-decision-dialog="later">
          <DialogHeader>
            <DialogTitle>Decide later</DialogTitle>
            <DialogDescription>{card.topic} leaves the queue until {formatDay(dismissUntil(days, new Date()))}, then returns if the analysis still reports it.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            {DISMISS_DAYS.map((d) => (
              <Button key={d} type="button" size="sm" variant={d === days ? "default" : "outline"} onClick={() => setDays(d)} data-days={d}>{d} days</Button>
            ))}
          </div>
          <label className="grid gap-1 text-sm"><span className="font-medium">Reason (required)</span>
            <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-field="reason" /></label>
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={!reason.trim() || pending} onClick={confirm} data-confirm-decision>Later: until {formatDay(dismissUntil(days, new Date()))}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ── The buttons on a card ───────────────────────────────────────────────────
export function OpportunityDecisions({ clientId, card }: { clientId: string; card: Card }) {
  const run = useAuthorityRun();
  const selection = useSelection();
  const [dialog, setDialog] = useState<{ action: DecisionAction; intent?: string } | "later" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const w = card.workflow;
  if (!decidable(w)) return null;
  const kind = decisionKind(card.key);
  const raw = card.details.raw;
  const rec = kind === "intent" ? intentRecommendation(raw) : null;
  const place = kind === "market" ? (raw.target.location ?? card.topic.replace(/^Market: /, "")) : null;

  function done(r: Extract<ApplyResult, { ok: true }>) {
    setMessage(r.text);
    if (r.refresh?.runId) run.watch(r.refresh.runId, { tone: "info", text: `${r.text} ${r.refresh.text}` });
    else if (r.refresh) run.setMessage({ tone: "warning", text: `${r.text} ${r.refresh.text}` });
  }
  const btn = (label: string, onClick: () => void, id: string, variant: "default" | "outline" = "outline") => (
    <Button key={id} type="button" size="xs" variant={variant} onClick={onClick} data-decision={id}>{label}</Button>
  );

  const buttons: ReactNode[] = [];
  if (kind === "intent" && rec) {
    buttons.push(btn(`Keep ${rec.stored ?? "current"}`, () => setDialog({ action: "keep_intent" }), "keep_intent"));
    for (const i of rec.options) buttons.push(btn(`Change to ${i}`, () => setDialog({ action: "set_intent", intent: i }), `set_intent:${i}`));
  } else if (kind === "market") {
    buttons.push(btn("Approve market", () => setDialog({ action: "approve_market" }), "approve_market"),
      btn("Decline", () => setDialog({ action: "decline_market" }), "decline_market"),
      btn("Later", () => setDialog("later"), "later"));
  } else if (kind === "service") {
    buttons.push(btn("Confirm service", () => setDialog({ action: "confirm_service" }), "confirm_service"),
      btn("Not offered", () => setDialog({ action: "not_offered" }), "not_offered"));
  }
  buttons.push(btn("Create task…", () => setDialog({ action: "create_task" }), "create_task"));

  return (
    <div className="mt-2 space-y-1.5" data-decisions={w.opportunityId}>
      <div className="flex flex-wrap items-center gap-2">
        {kind === "market" && selection && place && (
          <label className="flex items-center gap-1.5 text-xs text-navy-800">
            <input type="checkbox" checked={selection.selected.has(w.opportunityId)} data-select-market={w.opportunityId}
              disabled={!selection.selected.has(w.opportunityId) && selection.selected.size >= MAX_SELECTED}
              onChange={(e) => selection.toggle({ id: w.opportunityId, place, workflow: w }, e.target.checked)} />
            Select
          </label>
        )}
        {buttons}
      </div>
      {message && <p role="status" className="text-xs text-green-800" data-decision-message>{message}</p>}
      {dialog && dialog !== "later" && (
        <DecisionDialog open clientId={clientId} card={card} action={dialog.action} intent={dialog.intent} onClose={() => setDialog(null)} onDone={done} />
      )}
      {dialog === "later" && <LaterDialog open clientId={clientId} card={card} onClose={() => setDialog(null)} onDone={setMessage} />}
    </div>
  );
}

// ── The Markets group's toolbar: act on the selected rows ───────────────────
export function MarketBatchBar({ clientId }: { clientId: string }) {
  const router = useRouter();
  const run = useAuthorityRun();
  const selection = useSelection();
  const [mode, setMode] = useState<"approve_market" | "decline_market" | null>(null);
  const [previews, setPreviews] = useState<{ sel: Selected; p: DecisionPreview }[]>([]);
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<{ opportunityId: string; ok: boolean; text: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!selection) return null;
  const sel = [...selection.selected.values()];

  function open(m: "approve_market" | "decline_market") {
    setMode(m); setResults(null); setError(null); setReason(""); setPreviews([]);
    startTransition(async () => {
      const out: { sel: Selected; p: DecisionPreview }[] = [];
      for (const s of sel) out.push({ sel: s, p: await previewAuthorityDecisionAction(clientId, s.id, m, snapshot(s.workflow)) });
      setPreviews(out);
    });
  }
  const ready = previews.filter((x) => x.p.ok) as { sel: Selected; p: Ok }[];
  function confirm() {
    if (!mode) return;
    startTransition(async () => {
      const r = await applyMarketsAction(clientId, mode, ready.map(({ sel: s, p }) => ({
        opportunityId: s.id, payload: mode === "decline_market" ? { reason: reason.trim() } : p.payload, expected: p.expected,
      })));
      if ("error" in r) { setError(r.error); return; }
      setResults(r.results);
      const okCount = r.results.filter((x) => x.ok).length;
      const summary = `${okCount} of ${r.results.length} market${r.results.length === 1 ? "" : "s"} ${mode === "approve_market" ? "approved" : "declined"}.`;
      if (r.refresh?.runId) run.watch(r.refresh.runId, { tone: "info", text: `${summary} ${r.refresh.text}` });
      else if (r.refresh) run.setMessage({ tone: "warning", text: `${summary} ${r.refresh.text}` });
      selection!.clear();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs ring-1 ring-border" data-market-bar>
      <span className="font-medium" data-selected-count>{sel.length} selected</span>
      <span className="text-muted-foreground">(tick the markets to act on; at most {MAX_SELECTED})</span>
      <Button type="button" size="xs" disabled={!sel.length} onClick={() => open("approve_market")} data-batch="approve_market">Approve selected…</Button>
      <Button type="button" size="xs" variant="outline" disabled={!sel.length} onClick={() => open("decline_market")} data-batch="decline_market">Decline selected…</Button>
      {sel.length > 0 && <Button type="button" size="xs" variant="ghost" onClick={selection.clear}>Clear</Button>}
      <Dialog open={!!mode} onOpenChange={(o) => { if (!o && !pending) setMode(null); }}>
        {mode && (
          <DialogContent data-decision-dialog={`batch:${mode}`} className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{mode === "approve_market" ? "Approve markets" : "Decline markets"}</DialogTitle>
              <DialogDescription>
                {mode === "approve_market" ? "Each market is approved in its own transaction, then one refresh checks them all." : "Won't be recommended again until reopened. Authority decision only; no Client Intelligence record created."}
              </DialogDescription>
            </DialogHeader>
            {!previews.length && pending && <p className="text-sm">Preparing the preview…</p>}
            <ul className="max-h-72 space-y-1 overflow-y-auto text-xs" data-batch-preview>
              {previews.map(({ sel: s, p }) => {
                const r = results?.find((x) => x.opportunityId === s.id);
                return (
                  <li key={s.id} className={cn("rounded-md px-2 py-1.5 ring-1", p.ok ? "ring-border" : "bg-red-50 ring-red-200")} data-batch-row={s.id}>
                    <span className="font-medium">{s.place}</span>{" "}
                    {p.ok ? <span className="text-muted-foreground">{p.rows[0]?.before} → {p.rows[0]?.after}</span> : <span className="text-red-800">{p.text}</span>}
                    {r && <span className={cn("ml-1 font-medium", r.ok ? "text-green-800" : "text-red-800")} data-batch-result={r.ok ? "ok" : "error"}> · {r.text}</span>}
                  </li>
                );
              })}
            </ul>
            {mode === "decline_market" && !results && (
              <label className="grid gap-1 text-sm"><span className="font-medium">Reason (required)</span>
                <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-field="reason" /></label>
            )}
            {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setMode(null)}>{results ? "Close" : "Cancel"}</Button>
              {!results && (
                <Button type="button" disabled={pending || !ready.length || (mode === "decline_market" && !reason.trim())} onClick={confirm} data-confirm-decision>
                  {mode === "approve_market" ? `Approve ${ready.length}` : `Decline ${ready.length}`}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
