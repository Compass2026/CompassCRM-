import type { createClient } from "@/lib/supabase/server";
import type { BillingAnswer } from "@/lib/billing-ops";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// Calls the billing backend with the signed-in person's own JWT: the backend
// resolves who is asking (admin, member, portal contact) and refuses anything
// their role does not allow. A plain server module, not an action: callers are
// server actions that have already checked the caller. Nothing about Stripe is
// decided here, and no Stripe key is ever in the app.
export function callStripeBilling(supabase: Supabase, body: Record<string, unknown>): Promise<BillingAnswer> {
  return callBillingFunction(supabase, "stripe-billing", body);
}

// Reconciliation (B4) with the admin's own JWT: the same engine the daily
// schedule runs. It answers 202 {run_id} and works in the background.
export function callStripeReconcile(supabase: Supabase, body: Record<string, unknown>): Promise<BillingAnswer> {
  return callBillingFunction(supabase, "stripe-reconcile", body);
}

type Target = { url: string; headers: Record<string, string> } | { error: string };

// Where billing runs (docs/billing-runtime.md). BILLING_API_URL (server-only)
// set: the dedicated compass-billing project (Option B), which holds the
// Stripe key and its own database login. Unset: the Supabase Edge Functions —
// the TEST setup before cutover, and the rollback (unset it and redeploy).
export function billingTarget(name: "stripe-billing" | "stripe-reconcile", env: Record<string, string | undefined> = process.env): Target {
  const base = env.BILLING_API_URL?.trim().replace(/\/$/, "");
  if (base) {
    if (!/^https:\/\/[^\s/?#]+$/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
      return { error: "BILLING_API_URL must be the billing project's https origin" };
    }
    return { url: `${base}/api/${name === "stripe-billing" ? "billing" : "reconcile"}`, headers: {} };
  }
  return {
    url: `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${name}`,
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" },
  };
}

async function callBillingFunction(supabase: Supabase, name: "stripe-billing" | "stripe-reconcile", body: Record<string, unknown>): Promise<BillingAnswer> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { status: 401, body: { error: "not_signed_in" } };
  const target = billingTarget(name);
  if ("error" in target) return { status: 503, body: { error: "billing_not_configured", detail: target.error } };
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        ...target.headers,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    // Timeout or network error: the action may or may not have gone through.
    return { status: null, body: null };
  }
}
