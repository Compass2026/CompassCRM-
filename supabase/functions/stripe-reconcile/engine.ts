// The reconciliation engine (B4). Not a second sync: every Stripe read and
// every mirror write goes through the shared B2 layer (../_shared/stripe/sync.ts
// → billing_sync_apply), exactly as a webhook would. The engine only decides
// what to re-read, measures what changed (a fingerprint of the client's mirror
// before and after, 0060) and records the run.
//
//   1. Catalog: every Stripe Product the catalog maps, and all its Prices.
//   2. Customers: every active linked customer in the mode (the least recently
//      reconciled first), each through resyncCustomer, then the invoices
//      Compass holds that Stripe no longer lists, then Compass-created
//      Checkout Sessions that are not final. Two at a time.
//   3. Webhook ledger: failed events, and events whose processing lease
//      expired, are claimed and re-synced from Stripe's current state (the
//      stored payload is never replayed; the ledger keeps only the object id).
// Changes are measured in 1 and 2 (fingerprints before and after).
//
// One customer failing is recorded and the run goes on; an authentication or
// permission failure, a database failure, or three customers failing in a row
// fails the run. A time budget stops a large run cleanly (status partial); the
// next run starts with the customers this one did not reach.
//
// Stripe wins: nothing here writes to Stripe, and nothing changes agreements,
// entitlements or external payments.

import type { StripeApi } from "../_shared/stripe/api.ts";
import { StripeApiError } from "../_shared/stripe/api.ts";
import { createStripeSync, type OpResult, outcome, STRIPE_WEBHOOK_EVENTS } from "../_shared/stripe/sync.ts";
import type { ReconcileStore } from "./store.ts";

export type Fingerprint = Record<string, Record<string, string>>;
export type Changes = Record<string, number>;

// fingerprint kind → the category a new / changed / removed object counts as.
const CATEGORY: Record<string, { imported: string; updated: string; removed: string }> = {
  customer: { imported: "customer_updated", updated: "customer_updated", removed: "customer_removed" },
  subscription: { imported: "subscription_imported", updated: "subscription_updated", removed: "subscription_removed" },
  invoice: { imported: "invoice_imported", updated: "invoice_updated", removed: "invoice_removed" },
  payment: { imported: "payment_imported", updated: "payment_updated", removed: "payment_removed" },
  refund: { imported: "refund_imported", updated: "refund_updated", removed: "refund_removed" },
  checkout: { imported: "checkout_updated", updated: "checkout_updated", removed: "checkout_removed" },
  product: { imported: "catalog_product_imported", updated: "catalog_product_updated", removed: "catalog_product_removed" },
  price: { imported: "catalog_price_imported", updated: "catalog_price_updated", removed: "catalog_price_removed" },
};

// What changed between two fingerprints, by category.
export function diffFingerprints(before: Fingerprint, after: Fingerprint): { changes: Changes; total: number } {
  const changes: Changes = {};
  const add = (k: string) => { changes[k] = (changes[k] ?? 0) + 1; };
  for (const kind of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const cat = CATEGORY[kind] ?? { imported: `${kind}_imported`, updated: `${kind}_updated`, removed: `${kind}_removed` };
    const b = before?.[kind] ?? {};
    const a = after?.[kind] ?? {};
    for (const [id, digest] of Object.entries(a)) {
      if (!(id in b)) add(cat.imported);
      else if (b[id] !== digest) add(cat.updated);
    }
    for (const id of Object.keys(b)) if (!(id in a)) add(cat.removed);
  }
  return { changes, total: Object.values(changes).reduce((n, x) => n + x, 0) };
}

export function mergeChanges(into: Changes, add: Changes) {
  for (const [k, n] of Object.entries(add)) into[k] = (into[k] ?? 0) + n;
}

// Stripe objects a sync read, by kind (a result per object written or read).
export function countExamined(results: OpResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[r.op] = (out[r.op] ?? 0) + 1;
  return out;
}

export type ClientStatus = "healthy" | "repaired" | "attention" | "failed";
export function clientStatus(o: { error: string | null; changed: number; attention: string[]; warnings?: string[] }): ClientStatus {
  if (o.error) return "failed";
  if (o.attention.length > 0 || (o.warnings ?? []).length > 0) return "attention";
  return o.changed > 0 ? "repaired" : "healthy";
}

export type RunStatus = "completed" | "completed_with_errors" | "partial" | "failed";
export function runStatus(o: { failures: number; skipped: number }): RunStatus {
  if (o.failures > 0) return "completed_with_errors";
  return o.skipped > 0 ? "partial" : "completed";
}

// A failure no other customer would escape: the key, its permissions.
export function isSystemic(e: unknown): boolean {
  return e instanceof StripeApiError && (e.status === 401 || e.status === 403 || e.type === "authentication_error");
}

export class SystemicFailure extends Error {}

const SUPPORTED = new Set<string>(STRIPE_WEBHOOK_EVENTS);
const MAX_LISTED = 50; // warnings / failures kept in the summary

export type Tally = {
  customers_examined: number;
  customers_repaired: number;
  objects_examined: number;
  records_changed: number;
  warnings: number;
  failures: number;
  events_recovered: number;
  summary: {
    examined: Record<string, number>;
    changed: Changes;
    events: { claimed: number; recovered: number; ignored: number; failed: number };
    warnings: { client_id?: string; code: string; detail?: string }[];
    failures: { client_id?: string; event_id?: string; product_id?: string; error: string }[];
    skipped: number;
  };
};

export function newTally(): Tally {
  return {
    customers_examined: 0, customers_repaired: 0, objects_examined: 0, records_changed: 0, warnings: 0, failures: 0,
    events_recovered: 0,
    summary: { examined: {}, changed: {}, events: { claimed: 0, recovered: 0, ignored: 0, failed: 0 }, warnings: [], failures: [], skipped: 0 },
  };
}

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

// Up to `limit` at a time, in order. The first error stops new work; the
// items already started finish before it is thrown (no stray writes after the
// run is closed).
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: { e: unknown } | null = null;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failed ??= { e };
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw (failed as { e: unknown }).e;
}

export async function reconcile(deps: {
  api: StripeApi;
  store: ReconcileStore;
  runId: string;
  livemode: boolean;
  scopeClientId: string | null;
  tally: Tally;
  now?: () => Date;
  budgetMs?: number;
  concurrency?: number;
  eventLimit?: number;
}): Promise<Tally> {
  const { api, store, runId, livemode, tally } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  const deadline = now().getTime() + (deps.budgetMs ?? 300_000);
  const sync = createStripeSync({ api, store, now });
  const s = tally.summary;
  const examine = (results: OpResult[]) => {
    for (const [k, n] of Object.entries(countExamined(results))) {
      s.examined[k] = (s.examined[k] ?? 0) + n;
      tally.objects_examined += n;
    }
  };
  const warn = (w: { client_id?: string; code: string; detail?: string }) => {
    tally.warnings += 1;
    if (s.warnings.length < MAX_LISTED) s.warnings.push(w);
  };
  const fail = (f: { client_id?: string; event_id?: string; product_id?: string; error: string }) => {
    tally.failures += 1;
    if (s.failures.length < MAX_LISTED) s.failures.push(f);
  };

  // Preflight: the key works. An authentication failure fails the run here.
  await api.get("/v1/customers", { limit: 1 });

  // ── 1. The catalog (agency-wide runs only) ─────────────────────────────
  if (!deps.scopeClientId) {
    const before = await store.catalogFingerprint(livemode);
    for (const productId of await store.mappedProducts(livemode)) {
      try {
        examine(await sync.syncProductWithPrices(productId));
      } catch (e) {
        if (isSystemic(e)) throw e;
        fail({ product_id: productId, error: message(e) });
      }
    }
    const d = diffFingerprints(before, await store.catalogFingerprint(livemode));
    mergeChanges(s.changed, d.changes);
    tally.records_changed += d.total;
    for (const w of await store.catalogWarnings(livemode)) warn(w);
  }

  // ── 2. Linked customers ────────────────────────────────────────────────
  const links = await store.linkedCustomers(livemode, deps.scopeClientId);
  let consecutive = 0;
  let lastError = "";
  await mapLimit(links, deps.concurrency ?? 2, async (link) => {
    if (now().getTime() > deadline) {
      s.skipped += 1;
      return;
    }
    tally.customers_examined += 1;
    const warnings: string[] = [];
    let error: string | null = null;
    let changes: Changes = {};
    let changed = 0;
    let objects = 0;
    try {
      const before = await store.fingerprint(link.client_id, livemode);
      const results = await sync.resyncCustomer(link.stripe_customer_id);
      if (results.some((r) => r.op === "deleted")) {
        warnings.push("customer_deleted_in_stripe");
      } else {
        // Invoices Compass holds that Stripe no longer lists (deleted drafts).
        const listed = new Set(results.filter((r) => r.op === "invoice").map((r) => r.id));
        for (const id of await store.mirrorInvoiceIds(link.client_id, link.stripe_customer_id, livemode)) {
          if (!listed.has(id)) results.push(...await sync.syncInvoice(id));
        }
        // Compass-created Checkout Sessions not final yet: Stripe says what they are.
        for (const id of await store.pendingCheckouts(link.client_id, livemode)) {
          try {
            results.push(...await sync.syncCheckoutSession(id));
          } catch (e) {
            if (e instanceof StripeApiError && e.missing) warnings.push(`checkout_missing:${id}`);
            else throw e;
          }
        }
      }
      objects = results.length;
      examine(results);
      const d = diffFingerprints(before, await store.fingerprint(link.client_id, livemode));
      changes = d.changes;
      changed = d.total;
      consecutive = 0;
    } catch (e) {
      if (isSystemic(e)) throw e;
      error = message(e);
      consecutive += 1;
      lastError = error;
      fail({ client_id: link.client_id, error });
      if (consecutive >= 3) {
        await record();
        throw new SystemicFailure(`Three customers failed in a row; stopping. Last: ${lastError}`);
      }
    }
    await record();

    async function record() {
      const attention = error ? [] : await store.attention(link.client_id);
      for (const w of warnings) warn({ client_id: link.client_id, code: w });
      if (changed > 0) tally.customers_repaired += 1;
      tally.records_changed += changed;
      mergeChanges(s.changed, changes);
      await store.recordClient({
        run_id: runId, client_id: link.client_id, stripe_customer_id: link.stripe_customer_id,
        status: clientStatus({ error, changed, attention, warnings }), records_changed: changed, changes,
        objects_examined: objects, attention_reasons: attention, warnings, error,
      });
    }
  });
  // ── 3. The webhook ledger (agency-wide runs only) ──────────────────────
  // Last, so the measured passes above have already repaired what the
  // failed deliveries were about; this clears the ledger and catches objects
  // no customer pass covers.
  if (!deps.scopeClientId) {
    for (const ev of await store.recoverableEvents(livemode, deps.eventLimit ?? 100)) {
      const claim = await store.beginEvent(ev);
      if (!claim.claimed) continue;
      s.events.claimed += 1;
      if (!SUPPORTED.has(ev.type) || !ev.object_id || !ev.object_type) {
        await store.finishEvent(ev.id, claim.attempt, "ignored", "unsupported_event");
        s.events.ignored += 1;
        continue;
      }
      try {
        const results = await sync.syncEvent({
          id: ev.id, type: ev.type, livemode: ev.livemode,
          created: Math.floor(new Date(ev.event_created_at).getTime() / 1000),
          data: { object: { id: ev.object_id, object: ev.object_type } },
        });
        examine(results ?? []);
        const o = results ? outcome(results) : { status: "ignored" as const, reason: "unsupported_object" };
        await store.finishEvent(ev.id, claim.attempt, o.status, o.status === "ignored" ? o.reason : null);
        if (o.status === "processed") {
          s.events.recovered += 1;
          tally.events_recovered += 1;
        } else s.events.ignored += 1;
      } catch (e) {
        await store.failEvent(ev.id, claim.attempt, `reconciliation: ${message(e)}`).catch(() => undefined);
        if (isSystemic(e)) throw e;
        s.events.failed += 1;
        fail({ event_id: ev.id, error: message(e) });
      }
    }
  }

  return tally;
}
