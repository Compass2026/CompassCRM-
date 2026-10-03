"use server";

// The client agreement (plans) and its entitlement overrides (0058). Compass
// owns these: which package a client is on, how it pays, what it contracted
// to pay, and exactly what it receives. Invoices and paid state are Stripe's
// and are never written here. The agreed price and the exact Stripe Price it
// is bound to are an admin's (plans_agreement_price_guard enforces both the
// role and that the bound price says exactly what the agreement says).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole, requireTeamMember } from "@/lib/team";
import { validateAgreedPrice, validateAgreement, validateOverride } from "@/lib/billing";

function field(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" ? v : null;
}

function refuse(clientId: string, message: string): never {
  redirect(`/clients/${clientId}/plan?error=${encodeURIComponent(message)}`);
}

function done(clientId: string) {
  revalidatePath(`/clients/${clientId}/plan`);
  revalidatePath(`/clients/${clientId}/billing`);
  revalidatePath(`/clients/${clientId}/content`);
  revalidatePath(`/clients/${clientId}/social`);
  revalidatePath("/clients");
}

export async function saveAgreementAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const checked = validateAgreement({
    package_id: field(form, "package_id"),
    collection: field(form, "collection"),
    external_method: field(form, "external_method"),
    external_amount: field(form, "external_amount"),
    external_currency: field(form, "external_currency"),
    external_interval: field(form, "external_interval"),
    term_months: field(form, "term_months"),
    start_date: field(form, "start_date"),
    renewal_date: field(form, "renewal_date"),
    managed_ad_budget: field(form, "managed_ad_budget"),
    notes: field(form, "notes"),
  });
  if ("error" in checked) refuse(clientId, checked.error);
  // A bound Stripe Price belongs to the package: a new package unbinds it
  // (an admin's change; the database refuses it for a member).
  const { data: current } = await supabase
    .from("plans")
    .select("package_id, billing_package_price_id")
    .eq("client_id", clientId)
    .maybeSingle();
  const unbind = !!current?.billing_package_price_id && current.package_id !== checked.row.package_id;
  const row = { client_id: clientId, ...checked.row, ...(unbind ? { billing_package_price_id: null } : {}) };
  const { error } = await supabase.from("plans").upsert(row, { onConflict: "client_id" });
  if (error) refuse(clientId, error.message);
  done(clientId);
}

async function requireAdmin(clientId: string) {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const me = await getCurrentTeamRole(supabase);
  if (me?.role !== "admin") refuse(clientId, "Only an admin can set an agreement's price or its Stripe Price.");
  return supabase;
}

// The agreed recurring price (what the client contracted to pay). Changing it
// unbinds the Stripe Price, which no longer says the same thing; clearing it
// clears both.
export async function setAgreedPriceAction(clientId: string, form: FormData) {
  const supabase = await requireAdmin(clientId);
  const checked = validateAgreedPrice({
    amount: field(form, "agreed_amount"),
    currency: field(form, "agreed_currency"),
    interval: field(form, "agreed_interval"),
    interval_count: field(form, "agreed_interval_count"),
  });
  if ("error" in checked) refuse(clientId, checked.error);
  const { data: plan } = await supabase
    .from("plans")
    .select("collection, package_id, agreed_amount_cents, agreed_currency, agreed_billing_interval, agreed_billing_interval_count, billing_package_price_id")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!plan?.package_id) refuse(clientId, "Save the agreement's package first.");
  if (plan.collection !== "stripe") refuse(clientId, "An externally paid agreement records its amount in the external terms.");
  const t = checked.row;
  const same = t.agreed_amount_cents === plan.agreed_amount_cents && t.agreed_currency === plan.agreed_currency
    && t.agreed_billing_interval === plan.agreed_billing_interval && t.agreed_billing_interval_count === plan.agreed_billing_interval_count;
  if (same) return done(clientId);
  const { error } = await supabase
    .from("plans")
    .update({ ...t, billing_package_price_id: null })
    .eq("client_id", clientId);
  if (error) refuse(clientId, error.message);
  done(clientId);
}

// Bind the agreement to the exact approved Stripe Price Checkout will sell
// (or unbind it). The database accepts only an active price of the
// agreement's own package, in the current mode, with exactly the agreed
// amount, currency and interval.
export async function bindAgreementPriceAction(clientId: string, form: FormData) {
  const supabase = await requireAdmin(clientId);
  const id = field(form, "billing_package_price_id") || null;
  const { error } = await supabase.from("plans").update({ billing_package_price_id: id }).eq("client_id", clientId);
  if (error) refuse(clientId, error.message.replace(/^agreement price: /, "Stripe Price not bound: "));
  done(clientId);
}

export async function setEntitlementOverrideAction(clientId: string, serviceKey: string, form: FormData) {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const { data: service } = await supabase
    .from("service_catalog")
    .select("key, kind")
    .eq("key", serviceKey)
    .maybeSingle();
  if (!service) refuse(clientId, "That service is not in the catalog.");
  const checked = validateOverride({
    service_kind: service.kind,
    enabled: form.get("enabled") === "on",
    quantity: field(form, "quantity"),
    reason: field(form, "reason"),
  });
  if ("error" in checked) refuse(clientId, checked.error);
  const { error } = await supabase.from("client_entitlement_overrides").upsert(
    { client_id: clientId, service_key: service.key, service_kind: service.kind, ...checked },
    { onConflict: "client_id,service_key" }
  );
  if (error) refuse(clientId, error.message);
  done(clientId);
}

export async function clearEntitlementOverrideAction(clientId: string, serviceKey: string) {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const { error } = await supabase
    .from("client_entitlement_overrides")
    .delete()
    .eq("client_id", clientId)
    .eq("service_key", serviceKey);
  if (error) refuse(clientId, error.message);
  done(clientId);
}
