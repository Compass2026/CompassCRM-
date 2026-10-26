// The post-drafter's only door to the database: supabase-js with the
// service role, so every call reaches Postgres through PostgREST as
// authenticator + service_role — the session 0047's write boundary admits.
// It reads through the canonical loader and writes through drafter_write();
// it never inserts or edits posts itself. Authority mode (v2) adds one
// read-only load of the opportunity's state; it writes no Authority record
// (drafter_write links the post in its own transaction, 0053).
import type { AuthorityState } from "./authority.ts";
import type { RevisionState } from "./revision.ts";
import { DUPLICATE_WINDOW_DAYS } from "./authority.ts";
import type { Brief, DrafterInput, LintResult, SocialAccountRow } from "./types.ts";

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
  // v8: who holds the Authority request (authority_draft_claim); drafter_write
  // refuses another claimant's live claim (20261015175410).
  claimant: string | null;
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
// v9: a corrected caption for a revision request (post_revision_write_copy).
export type RevisePayload = {
  request_id: string;
  client_id: string;
  claimant: string;
  expected_copy_hash: string;
  copy: string;
  runtime: string;
  brief_hash: string;
  lint: LintResult;
};
export type Revised = {
  request_id: string;
  post_id: string;
  review_status: string;
  request_status: string;
  copy_state: string;
  image_state: string;
  resubmitted: boolean;
  waiting_for?: string[];
  error?: string;
  review_task_id: string | null;
};
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
    async input(clientId: string, serviceId: string | null = null): Promise<DrafterInput | null> {
      const { data, error } = await supabase.rpc("client_intelligence_for_content", { p_client_id: clientId, p_service_id: serviceId });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return (data as DrafterInput | null) ?? null;
    },

    // The client's Facebook Pages (v3, Facebook briefs). Read-only.
    async socialAccounts(clientId: string): Promise<SocialAccountRow[]> {
      const { data, error } = await supabase.from("social_accounts").select("id, platform, external_account_id, display_name")
        .eq("client_id", clientId).eq("platform", "facebook");
      if (error) throw new Error(error.message);
      return (data ?? []) as SocialAccountRow[];
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
      const task = must(await supabase.from("tasks").select("id, status, claimed_by, claimed_at")
        .eq("client_id", clientId).eq("key", `authority_draft:${opportunityId}`).in("status", ["open", "in_progress"])
        .order("created_at", { ascending: false }).limit(1));
      let request: AuthorityState["request"] = null;
      if (task?.[0]) {
        const ev = must(await supabase.from("authority_opportunity_events").select("id")
          .eq("opportunity_id", opportunityId).eq("kind", "decision").eq("actor_kind", "team")
          .eq("detail->>action", "request_draft").eq("detail->>task_id", task[0].id).limit(1));
        request = {
          task_id: task[0].id, status: task[0].status, requested_by_team: (ev ?? []).length > 0,
          claimed_by: task[0].claimed_by ?? null, claimed_at: task[0].claimed_at ?? null,
        };
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

    // v9: a revision request and the post it is for, read-only. The
    // destination key is built as content_social_destination() builds it.
    async revision(clientId: string, requestId: string): Promise<RevisionState | null> {
      const must = <T>(r: { data: T; error: { message: string } | null }): T => {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      };
      const request = must(await supabase.from("post_revision_requests")
        .select("id, client_id, post_id, status, mode, category, feedback, platform, service_id, keyword_id, destination, original_copy_hash, copy_state, copy_claimed_by, copy_claimed_at, image_state")
        .eq("id", requestId).eq("client_id", clientId).maybeSingle());
      if (!request) return null;
      const post = must(await supabase.from("social_posts")
        .select("id, client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id, cta_type, cta_url, social_account_id, copy, review_status, publish_status, approved_hash")
        .eq("id", request.post_id).eq("client_id", clientId).maybeSingle());
      if (!post) return null;
      const account = post.social_account_id
        ? must(await supabase.from("social_accounts").select("id, publish_page_id, external_account_id")
            .eq("id", post.social_account_id).eq("client_id", clientId).maybeSingle())
        : null;
      const claims = must(await supabase.from("post_claims").select("claim_id").eq("post_id", post.id).order("claim_id"));
      const assets = must(await supabase.from("post_assets").select("brand_asset_id, sort_order")
        .eq("post_id", post.id).not("brand_asset_id", "is", null).order("sort_order"));
      const bytes = new TextEncoder().encode(post.copy ?? "");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return {
        request, post,
        destination: account ? `${post.platform}:${account.publish_page_id ?? account.external_account_id ?? account.id}` : null,
        // deno-lint-ignore no-explicit-any
        claim_ids: (claims ?? []).map((c: any) => c.claim_id),
        // deno-lint-ignore no-explicit-any
        asset_ids: (assets ?? []).map((a: any) => a.brand_asset_id),
        copy_hash: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
      };
    },

    // v9: one call, one transaction (post_revision_write_copy).
    async reviseWrite(p: RevisePayload): Promise<Revised | { error: WriteError }> {
      const { data, error } = await supabase.rpc("post_revision_write_copy", { p });
      if (error) return { error: { code: error.code ?? null, message: error.message } };
      return data as Revised;
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
