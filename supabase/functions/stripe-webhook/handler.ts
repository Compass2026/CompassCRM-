// stripe-webhook (B2): Stripe's near-real-time notice that something changed.
// Stripe runs the billing; this only tells Compass to re-read the object.
//
//   receive → verify the Stripe signature → claim the event in the ledger
//   (one delivery works it; a concurrent duplicate gets 409, a finished one
//   200) → read the object from Stripe now and write it through the shared
//   sync layer → mark the event processed / ignored → 200.
//   A sync failure is recorded on the event (failed, with the error) and
//   answered 500, so Stripe retries; the event is never marked processed.
//
// Deployed with verify_jwt = false (Stripe sends no Supabase JWT): the
// signature is the authentication. A factory over its dependencies so the
// real request boundary runs in tests with a fake Stripe and a fake or real
// store (tests/stripe-webhook-handler.test.mjs, tests/stripe-webhook-integration.mjs).

import type { StripeApi, StripeObject } from "../_shared/stripe/api.ts";
import { ts } from "../_shared/stripe/map.ts";
import { verifyStripeSignature } from "../_shared/stripe/signature.ts";
import type { StripeStore } from "../_shared/stripe/store.ts";
import { createStripeSync, outcome, STRIPE_WEBHOOK_EVENTS } from "../_shared/stripe/sync.ts";

export const STRIPE_WEBHOOK_VERSION = 1;

export type WebhookConfig = { secretKey: string; webhookSecret: string };

const SUPPORTED = new Set<string>(STRIPE_WEBHOOK_EVENTS);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createStripeWebhook(deps: {
  config: () => Promise<WebhookConfig | null>;
  store: StripeStore;
  makeApi: (secretKey: string) => StripeApi;
  nowSeconds?: () => number;
  leaseSeconds?: number;
}) {
  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const cfg = await deps.config();
    if (!cfg) return json(503, { error: "stripe_not_configured" });

    const payload = await req.text();
    const check = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), cfg.webhookSecret, {
      now: deps.nowSeconds?.(),
    });
    if (!check.ok) return json(400, { error: "invalid_signature", reason: check.reason });

    let event: StripeObject;
    try {
      event = JSON.parse(payload);
    } catch {
      return json(400, { error: "invalid_payload" });
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") return json(400, { error: "invalid_payload" });

    const api = deps.makeApi(cfg.secretKey);
    // A live key only processes once an admin has switched billing to live
    // (app_settings 'billing'); until then Compass stays in test mode.
    if (api.mode === "live" && !(await deps.store.billingLivemode())) {
      return json(503, { error: "live_mode_not_enabled" });
    }

    const obj = event.data?.object ?? {};
    let claim;
    try {
      claim = await deps.store.beginEvent({
        id: event.id,
        type: event.type,
        livemode: !!event.livemode,
        api_version: event.api_version ?? null,
        event_created_at: ts(event.created) ?? new Date().toISOString(),
        object_type: typeof obj.object === "string" ? obj.object : null,
        object_id: typeof obj.id === "string" ? obj.id : null,
      }, deps.leaseSeconds);
    } catch (e) {
      return json(500, { error: "ledger_unavailable", detail: String((e as Error).message ?? e) });
    }
    if (!claim.claimed) {
      return claim.state === "done"
        ? json(200, { received: true, duplicate: true })
        : json(409, { error: "in_progress" });
    }

    const finish = (status: "processed" | "ignored", reason: string | null = null) =>
      deps.store.finishEvent(event.id, claim.attempt, status, reason);

    if ((api.mode === "live") !== !!event.livemode) {
      await finish("ignored", "mode_mismatch");
      return json(200, { received: true, ignored: "mode_mismatch" });
    }
    if (!SUPPORTED.has(event.type)) {
      await finish("ignored", "unsupported_event");
      return json(200, { received: true, ignored: "unsupported_event" });
    }

    try {
      const sync = createStripeSync({ api, store: deps.store });
      const results = await sync.syncEvent(event);
      const o = results ? outcome(results) : { status: "ignored" as const, reason: "unsupported_object" };
      await finish(o.status, o.status === "ignored" ? o.reason : null);
      return json(200, { received: true, ...o, results: results ?? [] });
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      await deps.store.failEvent(event.id, claim.attempt, message).catch(() => undefined);
      return json(500, { error: "sync_failed", detail: message });
    }
  }
  return { handle };
}
