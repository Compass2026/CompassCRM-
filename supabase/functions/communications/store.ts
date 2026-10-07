// communications' only door to the database and Vault: supabase-js with the
// service role. Reads the registry and settings; writes only through the 0063
// functions (rpc) and set_secret() (credentials Twilio hands back once).
//
// A Vault read that fails is an error, never "not in Vault": PostgREST answers
// a missing secret with 200 and null, and anything else (a refused key, a
// timeout) must not be reported to a person as a credential to go and store.
import type { AccountRow, Caller, NumberRow, RegistrationRow, ServiceRow } from "./handler.ts";
import type { SubaccountSecrets } from "../_shared/communications/credentials.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

const WRITE_FUNCTIONS = new Set([
  "communication_begin_outbound", "communication_mark_sent", "communication_register_account",
  "communication_register_messaging_service", "communication_register_number", "communication_record_compliance_sync",
]);

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data, error } = await supabase.rpc("get_secret", { secret_name: name });
      if (error) throw new Error(`vault_read: could not read ${name}`);
      return (data as string | null) || null;
    },

    // One read for a subaccount's key, key secret and Auth Token (0065).
    async subaccountSecrets(accountSid: string): Promise<SubaccountSecrets> {
      const { data, error } = await supabase.rpc("communication_subaccount_secrets", { p_account_sid: accountSid });
      if (error || !data) throw new Error(`vault_read: could not read the credentials of ${accountSid}`);
      const d = data as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      return {
        accountSid,
        keySid: str(d.api_key),
        keySecret: str(d.api_secret),
        authToken: str(d.auth_token),
        names: { keySid: String(d.api_key_name), keySecret: String(d.api_secret_name), authToken: String(d.auth_token_name) },
        authTokenFoundAs: str(d.auth_token_found_as),
        otherAuthTokenAccounts: Array.isArray(d.other_auth_token_accounts) ? (d.other_auth_token_accounts as string[]) : [],
      };
    },

    async setSecret(name: string, value: string): Promise<void> {
      const { error } = await supabase.rpc("set_secret", { secret_name: name, secret_value: value });
      // Never echo the value; name the secret only.
      if (error) throw new Error(`vault: could not store ${name}`);
    },

    async caller(jwt: string): Promise<Caller> {
      if (!jwt) return "none";
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return "none";
      const { data: m } = await supabase.from("team_members").select("id, role").eq("auth_user_id", data.user.id).maybeSingle();
      return { member: m?.id ?? null, role: m?.role ?? null };
    },

    async client(id: string) {
      const { data, error } = await supabase.from("clients").select("id, name, status").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async settings(clientId: string) {
      const { data, error } = await supabase.from("client_communication_settings")
        .select("enabled, outbound_enabled, display_name").eq("client_id", clientId).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async account(clientId: string): Promise<AccountRow | null> {
      const { data, error } = await supabase.from("communication_accounts")
        .select("id, provider_account_sid, status").eq("client_id", clientId).eq("provider", "twilio").maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async messagingService(clientId: string): Promise<ServiceRow | null> {
      const { data, error } = await supabase.from("communication_messaging_services")
        .select("id, provider_service_sid, friendly_name, status").eq("client_id", clientId).eq("status", "active")
        .order("created_at").limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async number(clientId: string, numberId: string): Promise<NumberRow | null> {
      const { data, error } = await supabase.from("communication_numbers")
        .select("id, provider_phone_number_sid, phone_number_e164, messaging_service_id, status")
        .eq("client_id", clientId).eq("id", numberId).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async registrations(clientId: string): Promise<RegistrationRow[]> {
      const { data, error } = await supabase.from("communication_compliance_profiles")
        .select("id, profile_type, provider_profile_sid").eq("client_id", clientId).order("created_at");
      if (error) throw new Error(error.message);
      return (data ?? []) as RegistrationRow[];
    },

    async rpc(fn: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!WRITE_FUNCTIONS.has(fn)) throw new Error(`refused: ${fn} is not a communications write`);
      const { data, error } = await supabase.rpc(fn, { p });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
  };
}
