"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Stripe calls go through the stripe-billing Edge Function so the secret key
// stays in Supabase Vault — same pattern as the BrightLocal/GSC syncs.
async function callStripeBilling(
  clientId: string,
  action: "setup" | "pause" | "resume"
) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-billing`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, client_id: clientId }),
    }
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error ?? `Billing action failed (${res.status})`);
  }
  revalidatePath(`/clients/${clientId}/billing`);
  revalidatePath(`/clients/${clientId}/plan`);
  return payload;
}

// Creates the Stripe customer + monthly subscription from the saved plan.
export async function setupBillingAction(clientId: string) {
  await callStripeBilling(clientId, "setup");
}

export async function pauseSubscriptionAction(clientId: string) {
  await callStripeBilling(clientId, "pause");
}

export async function resumeSubscriptionAction(clientId: string) {
  await callStripeBilling(clientId, "resume");
}
