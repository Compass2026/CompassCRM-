"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import type { Database } from "@/lib/database.types";
import { parsePostFields, postErrorMessage } from "@/lib/social-posts";

// Posts and their review gate (0045). Every action checks the caller is on
// team_members first. The database enforces the workflow again and is the
// authority: who may approve (a person through the API, never the worker),
// what is frozen, grounding, and that nothing belongs to another client.

export type PostFormState = { ok?: boolean; error?: string };

function revalidatePost(clientId: string, postId?: string) {
  revalidatePath(`/clients/${clientId}/social`);
  if (postId) revalidatePath(`/clients/${clientId}/social/${postId}`);
  revalidatePath(`/clients/${clientId}/reports`);
  revalidatePath(`/clients/${clientId}/tasks`);
  revalidatePath("/tasks");
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function start(): Promise<Supabase> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  return supabase;
}

export async function createPostAction(clientId: string, _prev: PostFormState, form: FormData): Promise<PostFormState> {
  if (!isUuid(clientId)) return { error: "Unknown client." };
  const supabase = await start();
  const parsed = parsePostFields((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { data, error } = await supabase
    .from("social_posts")
    .insert({ client_id: clientId, ...parsed.value })
    .select("id")
    .single();
  if (error) return { error: postErrorMessage(error.message) };
  revalidatePost(clientId);
  redirect(`/clients/${clientId}/social/${data.id}`);
}

export async function updatePostAction(
  clientId: string,
  postId: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const supabase = await start();
  const parsed = parsePostFields((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };
  const { data, error } = await supabase
    .from("social_posts")
    .update(parsed.value)
    .eq("id", postId)
    .eq("client_id", clientId)
    .eq("review_status", "draft")
    .select("id");
  if (error) return { error: postErrorMessage(error.message) };
  if (!data?.length) return { error: "Only a draft can be edited. Withdraw or reopen it first." };
  revalidatePost(clientId, postId);
  return { ok: true };
}

export async function linkClaimAction(clientId: string, postId: string, _prev: PostFormState, form: FormData): Promise<PostFormState> {
  const claimId = form.get("claim_id");
  if (!isUuid(clientId) || !isUuid(postId) || !isUuid(claimId)) return { error: "Pick a claim." };
  const supabase = await start();
  const { error } = await supabase.from("post_claims").insert({ post_id: postId, client_id: clientId, claim_id: claimId });
  if (error) {
    return { error: /duplicate key/.test(error.message) ? "That claim is already linked." : postErrorMessage(error.message) };
  }
  revalidatePost(clientId, postId);
  return { ok: true };
}

export async function unlinkClaimAction(clientId: string, postId: string, claimId: string): Promise<void> {
  if (!isUuid(clientId) || !isUuid(postId) || !isUuid(claimId)) return;
  const supabase = await start();
  const { error } = await supabase.from("post_claims").delete().eq("post_id", postId).eq("claim_id", claimId);
  if (error) throw new Error(postErrorMessage(error.message));
  revalidatePost(clientId, postId);
}

// Review and scheduling steps. Each is one guarded update: the WHERE clause
// names the state the person saw, so a post that moved meanwhile is not
// changed and the page says so instead.
type Step = {
  from: { review_status: string; publish_status?: string; submitted_at?: string | null };
  set: Database["public"]["Tables"]["social_posts"]["Update"];
};

async function step(clientId: string, postId: string, s: Step): Promise<PostFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const supabase = await start();
  let q = supabase
    .from("social_posts")
    .update(s.set)
    .eq("id", postId)
    .eq("client_id", clientId)
    .eq("review_status", s.from.review_status);
  if (s.from.publish_status) q = q.eq("publish_status", s.from.publish_status);
  if (s.from.submitted_at) q = q.eq("submitted_at", s.from.submitted_at);
  const { data, error } = await q.select("id");
  if (error) return { error: postErrorMessage(error.message) };
  if (!data?.length) return { error: "The post changed since this page loaded. Reload and look again." };
  revalidatePost(clientId, postId);
  return { ok: true };
}

export async function submitPostAction(clientId: string, postId: string): Promise<PostFormState> {
  return step(clientId, postId, { from: { review_status: "draft" }, set: { review_status: "in_review" } });
}

export async function withdrawPostAction(clientId: string, postId: string): Promise<PostFormState> {
  return step(clientId, postId, { from: { review_status: "in_review" }, set: { review_status: "draft" } });
}

// The reviewer approves the submission they looked at: submitted_at pins it,
// so a post withdrawn, edited and resubmitted meanwhile is not approved.
export async function approvePostAction(
  clientId: string,
  postId: string,
  submittedAt: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  if (!submittedAt) return { error: "The post is not in review." };
  const note = String(form.get("review_note") ?? "").trim();
  return step(clientId, postId, {
    from: { review_status: "in_review", submitted_at: submittedAt },
    set: { review_status: "approved", review_note: note || null },
  });
}

export async function rejectPostAction(
  clientId: string,
  postId: string,
  submittedAt: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  const note = String(form.get("review_note") ?? "").trim();
  if (!note) return { error: "Say why the post is rejected, so it can be fixed." };
  if (!submittedAt) return { error: "The post is not in review." };
  return step(clientId, postId, {
    from: { review_status: "in_review", submitted_at: submittedAt },
    set: { review_status: "rejected", review_note: note.slice(0, 2000) },
  });
}

export async function revisePostAction(clientId: string, postId: string): Promise<PostFormState> {
  return step(clientId, postId, { from: { review_status: "rejected" }, set: { review_status: "draft" } });
}

export async function reopenPostAction(clientId: string, postId: string): Promise<PostFormState> {
  return step(clientId, postId, { from: { review_status: "approved" }, set: { review_status: "draft" } });
}

// Schedules in Central time (the agency's day) from a datetime-local value.
export async function schedulePostAction(
  clientId: string,
  postId: string,
  fromPublish: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  const local = String(form.get("scheduled_at") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return { error: "Pick a date and time." };
  if (fromPublish !== "not_scheduled" && fromPublish !== "failed") return { error: "The post is already scheduled." };
  const at = centralToIso(local);
  if (!at) return { error: "That date and time is not valid." };
  return step(clientId, postId, {
    from: { review_status: "approved", publish_status: fromPublish },
    set: { scheduled_at: at, publish_status: "scheduled" },
  });
}

export async function unschedulePostAction(clientId: string, postId: string): Promise<PostFormState> {
  return step(clientId, postId, {
    from: { review_status: "approved", publish_status: "scheduled" },
    set: { publish_status: "not_scheduled" },
  });
}

export async function deletePostAction(clientId: string, postId: string): Promise<void> {
  if (!isUuid(clientId) || !isUuid(postId)) return;
  const supabase = await start();
  const { error } = await supabase.from("social_posts").delete().eq("id", postId).eq("client_id", clientId);
  if (error) throw new Error(postErrorMessage(error.message));
  revalidatePost(clientId);
  redirect(`/clients/${clientId}/social`);
}

// "2026-10-02T09:30" in America/Chicago → ISO instant.
function centralToIso(local: string): string | null {
  const guess = new Date(`${local}:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asCentral = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offset = asCentral - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}
