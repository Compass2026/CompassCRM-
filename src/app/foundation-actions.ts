"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/database.types";

type Enums = Database["public"]["Enums"];

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function int(form: FormData, key: string): number | null {
  const v = str(form, key);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function whoami(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ?? "team";
}

function revalidate(clientId: string) {
  revalidatePath(`/clients/${clientId}/foundation`);
  revalidatePath(`/clients/${clientId}/pipelines`);
  revalidatePath(`/clients/${clientId}`);
}

// ── Foundation stages ──────────────────────────────────────────────────────
// Updates only status / evidence / next_action; the gate triggers in Postgres
// decide whether the transition is allowed.
export async function setFoundationStageAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const stageId = str(form, "client_stage_id");
  if (!stageId) throw new Error("Missing stage id");
  const { error } = await supabase
    .from("client_stages")
    .update({
      status: (str(form, "status") as Enums["stage_status"]) ?? undefined,
      evidence: str(form, "evidence"),
      next_action: str(form, "next_action"),
    })
    .eq("id", stageId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

async function brandBuildStageId(clientId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("client_stages")
    .select(
      "id, status, client_pipelines!inner(client_id, pipelines(key)), stages(sort_order)"
    )
    .eq("client_pipelines.client_id", clientId);
  const stage = (data ?? []).find(
    (cs) =>
      cs.client_pipelines?.pipelines?.key === "foundation" &&
      cs.stages?.sort_order === 2
  );
  return stage?.id ?? null;
}

// ── Brand board ────────────────────────────────────────────────────────────
export async function approveBrandBoardAction(
  clientId: string,
  boardId: string,
  form: FormData
) {
  const supabase = await createClient();
  const who = await whoami();
  const now = new Date().toISOString();
  const { data: board, error } = await supabase
    .from("brand_boards")
    .update({ status: "approved", approved_by: who, approved_on: now })
    .eq("id", boardId)
    .eq("client_id", clientId)
    .select("version")
    .single();
  if (error) throw new Error(error.message);

  if (form.get("complete_stage") === "on") {
    const stageId = await brandBuildStageId(clientId);
    if (stageId) {
      const { error: stageError } = await supabase
        .from("client_stages")
        .update({
          status: "complete",
          evidence: `Brand board v${board.version} approved by ${who} on ${now.slice(0, 10)}.`,
          next_action: null,
        })
        .eq("id", stageId)
        .neq("status", "complete");
      if (stageError) throw new Error(stageError.message);
    }
  }
  revalidate(clientId);
}

export async function reopenBrandBoardAction(clientId: string, boardId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("brand_boards")
    .update({ status: "draft", approved_by: null, approved_on: null })
    .eq("id", boardId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function updateBrandBoardAction(
  clientId: string,
  boardId: string,
  form: FormData
) {
  const supabase = await createClient();
  const rules = (str(form, "hard_rules") ?? "")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  const { error } = await supabase
    .from("brand_boards")
    .update({
      positioning_line: str(form, "positioning_line"),
      standing_cta: str(form, "standing_cta"),
      hard_rules: rules,
      drive_doc_url: str(form, "drive_doc_url"),
    })
    .eq("id", boardId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function createBrandBoardAction(clientId: string) {
  const supabase = await createClient();
  const { data: latest } = await supabase
    .from("brand_boards")
    .select("version")
    .eq("client_id", clientId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase.from("brand_boards").insert({
    client_id: clientId,
    version: (latest?.version ?? 0) + 1,
    status: "draft",
    palette: [],
    typography: {},
  });
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

async function loadPalette(boardId: string, clientId: string): Promise<Json[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brand_boards")
    .select("palette")
    .eq("id", boardId)
    .eq("client_id", clientId)
    .single();
  if (error) throw new Error(error.message);
  if (data.palette === null) return [];
  if (!Array.isArray(data.palette)) {
    throw new Error(
      "This palette is stored in the structured (Shewmaker) shape; edit it in the brand board doc."
    );
  }
  return data.palette;
}

export async function addPaletteColorAction(
  clientId: string,
  boardId: string,
  form: FormData
) {
  const hex = (str(form, "hex") ?? "").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error("Hex must look like #b5542a");
  const palette = await loadPalette(boardId, clientId);
  palette.push({
    role: str(form, "role") ?? "other",
    name: str(form, "name") ?? hex,
    hex,
    usage: str(form, "usage"),
    source: str(form, "source") ?? "sourced",
  });
  const supabase = await createClient();
  const { error } = await supabase
    .from("brand_boards")
    .update({ palette })
    .eq("id", boardId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function removePaletteColorAction(
  clientId: string,
  boardId: string,
  index: number
) {
  const palette = await loadPalette(boardId, clientId);
  palette.splice(index, 1);
  const supabase = await createClient();
  const { error } = await supabase
    .from("brand_boards")
    .update({ palette })
    .eq("id", boardId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function setTypographyAction(
  clientId: string,
  boardId: string,
  form: FormData
) {
  const supabase = await createClient();
  const typography: { [key: string]: string } = {};
  for (const key of ["heading", "body", "accent", "notes"]) {
    const v = str(form, key);
    if (v) typography[key] = v;
  }
  const { error } = await supabase
    .from("brand_boards")
    .update({ typography })
    .eq("id", boardId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

// ── Claims ─────────────────────────────────────────────────────────────────
export async function setClaimStatusAction(
  clientId: string,
  claimId: string,
  status: Enums["claim_status"]
) {
  const supabase = await createClient();
  const confirmed = status === "confirmed";
  const { error } = await supabase
    .from("claims")
    .update({
      status,
      confirmed_by: confirmed ? await whoami() : null,
      confirmed_on: confirmed ? new Date().toISOString() : null,
    })
    .eq("id", claimId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function addClaimAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const claim = str(form, "claim");
  if (!claim) throw new Error("Claim text is required");
  const { error } = await supabase.from("claims").insert({
    client_id: clientId,
    claim,
    status: (str(form, "status") as Enums["claim_status"]) ?? "unverified",
    source: str(form, "source"),
  });
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function deleteClaimAction(clientId: string, claimId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("claims")
    .delete()
    .eq("id", claimId)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

// ── Money keywords ─────────────────────────────────────────────────────────
export async function addMoneyKeywordAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const keywordId = str(form, "keyword_id");
  if (!keywordId) throw new Error("Pick a keyword");
  const { error } = await supabase.from("money_keywords").insert({
    client_id: clientId,
    keyword_id: keywordId,
    alert_threshold_map: int(form, "alert_threshold_map") ?? 3,
    alert_threshold_organic: int(form, "alert_threshold_organic") ?? 5,
  });
  if (error) throw new Error(error.message);
  revalidate(clientId);
  revalidatePath(`/clients/${clientId}/keywords`);
}

export async function confirmMoneyKeywordAction(clientId: string, id: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("money_keywords")
    .update({ confirmed_by: await whoami(), confirmed_on: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function unconfirmMoneyKeywordAction(clientId: string, id: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("money_keywords")
    .update({ confirmed_by: null, confirmed_on: null })
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function updateMoneyThresholdsAction(
  clientId: string,
  id: string,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("money_keywords")
    .update({
      alert_threshold_map: int(form, "alert_threshold_map") ?? 3,
      alert_threshold_organic: int(form, "alert_threshold_organic") ?? 5,
    })
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
}

export async function removeMoneyKeywordAction(clientId: string, id: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("money_keywords")
    .delete()
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  revalidate(clientId);
  revalidatePath(`/clients/${clientId}/keywords`);
}

// ── Provisioning (Edge Function) ───────────────────────────────────────────
// Creates the client's Drive folder structure and site repo, or reports which
// credentials are missing. Idempotent — safe to press twice, and safe to press
// after a partial run.
export type ProvisionState = { ok: boolean; message: string } | null;

type ProvisionStep = { status: string; detail: string };

export async function provisionClientAction(
  clientId: string,
  _prev: ProvisionState,
  _form: FormData
): Promise<ProvisionState> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, message: "Not signed in." };

  let res: Response;
  try {
    res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/client-provision`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: clientId }),
      }
    );
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not reach the provisioning function.",
    };
  }

  const payload = (await res.json().catch(() => null)) as
    | { drive?: ProvisionStep; github?: ProvisionStep; error?: string }
    | null;
  if (!payload) {
    return { ok: false, message: `Provisioning failed (${res.status}).` };
  }
  if (payload.error) return { ok: false, message: payload.error };

  const parts = [
    payload.drive ? `Drive: ${payload.drive.detail}` : null,
    payload.github ? `GitHub: ${payload.github.detail}` : null,
  ].filter(Boolean);

  revalidatePath(`/clients/${clientId}/foundation`);
  revalidatePath(`/clients/${clientId}`);
  return { ok: res.ok, message: parts.join(" ") || "Nothing to do." };
}
