"use client";

import { useState, useTransition, type FormEvent } from "react";
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
  METHOD_EVIDENCE,
  METHOD_LABEL,
  evidenceChoices,
  reviewOptions,
  type ClaimRegistry,
  type RegistryClaim,
} from "@/lib/claim-registry";

type Panel = null | "classify" | "verify" | "revoke";

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
  const [method, setMethod] = useState<string>(opts.methods[0] ?? "");
  const stale = { fingerprint: claim.fingerprint, reviewId: claim.review_id };

  const toggle = (p: Panel) => {
    setError(null);
    setPanel((cur) => (cur === p ? null : p));
    if (p === "verify") setMethod(opts.methods[0] ?? "");
  };
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        setPanel(null);
        router.refresh();
      }
    });
  const text = (f: FormData, k: string) => String(f.get(k) ?? "");

  function classify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(() => classifyClaimAction(clientId, { claimId: claim.id, kind: text(f, "kind"), note: text(f, "note"), ...stale }));
  }
  function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const needs = METHOD_EVIDENCE[method]?.needs;
    run(() =>
      verifyClaimAction(clientId, {
        claimId: claim.id,
        action: opts.canReview ? "review" : "verify",
        method,
        evidenceId: needs === "location" ? null : text(f, "evidence"),
        locationId: needs === "location" ? text(f, "evidence") : null,
        excerpt: text(f, "excerpt"),
        observedOn: text(f, "observed_on"),
        expiresOn: text(f, "expires_on"),
        confirmedByContact: method === "client_confirmation" ? text(f, "contact") : null,
        note: text(f, "note"),
        ...stale,
      }),
    );
  }
  function revoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(() => revokeClaimAction(clientId, { claimId: claim.id, reason: text(f, "reason"), ...stale }));
  }

  const choices = method ? evidenceChoices(registry, claim, method) : [];
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
          <Label htmlFor={`method-${claim.id}`}>Method</Label>
          <select
            id={`method-${claim.id}`}
            name="method"
            className="field w-full"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
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
            <select id={`evidence-${claim.id}`} name="evidence" className="field w-full" required>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <Label htmlFor={`excerpt-${claim.id}`}>What the evidence says</Label>
          <Textarea
            id={`excerpt-${claim.id}`}
            name="excerpt"
            required
            maxLength={2000}
            placeholder="Quote the words that support the claim"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`observed-${claim.id}`}>Examined on</Label>
              <Input id={`observed-${claim.id}`} name="observed_on" type="date" required defaultValue={registry.today} max={registry.today} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`expires-${claim.id}`}>Evidence expires (optional)</Label>
              <Input id={`expires-${claim.id}`} name="expires_on" type="date" />
            </div>
          </div>
          {method === "client_confirmation" && (
            <Input name="contact" required placeholder="Client contact who confirmed it" maxLength={200} />
          )}
          <Input name="note" placeholder="Note (optional)" maxLength={1000} />
          <Button type="submit" size="sm" disabled={pending || choices.length === 0}>
            {pending ? "Saving…" : opts.canReview ? "Record re-review" : "Record verification"}
          </Button>
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
