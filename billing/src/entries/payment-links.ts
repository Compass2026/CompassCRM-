import { createStripeApi } from "../../../supabase/functions/_shared/stripe/api.ts";
import { createStripeBilling } from "../../../supabase/functions/stripe-billing/handler.ts";
import { createPaymentLinks } from "../payment-links.ts";
import { appBaseUrl, billingStore, database, nodeEntry, stripeKey } from "../runtime.ts";

let handler: ReturnType<typeof createPaymentLinks> | null = null;
export default nodeEntry(async (req) => {
  if (!handler) {
    const store = billingStore();
    const billing = createStripeBilling({ store, makeApi: (secretKey) => createStripeApi({ secretKey }),
      config: async () => { const secretKey = stripeKey(); return secretKey ? { secretKey, appUrl: appBaseUrl() } : null; } });
    handler = createPaymentLinks({ store, appUrl: appBaseUrl(), checkout: billing.checkoutForPaymentLink,
      links: {
        read: async (hash) => (await database().query("select public.billing_payment_link_read($1) as r", [hash])).rows[0].r,
        write: async (p) => (await database().query("select public.billing_payment_link_write($1::jsonb) as r", [JSON.stringify(p)])).rows[0].r,
      } });
  }
  return handler(req);
});
