// source-assets' only door to the database and Storage: supabase-js with the
// service role. It reads brand_assets and downloads stored files from the
// private brand-assets bucket, and writes only through
// brand_asset_record_hash (0055). It never uploads, moves or deletes a file.
import type { AssetRow, Read } from "./plan.ts";
import { MAX_BYTES } from "./plan.ts";

// deno-lint-ignore no-explicit-any
type Client = any;
const BUCKET = "brand-assets";

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
    },

    async caller(jwt: string): Promise<"none" | { member: string | null }> {
      if (!jwt) return "none";
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return "none";
      const { data: m } = await supabase.from("team_members").select("id").eq("auth_user_id", data.user.id).maybeSingle();
      return { member: m?.id ?? null };
    },

    async client(id: string): Promise<{ id: string; name: string } | null> {
      const { data, error } = await supabase.from("clients").select("id, name").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async assets(clientId: string): Promise<AssetRow[]> {
      const { data, error } = await supabase.from("brand_assets")
        .select("id, client_id, kind, source, label, storage_path, url, mime_type, size_bytes, width, height, content_hash, creative_use")
        .eq("client_id", clientId).order("kind").order("sort_order").order("created_at");
      if (error) throw new Error(error.message);
      return (data ?? []) as AssetRow[];
    },

    async read(storagePath: string): Promise<Read> {
      const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
      if (error) {
        const status = (error as { status?: number; statusCode?: string | number }).status
          ?? Number((error as { statusCode?: string | number }).statusCode);
        const msg = String(error.message ?? error);
        if (status === 404 || status === 400 || /not.?found/i.test(msg)) return { ok: false, reason: "missing" };
        return { ok: false, reason: "unreadable", detail: msg.slice(0, 200) };
      }
      if (!data) return { ok: false, reason: "missing" };
      if (data.size > MAX_BYTES) return { ok: false, reason: "too_large" };
      return { ok: true, bytes: new Uint8Array(await data.arrayBuffer()) };
    },

    async record(p: Record<string, unknown>): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("brand_asset_record_hash", { p });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },
  };
}
