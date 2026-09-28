"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { sameReviewSnapshot, validateReview, type ReviewAsset, type ReviewSnapshot } from "@/lib/creative-use";

// Creative use review (0054 / 0055). One update of the asset's governed
// fields, as the signed-in teammate through PostgREST: the database stamps
// the reviewer and time and writes the governance history; it refuses
// anyone else. The decision applies to the file the teammate saw — if the
// hash or the review changed since the page loaded, nothing is written.
// Nothing here hashes, uploads, generates or publishes.

export type ReviewAnswer = { ok: true; text: string } | { ok: false; text: string; errors?: string[]; changed?: boolean };

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const CHANGED = "This image changed since the page loaded (new file, new hash or another review). The page now shows its current state.";
const COLUMNS = "id, kind, source, label, storage_path, url, width, height, content_hash, content_hashed_at, creative_use, depicts_own_work, subjects, focal_x, focal_y, creative_review_note, creative_reviewed_at, creative_suggestions";

export async function reviewCreativeUseAction(
  clientId: string,
  assetId: string,
  seen: ReviewSnapshot,
  form: { decision: string; ownWork: string; subjects: string; focalX: string; focalY: string; reason: string },
): Promise<ReviewAnswer> {
  if (!isUuid(clientId) || !isUuid(assetId)) return { ok: false, text: "Unknown image." };
  const supabase = await createClient();
  try { await requireTeamMember(supabase); } catch { return { ok: false, text: NOT_TEAM }; }

  const { data: asset } = await supabase.from("brand_assets").select(COLUMNS).eq("id", assetId).eq("client_id", clientId).maybeSingle();
  if (!asset) return { ok: false, text: "This image no longer exists.", changed: true };
  const current = asset as unknown as ReviewAsset;
  if (!sameReviewSnapshot(current, seen)) {
    revalidatePath(`/clients/${clientId}/brand/creative-use`);
    return { ok: false, text: CHANGED, changed: true };
  }
  const v = validateReview(current, form);
  if (!v.ok) return { ok: false, text: "Not saved.", errors: v.errors };

  // Conditional on the snapshot too, so a concurrent change is never overwritten.
  let q = supabase.from("brand_assets").update(v.patch).eq("id", assetId).eq("client_id", clientId).eq("creative_use", seen.creative_use);
  q = seen.content_hash ? q.eq("content_hash", seen.content_hash) : q.is("content_hash", null);
  q = seen.creative_reviewed_at ? q.eq("creative_reviewed_at", seen.creative_reviewed_at) : q.is("creative_reviewed_at", null);
  const { data: updated, error } = await q.select("id, creative_use");
  if (error) return { ok: false, text: `Not saved: ${error.message}` };
  if (!updated?.length) {
    revalidatePath(`/clients/${clientId}/brand/creative-use`);
    return { ok: false, text: CHANGED, changed: true };
  }
  revalidatePath(`/clients/${clientId}/brand/creative-use`);
  revalidatePath(`/clients/${clientId}/brand`);
  const text = v.patch.creative_use === "approved" ? "Approved for creative use."
    : v.patch.creative_use === "excluded" ? "Excluded from creative use."
    : "Saved; the image stays unreviewed.";
  return { ok: true, text };
}
