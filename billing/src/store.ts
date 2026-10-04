// The billing runtime's door to the database (Option B, docs/billing-runtime.md):
// the same ReconcileStore (⊇ BillingStore ⊇ StripeStore) the Edge Functions
// build over supabase-js + the service role, here over a direct Postgres
// connection as the dedicated `billing_sync` login (0064). The handlers
// (supabase/functions/stripe-*/handler.ts) run unchanged on top of it.
//
// Parity with the supabase-js stores, deliberately:
//   - every read is built as JSON inside Postgres (json_agg / to_json), so a
//     row reaches the handler exactly as PostgREST would have sent it:
//     timestamps as ISO strings, bigint as numbers, jsonb parsed;
//   - the shared sync's methods (apply, linkCustomer, the ledger) fail with a
//     plain Error "<function>: <message>", the billing methods with
//     BillingDbError carrying the SQLSTATE (the handler maps 42501 / 23505 /
//     23503 / 23514 / P0002 to its answers);
//   - the same direct writes, and only those: a catalog entry's Stripe
//     Product, a client's custom price, the billing_portal setting — after
//     the handler's own admin check, and limited again by 0064's policies.
//
// Who is calling is asked of Supabase Auth with the caller's own JWT (the
// public anon key identifies the project); the runtime holds no service key.
// Secrets come from this project's environment, never from Vault.

import type { LedgerEvent } from "../../supabase/functions/_shared/stripe/store.ts";
import type { OpResult, SyncOp } from "../../supabase/functions/_shared/stripe/sync.ts";
import {
  type AgreementPlan, type AuditInput, BillingDbError, type Caller, type CatalogEntry, type CatalogTarget,
  type PackagePrice, type PriceMirror,
} from "../../supabase/functions/stripe-billing/store.ts";
import type { LinkedCustomer, ReconcileStore, RunInput } from "../../supabase/functions/stripe-reconcile/store.ts";
import type { Fingerprint } from "../../supabase/functions/stripe-reconcile/engine.ts";

// The one thing the store needs from a Postgres client (pg.Pool satisfies it).
export type Db = {
  // deno-lint-ignore no-explicit-any
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

// Supabase Auth: the auth user id behind a JWT, or null when it is not a
// valid, current session.
export type AuthUser = (jwt: string) => Promise<string | null>;

export function supabaseAuthUser(opts: { url: string; anonKey: string; fetch?: typeof fetch; timeoutMs?: number }): AuthUser {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/$/, "");
  return async (jwt) => {
    try {
      const res = await doFetch(`${base}/auth/v1/user`, {
        headers: { apikey: opts.anonKey, authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) return null;
      const user = await res.json().catch(() => null);
      return typeof user?.id === "string" ? user.id : null;
    } catch {
      return null;
    }
  };
}

// Stripe states that are billing the client (stripe-billing/store.ts).
const BLOCKING = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

// deno-lint-ignore no-explicit-any
type Pg = { code?: string; message?: string } & any;

export function createPgStore(db: Db, opts: {
  authUser: AuthUser;
  // The only secret the handlers ask the store for: the scheduler's.
  reconcileSecret?: string | null;
}): ReconcileStore {
  // A shared-sync call: a plain Error, as createStripeStore raises.
  async function sync<T>(name: string, sql: string, values: unknown[]): Promise<T> {
    try {
      return (await db.query(sql, values)).rows[0]?.r as T;
    } catch (e) {
      throw new Error(`${name}: ${(e as Pg)?.message ?? e}`);
    }
  }
  // A billing call or read: BillingDbError with the SQLSTATE.
  async function q(sql: string, values: unknown[] = []) {
    try {
      return (await db.query(sql, values)).rows;
    } catch (e) {
      throw new BillingDbError((e as Pg)?.code ?? null, String((e as Pg)?.message ?? e));
    }
  }
  // Rows as PostgREST would send them.
  async function rows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    const r = await q(`select coalesce(json_agg(x), '[]'::json) as j from (${sql}) x`, values);
    return (r[0]?.j ?? []) as T[];
  }
  async function one<T>(sql: string, values: unknown[] = []): Promise<T | null> {
    return (await rows<T>(sql, values))[0] ?? null;
  }
  async function call<T>(sql: string, values: unknown[]): Promise<T> {
    return (await q(sql, values))[0]?.r as T;
  }
  const j = (v: unknown) => JSON.stringify(v);

  return {
    // ── The shared sync (StripeStore) ──────────────────────────────────────
    apply: (ops: SyncOp[]) => sync<OpResult[]>("billing_sync_apply", "select public.billing_sync_apply($1::jsonb) as r", [j({ ops })]),
    linkCustomer: (p) => sync("billing_link_customer", "select public.billing_link_customer($1::jsonb) as r", [j(p)]),
    beginEvent: (e: LedgerEvent, leaseSeconds = 300) =>
      sync("billing_event_begin", "select public.billing_event_begin($1::jsonb, $2::int) as r", [j(e), leaseSeconds]),
    finishEvent: (id, attempt, status, reason = null) =>
      sync("billing_event_finish", "select public.billing_event_finish($1::text, $2::int, $3::text, $4::text) as r", [id, attempt, status, reason]),
    failEvent: (id, attempt, error) =>
      sync("billing_event_fail", "select public.billing_event_fail($1::text, $2::int, $3::text) as r", [id, attempt, error]),
    // Only the scheduler's secret is ever asked for; the Stripe keys are read
    // by the entry points straight from the environment.
    secret: async (name) => (name === "BILLING_RECONCILE_SECRET" ? (opts.reconcileSecret || null) : null),
    billingLivemode: () => sync<boolean>("billing_livemode", "select public.billing_livemode() as r", []),

    // ── Who is calling ─────────────────────────────────────────────────────
    async caller(jwt): Promise<"none" | Caller | null> {
      if (!jwt) return "none";
      const userId = await opts.authUser(jwt);
      if (!userId) return "none";
      const m = await one<{ id: string; role: string }>(
        "select id, role from public.team_members where auth_user_id = $1", [userId]);
      if (m) return { kind: "team", memberId: m.id, role: m.role === "admin" ? "admin" : "member" };
      const p = await one<{ id: string; client_id: string }>(
        "select id, client_id from public.portal_users where auth_user_id = $1 and is_active", [userId]);
      return p ? { kind: "portal", portalUserId: p.id, clientId: p.client_id } : null;
    },

    // ── BillingStore reads ─────────────────────────────────────────────────
    client: (id) => one("select id, name, status from public.clients where id = $1", [id]),
    plan: (clientId) => one<AgreementPlan>(
      `select package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
              agreed_billing_interval_count, billing_package_price_id
         from public.plans where client_id = $1`, [clientId]),

    activeLink: (clientId, livemode) => one(
      `select stripe_customer_id from public.stripe_customers
        where client_id = $1 and livemode = $2 and unlinked_at is null and deleted_at is null`, [clientId, livemode]),

    async linkOf(customerId) {
      const r = await one<{ client_id: string; client_name: string | null; unlinked_at: string | null; deleted_at: string | null }>(
        `select sc.client_id, c.name as client_name, sc.unlinked_at, sc.deleted_at
           from public.stripe_customers sc left join public.clients c on c.id = sc.client_id
          where sc.stripe_customer_id = $1`, [customerId]);
      return r ? { client_id: r.client_id, client_name: r.client_name ?? "", active: !r.unlinked_at && !r.deleted_at } : null;
    },

    async linksOf(customerIds) {
      if (customerIds.length === 0) return [];
      const r = await rows<{ stripe_customer_id: string; client_id: string; client_name: string | null; unlinked_at: string | null; deleted_at: string | null }>(
        `select sc.stripe_customer_id, sc.client_id, c.name as client_name, sc.unlinked_at, sc.deleted_at
           from public.stripe_customers sc left join public.clients c on c.id = sc.client_id
          where sc.stripe_customer_id = any($1::text[])`, [customerIds]);
      return r.map((x) => ({
        stripe_customer_id: x.stripe_customer_id, client_id: x.client_id, client_name: x.client_name ?? "",
        active: !x.unlinked_at && !x.deleted_at,
      }));
    },

    async linkCount(clientId, livemode) {
      const r = await q("select count(*)::int as n from public.stripe_customers where client_id = $1 and livemode = $2", [clientId, livemode]);
      return r[0]?.n ?? 0;
    },

    async catalogEntry(target: CatalogTarget, id): Promise<CatalogEntry | null> {
      if (target === "package") {
        return one<CatalogEntry>(
          `select p.id, p.name, p.kind, p.active, p.stripe_product_id,
                  (select count(*)::int from public.billing_package_prices pp where pp.package_id = p.id) as mapped_prices
             from public.billing_packages p where p.id = $1`, [id]);
      }
      return one<CatalogEntry>(
        `select id, name, null::text as kind, active, stripe_product_id, 0 as mapped_prices
           from public.billing_one_time_items where id = $1`, [id]);
    },

    async productOwner(productId) {
      const p = await one<{ id: string; name: string }>("select id, name from public.billing_packages where stripe_product_id = $1", [productId]);
      if (p) return { target: "package", ...p };
      const o = await one<{ id: string; name: string }>("select id, name from public.billing_one_time_items where stripe_product_id = $1", [productId]);
      return o ? { target: "one_time_item", ...o } : null;
    },

    productMirror: (productId) => one(
      "select livemode, active from public.stripe_products where stripe_product_id = $1 and deleted_at is null", [productId]),

    async setProduct(target, id, productId) {
      const table = target === "package" ? "billing_packages" : "billing_one_time_items";
      await q(`update public.${table} set stripe_product_id = $1 where id = $2`, [productId, id]);
    },

    packagePrice: (id) => one<PackagePrice>(
      `select pp.id, pp.package_id, pp.package_kind, pp.stripe_product_id, pp.stripe_price_id, pp.client_id, pp.active,
              coalesce(p.active, false) as package_active
         from public.billing_package_prices pp left join public.billing_packages p on p.id = pp.package_id
        where pp.id = $1`, [id]),

    priceMirror: (priceId) => one<PriceMirror>(
      `select active, type, livemode, deleted_at, unit_amount_cents, currency, recurring_interval,
              recurring_interval_count, recurring_usage_type, billing_scheme
         from public.stripe_prices where stripe_price_id = $1`, [priceId]),

    async mapClientPrice(row) {
      const created = await q(
        `insert into public.billing_package_prices
           (package_id, package_kind, stripe_product_id, stripe_price_id, client_id, notes, is_default, active)
         values ($1, $2, $3, $4, $5, $6, false, true)
         on conflict (stripe_price_id) do nothing returning id`,
        [row.package_id, row.package_kind, row.stripe_product_id, row.stripe_price_id, row.client_id, row.notes]);
      if (created.length) return { id: created[0].id, created: true };
      const existing = await one<{ id: string; client_id: string | null }>(
        "select id, client_id from public.billing_package_prices where stripe_price_id = $1", [row.stripe_price_id]);
      if (!existing || existing.client_id !== row.client_id) throw new BillingDbError("23505", "That Stripe price is mapped to another client.");
      return { id: existing.id, created: false };
    },

    blockingSubscriptions: (clientId, livemode) => rows(
      `select stripe_subscription_id, status from public.subscriptions
        where client_id = $1 and livemode = $2 and status = any($3::text[])`, [clientId, livemode, BLOCKING]),

    async openCheckouts(clientId, livemode) {
      const r = await rows<{ stripe_checkout_session_id: string; expires_at: string; line_items: { request_id?: string }[] | null }>(
        `select stripe_checkout_session_id, expires_at, line_items from public.checkout_sessions
          where client_id = $1 and livemode = $2 and status = 'open' order by created_at desc`, [clientId, livemode]);
      return r.map((x) => ({
        stripe_checkout_session_id: x.stripe_checkout_session_id, expires_at: x.expires_at,
        request_id: x.line_items?.[0]?.request_id ?? null,
      }));
    },

    checkout: (sessionId) => one(
      "select client_id, status, livemode from public.checkout_sessions where stripe_checkout_session_id = $1", [sessionId]),

    async checkoutSummary(sessionId) {
      const cs = await one<Record<string, unknown> & { line_items: { price?: string }[] | null; package_name: string | null }>(
        `select cs.id, cs.client_id, cs.stripe_checkout_session_id, cs.status, cs.url, cs.expires_at, cs.livemode,
                cs.line_items, cs.completed_at, p.name as package_name
           from public.checkout_sessions cs left join public.billing_packages p on p.id = cs.package_id
          where cs.stripe_checkout_session_id = $1`, [sessionId]);
      if (!cs) return null;
      const priceId = cs.line_items?.[0]?.price ?? null;
      const price = priceId
        ? await one<Record<string, unknown>>(
          `select unit_amount_cents, currency, recurring_interval, recurring_interval_count, nickname
             from public.stripe_prices where stripe_price_id = $1`, [priceId])
        : null;
      return {
        id: cs.id, client_id: cs.client_id, session_id: cs.stripe_checkout_session_id, status: cs.status, url: cs.url,
        expires_at: cs.expires_at, completed_at: cs.completed_at, livemode: cs.livemode, package_name: cs.package_name ?? null,
        price: price ? { id: priceId, ...price } : null,
      };
    },

    // ── BillingStore writes through 0060's functions ──────────────────────
    recordCheckout: (p) => call("select public.billing_record_checkout($1::jsonb) as r", [j(p)]),
    recordExternalPayment: (p) => call("select public.billing_record_external_payment($1::jsonb) as r", [j(p)]),
    voidExternalPayment: (p) => call("select public.billing_void_external_payment($1::jsonb) as r", [j(p)]),
    audit: (p: AuditInput) => call<string>("select public.billing_audit($1::jsonb) as r", [j(p)]),

    async setting(key) {
      const r = await one<{ value: Record<string, unknown> }>("select value from public.app_settings where key = $1", [key]);
      return r?.value ?? null;
    },

    async saveSetting(key, value) {
      await q(
        `insert into public.app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`, [key, j(value)]);
    },

    // ── ReconcileStore ─────────────────────────────────────────────────────
    beginRun: (p: RunInput) => call("select public.billing_reconcile_begin($1::jsonb) as r", [j(p)]),
    recordClient: (p) => call("select public.billing_reconcile_client($1::jsonb) as r", [j(p)]),
    finishRun: (p) => call("select public.billing_reconcile_finish($1::jsonb) as r", [j(p)]),
    fingerprint: (clientId, livemode) =>
      call<Fingerprint>("select public.billing_mirror_fingerprint($1::uuid, $2::boolean) as r", [clientId, livemode]),
    catalogFingerprint: (livemode) => call<Fingerprint>("select public.billing_catalog_fingerprint($1::boolean) as r", [livemode]),

    // Active links in the mode, the least recently reconciled first.
    async linkedCustomers(livemode, clientId) {
      const links = await rows<LinkedCustomer>(
        `select client_id, stripe_customer_id from public.stripe_customers
          where livemode = $1 and unlinked_at is null and deleted_at is null and ($2::uuid is null or client_id = $2::uuid)`,
        [livemode, clientId]);
      const last = await rows<{ client_id: string; checked_at: string }>(
        "select client_id, checked_at from public.client_billing_reconciliation");
      const at = new Map(last.map((r) => [r.client_id, r.checked_at]));
      return links.sort((a, b) => (at.get(a.client_id) ?? "").localeCompare(at.get(b.client_id) ?? ""));
    },

    async mappedProducts(livemode) {
      const r = await rows<{ stripe_product_id: string }>(
        `select distinct p.stripe_product_id from public.stripe_products p
          where p.livemode = $1 and p.stripe_product_id in (
            select stripe_product_id from public.billing_packages where stripe_product_id is not null
            union select stripe_product_id from public.billing_one_time_items where stripe_product_id is not null)`, [livemode]);
      return r.map((x) => x.stripe_product_id).sort();
    },

    async catalogWarnings(livemode) {
      const out: { code: string; detail?: string }[] = [];
      const pk = await rows<{ name: string; stripe_product_id: string; active: boolean; livemode: boolean; deleted_at: string | null }>(
        `select p.name, p.stripe_product_id, sp.active, sp.livemode, sp.deleted_at
           from public.billing_packages p join public.stripe_products sp on sp.stripe_product_id = p.stripe_product_id
          where p.active and p.stripe_product_id is not null`);
      for (const p of pk) {
        if (p.livemode !== livemode) out.push({ code: "catalog_product_other_mode", detail: `${p.name}: ${p.stripe_product_id}` });
        else if (!p.active || p.deleted_at) out.push({ code: "catalog_product_archived", detail: `${p.name}: ${p.stripe_product_id}` });
      }
      const pr = await rows<{ stripe_price_id: string; package_name: string | null; active: boolean; livemode: boolean; deleted_at: string | null }>(
        `select pp.stripe_price_id, p.name as package_name, sp.active, sp.livemode, sp.deleted_at
           from public.billing_package_prices pp
           left join public.billing_packages p on p.id = pp.package_id
           join public.stripe_prices sp on sp.stripe_price_id = pp.stripe_price_id
          where pp.active`);
      for (const p of pr) {
        if (p.livemode === livemode && (!p.active || p.deleted_at)) {
          out.push({ code: "catalog_price_archived", detail: `${p.package_name ?? "package"}: ${p.stripe_price_id}` });
        }
      }
      return out;
    },

    recoverableEvents: (livemode, limit) => rows<LedgerEvent>(
      `select id, type, livemode, api_version, event_created_at, object_type, object_id from public.stripe_events
        where livemode = $1 and (status = 'failed' or (status = 'processing' and lease_expires_at < now()))
        order by received_at limit $2`, [livemode, limit]),

    async mirrorInvoiceIds(clientId, customerId, livemode) {
      const r = await rows<{ stripe_invoice_id: string }>(
        `select stripe_invoice_id from public.invoices where client_id = $1 and stripe_customer_id = $2 and livemode = $3`,
        [clientId, customerId, livemode]);
      return r.map((x) => x.stripe_invoice_id);
    },

    async pendingCheckouts(clientId, livemode) {
      const r = await rows<{ stripe_checkout_session_id: string }>(
        `select stripe_checkout_session_id from public.checkout_sessions
          where client_id = $1 and livemode = $2 and (status = 'open' or (status = 'complete' and payment_status = 'unpaid'))`,
        [clientId, livemode]);
      return r.map((x) => x.stripe_checkout_session_id);
    },

    async attention(clientId) {
      const r = await one<{ attention_reasons: string[] | null }>(
        "select attention_reasons from public.client_billing_status where client_id = $1", [clientId]);
      return r?.attention_reasons ?? [];
    },
  };
}
