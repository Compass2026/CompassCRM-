"use server";

// The review queue's decisions (20261116150000). Approve & schedule is one
// database call (social_post_approve_and_schedule): the approval and the
// schedule commit together and the approval then names its time. Approve
// only and Reject reuse the post page's actions (approvePostAction,
// rejectPostAction), so both pages make the same decision the same way.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { postErrorMessage } from "@/lib/social-posts";
import { centralToIso } from "@/lib/review-queue";
import type { PostFormState } from "@/app/social-post-actions";

function revalidateQueue(clientId: string, postId: string) {
  revalidatePath("/review");
  revalidatePath(`/clients/${clientId}/social`);
  revalidatePath(`/clients/${clientId}/social/${postId}`);
  revalidatePath("/tasks");
}

export async function approveAndScheduleAction(
  clientId: string,
  postId: string,
  submittedAt: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  if (!submittedAt) return { error: "The post is not in review." };
  const at = centralToIso(String(form.get("publish_at") ?? "").trim());
  if (!at) return { error: "Pick the publish date and time (Central)." };
  if (Date.parse(at) < Date.now() + 2 * 60_000) return { error: "Pick a publish time at least a few minutes from now." };
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const note = String(form.get("review_note") ?? "").trim();
  const { error } = await supabase.rpc("social_post_approve_and_schedule", {
    p_post: postId,
    p_submitted_at: submittedAt,
    p_publish_at: at,
    p_note: note || undefined,
  });
  if (error) return { error: postErrorMessage(error.message) };
  revalidateQueue(clientId, postId);
  return { ok: true };
}

export async function setNoImageReasonAction(
  clientId: string,
  postId: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const reason = String(form.get("no_image_reason") ?? "").trim();
  if (reason && reason.length < 3) return { error: "Say why in a few words." };
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const { error } = await supabase.rpc("social_post_set_no_image_reason", { p_post: postId, p_reason: reason });
  if (error) return { error: postErrorMessage(error.message) };
  revalidateQueue(clientId, postId);
  return { ok: true };
}
