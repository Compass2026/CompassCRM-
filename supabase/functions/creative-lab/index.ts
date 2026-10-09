// Deployed entry point (verify_jwt = true). Read-only: the store below has no
// write method. Logic in handler.ts, tested by tests/creative-lab.test.mjs.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createCreativeLab, type LabAsset, type Store } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const store: Store = {
  async secret(name) {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  },
  async caller(jwt) {
    if (!jwt) return "none";
    const { data } = await supabase.auth.getUser(jwt);
    if (!data?.user) return "none";
    const { data: m } = await supabase.from("team_members").select("id").eq("auth_user_id", data.user.id).maybeSingle();
    return { member: m?.id ?? null };
  },
  async client(clientId) {
    const { data, error } = await supabase.from("clients").select("id, status").eq("id", clientId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { id: data.id, status: String(data.status) } : null;
  },
  async assets(clientId) {
    const { data, error } = await supabase.from("brand_assets")
      .select("id, kind, label, creative_use, depicts_own_work, subjects, focal_x, focal_y, width, height, content_hash, storage_path")
      .eq("client_id", clientId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((a: Record<string, unknown>) => ({
      ...a, kind: String(a.kind), creative_use: String(a.creative_use), subjects: (a.subjects as string[] | null) ?? [],
      focal_x: a.focal_x == null ? null : Number(a.focal_x), focal_y: a.focal_y == null ? null : Number(a.focal_y),
    })) as LabAsset[];
  },
  async sign(path, seconds) {
    const { data, error } = await supabase.storage.from("brand-assets").createSignedUrl(path, seconds);
    if (error || !data?.signedUrl) throw new Error(`sign ${path}: ${error?.message ?? "no url"}`);
    return data.signedUrl;
  },
};

const lab = createCreativeLab({ store });
Deno.serve((req) => lab.handle(req));
