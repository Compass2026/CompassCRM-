import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  attentionLabel,
  billingState,
  billingStateLabels,
  billingStateStyles,
  externalMethodLabels,
  formatMoney,
  stripeDashboardUrl,
} from "@/lib/billing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Read-only mirror of Stripe (0057). Stripe is authoritative: nothing on this
// page is computed by Compass except the operational attention flags, which
// are derived from Stripe's own state by client_billing_status.

const methodLabels: Record<string, string> = {
  card: "Card",
  us_bank_account: "ACH debit",
  other: "Other",
  ...externalMethodLabels,
};

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function BillingPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const { data: status } = await supabase
    .from("client_billing_status")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  const livemode = status?.livemode ?? false;
  const [{ data: invoices }, { data: payments }, { data: plan }] = await Promise.all([
    supabase
      .from("invoices")
      .select("stripe_invoice_id, number, status, currency, total_cents, amount_remaining_cents, due_date, period_start, period_end, hosted_invoice_url, invoice_pdf, stripe_subscription_id, stripe_created_at")
      .eq("client_id", clientId)
      .eq("livemode", livemode)
      .neq("status", "draft")
      .order("stripe_created_at", { ascending: false })
      .limit(24),
    supabase
      .from("payments")
      .select("id, source, status, amount_cents, amount_refunded_cents, currency, payment_method_type, external_method, reference, paid_at, stripe_payment_intent_id, stripe_invoice_id, livemode")
      .eq("client_id", clientId)
      .or(`livemode.eq.${livemode},source.eq.external`)
      .order("paid_at", { ascending: false, nullsFirst: false })
      .limit(24),
    supabase
      .from("plans")
      .select("package_id, billing_packages(name)")
      .eq("client_id", clientId)
      .maybeSingle(),
  ]);

  const state = billingState(status?.billing_state);
  const reasons = status?.attention_reasons ?? [];
  const outstanding = Object.entries((status?.outstanding_cents_by_currency ?? {}) as Record<string, number>);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Subscription</CardTitle>
              <Badge variant="outline" className={billingStateStyles[state]}>
                {billingStateLabels[state]}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!livemode && (
              <p className="text-xs text-muted-foreground">Showing Stripe test mode.</p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Package</dt>
              <dd>
                {plan?.billing_packages?.name ?? (
                  <Link href={`/clients/${clientId}/plan`} className="underline">Set on the Plan tab</Link>
                )}
              </dd>
              <dt className="text-muted-foreground">Stripe status</dt>
              <dd>{status?.subscription_status ?? "—"}</dd>
              <dt className="text-muted-foreground">Recurring</dt>
              <dd>
                {status?.mrr_cents != null ? `${formatMoney(status.mrr_cents, status.currency)} / month` : "—"}
                {status?.mrr_incomplete ? " (plus usage)" : ""}
              </dd>
              <dt className="text-muted-foreground">Current period</dt>
              <dd>
                {status?.current_period_start
                  ? `${fmtDate(status.current_period_start)} – ${fmtDate(status.current_period_end)}`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Next billing</dt>
              <dd>
                {status?.next_billing_at
                  ? fmtDate(status.next_billing_at)
                  : status?.cancel_at_period_end || status?.cancel_at
                    ? `Ends ${fmtDate(status.cancel_at ?? status.current_period_end)}`
                    : "—"}
              </dd>
              <dt className="text-muted-foreground">Payment method</dt>
              <dd>
                {status?.default_payment_method_type
                  ? `${methodLabels[status.default_payment_method_type] ?? status.default_payment_method_type}${
                      status.default_payment_method_last4 ? ` ····${status.default_payment_method_last4}` : ""
                    }`
                  : "Not on file"}
              </dd>
            </dl>
            {reasons.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-red-800">
                {reasons.map((r) => <li key={r}>{attentionLabel(r)}</li>)}
              </ul>
            )}
            {status?.checkout_url && (
              <p className="text-sm text-muted-foreground">
                A Checkout link is open until {fmtDate(status.checkout_expires_at)}.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {status?.stripe_customer_id && (
                <Button variant="outline" size="sm" render={
                  <a href={stripeDashboardUrl("customers", status.stripe_customer_id, livemode)} target="_blank" rel="noreferrer">
                    Open in Stripe
                  </a>
                } />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Checkout links, linking an existing Stripe customer and the Stripe
              customer portal arrive with the next billing release.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Outstanding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-3xl font-semibold tracking-tight">
              {outstanding.length === 0
                ? formatMoney(0, status?.currency ?? "usd")
                : outstanding.map(([cur, cents]) => formatMoney(cents, cur)).join(" + ")}
            </p>
            <p className="text-sm text-muted-foreground">
              {status?.open_invoice_count ?? 0} open invoice
              {(status?.open_invoice_count ?? 0) === 1 ? "" : "s"} in Stripe. Stripe
              retries failed payments and decides past due; this page mirrors it.
            </p>
            {status?.latest_invoice_url && status.latest_invoice_status === "open" && (
              <p className="text-sm">
                <a href={status.latest_invoice_url} target="_blank" rel="noreferrer" className="underline">
                  Open the invoice awaiting payment
                </a>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {(invoices ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Remaining</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices ?? []).map((i) => (
                  <TableRow key={i.stripe_invoice_id}>
                    <TableCell>{fmtDate(i.stripe_created_at)}</TableCell>
                    <TableCell>{i.number ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{i.stripe_subscription_id ? "Recurring" : "One-time"}</TableCell>
                    <TableCell>{i.status}</TableCell>
                    <TableCell>{formatMoney(i.total_cents, i.currency)}</TableCell>
                    <TableCell>{i.amount_remaining_cents ? formatMoney(i.amount_remaining_cents, i.currency) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {i.period_start ? `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` : "—"}
                    </TableCell>
                    <TableCell>
                      <a
                        href={i.hosted_invoice_url ?? stripeDashboardUrl("invoices", i.stripe_invoice_id, livemode)}
                        target="_blank"
                        rel="noreferrer"
                        className="underline text-muted-foreground"
                      >
                        View
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {(payments ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Paid</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Refunded</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{fmtDate(p.paid_at)}</TableCell>
                    <TableCell>{formatMoney(p.amount_cents, p.currency)}</TableCell>
                    <TableCell>{p.amount_refunded_cents ? formatMoney(p.amount_refunded_cents, p.currency) : "—"}</TableCell>
                    <TableCell>
                      {methodLabels[(p.source === "external" ? p.external_method : p.payment_method_type) ?? ""] ?? "—"}
                    </TableCell>
                    <TableCell>{p.status}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.stripe_payment_intent_id ? (
                        <a
                          href={stripeDashboardUrl("payments", p.stripe_payment_intent_id, p.livemode ?? livemode)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {p.stripe_payment_intent_id.slice(0, 14)}…
                        </a>
                      ) : (
                        p.reference ?? "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
