// twilio-webhook's only door to the database: supabase-js with the service
// role. It reads Vault (the subaccount's Auth Token) and whether an account
// is registered, and writes only through communication_record_inbound /
// communication_record_status (0063).
// deno-lint-ignore no-explicit-any
type Client = any;

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
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
