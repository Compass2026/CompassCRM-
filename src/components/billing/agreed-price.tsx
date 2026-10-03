import {
  agreedPriceText,
  agreementPriceStatus,
  agreementPriceStatusHelp,
  agreementPriceStatusLabels,
  type AgreementPriceStatus,
} from "@/lib/billing";
import { Badge } from "@/components/ui/badge";

// The agreement's price as client_agreement_price (0058) reads it: what the
// client contracted to pay, and the exact approved Stripe Price Checkout
// sells for it. Shown on the Plan tab (with the admin's controls) and the
// Billing tab (above the payment link).

export type AgreementPriceRow = {
  price_status: string | null;
  agreed_amount_cents: number | null;
  agreed_currency: string | null;
  agreed_billing_interval: string | null;
  agreed_billing_interval_count: number | null;
  billing_package_price_id: string | null;
  stripe_price_id: string | null;
  price_amount_cents: number | null;
  price_currency: string | null;
  price_interval: string | null;
  price_interval_count: number | null;
  price_livemode: boolean | null;
};

const statusStyles: Record<AgreementPriceStatus, string> = {
  ready: "bg-green-100 text-green-800 border-green-200",
  unmapped: "bg-amber-100 text-amber-800 border-amber-200",
  terms_missing: "bg-amber-100 text-amber-800 border-amber-200",
  inactive: "bg-red-100 text-red-800 border-red-200",
  wrong_mode: "bg-red-100 text-red-800 border-red-200",
  mismatch: "bg-red-100 text-red-800 border-red-200",
  not_applicable: "bg-muted text-muted-foreground",
};

export function agreedPriceOf(row: AgreementPriceRow | null | undefined): string {
  return agreedPriceText({
    amount_cents: row?.agreed_amount_cents,
    currency: row?.agreed_currency,
    interval: row?.agreed_billing_interval,
    interval_count: row?.agreed_billing_interval_count,
  });
}

export function AgreedPriceSummary({
  row,
  packageName,
  isAdmin,
}: {
  row: AgreementPriceRow | null | undefined;
  packageName: string | null | undefined;
  isAdmin: boolean;
}) {
  const status = agreementPriceStatus(row?.price_status);
  const mapped = row?.stripe_price_id
    ? agreedPriceText({
        amount_cents: row.price_amount_cents,
        currency: row.price_currency,
        interval: row.price_interval,
        interval_count: row.price_interval_count,
      })
    : null;
  return (
    <div className="space-y-2 text-sm" data-agreed-price data-price-status={status}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Package</dt>
        <dd>{packageName ?? "—"}</dd>
        <dt className="text-muted-foreground">Agreed price</dt>
        <dd className="font-medium" data-agreed-amount>{agreedPriceOf(row)}</dd>
        <dt className="text-muted-foreground">Stripe Price</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={statusStyles[status]} data-mapping-status>
            {agreementPriceStatusLabels[status]}
          </Badge>
          {mapped && (
            <span data-mapped-price>
              {mapped}
              {row?.price_livemode != null ? ` · ${row.price_livemode ? "live" : "test"} mode` : ""}
            </span>
          )}
        </dd>
      </dl>
      {status !== "ready" && status !== "not_applicable" && (
        <p className="text-xs text-muted-foreground">{agreementPriceStatusHelp[status]}</p>
      )}
      {isAdmin && row?.stripe_price_id && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Stripe detail</summary>
          <span className="font-mono">{row.stripe_price_id}</span>
        </details>
      )}
    </div>
  );
}
