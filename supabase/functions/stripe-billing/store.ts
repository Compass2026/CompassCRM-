// stripe-billing's door to the database: supabase-js with the service role,
// so every call reaches Postgres through PostgREST as authenticator +
// service_role. The Stripe mirror and the billing records are written only
// through the billing functions (0058 sync, 0059 operations), never directly;
// the catalog's Stripe mapping (a package's product, a client's custom price)
// is written here only after the handler has checked the caller is an admin.
// Reads are ordinary selects.

import { createStripeStore, type StripeStore } from "../_shared/stripe/store.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type Caller =
  | { kind: "team"; memberId: string; role: "admin" | "member" }
  | { kind: "portal"; portalUserId: string; clientId: string };

export type CatalogTarget = "package" | "one_time_item";
export type CatalogEntry = {
  id: string;
  name: string;
  kind: "standard" | "custom" | null; // null for a one-time item
  active: boolean;
  stripe_product_id: string | null;
  mapped_prices: number;
};
export type PackagePrice = {
  id: string;
  package_id: string;
  package_kind: string;
  package_active: boolean;
  stripe_product_id: string;
  stripe_price_id: string;
  client_id: string | null;
  active: boolean;
};
export type PriceMirror = {
  active: boolean;
  type: string;
  livemode: boolean;
  deleted_at: string | null;
  unit_amount_cents: number | null;
  currency: string;
  recurring_interval: string | null;
  recurring_interval_count: number | null;
  recurring_usage_type: string | null;
};
export type AuditInput = {
  client_id: string | null;
  action: string;
  actor_kind: "team" | "portal";
  actor_team_member_id?: string | null;
  actor_portal_user_id?: string | null;
  livemode?: boolean | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
};

// A database refusal keeps its SQLSTATE so the handler can answer 403 / 409.
export class BillingDbError extends Error {
  code: string | null;
  constructor(code: string | null, message: string) {
    super(message);
    this.code = code;
  }
}

export type BillingStore = StripeStore & {
  caller(jwt: string): Promise<"none" | Caller | null>;
  client(id: string): Promise<{ id: string; name: string; status: string } | null>;
  plan(clientId: string): Promise<{ package_id: string | null; collection: string } | null>;
  activeLink(clientId: string, livemode: boolean): Promise<{ stripe_customer_id: string } | null>;
  linkOf(customerId: string): Promise<{ client_id: string; client_name: string; active: boolean } | null>;
  linksOf(customerIds: string[]): Promise<{ stripe_customer_id: string; client_id: string; client_name: string; active: boolean }[]>;
  linkCount(clientId: string, livemode: boolean): Promise<number>;
  catalogEntry(target: CatalogTarget, id: string): Promise<CatalogEntry | null>;
  productOwner(productId: string): Promise<{ target: CatalogTarget; id: string; name: string } | null>;
  productMirror(productId: string): Promise<{ livemode: boolean; active: boolean } | null>;
  setProduct(target: CatalogTarget, id: string, productId: string): Promise<void>;
  packagePrice(id: string): Promise<PackagePrice | null>;
  priceMirror(priceId: string): Promise<PriceMirror | null>;
  mapClientPrice(row: { package_id: string; package_kind: "custom"; stripe_product_id: string; stripe_price_id: string; client_id: string; notes: string | null }): Promise<{ id: string; created: boolean }>;
  blockingSubscriptions(clientId: string, livemode: boolean): Promise<{ stripe_subscription_id: string; status: string }[]>;
  openCheckouts(clientId: string, livemode: boolean): Promise<{ stripe_checkout_session_id: string; expires_at: string; request_id: string | null }[]>;
  checkout(sessionId: string): Promise<{ client_id: string; status: string; livemode: boolean } | null>;
  checkoutSummary(sessionId: string): Promise<Record<string, unknown> | null>;
  recordCheckout(p: Record<string, unknown>): Promise<{ id: string; created: boolean }>;
  recordExternalPayment(p: Record<string, unknown>): Promise<{ id: string; created: boolean }>;
  voidExternalPayment(p: Record<string, unknown>): Promise<{ id: string; voided: boolean } | null>;
  audit(p: AuditInput): Promise<string>;
  // deno-lint-ignore no-explicit-any
  setting(key: string): Promise<Record<string, any> | null>;
  saveSetting(key: string, value: Record<string, unknown>): Promise<void>;
};

// Stripe states that are billing the client (see handler.ts).
const BLOCKING = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

export function createBillingStore(supabase: Client): BillingStore {
  const base = createStripeStore(supabase);
  const fail = (error: { code?: string; message: string }): never => {
    throw new BillingDbError(error.code ?? null, error.message);
  };
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(name, args);
    if (error) fail(error);
    return data as T;
  }
  async function maybe<T>(q: Promise<{ data: T | null; error: { code?: string; message: string } | null }>): Promise<T | null> {
    const { data, error } = await q;
    if (error) fail(error);
    return data ?? null;
  }

  return {
    ...base,

    // "none": no or invalid JWT. null: signed in, but neither on the team
    // nor an active portal contact.
    async caller(jwt) {
      if (!jwt) return "none";
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return "none";
      const m = await maybe<{ id: string; role: string }>(
        supabase.from("team_members").select("id, role").eq("auth_user_id", data.user.id).maybeSingle());
      if (m) return { kind: "team", memberId: m.id, role: m.role === "admin" ? "admin" : "member" };
      const p = await maybe<{ id: string; client_id: string }>(
        supabase.from("portal_users").select("id, client_id").eq("auth_user_id", data.user.id).eq("is_active", true).maybeSingle());
      return p ? { kind: "portal", portalUserId: p.id, clientId: p.client_id } : null;
    },

    client: (id) => maybe(supabase.from("clients").select("id, name, status").eq("id", id).maybeSingle()),
    plan: (clientId) => maybe(supabase.from("plans").select("package_id, collection").eq("client_id", clientId).maybeSingle()),

    activeLink: (clientId, livemode) =>
      maybe(supabase.from("stripe_customers").select("stripe_customer_id").eq("client_id", clientId).eq("livemode", livemode)
        .is("unlinked_at", null).is("deleted_at", null).maybeSingle()),

    async linkOf(customerId) {
      const r = await maybe<{ client_id: string; unlinked_at: string | null; deleted_at: string | null; clients: { name: string } }>(
        supabase.from("stripe_customers").select("client_id, unlinked_at, deleted_at, clients(name)").eq("stripe_customer_id", customerId).maybeSingle());
      return r ? { client_id: r.client_id, client_name: r.clients?.name ?? "", active: !r.unlinked_at && !r.deleted_at } : null;
    },

    async linksOf(customerIds) {
      if (customerIds.length === 0) return [];
      const { data, error } = await supabase.from("stripe_customers")
        .select("stripe_customer_id, client_id, unlinked_at, deleted_at, clients(name)").in("stripe_customer_id", customerIds);
      if (error) fail(error);
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map((r: any) => ({
        stripe_customer_id: r.stripe_customer_id, client_id: r.client_id, client_name: r.clients?.name ?? "",
        active: !r.unlinked_at && !r.deleted_at,
      }));
    },

    async linkCount(clientId, livemode) {
      const { count, error } = await supabase.from("stripe_customers").select("id", { count: "exact", head: true })
        .eq("client_id", clientId).eq("livemode", livemode);
      if (error) fail(error);
      return count ?? 0;
    },

    async catalogEntry(target, id) {
      if (target === "package") {
        const r = await maybe<{ id: string; name: string; kind: "standard" | "custom"; active: boolean; stripe_product_id: string | null }>(
          supabase.from("billing_packages").select("id, name, kind, active, stripe_product_id").eq("id", id).maybeSingle());
        if (!r) return null;
        const { count, error } = await supabase.from("billing_package_prices").select("id", { count: "exact", head: true }).eq("package_id", id);
        if (error) fail(error);
        return { ...r, mapped_prices: count ?? 0 };
      }
      const r = await maybe<{ id: string; name: string; active: boolean; stripe_product_id: string | null }>(
        supabase.from("billing_one_time_items").select("id, name, active, stripe_product_id").eq("id", id).maybeSingle());
      return r ? { ...r, kind: null, mapped_prices: 0 } : null;
    },

    async productOwner(productId) {
      const p = await maybe<{ id: string; name: string }>(supabase.from("billing_packages").select("id, name").eq("stripe_product_id", productId).maybeSingle());
      if (p) return { target: "package", ...p };
      const o = await maybe<{ id: string; name: string }>(supabase.from("billing_one_time_items").select("id, name").eq("stripe_product_id", productId).maybeSingle());
      return o ? { target: "one_time_item", ...o } : null;
    },

    productMirror: (productId) =>
      maybe(supabase.from("stripe_products").select("livemode, active").eq("stripe_product_id", productId).is("deleted_at", null).maybeSingle()),

    async setProduct(target, id, productId) {
      const table = target === "package" ? "billing_packages" : "billing_one_time_items";
      const { error } = await supabase.from(table).update({ stripe_product_id: productId }).eq("id", id);
      if (error) fail(error);
    },

    async packagePrice(id) {
      // deno-lint-ignore no-explicit-any
      const r = await maybe<any>(supabase.from("billing_package_prices")
        .select("id, package_id, package_kind, stripe_product_id, stripe_price_id, client_id, active, billing_packages(active)")
        .eq("id", id).maybeSingle());
      return r ? { ...r, package_active: !!r.billing_packages?.active, billing_packages: undefined } : null;
    },

    priceMirror: (priceId) =>
      maybe(supabase.from("stripe_prices").select("active, type, livemode, deleted_at, unit_amount_cents, currency, recurring_interval, recurring_interval_count, recurring_usage_type")
        .eq("stripe_price_id", priceId).maybeSingle()),

    async mapClientPrice(row) {
      const { data, error } = await supabase.from("billing_package_prices")
        .upsert({ ...row, is_default: false, active: true }, { onConflict: "stripe_price_id", ignoreDuplicates: true }).select("id");
      if (error) fail(error);
      if (data?.length) return { id: data[0].id, created: true };
      const existing = await maybe<{ id: string; client_id: string | null }>(
        supabase.from("billing_package_prices").select("id, client_id").eq("stripe_price_id", row.stripe_price_id).maybeSingle());
      if (!existing || existing.client_id !== row.client_id) throw new BillingDbError("23505", "That Stripe price is mapped to another client.");
      return { id: existing.id, created: false };
    },

    async blockingSubscriptions(clientId, livemode) {
      const { data, error } = await supabase.from("subscriptions").select("stripe_subscription_id, status")
        .eq("client_id", clientId).eq("livemode", livemode).in("status", BLOCKING);
      if (error) fail(error);
      return data ?? [];
    },

    async openCheckouts(clientId, livemode) {
      const { data, error } = await supabase.from("checkout_sessions").select("stripe_checkout_session_id, expires_at, line_items")
        .eq("client_id", clientId).eq("livemode", livemode).eq("status", "open").order("created_at", { ascending: false });
      if (error) fail(error);
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map((r: any) => ({
        stripe_checkout_session_id: r.stripe_checkout_session_id, expires_at: r.expires_at,
        request_id: r.line_items?.[0]?.request_id ?? null,
      }));
    },

    checkout: (sessionId) =>
      maybe(supabase.from("checkout_sessions").select("client_id, status, livemode").eq("stripe_checkout_session_id", sessionId).maybeSingle()),

    async checkoutSummary(sessionId) {
      // deno-lint-ignore no-explicit-any
      const cs = await maybe<any>(supabase.from("checkout_sessions")
        .select("id, client_id, stripe_checkout_session_id, status, url, expires_at, livemode, line_items, completed_at, billing_packages(name)")
        .eq("stripe_checkout_session_id", sessionId).maybeSingle());
      if (!cs) return null;
      const priceId = cs.line_items?.[0]?.price ?? null;
      const price = priceId
        ? await maybe<{ unit_amount_cents: number | null; currency: string; recurring_interval: string | null; recurring_interval_count: number | null; nickname: string | null }>(
          supabase.from("stripe_prices").select("unit_amount_cents, currency, recurring_interval, recurring_interval_count, nickname").eq("stripe_price_id", priceId).maybeSingle())
        : null;
      return {
        id: cs.id, client_id: cs.client_id, session_id: cs.stripe_checkout_session_id, status: cs.status, url: cs.url,
        expires_at: cs.expires_at, completed_at: cs.completed_at, livemode: cs.livemode, package_name: cs.billing_packages?.name ?? null,
        price: price ? { id: priceId, ...price } : null,
      };
    },

    recordCheckout: (p) => rpc("billing_record_checkout", { p }),
    recordExternalPayment: (p) => rpc("billing_record_external_payment", { p }),
    voidExternalPayment: (p) => rpc("billing_void_external_payment", { p }),
    audit: (p) => rpc("billing_audit", { p }),

    async setting(key) {
      const r = await maybe<{ value: Record<string, unknown> }>(supabase.from("app_settings").select("value").eq("key", key).maybeSingle());
      return r?.value ?? null;
    },

    async saveSetting(key, value) {
      const { error } = await supabase.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) fail(error);
    },
  };
}
