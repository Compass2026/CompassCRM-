"use server";

// The Billing tab's actions (B3). Every Stripe write is the stripe-billing
// Edge Function's: these actions check the caller is on the team, pass on
// only ids and what the teammate typed, and report the function's answer.
// The function decides everything that matters — the client's customer, the
// approved price, the amount, the mode — and refuses what the caller's role
// does not allow (admin-only actions are refused for a member there, and the
// database refuses them again).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { callStripeBilling } from "@/lib/stripe-billing-call";
import { billingAnswerText, isOk, isUuid, readCustomPrice, readExternalPayment } from "@/lib/billing-ops";

function field(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" ? v : null;
}

const tab = (clientId: string) => `/clients/${clientId}/billing`;

function back(clientId: string, kind: "notice" | "error", message: string): never {
  revalidatePath(tab(clientId));
  revalidatePath(`/clients/${clientId}/plan`);
  redirect(`${tab(clientId)}?${kind}=${encodeURIComponent(message)}`);
}

async function teamClient(clientId: string) {
  if (!isUuid(clientId)) redirect("/clients");
  const supabase = await createClient();
  try {
    await requireTeamMember(supabase);
  } catch {
    redirect("/login");
  }
  return supabase;
}

async function run(clientId: string, body: Record<string, unknown>, ok: string): Promise<never> {
  const supabase = await teamClient(clientId);
  const answer = await callStripeBilling(supabase, { client_id: clientId, ...body });
  if (!isOk(answer)) back(clientId, "error", billingAnswerText(answer));
  back(clientId, "notice", ok);
}

// ── 1. Existing customers ─────────────────────────────────────────────────
export type CustomerSearchResult = {
  id: string;
  name: string | null;
  email: string | null;
  livemode: boolean;
  deleted: boolean;
  created: number | null;
  compass_client_id: string | null;
  subscriptions: { id: string; status: string }[];
  linked_client: { id: string; name: string; active: boolean } | null;
  mode_matches: boolean;
};
export type CustomerSearch = { ok: true; livemode: boolean; customers: CustomerSearchResult[] } | { ok: false; text: string };

export async function searchStripeCustomersAction(clientId: string, query: string): Promise<CustomerSearch> {
  const supabase = await teamClient(clientId);
  const q = (query ?? "").trim();
  if (q.length < 2) return { ok: false, text: "Type at least two characters: a name, an email or a cus_ id." };
  const answer = await callStripeBilling(supabase, { action: "search_customers", query: q });
  if (!isOk(answer)) return { ok: false, text: billingAnswerText(answer) };
  const body = answer.body as { livemode: boolean; customers: CustomerSearchResult[] };
  return { ok: true, livemode: body.livemode, customers: body.customers };
}

export async function linkStripeCustomerAction(clientId: string, form: FormData) {
  const customerId = field(form, "customer_id") ?? "";
  if (form.get("confirm") !== "on") back(clientId, "error", "Tick the box to confirm this is the client's Stripe customer.");
  await run(clientId, { action: "link_customer", customer_id: customerId, confirm: true },
    `Linked ${customerId}. Its subscriptions, invoices and payments were imported from Stripe.`);
}

// ── 2. New customer ───────────────────────────────────────────────────────
export async function createStripeCustomerAction(clientId: string, form: FormData) {
  const email = field(form, "email")?.trim() ?? "";
  if (!email) back(clientId, "error", "Enter the client's billing email.");
  await run(clientId, { action: "create_customer", email, name: field(form, "name")?.trim() || null },
    "Created the client's Stripe customer.");
}

export async function resyncStripeCustomerAction(clientId: string) {
  await run(clientId, { action: "resync_customer" }, "Re-read the customer's billing from Stripe.");
}

// ── 4/5. Custom retainer price and Checkout ───────────────────────────────
export async function createCustomPriceAction(clientId: string, packageId: string, form: FormData) {
  const read = readCustomPrice({
    amount: field(form, "amount"), interval: field(form, "interval"), nickname: field(form, "nickname"), request_id: field(form, "request_id"),
  });
  if ("error" in read) back(clientId, "error", read.error);
  await run(clientId, { action: "create_custom_price", package_id: packageId, ...read.body },
    "Created the client's retainer price in Stripe. It can now be sold with a payment link.");
}

// The price is never the browser's: stripe-billing sells exactly the price the
// client's agreement is bound to (plans.billing_package_price_id).
export async function createCheckoutAction(clientId: string, form: FormData) {
  const requestId = field(form, "request_id");
  if (!isUuid(requestId)) back(clientId, "error", "The form expired. Reload the page and try again.");
  await run(clientId, { action: "create_checkout", request_id: requestId },
    "Payment link ready. Copy it and send it to the client.");
}

export async function expireCheckoutAction(clientId: string, sessionId: string) {
  await run(clientId, { action: "expire_checkout", session_id: sessionId }, "The payment link was expired.");
}

// ── 7. Customer Portal (a teammate acting for the client) ─────────────────
export async function openCustomerPortalAction(clientId: string) {
  const supabase = await teamClient(clientId);
  const answer = await callStripeBilling(supabase, { action: "create_portal_session", client_id: clientId });
  if (!isOk(answer) || typeof answer.body?.url !== "string" || !answer.body.url.startsWith("https://")) {
    back(clientId, "error", billingAnswerText(answer));
  }
  redirect(answer.body!.url as string);
}

// ── 8. External payments ──────────────────────────────────────────────────
export async function recordExternalPaymentAction(clientId: string, form: FormData) {
  const read = readExternalPayment({
    amount: field(form, "amount"), currency: field(form, "currency"), method: field(form, "method"),
    paid_at: field(form, "paid_at"), reference: field(form, "reference"), notes: field(form, "notes"),
    request_id: field(form, "request_id"),
  });
  if ("error" in read) back(clientId, "error", read.error);
  await run(clientId, { action: "record_external_payment", ...read.body }, "Recorded the external payment.");
}

export async function voidExternalPaymentAction(clientId: string, paymentId: string, form: FormData) {
  const reason = field(form, "reason")?.trim() ?? "";
  if (!reason) back(clientId, "error", "Say why the payment is being voided.");
  await run(clientId, { action: "void_external_payment", payment_id: paymentId, reason }, "Voided the payment. It stays in the history, marked void.");
}
