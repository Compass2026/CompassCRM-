"use server";

// The client agreement (plans) and its entitlement overrides (0057). Compass
// owns these: which package a client is on, how it pays, and exactly what it
// receives. Prices, invoices and paid state are Stripe's and are never
// written here.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { validateAgreement, validateOverride } from "@/lib/billing";

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
  const { error } = await supabase
    .from("plans")
    .upsert({ client_id: clientId, ...checked.row }, { onConflict: "client_id" });
  if (error) refuse(clientId, error.message);
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
