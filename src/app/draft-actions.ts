"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import type { Database, Json } from "@/lib/database.types";

type DraftUpdate = Database["public"]["Tables"]["content_drafts"]["Update"];

// Content draft actions (0067). Each is the signed-in teammate's own call:
// a request / regenerate / approve RPC, or an update the database guards
// (who may change what in which status, grounding at submit and approval).
// Nothing here writes content_posts directly, drafts with a model, or
// publishes; approval alone creates the final article.

export type DraftFormState = { ok?: boolean; error?: string; text?: string };

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const CHANGED = "The draft changed since this page loaded. Reload and look again.";

async function start() {
  const supabase = await createClient();
  try {
    await requireTeamMember(supabase);
  } catch {
    return null;
  }
  return supabase;
}

function revalidateDraft(clientId: string, draftId?: string) {
  if (draftId) revalidatePath(`/clients/${clientId}/drafts/${draftId}`);
  revalidatePath(`/clients/${clientId}/planner`);
  revalidatePath(`/clients/${clientId}/content`);
  revalidatePath("/production");
}

// Postgres refusals, in a teammate's words.
function draftError(message: string): string {
  return message.replace(/^.*?: (The draft cannot be (?:submitted|approved): )/, "$1");
}

// Generate on a blog (or web page) plan item.
export async function generateDraftAction(clientId: string, planItemId: string, _prev: DraftFormState, form: FormData): Promise<DraftFormState> {
  if (!isUuid(clientId) || !isUuid(planItemId)) return { error: "Unknown plan item." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const note = String(form.get("note") ?? "").trim().slice(0, 2000);
  const pageType = String(form.get("page_type") ?? "").trim() || undefined;
  const pageChange = String(form.get("page_change") ?? "").trim() || undefined;
  const { data, error } = await supabase.rpc("content_draft_request", {
    p_plan_item_id: planItemId, p_note: note || undefined, p_page_type: pageType, p_page_change: pageChange,
  });
  if (error) return { error: error.message };
  const draftId = (data as { draft_id?: string } | null)?.draft_id;
  revalidateDraft(clientId, draftId);
  if (draftId) redirect(`/clients/${clientId}/drafts/${draftId}`);
  return { ok: true };
}

export async function regenerateDraftAction(clientId: string, draftId: string, _prev: DraftFormState, form: FormData): Promise<DraftFormState> {
  if (!isUuid(clientId) || !isUuid(draftId)) return { error: "Unknown draft." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const note = String(form.get("note") ?? "").trim().slice(0, 2000);
  const { error } = await supabase.rpc("content_draft_regenerate", { p_draft_id: draftId, p_note: note || undefined });
  if (error) return { error: error.message };
  revalidateDraft(clientId, draftId);
  return { ok: true, text: "Sent back to the drafter. The new version replaces this one when it arrives." };
}

// A status step, conditional on the status and version the teammate saw.
async function step(clientId: string, draftId: string, seen: { status: string; version: number }, set: DraftUpdate): Promise<DraftFormState> {
  if (!isUuid(clientId) || !isUuid(draftId)) return { error: "Unknown draft." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data, error } = await supabase.from("content_drafts").update(set)
    .eq("id", draftId).eq("client_id", clientId).eq("status", seen.status).eq("version", seen.version).select("id");
  if (error) return { error: draftError(error.message) };
  if (!data?.length) return { error: CHANGED };
  revalidateDraft(clientId, draftId);
  return { ok: true };
}

export async function submitDraftAction(clientId: string, draftId: string, version: number): Promise<DraftFormState> {
  return step(clientId, draftId, { status: "draft", version }, { status: "in_review" });
}
export async function withdrawDraftAction(clientId: string, draftId: string, version: number): Promise<DraftFormState> {
  return step(clientId, draftId, { status: "in_review", version }, { status: "draft" });
}
export async function reopenDraftAction(clientId: string, draftId: string, version: number): Promise<DraftFormState> {
  return step(clientId, draftId, { status: "approved", version }, { status: "draft" });
}
export async function reviseDraftAction(clientId: string, draftId: string, version: number): Promise<DraftFormState> {
  return step(clientId, draftId, { status: "rejected", version }, { status: "draft" });
}
export async function rejectDraftAction(clientId: string, draftId: string, version: number, _prev: DraftFormState, form: FormData): Promise<DraftFormState> {
  const note = String(form.get("review_note") ?? "").trim();
  if (!note) return { error: "Say what needs to change." };
  return step(clientId, draftId, { status: "in_review", version }, { status: "rejected", review_note: note.slice(0, 2000) });
}

export async function approveDraftAction(clientId: string, draftId: string, version: number, _prev: DraftFormState, form: FormData): Promise<DraftFormState> {
  if (!isUuid(clientId) || !isUuid(draftId)) return { error: "Unknown draft." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const note = String(form.get("review_note") ?? "").trim().slice(0, 2000);
  const { data, error } = await supabase.rpc("content_draft_approve", { p_draft_id: draftId, p_version: version, p_note: note || undefined });
  if (error) return { error: error.code === "40001" ? CHANGED : draftError(error.message) };
  revalidateDraft(clientId, draftId);
  const created = (data as { created?: boolean } | null)?.created;
  return { ok: true, text: created ? "Approved. The final article is recorded on the Content tab." : "Approved." };
}

// A teammate's edit of a draft (draft or rejected): the content fields and the
// claims it stands on. The database bumps the version and re-checks at submit.
export async function saveDraftAction(clientId: string, draftId: string, version: number, _prev: DraftFormState, form: FormData): Promise<DraftFormState> {
  if (!isUuid(clientId) || !isUuid(draftId)) return { error: "Unknown draft." };
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const slug = str("slug");
  if (slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return { error: "The slug is lowercase words joined by hyphens." };
  const outline = str("outline").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(#{2,3})\s+(.+)$/);
    return m ? { level: m[1].length, heading: m[2].trim() } : { level: 2, heading: l.replace(/^#+\s*/, "") };
  });
  const links = str("internal_links").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [url, ...rest] = l.split(/\s+/);
    return { url, anchor: rest.join(" ") || url };
  });
  if (links.some((l) => !/^https?:\/\/\S+$/.test(l.url))) return { error: "Internal links are one per line: the URL, then the anchor text." };
  const ctaUrl = str("cta_url");
  if (ctaUrl && !/^https?:\/\/\S+$/.test(ctaUrl)) return { error: "The CTA link must be a full http(s) URL." };
  // A web page's own fields (0069), when the form carries them.
  const isPage = form.has("page_path");
  const pagePath = str("page_path");
  if (isPage && pagePath && !/^\/([a-z0-9]+(-[a-z0-9]+)*\/?)*$/.test(pagePath)) return { error: "The URL path is lowercase words and hyphens from the site root, like /services/roof-replacement." };
  let structured: Json | null = null;
  if (isPage && str("structured_data")) {
    try { structured = JSON.parse(str("structured_data")); } catch { return { error: "The structured data is not valid JSON." }; }
    if (!structured || typeof structured !== "object" || Array.isArray(structured)) return { error: "The structured data is one JSON-LD object." };
  }
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data, error } = await supabase.from("content_drafts").update({
    title: str("title") || null, slug: slug || null, meta_title: str("meta_title") || null, meta_description: str("meta_description") || null,
    h1: str("h1") || null, body_markdown: String(form.get("body_markdown") ?? "") || null, outline, internal_links: links,
    cta: { text: str("cta_text"), url: ctaUrl || null },
    ...(isPage ? { page_path: pagePath || null, page_objective: str("page_objective") || null, structured_data: structured } : {}),
  }).eq("id", draftId).eq("client_id", clientId).eq("version", version).in("status", ["draft", "rejected"]).select("id");
  if (error) return { error: draftError(error.message) };
  if (!data?.length) return { error: CHANGED };
  // Claims: the checked boxes are the claims the draft stands on.
  const want = new Set(form.getAll("claim_id").map(String).filter(isUuid));
  const { data: have } = await supabase.from("content_draft_claims").select("claim_id").eq("draft_id", draftId);
  const current = new Set((have ?? []).map((r) => r.claim_id));
  const remove = [...current].filter((c) => !want.has(c));
  const add = [...want].filter((c) => !current.has(c));
  if (remove.length) {
    const { error: e } = await supabase.from("content_draft_claims").delete().eq("draft_id", draftId).in("claim_id", remove);
    if (e) return { error: e.message };
  }
  if (add.length) {
    const { error: e } = await supabase.from("content_draft_claims").insert(add.map((claim_id) => ({ draft_id: draftId, client_id: clientId, claim_id })));
    if (e) return { error: e.message };
  }
  revalidateDraft(clientId, draftId);
  return { ok: true, text: "Saved." };
}

export async function deleteDraftAction(clientId: string, draftId: string): Promise<DraftFormState> {
  if (!isUuid(clientId) || !isUuid(draftId)) return { error: "Unknown draft." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data, error } = await supabase.from("content_drafts").delete().eq("id", draftId).eq("client_id", clientId).neq("status", "approved").select("id");
  if (error) return { error: draftError(error.message) };
  if (!data?.length) return { error: CHANGED };
  revalidateDraft(clientId);
  redirect(`/clients/${clientId}/planner`);
}
