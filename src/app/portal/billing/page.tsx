import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/billing";
import { formatDate } from "@/lib/portal";
import {
  invoiceStatusLabels,
  portalStatus,
  portalStatusHelp,
  portalStatusLabels,
  portalStatusStyles,
} from "@/lib/portal-billing";
import { openPortalBillingAction } from "@/app/portal-billing-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// The client's billing, in their words (B5). Everything comes from the
// portal_* views (0062), each filtered to the signed-in contact's own client
// in the database; nothing here names a client, and no Stripe id, internal
// code or note is ever selected.

export default async function PortalBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const [{ data: summary }, { data: services }, { data: invoices }] = await Promise.all([
    supabase.from("portal_billing_summary").select("*").maybeSingle(),
    supabase.from("portal_entitlements").select("service_key, service_name, kind, quantity, unit, period, sort_order").order("sort_order"),
    supabase.from("portal_billing_invoices").select("*").order("invoice_date", { ascending: false }).limit(24),
  ]);

  const status = portalStatus(summary?.status);
  const help = portalStatusHelp(status);
  const features = (services ?? []).filter((s) => s.kind === "feature");
  const monthly = (services ?? []).filter((s) => s.kind === "quota" && (s.quantity ?? 0) > 0);
  const external = summary?.collection === "external";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title kicker mb-1">Billing</h1>
        <p className="text-sm text-muted-foreground">Your plan with Compass and your invoices.</p>
      </div>
      {error && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</div>}

      <Card data-card="billing-overview">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Billing overview</CardTitle>
            <Badge variant="outline" className={portalStatusStyles[status]}>{portalStatusLabels[status]}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <dt className="text-muted-foreground">Current plan</dt>
            <dd>{summary?.plan_name ?? "—"}</dd>
            {!external && (
              <>
                <dt className="text-muted-foreground">Monthly amount</dt>
                <dd>{summary?.monthly_amount_cents != null ? formatMoney(summary.monthly_amount_cents, summary.currency) : "—"}</dd>
                <dt className="text-muted-foreground">{status === "scheduled_to_end" ? "Ends" : "Next billing date"}</dt>
                <dd>{formatDate(status === "scheduled_to_end" ? summary?.ends_at : summary?.next_billing_at)}</dd>
              </>
            )}
          </dl>
          {help && <p className="text-muted-foreground" data-billing-help>{help}</p>}
          {summary?.can_manage_billing && !external && (
            <form action={openPortalBillingAction}>
              <Button type="submit" size="sm">Manage billing</Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Update your payment method, download invoices and change your billing contact details on Stripe, our
                payment processor. To change your plan, reply to your last email from Compass.
              </p>
            </form>
          )}
        </CardContent>
      </Card>

      <Card data-card="plan-services">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your plan includes</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <p className="mb-2 font-medium">Services</p>
            {features.length === 0 ? (
              <p className="text-muted-foreground">Your plan details will appear here once they are set up.</p>
            ) : (
              <ul className="space-y-1">{features.map((s) => <li key={s.service_key}>{s.service_name}</li>)}</ul>
            )}
          </div>
          <div>
            <p className="mb-2 font-medium">Every month</p>
            {monthly.length === 0 ? (
              <p className="text-muted-foreground">—</p>
            ) : (
              <ul className="space-y-1">
                {monthly.map((s) => <li key={s.service_key}>{s.quantity} {s.service_name}</li>)}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card data-card="invoices">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {external ? (
            <p className="text-sm text-muted-foreground">Billing is managed directly with Compass, so invoices are not listed here.</p>
          ) : (invoices ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices ?? []).map((i) => (
                  <TableRow key={`${i.number}-${i.invoice_date}`}>
                    <TableCell>{formatDate(i.invoice_date)}</TableCell>
                    <TableCell>{i.number ?? "—"}</TableCell>
                    <TableCell>{formatMoney(i.total_cents, i.currency)}</TableCell>
                    <TableCell>
                      {invoiceStatusLabels[i.status ?? ""] ?? i.status}
                      {i.status === "open" && i.amount_remaining_cents ? ` · ${formatMoney(i.amount_remaining_cents, i.currency)} due` : ""}
                    </TableCell>
                    <TableCell className="space-x-3 whitespace-nowrap text-right">
                      {i.hosted_invoice_url && <a href={i.hosted_invoice_url} target="_blank" rel="noreferrer" className="underline">View invoice</a>}
                      {i.invoice_pdf && <a href={i.invoice_pdf} target="_blank" rel="noreferrer" className="underline">Download PDF</a>}
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
