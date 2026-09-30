// stripe-billing (B3): the billing commands a person asks for. Every Stripe
// write Compass makes goes through here, server-side, and every write is
// followed by the shared B2 sync (../_shared/stripe/sync.ts), so the mirror is
// filled exactly as the webhook would fill it. Nothing is trusted from the
// browser: the client's customer, the price, the amount of a Checkout, the
// billing mode and the caller's rights are all resolved here.
//
//   POST {action, ...} with the caller's Supabase JWT (verify_jwt = true).
//
// Actions and who may call them (docs/billing.md, "B3 authorization"):
//
//   admin   search_customers, link_customer, create_customer, import_product,
//           create_custom_price, create_checkout, expire_checkout,
//           configure_portal, record_external_payment, void_external_payment
//   admin   create_portal_session {client_id} (a teammate opening the client's
//           Customer Portal acts for the client)
//   portal  create_portal_session (no client id: the contact's own client,
//           derived from the sign-in; never another client's)
//   team    resync_customer, version
//
// Idempotency: every Stripe create carries an idempotency key derived from
// the request (a request id the form generates once, or the client and link
// generation for a customer), and every Compass record is keyed so a retry
// writes nothing twice (docs/billing.md, "Idempotency").
//
// Billing never stops client work: nothing here changes entitlements, stages,
// tasks or anything outside the billing tables.

import type { StripeApi, StripeObject } from "../_shared/stripe/api.ts";
import { StripeApiError } from "../_shared/stripe/api.ts";
import { checkoutSessionRow } from "../_shared/stripe/map.ts";
import { createStripeSync } from "../_shared/stripe/sync.ts";
import { BillingDbError, type BillingStore, type Caller } from "./store.ts";

export const STRIPE_BILLING_VERSION = 1;

export type BillingConfig = { secretKey: string; appUrl: string };

export const ADMIN_ACTIONS = [
  "search_customers", "link_customer", "create_customer", "import_product", "create_custom_price",
  "create_checkout", "expire_checkout", "configure_portal", "record_external_payment", "void_external_payment",
] as const;
export const TEAM_ACTIONS = ["resync_customer", "version"] as const;
export const ACTIONS = [...ADMIN_ACTIONS, ...TEAM_ACTIONS, "create_portal_session"] as const;
export type Action = typeof ACTIONS[number];

// A subscription in one of these states is (or is about to be) billing the
// client: a second Checkout would create a second subscription.
export const BLOCKING_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

export const PORTAL_CONFIG_VERSION = 1;

class Refusal extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
  throw new Refusal(status, code, message, extra);
};

// What a database refusal means to the caller (0059's functions raise these).
const DB_REFUSALS: Record<string, [number, string]> = {
  "42501": [403, "forbidden"],
  "23505": [409, "conflict"],
  "23503": [409, "reference_missing"],
  "23514": [400, "invalid_request"],
  "P0002": [404, "not_found"],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Input readers (pure) ────────────────────────────────────────────────────
export function uuidOf(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !UUID.test(v)) refuse(400, "invalid_request", `${key} must be a uuid`);
  return (v as string).toLowerCase();
}
export function idOfKind(body: Record<string, unknown>, key: string, prefix: string): string {
  const v = body[key];
  if (typeof v !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(v)) {
    refuse(400, "invalid_request", `${key} must be a Stripe ${prefix}_ id`);
  }
  return v as string;
}
function text(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | null {
  const v = body[key];
  if (v == null || (typeof v === "string" && v.trim() === "")) {
    if (opts.required) refuse(400, "invalid_request", `${key} is required`);
    return null;
  }
  if (typeof v !== "string") refuse(400, "invalid_request", `${key} must be text`);
  const s = (v as string).trim();
  if (s.length > (opts.max ?? 500)) refuse(400, "invalid_request", `${key} is too long`);
  return s;
}
// Money is integer minor units; never a float, never negative or zero.
export function amountOf(body: Record<string, unknown>, key: string, max = 100_000_000): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > max) {
    refuse(400, "invalid_request", `${key} must be a whole number of cents between 1 and ${max}`);
  }
  return v as number;
}
export function currencyOf(body: Record<string, unknown>, key = "currency"): string {
  const v = body[key] ?? "usd";
  if (typeof v !== "string" || !/^[a-zA-Z]{3}$/.test(v)) refuse(400, "invalid_request", `${key} must be a 3-letter currency code`);
  return (v as string).toLowerCase();
}

// Stripe's search syntax: a quoted value with \ and ' escaped.
export function searchValue(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
export function customerSearchQuery(q: string): { kind: "id" | "email" | "name"; query: string } {
  const t = q.trim();
  if (/^cus_[A-Za-z0-9]+$/.test(t)) return { kind: "id", query: t };
  if (t.includes("@")) return { kind: "email", query: `email:${searchValue(t)}` };
  return { kind: "name", query: `name~${searchValue(t)}` };
}

// The Customer Portal configuration Compass allows: payment methods, invoices
// and billing contact details only. Never plan changes, quantities,
// cancellation or pausing: those are the agreement's, changed by a teammate.
export function portalConfigParams(appUrl: string) {
  return {
    business_profile: { headline: "Manage your Compass Marketing Advisors billing" },
    default_return_url: `${appUrl}/portal`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address", "phone", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    },
    metadata: { compass_portal_config_version: String(PORTAL_CONFIG_VERSION) },
  };
}

// Checked against Stripe before every portal session: a configuration someone
// widened in the Stripe dashboard is refused rather than handed to a client.
export function checkPortalConfig(cfg: StripeObject): string[] {
  const f = cfg?.features ?? {};
  const problems: string[] = [];
  if (!cfg?.active) problems.push("configuration is not active");
  if (f.subscription_cancel?.enabled) problems.push("cancellation is enabled");
  if (f.subscription_update?.enabled) problems.push("plan or quantity changes are enabled");
  if (f.subscription_pause?.enabled) problems.push("pausing is enabled");
  if (!f.payment_method_update?.enabled) problems.push("payment method updates are disabled");
  if (!f.invoice_history?.enabled) problems.push("invoice history is disabled");
  const allowed: string[] = f.customer_update?.enabled ? (f.customer_update.allowed_updates ?? []) : [];
  for (const a of allowed) if (!["email", "address", "phone", "tax_id", "name", "shipping"].includes(a)) problems.push(`customer can update ${a}`);
  return problems;
}

// What may be sold through Checkout for this client: an approved recurring
// Stripe Price mapped to the client's agreed package (and, for a custom
// package, reserved for this client), active in Stripe and in this mode.
export type CheckoutPriceCheck = {
  mapping: { package_id: string; client_id: string | null; active: boolean; package_active: boolean; package_kind: string } | null;
  price: { active: boolean; type: string; livemode: boolean; deleted_at: string | null; unit_amount_cents: number | null; recurring_usage_type: string | null } | null;
  plan: { package_id: string | null; collection: string } | null;
  clientId: string;
  livemode: boolean;
};
export function checkCheckoutPrice(c: CheckoutPriceCheck): { status: number; code: string; message: string } | null {
  if (!c.mapping) return { status: 404, code: "price_not_approved", message: "That price is not an approved package price." };
  if (c.mapping.client_id && c.mapping.client_id !== c.clientId) {
    return { status: 403, code: "price_not_for_client", message: "That custom price belongs to another client." };
  }
  if (c.mapping.package_kind === "custom" && !c.mapping.client_id) {
    return { status: 409, code: "price_not_for_client", message: "A custom package price must be reserved for the client." };
  }
  if (!c.mapping.active || !c.mapping.package_active) {
    return { status: 409, code: "price_inactive", message: "That package price is retired in the Compass catalog." };
  }
  if (!c.plan || !c.plan.package_id) return { status: 409, code: "no_agreement", message: "Record the client's package on the Plan tab first." };
  if (c.plan.collection !== "stripe") {
    return { status: 409, code: "agreement_external", message: "The agreement is collected outside Stripe; change it to Stripe first." };
  }
  if (c.plan.package_id !== c.mapping.package_id) {
    return { status: 409, code: "package_mismatch", message: "That price sells a different package from the client's agreement." };
  }
  if (!c.price) return { status: 409, code: "price_missing", message: "The Stripe price is not in the mirror; import the product again." };
  if (c.price.deleted_at || !c.price.active) return { status: 409, code: "price_inactive", message: "The Stripe price is archived in Stripe." };
  if (c.price.type !== "recurring" || c.price.recurring_usage_type === "metered") {
    return { status: 409, code: "price_not_recurring", message: "Checkout sells a licensed recurring price only." };
  }
  if (c.price.livemode !== c.livemode) {
    return { status: 409, code: "price_mode_mismatch", message: `That price is a ${c.price.livemode ? "live" : "test"} price; billing is in ${c.livemode ? "live" : "test"} mode.` };
  }
  if (!c.price.unit_amount_cents) return { status: 409, code: "price_not_fixed", message: "Checkout sells a fixed-amount price only." };
  return null;
}

// ── The handler ─────────────────────────────────────────────────────────────
export function createStripeBilling(deps: {
  config: () => Promise<BillingConfig | null>;
  store: BillingStore;
  makeApi: (secretKey: string) => StripeApi;
  now?: () => Date;
}) {
  const { store } = deps;
  const now = () => (deps.now ? deps.now() : new Date());

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_request", detail: "body must be JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid_request", detail: "body must be an object" });
    const action = body.action as Action;

    try {
      const caller = await store.caller(jwt);
      if (caller === "none") return json(401, { error: "not_signed_in" });
      if (!caller) return json(403, { error: "forbidden", detail: "Billing is for the Compass team and the client's own portal contacts." });
      if (!(ACTIONS as readonly string[]).includes(action)) return json(400, { error: "unknown_action" });
      authorize(action, caller, body);
      if (action === "version") return json(200, { version: STRIPE_BILLING_VERSION, actions: ACTIONS });

      const cfg = await deps.config();
      if (!cfg) return json(503, { error: "stripe_not_configured", detail: "STRIPE_SECRET_KEY is not in Vault." });
      const api = deps.makeApi(cfg.secretKey);
      const livemode = api.mode === "live";
      const settingLive = await store.billingLivemode();
      if (livemode && !settingLive) return json(503, { error: "live_mode_not_enabled", detail: "A live key needs billing switched to live by an admin." });
      if (!livemode && settingLive) return json(503, { error: "key_mode_mismatch", detail: "Billing is in live mode but the key is a test key." });

      const ctx: Ctx = { api, livemode, caller: caller as Caller, cfg, sync: createStripeSync({ api, store, now }) };
      return json(200, await run(action, ctx, body));
    } catch (e) {
      if (e instanceof Refusal) return json(e.status, { error: e.code, detail: e.message, ...e.extra });
      if (e instanceof StripeApiError) {
        return json(502, { error: "stripe_error", detail: e.message, stripe_code: e.code, stripe_type: e.type, stripe_param: e.param });
      }
      if (e instanceof BillingDbError) {
        const [status, code] = DB_REFUSALS[e.code ?? ""] ?? [500, "failed"];
        return json(status, { error: code, detail: e.message });
      }
      return json(500, { error: "failed", detail: String((e as Error)?.message ?? e) });
    }
  }

  function authorize(action: Action, caller: Exclude<Awaited<ReturnType<BillingStore["caller"]>>, "none">, body: Record<string, unknown>) {
    if (!caller) refuse(403, "forbidden", "Billing is for the Compass team and the client's own portal contacts.");
    const c = caller as Caller;
    if (c.kind === "portal") {
      if (action !== "create_portal_session") refuse(403, "forbidden", "A portal contact may only open their own billing portal.");
      if (body.client_id !== undefined && body.client_id !== c.clientId) refuse(403, "forbidden", "A portal contact may only open their own billing portal.");
      return;
    }
    if ((TEAM_ACTIONS as readonly string[]).includes(action)) return;
    if (c.role !== "admin") refuse(403, "admin_only", "Only an admin can do that.");
  }

  type Ctx = { api: StripeApi; livemode: boolean; caller: Caller; cfg: BillingConfig; sync: ReturnType<typeof createStripeSync> };

  const memberOf = (c: Caller) => (c.kind === "team" ? c.memberId : null);

  async function liveClient(id: string) {
    const client = await store.client(id);
    if (!client) refuse(404, "client_not_found", "No such client.");
    if (client!.status === "offboarded") refuse(409, "client_offboarded", "The client is offboarded.");
    return client!;
  }

  async function retrieve(api: StripeApi, path: string, params?: Record<string, string | number | string[]>) {
    try {
      return await api.get(path, params);
    } catch (e) {
      if (e instanceof StripeApiError && e.missing) return null;
      throw e;
    }
  }

  async function run(action: Action, ctx: Ctx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (action) {
      case "search_customers": return searchCustomers(ctx, body);
      case "link_customer": return linkCustomer(ctx, body);
      case "create_customer": return createCustomer(ctx, body);
      case "resync_customer": return resyncCustomer(ctx, body);
      case "import_product": return importProduct(ctx, body);
      case "create_custom_price": return createCustomPrice(ctx, body);
      case "create_checkout": return createCheckout(ctx, body);
      case "expire_checkout": return expireCheckout(ctx, body);
      case "configure_portal": return configurePortal(ctx);
      case "create_portal_session": return createPortalSession(ctx, body);
      case "record_external_payment": return recordExternalPayment(ctx, body);
      case "void_external_payment": return voidExternalPayment(ctx, body);
      default: return refuse(400, "unknown_action", String(action));
    }
  }

  // ── 1. Existing customers ───────────────────────────────────────────────
  async function searchCustomers({ api, livemode }: Ctx, body: Record<string, unknown>) {
    const q = text(body, "query", { required: true, max: 200 })!;
    if (q.length < 2) refuse(400, "invalid_request", "Search needs at least two characters.");
    const s = customerSearchQuery(q);
    let found: StripeObject[];
    if (s.kind === "id") {
      const c = await retrieve(api, `/v1/customers/${s.query}`, { expand: ["subscriptions"] });
      found = c ? [c] : [];
    } else {
      found = await api.search("/v1/customers/search", s.query, { limit: 20, expand: ["data.subscriptions"] });
    }
    const links = await store.linksOf(found.map((c) => c.id));
    const customers = found.map((c) => {
      const link = links.find((l) => l.stripe_customer_id === c.id) ?? null;
      const subs: StripeObject[] = c.subscriptions?.data ?? [];
      return {
        id: c.id,
        name: c.name ?? null,
        email: c.email ?? null,
        livemode: !!c.livemode,
        deleted: !!c.deleted,
        created: c.created ?? null,
        currency: c.currency ?? null,
        compass_client_id: c.metadata?.compass_client_id ?? null,
        subscriptions: subs.map((x) => ({ id: x.id, status: x.status })),
        linked_client: link ? { id: link.client_id, name: link.client_name, active: link.active } : null,
        mode_matches: !!c.livemode === livemode,
      };
    });
    return { livemode, customers };
  }

  async function linkCustomer({ api, livemode, caller, sync }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const customerId = idOfKind(body, "customer_id", "cus");
    if (body.confirm !== true) refuse(400, "confirmation_required", "Linking needs an explicit confirmation.");
    const client = await liveClient(clientId);

    const c = await retrieve(api, `/v1/customers/${customerId}`);
    if (!c) refuse(404, "customer_not_found", `No Stripe customer ${customerId} in ${livemode ? "live" : "test"} mode.`);
    if (c!.deleted) refuse(409, "customer_deleted", "That Stripe customer is deleted.");
    if (!!c!.livemode !== livemode) refuse(409, "mode_mismatch", "That customer is not in the current billing mode.");

    const existing = await store.linkOf(customerId);
    if (existing) {
      if (existing.client_id !== clientId) {
        refuse(409, "customer_linked_elsewhere", `That Stripe customer is already linked to ${existing.client_name}.`, { linked_client_id: existing.client_id });
      }
      if (existing.active) {
        const results = await sync.resyncCustomer(customerId);
        return { linked: true, already_linked: true, customer_id: customerId, synced: results.length };
      }
      refuse(409, "customer_previously_unlinked", "That customer was unlinked from this client; relinking is not supported yet.");
    }
    const active = await store.activeLink(clientId, livemode);
    if (active) {
      refuse(409, "client_already_linked", `${client.name} is already linked to ${active.stripe_customer_id} in this mode.`, { customer_id: active.stripe_customer_id });
    }
    const claimed = c!.metadata?.compass_client_id;
    if (claimed && claimed !== clientId) {
      refuse(409, "customer_claimed_by_other_client", "The customer's Stripe metadata names a different Compass client.", { compass_client_id: claimed });
    }

    const results = await sync.linkCustomer({ clientId, customerId, linkSource: "linked_existing", linkedBy: memberOf(caller) });
    await store.audit({ client_id: clientId, action: "link_customer", ...actor(caller), livemode, subject: customerId,
      detail: { name: c!.name ?? null, email: c!.email ?? null, synced: results.length } });
    return { linked: true, customer_id: customerId, synced: results.length };
  }

  // ── 2. New customers ────────────────────────────────────────────────────
  async function createCustomer({ api, livemode, caller, sync }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const email = text(body, "email", { required: true, max: 254 })!.toLowerCase();
    if (!EMAIL.test(email)) refuse(400, "invalid_request", "email is not an email address");
    const client = await liveClient(clientId);
    const name = text(body, "name", { max: 200 }) ?? client.name;

    const active = await store.activeLink(clientId, livemode);
    if (active) {
      refuse(409, "client_already_linked", `${client.name} already has a Stripe customer in this mode.`, { customer_id: active.stripe_customer_id });
    }
    // A customer Compass created earlier for this client (e.g. the link step
    // failed after Stripe answered) is found by its metadata and linked, never
    // re-created. Stripe search lags a few seconds; the idempotency key below
    // covers that window.
    const prior = (await api.search("/v1/customers/search", `metadata['compass_client_id']:${searchValue(clientId)}`, { limit: 10 }))
      .filter((x) => !x.deleted && !!x.livemode === livemode);
    if (prior.length > 0) {
      refuse(409, "existing_customer_found", "Stripe already has a customer for this client; link it instead.",
        { customers: prior.map((x) => ({ id: x.id, name: x.name ?? null, email: x.email ?? null })) });
    }

    // One key per client, mode and link generation: a double click, a retry
    // or a second tab inside Stripe's 24-hour window gets the same customer.
    const generation = await store.linkCount(clientId, livemode);
    const key = `compass-customer-${clientId}-${livemode ? "live" : "test"}-${generation}`;
    let customer: StripeObject;
    try {
      customer = await api.post("/v1/customers", {
        name, email,
        metadata: { compass_client_id: clientId, compass_client_name: client.name },
      }, { idempotencyKey: key });
    } catch (e) {
      if (e instanceof StripeApiError && e.type === "idempotency_error") {
        refuse(409, "customer_creation_in_progress",
          "A customer for this client was already requested with different details. Link the customer Stripe created, or retry tomorrow.");
      }
      throw e;
    }

    let results;
    try {
      results = await sync.linkCustomer({ clientId, customerId: customer.id, linkSource: "created", linkedBy: memberOf(caller) });
    } catch (e) {
      // A concurrent request linked the same customer first: the same result.
      const again = await store.linkOf(customer.id);
      if (again?.client_id === clientId && again.active) return { created: false, customer_id: customer.id };
      throw e;
    }
    await store.audit({ client_id: clientId, action: "create_customer", ...actor(caller), livemode, subject: customer.id,
      detail: { name, email } });
    return { created: true, customer_id: customer.id, synced: results.length };
  }

  async function resyncCustomer({ livemode, caller, sync }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    await liveClient(clientId);
    const link = await store.activeLink(clientId, livemode);
    if (!link) refuse(404, "no_customer", "The client has no linked Stripe customer in this mode.");
    const results = await sync.resyncCustomer(link!.stripe_customer_id);
    await store.audit({ client_id: clientId, action: "resync_customer", ...actor(caller), livemode, subject: link!.stripe_customer_id,
      detail: { synced: results.length } });
    return { customer_id: link!.stripe_customer_id, synced: results.length };
  }

  // ── 3. Catalog: Stripe Products and client prices ───────────────────────
  async function importProduct({ api, livemode, caller, sync }: Ctx, body: Record<string, unknown>) {
    const target = body.target === "one_time_item" ? "one_time_item" : body.target === "package" ? "package" : null;
    if (!target) refuse(400, "invalid_request", "target must be package or one_time_item");
    const targetId = uuidOf(body, "target_id");
    const productId = idOfKind(body, "product_id", "prod");
    const entry = await store.catalogEntry(target!, targetId);
    if (!entry) refuse(404, "catalog_entry_not_found", "No such catalog entry.");

    const p = await retrieve(api, `/v1/products/${productId}`);
    if (!p || p.deleted) refuse(404, "product_not_found", `No Stripe product ${productId} in ${livemode ? "live" : "test"} mode.`);
    if (!!p!.livemode !== livemode) refuse(409, "mode_mismatch", "That product is not in the current billing mode.");
    if (!p!.active) refuse(409, "product_inactive", "That Stripe product is archived.");
    const owner = await store.productOwner(productId);
    if (owner && !(owner.target === target && owner.id === targetId)) {
      refuse(409, "product_mapped_elsewhere", `That product already belongs to ${owner.name}.`);
    }
    if (entry!.stripe_product_id && entry!.stripe_product_id !== productId && entry!.mapped_prices > 0) {
      refuse(409, "entry_has_prices", "Retire this entry's mapped prices before changing its Stripe product.");
    }

    const results = await sync.syncProductWithPrices(productId);
    await store.setProduct(target!, targetId, productId);
    await store.audit({ client_id: null, action: "import_product", ...actor(caller), livemode, subject: productId,
      detail: { target, target_id: targetId, name: p!.name, prices: results.filter((r) => r.op === "price").length } });
    return { product_id: productId, prices: results.filter((r) => r.op === "price").map((r) => r.id) };
  }

  async function createCustomPrice({ api, livemode, caller, sync }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const packageId = uuidOf(body, "package_id");
    const requestId = uuidOf(body, "request_id");
    const amount = amountOf(body, "amount_cents");
    const currency = currencyOf(body);
    const interval = body.interval ?? "month";
    if (interval !== "month" && interval !== "year") refuse(400, "invalid_request", "interval must be month or year");
    const count = body.interval_count ?? 1;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 12) {
      refuse(400, "invalid_request", "interval_count must be a whole number from 1 to 12");
    }
    const nickname = text(body, "nickname", { max: 120 });
    const client = await liveClient(clientId);

    const pkg = await store.catalogEntry("package", packageId);
    if (!pkg) refuse(404, "package_not_found", "No such package.");
    if (pkg!.kind !== "custom") refuse(409, "package_not_custom", "Client-specific prices belong to a custom package only.");
    if (!pkg!.active) refuse(409, "package_inactive", "That package is retired.");
    if (!pkg!.stripe_product_id) refuse(409, "package_not_mapped", "Import the package's Stripe product first.");
    const product = await store.productMirror(pkg!.stripe_product_id!);
    if (!product || product.livemode !== livemode) refuse(409, "mode_mismatch", "The package's Stripe product is not in the current billing mode.");

    const pr = await api.post("/v1/prices", {
      product: pkg!.stripe_product_id,
      currency,
      unit_amount: amount,
      recurring: { interval, interval_count: count },
      nickname: nickname ?? `${client.name} — ${pkg!.name}`,
      metadata: { compass_client_id: clientId, compass_package_id: packageId, compass_request_id: requestId },
    }, { idempotencyKey: `compass-price-${requestId}` });
    if (pr.metadata?.compass_client_id !== clientId || pr.product !== pkg!.stripe_product_id) {
      refuse(409, "request_id_reused", "That request id created a different price.");
    }
    await sync.syncPrice(pr.id);
    const mapped = await store.mapClientPrice({
      package_id: packageId, package_kind: "custom", stripe_product_id: pkg!.stripe_product_id!, stripe_price_id: pr.id,
      client_id: clientId, notes: nickname,
    });
    if (mapped.created) {
      await store.audit({ client_id: clientId, action: "create_custom_price", ...actor(caller), livemode, subject: pr.id,
        detail: { package_id: packageId, amount_cents: amount, currency, interval, interval_count: count, nickname } });
    }
    return { created: mapped.created, price_id: pr.id, package_price_id: mapped.id };
  }

  // ── 5. Checkout ─────────────────────────────────────────────────────────
  async function createCheckout({ api, livemode, caller, cfg, sync }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const packagePriceId = uuidOf(body, "package_price_id");
    const requestId = uuidOf(body, "request_id");
    // Nothing else from the body reaches Stripe: no price id, amount or customer.
    const client = await liveClient(clientId);

    const mapping = await store.packagePrice(packagePriceId);
    // Read the price from Stripe now: an archive in the dashboard is honoured.
    if (mapping) await sync.syncPrice(mapping.stripe_price_id);
    const price = mapping ? await store.priceMirror(mapping.stripe_price_id) : null;
    const plan = await store.plan(clientId);
    const bad = checkCheckoutPrice({ mapping, price, plan, clientId, livemode });
    if (bad) refuse(bad.status, bad.code, bad.message);

    const link = await store.activeLink(clientId, livemode);
    if (!link) refuse(409, "no_customer", "Link or create the client's Stripe customer first.");

    // Duplicate subscription protection: Stripe's current state for the
    // customer (read now and synced), and the mirror for the client.
    const subs = await api.list("/v1/subscriptions", { customer: link!.stripe_customer_id, status: "all" });
    const blocking = subs.filter((s) => BLOCKING_SUBSCRIPTION_STATUSES.includes(s.status));
    for (const s of blocking) await sync.syncSubscription(s.id);
    const mirrored = await store.blockingSubscriptions(clientId, livemode);
    const all = new Map<string, string>();
    for (const s of blocking) all.set(s.id, s.status);
    for (const s of mirrored) all.set(s.stripe_subscription_id, s.status);
    if (all.size > 0) {
      refuse(409, "subscription_exists",
        `${client.name} already has a subscription (${[...all.values()].join(", ")}). Change it in Stripe instead of selling a second one.`,
        { subscriptions: [...all].map(([id, status]) => ({ id, status })) });
    }

    // One open link per client: an open session is re-read first (it may have
    // expired or completed since).
    const idempotencyKey = `compass-checkout-${clientId}-${requestId}`;
    for (const open of await store.openCheckouts(clientId, livemode)) {
      await sync.syncCheckoutSession(open.stripe_checkout_session_id);
    }
    const stillOpen = (await store.openCheckouts(clientId, livemode)).filter((o) => new Date(o.expires_at) > now());
    if (stillOpen.length > 0) {
      const o = stillOpen[0];
      if (o.request_id === requestId) return { created: false, checkout: await describeCheckout(o.stripe_checkout_session_id) };
      refuse(409, "checkout_open", "A payment link for this client is still open; expire it before creating another.",
        { checkout: await describeCheckout(o.stripe_checkout_session_id) });
    }

    const metadata = {
      compass_client_id: clientId,
      compass_package_id: mapping!.package_id,
      compass_package_price_id: mapping!.id,
      compass_request_id: requestId,
    };
    const params = (methods: string[]) => ({
      mode: "subscription",
      customer: link!.stripe_customer_id,
      client_reference_id: clientId,
      line_items: [{ price: mapping!.stripe_price_id, quantity: 1 }],
      payment_method_types: methods,
      success_url: `${cfg.appUrl}/checkout/complete`,
      cancel_url: `${cfg.appUrl}/checkout/canceled`,
      metadata,
      subscription_data: { metadata: { compass_client_id: clientId, compass_package_id: mapping!.package_id } },
    });
    let cs: StripeObject;
    let achOffered = true;
    try {
      cs = await api.post("/v1/checkout/sessions", params(["card", "us_bank_account"]), { idempotencyKey });
    } catch (e) {
      // ACH debit where the account can take it; card alone where it cannot.
      if (e instanceof StripeApiError && e.status === 400 && /payment_method_types/.test(e.param ?? "") && /us_bank_account/.test(e.message)) {
        achOffered = false;
        cs = await api.post("/v1/checkout/sessions", params(["card"]), { idempotencyKey: `${idempotencyKey}-card` });
      } else throw e;
    }
    if (cs.client_reference_id !== clientId || cs.metadata?.compass_request_id !== requestId) {
      refuse(409, "request_id_reused", "That request id created a different Checkout Session.");
    }
    const row = checkoutSessionRow(cs, now().toISOString());
    const recorded = await store.recordCheckout({
      ...row,
      client_id: clientId,
      package_id: mapping!.package_id,
      line_items: [{ price: mapping!.stripe_price_id, quantity: 1, package_price_id: mapping!.id, request_id: requestId }],
      created_by: memberOf(caller),
    });
    return { created: recorded.created, ach_offered: achOffered, checkout: await describeCheckout(cs.id) };
  }

  async function describeCheckout(sessionId: string) {
    return await store.checkoutSummary(sessionId);
  }

  async function expireCheckout({ api, livemode, caller, sync }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const sessionId = typeof body.session_id === "string" && /^cs_(test|live)_[A-Za-z0-9]+$/.test(body.session_id) ? body.session_id : null;
    if (!sessionId) refuse(400, "invalid_request", "session_id must be a Checkout Session id");
    const cs = await store.checkout(sessionId!);
    if (!cs || cs.client_id !== clientId) refuse(404, "checkout_not_found", "No such payment link for this client.");
    if (cs!.livemode !== livemode) refuse(409, "mode_mismatch", "That payment link is not in the current billing mode.");
    if (cs!.status === "open") {
      try {
        await api.post(`/v1/checkout/sessions/${sessionId}/expire`, {}, { idempotencyKey: `compass-expire-${sessionId}` });
      } catch (e) {
        // Already completed or expired in Stripe: the sync below records which.
        if (!(e instanceof StripeApiError && e.status === 400)) throw e;
      }
    }
    await sync.syncCheckoutSession(sessionId!);
    await store.audit({ client_id: clientId, action: "expire_checkout", ...actor(caller), livemode, subject: sessionId, detail: {} });
    return { checkout: await describeCheckout(sessionId!) };
  }

  // ── 7. Customer Portal ──────────────────────────────────────────────────
  async function configurePortal({ api, livemode, caller, cfg }: Ctx) {
    const mode = livemode ? "live" : "test";
    const setting = (await store.setting("billing_portal")) ?? {};
    const existing = setting[mode];
    if (existing?.configuration_id && existing.version === PORTAL_CONFIG_VERSION) {
      const current = await retrieve(api, `/v1/billing_portal/configurations/${existing.configuration_id}`);
      if (current && checkPortalConfig(current).length === 0) return { configuration_id: existing.configuration_id, created: false };
    }
    const conf = await api.post("/v1/billing_portal/configurations", portalConfigParams(cfg.appUrl),
      { idempotencyKey: `compass-portal-config-v${PORTAL_CONFIG_VERSION}-${mode}-${existing?.configuration_id ?? "first"}` });
    const problems = checkPortalConfig(conf);
    if (problems.length) refuse(502, "portal_config_unsafe", `Stripe returned a configuration Compass does not allow: ${problems.join("; ")}.`);
    await store.saveSetting("billing_portal", {
      ...setting,
      [mode]: { configuration_id: conf.id, version: PORTAL_CONFIG_VERSION, configured_at: now().toISOString(), configured_by: memberOf(caller) },
    });
    await store.audit({ client_id: null, action: "configure_portal", ...actor(caller), livemode, subject: conf.id,
      detail: { version: PORTAL_CONFIG_VERSION } });
    return { configuration_id: conf.id, created: true };
  }

  async function createPortalSession({ api, livemode, caller, cfg }: Ctx, body: Record<string, unknown>) {
    // A portal contact's client comes from the sign-in, never from the body.
    const clientId = caller.kind === "portal" ? caller.clientId : uuidOf(body, "client_id");
    await liveClient(clientId);
    const link = await store.activeLink(clientId, livemode);
    if (!link) refuse(404, "no_billing_account", "There is no billing account to manage yet.");
    const setting = (await store.setting("billing_portal")) ?? {};
    const confId = setting[livemode ? "live" : "test"]?.configuration_id;
    if (!confId) refuse(409, "portal_not_configured", "An admin has to configure the Customer Portal first.");
    const conf = await retrieve(api, `/v1/billing_portal/configurations/${confId}`);
    const problems = conf ? checkPortalConfig(conf) : ["configuration not found"];
    if (problems.length) {
      refuse(409, "portal_config_unsafe", `The Customer Portal configuration was changed in Stripe: ${problems.join("; ")}. An admin must reconfigure it.`);
    }
    const returnUrl = caller.kind === "portal" ? `${cfg.appUrl}/portal/billing` : `${cfg.appUrl}/clients/${clientId}/billing`;
    const session = await api.post("/v1/billing_portal/sessions", { customer: link!.stripe_customer_id, configuration: confId, return_url: returnUrl });
    await store.audit({ client_id: clientId, action: "portal_session", ...actor(caller), livemode, subject: link!.stripe_customer_id, detail: {} });
    return { url: session.url };
  }

  // ── 8. External payments ────────────────────────────────────────────────
  async function recordExternalPayment({ caller }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const requestId = uuidOf(body, "request_id");
    const amount = amountOf(body, "amount_cents");
    const currency = currencyOf(body);
    const method = body.method;
    if (!["check", "wire", "ach_manual", "other"].includes(method as string)) refuse(400, "invalid_request", "method must be check, wire, ach_manual or other");
    const paidAt = text(body, "paid_at", { required: true })!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || Number.isNaN(Date.parse(paidAt))) refuse(400, "invalid_request", "paid_at must be a date (YYYY-MM-DD)");
    if (Date.parse(paidAt) > now().getTime() + 86_400_000) refuse(400, "invalid_request", "paid_at is in the future");
    const reference = text(body, "reference", { max: 200 });
    const notes = text(body, "notes", { required: true, max: 2000 })!;
    if (!(await store.client(clientId))) refuse(404, "client_not_found", "No such client.");
    const r = await store.recordExternalPayment({
      client_id: clientId, amount_cents: amount, currency, paid_at: `${paidAt}T12:00:00Z`, external_method: method as string,
      reference, notes, recorded_by: memberOf(caller)!, client_request_id: requestId,
    });
    return { payment_id: r.id, created: r.created };
  }

  async function voidExternalPayment({ caller }: Ctx, body: Record<string, unknown>) {
    const clientId = uuidOf(body, "client_id");
    const paymentId = uuidOf(body, "payment_id");
    const reason = text(body, "reason", { required: true, max: 1000 })!;
    const r = await store.voidExternalPayment({ client_id: clientId, payment_id: paymentId, voided_by: memberOf(caller)!, reason });
    if (!r) refuse(404, "payment_not_found", "No unvoided external payment with that id for this client.");
    return { payment_id: paymentId, voided: true };
  }

  return { handle };
}

function actor(c: Caller) {
  return c.kind === "team"
    ? { actor_kind: "team" as const, actor_team_member_id: c.memberId }
    : { actor_kind: "portal" as const, actor_portal_user_id: c.portalUserId };
}
