// The content-drafter's only door to the database: supabase-js with the
// service role, so every call reaches Postgres through PostgREST as
// authenticator + service_role — the session 0067's content_draft_write
// admits. It reads the draft, the canonical Client Intelligence input (0047)
// and the client's published articles and who holds the draft's task; its
// one write is content_draft_write.
import type { DrafterInput } from "../post-drafter/types.ts";
import type { DraftRow, SitePage } from "./brief.ts";
import type { HeroAsset } from "./hero.ts";
import { sitemapArticles, sitemapChildren } from "./links.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

type WriteResult = { draft_id: string; status: string; version: number; word_count: number };
type OpenResult = { draft_id: string; plan_item_id: string; status: string; reused: boolean };
export type WriteError = { code: string | null; message: string };
export type ClaimHolder = { claimed_by: string | null; claimed_at: string | null };

export function createStore(supabase: Client, fetchImpl: typeof fetch = fetch) {
  async function readSitemap(url: string): Promise<string | null> {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/xml,text/xml" }, signal: AbortSignal.timeout(5000) });
      return res.ok ? await res.text() : null;
    } catch { return null; }
  }
  async function liveArticles(clientId: string): Promise<SitePage[]> {
    const { data: client } = await supabase.from("clients").select("website_url").eq("id", clientId).maybeSingle();
    const site = (client?.website_url as string | null) ?? null;
    const originOf = (u: string | null) => { try { return new URL(u ?? "").origin; } catch { return null; } };
    const origin = originOf(site);
    if (!origin || !origin.startsWith("https://")) return [];
    const { data: rows } = await supabase.from("sites").select("url, content_paths").eq("client_id", clientId);
    const route = ((rows ?? []) as { url: string | null; content_paths: { blog_route?: unknown } | null }[])
      .find((r) => originOf(r.url) === origin && typeof r.content_paths?.blog_route === "string")
      ?.content_paths?.blog_route as string | undefined;
    const root = await readSitemap(`${origin}/sitemap.xml`);
    if (!root) return [];
    const children = sitemapChildren(root, origin).slice(0, 5);
    const docs = children.length ? (await Promise.all(children.map(readSitemap))).filter((x): x is string => !!x) : [root];
    return docs.flatMap((xml) => sitemapArticles(xml, origin, route));
  }

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
    async input(clientId: string, serviceId: string | null = null, keywordId: string | null = null): Promise<DrafterInput | null> {
      const { data, error } = await supabase.rpc("client_intelligence_for_content", { p_client_id: clientId, p_service_id: serviceId, p_keyword_id: keywordId });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return (data as DrafterInput | null) ?? null;
    },
    // Published articles with a URL: pages a new article may link to. The
    // CRM's own records first, then the posts the client's live sitemap lists
    // under its blog route (Nov 20 2026), so articles that predate the CRM
    // count too. An unreadable sitemap adds nothing; it never fails a brief.
    async sitePages(clientId: string): Promise<SitePage[]> {
      const { data, error } = await supabase.from("content_posts").select("url, title")
        .eq("client_id", clientId).eq("status", "published").not("url", "is", null).order("title");
      if (error) throw new Error(error.message);
      const pages = (data ?? []) as SitePage[];
      return [...pages, ...await liveArticles(clientId)];
    },
    // Who holds the draft's task (its request task, else the weekly blog_post
    // task), from content_draft_claim (20261015175146). null: no task.
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
    // A draft with a hero writes through content_draft_write_with_hero: the
    // hero and the content land in one transaction (20261015210000).
    async write(p: Record<string, unknown>): Promise<WriteResult | { error: WriteError }> {
      const hero = (p.content as { hero?: unknown } | undefined)?.hero;
      const { data, error } = hero
        ? await supabase.rpc("content_draft_write_with_hero", { p })
        : await supabase.rpc("content_draft_write", { p });
      if (error) return { error: { code: error.code ?? null, message: error.message } };
      return data as WriteResult;
    },
    // The brand asset a submitted draft proposes as its hero image.
    async heroAsset(id: string): Promise<HeroAsset | null> {
      const { data, error } = await supabase.from("brand_assets")
        .select("id, client_id, kind, storage_path, content_hash, mime_type, width, height").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as HeroAsset | null) ?? null;
    },
  };
}
export type Store = ReturnType<typeof createStore>;
