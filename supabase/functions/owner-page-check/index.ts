// Deployed entry point (verify_jwt = true). The logic is handler.ts and
// check.ts, tested with a fake store and fetch (tests/owner-page-check.test.mjs).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createOwnerPageCheck, type Store } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const store: Store = {
  async secret(name) {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  },
  async teamMember(jwt) {
    const { data } = await supabase.auth.getUser(jwt);
    if (!data?.user) return null;
    const { data: m } = await supabase.from("team_members").select("id").eq("auth_user_id", data.user.id).maybeSingle();
    return m?.id ?? null;
  },
  async targets(clientId, programId) {
    const { data, error } = await supabase.rpc("owner_page_check_targets", { p_client_id: clientId, p_brand_workspace_id: programId });
    if (error) throw new Error(error.message);
    return (data ?? []) as { url: string; site_url: string; keyword_count: number }[];
  },
  async record(row) {
    const { error } = await supabase.from("owner_page_checks").insert(row);
    if (error) throw new Error(error.message);
  },
};

const check = createOwnerPageCheck({ store });
Deno.serve((req) => check.handle(req));
