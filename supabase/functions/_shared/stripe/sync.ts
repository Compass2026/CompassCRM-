// The shared Stripe synchronisation layer (B2). One path from "something
// about this Stripe object may have changed" to the Compass mirror, whatever
// asked: a webhook, reconciliation (B4), linking an existing customer (B3) or
// a manual resync.
//
// It never trusts an event's payload as current state: every sync reads the
// object from Stripe now (fetch-on-event), maps it (map.ts) and hands the
// rows to the database (store.apply → billing_sync_apply, 0059), which
// resolves ownership from the customer link and keeps the newest read. So a
// late, duplicated or reordered event converges on Stripe's present state.
// Deleted objects are the exception: Stripe may no longer return them, so
// their deletion is recorded from the event itself.
//
// Stripe is read, never written, here. Stripe wins.

import type { StripeApi, StripeObject } from "./api.ts";
import { StripeApiError } from "./api.ts";
import {
  checkoutSessionRow, customerRow, idOf, invoiceLineRows, invoicePaymentIntentIds, invoiceRow,
  invoiceSubscriptionId, paymentRow, priceRow, productRow, refundRow, subscriptionItemRows,
  subscriptionRow, ts,
} from "./map.ts";

export type SyncOp = Record<string, unknown>;
export type OpResult = { op: string; id: string | null; result: string };

export type SyncStore = {
  apply(ops: SyncOp[]): Promise<OpResult[]>;
  linkCustomer(p: { client_id: string; link_source: "created" | "linked_existing"; linked_by: string | null; row: Record<string, unknown> }): Promise<unknown>;
};

// The events the webhook endpoint subscribes to: exactly what keeps the
// mirror's objects current (docs/billing.md lists them for the Stripe
// dashboard). Anything else delivered is recorded as ignored.
export const STRIPE_WEBHOOK_EVENTS = [
  "customer.updated",
  "customer.deleted",
  "product.created",
  "product.updated",
  "product.deleted",
  "price.created",
  "price.updated",
  "price.deleted",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "invoice.deleted",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
] as const;

// What a webhook event's sync amounted to, for the ledger.
export function outcome(results: OpResult[]): { status: "processed" } | { status: "ignored"; reason: string } {
  if (results.length === 0) return { status: "ignored", reason: "nothing_to_sync" };
  const r = results.map((x) => x.result);
  if (r.every((x) => x === "unlinked")) return { status: "ignored", reason: "customer_not_linked" };
  if (r.every((x) => x === "unlinked" || x === "mode_mismatch")) return { status: "ignored", reason: "mode_mismatch" };
  if (r.every((x) => x === "missing")) return { status: "ignored", reason: "not_created_by_compass" };
  if (r.every((x) => x === "missing_payment")) return { status: "ignored", reason: "payment_not_mirrored" };
  return { status: "processed" };
}

export function createStripeSync(deps: { api: StripeApi; store: SyncStore; now?: () => Date }) {
  const { api, store } = deps;
  const stamp = () => (deps.now ? deps.now() : new Date()).toISOString();

  async function retrieve(path: string, params?: Record<string, string | number | string[]>): Promise<StripeObject | null> {
    try {
      return await api.get(path, params);
    } catch (e) {
      if (e instanceof StripeApiError && e.missing) return null;
      throw e;
    }
  }

  async function syncProduct(id: string): Promise<OpResult[]> {
    const at = stamp();
    const p = await retrieve(`/v1/products/${id}`);
    if (!p || p.deleted) return store.apply([{ op: "deleted", object: "product", id, at }]);
    return store.apply([{ op: "product", row: productRow(p, at) }]);
  }

  async function syncPrice(id: string): Promise<OpResult[]> {
    const at = stamp();
    const pr = await retrieve(`/v1/prices/${id}`, { expand: ["product"] });
    if (!pr || pr.deleted) return store.apply([{ op: "deleted", object: "price", id, at }]);
    const ops: SyncOp[] = [];
    if (pr.product && typeof pr.product === "object" && !pr.product.deleted) ops.push({ op: "product", row: productRow(pr.product, at) });
    ops.push({ op: "price", row: priceRow(pr, at) });
    return store.apply(ops);
  }

  // A product and every price on it, read now: importing a Stripe Product
  // into the Compass catalog (B3) and reconciling the catalog (B4).
  async function syncProductWithPrices(id: string): Promise<OpResult[]> {
    const at = stamp();
    const p = await retrieve(`/v1/products/${id}`);
    if (!p || p.deleted) return store.apply([{ op: "deleted", object: "product", id, at }]);
    const prices = await api.list("/v1/prices", { product: id });
    return store.apply([{ op: "product", row: productRow(p, at) }, ...prices.map((pr) => ({ op: "price", row: priceRow(pr, at) }))]);
  }

  async function syncCustomer(id: string): Promise<OpResult[]> {
    const at = stamp();
    const c = await retrieve(`/v1/customers/${id}`, { expand: ["invoice_settings.default_payment_method"] });
    if (!c || c.deleted) return store.apply([{ op: "deleted", object: "customer", id, at }]);
    return store.apply([{ op: "customer", row: customerRow(c, at) }]);
  }

  // The subscription with its items, and the products / prices they use (the
  // mirror's foreign keys need them first; they are current as of this read).
  async function syncSubscription(id: string): Promise<OpResult[]> {
    const at = stamp();
    const s = await api.get(`/v1/subscriptions/${id}`, { expand: ["items.data.price.product", "default_payment_method"] });
    const ops: SyncOp[] = [];
    const seen = new Set<string>();
    for (const item of s.items?.data ?? []) {
      const pr = item.price;
      if (!pr || typeof pr !== "object") continue;
      if (pr.product && typeof pr.product === "object" && !seen.has(pr.product.id)) {
        seen.add(pr.product.id);
        ops.push({ op: "product", row: productRow(pr.product, at) });
      }
      if (!seen.has(pr.id)) {
        seen.add(pr.id);
        ops.push({ op: "price", row: priceRow(pr, at) });
      }
    }
    ops.push({ op: "subscription", row: subscriptionRow(s, at), items: subscriptionItemRows(s, at) });
    return store.apply(ops);
  }

  // A PaymentIntent, its latest charge and every refund against it.
  async function syncPaymentIntent(id: string, invoiceId?: string | null): Promise<OpResult[]> {
    const at = stamp();
    const pi = await api.get(`/v1/payment_intents/${id}`, { expand: ["latest_charge"] });
    const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const ops: SyncOp[] = [{ op: "payment", row: paymentRow(pi, charge, at, invoiceId) }];
    const refunds = await api.list("/v1/refunds", { payment_intent: id });
    for (const r of refunds) ops.push({ op: "refund", row: refundRow(r, pi.livemode, at) });
    return store.apply(ops);
  }

  async function syncInvoice(id: string): Promise<OpResult[]> {
    const at = stamp();
    const inv = await retrieve(`/v1/invoices/${id}`, { expand: ["payments"] });
    if (!inv) return store.apply([{ op: "delete_invoice", id }]);
    const results: OpResult[] = [];
    const subId = invoiceSubscriptionId(inv);
    if (subId) results.push(...await syncSubscription(subId));
    const lines = await api.list(`/v1/invoices/${id}/lines`);
    results.push(...await store.apply([{ op: "invoice", row: invoiceRow(inv, at), lines: invoiceLineRows(lines, at) }]));
    for (const pi of invoicePaymentIntentIds(inv)) results.push(...await syncPaymentIntent(pi, id));
    return results;
  }

  async function syncCharge(id: string): Promise<OpResult[]> {
    const charge = await api.get(`/v1/charges/${id}`);
    const pi = idOf(charge.payment_intent);
    return pi ? syncPaymentIntent(pi) : [{ op: "charge", id, result: "no_payment_intent" }];
  }

  async function syncRefund(id: string): Promise<OpResult[]> {
    const r = await api.get(`/v1/refunds/${id}`);
    let pi = idOf(r.payment_intent);
    if (!pi && r.charge) pi = idOf((await api.get(`/v1/charges/${idOf(r.charge)}`)).payment_intent);
    return pi ? syncPaymentIntent(pi) : [{ op: "refund", id, result: "no_payment_intent" }];
  }

  // Only sessions Compass created are mirrored (B3 records them); whatever a
  // completed session produced is synced either way, since it belongs to a
  // customer Compass may have linked.
  async function syncCheckoutSession(id: string): Promise<OpResult[]> {
    const at = stamp();
    const cs = await api.get(`/v1/checkout/sessions/${id}`);
    const results = await store.apply([{ op: "checkout_session", row: checkoutSessionRow(cs, at) }]);
    const sub = idOf(cs.subscription);
    const inv = idOf(cs.invoice);
    const pi = idOf(cs.payment_intent);
    if (sub) results.push(...await syncSubscription(sub));
    if (inv) results.push(...await syncInvoice(inv));
    else if (pi) results.push(...await syncPaymentIntent(pi));
    return results;
  }

  // Everything Stripe holds for one customer, read now: the resync behind
  // linking an existing customer, reconciliation (B4) and a manual resync.
  // Every list is paginated by the API client.
  async function resyncCustomer(customerId: string): Promise<OpResult[]> {
    const results = await syncCustomer(customerId);
    // Deleted (or gone) in Stripe: recorded as deleted; there is nothing more to list.
    if (results.some((r) => r.op === "deleted")) return results;
    for (const s of await api.list("/v1/subscriptions", { customer: customerId, status: "all" })) {
      results.push(...await syncSubscription(s.id));
    }
    const invoiced = new Set<string>();
    for (const inv of await api.list("/v1/invoices", { customer: customerId })) {
      const r = await syncInvoice(inv.id);
      results.push(...r);
      for (const x of r) if (x.op === "payment" && x.id) invoiced.add(x.id);
    }
    for (const pi of await api.list("/v1/payment_intents", { customer: customerId })) {
      if (!invoiced.has(pi.id)) results.push(...await syncPaymentIntent(pi.id));
    }
    return results;
  }

  // Link a Stripe customer to a client (created by Compass, or an existing
  // one a teammate chose), then import what Stripe already holds for it.
  async function linkCustomer(p: { clientId: string; customerId: string; linkSource: "created" | "linked_existing"; linkedBy: string | null }) {
    const at = stamp();
    const c = await api.get(`/v1/customers/${p.customerId}`, { expand: ["invoice_settings.default_payment_method"] });
    if (c.deleted) throw new Error(`Stripe customer ${p.customerId} is deleted`);
    if ((api.mode === "live") !== !!c.livemode) throw new Error(`Stripe customer ${p.customerId} is not in ${api.mode} mode`);
    await store.linkCustomer({ client_id: p.clientId, link_source: p.linkSource, linked_by: p.linkedBy, row: customerRow(c, at) });
    return resyncCustomer(p.customerId);
  }

  // A webhook event: the object it names, read now. null when the event is
  // not about an object the mirror keeps.
  async function syncEvent(event: StripeObject): Promise<OpResult[] | null> {
    const obj = event.data?.object ?? {};
    const id: string = obj.id;
    const at = ts(event.created) ?? stamp();
    switch (obj.object) {
      case "customer":
        return event.type === "customer.deleted"
          ? store.apply([{ op: "deleted", object: "customer", id, at }])
          : syncCustomer(id);
      case "product":
        return event.type === "product.deleted"
          ? store.apply([{ op: "deleted", object: "product", id, at }])
          : syncProduct(id);
      case "price":
        return event.type === "price.deleted"
          ? store.apply([{ op: "deleted", object: "price", id, at }])
          : syncPrice(id);
      case "subscription":
        return syncSubscription(id);
      case "invoice":
        return event.type === "invoice.deleted" ? store.apply([{ op: "delete_invoice", id }]) : syncInvoice(id);
      case "payment_intent":
        return syncPaymentIntent(id);
      case "charge":
        return syncCharge(id);
      case "refund":
        return syncRefund(id);
      case "checkout.session":
        return syncCheckoutSession(id);
      default:
        return null;
    }
  }

  return {
    syncEvent, syncProduct, syncProductWithPrices, syncPrice, syncCustomer, syncSubscription, syncInvoice, syncPaymentIntent,
    syncCharge, syncRefund, syncCheckoutSession, resyncCustomer, linkCustomer,
  };
}
