// POST /api/billing — the Billing tab's and the portal's operations (the
// stripe-billing handler, unchanged). The caller is the signed-in teammate or
// portal contact whose Supabase JWT the CRM forwards; the handler resolves
// their role and refuses what it does not allow.
import { createStripeApi } from "../../../supabase/functions/_shared/stripe/api.ts";
import { createStripeBilling } from "../../../supabase/functions/stripe-billing/handler.ts";
import { appBaseUrl, billingStore, nodeEntry, stripeKey } from "../runtime.ts";

let billing: ReturnType<typeof createStripeBilling> | null = null;

export default nodeEntry(async (req) => {
  billing ??= createStripeBilling({
    config: async () => {
      const secretKey = stripeKey();
      return secretKey ? { secretKey, appUrl: appBaseUrl() } : null;
    },
    store: billingStore(),
    makeApi: (secretKey) => createStripeApi({ secretKey }),
  });
  return billing.handle(req);
});
