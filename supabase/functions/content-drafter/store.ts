// The content-drafter's only door to the database: supabase-js with the
// service role, so every call reaches Postgres through PostgREST as
// authenticator + service_role — the session 0067's content_draft_write
// admits. It reads the draft, the canonical Client Intelligence input (0047)
// and the client's published articles and who holds the draft's task; its
// one write is content_draft_write.
import type { DrafterInput } from "../post-drafter/types.ts";
import type { DraftRow, SitePage } from "./brief.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

type WriteResult = { draft_id: string; status: string; version: number; word_count: number };
type OpenResult = { draft_id: string; plan_item_id: string; status: string; reused: boolean };
export type WriteError = { code: string | null; message: string };
export type ClaimHolder = { claimed_by: string | null; claimed_at: string | null };

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
    async draft(id: string): Promise<DraftRow | null> {
      const { data, error } = await supabase.from("content_drafts")
        .select("id, client_id, plan_item_id, deliverable, status, topic, primary_keyword, keyword_id, search_intent, service_id, authority_opportunity_id, target_url, request_note")
        .eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as DraftRow | null) ?? null;
    },
    async input(clientId: string, serviceId: string | null = null): Promise<DrafterInput | null> {
      const { data, error } = await supabase.rpc("client_intelligence_for_content", { p_client_id: clientId, p_service_id: serviceId });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return (data as DrafterInput | null) ?? null;
    },
    // Published articles with a URL: pages a new article may link to.
    async sitePages(clientId: string): Promise<SitePage[]> {
      const { data, error } = await supabase.from("content_posts").select("url, title")
        .eq("client_id", clientId).eq("status", "published").not("url", "is", null).order("title");
      if (error) throw new Error(error.message);
      return (data ?? []) as SitePage[];
    },
    // Who holds the draft's task (its request task, else the weekly blog_post
    // task), from content_draft_claim (20261015180000). null: no task.
    async claimHolder(draftId: string): Promise<ClaimHolder | null> {
      const { data: d, error } = await supabase.from("content_drafts").select("request_task_id, source_task_id").eq("id", draftId).maybeSingle();
      if (error) throw new Error(error.message);
      const taskId = d?.request_task_id ?? d?.source_task_id;
      if (!taskId) return null;
      const { data: t, error: e2 } = await supabase.from("tasks").select("claimed_by, claimed_at").eq("id", taskId).maybeSingle();
      if (e2) throw new Error(e2.message);
      return (t as ClaimHolder | null) ?? null;
    },
    // The weekly blog (0068): open the draft for a blog_post task.
    async openWeekly(p: Record<string, unknown>): Promise<OpenResult | { error: WriteError }> {
      const { data, error } = await supabase.rpc("content_draft_open_weekly", { p });
      if (error) return { error: { code: error.code ?? null, message: error.message } };
      return data as OpenResult;
    },
    async write(p: Record<string, unknown>): Promise<WriteResult | { error: WriteError }> {
      const { data, error } = await supabase.rpc("content_draft_write", { p });
      if (error) return { error: { code: error.code ?? null, message: error.message } };
      return data as WriteResult;
    },
  };
}
export type Store = ReturnType<typeof createStore>;
