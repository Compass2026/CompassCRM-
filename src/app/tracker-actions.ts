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

function num(form: FormData, key: string): number | null {
  const v = str(form, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Content posts ──────────────────────────────────────────────────────────
export async function addContentPostAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("content_posts").insert({
    client_id: clientId,
    title: str(form, "title") ?? "Untitled",
    keyword_id: str(form, "keyword_id"),
    status: (str(form, "status") as Enums["content_status"]) ?? "idea",
    owner: (str(form, "owner") as Enums["owner_type"]) ?? "TOM",
    due_date: str(form, "due_date"),
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/content`);
}

export async function updateContentPostAction(
  clientId: string,
  postId: string,
  form: FormData
) {
  const supabase = await createClient();
  const status = str(form, "status") as Enums["content_status"] | null;
  const explicitPublishedAt = str(form, "published_at");
  const { error } = await supabase
    .from("content_posts")
    .update({
      status: status ?? undefined,
      owner: (str(form, "owner") as Enums["owner_type"]) ?? undefined,
      due_date: str(form, "due_date"),
      url: str(form, "url"),
      word_count: num(form, "word_count"),
      keyword_id: str(form, "keyword_id"),
      published_at:
        explicitPublishedAt ??
        (status === "published" ? new Date().toISOString().slice(0, 10) : null),
      notes: str(form, "notes"),
    })
    .eq("id", postId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/content`);
  revalidatePath(`/clients/${clientId}/reports`);
}

export async function deleteContentPostAction(clientId: string, postId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("content_posts")
    .delete()
    .eq("id", postId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/content`);
}

// ── Social posts ───────────────────────────────────────────────────────────
export async function addSocialPostAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("social_posts").insert({
    client_id: clientId,
    platform: (str(form, "platform") as Enums["social_platform"]) ?? "facebook",
    copy: str(form, "copy"),
    asset_url: str(form, "asset_url"),
    scheduled_at: str(form, "scheduled_at"),
    status: (str(form, "status") as Enums["social_post_status"]) ?? "idea",
    notes: str(form, "notes"),
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/social`);
}

export async function updateSocialPostAction(
  clientId: string,
  postId: string,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("social_posts")
    .update({
      platform: (str(form, "platform") as Enums["social_platform"]) ?? undefined,
      copy: str(form, "copy"),
      asset_url: str(form, "asset_url"),
      scheduled_at: str(form, "scheduled_at"),
      status:
        (str(form, "status") as Enums["social_post_status"]) ?? undefined,
      published_url: str(form, "published_url"),
      notes: str(form, "notes"),
    })
    .eq("id", postId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/social`);
  revalidatePath(`/clients/${clientId}/reports`);
}

export async function deleteSocialPostAction(clientId: string, postId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("social_posts")
    .delete()
    .eq("id", postId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/social`);
}

// ── Monthly cycles (Reports tab) ───────────────────────────────────────────
export async function updateCycleAction(
  clientId: string,
  cycleId: string,
  form: FormData
) {
  const supabase = await createClient();
  const status = str(form, "status") as Enums["cycle_status"] | null;
  const { error } = await supabase
    .from("monthly_cycles")
    .update({
      report_url: str(form, "report_url"),
      notes: str(form, "notes"),
      status: status ?? undefined,
      completed_at: status === "complete" ? new Date().toISOString() : null,
    })
    .eq("id", cycleId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/reports`);
}

// Manual cycle creation for the current month (the pg_cron job normally does
// this on the 1st). Mirrors create_monthly_cycles() for a single client.
export async function startCycleAction(clientId: string) {
  const supabase = await createClient();
  const period = new Date();
  const periodDate = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, "0")}-01`;

  const { data: cycle, error: cycleError } = await supabase
    .from("monthly_cycles")
    .insert({ client_id: clientId, period: periodDate })
    .select("id")
    .single();
  if (cycleError) throw new Error(cycleError.message);

  const [{ data: templates }, { data: enrollments }] = await Promise.all([
    supabase
      .from("task_templates")
      .select("title, default_owner, department, sort_order, pipelines!inner(is_recurring)")
      .eq("pipelines.is_recurring", true)
      .order("sort_order"),
    supabase
      .from("client_pipelines")
      .select("pipelines(key)")
      .eq("client_id", clientId),
  ]);
  const departments = new Set(
    (enrollments ?? []).map((e) => e.pipelines?.key).filter(Boolean)
  );
  const tasks = (templates ?? [])
    .filter((t) => !t.department || departments.has(t.department))
    .map((t) => ({
      client_id: clientId,
      monthly_cycle_id: cycle.id,
      title: t.title,
      owner: t.default_owner,
    }));
  if (tasks.length > 0) {
    const { error } = await supabase.from("tasks").insert(tasks);
    if (error) throw new Error(error.message);
  }
  revalidatePath(`/clients/${clientId}/reports`);
}
