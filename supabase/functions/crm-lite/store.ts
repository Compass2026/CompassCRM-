// crm-lite's only door to the database: supabase-js with the service role.
// Vault through get_secret / set_secret / communication_subaccount_secrets
// (0065); jobs only through the CRM Lite functions.
// deno-lint-ignore no-explicit-any
type Client = any;
import type { SubaccountSecrets } from "../_shared/communications/credentials.ts";
import type { Caller } from "./handler.ts";

type Json = Record<string, unknown>;

async function rpc(supabase: Client, name: string, args: Json): Promise<unknown> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data, error } = await supabase.rpc("get_secret", { secret_name: name });
      if (error) throw new Error(`vault_read: could not read ${name}`);
      return (data as string | null) || null;
    },

    async setSecret(name: string, value: string): Promise<void> {
      const { error } = await supabase.rpc("set_secret", { secret_name: name, secret_value: value });
      if (error) throw new Error(`vault: could not store ${name}`);
    },

    async subaccountSecrets(accountSid: string): Promise<SubaccountSecrets> {
      const { data, error } = await supabase.rpc("communication_subaccount_secrets", { p_account_sid: accountSid });
      if (error) throw new Error(`vault_read: could not read the credentials of ${accountSid}`);
      const d = (data ?? {}) as Json;
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      return {
        accountSid,
        keySid: str(d.api_key), keySecret: str(d.api_secret), authToken: str(d.auth_token),
        names: { keySid: String(d.api_key_name ?? ""), keySecret: String(d.api_secret_name ?? ""), authToken: String(d.auth_token_name ?? "") },
        authTokenFoundAs: str(d.auth_token_found_as),
        otherAuthTokenAccounts: Array.isArray(d.other_auth_token_accounts) ? (d.other_auth_token_accounts as string[]) : [],
      };
    },

    async caller(jwt: string): Promise<Caller> {
      if (!jwt) return "none";
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return "none";
      const { data: m } = await supabase.from("team_members").select("id, role").eq("auth_user_id", data.user.id).maybeSingle();
      return { member: m?.id ?? null, role: m?.role ?? null };
    },

    async source(id: string) {
      const { data, error } = await supabase.from("inquiry_sources").select("id, secret_name").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    recordTokenIssued: (sourceId: string, actorId: string) =>
      rpc(supabase, "crm_record_token_issued", { p_source: sourceId, p_actor: actorId }) as Promise<Json>,
    claim: async (limit: number) => ((await rpc(supabase, "crm_notification_claim", { p_limit: limit })) ?? []) as Json[],
    claimUnknown: async (limit: number) => ((await rpc(supabase, "crm_notification_claim_unknown", { p_limit: limit })) ?? []) as Json[],
    result: (p: Json) => rpc(supabase, "crm_notification_result", { p }) as Promise<Json>,
    beginTest: (p: Json) => rpc(supabase, "crm_notification_begin_test", { p }) as Promise<Json>,

    async job(id: string) {
      const { data, error } = await supabase.from("notification_jobs")
        .select("id, status, provider_status, error_code, error_message").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },
  };
}
