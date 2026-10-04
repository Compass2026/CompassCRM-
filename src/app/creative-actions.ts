"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { callCreativeEngine, engineMessage } from "@/lib/creative-engine-call";
import { isCreativePolicy } from "@/lib/creative-post";
import { findTemplate } from "../../supabase/functions/creative-engine/registry.ts";
import { lucasPreviewRefs } from "../../supabase/functions/creative-engine/previews.ts";
import { KITS } from "../../supabase/functions/creative-engine/kits.ts";
import { specHash } from "../../supabase/functions/creative-engine/spec.ts";

// Creative Engine actions (0054 / 0057). Renders and records go through the
// creative-engine function with the teammate's own JWT — the CRM never
// writes a run or an asset itself. Approving a template for a client,
// setting a policy and requesting new creative are the teammate's own
// updates through PostgREST; the database stamps who and when, and refuses
// anyone else. Nothing here publishes.

export type CreativeFormState = { ok?: boolean; error?: string; text?: string };

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const CHANNELS = ["google_business", "facebook", "instagram"] as const;

async function start() {
  const supabase = await createClient();
  try {
    await requireTeamMember(supabase);
  } catch {
    return null;
  }
  return supabase;
}

function revalidateCreative(clientId: string, postId?: string) {
  revalidatePath(`/clients/${clientId}/brand/creative-preview`);
  revalidatePath(`/clients/${clientId}/social`);
  if (postId) revalidatePath(`/clients/${clientId}/social/${postId}`);
}

// ── Posts ───────────────────────────────────────────────────────────────────

export async function generatePostCreativeAction(
  clientId: string,
  postId: string,
  _prev: CreativeFormState,
  form: FormData,
): Promise<CreativeFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const templateId = String(form.get("template_id") ?? "");
  if (!isUuid(templateId)) return { error: "Choose a template." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data: t } = await supabase.from("creative_templates").select("key, version, spec_hash").eq("id", templateId).maybeSingle();
  if (!t) return { error: "That template no longer exists." };
  const { data: post } = await supabase.from("social_posts").select("creative_version").eq("id", postId).eq("client_id", clientId).maybeSingle();
  if (!post) return { error: "This post no longer exists." };
  const answer = await callCreativeEngine(supabase, {
    mode: "post",
    post_id: postId,
    template: { key: t.key, version: t.version, spec_hash: t.spec_hash },
    reason: post.creative_version > 0 ? "regenerate" : "initial",
  });
  revalidateCreative(clientId, postId);
  const m = engineMessage(answer);
  return m.ok ? { ok: true, text: m.text } : { error: m.text };
}

export async function setPostCreativePolicyAction(
  clientId: string,
  postId: string,
  _prev: CreativeFormState,
  form: FormData,
): Promise<CreativeFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const policy = form.get("creative_policy");
  if (!isCreativePolicy(policy)) return { error: "Choose a policy." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data, error } = await supabase
    .from("social_posts")
    .update({ creative_policy: policy })
    .eq("id", postId)
    .eq("client_id", clientId)
    .eq("review_status", "draft")
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "The policy changes only while the post is a draft. Reload and look again." };
  revalidateCreative(clientId, postId);
  return { ok: true, text: "Saved." };
}

export async function requestNewCreativeAction(
  clientId: string,
  postId: string,
  _prev: CreativeFormState,
  form: FormData,
): Promise<CreativeFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data: post } = await supabase.from("social_posts").select("id").eq("id", postId).eq("client_id", clientId).maybeSingle();
  if (!post) return { error: "This post no longer exists." };
  const note = String(form.get("note") ?? "").trim().slice(0, 500);
  const { error } = await supabase.rpc("request_new_creative", { p_post_id: postId, p_note: note });
  if (error) return { error: error.message };
  revalidateCreative(clientId, postId);
  return { ok: true, text: "The graphic is unlinked and the post is a draft again. Render a new one." };
}

// ── Templates for a client ──────────────────────────────────────────────────

// Records a client-specific preview of one template version (the function's
// preview mode). This proposes the template for the client; it approves
// nothing.
export async function recordTemplatePreviewAction(clientId: string, key: string): Promise<CreativeFormState> {
  if (!isUuid(clientId)) return { error: "Unknown client." };
  const kit = Object.values(KITS).find((k) => k.client_id === clientId);
  const t = findTemplate(key, 1);
  const refs = lucasPreviewRefs(key);
  if (!kit || !t || !refs || t.spec.logo_asset_id !== kit.logo_asset_id) return { error: "No preview exists for this client and template." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const answer = await callCreativeEngine(supabase, {
    mode: "preview",
    client_id: clientId,
    template: { key: t.key, version: t.version, spec_hash: await specHash(t.spec) },
    ...refs,
  });
  revalidateCreative(clientId);
  if (answer.status === 200) return { ok: true, text: answer.body?.reused ? "Already recorded." : "Preview recorded. Look at it, then approve or revoke." };
  return { error: engineMessage(answer).text };
}

// Approve (proposed → approved) or revoke (proposed / approved → revoked) one
// template version for the client, conditional on the state the teammate saw.
export async function decideClientTemplateAction(
  clientId: string,
  rowId: string,
  decision: "approve" | "revoke",
  seenStatus: string,
): Promise<CreativeFormState> {
  if (!isUuid(clientId) || !isUuid(rowId)) return { error: "Unknown template approval." };
  if (decision === "approve" && seenStatus !== "proposed") return { error: "Only a proposed template can be approved." };
  if (decision === "revoke" && !["proposed", "approved"].includes(seenStatus)) return { error: "This template is already revoked." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { data, error } = await supabase
    .from("client_creative_templates")
    .update({ status: decision === "approve" ? "approved" : "revoked" })
    .eq("id", rowId)
    .eq("client_id", clientId)
    .eq("status", seenStatus)
    .select("id, status");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "This template changed since the page loaded. Reload and look again." };
  revalidateCreative(clientId);
  return { ok: true, text: decision === "approve" ? "Approved for this client." : "Revoked." };
}

// The default policy for new posts on one channel (client_creative_settings).
// Existing posts keep theirs.
export async function setChannelCreativePolicyAction(
  clientId: string,
  _prev: CreativeFormState,
  form: FormData,
): Promise<CreativeFormState> {
  if (!isUuid(clientId)) return { error: "Unknown client." };
  const channel = String(form.get("channel") ?? "");
  const policy = form.get("creative_policy");
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) return { error: "Choose a channel." };
  if (!isCreativePolicy(policy)) return { error: "Choose a policy." };
  const supabase = await start();
  if (!supabase) return { error: NOT_TEAM };
  const { error } = await supabase
    .from("client_creative_settings")
    .upsert({ client_id: clientId, channel: channel as (typeof CHANNELS)[number], creative_policy: policy }, { onConflict: "client_id,channel" });
  if (error) return { error: error.message };
  revalidateCreative(clientId);
  return { ok: true, text: "Saved. New posts on this channel start with this policy." };
}
