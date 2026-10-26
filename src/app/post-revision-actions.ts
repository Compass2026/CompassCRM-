"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { postErrorMessage } from "@/lib/social-posts";
import { REVISION_CATEGORIES } from "@/lib/post-revisions";

// Rejection corrections (20261026200000). Every action checks the caller is
// on team_members first; the post_revision_* functions check again (a
// signed-in teammate through PostgREST) and hold every rule: one request per
// rejection, nothing approved, scheduled or published, history kept.

export type RevisionFormState = { ok?: boolean; error?: string; message?: string };

function revalidate(clientId: string, postId: string) {
  revalidatePath(`/clients/${clientId}/social`);
  revalidatePath(`/clients/${clientId}/social/${postId}`);
  revalidatePath("/tasks");
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

// One guarded call: the caller is a teammate, then the database decides.
async function run(
  clientId: string, postId: string, call: (supabase: Supabase) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<RevisionFormState & { data?: unknown }> {
  if (!isUuid(clientId) || !isUuid(postId)) return { error: "Unknown post." };
  const supabase = await createClient();
  await requireTeamMember(supabase);
  const { data, error } = await call(supabase);
  if (error) return { error: postErrorMessage(error.message) };
  revalidate(clientId, postId);
  return { ok: true, data };
}

// Correct what the reviewer rejected (the original stays in post history).
export async function reclassifyRevisionAction(
  clientId: string, postId: string, requestId: string, _prev: RevisionFormState, form: FormData,
): Promise<RevisionFormState> {
  const category = String(form.get("category") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!(REVISION_CATEGORIES as readonly string[]).includes(category)) return { error: "Pick caption, image or both." };
  if (!note) return { error: "Say why the category changes." };
  if (!isUuid(requestId)) return { error: "Unknown request." };
  return run(clientId, postId, (db) => db.rpc("post_revision_reclassify", { p_id: requestId, p_category: category, p_note: note.slice(0, 1000) }));
}

// Start (or retry) the automatic correction: Claude for the caption, ChatGPT
// (through Executive OS) for an image.
export async function requestCorrectionAction(clientId: string, postId: string, requestId: string): Promise<RevisionFormState> {
  if (!isUuid(requestId)) return { error: "Unknown request." };
  const r = await run(clientId, postId, (db) => db.rpc("post_revision_request_correction", { p_id: requestId }));
  return r.error ? r : { ok: true, message: "Requested. The page shows what was started." };
}

// Reopen to edit by hand: the automatic correction stops; the feedback stays.
export async function reopenManualAction(clientId: string, postId: string, requestId: string): Promise<RevisionFormState> {
  if (!isUuid(requestId)) return { error: "Unknown request." };
  return run(clientId, postId, (db) => db.rpc("post_revision_reopen_manual", { p_id: requestId }));
}

// Record that one rejected part needs no change (attributed, note required).
export async function resolveRevisionAction(
  clientId: string, postId: string, requestId: string, obligation: "copy" | "image", _prev: RevisionFormState, form: FormData,
): Promise<RevisionFormState> {
  const note = String(form.get("note") ?? "").trim();
  if (!note) return { error: "Say why it needs no change." };
  if (!isUuid(requestId) || (obligation !== "copy" && obligation !== "image")) return { error: "Unknown request." };
  return run(clientId, postId, (db) => db.rpc("post_revision_resolve", { p_id: requestId, p_obligation: obligation, p_note: note.slice(0, 1000) }));
}

// Edit the caption on the review screen: one transaction (withdraw or reopen,
// change only the caption, submit for a fresh review), bound to the caption
// this page showed. Claims, keyword, service, destination and media stay.
export async function editCaptionAction(
  clientId: string, postId: string, expectedCopyHash: string, _prev: RevisionFormState, form: FormData,
): Promise<RevisionFormState> {
  const copy = String(form.get("copy") ?? "").trim();
  if (!copy) return { error: "Write the caption." };
  if (!/^[0-9a-f]{64}$/.test(expectedCopyHash)) return { error: "Reload the page and try again." };
  const r = await run(clientId, postId, (db) => db.rpc("social_post_edit_caption", { p_post: postId, p_expected_copy_hash: expectedCopyHash, p_copy: copy }));
  if (r.error) return r;
  const d = (r.data ?? {}) as { review_status?: string; waiting?: string | null };
  return d.review_status === "in_review"
    ? { ok: true, message: "Saved and sent back for a fresh review." }
    : { ok: true, message: d.waiting ? "Caption saved. The post stays a draft until the rejected image is corrected." : "Caption saved." };
}
