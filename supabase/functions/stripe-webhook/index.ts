// Deployed entry point (verify_jwt = false: Stripe signs, it sends no JWT).
// The logic is handler.ts over the shared Stripe sync layer
// (../_shared/stripe/), tested with a fake Stripe and against PostgREST.
// Secrets come from Vault through get_secret (service role): the endpoint's
// STRIPE_WEBHOOK_SECRET and STRIPE_SECRET_KEY (a TEST key until go-live).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createStripeApi } from "../_shared/stripe/api.ts";
import { createStripeStore } from "../_shared/stripe/store.ts";
import { createStripeWebhook, type WebhookConfig } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = createStripeStore(supabase);

// Secrets are read at most every five minutes per isolate, so a rotation in
// Vault takes effect without a redeploy.
let cached: { at: number; cfg: WebhookConfig } | null = null;
async function config(): Promise<WebhookConfig | null> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.cfg;
  const [secretKey, webhookSecret] = await Promise.all([
    store.secret("STRIPE_SECRET_KEY"),
    store.secret("STRIPE_WEBHOOK_SECRET"),
  ]);
  if (!secretKey || !webhookSecret) return null;
  cached = { at: Date.now(), cfg: { secretKey, webhookSecret } };
  return cached.cfg;
}

const webhook = createStripeWebhook({ config, store, makeApi: (secretKey) => createStripeApi({ secretKey }) });
Deno.serve((req) => webhook.handle(req));
