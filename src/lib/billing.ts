// Billing read model helpers (0058). Pure: shared by the Plan and Billing
// tabs, the Dashboard, the agreement server actions and the tests.
//
// Stripe is the financial source of truth. Everything shown here is read
// from the Stripe mirror through client_billing_status, which derives the
// state instead of storing it. Billing state never changes an entitlement.

export type BillingState =
  | "none"
  | "checkout_pending"
  | "external"
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "collection_paused"
  | "canceling"
  | "canceled";

export const billingStateLabels: Record<BillingState, string> = {
  none: "Not set up",
  checkout_pending: "Checkout sent",
  external: "Paid externally",
  incomplete: "First payment pending",
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  unpaid: "Unpaid",
  paused: "Paused",
  collection_paused: "Collection paused",
  canceling: "Cancels at period end",
  canceled: "Canceled",
};

export const billingStateStyles: Record<BillingState, string> = {
  none: "bg-zinc-100 text-zinc-600 border-zinc-200",
  checkout_pending: "bg-blue-100 text-blue-800 border-blue-200",
  external: "bg-zinc-100 text-zinc-700 border-zinc-200",
  incomplete: "bg-amber-100 text-amber-800 border-amber-200",
  trialing: "bg-blue-100 text-blue-800 border-blue-200",
  active: "bg-green-100 text-green-800 border-green-200",
  past_due: "bg-red-100 text-red-800 border-red-200",
  unpaid: "bg-red-100 text-red-800 border-red-200",
  paused: "bg-amber-100 text-amber-800 border-amber-200",
  collection_paused: "bg-amber-100 text-amber-800 border-amber-200",
  canceling: "bg-amber-100 text-amber-800 border-amber-200",
  canceled: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export function billingState(value: string | null | undefined): BillingState {
  return value && value in billingStateLabels ? (value as BillingState) : "none";
}

// Why client_billing_status raised billing_attention. Operational alerts
// derived from Stripe's own state; Compass never decides dunning.
export const attentionReasonLabels: Record<string, string> = {
  subscription_past_due: "Stripe marks the subscription past due",
  subscription_unpaid: "Stripe marks the subscription unpaid",
  subscription_incomplete: "The first payment has not completed",
  invoice_overdue: "An open invoice is overdue or has failed a payment attempt",
  multiple_live_subscriptions: "More than one live Stripe subscription",
  unmapped_price: "The subscription uses a Stripe price no package is mapped to",
  no_agreement_package: "Billing in Stripe, but no package on the agreement",
  package_mismatch: "The Stripe price belongs to a different package than the agreement",
  agreement_price_unmapped: "Billing is under way, but the agreement has no exact Stripe Price bound",
  agreement_price_mismatch: "The Stripe Price or subscription differs from the agreed price",
};

export function attentionLabel(reason: string): string {
  return attentionReasonLabels[reason] ?? reason.replaceAll("_", " ");
}

// Currencies Stripe charges in whole units (no minor unit).
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function minorUnits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2;
}

// Integer minor units → "$1,500.00". Never floats in storage; only here.
export function formatMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents == null || !currency) return "—";
  const digits = minorUnits(currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 10 ** digits);
}

// "1,500" / "1500.5" / "$1,500.00" → minor units as an integer, exactly (no
// float arithmetic). null for empty, "invalid" for anything else.
export function parseMoneyToCents(input: string | null | undefined, currency = "usd"): number | null | "invalid" {
  if (input == null) return null;
  const s = input.trim().replace(/^\$/, "").replaceAll(",", "");
  if (s === "") return null;
  const digits = minorUnits(currency);
  const m = digits === 0 ? /^(\d+)$/.exec(s) : /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return "invalid";
  const whole = Number(m[1]);
  const frac = digits === 0 ? 0 : Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 10 ** digits + frac;
  return Number.isSafeInteger(cents) ? cents : "invalid";
}

// ── Agreement (plans) ──────────────────────────────────────────────────────
export type Collection = "stripe" | "external";

// What the client contracted to pay (plans.agreed_*), in words:
// "$650.00/month", "$1,950.00 every 3 months".
export function agreedPriceText(p: {
  amount_cents: number | null | undefined;
  currency: string | null | undefined;
  interval: string | null | undefined;
  interval_count?: number | null;
}): string {
  if (p.amount_cents == null || !p.currency || !p.interval) return "—";
  const money = formatMoney(p.amount_cents, p.currency);
  const n = p.interval_count ?? 1;
  return n === 1 ? `${money}/${p.interval}` : `${money} every ${n} ${p.interval}s`;
}

// client_agreement_price.price_status (0058): is the agreement bound to the
// exact Stripe Price Checkout will sell?
export type AgreementPriceStatus =
  | "not_applicable" | "terms_missing" | "unmapped" | "inactive" | "wrong_mode" | "mismatch" | "ready";
export const agreementPriceStatusLabels: Record<AgreementPriceStatus, string> = {
  not_applicable: "Not applicable",
  terms_missing: "No agreed price",
  unmapped: "Not mapped",
  inactive: "Mapped price retired",
  wrong_mode: "Mapped to the other Stripe mode",
  mismatch: "Mapped price differs",
  ready: "Mapped",
};
export const agreementPriceStatusHelp: Record<AgreementPriceStatus, string> = {
  not_applicable: "Only a Stripe-collected agreement with a package is sold through Checkout.",
  terms_missing: "Record the agreed price first (admin).",
  unmapped: "No approved Stripe Price is bound to the agreed price yet. Checkout stays closed until an admin binds one.",
  inactive: "The bound price is retired in the catalog or archived in Stripe. Bind an active price with the same terms.",
  wrong_mode: "The bound price belongs to the other Stripe mode. Bind a price from the current mode.",
  mismatch: "The bound Stripe Price no longer says what the agreement says. Bind a matching price or correct the agreement.",
  ready: "Checkout sells exactly this price.",
};
export function agreementPriceStatus(value: string | null | undefined): AgreementPriceStatus {
  return value && value in agreementPriceStatusLabels ? (value as AgreementPriceStatus) : "not_applicable";
}

export type AgreedPriceRow = {
  agreed_amount_cents: number | null;
  agreed_currency: string | null;
  agreed_billing_interval: string | null;
  agreed_billing_interval_count: number | null;
};

// The agreed recurring price an admin records: an amount, per month or year
// (every 1 – 12). Empty amount clears it.
export function validateAgreedPrice(input: {
  amount: string | null;
  currency?: string | null;
  interval: string | null;
  interval_count: string | null;
}): { row: AgreedPriceRow } | { error: string } {
  const currency = (input.currency || "usd").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return { error: "Currency is a three-letter code (usd)." };
  const cents = parseMoneyToCents(input.amount, currency);
  if (cents == null) {
    return { row: { agreed_amount_cents: null, agreed_currency: null, agreed_billing_interval: null, agreed_billing_interval_count: null } };
  }
  if (cents === "invalid" || cents <= 0) return { error: "The agreed price is an amount above zero." };
  const interval = input.interval || "month";
  if (!(interval in intervalLabels)) return { error: "The agreed price is per month or per year." };
  const count = input.interval_count?.trim() ? Number(input.interval_count) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 12) return { error: "Billed every 1 to 12 months or years." };
  return { row: { agreed_amount_cents: cents, agreed_currency: currency, agreed_billing_interval: interval, agreed_billing_interval_count: count } };
}

// Which approved package prices an agreement may bind: its own package's,
// active, in the current mode, reserved for no other client, with exactly the
// agreed amount, currency and interval (the database's rule, for the list).
export type BindablePrice = {
  id: string;
  package_id: string;
  client_id: string | null;
  active: boolean;
  is_default: boolean;
  stripe_prices: {
    active: boolean;
    livemode: boolean;
    deleted_at: string | null;
    unit_amount_cents: number | null;
    currency: string;
    recurring_interval: string | null;
    recurring_interval_count: number | null;
  } | null;
};
export function bindablePrices(
  prices: BindablePrice[],
  plan: { client_id: string; package_id: string | null } & AgreedPriceRow,
  livemode: boolean,
): BindablePrice[] {
  if (!plan.package_id || plan.agreed_amount_cents == null) return [];
  return prices.filter((p) => {
    const sp = p.stripe_prices;
    return p.package_id === plan.package_id && p.active && (p.client_id == null || p.client_id === plan.client_id)
      && !!sp && sp.active && !sp.deleted_at && sp.livemode === livemode
      && sp.unit_amount_cents === plan.agreed_amount_cents && sp.currency === plan.agreed_currency
      && sp.recurring_interval === plan.agreed_billing_interval && sp.recurring_interval_count === plan.agreed_billing_interval_count;
  });
}
export const externalMethodLabels: Record<string, string> = {
  check: "Check",
  wire: "Wire",
  ach_manual: "ACH received manually",
  other: "Other offline payment",
};
export const intervalLabels: Record<string, string> = { month: "month", year: "year" };

export type AgreementInput = {
  package_id: string | null;
  collection: string | null;
  external_method: string | null;
  external_amount: string | null;
  external_currency: string | null;
  external_interval: string | null;
  term_months: string | null;
  start_date: string | null;
  renewal_date: string | null;
  managed_ad_budget: string | null;
  notes: string | null;
};

export type AgreementRow = {
  package_id: string | null;
  collection: Collection;
  external_method: string | null;
  external_amount_cents: number | null;
  external_currency: string | null;
  external_interval: string | null;
  term_months: number | null;
  start_date: string | null;
  renewal_date: string | null;
  managed_ad_budget_cents: number | null;
  notes: string | null;
  // An external arrangement carries no agreed Stripe price (plans_agreed_terms_stripe_only);
  // a Stripe agreement's price is set apart, by an admin (setAgreedPriceAction).
  agreed_amount_cents?: null;
  agreed_currency?: null;
  agreed_billing_interval?: null;
  agreed_billing_interval_count?: null;
  billing_package_price_id?: null;
};

// The same rules as plans' constraints, with a reason the teammate can act on.
export function validateAgreement(input: AgreementInput): { row: AgreementRow } | { error: string } {
  const collection = (input.collection ?? "stripe") as Collection;
  if (collection !== "stripe" && collection !== "external") return { error: "Choose how the client pays." };
  const term = input.term_months ? Number(input.term_months) : null;
  if (term != null && (!Number.isInteger(term) || term <= 0)) return { error: "Term is a whole number of months." };
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (input.start_date && !date.test(input.start_date)) return { error: "Start date is not a date." };
  if (input.renewal_date && !date.test(input.renewal_date)) return { error: "Renewal date is not a date." };
  if (input.start_date && input.renewal_date && input.renewal_date < input.start_date) {
    return { error: "Renewal date is before the start date." };
  }
  const budget = parseMoneyToCents(input.managed_ad_budget);
  if (budget === "invalid") return { error: "Managed ad budget is not an amount." };

  const row: AgreementRow = {
    package_id: input.package_id || null,
    collection,
    external_method: null,
    external_amount_cents: null,
    external_currency: null,
    external_interval: null,
    term_months: term,
    start_date: input.start_date || null,
    renewal_date: input.renewal_date || null,
    managed_ad_budget_cents: budget,
    notes: input.notes?.trim() || null,
  };
  if (collection === "external") {
    const currency = (input.external_currency || "usd").toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) return { error: "Currency is a three-letter code (usd)." };
    const amount = parseMoneyToCents(input.external_amount, currency);
    if (!input.external_method || !(input.external_method in externalMethodLabels)) {
      return { error: "An external arrangement needs its payment method." };
    }
    if (amount == null || amount === "invalid" || amount <= 0) {
      return { error: "An external arrangement needs the agreed amount." };
    }
    if (!input.external_interval || !(input.external_interval in intervalLabels)) {
      return { error: "An external arrangement is billed per month or per year." };
    }
    Object.assign(row, {
      agreed_amount_cents: null,
      agreed_currency: null,
      agreed_billing_interval: null,
      agreed_billing_interval_count: null,
      billing_package_price_id: null,
      external_method: input.external_method,
      external_amount_cents: amount,
      external_currency: currency,
      external_interval: input.external_interval,
    });
  }
  return { row };
}

// ── Entitlements ───────────────────────────────────────────────────────────
export type Entitlement = {
  service_key: string;
  service_name: string;
  service_kind: "feature" | "quota";
  unit: string | null;
  period: string | null;
  enabled: boolean;
  quantity: number | null;
  source: "package" | "override" | "none";
  package_enabled: boolean | null;
  package_quantity: number | null;
  override_reason: string | null;
};

export function entitlementText(e: Pick<Entitlement, "service_kind" | "enabled" | "quantity" | "unit" | "period">): string {
  if (!e.enabled) return "Not included";
  if (e.service_kind === "feature") return "Included";
  return `${e.quantity ?? 0} ${e.unit ?? ""} / ${e.period ?? "month"}`.replace(/\s+/g, " ");
}

export type OverrideInput = { service_kind: string; enabled: boolean; quantity: string | null; reason: string | null };

// The same rules as client_entitlement_overrides' constraints.
export function validateOverride(input: OverrideInput): { enabled: boolean; quantity: number | null; reason: string } | { error: string } {
  const reason = input.reason?.trim() ?? "";
  if (!reason) return { error: "Say why this client's agreement differs from its package." };
  if (input.service_kind === "feature") return { enabled: input.enabled, quantity: null, reason };
  if (!input.enabled) return { enabled: false, quantity: null, reason };
  const q = input.quantity?.trim() ? Number(input.quantity) : NaN;
  if (!Number.isInteger(q) || q < 0) return { error: "An included quota needs a whole-number quantity." };
  return { enabled: true, quantity: q, reason };
}

// Stripe dashboard links follow the mode of the object they point at.
export function stripeDashboardUrl(kind: "customers" | "subscriptions" | "invoices" | "payments", id: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}${kind}/${id}`;
}
