// creative-engine's only door to the database and Storage: supabase-js with
// the service role, so its writes arrive as PostgREST's authenticator +
// service_role — 0054's Creative Engine session. Every write is one of 0054's
// governed functions (creative_register_template, creative_begin_run,
// creative_write, creative_fail_run) or an upload to the private
// creative-assets bucket at a content address (objects there are immutable).
// It reads posts and template approvals; it never changes them except
// through those functions.
// It reads brand-asset bytes; it never writes, moves or deletes them.
import type { Facts } from "./govern.ts";
import type { Store } from "./handler.ts";
import { MAX_SOURCE_BYTES } from "./render.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

async function rpc(supabase: Client, fn: string, p: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(fn, { p });
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

export function createStore(supabase: Client): Store {
  return {
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

    async facts(clientId): Promise<Facts | null> {
      const { data: client, error } = await supabase.from("clients").select("id, name, phone, website_url, status").eq("id", clientId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!client) return null;
      const [brand, board, services, claims, assets] = await Promise.all([
        supabase.from("client_brands").select("tagline").eq("client_id", clientId).maybeSingle(),
        supabase.from("brand_boards").select("standing_cta").eq("client_id", clientId).order("version", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("services").select("id, name, segment, status").eq("client_id", clientId),
        supabase.from("claims").select("id, claim, status, source").eq("client_id", clientId),
        supabase.from("brand_assets")
          .select("id, kind, creative_use, depicts_own_work, subjects, focal_x, focal_y, width, height, content_hash, storage_path")
          .eq("client_id", clientId),
      ]);
      for (const r of [brand, board, services, claims, assets]) if (r.error) throw new Error(r.error.message);
      return {
        client,
        brand: { tagline: brand.data?.tagline ?? null, standing_cta: board.data?.standing_cta ?? null },
        services: services.data ?? [],
        claims: (claims.data ?? []).map((c: { status: unknown }) => ({ ...c, status: String(c.status) })),
        assets: (assets.data ?? []).map((a: Record<string, unknown>) => ({
          ...a, kind: String(a.kind), subjects: (a.subjects as string[] | null) ?? [],
          focal_x: a.focal_x == null ? null : Number(a.focal_x), focal_y: a.focal_y == null ? null : Number(a.focal_y),
        })),
      } as Facts;
    },

    async read(storagePath) {
      const { data, error } = await supabase.storage.from("brand-assets").download(storagePath);
      if (error || !data) throw new Error(`source ${storagePath} could not be read: ${error?.message ?? "missing"}`);
      if (data.size > MAX_SOURCE_BYTES) throw new Error(`source ${storagePath} is over ${MAX_SOURCE_BYTES} bytes`);
      return new Uint8Array(await data.arrayBuffer());
    },

    async template(key, version) {
      const { data, error } = await supabase.from("creative_templates").select("id, spec_hash, status")
        .eq("key", key).eq("version", version).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async post(postId) {
      const { data, error } = await supabase.from("social_posts")
        .select("id, client_id, platform, service_id, copy, review_status, creative_policy, creative_version, scheduled_at")
        .eq("id", postId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const links = await supabase.from("post_claims").select("claim_id, created_at").eq("post_id", postId)
        .order("created_at").order("claim_id");
      if (links.error) throw new Error(links.error.message);
      return { ...data, platform: String(data.platform), claim_ids: (links.data ?? []).map((l: { claim_id: string }) => l.claim_id) };
    },

    async clientTemplateStatus(clientId, templateId) {
      const { data, error } = await supabase.from("client_creative_templates").select("status")
        .eq("client_id", clientId).eq("template_id", templateId).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.status ?? null;
    },

    registerTemplate: (p) => rpc(supabase, "creative_register_template", p),
    beginRun: (p) => rpc(supabase, "creative_begin_run", p),
    write: (p) => rpc(supabase, "creative_write", p),
    async failRun(p) {
      await rpc(supabase, "creative_fail_run", p);
    },

    async upload(path, bytes, contentType) {
      const { error } = await supabase.storage.from("creative-assets").upload(path, bytes, { contentType, upsert: false });
      // Content-addressed: the same path is the same bytes.
      if (error && !/exists|duplicate/i.test(String(error.message))) throw new Error(`upload ${path}: ${error.message}`);
    },
  };
}
