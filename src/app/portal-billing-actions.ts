"use server";

// The portal's Manage billing button (B5). It asks stripe-billing for a
// Stripe Customer Portal session with the portal contact's own sign-in and
// sends NO client id: the function derives the client from the sign-in and
// refuses any other (B3). The Customer Portal configuration Compass allows
// (payment method, invoices, billing contact details; no cancel, plan or
// quantity changes) is re-checked by the function before every session.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { callStripeBilling } from "@/lib/stripe-billing-call";
import { MANAGE_BILLING_UNAVAILABLE } from "@/lib/portal-billing";

export async function openPortalBillingAction() {
  const supabase = await createClient();
  const answer = await callStripeBilling(supabase, { action: "create_portal_session" });
  const url = answer.status === 200 ? answer.body?.url : null;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    redirect(`/portal/billing?error=${encodeURIComponent(MANAGE_BILLING_UNAVAILABLE)}`);
  }
  redirect(url);
}
