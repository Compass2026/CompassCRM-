// /api/reconcile — the safety net (the stripe-reconcile handler, unchanged).
//   GET  from Vercel Cron, daily: Authorization: Bearer $CRON_SECRET, run
//        agency-wide as the scheduler (it replaces 0061's pg_cron caller);
//   POST from the CRM with an admin's JWT: {} or {client_id}.
// It answers 202 {run_id} and finishes under Vercel's waitUntil, within this
// function's duration; a run cut short by its time budget is continued by the
// next one (least recently reconciled clients first).
import { createStripeApi } from "../../../supabase/functions/_shared/stripe/api.ts";
import { createStripeReconcile } from "../../../supabase/functions/stripe-reconcile/handler.ts";
import { billingStore, env, nodeEntry, sameSecret, stripeKey } from "../runtime.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default nodeEntry(async (req, work) => {
  const reconcile = createStripeReconcile({
    config: async () => {
      const secretKey = stripeKey();
      return secretKey ? { secretKey } : null;
    },
    store: billingStore(),
    makeApi: (secretKey) => createStripeApi({ secretKey }),
    waitUntil: work.waitUntil,
    budgetMs: 45_000,
  });
  if (req.method === "GET") {
    const cronSecret = env("CRON_SECRET");
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(bearer, cronSecret)) return json(401, { error: "invalid_secret" });
    return reconcile.handle(new Request(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-billing-reconcile-secret": cronSecret! },
      body: "{}",
    }));
  }
  if (req.headers.has("x-billing-reconcile-secret")) return json(401, { error: "invalid_secret" });
  return reconcile.handle(req);
});
