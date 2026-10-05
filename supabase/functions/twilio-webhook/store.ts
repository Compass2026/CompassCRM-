// twilio-webhook's only door to the database: supabase-js with the service
// role. It reads Vault (the subaccount's Auth Token, through
// communication_subaccount_secrets, 0065) and whether an account is
// registered, and writes only through communication_record_inbound /
// communication_record_status (0063).
// deno-lint-ignore no-explicit-any
type Client = any;

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data, error } = await supabase.rpc("get_secret", { secret_name: name });
      if (error) throw new Error(`vault_read: could not read ${name}`);
      return (data as string | null) || null;
    },

    // The subaccount's Auth Token through the same Vault read the
    // communications function uses (0065): exact name, or the one name that
    // differs only in the SID's letter case.
    async authToken(accountSid: string): Promise<string | null> {
      const { data, error } = await supabase.rpc("communication_subaccount_secrets", { p_account_sid: accountSid });
      if (error) throw new Error("vault_read: could not read the subaccount's Auth Token");
      const t = (data as Record<string, unknown> | null)?.auth_token;
      return typeof t === "string" && t ? t : null;
    },

    async accountKnown(accountSid: string): Promise<boolean> {
      const { data, error } = await supabase.from("communication_accounts").select("id")
        .eq("provider_account_sid", accountSid).neq("status", "closed").maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },

    async recordInbound(p: Record<string, unknown>): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("communication_record_inbound", { p });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },

    async recordStatus(p: Record<string, unknown>): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("communication_record_status", { p });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },
  };
}
