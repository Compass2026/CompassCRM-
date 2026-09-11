"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";

type Enums = Database["public"]["Enums"];

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function revalidate(clientId: string) {
  revalidatePath(`/clients/${clientId}/services`);
}

// ── Services — the taxonomy (PB1) ──────────────────────────────────────────
export async function addServiceAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { data: last } = await supabase
    .from("services")
    .select("sort_order")
    .eq("client_id", clientId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("services").insert({
    client_id: clientId,
    name: str(form, "name") ?? "Untitled service",
    segment: str(form, "segment"),
    gbp_entry: str(form, "gbp_entry"),
    page_url: str(form, "page_url"),
    page_type: (str(form, "page_type") as Enums["service_page_type"]) ?? "service",
    parent_service_id: str(form, "parent_service_id"),
    primary_keyword_id: str(form, "primary_keyword_id"),
    sort_order: (last?.sort_order ?? 0) + 1,
  });
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function updateServiceAction(
  clientId: string,
  serviceId: string,
  form: FormData
) {
  const supabase = await createClient();
  const parentId = str(form, "parent_service_id");

  // A service that is itself a parent cannot be folded into another one —
  // that would hide its children a level deeper than the tab renders.
  if (parentId) {
    if (parentId === serviceId) {
      throw new Error("A service cannot be folded into itself.");
    }
    const { count } = await supabase
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("parent_service_id", serviceId);
    if (count) {
      throw new Error(
        "This service has folded children — unfold them before folding it into another service."
      );
    }
  }

  const { error } = await supabase
    .from("services")
    .update({
      name: str(form, "name") ?? undefined,
      segment: str(form, "segment"),
      gbp_entry: str(form, "gbp_entry"),
      page_url: str(form, "page_url"),
      page_type:
        (str(form, "page_type") as Enums["service_page_type"]) ?? undefined,
      parent_service_id: parentId,
      primary_keyword_id: str(form, "primary_keyword_id"),
      status: (str(form, "status") as Enums["taxonomy_status"]) ?? undefined,
    })
    .eq("id", serviceId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function deleteServiceAction(clientId: string, serviceId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("services").delete().eq("id", serviceId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function setServiceStatusAction(
  clientId: string,
  serviceId: string,
  status: Enums["taxonomy_status"]
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ status })
    .eq("id", serviceId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function approveAllProposedAction(clientId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ status: "approved" })
    .eq("client_id", clientId)
    .eq("status", "proposed");
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

// Reorder by swapping with the adjacent service in the same segment — that is
// what the card actually shows, so a move always visibly moves something.
// Folded children are skipped; they render under their parent, not in sequence.
export async function moveServiceAction(
  clientId: string,
  serviceId: string,
  direction: "up" | "down"
) {
  const supabase = await createClient();
  const { data: services } = await supabase
    .from("services")
    .select("id, sort_order, segment, parent_service_id")
    .eq("client_id", clientId)
    .order("sort_order")
    .order("name");
  if (!services) return;

  const self = services.find((s) => s.id === serviceId);
  if (!self) return;

  const siblings = services.filter(
    (s) => !s.parent_service_id && s.segment === self.segment
  );
  const index = siblings.findIndex((s) => s.id === serviceId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= siblings.length) return;

  // Swap the two rows' positions in the full list, then renumber densely so
  // sort_order stays gap-free and ties can't accumulate.
  const a = services.findIndex((s) => s.id === siblings[index].id);
  const b = services.findIndex((s) => s.id === siblings[target].id);
  [services[a], services[b]] = [services[b], services[a]];

  for (const [i, s] of services.entries()) {
    const next = i + 1;
    if (s.sort_order === next) continue;
    const { error } = await supabase
      .from("services")
      .update({ sort_order: next })
      .eq("id", s.id);
    if (error) throw new Error(error.message);
  }
  revalidate(clientId);
}
