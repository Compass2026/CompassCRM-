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

// A person posted an approved social post natively and records where.
// The database re-checks the approval hash and the grounding, and refuses
// Business Profile posts (only the publisher publishes those).
export async function markPublishedAction(
  clientId: string,
  postId: string,
  fromPublish: string,
  _prev: PostFormState,
  form: FormData
): Promise<PostFormState> {
  const url = String(form.get("published_url") ?? "").trim();
  const local = String(form.get("published_at") ?? "").trim();
  if (!/^https:\/\/\S+$/i.test(url)) return { error: "Paste the post's https:// link." };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return { error: "When was it published?" };
  if (!["not_scheduled", "scheduled", "failed"].includes(fromPublish)) return { error: "The post cannot be marked published now." };
  const at = centralToIso(local);
  if (!at) return { error: "That date and time is not valid." };
  if (Date.parse(at) > Date.now() + 5 * 60_000) return { error: "The publication time is in the future." };
  const externalId = String(form.get("external_post_id") ?? "").trim();
  return step(clientId, postId, {
    from: { review_status: "approved", publish_status: fromPublish },
    set: { publish_status: "published", published_url: url, published_at: at, external_post_id: externalId || null },
  });
}

// Publish now (Business Profile, 0046): the same governed path as the
// 5-minute tick. The post is put in the queue (scheduled, due now) and the
// post-publisher function is asked, with this person's JWT, to run that one
// post: switch and pilot list, preflight, claim (0045 re-checks the approval
// fingerprint and grounding), send from the approved snapshot, record a
// publisher_runs row. Nothing here talks to Google or writes publish state
// past scheduled.
export async function publishNowAction(clientId: string, postId: string): Promise<PostFormState> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const supabase = await start();
  const { data: post } = await supabase
    .from("social_posts")
    .select("review_status, publish_status, platform")
    .eq("id", postId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!post) return { error: "Unknown post." };
  if (post.platform !== "google_business") return { error: "Only Business Profile posts go through the publisher." };
  if (post.review_status !== "approved") return { error: "Only an approved post can be published." };
  let queuedHere = false;
  if (post.publish_status === "not_scheduled" || post.publish_status === "failed") {
    const queued = await step(clientId, postId, {
      from: { review_status: "approved", publish_status: post.publish_status },
      set: { scheduled_at: new Date().toISOString(), publish_status: "scheduled" },
    });
    if (queued.error) return queued;
    queuedHere = true;
  } else if (post.publish_status !== "scheduled") {
    return { error: `The post is ${post.publish_status}.` };
  }

  const answer = await callPublisher(supabase, postId);
  revalidatePost(clientId, postId);
  if (!answer) {
    return {
      error: queuedHere
        ? "The publisher did not answer. The post is scheduled for now and the next 5-minute run will take it; unschedule it to stop that."
        : "The publisher did not answer. The post stays scheduled for the next 5-minute run.",
    };
  }
  const result = ((answer as { results?: { post_id: string; outcome: string; detail?: string | null }[] })?.results ?? [])
    .filter((r) => r.post_id === postId)
    .at(-1);
  if (result?.outcome === "published" || result?.outcome === "reconciled") return { ok: true };
  // A block leaves nothing queued behind a person's back: a post this click
  // scheduled goes back to not scheduled (the run and any task stay on record).
  if (result?.outcome === "blocked" && queuedHere) {
    await supabase
      .from("social_posts")
      .update({ publish_status: "not_scheduled" })
      .eq("id", postId)
      .eq("client_id", clientId)
      .eq("publish_status", "scheduled");
    revalidatePost(clientId, postId);
  }
  return { error: publishNowMessage(result?.outcome, result?.detail) };
}

// The function checks this person's JWT against team_members itself; the
// anon key is only the gateway's apikey.
async function callPublisher(supabase: Supabase, postId: string): Promise<unknown | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/post-publisher`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "now", post_id: postId }),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function publishNowMessage(outcome: string | undefined, detail: string | null | undefined): string {
  const why = detail ? ` ${detail}` : "";
  switch (outcome) {
    case "blocked":
      return `Not published.${why}`;
    case "lapsed":
      return `Not published: what the approval stood on changed, so the post went back to review.${why}`;
    case "failed":
      return `Google refused or did not answer.${why}`;
    case "uncertain":
      return "Google accepted the post without naming it. Nothing is recorded yet: the publisher checks the profile within about 10 minutes.";
    case "ambiguous":
      return `Not sent again and not recorded: the profile needs a person's check (see the task).${why}`;
    case "skipped":
      return `Nothing was sent.${why}`;
    default:
      return "Nothing was sent; see the publisher history below.";
  }
}

export async function linkAssetAction(clientId: string, postId: string, _prev: PostFormState, form: FormData): Promise<PostFormState> {
  const assetId = form.get("brand_asset_id");
  if (!isUuid(clientId) || !isUuid(postId) || !isUuid(assetId)) return { error: "Pick an asset." };
  const supabase = await start();
  const { data: last } = await supabase
    .from("post_assets")
    .select("sort_order")
    .eq("post_id", postId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase
    .from("post_assets")
    .insert({ post_id: postId, client_id: clientId, brand_asset_id: assetId, sort_order: (last?.sort_order ?? 0) + 1 });
  if (error) {
    return { error: /duplicate key/.test(error.message) ? "That asset is already on the post." : postErrorMessage(error.message) };
  }
  revalidatePost(clientId, postId);
  return { ok: true };
}

export async function unlinkAssetAction(clientId: string, postId: string, assetId: string): Promise<void> {
  if (!isUuid(clientId) || !isUuid(postId) || !isUuid(assetId)) return;
  const supabase = await start();
  const { error } = await supabase.from("post_assets").delete().eq("post_id", postId).eq("brand_asset_id", assetId);
  if (error) throw new Error(postErrorMessage(error.message));
  revalidatePost(clientId, postId);
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
