// The post-drafter's only door to the database: supabase-js with the
// service role, so every call reaches Postgres through PostgREST as
// authenticator + service_role — the session 0047's write boundary admits.
// It reads through the canonical loader and writes through drafter_write();
// it never inserts or edits posts itself. Authority mode (v2) adds one
// read-only load of the opportunity's state; it writes no Authority record
// (drafter_write links the post in its own transaction, 0053).
import type { AuthorityState } from "./authority.ts";
import { DUPLICATE_WINDOW_DAYS } from "./authority.ts";
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
  // v2: the Authority opportunity the attempt was made for (0053).
  authority_opportunity_id?: string;
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
  // v2: an Authority draft; drafter_write re-checks the opportunity against
  // the expected run inside its transaction and links the post (0053).
  authority_opportunity_id?: string;
  authority_run_id?: string;
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

    // Authority mode (v2): the opportunity, the client's latest completed
    // run, the opportunity's post links, the open request and the client's
    // recent Business Profile posts. Read-only.
    async authority(clientId: string, opportunityId: string, now: Date): Promise<AuthorityState> {
      const must = <T>(r: { data: T; error: { message: string } | null }): T => {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      };
      const opportunity = must(await supabase.from("authority_opportunities")
        .select("id, client_id, key, present, last_seen_run_id, status, section, action, tier, content_type, topic, service_id, keyword_id, intent, target_path, eligible_from, cycle_started_at, opportunity")
        .eq("id", opportunityId).eq("client_id", clientId).maybeSingle());
      const latest = must(await supabase.from("authority_runs").select("id, engine_version, site:inventory->>site")
        .eq("client_id", clientId).eq("status", "completed").order("finished_at", { ascending: false }).order("id").limit(1));
      const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString();
      const recent = must(await supabase.from("social_posts")
        .select("id, service_id, search_intent, review_status, publish_status, created_at, copy")
        .eq("client_id", clientId).eq("platform", "google_business").gte("created_at", since).order("created_at", { ascending: false }));
      if (!opportunity) return { opportunity: null, latest_run: latest?.[0] ?? null, post_links: [], request: null, recent_posts: recent ?? [] };
      const links = must(await supabase.from("authority_opportunity_links")
        .select("created_at, social_posts(review_status, publish_status)")
        .eq("opportunity_id", opportunityId).eq("kind", "social_post"));
      const task = must(await supabase.from("tasks").select("id, status")
        .eq("client_id", clientId).eq("key", `authority_draft:${opportunityId}`).in("status", ["open", "in_progress"])
        .order("created_at", { ascending: false }).limit(1));
      let request: AuthorityState["request"] = null;
      if (task?.[0]) {
        const ev = must(await supabase.from("authority_opportunity_events").select("id")
          .eq("opportunity_id", opportunityId).eq("kind", "decision").eq("actor_kind", "team")
          .eq("detail->>action", "request_draft").eq("detail->>task_id", task[0].id).limit(1));
        request = { task_id: task[0].id, status: task[0].status, requested_by_team: (ev ?? []).length > 0 };
      }
      return {
        opportunity,
        latest_run: latest?.[0] ?? null,
        // deno-lint-ignore no-explicit-any
        post_links: (links ?? []).map((l: any) => ({
          created_at: l.created_at,
          review_status: l.social_posts?.review_status ?? null,
          publish_status: l.social_posts?.publish_status ?? null,
        })),
        request,
        recent_posts: recent ?? [],
      };
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
