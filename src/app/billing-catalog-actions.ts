"use server";

// Settings › Billing catalog (B3): the packages Compass sells, what each
// includes, the one-time items, and which Stripe Products and Prices they
// map to. Admin only. Compass rows are written with the admin's own session,
// so RLS (0058: is_team() and is_team_admin()) refuses a member however the
// action is reached; anything that reads or creates a Stripe object goes
// through the stripe-billing function, which checks the role again.
// No price amounts are invented here: a standard price is chosen from the
// Stripe Prices already on the package's product.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import { callStripeBilling } from "@/lib/stripe-billing-call";
import { billingAnswerText, isOk, isUuid, readEntitlement, readOneTimeItem, readPackage } from "@/lib/billing-ops";

const PAGE = "/settings/billing";

function field(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" ? v : null;
}

function back(kind: "notice" | "error", message: string): never {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${kind}=${encodeURIComponent(message)}`);
}

async function adminClient() {
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  if (!me) redirect("/login");
  if (me.role !== "admin") back("error", "Only an admin can change the billing catalog.");
  return supabase;
}

const dbText = (e: { code?: string; message: string }) =>
  e.code === "42501" || /row-level security/.test(e.message) ? "Only an admin can change the billing catalog." : e.message;

// ── Packages ───────────────────────────────────────────────────────────────
export async function savePackageAction(form: FormData) {
  const supabase = await adminClient();
  const read = readPackage({
    key: field(form, "key"), name: field(form, "name"), description: field(form, "description"),
    kind: field(form, "kind"), sort_order: field(form, "sort_order"),
  });
  if ("error" in read) back("error", read.error);
  const id = field(form, "id");
  const { error } = isUuid(id)
    // The key and kind of an existing package are fixed: entitlements and prices hang off them.
    ? await supabase.from("billing_packages").update({ name: read.row.name, description: read.row.description, sort_order: read.row.sort_order }).eq("id", id)
    : await supabase.from("billing_packages").insert(read.row);
  if (error) back("error", dbText(error));
  back("notice", `Saved ${read.row.name}.`);
}

export async function setPackageActiveAction(packageId: string, active: boolean) {
  const supabase = await adminClient();
  const { error } = await supabase.from("billing_packages").update({ active }).eq("id", packageId);
  if (error) back("error", dbText(error));
  back("notice", active ? "Package offered again." : "Package retired: existing agreements keep it; it is no longer offered.");
}

export async function savePackageEntitlementAction(packageId: string, serviceKey: string, form: FormData) {
  const supabase = await adminClient();
  const { data: service } = await supabase.from("service_catalog").select("key, kind").eq("key", serviceKey).maybeSingle();
  if (!service) back("error", "That service is not in the catalog.");
  const checked = readEntitlement(service.kind, form.get("enabled") === "on", field(form, "quantity"));
  if ("error" in checked) back("error", checked.error);
  const { error } = await supabase.from("package_entitlements").upsert(
    { package_id: packageId, service_key: service.key, service_kind: service.kind, enabled: checked.enabled, quantity: checked.quantity },
    { onConflict: "package_id,service_key" },
  );
  if (error) back("error", dbText(error));
  back("notice", "Saved the package's entitlement.");
}

// ── Stripe mapping ─────────────────────────────────────────────────────────
export async function importStripeProductAction(target: "package" | "one_time_item", targetId: string, form: FormData) {
  const supabase = await adminClient();
  const productId = field(form, "product_id")?.trim() ?? "";
  const answer = await callStripeBilling(supabase, { action: "import_product", target, target_id: targetId, product_id: productId });
  if (!isOk(answer)) back("error", billingAnswerText(answer));
  back("notice", `Imported ${productId} and its prices from Stripe.`);
}

export async function mapPackagePriceAction(packageId: string, form: FormData) {
  const supabase = await adminClient();
  const priceId = field(form, "stripe_price_id") ?? "";
  const { data: pkg } = await supabase.from("billing_packages").select("kind, stripe_product_id").eq("id", packageId).maybeSingle();
  if (!pkg?.stripe_product_id) back("error", "Import the package's Stripe product first.");
  if (pkg.kind !== "standard") back("error", "A custom package's prices are created per client on the client's Billing tab.");
  const { error } = await supabase.from("billing_package_prices").insert({
    package_id: packageId, package_kind: "standard", stripe_product_id: pkg.stripe_product_id, stripe_price_id: priceId,
    is_default: form.get("is_default") === "on",
  });
  if (error) back("error", dbText(error));
  back("notice", "Approved the price for Checkout.");
}

export async function setPackagePriceAction(mappingId: string, change: { active?: boolean; is_default?: boolean }) {
  const supabase = await adminClient();
  const patch: { active?: boolean; is_default?: boolean } = {};
  if (typeof change.active === "boolean") patch.active = change.active;
  if (typeof change.is_default === "boolean") patch.is_default = change.is_default;
  if (patch.is_default) {
    const { data: row } = await supabase.from("billing_package_prices").select("package_id").eq("id", mappingId).maybeSingle();
    if (row) await supabase.from("billing_package_prices").update({ is_default: false }).eq("package_id", row.package_id).neq("id", mappingId);
  }
  const { error } = await supabase.from("billing_package_prices").update(patch).eq("id", mappingId);
  if (error) back("error", dbText(error));
  back("notice", "Saved the price mapping.");
}

// ── One-time items ─────────────────────────────────────────────────────────
export async function saveOneTimeItemAction(form: FormData) {
  const supabase = await adminClient();
  const read = readOneTimeItem({ key: field(form, "key"), name: field(form, "name"), description: field(form, "description"), category: field(form, "category") });
  if ("error" in read) back("error", read.error);
  const id = field(form, "id");
  const { error } = isUuid(id)
    ? await supabase.from("billing_one_time_items").update({ name: read.row.name, description: read.row.description, category: read.row.category }).eq("id", id)
    : await supabase.from("billing_one_time_items").insert(read.row);
  if (error) back("error", dbText(error));
  back("notice", `Saved ${read.row.name}.`);
}

export async function setOneTimeItemActiveAction(itemId: string, active: boolean) {
  const supabase = await adminClient();
  const { error } = await supabase.from("billing_one_time_items").update({ active }).eq("id", itemId);
  if (error) back("error", dbText(error));
  back("notice", active ? "Item offered again." : "Item retired.");
}

// ── Customer Portal ────────────────────────────────────────────────────────
export async function configurePortalAction() {
  const supabase = await adminClient();
  const answer = await callStripeBilling(supabase, { action: "configure_portal" });
  if (!isOk(answer)) back("error", billingAnswerText(answer));
  back("notice", answer.body?.created ? "Configured the Stripe Customer Portal." : "The Customer Portal is already configured as Compass requires.");
}
