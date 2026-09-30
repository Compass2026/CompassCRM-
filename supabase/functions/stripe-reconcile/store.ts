// stripe-reconcile's door to the database: supabase-js with the service role
// (authenticator + service_role through PostgREST, the session 0058 / 0060
// admit). It extends the stripe-billing store (the caller lookup, secrets, the
// shared sync writes and the webhook ledger) with the reads reconciliation
// needs and the three run functions of 0060. The mirror is written only by
// billing_sync_apply; run history only by billing_reconcile_*.

import type { LedgerEvent } from "../_shared/stripe/store.ts";
import { BillingDbError, type BillingStore, createBillingStore } from "../stripe-billing/store.ts";
import type { Fingerprint } from "./engine.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type LinkedCustomer = { client_id: string; stripe_customer_id: string };
export type RunInput = { livemode: boolean; trigger: "schedule" | "admin" | "admin_client"; requested_by: string | null; scope_client_id: string | null };

export type ReconcileStore = BillingStore & {
  beginRun(p: RunInput): Promise<{ id: string }>;
  recordClient(p: Record<string, unknown>): Promise<void>;
  finishRun(p: Record<string, unknown>): Promise<void>;
  fingerprint(clientId: string, livemode: boolean): Promise<Fingerprint>;
  catalogFingerprint(livemode: boolean): Promise<Fingerprint>;
  linkedCustomers(livemode: boolean, clientId: string | null): Promise<LinkedCustomer[]>;
  mappedProducts(livemode: boolean): Promise<string[]>;
  catalogWarnings(livemode: boolean): Promise<{ code: string; detail?: string }[]>;
  recoverableEvents(livemode: boolean, limit: number): Promise<LedgerEvent[]>;
  mirrorInvoiceIds(clientId: string, customerId: string, livemode: boolean): Promise<string[]>;
  pendingCheckouts(clientId: string, livemode: boolean): Promise<string[]>;
  attention(clientId: string): Promise<string[]>;
};

export function createReconcileStore(supabase: Client): ReconcileStore {
  const base = createBillingStore(supabase);
  const fail = (error: { code?: string; message: string }): never => {
    throw new BillingDbError(error.code ?? null, error.message);
  };
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(name, args);
    if (error) fail(error);
    return data as T;
  }
  async function rows<T>(q: Promise<{ data: T[] | null; error: { code?: string; message: string } | null }>): Promise<T[]> {
    const { data, error } = await q;
    if (error) fail(error);
    return data ?? [];
  }

  return {
    ...base,
    beginRun: (p) => rpc("billing_reconcile_begin", { p }),
    recordClient: (p) => rpc("billing_reconcile_client", { p }),
    finishRun: (p) => rpc("billing_reconcile_finish", { p }),
    fingerprint: (clientId, livemode) => rpc("billing_mirror_fingerprint", { p_client: clientId, p_livemode: livemode }),
    catalogFingerprint: (livemode) => rpc("billing_catalog_fingerprint", { p_livemode: livemode }),

    // Active links in the mode, the least recently reconciled first (never
    // reconciled before all), so a run cut short by its time budget is
    // continued by the next one.
    async linkedCustomers(livemode, clientId) {
      let q = supabase.from("stripe_customers").select("client_id, stripe_customer_id")
        .eq("livemode", livemode).is("unlinked_at", null).is("deleted_at", null);
      if (clientId) q = q.eq("client_id", clientId);
      const links = await rows<LinkedCustomer>(q);
      const last = await rows<{ client_id: string; checked_at: string }>(
        supabase.from("client_billing_reconciliation").select("client_id, checked_at"));
      const at = new Map(last.map((r) => [r.client_id, r.checked_at]));
      return links.sort((a, b) => (at.get(a.client_id) ?? "").localeCompare(at.get(b.client_id) ?? ""));
    },

    // Stripe Products the catalog maps (packages, one-time items), in the mode.
    async mappedProducts(livemode) {
      const pk = await rows<{ stripe_product_id: string | null }>(supabase.from("billing_packages").select("stripe_product_id").not("stripe_product_id", "is", null));
      const it = await rows<{ stripe_product_id: string | null }>(supabase.from("billing_one_time_items").select("stripe_product_id").not("stripe_product_id", "is", null));
      const ids = [...new Set([...pk, ...it].map((r) => r.stripe_product_id!).filter(Boolean))];
      if (ids.length === 0) return [];
      const inMode = await rows<{ stripe_product_id: string }>(
        supabase.from("stripe_products").select("stripe_product_id").in("stripe_product_id", ids).eq("livemode", livemode));
      return inMode.map((r) => r.stripe_product_id).sort();
    },

    // What an admin should look at after the catalog was re-read: a mapped
    // Product archived or deleted in Stripe, an approved Price archived, and a
    // mapping to an object of the other mode. Nothing is unmapped automatically.
    async catalogWarnings(livemode) {
      const out: { code: string; detail?: string }[] = [];
      const pk = await rows<{ name: string; stripe_product_id: string | null; stripe_products: { active: boolean; livemode: boolean; deleted_at: string | null } | null }>(
        supabase.from("billing_packages").select("name, stripe_product_id, stripe_products(active, livemode, deleted_at)").eq("active", true).not("stripe_product_id", "is", null));
      for (const p of pk) {
        if (!p.stripe_products) continue;
        if (p.stripe_products.livemode !== livemode) out.push({ code: "catalog_product_other_mode", detail: `${p.name}: ${p.stripe_product_id}` });
        else if (!p.stripe_products.active || p.stripe_products.deleted_at) out.push({ code: "catalog_product_archived", detail: `${p.name}: ${p.stripe_product_id}` });
      }
      const pr = await rows<{ stripe_price_id: string; billing_packages: { name: string } | null; stripe_prices: { active: boolean; livemode: boolean; deleted_at: string | null } | null }>(
        supabase.from("billing_package_prices").select("stripe_price_id, billing_packages(name), stripe_prices(active, livemode, deleted_at)").eq("active", true));
      for (const p of pr) {
        if (p.stripe_prices && p.stripe_prices.livemode === livemode && (!p.stripe_prices.active || p.stripe_prices.deleted_at)) {
          out.push({ code: "catalog_price_archived", detail: `${p.billing_packages?.name ?? "package"}: ${p.stripe_price_id}` });
        }
      }
      return out;
    },

    // Failed events, and events whose processing lease expired, in the mode.
    recoverableEvents(livemode, limit) {
      return rows<LedgerEvent>(supabase.from("stripe_events")
        .select("id, type, livemode, api_version, event_created_at, object_type, object_id")
        .eq("livemode", livemode)
        .or(`status.eq.failed,and(status.eq.processing,lease_expires_at.lt.${new Date().toISOString()})`)
        .order("received_at", { ascending: true }).limit(limit));
    },

    async mirrorInvoiceIds(clientId, customerId, livemode) {
      const r = await rows<{ stripe_invoice_id: string }>(supabase.from("invoices").select("stripe_invoice_id")
        .eq("client_id", clientId).eq("stripe_customer_id", customerId).eq("livemode", livemode));
      return r.map((x) => x.stripe_invoice_id);
    },

    // Open sessions (whatever their expiry says locally: Stripe decides), and
    // completed ones whose payment is still settling (ACH).
    async pendingCheckouts(clientId, livemode) {
      const r = await rows<{ stripe_checkout_session_id: string }>(supabase.from("checkout_sessions").select("stripe_checkout_session_id")
        .eq("client_id", clientId).eq("livemode", livemode)
        .or("status.eq.open,and(status.eq.complete,payment_status.eq.unpaid)"));
      return r.map((x) => x.stripe_checkout_session_id);
    },

    async attention(clientId) {
      const r = await rows<{ attention_reasons: string[] | null }>(
        supabase.from("client_billing_status").select("attention_reasons").eq("client_id", clientId));
      return r[0]?.attention_reasons ?? [];
    },
  };
}
