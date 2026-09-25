// The post-drafter's only door to the database: supabase-js with the
// service role, so every call reaches Postgres through PostgREST as
// authenticator + service_role — the session 0047's write boundary admits.
// It reads through the canonical loader and writes through drafter_write();
// it never inserts or edits posts itself.
import type { Brief, DrafterInput, LintResult } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type FailedRun = {
  client_id: string;
  requested_via: "worker" | "team";
  requested_by: string | null;
  target: Brief["target"];
  brief_version: string;
  brief_hash: string;
  brief: Brief;
  claim_ids: string[];
  runtime: string;
  attempt: number;
  lint: LintResult | null;
  status: "stale_brief" | "lint_failed" | "refused";
  detail: string;
};

export type WritePayload = {
  client_id: string;
  requested_via: "worker" | "team";
  requested_by: string | null;
  runtime: string;
  attempt: number;
  brief_version: string;
  brief_hash: string;
  brief: Brief;
  lint: LintResult;
  copy: string;
  claim_ids: string[];
  asset_ids: string[];
};
export type WriteError = { code: string | null; message: string };
export type Written = { run_id: string; post_id: string; review_task_id: string | null };

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
    },

    async teamMemberForJwt(jwt: string): Promise<string | null> {
      if (!jwt) return null;
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return null;
      const { data: m } = await supabase.from("team_members").select("id").eq("auth_user_id", data.user.id).maybeSingle();
      return m?.id ?? null;
    },

    // The one read of Client Intelligence (0047).
    async input(clientId: string): Promise<DrafterInput | null> {
      const { data, error } = await supabase.rpc("client_intelligence_input", { p_client_id: clientId });
      if (error) throw new Error(error.message);
      return (data as DrafterInput | null) ?? null;
    },

    // Submits already made against this brief (any outcome).
    async attempts(clientId: string, briefHash: string): Promise<number> {
      const { count, error } = await supabase.from("drafter_runs").select("id", { count: "exact", head: true })
        .eq("client_id", clientId).eq("brief_hash", briefHash);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    async recordRun(r: FailedRun): Promise<void> {
      const { error } = await supabase.from("drafter_runs").insert(r);
      if (error) throw new Error(error.message);
    },

    // One call, one transaction (drafter_write in 0047).
    async write(p: WritePayload): Promise<Written | { error: WriteError }> {
      const { data, error } = await supabase.rpc("drafter_write", { p });
      if (error) return { error: { code: error.code ?? null, message: error.message } };
      return data as Written;
    },
  };
}
export type Store = ReturnType<typeof createStore>;
