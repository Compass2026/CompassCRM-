import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  pauseSubscriptionAction,
  resumeSubscriptionAction,
  setupBillingAction,
} from "@/app/billing-actions";
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
import { paidStatusLabels, paidStatusStyles } from "@/lib/labels";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const methodLabels: Record<string, string> = {
  card: "Card",
  stripe_ach: "ACH (Stripe)",
  external_ach: "ACH (external)",
  check: "Check",
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
  const [
    { data: customer },
    { data: subscription },
    { data: payments },
    { data: plan },
  ] = await Promise.all([
    supabase
      .from("stripe_customers")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle(),
    supabase
      .from("subscriptions")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("payments")
      .select("*")
      .eq("client_id", clientId)
      .order("paid_at", { ascending: false }),
    supabase
      .from("plans")
      .select("package_name, monthly_fee")
      .eq("client_id", clientId)
      .maybeSingle(),
  ]);

  const lifetimePaid = (payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  const setup = setupBillingAction.bind(null, clientId);
  const pause = pauseSubscriptionAction.bind(null, clientId);
  const resume = resumeSubscriptionAction.bind(null, clientId);
  const isPaused = subscription?.status === "paused";
  const isCanceled = subscription?.status === "canceled";

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Subscription</CardTitle>
              {subscription && (
                <Badge
                  variant="outline"
                  className={paidStatusStyles[subscription.paid_status]}
                >
                  {paidStatusLabels[subscription.paid_status]}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!subscription ? (
              <>
                <p className="text-sm text-muted-foreground">
                  No subscription yet. Setting up billing creates the Stripe
                  customer and a monthly subscription priced from the plan
                  {plan?.monthly_fee
                    ? ` (${usd.format(plan.monthly_fee)}/mo)`
                    : ""}
                  , payable by card or ACH debit via the first hosted invoice.
                </p>
                {plan?.monthly_fee ? (
                  <form action={setup}>
                    <Button type="submit">Set up billing</Button>
                  </form>
                ) : (
                  <p className="text-sm">
                    Set a monthly fee on the{" "}
                    <Link
                      href={`/clients/${clientId}/plan`}
                      className="underline"
                    >
                      Plan tab
                    </Link>{" "}
                    first.
                  </p>
                )}
              </>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd>{plan?.package_name ?? "—"}</dd>
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd>
                    {subscription.amount != null
                      ? `${usd.format(subscription.amount)} / ${subscription.interval}`
                      : "—"}
                  </dd>
                  <dt className="text-muted-foreground">Stripe status</dt>
                  <dd>{subscription.status ?? "—"}</dd>
                  <dt className="text-muted-foreground">Current period</dt>
                  <dd>
                    {fmtDate(subscription.current_period_start)} –{" "}
                    {fmtDate(subscription.current_period_end)}
                  </dd>
                  <dt className="text-muted-foreground">Payment method</dt>
                  <dd>
                    {customer?.payment_method_type
                      ? `${
                          customer.payment_method_type === "us_bank_account"
                            ? "ACH debit"
                            : "Card"
                        }${customer.last4 ? ` ····${customer.last4}` : ""}`
                      : "Not on file yet"}
                  </dd>
                </dl>
                {subscription.latest_invoice_url && (
                  <p className="text-sm">
                    <a
                      href={subscription.latest_invoice_url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Open invoice awaiting payment
                    </a>{" "}
                    <span className="text-muted-foreground">
                      — send this link to the client (card or ACH)
                    </span>
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {!isCanceled &&
                    (isPaused ? (
                      <form action={resume}>
                        <Button variant="outline" size="sm" type="submit">
                          Resume subscription
                        </Button>
                      </form>
                    ) : (
                      <form action={pause}>
                        <Button variant="outline" size="sm" type="submit">
                          Pause subscription
                        </Button>
                      </form>
                    ))}
                  {customer && (
                    <Button variant="outline" size="sm" render={
                      <a
                        href={`https://dashboard.stripe.com/customers/${customer.stripe_customer_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Stripe
                      </a>
                    } />
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Lifetime paid</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tracking-tight">
              {usd.format(lifetimePaid)}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {(payments ?? []).length} payment
              {(payments ?? []).length === 1 ? "" : "s"} recorded — status is
              webhook-driven, so this updates as Stripe settles invoices.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payment history</CardTitle>
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
                  <TableHead>Method</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Invoice</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{fmtDate(p.paid_at)}</TableCell>
                    <TableCell>{usd.format(p.amount)}</TableCell>
                    <TableCell>
                      {p.method ? (methodLabels[p.method] ?? p.method) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fmtDate(p.period_start)} – {fmtDate(p.period_end)}
                    </TableCell>
                    <TableCell>
                      {p.stripe_invoice_id ? (
                        <a
                          href={`https://dashboard.stripe.com/invoices/${p.stripe_invoice_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline text-muted-foreground"
                        >
                          {p.stripe_invoice_id.slice(0, 14)}…
                        </a>
                      ) : (
                        "—"
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
