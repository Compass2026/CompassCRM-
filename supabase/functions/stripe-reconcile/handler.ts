// stripe-reconcile (B4): the safety net behind the webhook. It re-reads what
// Stripe holds and repairs the Compass mirror through the shared B2 sync, then
// records the run (engine.ts). Stripe wins; nothing is written to Stripe.
//
// Callers (POST; the function is deployed with verify_jwt = true, so the
// gateway also wants a JWT — the scheduler sends the anon key):
//   - the scheduler: header x-billing-reconcile-secret = Vault
//     BILLING_RECONCILE_SECRET (pg_cron → billing_fire_reconciliation(), 0060;
//     not scheduled until cutover). Agency-wide only.
//   - an admin, with their own JWT: {} for an agency-wide run (Settings) or
//     {client_id} for one client (the Billing tab). The same engine either way.
// A member, a portal contact or a stranger is refused; so is anything else.
//
// It answers 202 {run_id} once the run is recorded and works in the
// background (EdgeRuntime.waitUntil); the run row says how it ended. One run
// at a time per mode (409 run_in_progress).
//
// The shared service-role key residual (docs/billing.md) applies: any Edge
// Function in the project could call the functions this one calls.

import type { StripeApi } from "../_shared/stripe/api.ts";
import { StripeApiError } from "../_shared/stripe/api.ts";
import { BillingDbError } from "../stripe-billing/store.ts";
import { isSystemic, newTally, reconcile, runStatus, SystemicFailure, type Tally } from "./engine.ts";
import type { ReconcileStore } from "./store.ts";

export const STRIPE_RECONCILE_VERSION = 1;

export type ReconcileConfig = { secretKey: string };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Constant-time comparison of the scheduler's secret.
export function sameSecret(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export function createStripeReconcile(deps: {
  config: () => Promise<ReconcileConfig | null>;
  store: ReconcileStore;
  makeApi: (secretKey: string) => StripeApi;
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => Date;
  budgetMs?: number;
  concurrency?: number;
}) {
  const { store } = deps;
  const waitUntil = deps.waitUntil ?? ((p: Promise<unknown>) => {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
  });

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(400, { error: "invalid_request", detail: "body must be JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid_request" });

    try {
      // ── Who is asking ────────────────────────────────────────────────────
      let trigger: "schedule" | "admin" | "admin_client";
      let requestedBy: string | null = null;
      let scope: string | null = null;
      const header = req.headers.get("x-billing-reconcile-secret");
      if (header) {
        if (!sameSecret(header, await store.secret("BILLING_RECONCILE_SECRET"))) return json(401, { error: "invalid_secret" });
        if (body.client_id !== undefined) return json(400, { error: "invalid_request", detail: "the scheduler runs agency-wide" });
        trigger = "schedule";
      } else {
        const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        const caller = await store.caller(jwt);
        if (caller === "none") return json(401, { error: "not_signed_in" });
        if (!caller || caller.kind !== "team") return json(403, { error: "forbidden", detail: "Reconciliation is for Compass admins." });
        if (caller.role !== "admin") return json(403, { error: "admin_only", detail: "Only an admin starts a billing reconciliation." });
        requestedBy = caller.memberId;
        if (body.client_id !== undefined) {
          if (typeof body.client_id !== "string" || !UUID.test(body.client_id)) return json(400, { error: "invalid_request", detail: "client_id must be a uuid" });
          scope = body.client_id.toLowerCase();
          trigger = "admin_client";
        } else trigger = "admin";
      }

      // ── Stripe and the mode ─────────────────────────────────────────────
      const cfg = await deps.config();
      if (!cfg) return json(503, { error: "stripe_not_configured", detail: "STRIPE_SECRET_KEY is not in Vault." });
      const api = deps.makeApi(cfg.secretKey);
      const livemode = api.mode === "live";
      const settingLive = await store.billingLivemode();
      if (livemode && !settingLive) return json(503, { error: "live_mode_not_enabled", detail: "A live key reconciles only after billing is switched to live." });
      if (!livemode && settingLive) return json(503, { error: "key_mode_mismatch", detail: "Billing is in live mode but the key is a test key." });

      if (scope) {
        const client = await store.client(scope);
        if (!client) return json(404, { error: "client_not_found" });
        if (!(await store.activeLink(scope, livemode))) return json(404, { error: "no_customer", detail: "The client has no linked Stripe customer in this mode." });
      }

      // ── Begin, answer, work in the background ─────────────────────────────
      let run: { id: string };
      try {
        run = await store.beginRun({ livemode, trigger, requested_by: requestedBy, scope_client_id: scope });
      } catch (e) {
        if (e instanceof BillingDbError && e.code === "55P03") return json(409, { error: "run_in_progress", detail: "A billing reconciliation is already running." });
        if (e instanceof BillingDbError && e.code === "42501") return json(403, { error: "forbidden", detail: e.message });
        throw e;
      }
      const work = execute(run.id, api, livemode, scope);
      waitUntil(work);
      return json(202, { run_id: run.id, livemode, trigger });
    } catch (e) {
      return json(500, { error: "failed", detail: String((e as Error)?.message ?? e) });
    }
  }

  // Run the engine and close the run however it ends. Never throws.
  async function execute(runId: string, api: StripeApi, livemode: boolean, scope: string | null): Promise<Tally> {
    const tally = newTally();
    try {
      await reconcile({ api, store, runId, livemode, scopeClientId: scope, tally, now: deps.now, budgetMs: deps.budgetMs, concurrency: deps.concurrency });
      await store.finishRun({ run_id: runId, status: runStatus({ failures: tally.failures, skipped: tally.summary.skipped }), ...counters(tally) });
    } catch (e) {
      const reason = e instanceof SystemicFailure
        ? e.message
        : e instanceof StripeApiError && isSystemic(e)
          ? `Stripe refused the key (${e.status}): ${e.message}`
          : `Reconciliation failed: ${String((e as Error)?.message ?? e)}`;
      await store.finishRun({ run_id: runId, status: "failed", error: reason.slice(0, 1000), ...counters(tally) }).catch(() => undefined);
    }
    return tally;
  }

  return { handle, execute };
}

function counters(t: Tally) {
  return {
    customers_examined: t.customers_examined, customers_repaired: t.customers_repaired, objects_examined: t.objects_examined,
    records_changed: t.records_changed, warnings: t.warnings, failures: t.failures, events_recovered: t.events_recovered,
    summary: t.summary,
  };
}
