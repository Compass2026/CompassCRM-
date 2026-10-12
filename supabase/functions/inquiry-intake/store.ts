// inquiry-intake's only door to the database: supabase-js with the service
// role. Reads the source by key and its token from Vault; writes only through
// crm_ingest_inquiry (CRM Lite).
// deno-lint-ignore no-explicit-any
type Client = any;
import type { Source } from "./handler.ts";

export function createStore(supabase: Client) {
  return {
    async source(key: string): Promise<Source | null> {
      const { data, error } = await supabase.rpc("crm_inquiry_source", { p_key: key });
      if (error) throw new Error(`source_read: ${error.message}`);
      return (data as Source | null) ?? null;
    },

    async secret(name: string): Promise<string | null> {
      const { data, error } = await supabase.rpc("get_secret", { secret_name: name });
      if (error) throw new Error(`vault_read: could not read ${name}`);
      return (data as string | null) || null;
    },

    async ingest(p: Record<string, unknown>): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("crm_ingest_inquiry", { p });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },
  };
}
