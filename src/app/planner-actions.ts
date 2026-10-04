"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { addDays, OPPORTUNITY_DELIVERABLE, parsePlanFields, parseWeek } from "@/lib/content-planner";

// Content Planner actions (0065). Each is the signed-in teammate's own write
// through PostgREST; the database checks the shapes, the same-client links,
// the Authority mapping and stamps who changed what (content_plan_items_guard).
// Nothing here drafts, renders or publishes.

// n: a submission stamp, so an add form can reset after a successful add.
export type PlanFormState = { ok?: boolean; error?: string; n?: number };

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";

async function start() {
  const supabase = await createClient();
  try {
    await requireTeamMember(supabase);
  } catch {
    return null;
  }
  return supabase;
}

function revalidatePlanner(clientId: string) {
  revalidatePath(`/clients/${clientId}/planner`);
  revalidatePath("/production");
}

// Postgres refusals in a teammate's words.
function planError(message: string): string {
  if (/content_plan_items_channel_shape/.test(message)) return "That channel does not fit this kind of slot.";
  if (/content_plan_items_planned_in_week/.test(message)) return "The planned date must fall inside the week.";
  if (/content_plan_items_social_post_key|content_plan_items_content_post_key/.test(message)) return "That draft already fills another slot.";
  if (/foreign key/.test(message)) return "That service, keyword, opportunity or draft belongs to another client or no longer exists.";
  return message;
}

export async function createPlanItemAction(clientId: string, weekParam: string, _prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  if (!isUuid(clientId)) return { error: "Unknown client." };
  const week = parseWeek(weekParam);
  const parsed = parsePlanFields((k) => form.get(k), week);
  if (!parsed.ok) return { error: parsed.error };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { error } = await supabase.from("content_plan_items").insert({
    client_id: clientId,
    week_start: week,
    ...parsed.fields,
    channel: parsed.fields.channel as never,
  });
  if (error) return { error: planError(error.message) };
  revalidatePlanner(clientId);
  return { ok: true, n: Date.now() };
}

export async function updatePlanItemAction(clientId: string, itemId: string, weekParam: string, _prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  if (!isUuid(clientId) || !isUuid(itemId)) return { error: "Unknown plan item." };
  const week = parseWeek(weekParam);
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data: item } = await supabase.from("content_plan_items").select("deliverable, channel, purpose").eq("id", itemId).eq("client_id", clientId).maybeSingle();
  if (!item) return { error: "This plan item no longer exists." };
  // The slot and the purpose stay as planned; an authority item keeps its opportunity.
  const parsed = parsePlanFields((k) =>
    k === "deliverable" ? item.deliverable : k === "purpose" ? (item.purpose === "authority" ? "educational" : item.purpose)
      : k === "channel" && item.channel ? item.channel : form.get(k), week);
  if (!parsed.ok) return { error: parsed.error };
  const { deliverable: _d, channel: _c, purpose: _p, ...fields } = parsed.fields;
  void _d; void _c; void _p;
  const { error } = await supabase.from("content_plan_items").update(fields).eq("id", itemId).eq("client_id", clientId);
  if (error) return { error: planError(error.message) };
  revalidatePlanner(clientId);
  return { ok: true };
}

export async function deletePlanItemAction(clientId: string, itemId: string): Promise<PlanFormState> {
  if (!isUuid(clientId) || !isUuid(itemId)) return { error: "Unknown plan item." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data, error } = await supabase.from("content_plan_items").delete().eq("id", itemId).eq("client_id", clientId)
    .is("social_post_id", null).is("content_post_id", null).select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Unlink its draft first; a plan item with a draft is not deleted." };
  revalidatePlanner(clientId);
  return { ok: true };
}

// Link an existing post (social / gbp slot) or blog (blog slot) to the item.
export async function linkOutputAction(clientId: string, itemId: string, _prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  if (!isUuid(clientId) || !isUuid(itemId)) return { error: "Unknown plan item." };
  const output = String(form.get("output") ?? "");
  const m = output.match(/^(post|blog):([0-9a-f-]{36})$/i);
  if (!m || !isUuid(m[2])) return { error: "Choose a draft to link." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const patch = m[1] === "post" ? { social_post_id: m[2] } : { content_post_id: m[2] };
  const { error } = await supabase.from("content_plan_items").update(patch).eq("id", itemId).eq("client_id", clientId);
  if (error) return { error: planError(error.message) };
  revalidatePlanner(clientId);
  return { ok: true };
}

export async function unlinkOutputAction(clientId: string, itemId: string): Promise<PlanFormState> {
  if (!isUuid(clientId) || !isUuid(itemId)) return { error: "Unknown plan item." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { error } = await supabase.from("content_plan_items").update({ social_post_id: null, content_post_id: null })
    .eq("id", itemId).eq("client_id", clientId);
  if (error) return { error: error.message };
  revalidatePlanner(clientId);
  return { ok: true };
}

// A teammate's hold: blocked (with the reason), delivered (with the link, when
// there is one), or cleared.
export async function setHoldAction(clientId: string, itemId: string, _prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  if (!isUuid(clientId) || !isUuid(itemId)) return { error: "Unknown plan item." };
  const hold = String(form.get("hold") ?? "");
  const reason = String(form.get("hold_reason") ?? "").trim().slice(0, 500);
  const url = String(form.get("output_url") ?? "").trim();
  if (!["blocked", "delivered", "clear"].includes(hold)) return { error: "Choose blocked, delivered or clear." };
  if (hold === "blocked" && !reason) return { error: "Say what it is waiting on." };
  if (url && !/^https?:\/\/\S+$/.test(url)) return { error: "The delivered link must be a full http(s) URL." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const patch = hold === "clear" ? { hold: null, hold_reason: null }
    : hold === "blocked" ? { hold: "blocked", hold_reason: reason }
    : { hold: "delivered", hold_reason: reason || null, ...(url ? { output_url: url } : {}) };
  const { error } = await supabase.from("content_plan_items").update(patch).eq("id", itemId).eq("client_id", clientId);
  if (error) return { error: planError(error.message) };
  revalidatePlanner(clientId);
  return { ok: true };
}

// Plan an Authority opportunity into this week: the slot, topic, intent,
// service, keyword and target page come from the opportunity.
export async function planFromAuthorityAction(clientId: string, weekParam: string, opportunityId: string, _prev: PlanFormState, form: FormData): Promise<PlanFormState> {
  if (!isUuid(clientId) || !isUuid(opportunityId)) return { error: "Unknown opportunity." };
  const week = parseWeek(weekParam);
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const [{ data: o }, { data: client }] = await Promise.all([
    supabase.from("authority_opportunities").select("id, content_type, topic, intent, service_id, keyword_id, target_path")
      .eq("id", opportunityId).eq("client_id", clientId).maybeSingle(),
    supabase.from("clients").select("website_url").eq("id", clientId).maybeSingle(),
  ]);
  if (!o) return { error: "This opportunity no longer exists." };
  const deliverable = OPPORTUNITY_DELIVERABLE[o.content_type];
  if (!deliverable) return { error: `A ${o.content_type.replace(/_/g, " ")} opportunity does not fill a weekly slot.` };
  const planned = String(form.get("planned_date") ?? "").trim() || null;
  if (planned && (planned < week || planned > addDays(week, 6))) return { error: "The planned date must fall inside this week." };
  let target: string | null = null;
  if (o.target_path && client?.website_url) {
    try { target = new URL(o.target_path, client.website_url).toString(); } catch { target = null; }
  }
  const intent = ["navigational", "informational", "commercial", "transactional"].includes(o.intent ?? "") ? o.intent : null;
  const { error } = await supabase.from("content_plan_items").insert({
    client_id: clientId, week_start: week, deliverable, channel: deliverable === "gbp" ? "google_business" : null,
    purpose: "authority", authority_opportunity_id: o.id, topic: o.topic.slice(0, 200), search_intent: intent,
    service_id: o.service_id, keyword_id: o.keyword_id, target_url: target, planned_date: planned,
  });
  if (error) return { error: planError(error.message) };
  revalidatePlanner(clientId);
  return { ok: true };
}
