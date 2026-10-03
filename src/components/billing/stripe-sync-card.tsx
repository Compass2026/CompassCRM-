import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { changesText, resultText, runStatusLabels, runStatusStyles, warningText, webhookText } from "@/lib/billing-reconcile";
import { attentionLabel } from "@/lib/billing";
import { modeLabel } from "@/lib/billing-ops";

export type SyncHealth = {
  failed_events: number | null;
  stuck_events: number | null;
  last_event_at: string | null;
  last_run_status: string | null;
  last_run_started_at: string | null;
  last_run_completed_at: string | null;
  last_run_records_changed: number | null;
} | null;

export type ClientReconciliation = {
  status: string | null;
  records_changed: number | null;
  changes: unknown;
  attention_reasons: string[] | null;
  warnings: string[] | null;
  error: string | null;
  checked_at: string | null;
} | null;

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// "Stripe sync": the webhook ledger's state and the last reconciliation —
// for one client (result) or the agency (the last agency-wide run). Webhooks
// are the real-time path; reconciliation is the daily safety net.
export function StripeSyncCard({ health, result, livemode, scope, action, actionLabel }: {
  health: SyncHealth;
  result?: ClientReconciliation;
  livemode: boolean;
  scope: "client" | "agency";
  action?: () => Promise<void>;
  actionLabel?: string;
}) {
  const webhook = webhookText(health);
  const reasons = [...(result?.attention_reasons ?? []).map(attentionLabel), ...(result?.warnings ?? []).map(warningText)];
  const changed = changesText(result?.changes as Record<string, number> | null);
  return (
    <Card data-card="stripe-sync">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Stripe sync</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <dt className="text-muted-foreground">Webhook</dt>
          <dd className={webhook.ok ? "" : "text-red-800"}>{webhook.text}</dd>
          <dt className="text-muted-foreground">Mode</dt>
          <dd>{modeLabel(livemode)}</dd>
          <dt className="text-muted-foreground">Last reconciled</dt>
          <dd data-last-reconciled>
            {scope === "client" ? fmt(result?.checked_at) : fmt(health?.last_run_completed_at ?? health?.last_run_started_at)}
          </dd>
          <dt className="text-muted-foreground">Result</dt>
          <dd data-reconcile-result>
            {scope === "client" ? (
              resultText(result?.status ? { status: result.status, records_changed: result.records_changed, error: result.error } : null)
            ) : health?.last_run_status ? (
              <>
                <Badge variant="outline" className={runStatusStyles[health.last_run_status]}>{runStatusLabels[health.last_run_status] ?? health.last_run_status}</Badge>{" "}
                {(health.last_run_records_changed ?? 0) > 0 ? `repaired ${health.last_run_records_changed} records` : "no differences"}
              </>
            ) : (
              "Not reconciled yet"
            )}
          </dd>
        </dl>
        {scope === "client" && changed && <p className="text-xs text-muted-foreground">Repaired: {changed}.</p>}
        {reasons.length > 0 && (
          <ul className="list-disc pl-5 text-red-800" data-reconcile-attention>
            {reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
        {action && (
          <form action={action}>
            <Button type="submit" size="sm" variant="outline">{actionLabel}</Button>
          </form>
        )}
        <p className="text-xs text-muted-foreground">
          Stripe&apos;s webhooks keep this current as things happen; reconciliation re-reads Stripe daily and repairs
          anything missed. Stripe always wins; nothing is changed in Stripe.
        </p>
      </CardContent>
    </Card>
  );
}
