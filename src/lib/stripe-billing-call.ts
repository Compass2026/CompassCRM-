import type { createClient } from "@/lib/supabase/server";
import type { BillingAnswer } from "@/lib/billing-ops";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// Calls the deployed stripe-billing function with the signed-in person's own
// JWT: the function resolves who is asking (admin, member, portal contact)
// and refuses anything their role does not allow. A plain server module, not
// an action: callers are server actions that have already checked the caller.
// Nothing about Stripe is decided here, and no Stripe key is ever in the app.
export async function callStripeBilling(supabase: Supabase, body: Record<string, unknown>): Promise<BillingAnswer> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { status: 401, body: { error: "not_signed_in" } };
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-billing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
