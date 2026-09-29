// Deployed entry point (verify_jwt = true: every caller is a signed-in
// teammate or portal contact). The logic is handler.ts over the shared Stripe
// sync layer (../_shared/stripe/), tested with a fake Stripe and against
// PostgREST (tests/stripe-billing-handler.test.mjs, tests/stripe-billing-integration.mjs).
// Secrets come from Vault through get_secret (service role): STRIPE_SECRET_KEY
// (a TEST key until go-live) and, optionally, APP_BASE_URL for the Checkout
// return pages and the Customer Portal's return link.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createStripeApi } from "../_shared/stripe/api.ts";
import { type BillingConfig, createStripeBilling } from "./handler.ts";
import { createBillingStore } from "./store.ts";

const DEFAULT_APP_URL = "https://compass-crm-ten.vercel.app";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = createBillingStore(supabase);

// Read at most every five minutes per isolate, so a rotation in Vault takes
// effect without a redeploy.
let cached: { at: number; cfg: BillingConfig } | null = null;
async function config(): Promise<BillingConfig | null> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.cfg;
  const [secretKey, appUrl] = await Promise.all([store.secret("STRIPE_SECRET_KEY"), store.secret("APP_BASE_URL")]);
  if (!secretKey) return null;
  const url = (appUrl && /^https:\/\/[^\s/]+$/.test(appUrl.replace(/\/$/, ""))) ? appUrl.replace(/\/$/, "") : DEFAULT_APP_URL;
  cached = { at: Date.now(), cfg: { secretKey, appUrl: url } };
  return cached.cfg;
}

const billing = createStripeBilling({ config, store, makeApi: (secretKey) => createStripeApi({ secretKey }) });
Deno.serve((req) => billing.handle(req));
