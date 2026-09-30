// Stripe object → Compass mirror row (0058 / 0059). Pure; the one place a
// Stripe shape is read, so the webhook, reconciliation, customer linking and
// a manual resync all map an object the same way.
//
// Shapes are read at the pinned API version (api.ts) with the older field
// locations as fallbacks, because Stripe moved several of them in 2025
// ("basil"): the subscription period onto its items, invoice.subscription to
// invoice.parent.subscription_details, a line's price to line.pricing, and
// invoice.payment_intent to invoice.payments.
//
// A key the object does not carry is left out of the row (never written as
// null), so a partial view never erases what a fuller one recorded. Every row
// carries stripe_synced_at: when the object was read from Stripe.

import type { StripeObject } from "./api.ts";

export type Row = Record<string, unknown>;

export const ts = (secs: number | null | undefined): string | null =>
  secs == null ? null : new Date(secs * 1000).toISOString();

export const idOf = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : ((v as StripeObject).id ?? null);

// Drop undefined keys (unknown in this shape); keep explicit nulls (Stripe said none).
function clean(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

function methodType(t: unknown): "card" | "us_bank_account" | "other" | null {
  if (t == null) return null;
  return t === "card" || t === "us_bank_account" ? t : "other";
}

export function productRow(p: StripeObject, syncedAt: string): Row {
  return clean({
    stripe_product_id: p.id,
    livemode: p.livemode,
    name: p.name,
    description: p.description ?? null,
    active: p.active,
    metadata: p.metadata ?? {},
    stripe_created_at: ts(p.created),
    stripe_synced_at: syncedAt,
  });
}

export function priceRow(pr: StripeObject, syncedAt: string): Row {
  const rec = pr.recurring ?? null;
  return clean({
    stripe_price_id: pr.id,
    stripe_product_id: idOf(pr.product),
    livemode: pr.livemode,
    active: pr.active,
    type: pr.type,
    currency: pr.currency,
    unit_amount_cents: pr.unit_amount ?? null,
    billing_scheme: pr.billing_scheme ?? "per_unit",
    recurring_interval: rec?.interval ?? null,
    recurring_interval_count: rec?.interval_count ?? null,
    recurring_usage_type: rec?.usage_type ?? null,
    nickname: pr.nickname ?? null,
    lookup_key: pr.lookup_key ?? null,
    tax_behavior: pr.tax_behavior ?? null,
    metadata: pr.metadata ?? {},
    stripe_created_at: ts(pr.created),
    stripe_synced_at: syncedAt,
  });
}

// The customer as the link row stores it. The default payment method is
// summarised only when Stripe expanded it (invoice_settings.default_payment_method).
export function customerRow(c: StripeObject, syncedAt: string): Row {
  const pm = c.invoice_settings?.default_payment_method;
  const pmObj = pm && typeof pm === "object" ? pm : null;
  return clean({
    stripe_customer_id: c.id,
    livemode: c.livemode,
    email: c.email ?? null,
    name: c.name ?? null,
    currency: c.currency ?? null,
    default_payment_method_type: pmObj ? methodType(pmObj.type) : undefined,
    default_payment_method_brand: pmObj ? (pmObj.card?.brand ?? pmObj.us_bank_account?.bank_name ?? null) : undefined,
    default_payment_method_last4: pmObj ? (pmObj.card?.last4 ?? pmObj.us_bank_account?.last4 ?? null) : undefined,
    metadata: c.metadata ?? {},
    stripe_created_at: ts(c.created),
    stripe_synced_at: syncedAt,
  });
}

export function subscriptionRow(s: StripeObject, syncedAt: string): Row {
  const first = s.items?.data?.[0] ?? {};
  const pm = s.default_payment_method;
  return clean({
    stripe_subscription_id: s.id,
    stripe_customer_id: idOf(s.customer),
    livemode: s.livemode,
    status: s.status,
    collection_method: s.collection_method,
    currency: s.currency,
    cancel_at_period_end: !!s.cancel_at_period_end,
    cancel_at: ts(s.cancel_at),
    canceled_at: ts(s.canceled_at),
    ended_at: ts(s.ended_at),
    cancellation_reason: s.cancellation_details?.reason ?? null,
    cancellation_feedback: s.cancellation_details?.feedback ?? null,
    cancellation_comment: s.cancellation_details?.comment ?? null,
    pause_collection_behavior: s.pause_collection?.behavior ?? null,
    pause_collection_resumes_at: ts(s.pause_collection?.resumes_at),
    trial_start: ts(s.trial_start),
    trial_end: ts(s.trial_end),
    start_date: ts(s.start_date),
    billing_cycle_anchor: ts(s.billing_cycle_anchor),
    current_period_start: ts(s.current_period_start ?? first.current_period_start),
    current_period_end: ts(s.current_period_end ?? first.current_period_end),
    days_until_due: s.days_until_due ?? null,
    latest_stripe_invoice_id: idOf(s.latest_invoice),
    default_payment_method_type: pm && typeof pm === "object" ? methodType(pm.type) : undefined,
    metadata: s.metadata ?? {},
    stripe_created_at: ts(s.created),
    stripe_synced_at: syncedAt,
  });
}

export function subscriptionItemRows(s: StripeObject, syncedAt: string): Row[] {
  return (s.items?.data ?? []).map((i: StripeObject) => clean({
    stripe_subscription_item_id: i.id,
    stripe_price_id: idOf(i.price),
    quantity: i.quantity ?? null,
    stripe_created_at: ts(i.created),
    stripe_synced_at: syncedAt,
  }));
}

export function invoiceSubscriptionId(inv: StripeObject): string | null {
  return idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription);
}

export function invoiceRow(inv: StripeObject, syncedAt: string): Row {
  const tr = inv.status_transitions ?? {};
  return clean({
    stripe_invoice_id: inv.id,
    stripe_customer_id: idOf(inv.customer),
    stripe_subscription_id: invoiceSubscriptionId(inv),
    livemode: inv.livemode,
    number: inv.number ?? null,
    status: inv.status,
    billing_reason: inv.billing_reason ?? null,
    collection_method: inv.collection_method,
    currency: inv.currency,
    subtotal_cents: inv.subtotal,
    total_cents: inv.total,
    amount_due_cents: inv.amount_due,
    amount_paid_cents: inv.amount_paid,
    amount_remaining_cents: inv.amount_remaining,
    attempt_count: inv.attempt_count ?? 0,
    attempted: !!inv.attempted,
    next_payment_attempt: ts(inv.next_payment_attempt),
    due_date: ts(inv.due_date),
    period_start: ts(inv.period_start),
    period_end: ts(inv.period_end),
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    paid_out_of_band: !!inv.paid_out_of_band,
    stripe_created_at: ts(inv.created),
    finalized_at: ts(tr.finalized_at),
    paid_at: ts(tr.paid_at),
    voided_at: ts(tr.voided_at),
    marked_uncollectible_at: ts(tr.marked_uncollectible_at),
    stripe_synced_at: syncedAt,
  });
}

export function invoiceLineRows(lines: StripeObject[], syncedAt: string): Row[] {
  return lines.map((l) => {
    const details = l.pricing?.price_details ?? {};
    const sub = l.parent?.subscription_item_details ?? null;
    const item = l.parent?.invoice_item_details ?? null;
    return clean({
      stripe_line_item_id: l.id,
      stripe_price_id: idOf(l.price) ?? idOf(details.price),
      stripe_product_id: idOf(l.price?.product) ?? idOf(details.product),
      stripe_subscription_item_id: idOf(l.subscription_item) ?? idOf(sub?.subscription_item),
      description: l.description ?? null,
      quantity: l.quantity ?? null,
      amount_cents: l.amount,
      currency: l.currency,
      period_start: ts(l.period?.start),
      period_end: ts(l.period?.end),
      proration: !!(l.proration ?? sub?.proration ?? item?.proration ?? false),
      stripe_synced_at: syncedAt,
    });
  });
}

// The PaymentIntents an invoice was paid with (basil: invoice.payments; older:
// invoice.payment_intent).
export function invoicePaymentIntentIds(inv: StripeObject): string[] {
  const ids = new Set<string>();
  const legacy = idOf(inv.payment_intent);
  if (legacy) ids.add(legacy);
  for (const p of inv.payments?.data ?? []) {
    const pi = idOf(p.payment?.payment_intent);
    if (pi) ids.add(pi);
  }
  return [...ids];
}

// A PaymentIntent and its latest charge (expanded). invoiceId is added only
// when the caller knows it (the PI itself no longer names its invoice).
export function paymentRow(pi: StripeObject, charge: StripeObject | null, syncedAt: string, invoiceId?: string | null): Row {
  const err = pi.last_payment_error ?? null;
  return clean({
    stripe_payment_intent_id: pi.id,
    stripe_charge_id: charge?.id ?? idOf(pi.latest_charge),
    stripe_customer_id: idOf(pi.customer),
    stripe_invoice_id: invoiceId ?? undefined,
    livemode: pi.livemode,
    status: pi.status,
    payment_method_type: methodType(charge?.payment_method_details?.type ?? pi.payment_method_types?.[0]),
    failure_code: err?.code ?? charge?.failure_code ?? null,
    failure_message: err?.message ?? charge?.failure_message ?? null,
    amount_cents: pi.amount,
    amount_refunded_cents: charge?.amount_refunded ?? 0,
    currency: pi.currency,
    paid_at: pi.status === "succeeded" ? ts(charge?.created ?? pi.created) : null,
    stripe_created_at: ts(pi.created),
    stripe_synced_at: syncedAt,
  });
}

// A Refund carries no livemode of its own: it takes its PaymentIntent's.
export function refundRow(r: StripeObject, livemode: boolean, syncedAt: string): Row {
  return clean({
    stripe_refund_id: r.id,
    stripe_payment_intent_id: idOf(r.payment_intent),
    stripe_charge_id: idOf(r.charge),
    livemode: r.livemode ?? livemode,
    amount_cents: r.amount,
    currency: r.currency,
    status: r.status,
    reason: r.reason ?? null,
    failure_reason: r.failure_reason ?? null,
    stripe_created_at: ts(r.created),
    stripe_synced_at: syncedAt,
  });
}

export function checkoutSessionRow(cs: StripeObject, syncedAt: string): Row {
  return clean({
    stripe_checkout_session_id: cs.id,
    stripe_customer_id: idOf(cs.customer) ?? undefined,
    livemode: cs.livemode ?? undefined,
    mode: cs.mode ?? undefined,
    stripe_created_at: ts(cs.created) ?? undefined,
    status: cs.status,
    payment_status: cs.payment_status ?? null,
    url: cs.status === "open" ? (cs.url ?? null) : null,
    expires_at: ts(cs.expires_at),
    stripe_subscription_id: idOf(cs.subscription),
    stripe_invoice_id: idOf(cs.invoice),
    stripe_payment_intent_id: idOf(cs.payment_intent),
    stripe_synced_at: syncedAt,
  });
}
