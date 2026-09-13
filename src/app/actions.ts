"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { blockedQuery, blockedReason } from "@/lib/db-errors";
import type { Database } from "@/lib/database.types";

type Enums = Database["public"]["Enums"];

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function num(form: FormData, key: string): number | null {
  const v = str(form, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Clients ────────────────────────────────────────────────────────────────
// The vertical is a slug (`interior_design`, `roofing`): the worker keys the
// schema.org type, the citation list and the industry pulse off it.
function verticalSlug(form: FormData): string | null {
  const v = str(form, "vertical");
  if (!v) return null;
  const slug = v
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || null;
}

function businessType(form: FormData): Enums["business_type"] | null {
  const v = str(form, "business_type");
  return v === "storefront" || v === "service_area" ? v : null;
}

// The intake. Everything the Foundation worker reads on its first run is
// captured here so a new client never stalls on a blank field: the vertical
// and business type drive the brand board and schema, city / state drive
// DataForSEO locations and the GBP lookup, phone drives NAP checks. An
// existing site the client keeps is recorded as a client-controlled `sites`
// row up front, so the audit files a fix list for Tom to blend rather than a
// punch list, and the Website build lands on a side branch of nothing.
export async function createClientAction(form: FormData) {
  const supabase = await createClient();
  const websiteUrl = str(form, "website_url");
  const { data, error } = await supabase
    .from("clients")
    .insert({
      name: str(form, "name") ?? "Unnamed client",
      dba: str(form, "dba"),
      industry: str(form, "industry"),
      vertical: verticalSlug(form),
      business_type: businessType(form),
      website_url: websiteUrl,
      phone: str(form, "phone"),
      city: str(form, "city"),
      state: str(form, "state"),
      service_area: str(form, "service_area"),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (form.get("existing_site") === "on" && websiteUrl) {
    const { error: siteError } = await supabase.from("sites").insert({
      client_id: data.id,
      url: websiteUrl,
      stack: "other",
      controlled_by_compass: false,
    });
    if (siteError) throw new Error(siteError.message);

    // The client keeps their site, so there is nothing for the Website
    // pipeline to build: drop the enrollment the insert trigger just made
    // (Tom, Sept 13 2026 — BHG Safety Partners got a proposal build it did
    // not want). The SEO audit still covers the site. Enrolling Website
    // later on the Plan tab is the way back if that changes.
    const { data: websitePipeline } = await supabase
      .from("pipelines")
      .select("id")
      .eq("key", "website")
      .maybeSingle();
    if (websitePipeline) {
      const { error: dropError } = await supabase
        .from("client_pipelines")
        .delete()
        .eq("client_id", data.id)
        .eq("pipeline_id", websitePipeline.id);
      if (dropError) throw new Error(dropError.message);
    }
  }

  revalidatePath("/clients");
  redirect(`/clients/${data.id}`);
}

export async function updateClientAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      name: str(form, "name") ?? undefined,
      dba: str(form, "dba"),
      industry: str(form, "industry"),
      vertical: verticalSlug(form),
      business_type: businessType(form),
      website_url: str(form, "website_url"),
      phone: str(form, "phone"),
      address_line1: str(form, "address_line1"),
      city: str(form, "city"),
      state: str(form, "state"),
      zip: str(form, "zip"),
      service_area: str(form, "service_area"),
      status: (str(form, "status") as Enums["client_status"]) ?? undefined,
      signed_at: str(form, "signed_at"),
      kickoff_at: str(form, "kickoff_at"),
      launched_at: str(form, "launched_at"),
      renewal_at: str(form, "renewal_at"),
      drive_root_url: str(form, "drive_root_url"),
      notes: str(form, "notes"),
    })
    .eq("id", clientId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}`);
}

// ── Contacts ───────────────────────────────────────────────────────────────
export async function addContactAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("client_contacts").insert({
    client_id: clientId,
    name: str(form, "name") ?? "Contact",
    role: str(form, "role"),
    email: str(form, "email"),
    phone: str(form, "phone"),
    is_primary: form.get("is_primary") === "on",
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteContactAction(clientId: string, contactId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_contacts")
    .delete()
    .eq("id", contactId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}`);
}

// ── Access tracker ─────────────────────────────────────────────────────────
export async function upsertAccessAction(
  clientId: string,
  system: Enums["access_system"],
  status: Enums["access_status"],
  notes: string | null
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_access")
    .upsert(
      { client_id: clientId, system, status, notes },
      { onConflict: "client_id,system" }
    );
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}`);
}

// ── Plan ───────────────────────────────────────────────────────────────────
export async function upsertPlanAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("plans").upsert(
    {
      client_id: clientId,
      package_name: str(form, "package_name"),
      monthly_fee: num(form, "monthly_fee"),
      term_months: num(form, "term_months"),
      start_date: str(form, "start_date"),
      renewal_date: str(form, "renewal_date"),
      gbp_posts_per_month: num(form, "gbp_posts_per_month"),
      blog_posts_per_month: num(form, "blog_posts_per_month"),
      social_posts_per_month: num(form, "social_posts_per_month"),
      ad_budget_managed: num(form, "ad_budget_managed"),
      notes: str(form, "notes"),
    },
    { onConflict: "client_id" }
  );
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/plan`);
}

// ── Enrollment ─────────────────────────────────────────────────────────────
export async function enrollPipelineAction(clientId: string, pipelineId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pipelines")
    .insert({ client_id: clientId, pipeline_id: pipelineId });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}`);
}

export async function unenrollPipelineAction(
  clientId: string,
  clientPipelineId: string
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pipelines")
    .delete()
    .eq("id", clientPipelineId);
  if (error) {
    const blocked = blockedReason(error);
    if (blocked) {
      redirect(`/clients/${clientId}/plan?${blockedQuery(blocked)}`);
    }
    throw new Error(error.message);
  }
  revalidatePath(`/clients/${clientId}`);
}

// ── Documents ──────────────────────────────────────────────────────────────
export async function addDriveLinkAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("documents").insert({
    client_id: clientId,
    kind: "drive_link",
    label: str(form, "label") ?? "Link",
    category: (str(form, "category") as Enums["document_category"]) ?? "other",
    url: str(form, "url"),
    notes: str(form, "notes"),
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/documents`);
}

export async function uploadDocumentAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("No file selected");
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const path = `${clientId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(path, file);
  if (uploadError) throw new Error(uploadError.message);

  const { error } = await supabase.from("documents").insert({
    client_id: clientId,
    kind: "upload",
    label: str(form, "label") ?? file.name,
    category: (str(form, "category") as Enums["document_category"]) ?? "other",
    storage_path: path,
    file_name: file.name,
    mime_type: file.type,
    uploaded_by: user?.email ?? null,
    notes: str(form, "notes"),
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/documents`);
}

export async function deleteDocumentAction(clientId: string, documentId: string) {
  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .single();
  if (doc?.storage_path) {
    await supabase.storage.from("documents").remove([doc.storage_path]);
  }
  const { error } = await supabase.from("documents").delete().eq("id", documentId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/documents`);
}

export async function getDocumentUrlAction(storagePath: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from("documents")
    .createSignedUrl(storagePath, 60 * 10);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ── Stages ─────────────────────────────────────────────────────────────────
export async function updateStageAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const stageId = str(form, "client_stage_id");
  if (!stageId) throw new Error("Missing stage id");
  const { error } = await supabase
    .from("client_stages")
    .update({
      status: (str(form, "status") as Enums["stage_status"]) ?? undefined,
      owner: (str(form, "owner") as Enums["owner_type"]) ?? undefined,
      due_date: str(form, "due_date"),
      evidence: str(form, "evidence"),
      next_action: str(form, "next_action"),
      notes: str(form, "notes"),
    })
    .eq("id", stageId);
  if (error) {
    const blocked = blockedReason(error);
    if (blocked) {
      redirect(`/clients/${clientId}/pipelines?${blockedQuery(blocked)}`);
    }
    throw new Error(error.message);
  }
  revalidatePath(`/clients/${clientId}/pipelines`);
  revalidatePath(`/clients/${clientId}`);
}

// ── Tasks ──────────────────────────────────────────────────────────────────
export async function addTaskAction(
  clientId: string,
  clientStageId: string | null,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase.from("tasks").insert({
    client_id: clientId,
    client_stage_id: clientStageId,
    title: str(form, "title") ?? "Task",
    owner: (str(form, "owner") as Enums["owner_type"]) ?? "TOM",
    due_date: str(form, "due_date"),
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/pipelines`);
  revalidatePath("/tasks");
}

export async function toggleTaskAction(
  clientId: string,
  taskId: string,
  done: boolean
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("tasks")
    .update({
      status: done ? "done" : "open",
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq("id", taskId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/pipelines`);
  revalidatePath("/tasks");
}

// ── Deliverables ───────────────────────────────────────────────────────────
export async function addDeliverableAction(
  clientId: string,
  clientStageId: string | null,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase.from("deliverables").insert({
    client_id: clientId,
    client_stage_id: clientStageId,
    label: str(form, "label") ?? "Deliverable",
    url: str(form, "url") ?? "",
    type: (str(form, "type") as Enums["deliverable_type"]) ?? "drive",
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/pipelines`);
}
