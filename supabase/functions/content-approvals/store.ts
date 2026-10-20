// content-approvals' only door to the database: supabase-js with the service
// role (authenticator + service_role through PostgREST), which is the session
// the content_authorization_* and content_edit_* functions admit. For
// delegated post edits it also hands out signed upload URLs that cannot
// overwrite an existing object and reads stored files from the private
// brand-assets bucket (as source-assets does); it never writes bytes itself.
import type { DbResult, Store, StoredRead } from "./handler.ts";
import { MAX_EDIT_BYTES } from "./handler.ts";

const BUCKET = "brand-assets";

// deno-lint-ignore no-explicit-any
type Client = any;
type Json = Record<string, unknown>;

const wrap = <T>({ data, error }: { data: unknown; error: { code?: string | null; message: string } | null }): DbResult<T> =>
  ({ data: (data as T | null) ?? null, error: error ? { code: error.code ?? null, message: error.message } : null });

export function createStore(supabase: Client): Store {
  return {
    async secret(name) {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
    },
    async clientsNamed(name) {
      const { data, error } = await supabase.from("clients").select("id, name").ilike("name", `%${name.replace(/[%_]/g, "")}%`).limit(10);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; name: string }[];
    },
    async batch(clientId, channel) {
      return wrap<Json>(await supabase.rpc("content_review_batch", { p_client: clientId, ...(channel ? { p_channel: channel } : {}) }));
    },
    async record(p) { return wrap<Json>(await supabase.rpc("content_authorization_record", { p })); },
    async execute(id) { return wrap<Json>(await supabase.rpc("content_authorization_execute", { p_id: id })); },
    async refuse(id, code, message) { return wrap<Json>(await supabase.rpc("content_authorization_refuse", { p_id: id, p_code: code, p_message: message })); },
    async status(operationId) { return wrap<Json>(await supabase.rpc("content_authorization_status", { p_operation_id: operationId })); },

    async editStage(p) { return wrap<Json>(await supabase.rpc("content_edit_stage", { p })); },
    async editRecord(p) { return wrap<Json>(await supabase.rpc("content_edit_record", { p })); },
    async editExecute(id, measured) { return wrap<Json>(await supabase.rpc("content_edit_execute", { p_id: id, p_measured: measured })); },
    async editRefuse(id, code, message) { return wrap<Json>(await supabase.rpc("content_edit_refuse", { p_id: id, p_code: code, p_message: message })); },
    async editStatus(operationId) { return wrap<Json>(await supabase.rpc("content_edit_status", { p_operation_id: operationId })); },

    async uploadSlot(storagePath) {
      const dir = storagePath.slice(0, storagePath.lastIndexOf("/"));
      const name = storagePath.slice(storagePath.lastIndexOf("/") + 1);
      const { data: list, error: le } = await supabase.storage.from(BUCKET).list(dir, { search: name, limit: 10 });
      if (le) throw new Error(le.message);
      if ((list ?? []).some((o: { name: string }) => o.name === name)) return { exists: true as const };
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath, { upsert: false });
      if (error) throw new Error(error.message);
      return { exists: false as const, signed_url: data.signedUrl as string, token: data.token as string };
    },

    async read(storagePath): Promise<StoredRead> {
      const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
      if (error) {
        const status = (error as { status?: number; statusCode?: string | number }).status
          ?? Number((error as { statusCode?: string | number }).statusCode);
        const msg = String(error.message ?? error);
        if (status === 404 || status === 400 || /not.?found/i.test(msg)) return { ok: false, reason: "missing" };
        return { ok: false, reason: "unreadable", detail: msg.slice(0, 200) };
      }
      if (!data) return { ok: false, reason: "missing" };
      if (data.size > MAX_EDIT_BYTES) return { ok: false, reason: "too_large" };
      return { ok: true, bytes: new Uint8Array(await data.arrayBuffer()) };
    },
  };
}
