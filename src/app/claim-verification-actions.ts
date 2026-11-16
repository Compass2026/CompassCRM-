"use server";

// Claims verification (20261104200000). The decisions go to the database's
// own writers (claim_classify / claim_verify / claim_revoke), which decide who
// may make them (the verification owner, signed in) and what evidence each
// method needs; these actions only pass the form through and report the
// database's answer. Evidence files go through the claim-evidence Edge
// Function, which hashes the stored bytes itself.
// Nothing here writes a table directly.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { decisionErrorText } from "@/lib/claim-registry";

export type ActionResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

function revalidate(clientId: string) {
  revalidatePath(`/clients/${clientId}/intelligence`);
}

const opt = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? undefined : t;
};

export async function classifyClaimAction(
  clientId: string,
  input: { claimId: string; kind: string; fingerprint: string; reviewId: string | null; note?: string | null },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_classify", {
    p_claim_id: input.claimId,
    p_kind: input.kind,
    p_expected_fingerprint: input.fingerprint,
    p_expected_review_id: input.reviewId ?? undefined,
    p_note: opt(input.note),
  });
  if (error) return { ok: false, error: error.message };
  revalidate(clientId);
  return { ok: true };
}

export async function verifyClaimAction(
  clientId: string,
  input: {
    claimId: string;
    action: "verify" | "review";
    method: string;
    evidenceId?: string | null;
    locationId?: string | null;
    excerpt: string;
    observedOn: string;
    expiresOn?: string | null;
    confirmedByContact?: string | null;
    note?: string | null;
    fingerprint: string;
    reviewId: string | null;
  },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_verify", {
    p_claim_id: input.claimId,
    p_action: input.action,
    p_method: input.method,
    p_excerpt: input.excerpt,
    p_observed_on: input.observedOn,
    p_expected_fingerprint: input.fingerprint,
    p_expected_review_id: input.reviewId ?? undefined,
    p_evidence_id: opt(input.evidenceId),
    p_location_id: opt(input.locationId),
    p_expires_on: opt(input.expiresOn),
    p_confirmed_by_contact: opt(input.confirmedByContact),
    p_note: opt(input.note),
  });
  if (error) return { ok: false, error: decisionErrorText(error) };
  revalidate(clientId);
  return { ok: true };
}

export async function revokeClaimAction(
  clientId: string,
  input: { claimId: string; reason: string; fingerprint: string; reviewId: string | null },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_revoke", {
    p_claim_id: input.claimId,
    p_reason: input.reason,
    p_expected_fingerprint: input.fingerprint,
    p_expected_review_id: input.reviewId ?? undefined,
  });
  if (error) return { ok: false, error: error.message };
  revalidate(clientId);
  return { ok: true };
}

// ── Evidence files (the claim-evidence Edge Function, with the caller's JWT) ──
async function callEvidence(body: Record<string, unknown>): Promise<ActionResult<{ body: Record<string, unknown> }>> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: "Not signed in" };
  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/claim-evidence`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `The evidence service could not be reached: ${(e as Error).message}` };
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: text.slice(0, 300) || `The evidence service answered ${res.status}` };
  }
  if (!res.ok) return { ok: false, error: String(json.error ?? `The evidence service answered ${res.status}`) };
  return { ok: true, body: json };
}

export async function prepareClaimEvidenceAction(
  clientId: string,
  input: { sha256: string; size: number; mimeType: string },
): Promise<ActionResult<{ body: Record<string, unknown> }>> {
  return callEvidence({ mode: "prepare", client_id: clientId, sha256: input.sha256, size: input.size, mime_type: input.mimeType });
}

export async function finalizeClaimEvidenceAction(
  clientId: string,
  input: {
    uploadId: string;
    path: string;
    evidenceType: "document" | "capture";
    label: string;
    originalName?: string | null;
    sourceUrl?: string | null;
    capturedOn?: string | null;
  },
): Promise<ActionResult<{ body: Record<string, unknown> }>> {
  const r = await callEvidence({
    mode: "finalize",
    client_id: clientId,
    upload_id: input.uploadId,
    path: input.path,
    evidence_type: input.evidenceType,
    label: input.label,
    original_name: opt(input.originalName),
    source_url: opt(input.sourceUrl),
    captured_on: opt(input.capturedOn),
  });
  if (r.ok) revalidate(clientId);
  return r;
}

/**
 * A 60-second link to look at a registered evidence file (PR2a.1, H4). It is
 * signed with the teammate's own session, so the bucket's team-read policy
 * decides, and Storage's request log records who looked. The bucket stays
 * private and nothing is written.
 */
export async function viewClaimEvidenceAction(evidenceId: string): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();
  // claim_evidence is not in the generated types yet; team-read RLS applies.
  const { data, error } = await supabase
    .from("claim_evidence" as never)
    .select("storage_path")
    .eq("id" as never, evidenceId as never)
    .maybeSingle();
  const ev = data as { storage_path: string } | null;
  if (error) return { ok: false, error: error.message };
  if (!ev) return { ok: false, error: "That evidence file was not found." };
  const { data: signed, error: signError } = await supabase.storage.from("claim-evidence").createSignedUrl(ev.storage_path, 60);
  if (signError || !signed?.signedUrl) return { ok: false, error: signError?.message ?? "The file could not be opened." };
  return { ok: true, url: signed.signedUrl };
}

export async function checkClaimEvidenceAction(
  evidenceId: string,
): Promise<ActionResult<{ body: Record<string, unknown> }>> {
  return callEvidence({ mode: "check", evidence_id: evidenceId });
}
