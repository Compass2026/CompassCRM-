// POST /api/stripe/webhook — Stripe's events (the stripe-webhook handler,
// unchanged): the Stripe-Signature header is verified against this endpoint's
// STRIPE_WEBHOOK_SECRET over the raw body, then every object is re-read from
// Stripe and written through the shared sync as billing_sync.
import { createStripeApi } from "../../../supabase/functions/_shared/stripe/api.ts";
import { createStripeWebhook } from "../../../supabase/functions/stripe-webhook/handler.ts";
import { billingStore, env, nodeEntry, stripeKey } from "../runtime.ts";

let webhook: ReturnType<typeof createStripeWebhook> | null = null;

export default nodeEntry(async (req) => {
  webhook ??= createStripeWebhook({
    config: async () => {
      const secretKey = stripeKey();
      const webhookSecret = env("STRIPE_WEBHOOK_SECRET");
      return secretKey && webhookSecret ? { secretKey, webhookSecret } : null;
    },
    store: billingStore(),
    makeApi: (secretKey) => createStripeApi({ secretKey }),
  });
  return webhook.handle(req);
});
