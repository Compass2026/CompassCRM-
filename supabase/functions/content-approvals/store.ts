// content-approvals' only door to the database: supabase-js with the service
// role (authenticator + service_role through PostgREST), which is the session
// the content_authorization_* functions admit.
import type { DbResult, Store } from "./handler.ts";

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
  };
}
