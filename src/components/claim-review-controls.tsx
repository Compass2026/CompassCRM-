"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  classifyClaimAction,
  revokeClaimAction,
  verifyClaimAction,
  type ActionResult,
} from "@/app/claim-verification-actions";
import {
  EXCERPT_PLACEHOLDER,
  METHOD_EVIDENCE,
  METHOD_LABEL,
  evidenceChoices,
  excerptProblem,
  formatBytes,
  formatDay,
  keptDraftState,
  reviewOptions,
  type ClaimRegistry,
  type KeptDraft,
  type RegistryClaim,
} from "@/lib/claim-registry";

type Panel = null | "classify" | "verify" | "revoke";

/** The verify form's values. Kept in this tab until recorded (PR2a.1, H3). */
type Draft = {
  method: string;
  evidence: string;
  excerpt: string;
  observed_on: string;
  expires_on: string;
  contact: string;
  note: string;
};

// Session storage: the draft lives only in this browser tab (a reload keeps
// it, closing the tab drops it). It carries the claim's fingerprint and review
// id, so a draft written before the claim changed is never reused silently.
const draftKey = (claimId: string) => `compass:claim-verify:${claimId}`;

function loadDraft(key: string): KeptDraft<Partial<Draft>> | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as KeptDraft<Partial<Draft>>) : null;
  } catch {
    return null;
  }
}
function saveDraft(key: string, kept: KeptDraft<Draft>) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(kept));
  } catch {
    /* storage unavailable: the form still works, it just isn't kept */
  }
}
function dropDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* nothing to drop */
  }
}

// Classify / Verify / Re-review / Revoke on one registry row (20261104200000).
// Shown only to the verification owner; the database's writers decide again
// and their refusal is shown here, in place. None of these changes a claim's
// status, so nothing a post or draft may cite moves.
export function ClaimReviewControls({
  clientId,
  claim,
  registry,
}: {
  clientId: string;
  claim: RegistryClaim;
  registry: Pick<ClaimRegistry, "intervals" | "evidence" | "locations" | "today">;
}) {
  const opts = reviewOptions(registry, claim);
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stale = { fingerprint: claim.fingerprint, reviewId: claim.review_id };
  const key = draftKey(claim.id);
  const blank = (): Draft => ({
    method: opts.methods[0] ?? "",
    evidence: "",
    excerpt: "",
    observed_on: registry.today,
    expires_on: "",
    contact: "",
    note: "",
  });
  const [draft, setDraft] = useState<Draft>(blank);
  const [readBack, setReadBack] = useState(false);
  // A draft written before the claim changed, held back until the owner chooses.
  const [held, setHeld] = useState<Partial<Draft> | null>(null);
  const method = draft.method;
  const choices = method ? evidenceChoices(registry, claim, method) : [];
  // Never a default: the owner picks the evidence, and a pick that is no
  // longer offered (changed, removed, another method) is not replaced.
  const evidenceId = choices.some((c) => c.id === draft.evidence) ? draft.evidence : "";
  const evidenceGone = draft.evidence !== "" && evidenceId === "";
  const needs = METHOD_EVIDENCE[method]?.needs;
  const chosenFile = needs !== "location" ? registry.evidence.find((e) => e.id === evidenceId) : undefined;
  const chosenLocation = needs === "location" ? registry.locations.find((l) => l.id === evidenceId) : undefined;

  // Unsent values survive a reload (A7 lost a prefilled form), stamped with
  // the claim as it is now. Not while an older draft is waiting for a choice.
  useEffect(() => {
    if (panel === "verify" && !held)
      saveDraft(key, { at: Date.now(), fingerprint: claim.fingerprint, reviewId: claim.review_id, draft });
  }, [panel, held, key, draft, claim.fingerprint, claim.review_id]);

  const set = (patch: Partial<Draft>) => {
    setReadBack(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const toggle = (p: Panel) => {
    setError(null);
    setReadBack(false);
    setPanel((cur) => (cur === p ? null : p));
    if (p === "verify") {
      const kept = loadDraft(key);
      const state = keptDraftState(kept, stale, Date.now());
      setHeld(state === "changed" ? (kept?.draft ?? null) : null);
      if (state === "expired") dropDraft(key);
      fill(state === "matches" ? (kept?.draft ?? null) : null);
    }
  };
  function fill(values: Partial<Draft> | null) {
    const next = { ...blank(), ...(values ?? {}) };
    if (!opts.methods.includes(next.method)) next.method = opts.methods[0] ?? "";
    setDraft(next);
  }
  // The owner chose to look at the older values: they fill the form, and the
  // read-back still has to be confirmed before anything is recorded.
  function restoreHeld() {
    fill(held);
    setHeld(null);
  }
  function discardHeld() {
    dropDraft(key);
    setHeld(null);
    fill(null);
  }
  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        setReadBack(false);
        setError(r.error);
      } else {
        after?.();
        setPanel(null);
        setReadBack(false);
        router.refresh();
      }
    });
  const text = (f: FormData, k: string) => String(f.get(k) ?? "");

  function classify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(() => classifyClaimAction(clientId, { claimId: claim.id, kind: text(f, "kind"), note: text(f, "note"), ...stale }));
  }
  // Step one: check the quote and show what will be recorded (H1, H2).
  function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (held) return setError("Use or discard the values kept from before this claim changed first.");
    if (!evidenceId) return setError(evidenceGone ? "The evidence chosen earlier is no longer offered; choose it again." : "Choose the evidence this decision rests on.");
    const problem = excerptProblem(draft.excerpt, draft.note);
    if (problem) return setError(problem);
    setError(null);
    setReadBack(true);
  }
  // Step two: record exactly what the read-back showed.
  function record() {
    if (!evidenceId || held) return setReadBack(false);
    run(
      () =>
        verifyClaimAction(clientId, {
          claimId: claim.id,
          action: opts.canReview ? "review" : "verify",
          method,
          evidenceId: needs === "location" ? null : evidenceId,
          locationId: needs === "location" ? evidenceId : null,
          excerpt: draft.excerpt,
          observedOn: draft.observed_on,
          expiresOn: draft.expires_on,
          confirmedByContact: method === "client_confirmation" ? draft.contact : null,
          note: draft.note,
          ...stale,
        }),
      () => dropDraft(key),
    );
  }
  function revoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(() => revokeClaimAction(clientId, { claimId: claim.id, reason: text(f, "reason"), ...stale }));
  }

  const kinds = registry.intervals.filter((i) => i.kind !== "unclassified" && i.kind !== claim.kind);
  const formClass = "space-y-2 rounded-lg bg-muted/40 p-3 ring-1 ring-border";

  return (
    <div className="space-y-2" data-review-controls>
      <div className="flex flex-wrap items-center gap-1.5">
        {opts.canClassify && (
          <Button type="button" size="xs" variant="outline" onClick={() => toggle("classify")} data-action="classify">
            {claim.kind ? "Re-classify" : "Classify"}
          </Button>
        )}
        {(opts.canVerify || opts.canReview) && (
          <Button type="button" size="xs" variant="outline" onClick={() => toggle("verify")} data-action="verify">
            {opts.canReview ? "Re-review" : "Verify"}
          </Button>
        )}
        {opts.canRevoke && (
          <Button type="button" size="xs" variant="ghost" onClick={() => toggle("revoke")} data-action="revoke">
            Revoke
          </Button>
        )}
        {!opts.canVerify && !opts.canReview && opts.verifyBlocked && (
          <span className="text-xs text-muted-foreground" data-verify-blocked>
            {opts.verifyBlocked}
          </span>
        )}
      </div>

      {panel === "classify" && (
        <form onSubmit={classify} className={formClass} data-form="classify">
          <Label htmlFor={`kind-${claim.id}`}>Kind of fact</Label>
          <select id={`kind-${claim.id}`} name="kind" className="field w-full" required defaultValue="">
            <option value="" disabled>
              Choose a kind
            </option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label} · review every {k.review_days} days
              </option>
            ))}
          </select>
          {claim.verification.record && (
            <p className="text-xs text-amber-900">Re-classifying clears the verification in force; verify it again afterwards.</p>
          )}
          <Input name="note" placeholder="Note (optional)" maxLength={1000} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save classification"}
          </Button>
        </form>
      )}

      {panel === "verify" && (
        <form onSubmit={verify} className={formClass} data-form="verify">
          <p className="text-xs text-muted-foreground">
            Records your decision and pins the evidence. It does not change what posts and drafts may cite.
          </p>
          {held && (
            <div className="space-y-1.5 rounded-md bg-amber-50 p-2.5 text-xs text-amber-900 ring-1 ring-amber-200" data-held-draft role="status">
              <p>
                Values you typed earlier were kept, but this claim has changed since (its text, source, kind or last
                decision). They were not filled in. Look at them again before using them.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="xs" variant="outline" onClick={restoreHeld} data-action="restore-draft">
                  Show the earlier values
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={discardHeld} data-action="discard-draft">
                  Discard them
                </Button>
              </div>
            </div>
          )}
          <Label htmlFor={`method-${claim.id}`}>Method</Label>
          <select
            id={`method-${claim.id}`}
            name="method"
            className="field w-full"
            value={method}
            onChange={(e) => set({ method: e.target.value, evidence: "" })}
          >
            {opts.methods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m] ?? m}
              </option>
            ))}
          </select>
          {method && <p className="text-xs text-muted-foreground">{METHOD_EVIDENCE[method]?.help}</p>}
          <Label htmlFor={`evidence-${claim.id}`}>Evidence</Label>
          {choices.length === 0 ? (
            <p className="text-xs text-amber-900" data-no-evidence>
              {METHOD_EVIDENCE[method]?.needs === "location"
                ? "No approved location on this claim's site."
                : "No intact file of that kind yet: upload one under Claim evidence files."}
            </p>
          ) : (
            <select
              id={`evidence-${claim.id}`}
              name="evidence"
              className="field w-full"
              aria-required="true"
              value={evidenceId}
              onChange={(e) => set({ evidence: e.target.value })}
            >
              <option value="" disabled>
                Choose the evidence
              </option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {evidenceGone && (
            <p className="text-xs text-amber-900" data-evidence-gone>
              The evidence chosen earlier is no longer offered (changed, removed, or not valid for this method). Choose it
              again.
            </p>
          )}
          <Label htmlFor={`excerpt-${claim.id}`}>What the evidence says</Label>
          <p className="text-xs text-muted-foreground">The evidence&apos;s own words, quoted. Your comments go in the note below.</p>
          <Textarea
            id={`excerpt-${claim.id}`}
            name="excerpt"
            required
            maxLength={2000}
            placeholder={EXCERPT_PLACEHOLDER}
            value={draft.excerpt}
            onChange={(e) => set({ excerpt: e.target.value })}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`observed-${claim.id}`}>Examined on</Label>
              <Input
                id={`observed-${claim.id}`}
                name="observed_on"
                type="date"
                required
                max={registry.today}
                value={draft.observed_on}
                onChange={(e) => set({ observed_on: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`expires-${claim.id}`}>Evidence expires (optional)</Label>
              <Input
                id={`expires-${claim.id}`}
                name="expires_on"
                type="date"
                value={draft.expires_on}
                onChange={(e) => set({ expires_on: e.target.value })}
              />
            </div>
          </div>
          {method === "client_confirmation" && (
            <Input
              name="contact"
              required
              placeholder="Client contact who confirmed it"
              maxLength={200}
              value={draft.contact}
              onChange={(e) => set({ contact: e.target.value })}
            />
          )}
          <Label htmlFor={`note-${claim.id}`}>Note (optional)</Label>
          <Input
            id={`note-${claim.id}`}
            name="note"
            placeholder="Your comment: limits, why this evidence, what it does not cover"
            maxLength={1000}
            value={draft.note}
            onChange={(e) => set({ note: e.target.value })}
          />
          {!readBack && (
            <Button type="submit" size="sm" disabled={pending || choices.length === 0}>
              Review before recording
            </Button>
          )}
          {readBack && (
            <div className="space-y-1.5 rounded-md bg-background p-3 text-xs ring-1 ring-border" data-readback role="region" aria-label="What will be recorded">
              <p className="font-medium text-navy-900">You are recording {opts.canReview ? "a re-review" : "a verification"} of “{claim.claim}”:</p>
              <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[8rem_1fr]">
                <dt className="text-muted-foreground">Method</dt>
                <dd data-readback-method>{METHOD_LABEL[method] ?? method}</dd>
                <dt className="text-muted-foreground">Evidence</dt>
                <dd className="break-all" data-readback-evidence={evidenceId}>
                  {chosenFile && (
                    <>
                      {chosenFile.label}
                      {chosenFile.original_name ? ` (${chosenFile.original_name})` : ""} · {chosenFile.mime_type} ·{" "}
                      {formatBytes(chosenFile.size_bytes)} · uploaded {formatDay(chosenFile.created_at)}
                      <br />
                      SHA-256 <span data-readback-sha256>{chosenFile.sha256}</span>
                    </>
                  )}
                  {chosenLocation && <>{choices.find((c) => c.id === evidenceId)?.label}</>}
                </dd>
                <dt className="text-muted-foreground">Quote</dt>
                <dd className="whitespace-pre-wrap" data-readback-excerpt>“{draft.excerpt.trim()}”</dd>
                <dt className="text-muted-foreground">Note</dt>
                <dd className="whitespace-pre-wrap" data-readback-note>{draft.note.trim() || "—"}</dd>
                <dt className="text-muted-foreground">Examined on</dt>
                <dd>{formatDay(draft.observed_on)}</dd>
                {draft.expires_on && (
                  <>
                    <dt className="text-muted-foreground">Evidence expires</dt>
                    <dd>{formatDay(draft.expires_on)}</dd>
                  </>
                )}
                {method === "client_confirmation" && (
                  <>
                    <dt className="text-muted-foreground">Confirmed by</dt>
                    <dd>{draft.contact}</dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" onClick={record} disabled={pending} data-action="record">
                  {pending ? "Saving…" : opts.canReview ? "Record re-review" : "Record verification"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setReadBack(false)} disabled={pending} data-action="edit">
                  Edit
                </Button>
              </div>
            </div>
          )}
        </form>
      )}

      {panel === "revoke" && (
        <form onSubmit={revoke} className={formClass} data-form="revoke">
          <Label htmlFor={`reason-${claim.id}`}>Why is the verification revoked?</Label>
          <Textarea id={`reason-${claim.id}`} name="reason" required minLength={3} maxLength={500} />
          <Button type="submit" size="sm" variant="destructive" disabled={pending}>
            {pending ? "Saving…" : "Revoke verification"}
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-xs font-medium text-red-800" data-review-error>
          {error}
        </p>
      )}
    </div>
  );
}
