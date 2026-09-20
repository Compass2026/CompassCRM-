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

// ── Redeploy (Edge Function) ───────────────────────────────────────────────
// site-push with { deploy: true } and no files: ensure the Vercel project and
// start a production deployment of the branch it last pushed. No commit.
export type RedeployState = { ok: boolean; message: string } | null;

type VercelStep = {
  status: "created" | "deployed" | "skipped" | "failed";
  project?: string;
  staging_url?: string;
  detail?: string;
};

export async function redeploySiteAction(
  clientId: string,
  _prev: RedeployState,
  _form: FormData
): Promise<RedeployState> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, message: "Not signed in." };

  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/site-push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId, deploy: true }),
    });
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not reach site-push.",
    };
  }

  const payload = (await res.json().catch(() => null)) as
    | { vercel?: VercelStep; branch?: string; error?: string }
    | null;
  if (!payload) return { ok: false, message: `Redeploy failed (${res.status}).` };
  if (payload.error) return { ok: false, message: payload.error };

  revalidatePath(`/clients/${clientId}/foundation`);
  const v = payload.vercel;
  if (!v) return { ok: res.ok, message: "No Vercel result returned." };
  switch (v.status) {
    case "created":
    case "deployed":
      return {
        ok: true,
        message: `Deployment started for ${payload.branch ?? "the pushed branch"} → ${v.staging_url ?? v.project ?? "Vercel"}. It is live in about a minute.`,
      };
    case "skipped":
      return { ok: false, message: "VERCEL_TOKEN is not in Vault, so nothing was deployed." };
    default:
      return { ok: false, message: `Vercel: ${v.detail ?? "deployment failed."}` };
  }
}

// "Put it back": one commit on the site's branch that restores the previous
// commit's tree, then a production deployment of it (Vercel's Git
// integration blocks commits from non-members, so site-push deploys). The
// change stays in history.
export async function revertSiteAction(
  clientId: string,
  _prev: RedeployState,
  _form: FormData
): Promise<RedeployState> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, message: "Not signed in." };

  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/site-push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId, revert: true }),
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not reach site-push." };
  }
  const payload = (await res.json().catch(() => null)) as
    | { commit_url?: string; restored?: string; error?: string }
    | null;
  if (!payload) return { ok: false, message: `Revert failed (${res.status}).` };
  if (payload.error) return { ok: false, message: payload.error };

  // The revert commit is on the branch; now deploy it.
  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/site-push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId, deploy: true }),
  }).catch(() => null);

  await supabase.from("change_log").insert({
    client_id: clientId,
    object_type: "site",
    change_type: "revert",
    before: {},
    after: { commit: payload.commit_url ?? null, restored: payload.restored ?? null },
    reasoning: `Put it back pressed by ${await whoami()}.`,
    status: "approved",
  });
  revalidatePath(`/clients/${clientId}/foundation`);
  return {
    ok: true,
    message: `Put back to ${payload.restored?.slice(0, 7) ?? "the previous commit"}. Vercel redeploys it in about a minute.`,
  };
}

// ── Website work mode and the build brief (Foundation integration) ─────────
import { composeBuildBrief, type BriefInput } from "@/lib/build-brief";
import type { ContentPaths } from "@/lib/content-adapters";

export type WorkModeState = { ok: boolean; message: string } | null;

export async function setWorkModeAction(clientId: string, _prev: WorkModeState, form: FormData): Promise<WorkModeState> {
  const supabase = await createClient();
  const raw = str(form, "work_mode");
  const mode = raw === "new_build" || raw === "upgrade_existing" || raw === "client_retains" ? raw : null;
  const { data: site } = await supabase.from("sites").select("id").eq("client_id", clientId).order("created_at").limit(1).maybeSingle();
  if (!site) return { ok: false, message: "No site row yet — the intake or the worker's Discovery step records one." };
  const { error } = await supabase
    .from("sites")
    .update({ work_mode: mode, ...(mode === "client_retains" ? { controlled_by_compass: false } : mode ? { controlled_by_compass: true } : {}) })
    .eq("id", site.id);
  if (error) return { ok: false, message: error.message };
  revalidate(clientId);
  return { ok: true, message: mode ? `Work mode ${mode}. Enrollments are unchanged — the Plan tab decides those.` : "Work mode cleared." };
}

export type BuildBriefState = { ok: boolean; message: string } | null;

/**
 * Compose the build brief from what the CRM holds today and store it on the
 * site row. The repository tree is not read here (the app holds no GitHub
 * token); the worker refreshes the brief with the detected adapter when it
 * runs, and files the Drive copy. Every unknown lands in missing_inputs.
 */
export async function generateBuildBriefAction(clientId: string, _prev: BuildBriefState, _form: FormData): Promise<BuildBriefState> {
  const supabase = await createClient();
  const who = await whoami();
  const [{ data: client }, { data: site }, { data: services }, { data: groups }, { data: claims }, { data: locations }, { data: brand }, { data: board }, { data: assets }, { data: release }] =
    await Promise.all([
      supabase.from("clients").select("id, name, dba, vertical, business_type, phone, city, state, address_line1, service_area, website_url, drive_folders").eq("id", clientId).single(),
      supabase.from("sites").select("id, url, stack, controlled_by_compass, repo_url, branch, preview_branch, vercel_project, staging_url, domain_constant, work_mode, content_paths, content_adapter, foundation_version, foundation_sha").eq("client_id", clientId).order("created_at").limit(1).maybeSingle(),
      supabase.from("services").select("id, name, segment, page_type, status, page_url, parent_service_id").eq("client_id", clientId).order("sort_order"),
      supabase.from("page_groups").select("id, name, page_type, target_url, city_tier, status, keywords:primary_keyword_id(keyword, volume)").eq("client_id", clientId),
      supabase.from("claims").select("claim, status, source").eq("client_id", clientId),
      supabase.from("locations").select("name, city, state, is_physical_location").eq("client_id", clientId),
      supabase.from("client_brands").select("tagline, positioning").eq("client_id", clientId).maybeSingle(),
      supabase.from("brand_boards").select("status, palette, typography, standing_cta, hard_rules, drive_doc_url").eq("client_id", clientId).order("version", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("brand_assets").select("kind, label, url, width, height, is_primary").eq("client_id", clientId),
      supabase.from("foundation_releases").select("version, source_repo, source_sha, accepted_on, handoff_url, documents").eq("is_current", true).maybeSingle(),
    ]);
  if (!client) return { ok: false, message: "Client not found." };
  if (!site) return { ok: false, message: "No site row yet — set the work mode at intake or let the worker's Discovery step record one." };

  const byId = new Map((services ?? []).map((s) => [s.id, s.name]));
  const palette = Array.isArray(board?.palette) ? (board!.palette as { role?: string; hex?: string; source?: string }[]) : [];
  const input: BriefInput = {
    client: { ...client, drive_folders: (client.drive_folders as Record<string, string> | null) ?? null },
    site: {
      ...site,
      work_mode: site.work_mode ?? null,
      content_paths: (site.content_paths as ContentPaths | null) ?? null,
      content_adapter: (site.content_adapter as BriefInput["site"] extends infer S ? (S extends { content_adapter?: infer A } ? A : never) : never) ?? null,
    },
    release: release
      ? {
          version: release.version,
          source_repo: release.source_repo,
          source_sha: release.source_sha,
          accepted_on: release.accepted_on,
          documents: (Array.isArray(release.documents) ? release.documents : []) as { label: string; url: string }[],
          handoff_doc: release.handoff_url,
        }
      : undefined,
    services: (services ?? []).map((s) => ({ id: s.id, name: s.name, segment: s.segment, page_type: s.page_type, status: s.status, page_url: s.page_url, parent_name: s.parent_service_id ? byId.get(s.parent_service_id) ?? null : null })),
    pageGroups: (groups ?? []).map((g) => {
      const kw = g.keywords as unknown as { keyword: string; volume: number | null } | null;
      return { id: g.id, name: g.name, page_type: g.page_type, target_url: g.target_url, city_tier: g.city_tier, status: g.status, primary_keyword: kw?.keyword ?? null, primary_volume: kw?.volume ?? null };
    }),
    claims: (claims ?? []).map((c) => ({ claim: c.claim, status: c.status, source: c.source })),
    locations: (locations ?? []).map((l) => ({ name: l.name, city: l.city, state: l.state, is_physical_location: l.is_physical_location })),
    brand: board || brand
      ? {
          tagline: brand?.tagline ?? null,
          positioning: brand?.positioning ?? null,
          standing_cta: board?.standing_cta ?? null,
          hard_rules: Array.isArray(board?.hard_rules) ? (board!.hard_rules as string[]) : [],
          palette: palette.filter((p) => typeof p?.hex === "string").map((p) => ({ role: String(p.role ?? ""), hex: String(p.hex), source: p.source })),
          typography: (board?.typography as { heading?: string; body?: string } | null) ?? null,
          board_status: (board?.status as "draft" | "approved" | null) ?? null,
          drive_doc_url: board?.drive_doc_url ?? null,
        }
      : null,
    assets: (assets ?? []).map((a) => ({ kind: a.kind, label: a.label, url: a.url, width: a.width, height: a.height, is_primary: a.is_primary })),
    detected: null,
    generatedBy: who,
  };
  const brief = composeBuildBrief(input);
  const { error } = await supabase
    .from("sites")
    .update({ build_brief: brief as unknown as Json, build_brief_at: brief.generated_at, ...(site.work_mode ? {} : { work_mode: brief.work_mode }) })
    .eq("id", site.id);
  if (error) return { ok: false, message: error.message };
  await supabase.from("change_log").insert({
    client_id: clientId,
    change_type: "build_brief",
    object_type: "site",
    object_id: site.id,
    before: null,
    after: { work_mode: brief.work_mode, standard: `${brief.standard.version}@${brief.standard.source_sha.slice(0, 7)}`, adapter: brief.content_adapter.key, missing_inputs: brief.missing_inputs.length, page_plan: brief.page_plan.length },
    reasoning: `Build brief composed on the Foundation tab by ${who}; the worker refreshes it with the detected adapter and files the Drive copy.`,
    status: "proposed",
  });
  revalidate(clientId);
  return {
    ok: true,
    message: `Brief stored (${brief.work_mode}, ${brief.content_adapter.key}, ${brief.page_plan.length} page groups, ${brief.missing_inputs.length} missing inputs). The worker files the Drive copy.`,
  };
}
