// social-history's only door to the database: supabase-js with the service
// role, so every call reaches Postgres through PostgREST as authenticator +
// service_role, the one session the Social History writers admit. It reads
// clients, team_members and social_accounts, and writes only through
// social_history_begin_import / _record_posts / _finish_import. It never
// writes a table directly, and it reads nothing Client Intelligence or
// Authority use as evidence.
import type { PostRow } from "./map.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type Caller = "none" | { member: string | null; role: string | null };
export type BeginArgs = {
  clientId: string; pageId: string; pageName: string | null; providerAccountId: string;
  limit: number; windowFrom: string; requestedBy: string | null;
};
export type BeginResult = { import_id: string; social_account_id: string } | { conflict: "running" | "page_taken" | "page_differs"; message: string };
export type Counts = { inserted: number; updated: number; unchanged: number; metrics_captured: number };
export type Listing = { complete: boolean; oldest_seen: string | null; skipped: number; provider_state: Record<string, unknown> };

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
    },

    async caller(jwt: string): Promise<Caller> {
      if (!jwt) return "none";
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return "none";
      const { data: m } = await supabase.from("team_members").select("id, role").eq("auth_user_id", data.user.id).maybeSingle();
      return { member: m?.id ?? null, role: m?.role ?? null };
    },

    async client(id: string): Promise<{ id: string; name: string; status: string } | null> {
      const { data, error } = await supabase.from("clients").select("id, name, status").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    // The client's recorded Facebook account, if any.
    async socialAccount(clientId: string): Promise<{ id: string; external_account_id: string | null; display_name: string | null } | null> {
      const { data, error } = await supabase.from("social_accounts").select("id, external_account_id, display_name")
        .eq("client_id", clientId).eq("platform", "facebook").not("external_account_id", "is", null).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    // Which other client a Page is recorded for, if any.
    async pageOwner(pageId: string, clientId: string): Promise<string | null> {
      const { data, error } = await supabase.from("social_accounts").select("client_id")
        .eq("platform", "facebook").eq("external_account_id", pageId).neq("client_id", clientId).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.client_id ?? null;
    },

    async begin(a: BeginArgs): Promise<BeginResult> {
      const { data, error } = await supabase.rpc("social_history_begin_import", {
        p_client_id: a.clientId, p_platform: "facebook", p_page_id: a.pageId, p_page_name: a.pageName,
        p_provider_account_id: a.providerAccountId, p_limit: a.limit, p_window_from: a.windowFrom, p_requested_by: a.requestedBy,
      });
      if (error) {
        if (error.code === "55P03") return { conflict: "running", message: error.message };
        if (error.code === "23505") {
          return { conflict: /another client/.test(error.message) ? "page_taken" : "page_differs", message: error.message };
        }
        throw new Error(error.message);
      }
      return data as { import_id: string; social_account_id: string };
    },

    async record(importId: string, posts: PostRow[]): Promise<Counts> {
      const { data, error } = await supabase.rpc("social_history_record_posts", { p_import_id: importId, p_posts: posts });
      if (error) throw new Error(error.message);
      return data as Counts;
    },

    async finish(importId: string, status: "completed" | "partial" | "failed", error: string | null, listing: Listing) {
      const { data, error: e } = await supabase.rpc("social_history_finish_import",
        { p_import_id: importId, p_status: status, p_error: error, p_listing: listing });
      if (e) throw new Error(e.message);
      return data as Record<string, unknown>;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
