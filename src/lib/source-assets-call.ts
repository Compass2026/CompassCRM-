import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// Recording a stored brand asset's content hash from the app (Brand tab
// upload, Brand › Creative use "Record hash"). The hash is never computed
// here or in the browser: the deployed source-assets function (0055) reads
// the stored bytes, measures them and records them through
// brand_asset_record_hash. The app only asks, as the signed-in teammate (their
// own JWT; the function checks it against team_members), in the function's
// two steps: an inventory of the one asset, then `hash` bound to the hash that
// inventory measured — so bytes that change in between are refused, never
// recorded. A plain server module: callers are server actions.

export type SourceAssetsAnswer = { status: number | null; body: Record<string, unknown> | null };
export type SourceAssetsCall = (body: Record<string, unknown>) => Promise<SourceAssetsAnswer>;

export const SOURCE_ASSETS_TIMEOUT_MS = 30_000;

export function sourceAssetsCaller(supabase: Supabase): SourceAssetsCall {
  return async (body) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return { status: 401, body: null };
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/source-assets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SOURCE_ASSETS_TIMEOUT_MS),
        cache: "no-store",
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { status: null, body: null };
    }
  };
}

export type HashOutcome = {
  ok: boolean;
  /** hashed: a hash was recorded now; unchanged: the file already carried it; refused / failed: nothing recorded. */
  status: "hashed" | "unchanged" | "refused" | "failed";
  text: string;
  content_hash?: string;
};

type Issue = { code?: string; detail?: string };
type InventoryEntry = {
  asset_id?: string;
  action?: string;
  measured?: { content_hash?: string } | null;
  issues?: Issue[];
};

const NOT_RECORDED = "The file's hash was not recorded";

function transportFailure(a: SourceAssetsAnswer, step: string): HashOutcome | null {
  if (a.status === 200) return null;
  const b = a.body ?? {};
  const message = typeof b.error === "string" ? b.error : typeof b.message === "string" ? b.message : null;
  if (a.status === null) return { ok: false, status: "failed", text: `The source-assets function did not answer (${step}). Retry with "Record hash" on Brand › Creative use.` };
  if (a.status === 401) return { ok: false, status: "failed", text: "Your session expired. Sign in again, then use \"Record hash\" on Brand › Creative use." };
  if (a.status === 403) return { ok: false, status: "failed", text: "Only Compass team members can record a file's hash." };
  if (a.status === 404 && !message) return { ok: false, status: "failed", text: "The source-assets function is not deployed." };
  return { ok: false, status: "failed", text: `source-assets ${step} answered ${a.status}${message ? `: ${message}` : ""}.` };
}

const issueText = (issues: Issue[] | undefined, fallback: string) =>
  (issues ?? []).map((i) => i.detail ?? i.code).filter(Boolean).join(" ") || fallback;

/**
 * Inventory the one asset, then record its hash bound to what the inventory
 * measured. Never throws; the outcome says what happened in a sentence.
 */
export async function recordStoredAssetHash(call: SourceAssetsCall, clientId: string, assetId: string): Promise<HashOutcome> {
  const inv = await call({ mode: "inventory", client_id: clientId, asset_ids: [assetId] });
  const invFailed = transportFailure(inv, "inventory");
  if (invFailed) return invFailed;
  // A v2 deployment ignores asset_ids and lists every asset; pick ours either way.
  const assets = (Array.isArray(inv.body?.assets) ? inv.body!.assets : []) as InventoryEntry[];
  const entry = assets.find((e) => e.asset_id === assetId);
  if (!entry) return { ok: false, status: "refused", text: "source-assets did not find this asset for this client." };
  if (entry.action === "unchanged" && entry.measured?.content_hash) {
    return { ok: true, status: "unchanged", text: "The file's hash is already recorded.", content_hash: entry.measured.content_hash };
  }
  if (entry.action !== "record" || !entry.measured?.content_hash) {
    return { ok: false, status: "refused", text: `${NOT_RECORDED}: ${issueText(entry.issues, "source-assets could not measure the stored file.")}` };
  }

  const expected = entry.measured.content_hash;
  const res = await call({ mode: "hash", client_id: clientId, expect: { [assetId]: expected } });
  const hashFailed = transportFailure(res, "hash");
  if (hashFailed) return hashFailed;
  const results = (Array.isArray(res.body?.results) ? res.body!.results : []) as Record<string, unknown>[];
  const r = results.find((x) => x.asset_id === assetId);
  if (!r) return { ok: false, status: "failed", text: `${NOT_RECORDED}: source-assets returned no result for it.` };
  const status = String(r.status ?? "");
  if (status === "unchanged") return { ok: true, status: "unchanged", text: "The file's hash is already recorded.", content_hash: expected };
  if (status === "hashed" || status === "rehashed" || status === "measured") {
    return { ok: true, status: "hashed", text: `Hash recorded (${expected.slice(0, 12)}…).`, content_hash: expected };
  }
  const code = typeof r.code === "string" ? r.code.replace(/_/g, " ") : "refused";
  const detail = typeof r.detail === "string" ? r.detail : issueText(r.issues as Issue[] | undefined, "");
  return { ok: false, status: "refused", text: `${NOT_RECORDED} (${code})${detail ? `: ${detail}` : "."}` };
}

/** Types source-assets can measure; anything else is stored without a hash, by design. */
export const HASHABLE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const isHashableMime = (mime: string | null | undefined) =>
  !!mime && (HASHABLE_MIME as readonly string[]).includes(mime.toLowerCase());
