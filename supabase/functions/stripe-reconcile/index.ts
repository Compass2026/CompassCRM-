// Deployed entry point (verify_jwt = true: the scheduler sends the anon key
// plus its own secret; an admin sends their JWT). The logic is handler.ts and
// engine.ts over the shared Stripe sync layer (../_shared/stripe/), tested
// with a fake Stripe and against PostgREST (tests/stripe-reconcile-handler.test.mjs,
// tests/stripe-reconcile-integration.mjs). Secrets come from Vault through
// get_secret (service role): STRIPE_SECRET_KEY (a TEST key until go-live) and
// BILLING_RECONCILE_SECRET (the scheduler's).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createStripeApi } from "../_shared/stripe/api.ts";
import { createStripeReconcile, type ReconcileConfig } from "./handler.ts";
import { createReconcileStore } from "./store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = createReconcileStore(supabase);

let cached: { at: number; cfg: ReconcileConfig } | null = null;
async function config(): Promise<ReconcileConfig | null> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.cfg;
  const secretKey = await store.secret("STRIPE_SECRET_KEY");
  if (!secretKey) return null;
  cached = { at: Date.now(), cfg: { secretKey } };
  return cached.cfg;
}

const reconcile = createStripeReconcile({ config, store, makeApi: (secretKey) => createStripeApi({ secretKey }) });
Deno.serve((req) => reconcile.handle(req));
