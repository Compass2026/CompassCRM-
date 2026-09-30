import { randomUUID } from "node:crypto";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import {
  attentionLabel,
  billingState,
  billingStateLabels,
  billingStateStyles,
  entitlementText,
  externalMethodLabels,
  formatMoney,
  stripeDashboardUrl,
  type Entitlement,
} from "@/lib/billing";
import { auditActionLabels, intervalText, linkIsOpen, modeLabel } from "@/lib/billing-ops";
import {
  createCheckoutAction,
  createCustomPriceAction,
  createStripeCustomerAction,
  expireCheckoutAction,
  openCustomerPortalAction,
  recordExternalPaymentAction,
  resyncStripeCustomerAction,
  voidExternalPaymentAction,
} from "@/app/billing-actions";
import { reconcileClientAction } from "@/app/billing-reconcile-actions";
import { CopyLinkButton } from "@/components/billing/copy-link-button";
import { StripeSyncCard } from "@/components/billing/stripe-sync-card";
import { CustomerLinkSearch } from "@/components/billing/customer-link-search";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// The client's billing (B3). Stripe is authoritative: everything financial on
// this page is read from the Stripe mirror (0058 / 0059), which only the
// Stripe functions write. The actions call the stripe-billing function with
// the teammate's own session; admin-only actions are shown to admins only and
// refused for anyone else by the function and the database.

const methodLabels: Record<string, string> = {
  card: "Card",
  us_bank_account: "ACH debit",
  other: "Other",
  ...externalMethodLabels,
};
const BLOCKING = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

type PriceInfo = {
  unit_amount_cents: number | null;
  currency: string;
  recurring_interval: string | null;
  recurring_interval_count: number | null;
  nickname: string | null;
  active: boolean;
  livemode: boolean;
};
const priceText = (p: PriceInfo | null | undefined) =>
  p ? `${formatMoney(p.unit_amount_cents, p.currency)} / ${intervalText(p.recurring_interval, p.recurring_interval_count)}` : "—";

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { clientId } = await params;
  const { error, notice } = await searchParams;
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  const isAdmin = me?.role === "admin";

  const [{ data: status }, { data: livemodeSetting }] = await Promise.all([
    supabase.from("client_billing_status").select("*").eq("client_id", clientId).maybeSingle(),
    supabase.rpc("billing_livemode"),
  ]);
  const livemode = status?.livemode ?? livemodeSetting === true;

  const [
    { data: client },
    { data: contact },
    { data: plan },
    { data: customer },
    { data: checkouts },
    { data: invoices },
    { data: payments },
    { data: refunds },
    { data: entitlementRows },
    { data: audit },
    { data: portalSetting },
  ] = await Promise.all([
    supabase.from("clients").select("id, name, status").eq("id", clientId).maybeSingle(),
    supabase.from("client_contacts").select("email").eq("client_id", clientId).eq("is_primary", true).not("email", "is", null).limit(1).maybeSingle(),
    supabase.from("plans").select("package_id, collection, billing_packages(id, name, kind, active)").eq("client_id", clientId).maybeSingle(),
    supabase
      .from("stripe_customers")
      .select("stripe_customer_id, name, email, link_source, linked_at, livemode, team_members!stripe_customers_linked_by_fkey(name)")
      .eq("client_id", clientId)
      .eq("livemode", livemode)
      .is("unlinked_at", null)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("checkout_sessions")
      .select("stripe_checkout_session_id, status, url, expires_at, completed_at, line_items, created_at, billing_packages(name), team_members!checkout_sessions_created_by_fkey(name)")
      .eq("client_id", clientId)
      .eq("livemode", livemode)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("invoices")
      .select("stripe_invoice_id, number, status, currency, total_cents, amount_paid_cents, amount_remaining_cents, due_date, period_start, period_end, hosted_invoice_url, invoice_pdf, stripe_subscription_id, stripe_created_at")
      .eq("client_id", clientId)
      .eq("livemode", livemode)
      .neq("status", "draft")
      .order("stripe_created_at", { ascending: false })
      .limit(24),
    supabase
      .from("payments")
      .select("id, source, status, amount_cents, amount_refunded_cents, currency, payment_method_type, external_method, reference, notes, paid_at, stripe_payment_intent_id, livemode, voided_at, void_reason, recorder:team_members!payments_recorded_by_fkey(name), voider:team_members!payments_voided_by_fkey(name)")
      .eq("client_id", clientId)
      .or(`livemode.eq.${livemode},source.eq.external`)
      .order("paid_at", { ascending: false, nullsFirst: false })
      .limit(24),
    supabase
      .from("stripe_refunds")
      .select("stripe_refund_id, stripe_payment_intent_id, amount_cents, currency, status, reason, failure_reason, stripe_created_at")
      .eq("client_id", clientId)
      .eq("livemode", livemode)
      .order("stripe_created_at", { ascending: true }),
    supabase.from("client_entitlements").select("*").eq("client_id", clientId).order("service_kind").order("service_name"),
    supabase
      .from("billing_audit_events")
      .select("id, action, actor_kind, subject, detail, created_at, livemode, team_members(name), portal_users(email)")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("app_settings").select("value").eq("key", "billing_portal").maybeSingle(),
  ]);
  const [{ data: syncHealth }, { data: reconciled }] = await Promise.all([
    supabase.from("billing_sync_health").select("*").maybeSingle(),
    supabase.from("client_billing_reconciliation").select("*").eq("client_id", clientId).maybeSingle(),
  ]);

  // Prices approved for the agreed package: the package's standard prices, or
  // (custom package) the ones created for this client. Never any other.
  const pkg = plan?.billing_packages ?? null;
  const { data: approved } = pkg
    ? await supabase
        .from("billing_package_prices")
        .select("id, client_id, is_default, stripe_price_id, stripe_prices(unit_amount_cents, currency, recurring_interval, recurring_interval_count, nickname, active, livemode)")
        .eq("package_id", pkg.id)
        .eq("active", true)
        .or(`client_id.is.null,client_id.eq.${clientId}`)
    : { data: [] };
  const sellable = (approved ?? []).filter((p) => p.stripe_prices?.active && p.stripe_prices.livemode === livemode);
  const priceIds = [...new Set((checkouts ?? []).map((c) => (c.line_items as { price?: string }[])?.[0]?.price).filter(Boolean) as string[])];
  const { data: checkoutPrices } = priceIds.length
    ? await supabase.from("stripe_prices").select("stripe_price_id, unit_amount_cents, currency, recurring_interval, recurring_interval_count, nickname, active, livemode").in("stripe_price_id", priceIds)
    : { data: [] };
  const priceOf = (id: string | undefined) => (checkoutPrices ?? []).find((p) => p.stripe_price_id === id) as PriceInfo | undefined;

  const state = billingState(status?.billing_state);
  const reasons = status?.attention_reasons ?? [];
  const outstanding = Object.entries((status?.outstanding_cents_by_currency ?? {}) as Record<string, number>);
  const open = (checkouts ?? []).find((c) => linkIsOpen(c));
  const subscribed = !!status?.subscription_status && BLOCKING.has(status.subscription_status);
  const entitlements = (entitlementRows ?? []) as Entitlement[];
  const portalReady = !!((portalSetting?.value ?? {}) as Record<string, { configuration_id?: string }>)[livemode ? "live" : "test"]?.configuration_id;
  const offboarded = client?.status === "offboarded";
  const refundsFor = (pi: string | null) => (refunds ?? []).filter((r) => r.stripe_payment_intent_id === pi);
  const blockedCheckout = !pkg
    ? "Record the client's package on the Plan tab first."
    : plan?.collection === "external"
      ? "The agreement is collected outside Stripe."
      : !customer
        ? "Link or create the client's Stripe customer first."
        : subscribed
          ? "The client already has a subscription in Stripe; change it there rather than selling a second one."
          : sellable.length === 0
            ? pkg.kind === "custom"
              ? "Create the client's retainer price below first."
              : "No approved price for this package yet (Settings › Billing catalog)."
            : null;

  return (
    <div className="space-y-4">
      <div
        className={`rounded-md border px-3 py-2 text-sm ${livemode ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}
        data-billing-mode={livemode ? "live" : "test"}
      >
        <strong>Stripe {modeLabel(livemode).toLowerCase()}.</strong>{" "}
        {livemode ? "Real charges." : "No real money moves: test customers, test cards and test bank accounts only."}{" "}
        Only an admin switches the mode, at cutover.
      </div>
      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">{notice}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Subscription</CardTitle>
              <Badge variant="outline" className={billingStateStyles[state]}>{billingStateLabels[state]}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Package</dt>
              <dd>{pkg?.name ?? <Link href={`/clients/${clientId}/plan`} className="underline">Set on the Plan tab</Link>}</dd>
              <dt className="text-muted-foreground">Stripe status</dt>
              <dd>{status?.subscription_status ?? "—"}</dd>
              <dt className="text-muted-foreground">Recurring</dt>
              <dd>
                {status?.mrr_cents != null ? `${formatMoney(status.mrr_cents, status.currency)} / month` : "—"}
                {status?.mrr_incomplete ? " (plus usage)" : ""}
              </dd>
              <dt className="text-muted-foreground">Current period</dt>
              <dd>{status?.current_period_start ? `${fmtDate(status.current_period_start)} – ${fmtDate(status.current_period_end)}` : "—"}</dd>
              <dt className="text-muted-foreground">Next billing</dt>
              <dd>
                {status?.next_billing_at
                  ? fmtDate(status.next_billing_at)
                  : status?.cancel_at_period_end || status?.cancel_at
                    ? `Ends ${fmtDate(status.cancel_at ?? status.current_period_end)}`
                    : "—"}
              </dd>
              <dt className="text-muted-foreground">Cancels at period end</dt>
              <dd>{status?.cancel_at_period_end ? "Yes" : "No"}</dd>
              <dt className="text-muted-foreground">Payment method</dt>
              <dd>
                {status?.default_payment_method_type
                  ? `${methodLabels[status.default_payment_method_type] ?? status.default_payment_method_type}${status.default_payment_method_last4 ? ` ····${status.default_payment_method_last4}` : ""}`
                  : "Not on file"}
              </dd>
            </dl>
            {reasons.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-red-800">Needs attention</p>
                <ul className="list-disc pl-5 text-sm text-red-800">
                  {reasons.map((r) => <li key={r}>{attentionLabel(r)}</li>)}
                </ul>
                <p className="text-xs text-muted-foreground">Stripe runs retries and dunning; nothing here stops the client&apos;s work.</p>
              </div>
            )}
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
              {status?.open_invoice_count ?? 0} open invoice{(status?.open_invoice_count ?? 0) === 1 ? "" : "s"} in Stripe.
              Stripe retries failed payments and decides past due; this page mirrors it.
            </p>
            {status?.latest_invoice_url && status.latest_invoice_status === "open" && (
              <p className="text-sm">
                <a href={status.latest_invoice_url} target="_blank" rel="noreferrer" className="underline">Open the invoice awaiting payment</a>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <StripeSyncCard
        health={syncHealth}
        result={reconciled}
        livemode={livemode}
        scope="client"
        action={isAdmin && customer && !offboarded ? reconcileClientAction.bind(null, clientId) : undefined}
        actionLabel="Reconcile This Client"
      />

      {/* ── Stripe customer ───────────────────────────────────────────── */}
      <Card data-card="customer">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Stripe customer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {customer ? (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                <dt className="text-muted-foreground">Customer</dt>
                <dd className="font-mono text-xs">{customer.stripe_customer_id}</dd>
                <dt className="text-muted-foreground">Name</dt>
                <dd>{customer.name ?? "—"}</dd>
                <dt className="text-muted-foreground">Billing email</dt>
                <dd>{customer.email ?? "—"}</dd>
                <dt className="text-muted-foreground">How linked</dt>
                <dd>
                  {customer.link_source === "created" ? "Created by Compass" : "Existing customer linked"} {fmtDate(customer.linked_at)}
                  {customer.team_members?.name ? ` by ${customer.team_members.name}` : ""}
                </dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <a
                  href={stripeDashboardUrl("customers", customer.stripe_customer_id, livemode)}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Open in Stripe
                </a>
                {isAdmin && !offboarded && (
                  <form action={openCustomerPortalAction.bind(null, clientId)}>
                    <Button type="submit" variant="outline" size="sm" disabled={!portalReady}>Manage Billing in Stripe</Button>
                  </form>
                )}
                {!offboarded && (
                  <form action={resyncStripeCustomerAction.bind(null, clientId)}>
                    <Button type="submit" variant="ghost" size="sm">Re-read from Stripe</Button>
                  </form>
                )}
              </div>
              {isAdmin && !portalReady && (
                <p className="text-xs text-muted-foreground">
                  Manage Billing opens the Stripe Customer Portal once an admin configures it in{" "}
                  <Link href="/settings/billing" className="underline">Settings › Billing catalog</Link>.
                </p>
              )}
            </>
          ) : offboarded ? (
            <p className="text-muted-foreground">The client is offboarded.</p>
          ) : isAdmin ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="font-medium">Link an existing Stripe customer</p>
                <p className="text-xs text-muted-foreground">
                  If the client already pays through Stripe, link that customer rather than creating a second one.
                  Its subscriptions, invoices and payments are imported.
                </p>
                <CustomerLinkSearch clientId={clientId} clientName={client?.name ?? "the client"} />
              </div>
              <form action={createStripeCustomerAction.bind(null, clientId)} className="space-y-2">
                <p className="font-medium">Or create a new Stripe customer</p>
                <p className="text-xs text-muted-foreground">
                  Only for a client with no Stripe customer yet. Stripe records the Compass client id on it.
                </p>
                <div className="space-y-1">
                  <Label htmlFor="cust-name">Name</Label>
                  <Input id="cust-name" name="name" defaultValue={client?.name ?? ""} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cust-email">Billing email</Label>
                  <Input id="cust-email" name="email" type="email" required defaultValue={contact?.email ?? ""} />
                </div>
                <Button type="submit" size="sm">Create Stripe customer</Button>
              </form>
            </div>
          ) : (
            <p className="text-muted-foreground">No Stripe customer yet. An admin links the client&apos;s existing customer or creates one.</p>
          )}
        </CardContent>
      </Card>

      {/* ── Payment link ──────────────────────────────────────────────── */}
      <Card data-card="payment-link">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{open ? "Payment Link Ready" : "Payment link"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {open ? (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                <dt className="text-muted-foreground">Client</dt>
                <dd>{client?.name}</dd>
                <dt className="text-muted-foreground">Package</dt>
                <dd>{open.billing_packages?.name ?? "—"}</dd>
                <dt className="text-muted-foreground">Price</dt>
                <dd>{priceText(priceOf((open.line_items as { price?: string }[])?.[0]?.price))}</dd>
                <dt className="text-muted-foreground">Expires</dt>
                <dd>{fmtDateTime(open.expires_at)}</dd>
                <dt className="text-muted-foreground">Mode</dt>
                <dd>{modeLabel(livemode)}</dd>
                <dt className="text-muted-foreground">Created by</dt>
                <dd>{open.team_members?.name ?? "—"} · {fmtDate(open.created_at)}</dd>
              </dl>
              <p className="break-all rounded border bg-muted/40 px-2 py-1 font-mono text-xs" data-payment-link>{open.url}</p>
              <div className="flex flex-wrap gap-2">
                <CopyLinkButton url={open.url!} />
                <a href={open.url!} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open Payment Link
                </a>
                {isAdmin && (
                  <form action={expireCheckoutAction.bind(null, clientId, open.stripe_checkout_session_id)}>
                    <Button type="submit" variant="ghost" size="sm">Expire link</Button>
                  </form>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Send it to the client yourself. The subscription starts when Stripe confirms payment (card at once;
                ACH debit takes a few business days) — not when the client finishes the page.
              </p>
            </>
          ) : blockedCheckout ? (
            <p className="text-muted-foreground" data-checkout-blocked>{blockedCheckout}</p>
          ) : isAdmin ? (
            <form action={createCheckoutAction.bind(null, clientId)} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="request_id" value={randomUUID()} />
              <div className="space-y-1">
                <Label htmlFor="package_price_id">Price ({pkg?.name})</Label>
                <select
                  id="package_price_id"
                  name="package_price_id"
                  className="field w-full"
                  defaultValue={(sellable.find((p) => p.is_default) ?? sellable[0])?.id}
                >
                  {sellable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {priceText(p.stripe_prices as PriceInfo)}{p.stripe_prices?.nickname ? ` — ${p.stripe_prices.nickname}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" size="sm">Create payment link</Button>
              <p className="w-full text-xs text-muted-foreground">
                Stripe Checkout for a subscription at an approved price, card or ACH debit. Nothing is charged until the client pays.
              </p>
            </form>
          ) : (
            <p className="text-muted-foreground">An admin creates the payment link; you can copy and send it once it exists.</p>
          )}

          {isAdmin && pkg?.kind === "custom" && customer && !subscribed && !open && (
            <form action={createCustomPriceAction.bind(null, clientId, pkg.id)} className="flex flex-wrap items-end gap-3 border-t pt-3">
              <input type="hidden" name="request_id" value={randomUUID()} />
              <p className="w-full font-medium">New retainer price for {client?.name}</p>
              <div className="space-y-1">
                <Label htmlFor="retainer-amount">Amount (USD)</Label>
                <Input id="retainer-amount" name="amount" inputMode="decimal" placeholder="2,250.00" required className="w-32" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="retainer-interval">Every</Label>
                <select id="retainer-interval" name="interval" className="field" defaultValue="month">
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
              </div>
              <div className="space-y-1 grow">
                <Label htmlFor="retainer-nickname">Name in Stripe</Label>
                <Input id="retainer-nickname" name="nickname" placeholder={`${client?.name} retainer`} />
              </div>
              <Button type="submit" size="sm" variant="outline">Create price</Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* ── Entitlements ─────────────────────────────────────────────── */}
      <Card data-card="entitlements">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">What the client receives</CardTitle>
          <p className="text-xs text-muted-foreground">
            From the agreement, not from payment: past due or unpaid never switches anything off.
            Edit on the <Link href={`/clients/${clientId}/plan`} className="underline">Plan tab</Link>.
          </p>
        </CardHeader>
        <CardContent>
          {entitlements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No package on the agreement yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Included</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entitlements.map((e) => (
                  <TableRow key={e.service_key}>
                    <TableCell>{e.service_name}</TableCell>
                    <TableCell>{entitlementText(e)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {e.source === "override" ? `Client override: ${e.override_reason}` : e.source === "package" ? "Package" : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Invoices ─────────────────────────────────────────────────── */}
      <Card data-card="invoices">
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
                  <TableHead>Paid</TableHead>
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
                    <TableCell>{formatMoney(i.total_cents, i.currency)} <span className="text-xs uppercase text-muted-foreground">{i.currency}</span></TableCell>
                    <TableCell>{formatMoney(i.amount_paid_cents, i.currency)}</TableCell>
                    <TableCell>{i.amount_remaining_cents ? formatMoney(i.amount_remaining_cents, i.currency) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{i.period_start ? `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` : "—"}</TableCell>
                    <TableCell className="space-x-2 whitespace-nowrap">
                      <a href={i.hosted_invoice_url ?? stripeDashboardUrl("invoices", i.stripe_invoice_id, livemode)} target="_blank" rel="noreferrer" className="underline text-muted-foreground">View</a>
                      {i.invoice_pdf && <a href={i.invoice_pdf} target="_blank" rel="noreferrer" className="underline text-muted-foreground">PDF</a>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Payments and refunds ─────────────────────────────────────── */}
      <Card data-card="payments">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(payments ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Refunded</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Reference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments ?? []).flatMap((p) => {
                  const rows = [
                    <TableRow key={p.id} data-payment={p.id} className={p.voided_at ? "text-muted-foreground line-through decoration-1" : undefined}>
                      <TableCell>{fmtDate(p.paid_at)}</TableCell>
                      <TableCell>{formatMoney(p.amount_cents, p.currency)}</TableCell>
                      <TableCell>{methodLabels[(p.source === "external" ? p.external_method : p.payment_method_type) ?? ""] ?? "—"}</TableCell>
                      <TableCell>{p.voided_at ? "void" : p.status}</TableCell>
                      <TableCell>{p.amount_refunded_cents ? formatMoney(p.amount_refunded_cents, p.currency) : "—"}</TableCell>
                      <TableCell>{p.source === "external" ? `External · recorded by ${p.recorder?.name ?? "—"}` : "Stripe"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.stripe_payment_intent_id ? (
                          <a href={stripeDashboardUrl("payments", p.stripe_payment_intent_id, p.livemode ?? livemode)} target="_blank" rel="noreferrer" className="underline">
                            {p.stripe_payment_intent_id.slice(0, 14)}…
                          </a>
                        ) : (
                          p.reference ?? "—"
                        )}
                      </TableCell>
                    </TableRow>,
                  ];
                  for (const r of refundsFor(p.stripe_payment_intent_id)) {
                    rows.push(
                      <TableRow key={r.stripe_refund_id} data-refund={r.stripe_refund_id} className="bg-muted/30 text-xs">
                        <TableCell className="pl-6">↳ {fmtDate(r.stripe_created_at)}</TableCell>
                        <TableCell>−{formatMoney(r.amount_cents, r.currency)}</TableCell>
                        <TableCell>Refund</TableCell>
                        <TableCell>{r.status}</TableCell>
                        <TableCell colSpan={2}>{r.reason?.replaceAll("_", " ") ?? "—"}{r.failure_reason ? ` · failed: ${r.failure_reason}` : ""}</TableCell>
                        <TableCell className="font-mono">{r.stripe_refund_id}</TableCell>
                      </TableRow>,
                    );
                  }
                  if (p.source === "external" && (p.notes || p.voided_at)) {
                    rows.push(
                      <TableRow key={`${p.id}-notes`} className="text-xs">
                        <TableCell colSpan={7} className="pl-6 text-muted-foreground">
                          {p.notes}
                          {p.voided_at ? ` — voided ${fmtDate(p.voided_at)} by ${p.voider?.name ?? "—"}: ${p.void_reason}` : ""}
                          {isAdmin && !p.voided_at && (
                            <details className="mt-1">
                              <summary className="cursor-pointer underline">Void this payment</summary>
                              <form action={voidExternalPaymentAction.bind(null, clientId, p.id)} className="mt-2 flex flex-wrap gap-2">
                                <Input name="reason" placeholder="Why (e.g. check returned)" required className="w-72" />
                                <Button type="submit" size="sm" variant="outline">Void</Button>
                              </form>
                            </details>
                          )}
                        </TableCell>
                      </TableRow>,
                    );
                  }
                  return rows;
                })}
              </TableBody>
            </Table>
          )}

          {isAdmin && (
            <details className="rounded-md border p-3 text-sm" data-card="external-payment">
              <summary className="cursor-pointer font-medium">Record an external payment</summary>
              <form action={recordExternalPaymentAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="request_id" value={randomUUID()} />
                <div className="space-y-1">
                  <Label htmlFor="ext-amount">Amount</Label>
                  <Input id="ext-amount" name="amount" inputMode="decimal" required placeholder="1,500.00" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ext-currency">Currency</Label>
                  <Input id="ext-currency" name="currency" defaultValue="usd" maxLength={3} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ext-method">Method</Label>
                  <select id="ext-method" name="method" className="field w-full" required defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {Object.entries(externalMethodLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ext-date">Date received</Label>
                  <Input id="ext-date" name="paid_at" type="date" required />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="ext-reference">Reference (check number, wire id)</Label>
                  <Input id="ext-reference" name="reference" />
                </div>
                <div className="space-y-1 sm:col-span-3">
                  <Label htmlFor="ext-notes">Notes</Label>
                  <Input id="ext-notes" name="notes" required placeholder="What the payment was for" />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Recorded as paid outside Stripe, with your name. It is never edited or deleted; a mistake is voided with a reason.
                </p>
                <Button type="submit" size="sm">Record payment</Button>
              </form>
            </details>
          )}
        </CardContent>
      </Card>

      {/* ── History ──────────────────────────────────────────────────── */}
      <Card data-card="history">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Billing history</CardTitle>
        </CardHeader>
        <CardContent>
          {(audit ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(audit ?? []).map((a) => (
                <li key={a.id} className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">{fmtDateTime(a.created_at)}</span>
                  <span>{auditActionLabels[a.action] ?? a.action}</span>
                  <span className="text-muted-foreground">
                    by {a.actor_kind === "portal" ? `${a.portal_users?.email ?? "the client"} (portal)` : (a.team_members?.name ?? "—")}
                  </span>
                  {a.subject && <span className="font-mono text-xs text-muted-foreground">{a.subject}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
