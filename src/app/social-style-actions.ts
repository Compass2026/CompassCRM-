"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import { isUuid } from "@/lib/tasks";
import { analyzeMessage, validateStyleReview } from "@/lib/social-style";

// Social › Style (Social History SH2). Three things a teammate does here, each
// as themselves:
//   run the analysis   the deployed social-history function's analyze mode,
//                      called with the teammate's own JWT; it records a
//                      PROPOSED profile (never approves)
//   approve / reject   social_history_style_review through PostgREST, bound to
//                      the profile hash the page showed (decision 1)
//   include / exclude  social_history_set_learning on an imported post
// Nothing here publishes, schedules, drafts or writes a claim.

export type StyleAnswer = { ok: boolean; text: string; changed?: boolean };

const NOT_TEAM = "Your session expired or you aren't on the Compass team. Sign in again and retry.";
const ANALYZE_TIMEOUT_MS = 60_000;
const path = (clientId: string) => `/clients/${clientId}/social/style`;

export async function runStyleAnalysisAction(clientId: string): Promise<StyleAnswer> {
  if (!isUuid(clientId)) return { ok: false, text: "Unknown client." };
  const supabase = await createClient();
  try { await requireTeamMember(supabase); } catch { return { ok: false, text: NOT_TEAM }; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, text: NOT_TEAM };
  let status: number | null = null;
  let body: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/social-history`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "analyze", client_id: clientId }),
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      cache: "no-store",
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* timeout or network: reported below */ }
  revalidatePath(path(clientId));
  return analyzeMessage(status, body);
}

export async function reviewStyleProfileAction(clientId: string, profileId: string, seenHash: string,
  decision: string, note: string): Promise<StyleAnswer> {
  if (!isUuid(clientId) || !isUuid(profileId) || !/^[0-9a-f]{64}$/.test(seenHash)) return { ok: false, text: "Unknown profile." };
  const v = validateStyleReview(decision, note);
  if (!v.ok) return { ok: false, text: v.error };
  const supabase = await createClient();
  try { await requireTeamMember(supabase); } catch { return { ok: false, text: NOT_TEAM }; }
  const { error } = await supabase.rpc("social_history_style_review", {
    p_profile_id: profileId, p_decision: v.decision, p_expected_hash: seenHash, p_note: v.note ?? undefined,
  });
  revalidatePath(path(clientId));
  if (error) {
    if (error.code === "SH409") return { ok: false, text: error.message, changed: true };
    return { ok: false, text: `Not saved: ${error.message}` };
  }
  return { ok: true, text: v.decision === "approve" ? "Approved. This is now the client's style profile (nothing reads it yet)." : "Rejected. Run the analysis again when the history or exclusions change." };
}

export async function setHistoryLearningAction(clientId: string, postId: string, status: string, note: string): Promise<StyleAnswer> {
  if (!isUuid(clientId) || !isUuid(postId)) return { ok: false, text: "Unknown post." };
  if (status !== "included" && status !== "excluded") return { ok: false, text: "Choose include or exclude." };
  if (status === "excluded" && !note.trim()) return { ok: false, text: "Say why the post is excluded from learning." };
  const supabase = await createClient();
  try { await requireTeamMember(supabase); } catch { return { ok: false, text: NOT_TEAM }; }
  const { error } = await supabase.rpc("social_history_set_learning", {
    p_post_id: postId, p_status: status, p_note: note.trim() || undefined,
  });
  revalidatePath(path(clientId));
  if (error) return { ok: false, text: `Not saved: ${error.message}` };
  return { ok: true, text: status === "excluded" ? "Excluded from style learning. Run the analysis again to update the profile." : "Included in style learning. Run the analysis again to update the profile." };
}
